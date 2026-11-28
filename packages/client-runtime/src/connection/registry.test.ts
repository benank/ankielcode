import {
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type ServerConfig,
} from "@ankielcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
  type ConnectionRoute,
  SshConnectionProfile,
  SshConnectionRegistration,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import type { RouteCheck } from "./driver.ts";
import { connectionRouteId } from "./routes.ts";
import {
  ConnectionTransientError,
  ConnectionBlockedError,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as RpcSession from "../rpc/session.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { runDesktopCommitWithReconnectObserver } from "../state/server.ts";
import { v2ShellSnapshot } from "../state/orchestrationV2TestFixtures.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const SECOND_TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-2"),
  label: "Second environment",
  httpBaseUrl: "https://environment-2.example.test",
  wsBaseUrl: "wss://environment-2.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const REMOTE_TARGET = new SshConnectionTarget({
  environmentId: EnvironmentId.make("environment-remote"),
  label: "Remote environment",
  connectionId: "remote-ssh",
});

const remoteProfile = (target: SshConnectionTarget) =>
  new SshConnectionProfile({
    connectionId: target.connectionId,
    environmentId: target.environmentId,
    label: target.label,
    target: { alias: "test", hostname: "test.example.test", username: "developer", port: 22 },
  });
const remoteRegistration = (target: SshConnectionTarget) =>
  new SshConnectionRegistration({
    target,
    profile: remoteProfile(target),
    credential: new BearerConnectionCredential({ token: "ssh-token" }),
  });

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-bearer"),
  label: "Bearer environment",
  connectionId: "bearer-connection",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: BEARER_TARGET.environmentId,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://bearer.example.test",
  wsBaseUrl: "wss://bearer.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});

const SSH_TARGET: DesktopSshEnvironmentTarget = {
  alias: "test",
  hostname: "test.example.test",
  username: "developer",
  port: 22,
};
const SSH_CONNECTION = new SshConnectionTarget({
  environmentId: EnvironmentId.make("environment-ssh"),
  label: "SSH environment",
  connectionId: "ssh-connection",
});
const SSH_PROFILE = new SshConnectionProfile({
  connectionId: SSH_CONNECTION.connectionId,
  environmentId: SSH_CONNECTION.environmentId,
  label: SSH_CONNECTION.label,
  target: SSH_TARGET,
});

const CACHED_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  ...v2ShellSnapshot,
  snapshotSequence: 1,
};

interface SessionControl {
  readonly closed: Deferred.Deferred<never, ConnectionTransientError>;
}

const makeHarness = Effect.fn("TestEnvironmentRegistry.makeHarness")(function* (
  initialTargets: ReadonlyArray<ConnectionTarget>,
  initialProfiles: ReadonlyArray<ConnectionProfile> = [],
  initialCredentials: ReadonlyArray<readonly [string, ConnectionCredential]> = [],
  options?: {
    readonly prepareError?: ConnectionBlockedError;
    readonly beforeSessionConnect?: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly beforeRegistrationRegister?: (
      registration: ConnectionRegistration,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly beforeRegistrationRemove?: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, Persistence.ConnectionPersistenceError>;
    readonly beforeCredentialPut?: (
      connectionId: string,
    ) => Effect.Effect<void, ConnectionTransientError>;
    readonly checkRoute?: (route: ConnectionRoute) => RouteCheck;
    readonly prepareRoute?: (target: ConnectionTarget) => ConnectionBlockedError | undefined;
    readonly beforePrepareRoute?: (
      target: ConnectionTarget,
    ) => Effect.Effect<ConnectionBlockedError | undefined>;
    readonly initialDisabled?: ReadonlyArray<EnvironmentId>;
    readonly directEndpoints?: ServerConfig["directEndpoints"];
  },
) {
  const storedTargets = yield* Ref.make<ReadonlyArray<ConnectionTarget>>(initialTargets);
  const shellCache = yield* Ref.make(new Map([[TARGET.environmentId, CACHED_SNAPSHOT]]));
  const cacheClears = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
  const ownedDataClears = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
  const sessions = yield* Ref.make<ReadonlyArray<SessionControl>>([]);
  const releasedSessions = yield* Ref.make(0);
  const storedProfiles = yield* Ref.make(
    new Map(initialProfiles.map((profile) => [profile.connectionId, profile])),
  );
  const profileReadCount = yield* Ref.make(0);
  const storedCredentials = yield* Ref.make(new Map(initialCredentials));
  const disconnectedSshTargets = yield* Ref.make<ReadonlyArray<DesktopSshEnvironmentTarget>>([]);

  const storedDisabled = yield* Ref.make<ReadonlySet<EnvironmentId>>(
    new Set(options?.initialDisabled ?? []),
  );
  const targetStore = Persistence.ConnectionTargetStore.of({
    list: Ref.get(storedTargets),
    listDisabled: Ref.get(storedDisabled).pipe(Effect.map((ids) => [...ids])),
  });
  const registrationStore = Persistence.ConnectionRegistrationStore.of({
    register: (registration, routes) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRegister?.(registration) ?? Effect.void;
        yield* Ref.update(storedTargets, (current) =>
          replaceRoutes(current, registration.target.environmentId, routes),
        );
        switch (registration._tag) {
          case "BearerConnectionRegistration":
          case "SshConnectionRegistration":
            yield* Ref.update(storedProfiles, (current) => {
              const next = new Map(current);
              next.set(registration.profile.connectionId, registration.profile);
              return next;
            });
            yield* Ref.update(storedCredentials, (current) => {
              const next = new Map(current);
              next.set(registration.target.connectionId, registration.credential);
              return next;
            });
            return;
        }
      }),
    setRoutes: (environmentId, routes) =>
      Ref.update(storedTargets, (current) => replaceRoutes(current, environmentId, routes)),
    remove: (environmentId) =>
      Effect.gen(function* () {
        yield* options?.beforeRegistrationRemove?.(environmentId) ?? Effect.void;
        const removed = (yield* Ref.get(storedTargets)).filter(
          (target) => target.environmentId === environmentId,
        );
        yield* Ref.update(storedTargets, (current) =>
          current.filter((target) => target.environmentId !== environmentId),
        );
        for (const target of removed) {
          if (target._tag === "BearerConnectionTarget" || target._tag === "SshConnectionTarget") {
            yield* Ref.update(storedProfiles, (current) => {
              const next = new Map(current);
              next.delete(target.connectionId);
              return next;
            });
            yield* Ref.update(storedCredentials, (current) => {
              const next = new Map(current);
              next.delete(target.connectionId);
              return next;
            });
          }
        }
      }),
    setEnabled: (environmentId, enabled) =>
      Ref.update(storedDisabled, (current) => {
        const next = new Set(current);
        if (enabled) {
          next.delete(environmentId);
        } else {
          next.add(environmentId);
        }
        return next;
      }),
  });
  const cacheStore = Persistence.EnvironmentCacheStore.of({
    loadShell: (environmentId) =>
      Ref.get(shellCache).pipe(
        Effect.map((cache) => Option.fromUndefinedOr(cache.get(environmentId))),
      ),
    saveShell: (environmentId, snapshot) =>
      Ref.update(shellCache, (current) => {
        const next = new Map(current);
        next.set(environmentId, snapshot);
        return next;
      }),
    loadThread: (_environmentId, _threadId) => Effect.succeedNone,
    saveThread: (_environmentId, _thread) => Effect.void,
    removeThread: (_environmentId, _threadId) => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: (environmentId) =>
      Ref.update(shellCache, (current) => {
        const next = new Map(current);
        next.delete(environmentId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(cacheClears, (environmentIds) => [...environmentIds, environmentId]),
        ),
      ),
  });
  const ownedDataCleanup = Persistence.EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Ref.update(ownedDataClears, (environmentIds) => [...environmentIds, environmentId]),
  });
  const networkStatus = yield* SubscriptionRef.make<"unknown" | "offline" | "online">("online");
  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });
  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) =>
      Ref.update(profileReadCount, (count) => count + 1).pipe(
        Effect.andThen(Ref.get(storedProfiles)),
        Effect.map((current) => Option.fromUndefinedOr(current.get(connectionId))),
      ),
    put: (profile) =>
      Ref.update(storedProfiles, (current) => {
        const next = new Map(current);
        next.set(profile.connectionId, profile);
        return next;
      }),
    remove: (connectionId) =>
      Ref.update(storedProfiles, (current) => {
        const next = new Map(current);
        next.delete(connectionId);
        return next;
      }),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) =>
      Ref.get(storedCredentials).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(connectionId))),
      ),
    put: (connectionId, credential) =>
      (options?.beforeCredentialPut?.(connectionId) ?? Effect.void).pipe(
        Effect.andThen(
          Ref.update(storedCredentials, (current) => {
            const next = new Map(current);
            next.set(connectionId, credential);
            return next;
          }),
        ),
      ),
    remove: (connectionId) =>
      Ref.update(storedCredentials, (current) => {
        const next = new Map(current);
        next.delete(connectionId);
        return next;
      }),
  });
  const sshGateway = ClientCapabilities.SshEnvironmentGateway.of({
    provision: () => Effect.die(new Error("SSH provisioning is not used.")),
    prepare: () => Effect.die(new Error("SSH preparation is not used.")),
    disconnect: (target) => Ref.update(disconnectedSshTargets, (current) => [...current, target]),
  });
  const connectedRoutes = yield* Ref.make<ReadonlyArray<string>>([]);
  const checkRoute = (route: ConnectionRoute) =>
    Effect.succeed(options?.checkRoute?.(route) ?? "unchecked");
  const connectRoute = (entry: ConnectionCatalogEntry, route: ConnectionRoute) =>
    Effect.gen(function* () {
      const target = route.target;
      const credential =
        target._tag === "BearerConnectionTarget"
          ? yield* credentialStore.get(target.connectionId)
          : Option.none();
      const prepared: PreparedConnection = {
        ...PREPARED,
        environmentId: target.environmentId,
        label: target.label,
        httpAuthorization:
          Option.isSome(credential) && credential.value._tag === "BearerConnectionCredential"
            ? { _tag: "Bearer", token: credential.value.token }
            : null,
        target,
      };
      if (options?.prepareError) return yield* options.prepareError;
      const heldError = options?.beforePrepareRoute
        ? yield* options.beforePrepareRoute(target)
        : undefined;
      if (heldError !== undefined) return yield* heldError;
      const routeError = options?.prepareRoute?.(target);
      if (routeError !== undefined) return yield* routeError;
      yield* Ref.update(connectedRoutes, (current) => [...current, connectionRouteId(target)]);
      yield* options?.beforeSessionConnect?.(target.environmentId) ?? Effect.void;
      const closed = yield* Deferred.make<never, ConnectionTransientError>();
      yield* Ref.update(sessions, (current) => [...current, { closed }]);
      const session = yield* Effect.acquireRelease(
        Effect.succeed({
          client: {} as RpcSession.RpcSession["client"],
          initialConfig:
            options?.directEndpoints === undefined
              ? Effect.die(new Error("Config is not used by registry tests."))
              : Effect.succeed({ directEndpoints: options.directEndpoints } as ServerConfig),
          subscribeServerConfig: () =>
            options?.directEndpoints === undefined
              ? Stream.never
              : Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: { directEndpoints: options.directEndpoints } as ServerConfig,
                }),
          ready: Effect.void,
          probe: Effect.void,
          inboundFrames: Effect.succeed(0),
          closed: Deferred.await(closed),
        } satisfies RpcSession.RpcSession),
        () => Ref.update(releasedSessions, (count) => count + 1),
      );
      yield* session.ready;
      return { prepared, session };
    });
  const driver = ConnectionDriver.ConnectionDriver.of({
    connect: (entry, reportProgress) =>
      reportProgress({ stage: "preparing" }).pipe(
        Effect.andThen(
          ConnectionDriver.connectOverRoutes(entry, checkRoute, (route) =>
            connectRoute(entry, route),
          ),
        ),
      ),
    preflight: (_entry, route) =>
      checkRoute(route).pipe(
        Effect.map((check): ConnectionDriver.RoutePreflight =>
          check === "answered" ? "ready" : check,
        ),
      ),
    checkHost: () => Effect.succeed<ConnectionDriver.RouteCheck>("unchecked"),
  });

  const layerCache = Layer.succeed(Persistence.EnvironmentCacheStore, cacheStore);
  const layer = EnvironmentRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Persistence.ConnectionTargetStore, targetStore),
        Layer.succeed(Persistence.ConnectionRegistrationStore, registrationStore),
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, profileStore),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
        Layer.succeed(ClientCapabilities.SshEnvironmentGateway, sshGateway),
        Layer.succeed(Connectivity.Connectivity, connectivity),
        Layer.succeed(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
        ),
        Layer.succeed(ConnectionDriver.ConnectionDriver, driver),
        layerCache,
        Layer.succeed(Persistence.EnvironmentOwnedDataCleanup, ownedDataCleanup),
      ),
    ),
  );

  return {
    layer,
    storedTargets,
    shellCache,
    cacheClears,
    ownedDataClears,
    sessions,
    releasedSessions,
    storedProfiles,
    profileReadCount,
    storedCredentials,
    storedDisabled,
    disconnectedSshTargets,
    networkStatus,
    connectedRoutes,
  };
});

function routesOf(targets: ReadonlyArray<ConnectionTarget>, environmentId: EnvironmentId) {
  return targets.filter((target) => target.environmentId === environmentId);
}

function hasRoutes(targets: ReadonlyArray<ConnectionTarget>, environmentId: EnvironmentId) {
  return routesOf(targets, environmentId).length > 0;
}

function replaceRoutes(
  current: ReadonlyArray<ConnectionTarget>,
  environmentId: EnvironmentId,
  routes: ReadonlyArray<ConnectionTarget>,
): ReadonlyArray<ConnectionTarget> {
  const firstIndex = current.findIndex((target) => target.environmentId === environmentId);
  const others = current.filter((target) => target.environmentId !== environmentId);
  const insertAt =
    firstIndex === -1
      ? others.length
      : current.slice(0, firstIndex).filter((target) => target.environmentId !== environmentId)
          .length;
  return [...others.slice(0, insertAt), ...routes, ...others.slice(insertAt)];
}

function awaitConnectionState(
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
  predicate: (state: SupervisorConnectionState) => boolean,
) {
  return Effect.gen(function* () {
    const current = yield* registry.state(environmentId);
    if (predicate(current)) {
      return current;
    }
    return yield* registry
      .stateChanges(environmentId)
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
  });
}

describe("EnvironmentRegistry", () => {
  it.effect("replays connected state when arming a desktop commit observer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const commits = yield* Ref.make(0);
        const result = yield* runDesktopCommitWithReconnectObserver(
          registry.stateChanges(TARGET.environmentId),
          Ref.update(commits, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail("commit refused")),
          ),
        ).pipe(Effect.flip, Effect.timeout("1 second"));

        expect(result).toBe("commit refused");
        expect(yield* Ref.get(commits)).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("does not acquire a session after the registry scope has already closed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      const registryScope = yield* Scope.make();
      const context = yield* Layer.build(harness.layer).pipe(Scope.provide(registryScope));
      const registry = Context.get(context, EnvironmentRegistry.EnvironmentRegistry);
      const dispatcher = new Scheduler.MixedScheduler("sync", () => () => {}).makeDispatcher();
      const scheduler: Scheduler.Scheduler = {
        executionMode: "sync",
        shouldYield: () => false,
        makeDispatcher: () => dispatcher,
      };

      yield* Scope.close(registryScope, Exit.void);
      yield* registry.start.pipe(Effect.provideService(Scheduler.Scheduler, scheduler));
      dispatcher.flush();

      expect(yield* Ref.get(harness.sessions)).toHaveLength(0);
      expect(yield* Ref.get(harness.releasedSessions)).toBe(0);
    }),
  );

  it.effect("starts persisted environments independently", () =>
    Effect.gen(function* () {
      const bothLoadsStarted = yield* Deferred.make<void>();
      const releaseLoads = yield* Deferred.make<void>();
      const loadCount = yield* Ref.make(0);
      const harness = yield* makeHarness([TARGET, SECOND_TARGET], [], [], {
        beforeSessionConnect: () =>
          Ref.updateAndGet(loadCount, (count) => count + 1).pipe(
            Effect.tap((count) =>
              count === 2 ? Deferred.succeed(bothLoadsStarted, undefined) : Effect.void,
            ),
            Effect.andThen(Deferred.await(releaseLoads)),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const start = yield* Effect.forkChild(registry.start);

        yield* Deferred.await(bothLoadsStarted).pipe(Effect.timeout("1 second"));
        yield* Deferred.succeed(releaseLoads, undefined);
        yield* Fiber.join(start);

        expect(yield* Ref.get(loadCount)).toBe(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("does not expose a persisted environment as disconnected while it starts", () =>
    Effect.gen(function* () {
      const connectionStarted = yield* Deferred.make<void>();
      const finishConnection = yield* Deferred.make<void>();
      const harness = yield* makeHarness([TARGET], [], [], {
        beforeSessionConnect: () =>
          Deferred.succeed(connectionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishConnection)),
          ),
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        expect((yield* registry.state(TARGET.environmentId)).phase).toBe("connecting");

        yield* Deferred.await(connectionStarted);
        expect((yield* registry.state(TARGET.environmentId)).phase).toBe("connecting");
        yield* Deferred.succeed(finishConnection, undefined);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("preserves cached data on connection failure and clears it on explicit removal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        const controls = yield* Ref.get(harness.sessions);
        expect(controls).toHaveLength(1);
        const active = controls[0];
        expect(active).toBeDefined();
        expect((yield* Ref.get(harness.shellCache)).get(TARGET.environmentId)).toEqual(
          CACHED_SNAPSHOT,
        );

        const retryFiber = yield* Effect.forkChild(
          awaitConnectionState(
            registry,
            TARGET.environmentId,
            (state) => state.phase === "backoff",
          ),
        );
        yield* Effect.yieldNow;
        yield* Deferred.fail(
          active!.closed,
          new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
          }),
        );
        yield* Fiber.join(retryFiber);
        expect((yield* Ref.get(harness.shellCache)).get(TARGET.environmentId)).toEqual(
          CACHED_SNAPSHOT,
        );

        yield* registry.remove(TARGET.environmentId);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), TARGET.environmentId)).toBe(false);
        expect((yield* Ref.get(harness.shellCache)).has(TARGET.environmentId)).toBe(false);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([TARGET.environmentId]);
        expect((yield* SubscriptionRef.get(registry.entries)).has(TARGET.environmentId)).toBe(
          false,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a switched-off environment stays off after compatibility clears", () =>
    Effect.gen(function* () {
      const environmentId = REMOTE_TARGET.environmentId;
      const harness = yield* makeHarness([REMOTE_TARGET], [], [], {
        initialDisabled: [environmentId],
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        const error = new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Use a compatible client.",
        });
        yield* registry.setCompatibility(environmentId, error);
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
        expect(entry).toMatchObject({ enabled: false, unsupportedReason: error.message });
        expect(yield* Effect.flip(registry.setEnabled(environmentId, true))).toMatchObject({
          reason: "unsupported",
        });
        expect(yield* Ref.get(harness.sessions)).toHaveLength(0);
        yield* registry.setCompatibility(environmentId, null);
        expect((yield* SubscriptionRef.get(registry.entries)).get(environmentId)?.enabled).toBe(
          false,
        );
        expect(yield* registry.state(environmentId)).toMatchObject({ desired: false });
        expect(yield* Ref.get(harness.storedDisabled)).toEqual(new Set([environmentId]));
        expect(yield* Ref.get(harness.sessions)).toHaveLength(0);
        yield* registry.setEnabled(environmentId, true);
        yield* awaitConnectionState(
          registry,
          environmentId,
          (state) => state.phase === "connected",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("protocol rejection preserves enablement through recovery and relaunch", () =>
    Effect.gen(function* () {
      const error = new ConnectionBlockedError({
        reason: "unsupported",
        detail: "Use a compatible client.",
      });
      const rejection = yield* Ref.make<ConnectionBlockedError | undefined>(error);
      const harness = yield* makeHarness([REMOTE_TARGET], [], [], {
        beforePrepareRoute: () => Ref.get(rejection),
      });
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* SubscriptionRef.changes(registry.entries).pipe(
          Stream.filter(
            (entries) => entries.get(REMOTE_TARGET.environmentId)?.unsupportedReason !== undefined,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        expect(yield* Ref.get(harness.storedDisabled)).toEqual(new Set());
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(REMOTE_TARGET.environmentId),
        ).toMatchObject({ enabled: true, unsupportedReason: error.message });
        yield* awaitConnectionState(
          registry,
          REMOTE_TARGET.environmentId,
          (state) => !state.desired && state.phase === "available",
        );
        expect(yield* Ref.get(harness.sessions)).toHaveLength(0);

        yield* Ref.set(rejection, undefined);
        yield* registry.setCompatibility(REMOTE_TARGET.environmentId, null);
        yield* awaitConnectionState(
          registry,
          REMOTE_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        yield* registry.setCompatibility(REMOTE_TARGET.environmentId, error);
        yield* awaitConnectionState(
          registry,
          REMOTE_TARGET.environmentId,
          (state) => !state.desired && state.phase === "available",
        );
        expect(yield* Ref.get(harness.releasedSessions)).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(
          REMOTE_TARGET.environmentId,
        );
        expect(entry?.enabled).toBe(true);
        expect(entry?.unsupportedReason).toBeUndefined();
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          REMOTE_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect.each([
    { outcome: "connects after a server update", compatible: true },
    { outcome: "blocks again if still incompatible", compatible: false },
  ])("retrying an unsupported saved URL $outcome", ({ compatible }) =>
    Effect.gen(function* () {
      const environmentId = BEARER_TARGET.environmentId;
      const error = new ConnectionBlockedError({
        reason: "unsupported",
        detail: "Update the server to use this client.",
        serverUpdateRequired: true,
      });
      const attempts = yield* Ref.make(0);
      const retryStarted = yield* Deferred.make<void>();
      const retryResult = yield* Deferred.make<ConnectionBlockedError | undefined>();
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
        {
          beforePrepareRoute: () =>
            Effect.gen(function* () {
              if ((yield* Ref.updateAndGet(attempts, (count) => count + 1)) === 1) return error;
              yield* Deferred.succeed(retryStarted, undefined);
              return yield* Deferred.await(retryResult);
            }),
        },
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        const awaitUnsupported = SubscriptionRef.changes(registry.entries).pipe(
          Stream.filter((entries) => entries.get(environmentId)?.unsupportedReason !== undefined),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* awaitUnsupported;
        expect((yield* Ref.get(harness.storedDisabled)).has(environmentId)).toBe(false);
        expect((yield* SubscriptionRef.get(registry.entries)).get(environmentId)).toMatchObject({
          target: BEARER_TARGET,
          enabled: true,
          unsupportedReason: error.message,
          serverUpdateRequired: true,
        });
        expect(yield* Ref.get(attempts)).toBe(1);

        yield* registry.setEnabled(environmentId, true);
        yield* Deferred.await(retryStarted);
        const retrying = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
        expect(retrying?.enabled).toBe(true);
        expect(retrying?.unsupportedReason).toBeUndefined();
        expect(retrying?.serverUpdateRequired).toBeUndefined();
        expect((yield* Ref.get(harness.storedDisabled)).has(environmentId)).toBe(false);

        yield* Deferred.succeed(retryResult, compatible ? undefined : error);
        if (compatible) {
          yield* awaitConnectionState(
            registry,
            environmentId,
            (state) => state.phase === "connected",
          );
          expect(yield* Ref.get(harness.sessions)).toHaveLength(1);
        } else {
          yield* awaitUnsupported;
          expect((yield* SubscriptionRef.get(registry.entries)).get(environmentId)).toMatchObject({
            enabled: true,
            unsupportedReason: error.message,
            serverUpdateRequired: true,
          });
          expect((yield* Ref.get(harness.storedDisabled)).has(environmentId)).toBe(false);
          expect(yield* Ref.get(harness.sessions)).toHaveLength(0);
        }
        expect(yield* Ref.get(attempts)).toBe(2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("switching an environment off disconnects it and persists the flag", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([REMOTE_TARGET]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          REMOTE_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        yield* registry.setEnabled(REMOTE_TARGET.environmentId, false);
        yield* awaitConnectionState(
          registry,
          REMOTE_TARGET.environmentId,
          (state) => state.phase === "available",
        );

        const entry = (yield* SubscriptionRef.get(registry.entries)).get(
          REMOTE_TARGET.environmentId,
        );
        expect(entry?.enabled).toBe(false);
        expect((yield* Ref.get(harness.storedDisabled)).has(REMOTE_TARGET.environmentId)).toBe(
          true,
        );
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), REMOTE_TARGET.environmentId)).toBe(
          true,
        );
        expect(yield* Ref.get(harness.releasedSessions)).toBe(1);

        yield* registry.setEnabled(REMOTE_TARGET.environmentId, true);
        yield* awaitConnectionState(
          registry,
          REMOTE_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        expect((yield* Ref.get(harness.storedDisabled)).has(REMOTE_TARGET.environmentId)).toBe(
          false,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("re-registering a switched-off environment keeps it off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([REMOTE_TARGET], [], [], {
        initialDisabled: [REMOTE_TARGET.environmentId],
      });

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* registry.register(
          remoteRegistration(new SshConnectionTarget({ ...REMOTE_TARGET, label: "Renamed" })),
        );
        yield* Effect.yieldNow;

        const entry = (yield* SubscriptionRef.get(registry.entries)).get(
          REMOTE_TARGET.environmentId,
        );
        expect(entry?.target.label).toBe("Renamed");
        expect(entry?.enabled).toBe(false);
        expect(yield* Ref.get(harness.sessions)).toHaveLength(0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("switching an SSH environment off tears down its managed backend", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([SSH_CONNECTION], [SSH_PROFILE]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          SSH_CONNECTION.environmentId,
          (state) => state.phase === "connected",
        );

        yield* registry.setEnabled(SSH_CONNECTION.environmentId, false);
        yield* awaitConnectionState(
          registry,
          SSH_CONNECTION.environmentId,
          (state) => state.phase === "available",
        );

        expect(yield* Ref.get(harness.disconnectedSshTargets)).toEqual([SSH_TARGET]);
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), SSH_CONNECTION.environmentId)).toBe(
          true,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("moves durable streams to a replacement supervisor", () =>
    Effect.gen(function* () {
      const replacement = new SshConnectionTarget({
        connectionId: REMOTE_TARGET.connectionId,
        environmentId: REMOTE_TARGET.environmentId,
        label: "Replacement remote environment",
      });
      const harness = yield* makeHarness([REMOTE_TARGET]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const firstObserved = yield* Deferred.make<void>();
        const secondObserved = yield* Deferred.make<void>();
        const labels = yield* Ref.make<ReadonlyArray<string>>([]);
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          REMOTE_TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const subscription = yield* Effect.forkChild(
          registry
            .followStream(
              REMOTE_TARGET.environmentId,
              Stream.unwrap(
                EnvironmentSupervisor.EnvironmentSupervisor.pipe(
                  Effect.map((supervisor) =>
                    Stream.concat(Stream.succeed(supervisor.target.label), Stream.never),
                  ),
                ),
              ),
            )
            .pipe(
              Stream.tap((label) =>
                Ref.updateAndGet(labels, (current) => [...current, label]).pipe(
                  Effect.flatMap((current) =>
                    current.length === 1
                      ? Deferred.succeed(firstObserved, undefined)
                      : Deferred.succeed(secondObserved, undefined),
                  ),
                ),
              ),
              Stream.runDrain,
            ),
        );

        yield* Deferred.await(firstObserved).pipe(Effect.timeout("1 second"));
        yield* registry.register(remoteRegistration(replacement));
        yield* Deferred.await(secondObserved).pipe(Effect.timeout("1 second"));
        yield* Fiber.interrupt(subscription);

        expect(yield* Ref.get(labels)).toEqual([REMOTE_TARGET.label, replacement.label]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("moves prepared credential observers when re-pairing an unchanged environment", () =>
    Effect.gen(function* () {
      const replacementCredential = new BearerConnectionCredential({ token: "replacement-token" });
      const harness = yield* makeHarness(
        [BEARER_TARGET],
        [BEARER_PROFILE],
        [[BEARER_TARGET.connectionId, BEARER_CREDENTIAL]],
      );

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const initialObserved = yield* Deferred.make<void>();
        const replacementObserved = yield* Deferred.make<void>();
        const tokens = yield* Ref.make<ReadonlyArray<string>>([]);
        const followedSupervisors = yield* Ref.make(0);
        yield* registry.start;

        const subscription = yield* Effect.forkChild(
          registry
            .followStream(
              BEARER_TARGET.environmentId,
              Stream.unwrap(
                Effect.gen(function* () {
                  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
                  yield* Ref.update(followedSupervisors, (count) => count + 1);
                  return SubscriptionRef.changes(supervisor.prepared);
                }),
              ),
            )
            .pipe(
              Stream.filterMap((prepared) =>
                Option.isSome(prepared) && prepared.value.httpAuthorization?._tag === "Bearer"
                  ? Result.succeed(prepared.value.httpAuthorization.token)
                  : Result.failVoid,
              ),
              Stream.changes,
              Stream.runForEach((token) =>
                Effect.gen(function* () {
                  yield* Ref.update(tokens, (current) => [...current, token]);
                  yield* Deferred.succeed(
                    token === replacementCredential.token ? replacementObserved : initialObserved,
                    undefined,
                  );
                }),
              ),
            ),
        );

        yield* Deferred.await(initialObserved);
        yield* registry.register(remoteRegistration(REMOTE_TARGET));
        yield* awaitConnectionState(
          registry,
          REMOTE_TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        yield* registry.register(
          new BearerConnectionRegistration({
            target: new BearerConnectionTarget({ ...BEARER_TARGET }),
            profile: new BearerConnectionProfile({ ...BEARER_PROFILE }),
            credential: replacementCredential,
          }),
        );
        yield* Deferred.await(replacementObserved);
        yield* Fiber.interrupt(subscription);

        expect(yield* Ref.get(tokens)).toEqual([
          BEARER_CREDENTIAL.token,
          replacementCredential.token,
        ]);
        expect(yield* Ref.get(followedSupervisors)).toBe(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
