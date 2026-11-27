import {
  EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@ankielcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import { BearerConnectionProfile } from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { connectionRouteId } from "./routes.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const REMOTE_TARGET = new SshConnectionTarget({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  connectionId: "remote-ssh",
});

const TARGET_ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.none(),
  enabled: true,
};

const REMOTE_ENTRY: ConnectionCatalogEntry = {
  target: REMOTE_TARGET,
  profile: Option.none(),
  enabled: true,
};

const PREPARED_CONNECTION: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const TEST_RPC_CLIENT = {} as WsRpcProtocolClient;

const LAN_TARGET = new BearerConnectionTarget({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  connectionId: "bearer:lan",
});
const LAN_ROUTE = {
  target: LAN_TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: LAN_TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "http://192.168.1.10:3773/",
      wsBaseUrl: "ws://192.168.1.10:3773/",
    }),
  ),
} satisfies ConnectionRoute;
const LAN_THEN_REMOTE_ENTRY: ConnectionCatalogEntry = {
  target: LAN_ROUTE.target,
  profile: LAN_ROUTE.profile,
  alternateRoutes: [{ target: REMOTE_TARGET, profile: Option.none() }],
  enabled: true,
};

const SSH_ENTRY: ConnectionCatalogEntry = {
  target: new SshConnectionTarget({
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    connectionId: "ssh-connection",
  }),
  profile: Option.none(),
  enabled: true,
};

function preparedFor(target: ConnectionTarget): PreparedConnection {
  return { ...PREPARED_CONNECTION, target };
}

function transient(message = "Connection failed.") {
  return new ConnectionTransientError({
    reason: "transport",
    detail: message,
  });
}

function blocked(message = "Authentication required.") {
  return new ConnectionBlockedError({
    reason: "authentication",
    detail: message,
  });
}

function awaitState(
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  return SubscriptionRef.changes(state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

function recordLogs(logs: Array<unknown>, annotations?: Array<unknown>) {
  return Logger.layer(
    [
      Logger.make(({ message, fiber }) => {
        logs.push(message);
        annotations?.push(fiber.getRef(References.CurrentLogAnnotations));
      }),
    ],
    { mergeWithExisting: false },
  );
}

const makeHarness = Effect.fn("TestConnectionHarness.make")(function* (options?: {
  readonly networkStatus?: NetworkStatus;
  readonly prepare?: (
    attempt: number,
    target: ConnectionTarget,
  ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  readonly ready?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly release?: (attempt: number) => Effect.Effect<void>;
  readonly probe?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly configEvents?: Stream.Stream<ServerConfigStreamEvent> | undefined;
  readonly initialConfig?: (attempt: number) => Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly checkRoute?: (route: ConnectionRoute) => Effect.Effect<ConnectionDriver.RouteCheck>;
  readonly checkHost?: (prepared: PreparedConnection) => Effect.Effect<ConnectionDriver.RouteCheck>;
  readonly preflight?: (route: ConnectionRoute) => Effect.Effect<ConnectionDriver.RoutePreflight>;
  readonly inboundFrames?: Effect.Effect<number>;
}) {
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>(
    options?.networkStatus ?? "online",
  );
  const prepareCount = yield* Ref.make(0);
  const sessionCount = yield* Ref.make(0);
  const releaseCount = yield* Ref.make(0);
  const wakeups = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly reason: ConnectionWakeups.ConnectionWakeup;
  }>({
    sequence: 0,
    reason: "application-active",
  });
  const closedSessions = yield* Ref.make<
    ReadonlyArray<Deferred.Deferred<never, ConnectionTransientError>>
  >([]);

  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });

  const prepare = Effect.fn("TestConnectionDriver.prepare")(function* (target: ConnectionTarget) {
    const attempt = yield* Ref.updateAndGet(prepareCount, (count) => count + 1);
    if (options?.prepare) {
      return yield* options.prepare(attempt, target);
    }
    return PREPARED_CONNECTION;
  });

  const checkRoute = (route: ConnectionRoute) =>
    options?.checkRoute?.(route) ?? Effect.succeed<ConnectionDriver.RouteCheck>("unchecked");

  const connectRoute = Effect.fn("TestConnectionDriver.connectRoute")(function* (
    target: ConnectionTarget,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    yield* reportProgress({ stage: "preparing" });
    const prepared = yield* prepare(target);
    yield* reportProgress({ stage: "opening", prepared });

    const attempt = yield* Ref.updateAndGet(sessionCount, (count) => count + 1);
    const closed = yield* Deferred.make<never, ConnectionTransientError>();
    yield* Ref.update(closedSessions, (sessions) => [...sessions, closed]);

    const session = yield* Effect.acquireRelease(
      Effect.succeed({
        client: TEST_RPC_CLIENT,
        initialConfig:
          options?.initialConfig?.(attempt) ??
          Effect.die(new Error("Initial config is not used by supervisor tests.")),
        subscribeServerConfig: () =>
          options?.configEvents ??
          Stream.fromEffect(
            (options?.initialConfig?.(attempt) ?? Effect.never).pipe(Effect.orDie),
          ).pipe(
            Stream.map((config) => ({ version: 1 as const, type: "snapshot" as const, config })),
          ),
        ready: options?.ready?.(attempt) ?? Effect.void,
        probe: options?.probe?.(attempt) ?? Effect.void,
        inboundFrames: options?.inboundFrames ?? Effect.succeed(0),
        closed: Deferred.await(closed),
      } satisfies RpcSession.RpcSession),
      () =>
        Ref.update(releaseCount, (count) => count + 1).pipe(
          Effect.andThen(options?.release?.(attempt) ?? Effect.void),
        ),
    );

    yield* reportProgress({ stage: "synchronizing", prepared });
    yield* session.ready;
    return { prepared, session } satisfies ConnectionDriver.RouteConnection;
  });

  const connect = Effect.fn("TestConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    yield* reportProgress({ stage: "preparing" });
    return yield* ConnectionDriver.connectOverRoutes(entry, checkRoute, (route) =>
      connectRoute(route.target, reportProgress),
    );
  });

  const layerDependencies = Layer.mergeAll(
    Layer.succeed(Random.Random, {
      nextDoubleUnsafe: () => 1 - Number.EPSILON,
      nextIntUnsafe: () => 0,
    }),
    Layer.succeed(Connectivity.Connectivity, connectivity),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({
        changes: SubscriptionRef.changes(wakeups).pipe(
          Stream.drop(1),
          Stream.map((event) => event.reason),
        ),
      }),
    ),
    Layer.succeed(
      ConnectionDriver.ConnectionDriver,
      ConnectionDriver.ConnectionDriver.of({
        connect,
        preflight: (_entry, route) =>
          options?.preflight?.(route) ??
          checkRoute(route).pipe(
            Effect.map((check): ConnectionDriver.RoutePreflight =>
              check === "answered" ? "ready" : check,
            ),
          ),
        checkHost: (prepared) =>
          options?.checkHost?.(prepared) ??
          Effect.succeed<ConnectionDriver.RouteCheck>("unchecked"),
      }),
    ),
  );

  return {
    dependencies: layerDependencies,
    prepareCount,
    sessionCount,
    releaseCount,
    setNetworkStatus: (status: NetworkStatus) => SubscriptionRef.set(networkStatus, status),
    wake: (reason: ConnectionWakeups.ConnectionWakeup) =>
      SubscriptionRef.update(wakeups, (event) => ({
        sequence: event.sequence + 1,
        reason,
      })),
    closeLatestSession: Effect.fn("TestConnectionHarness.closeLatestSession")(function* (
      exit: Exit.Exit<never, ConnectionTransientError> = Exit.fail(transient("Session closed.")),
    ) {
      const sessions = yield* Ref.get(closedSessions);
      const latest = sessions.at(-1);
      if (latest) {
        yield* Deferred.done(latest, exit);
      }
    }),
  };
});

describe("EnvironmentSupervisor", () => {
  it.effect("does not attempt a connection until it is desired", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );

      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("available");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);
    }),
  );

  it.effect("does not let the initial connect signal cancel the first attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }),
  );

  it.effect("waits while offline and connects immediately when the network returns", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ networkStatus: "offline" });
      const supervisor = yield* EnvironmentSupervisor.make(REMOTE_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "offline");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);

      yield* harness.setNetworkStatus("online");
      const ready = yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(ready).toMatchObject({
        desired: true,
        network: "online",
        phase: "connected",
        attempt: 1,
        generation: 1,
        lastFailure: null,
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("explicit retry connects while the network still reports offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        networkStatus: "offline",
        prepare: () => Effect.sleep("1 second").pipe(Effect.as(PREPARED_CONNECTION)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(REMOTE_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "offline");
      // The loop wakes on the earlier signal and takes the retry's flag while
      // RetryRequested is still queued, so that signal must not cancel the attempt.
      yield* supervisor.connect;
      yield* supervisor.retryNow;
      yield* TestClock.adjust("1 second");
      const settled = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" || state.phase === "offline",
      );

      expect(settled.phase).toBe("connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }),
  );

  it.effect.each([
    { label: "cancels connection setup", retry: false, phase: "offline", sessions: 0 },
    { label: "does not cancel an explicit retry", retry: true, phase: "connected", sessions: 1 },
  ])("an offline report during setup $label", ({ retry, phase, sessions }) =>
    Effect.gen(function* () {
      const firstAttemptStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: () =>
          Deferred.succeed(firstAttemptStarted, undefined).pipe(
            Effect.andThen(Effect.sleep("1 second")),
            Effect.as(PREPARED_CONNECTION),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(REMOTE_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(firstAttemptStarted);
      if (retry) {
        yield* supervisor.retryNow;
      }
      yield* harness.setNetworkStatus("offline");
      yield* TestClock.adjust("1 second");
      const settled = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" || state.phase === "offline",
      );

      expect(settled.phase).toBe(phase);
      expect(yield* Ref.get(harness.sessionCount)).toBe(sessions);
    }),
  );

  it.effect("connects to the primary environment while the device reports offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ networkStatus: "offline" });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const settled = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" || state.phase === "offline",
      );

      expect(settled).toMatchObject({
        phase: "connected",
        network: "unknown",
        attempt: 1,
        lastFailure: null,
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect(
    "keeps a primary attempt through an offline report and restarts it when the network returns",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: (attempt) =>
            attempt === 1
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed(PREPARED_CONNECTION),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* Deferred.await(started);
        yield* harness.setNetworkStatus("offline");
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(harness.prepareCount)).toBe(1);

        yield* harness.setNetworkStatus("online");
        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the latest failure visible throughout the next connection attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient("Connection timed out.")) : Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");

      const retrying = yield* awaitState(
        supervisor.state,
        (state) =>
          state.phase === "connecting" && state.stage === "preparing" && state.attempt === 2,
      );
      expect(retrying).toMatchObject({
        phase: "connecting",
        stage: "preparing",
        attempt: 2,
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "transport",
          message: "Connection timed out.",
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("converts unexpected driver defects into retryable failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.die(new Error("Native transport defect."))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const logs: unknown[] = [];
      const annotations: unknown[] = [];
      const supervisor = yield* EnvironmentSupervisor.make(REMOTE_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(Layer.merge(harness.dependencies, recordLogs(logs, annotations))));

      const failed = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(failed).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "transport",
          message: "Test environment connection failed unexpectedly.",
        },
      });
      expect(logs).toEqual([["Connection attempt failed with an unexpected defect."]]);
      expect(annotations).toMatchObject([
        { "environment.id": REMOTE_TARGET.environmentId, errorName: "Error" },
      ]);

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    {
      label: "the attempt's network-status read dies",
      firstPrepare: Effect.never,
      statusDefect: true,
      log: "Connection attempt failed with an unexpected defect.",
    },
    {
      label: "an attempt interrupts itself",
      firstPrepare: Effect.interrupt,
      statusDefect: false,
      log: "Connection attempt failed with an unexpected interruption.",
    },
  ])("retries after $label", ({ firstPrepare, statusDefect, log }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) => (attempt === 1 ? firstPrepare : Effect.succeed(PREPARED_CONNECTION)),
      });
      const statusReads = yield* Ref.make(0);
      const logs: unknown[] = [];
      const annotations: Array<Record<string, unknown>> = [];
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provideService(
          Connectivity.Connectivity,
          Connectivity.Connectivity.of({
            // The supervisor reads once at startup; the second read belongs to the first attempt.
            status: Ref.updateAndGet(statusReads, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                statusDefect && count === 2
                  ? Effect.die(new Error("Platform connectivity defect."))
                  : Effect.succeed("online" as const),
              ),
            ),
            changes: Stream.never,
          }),
        ),
        Effect.provide(Layer.merge(harness.dependencies, recordLogs(logs, annotations))),
      );

      const failed = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(failed).toMatchObject({
        generation: 0,
        lastFailure: { _tag: "ConnectionTransientError", reason: "transport" },
      });
      expect(logs).toEqual([[log]]);
      expect(Object.hasOwn(annotations[0]!, "errorType")).toBe(statusDefect);

      yield* TestClock.adjust("999 millis");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      yield* TestClock.adjust("2 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    {
      label: "is interrupted",
      closed: Exit.interrupt(),
      releaseDefect: false,
      log: "Connection attempt failed with an unexpected interruption.",
    },
    {
      label: "fails while interrupted",
      closed: Exit.failCause(
        Cause.combine(Cause.fail(transient("Session closed.")), Cause.interrupt()),
      ),
      releaseDefect: false,
      log: null,
    },
    {
      label: "closes while its release defects",
      closed: Exit.fail(transient("Session closed.")),
      releaseDefect: true,
      log: "Connection release failed with an unexpected defect.",
    },
  ])("reconnects soon after a stable session $label", ({ closed, releaseDefect, log }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
        release: (session) =>
          releaseDefect && session === 1
            ? Effect.die(new Error("Session release defect."))
            : Effect.void,
      });
      const logs: unknown[] = [];
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(Layer.merge(harness.dependencies, recordLogs(logs))));

      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* TestClock.adjust("2 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* TestClock.adjust("1 minute");
      yield* harness.closeLatestSession(closed);
      const lost = yield* awaitState(supervisor.state, (state) => state.phase !== "connected");
      expect(logs).toEqual(log === null ? [] : [[log]]);
      expect(lost).toMatchObject({ phase: "backoff", generation: 1 });
      expect(lost.retryAt).toBeLessThanOrEqual((yield* Clock.currentTimeMillis) + 250);

      yield* TestClock.adjust("250 millis");
      const replaced = yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(replaced.generation).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "does not reuse a live session's generation when its attempt defects after going live",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          prepare: (attempt) =>
            attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
        });
        let logCalls = 0;
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(
          Effect.provide(
            Layer.merge(
              harness.dependencies,
              Logger.layer(
                [
                  // Logging the lost session's interruption throws, so the attempt itself defects.
                  Logger.make(() => {
                    logCalls += 1;
                    if (logCalls === 1) throw new Error("Logger defect.");
                  }),
                ],
                { mergeWithExisting: false },
              ),
            ),
          ),
        );

        yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        yield* TestClock.adjust("2 seconds");
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 1,
        );
        yield* harness.closeLatestSession(Exit.interrupt());
        const backoff = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        expect(backoff).toMatchObject({ generation: 1, lastFailure: null });

        yield* TestClock.adjust("4 seconds");
        const replaced = yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected",
        );
        expect(replaced.generation).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restarts the loop after a defect outside an attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const logs: unknown[] = [];
      let randomReads = 0;
      const supervisor = yield* EnvironmentSupervisor.make(REMOTE_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provideService(Random.Random, {
          // Both session losses below die here, so the second reaches the restart handler again.
          nextDoubleUnsafe: () => {
            randomReads += 1;
            if (randomReads <= 2) throw new Error("Random defect.");
            return 1 - Number.EPSILON;
          },
          nextIntUnsafe: () => 0,
        }),
        Effect.provide(Layer.merge(harness.dependencies, recordLogs(logs))),
      );

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* harness.closeLatestSession();
      const restarted = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(logs).toEqual([["Connection loop failed with an unexpected defect."]]);
      expect(restarted).toMatchObject({
        attempt: 1,
        generation: 1,
        lastFailure: { _tag: "ConnectionTransientError", reason: "transport" },
        retryAt: (yield* Clock.currentTimeMillis) + 300_000,
      });

      yield* TestClock.adjust("299999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("1 millis");
      const reconnected = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected",
      );
      expect(reconnected.generation).toBe(2);

      yield* harness.setNetworkStatus("offline");
      yield* harness.closeLatestSession();
      const offline = yield* awaitState(supervisor.state, (state) => state.phase !== "connected");
      expect(offline).toMatchObject({
        phase: "offline",
        attempt: 1,
        lastFailure: { _tag: "ConnectionTransientError", reason: "transport" },
      });

      yield* supervisor.retryNow;
      const retried = yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(retried.generation).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["connecting", "connected"] as const)(
    "stops attempting when its scope closes while %s",
    (phase) =>
      Effect.gen(function* () {
        const preparing = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: () =>
            Deferred.succeed(preparing, undefined).pipe(
              Effect.andThen(
                phase === "connected" ? Effect.succeed(PREPARED_CONNECTION) : Effect.never,
              ),
            ),
        });
        const logs: unknown[] = [];
        const scope = yield* Scope.make();
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(
          Effect.provide(Layer.merge(harness.dependencies, recordLogs(logs))),
          Scope.provide(scope),
        );

        yield* Deferred.await(preparing);
        yield* awaitState(supervisor.state, (state) => state.phase === phase);
        // Yielding between finalizers lets the loop run if the queue shuts down before its interrupt.
        yield* Scope.close(scope, Exit.void).pipe(
          Effect.provideService(References.MaxOpsBeforeYield, 1),
        );
        yield* TestClock.adjust("10 minutes");
        expect(logs).toEqual([]);
        expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("explicit retry interrupts the current backoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }),
  );

  it.effect.each([
    { label: "fails", cause: Cause.fail(blocked()) },
    {
      label: "fails while interrupted",
      cause: Cause.combine(Cause.fail(blocked()), Cause.interrupt()),
    },
  ])(
    "keeps a blocked host that $label idle until an external signal requests another attempt",
    ({ cause }) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const driver = yield* ConnectionDriver.ConnectionDriver.pipe(
          Effect.provide(harness.dependencies),
        );
        const connects = yield* Ref.make(0);
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(
          // The driver keeps only the typed error of a failed route, so the cause is mixed here.
          Effect.provideService(ConnectionDriver.ConnectionDriver, {
            ...driver,
            connect: (entry, reportProgress) =>
              Ref.updateAndGet(connects, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 1 ? Effect.failCause(cause) : driver.connect(entry, reportProgress),
                ),
              ),
          }),
          Effect.provide(harness.dependencies),
        );

        const failed = yield* awaitState(supervisor.state, (state) => state.lastFailure !== null);
        expect(failed).toMatchObject({
          phase: "blocked",
          lastFailure: { _tag: "ConnectionBlockedError", detail: "Authentication required." },
        });
        yield* TestClock.adjust("1 hour");
        expect(yield* Ref.get(connects)).toBe(1);

        yield* supervisor.retryNow;
        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        expect(yield* Ref.get(connects)).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not let platform wakeups reset an in-flight attempt", () =>
    Effect.gen(function* () {
      const firstAttemptStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: () =>
          Deferred.succeed(firstAttemptStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(firstAttemptStarted);
      yield* Effect.all(
        [
          harness.wake("application-active"),
          harness.wake("application-active"),
          harness.wake("application-active"),
        ],
        { concurrency: "unbounded" },
      );
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      yield* TestClock.adjust("15 seconds");
      const retrying = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      expect(retrying).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reports a slow SSH preparation failure instead of the setup timeout", () =>
    Effect.gen(function* () {
      const preparationFailure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail:
          "Could not prepare the SSH environment: curl: (28) Operation timed out after 240003 milliseconds",
      });
      const harness = yield* makeHarness({
        prepare: () =>
          Effect.sleep("4 minutes").pipe(Effect.andThen(Effect.fail(preparationFailure))),
      });
      const supervisor = yield* EnvironmentSupervisor.make(SSH_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "preparing",
      );
      const firstFailure = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff",
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("4 minutes");

      expect(yield* Fiber.join(firstFailure)).toMatchObject({
        attempt: 1,
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "remote-unavailable",
          message: preparationFailure.message,
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("times out an SSH route that stops answering after a slow preparation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.sleep("4 minutes").pipe(Effect.as(PREPARED_CONNECTION)),
        ready: () => Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(SSH_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "preparing",
      );
      yield* TestClock.adjust("4 minutes");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "synchronizing",
      );
      const firstFailure = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff",
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("90 seconds");

      expect(yield* Fiber.join(firstFailure)).toMatchObject({
        attempt: 1,
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not time a second SSH route's slow preparation", () =>
    Effect.gen(function* () {
      const secondSshTarget = new SshConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        connectionId: "ssh-connection-2",
      });
      const firstRouteFailure = transient("The first SSH route dropped while synchronizing.");
      const harness = yield* makeHarness({
        prepare: (attempt, target) =>
          attempt === 1
            ? Effect.succeed(preparedFor(target))
            : Effect.sleep("4 minutes").pipe(
                Effect.andThen(
                  Effect.fail(
                    new ConnectionTransientError({
                      reason: "remote-unavailable",
                      detail: "Could not prepare the SSH environment.",
                    }),
                  ),
                ),
              ),
        ready: () => Effect.fail(firstRouteFailure),
      });
      const supervisor = yield* EnvironmentSupervisor.make(
        { ...SSH_ENTRY, alternateRoutes: [{ target: secondSshTarget, profile: Option.none() }] },
        { initiallyDesired: true },
      ).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "preparing",
      );
      const firstFailure = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff",
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("4 minutes");

      // The driver reports the first transient failure across its routes.
      expect(yield* Fiber.join(firstFailure)).toMatchObject({
        attempt: 1,
        lastFailure: { reason: "transport", message: firstRouteFailure.message },
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("EnvironmentSupervisor routes", () => {
  it.effect("connects over the remote route before a slow LAN reachability check times out", () =>
    Effect.gen(function* () {
      const checkingLan = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Deferred.succeed(checkingLan, undefined).pipe(
                Effect.andThen(Effect.sleep("2500 millis")),
                Effect.as("silent" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_REMOTE_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLan);
      yield* TestClock.adjust("500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "SshConnectionTarget",
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("shares one head start across several slow LAN routes", () =>
    Effect.gen(function* () {
      const secondLanTarget = new BearerConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        connectionId: "bearer:second-lan",
      });
      const entry: ConnectionCatalogEntry = {
        ...LAN_THEN_REMOTE_ENTRY,
        alternateRoutes: [
          {
            target: secondLanTarget,
            profile: Option.some(
              new BearerConnectionProfile({
                connectionId: secondLanTarget.connectionId,
                environmentId: TARGET.environmentId,
                label: TARGET.label,
                httpBaseUrl: "http://192.168.56.1:3773/",
                wsBaseUrl: "ws://192.168.56.1:3773/",
              }),
            ),
          },
          { target: REMOTE_TARGET, profile: Option.none() },
        ],
      };
      const checking = yield* Ref.make(0);
      const checkingLans = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.updateAndGet(checking, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 2 ? Deferred.succeed(checkingLans, undefined) : Effect.void,
                ),
                Effect.andThen(Effect.sleep("2500 millis")),
                Effect.as("silent" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(entry, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLans);
      yield* TestClock.adjust("500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "SshConnectionTarget",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still prefers a LAN route that responds within its head start", () =>
    Effect.gen(function* () {
      const checkingLan = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Deferred.succeed(checkingLan, undefined).pipe(
                Effect.andThen(Effect.sleep("100 millis")),
                Effect.as("answered" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_REMOTE_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLan);
      yield* TestClock.adjust("100 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("tries a slow tailnet route that answered before a dead LAN route", () =>
    Effect.gen(function* () {
      const tailnetTarget = new BearerConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        connectionId: "bearer:tailnet",
      });
      // No remote route: a Tailscale-only client away from the LAN.
      const entry: ConnectionCatalogEntry = {
        ...LAN_THEN_REMOTE_ENTRY,
        alternateRoutes: [
          {
            target: tailnetTarget,
            profile: Option.some(
              new BearerConnectionProfile({
                connectionId: tailnetTarget.connectionId,
                environmentId: TARGET.environmentId,
                label: TARGET.label,
                httpBaseUrl: "http://100.100.1.2:3773/",
                wsBaseUrl: "ws://100.100.1.2:3773/",
                network: "tailscale",
              }),
            ),
          },
        ],
      };
      const checking = yield* Ref.make(0);
      const checkingBoth = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Ref.updateAndGet(checking, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 2 ? Deferred.succeed(checkingBoth, undefined) : Effect.void,
            ),
            Effect.andThen(
              connectionRouteId(route.target) === LAN_TARGET.connectionId
                ? Effect.sleep("2500 millis").pipe(Effect.as("silent" as const))
                : Effect.sleep("700 millis").pipe(Effect.as("answered" as const)),
            ),
          ),
        // The dead LAN address never answers the connection itself either.
        prepare: (_attempt, target) =>
          target._tag === "BearerConnectionTarget" &&
          target.connectionId === LAN_TARGET.connectionId
            ? Effect.never
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(entry, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingBoth);
      yield* TestClock.adjust("2500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(
        connectionRouteId(
          Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target,
        ),
      ).toBe("bearer:tailnet");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still tries a slow LAN route when the remote route fails", () =>
    Effect.gen(function* () {
      const checkingLan = yield* Deferred.make<void>();
      const attempted: string[] = [];
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Deferred.succeed(checkingLan, undefined).pipe(
                Effect.andThen(Effect.sleep("2500 millis")),
                Effect.as("answered" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => {
          attempted.push(target._tag);
          return target._tag === "SshConnectionTarget"
            ? Effect.fail(blocked("Pair this device again."))
            : Effect.succeed(preparedFor(target));
        },
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_REMOTE_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLan);
      yield* TestClock.adjust("2500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(attempted).toEqual(["SshConnectionTarget", "BearerConnectionTarget"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "retries instead of waiting on a LAN route that stayed silent after the remote route failed",
    () =>
      Effect.gen(function* () {
        const checkingLan = yield* Deferred.make<void>();
        const attempted: string[] = [];
        const harness = yield* makeHarness({
          checkRoute: (route) =>
            route.target._tag === "BearerConnectionTarget"
              ? Deferred.succeed(checkingLan, undefined).pipe(
                  Effect.andThen(Effect.sleep("2500 millis")),
                  Effect.as("silent" as const),
                )
              : Effect.succeed("unchecked"),
          prepare: (_attempt, target) => {
            attempted.push(target._tag);
            return target._tag === "SshConnectionTarget"
              ? Effect.fail(transient("Remote socket closed."))
              : Effect.never;
          },
        });
        const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_REMOTE_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* Deferred.await(checkingLan);
        yield* TestClock.adjust("2500 millis");
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        expect(attempted).toEqual(["SshConnectionTarget"]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("skips a silent LAN route and connects over the remote route", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Effect.succeed(route.target._tag === "BearerConnectionTarget" ? "silent" : "unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_REMOTE_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("SshConnectionTarget");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("moves to a blocked route's fallback instead of stopping", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "BearerConnectionTarget"
            ? Effect.fail(blocked("The environment credential is invalid."))
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_REMOTE_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("SshConnectionTarget");
    }),
  );
});
