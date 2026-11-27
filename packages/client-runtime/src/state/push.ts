import { type EnvironmentId, WS_METHODS } from "@ankielcode/contracts";
import * as Effect from "effect/Effect";
import { type Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createPushEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:push-status",
    tag: WS_METHODS.serverGetPushStatus,
    staleTimeMs: 5_000,
  });

  const refreshStatus = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    Effect.sync(() => {
      registry.refresh(status({ environmentId, input: {} }));
    });

  return {
    status,
    register: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:push-register",
      tag: WS_METHODS.serverRegisterPush,
      onSuccess: ({ environmentId }, registry) => refreshStatus(registry, environmentId),
    }),
    unregister: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:push-unregister",
      tag: WS_METHODS.serverUnregisterPush,
      onSuccess: ({ environmentId }, registry) => refreshStatus(registry, environmentId),
    }),
  };
}
