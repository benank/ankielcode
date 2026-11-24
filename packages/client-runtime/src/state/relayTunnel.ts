import { type EnvironmentId, WS_METHODS } from "@ankielcode/contracts";
import * as Effect from "effect/Effect";
import { type Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createRelayTunnelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:relay-status",
    tag: WS_METHODS.serverGetRelayStatus,
    staleTimeMs: 5_000,
  });

  const refreshStatus = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    Effect.sync(() => {
      registry.refresh(status({ environmentId, input: {} }));
    });

  return {
    status,
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:relay-configure",
      tag: WS_METHODS.serverConfigureRelay,
      onSuccess: ({ environmentId }, registry) => refreshStatus(registry, environmentId),
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:relay-disconnect",
      tag: WS_METHODS.serverDisconnectRelay,
      onSuccess: ({ environmentId }, registry) => refreshStatus(registry, environmentId),
    }),
  };
}
