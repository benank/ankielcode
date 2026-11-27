import type { EnvironmentId as EnvironmentIdType } from "@ankielcode/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  PullRequestRoutingPermissions,
  type PullRequestRoutingPermission,
  type StoredPullRequestRoutingPermission,
} from "../connection/pullRequestRoutingPermissions.ts";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
  environmentSessionGenerationAtom,
  followStreamInEnvironment,
  runAtomCommand,
} from "./runtime.ts";

export interface EnvironmentCatalogState {
  readonly isReady: boolean;
  readonly entries: ReadonlyMap<EnvironmentIdType, ConnectionCatalogEntry>;
}

export function* enabledEnvironmentIds(
  catalog: EnvironmentCatalogState,
): Generator<EnvironmentIdType> {
  for (const [environmentId, entry] of catalog.entries) {
    if (entry.enabled && entry.unsupportedReason === undefined) {
      yield environmentId;
    }
  }
}

const REFRESH_SETTLE_TIMEOUT = Duration.seconds(10);

/**
 * Pull to refresh for live lists: retries enabled environments that are not connected and waits for
 * each attempt, up to a cap. A connected socket is not probed (a relay can miss the quick probe),
 * and an attempt under way is not retried, since a retry restarts it.
 */
export const refreshEnvironmentConnections = Effect.fn("refreshEnvironmentConnections")(function* (
  environmentIds: ReadonlyArray<EnvironmentIdType>,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const enabled = new Set(
    enabledEnvironmentIds({ isReady: true, entries: yield* SubscriptionRef.get(registry.entries) }),
  );
  const reconnect = Effect.fnUntraced(function* (environmentId: EnvironmentIdType) {
    const before = yield* registry.state(environmentId);
    if (before.phase === "connected" || !before.desired) return;
    if (before.phase !== "connecting") yield* registry.retryNow(environmentId);
    // The supervisor publishes a new state object per transition, so any other non-connecting
    // state is this attempt's outcome, even one published before the subscription started.
    yield* registry.stateChanges(environmentId).pipe(
      Stream.filter((state) => state !== before && state.phase !== "connecting"),
      Stream.runHead,
      Effect.timeoutOption(REFRESH_SETTLE_TIMEOUT),
    );
  });
  yield* Effect.forEach(
    environmentIds.filter((environmentId) => enabled.has(environmentId)),
    (environmentId) =>
      reconnect(environmentId).pipe(
        Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }),
      ),
    { concurrency: "unbounded", discard: true },
  );
});

const EMPTY_ENVIRONMENT_CATALOG_STATE: EnvironmentCatalogState = Object.freeze({
  isReady: false,
  entries: new Map(),
});

export function createEnvironmentCatalogAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serial = { mode: "serial" as const, key: () => "environment-catalog" };
  const catalogAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) =>
          SubscriptionRef.changes(registry.entries).pipe(
            Stream.map((entries) => ({
              isReady: true,
              entries,
            })),
          ),
        ),
      ),
    ),
    { initialValue: EMPTY_ENVIRONMENT_CATALOG_STATE },
  );

  const catalogValueAtom = Atom.make((get) =>
    AsyncResult.getOrElse(get(catalogAtom), () => EMPTY_ENVIRONMENT_CATALOG_STATE),
  ).pipe(Atom.withLabel("environment-catalog-value"));

  const pullRequestRoutingPermissionsAtom = runtime.atom(
    Stream.unwrap(
      PullRequestRoutingPermissions.pipe(Effect.map((permissions) => permissions.changes)),
    ),
    { initialValue: [] as ReadonlyArray<StoredPullRequestRoutingPermission> },
  );
  const pullRequestRoutingPermissionsValueAtom = Atom.make((get) =>
    AsyncResult.getOrElse(get(pullRequestRoutingPermissionsAtom), () => []),
  ).pipe(Atom.withLabel("environment-pull-request-routing-permissions"));
  const setPullRequestRoutingPermission = createRuntimeCommand(runtime, {
    label: "environment-catalog:pull-request-routing-permission",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: Effect.fn(function* (input: {
      readonly environmentId: EnvironmentIdType;
      readonly permission: PullRequestRoutingPermission;
    }) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
      if (entry === undefined)
        return yield* new EnvironmentRegistry.EnvironmentNotRegisteredError({
          environmentId: input.environmentId,
        });
      const permissions = yield* PullRequestRoutingPermissions;
      yield* permissions.set(entry, input.permission);
    }),
  });

  const networkStatusAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) => SubscriptionRef.changes(registry.networkStatus)),
      ),
    ),
    { initialValue: "unknown" as const },
  );

  const networkStatusValueAtom = Atom.make((get) =>
    AsyncResult.getOrElse(get(networkStatusAtom), () => "unknown" as const),
  ).pipe(Atom.withLabel("environment-network-status-value"));

  const stateAtom = Atom.family((environmentId: EnvironmentIdType) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
          ),
        ),
      ),
      { initialValue: AVAILABLE_CONNECTION_STATE },
    ),
  );

  const sessionGenerationAtom = (environmentId: EnvironmentIdType) =>
    environmentSessionGenerationAtom(runtime, environmentId);

  const register = createRuntimeCommand(runtime, {
    label: "environment-catalog:register",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (
      target: Parameters<EnvironmentRegistry.EnvironmentRegistry["Service"]["register"]>[0],
    ) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.register(target)),
      ),
  });
  const remove = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.remove(environmentId)),
      ),
  });
  const setEnabled = createRuntimeCommand(runtime, {
    label: "environment-catalog:set-enabled",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: { readonly environmentId: EnvironmentIdType; readonly enabled: boolean }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.setEnabled(input.environmentId, input.enabled)),
      ),
  });
  const removeRoute = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove-route",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: { readonly environmentId: EnvironmentIdType; readonly routeId: string }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.removeRoute(input.environmentId, input.routeId)),
      ),
  });
  const reorderRoutes = createRuntimeCommand(runtime, {
    label: "environment-catalog:reorder-routes",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: {
      readonly environmentId: EnvironmentIdType;
      readonly routeIds: ReadonlyArray<string>;
    }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.reorderRoutes(input.environmentId, input.routeIds)),
      ),
  });
  const retryNow = createRuntimeCommand(runtime, {
    label: "environment-catalog:retry-now",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.retryNow(environmentId)),
      ),
  });
  const refresh = createRuntimeCommand(runtime, {
    label: "environment-catalog:refresh",
    scheduler: commandScheduler,
    concurrency: {
      mode: "singleFlight",
      key: (environmentIds: ReadonlyArray<EnvironmentIdType>) => environmentIds.join("\n"),
    },
    execute: refreshEnvironmentConnections,
  });

  return {
    catalogAtom,
    catalogValueAtom,
    pullRequestRoutingPermissionsValueAtom,
    setPullRequestRoutingPermission,
    networkStatusAtom,
    networkStatusValueAtom,
    stateAtom,
    sessionGenerationAtom,
    register,
    remove,
    removeRoute,
    reorderRoutes,
    refresh,
    retryNow,
    setEnabled,
  };
}

type EnvironmentCatalogAtoms = ReturnType<typeof createEnvironmentCatalogAtoms>;

/** Reconnects every enabled environment that is not connected, as a pull to refresh does. */
export function reconnectEnvironments(
  registry: AtomRegistry.AtomRegistry,
  catalog: Pick<EnvironmentCatalogAtoms, "catalogValueAtom" | "refresh">,
) {
  const environmentIds = [...enabledEnvironmentIds(registry.get(catalog.catalogValueAtom))];
  return runAtomCommand(registry, catalog.refresh, environmentIds);
}
