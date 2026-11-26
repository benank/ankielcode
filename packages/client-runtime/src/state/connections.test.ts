import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@ankielcode/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as TestClock from "effect/testing/TestClock";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createEnvironmentCatalogAtoms, refreshEnvironmentConnections } from "./connections.ts";

const ENVIRONMENT_ID = EnvironmentId.make("catalog-environment");

const connectionState = (
  overrides: Partial<SupervisorConnectionState>,
): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  ...overrides,
});

const makeCatalogHarness = Effect.fn("TestCatalog.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make(
    connectionState({ phase: "connected", attempt: 1, generation: 1 }),
  );
  const session = yield* SubscriptionRef.make(Option.some({} as RpcSession.RpcSession));
  const supervisor = {
    state,
    session,
  } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const catalog = createEnvironmentCatalogAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
  );
  const atom = catalog.sessionGenerationAtom(ENVIRONMENT_ID);
  const atoms = AtomRegistry.make();
  const unmount = atoms.mount(atom);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unmount();
      atoms.dispose();
    }),
  );
  yield* Effect.yieldNow;
  /** Moves the supervisor to `next`, with a new session object when one is established. */
  const generationAfter = (
    next: SupervisorConnectionState,
    nextSession: Option.Option<RpcSession.RpcSession> = Option.none(),
  ) =>
    SubscriptionRef.set(session, nextSession).pipe(
      Effect.andThen(SubscriptionRef.set(state, next)),
      Effect.andThen(Effect.yieldNow),
      Effect.map(() => atoms.get(atom)),
    );
  return { generation: () => atoms.get(atom), generationAfter };
});

const lastFailure = new ConnectionTransientError({ reason: "transport", detail: "Down." });
const newSession = () => Option.some({} as RpcSession.RpcSession);

describe("environment catalog atoms", () => {
  it.effect("changes the session generation only when a new session comes up", () =>
    Effect.gen(function* () {
      const { generation, generationAfter } = yield* makeCatalogHarness();
      const first = generation();
      // A retry reports the generation it is attempting before it is established.
      expect(
        yield* generationAfter(
          connectionState({ phase: "connecting", stage: "opening", generation: 2, lastFailure }),
        ),
      ).toBe(first);
      expect(
        yield* generationAfter(
          connectionState({ phase: "backoff", generation: 1, lastFailure, retryAt: 1 }),
        ),
      ).toBe(first);
      expect(
        yield* generationAfter(
          connectionState({ phase: "connected", attempt: 2, generation: 2 }),
          newSession(),
        ),
      ).not.toBe(first);
    }),
  );

  it.effect("changes when a replaced supervisor's first session reuses an old generation", () =>
    Effect.gen(function* () {
      const { generation, generationAfter } = yield* makeCatalogHarness();
      const first = generation();
      yield* generationAfter(
        connectionState({ phase: "backoff", generation: 1, lastFailure, retryAt: 1 }),
      );
      // Re-pairing or editing a route installs a new supervisor, whose counter starts over.
      yield* generationAfter(connectionState({ phase: "available", generation: 0 }));
      expect(
        yield* generationAfter(
          connectionState({ phase: "connected", attempt: 1, generation: 1 }),
          newSession(),
        ),
      ).not.toBe(first);
    }),
  );
});

interface RefreshEnvironment {
  readonly id: string;
  readonly state: SupervisorConnectionState;
  readonly enabled?: boolean;
  readonly unsupportedReason?: string;
  /** The states the supervisor publishes once the retry arrives. */
  readonly afterRetry?: ReadonlyArray<SupervisorConnectionState>;
}

const makeRefreshHarness = Effect.fn("TestRefresh.makeHarness")(function* (
  environments: ReadonlyArray<RefreshEnvironment>,
) {
  const states = new Map<
    EnvironmentId,
    SubscriptionRef.SubscriptionRef<SupervisorConnectionState>
  >();
  const entries = new Map<EnvironmentId, ConnectionCatalogEntry>();
  for (const environment of environments) {
    const environmentId = EnvironmentId.make(environment.id);
    states.set(environmentId, yield* SubscriptionRef.make(environment.state));
    entries.set(environmentId, {
      target: new PrimaryConnectionTarget({
        environmentId,
        label: environment.id,
        httpBaseUrl: `https://${environment.id}.test`,
        wsBaseUrl: `wss://${environment.id}.test`,
      }),
      profile: Option.none(),
      enabled: environment.enabled ?? true,
      ...(environment.unsupportedReason === undefined
        ? {}
        : { unsupportedReason: environment.unsupportedReason }),
    });
  }
  const retried: Array<string> = [];
  const stateOf = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
    const state = states.get(environmentId);
    if (state === undefined) {
      return yield* new EnvironmentRegistry.EnvironmentNotRegisteredError({ environmentId });
    }
    return state;
  });
  const service: Pick<
    EnvironmentRegistry.EnvironmentRegistry["Service"],
    "entries" | "state" | "stateChanges" | "retryNow"
  > = {
    entries:
      yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(entries),
    state: (environmentId) => stateOf(environmentId).pipe(Effect.flatMap(SubscriptionRef.get)),
    stateChanges: (environmentId) =>
      Stream.unwrap(stateOf(environmentId).pipe(Effect.map(SubscriptionRef.changes))),
    retryNow: (environmentId) =>
      Effect.gen(function* () {
        retried.push(environmentId);
        const state = states.get(environmentId);
        const next = environments.find((environment) => environment.id === environmentId);
        if (state === undefined || next?.afterRetry === undefined) return;
        for (const published of next.afterRetry) yield* SubscriptionRef.set(state, published);
      }),
  };
  const registry = service as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
  const refresh = (ids: ReadonlyArray<string>) =>
    refreshEnvironmentConnections(ids.map((id) => EnvironmentId.make(id))).pipe(
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
    );
  const publish = (id: string, next: SupervisorConnectionState) =>
    SubscriptionRef.set(states.get(EnvironmentId.make(id))!, next);
  return { refresh, publish, retried };
});

const backoff = () => connectionState({ phase: "backoff", lastFailure, retryAt: 1 });
const connecting = () => connectionState({ phase: "connecting", stage: "opening", lastFailure });
const connected = () => connectionState({ phase: "connected", attempt: 1, generation: 2 });

describe("refreshEnvironmentConnections", () => {
  it.effect("retries enabled environments that are not connected and waits for each outcome", () =>
    Effect.gen(function* () {
      const harness = yield* makeRefreshHarness([
        { id: "live", state: connected() },
        { id: "off", state: backoff(), enabled: false },
        { id: "old-client", state: backoff(), unsupportedReason: "Too old." },
        { id: "not-wanted", state: connectionState({ phase: "available", desired: false }) },
        // Both attempts finish before the refresh subscribes to their state.
        { id: "recovers", state: backoff(), afterRetry: [connecting(), connected()] },
        { id: "still-down", state: backoff(), afterRetry: [connecting(), backoff()] },
      ]);
      yield* harness.refresh([
        "live",
        "off",
        "old-client",
        "not-wanted",
        "recovers",
        "still-down",
        "removed",
      ]);
      expect(harness.retried).toEqual(["recovers", "still-down"]);
    }),
  );

  it.effect("waits for an attempt the supervisor has not finished, up to a cap", () =>
    Effect.gen(function* () {
      const harness = yield* makeRefreshHarness([
        // The supervisor has not taken the retry yet, so the state it holds is not an outcome.
        { id: "queued", state: backoff() },
        // A retry would restart this attempt, so the refresh only waits for it.
        { id: "under-way", state: connecting() },
        { id: "hung", state: connectionState({ phase: "offline" }), afterRetry: [connecting()] },
      ]);
      for (const id of ["queued", "under-way"]) {
        const pending = yield* Effect.forkChild(harness.refresh([id]));
        yield* TestClock.adjust("5 seconds");
        expect(pending.pollUnsafe()).toBeUndefined();
        yield* harness.publish(id, connected());
        yield* Fiber.join(pending);
      }

      const hung = yield* Effect.forkChild(harness.refresh(["hung"]));
      yield* TestClock.adjust("9 seconds");
      expect(hung.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(hung);
      expect(harness.retried).toEqual(["queued", "hung"]);
    }),
  );
});
