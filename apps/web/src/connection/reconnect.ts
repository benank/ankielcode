import { reconnectEnvironments as reconnectCatalogEnvironments } from "@ankielcode/client-runtime/state/connections";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { registerCommands } from "../shortcuts/dispatcher";
import { environmentCatalog } from "./catalog";

export function reconnectEnvironments(): void {
  void reconnectCatalogEnvironments(appAtomRegistry, environmentCatalog);
}

/** The Reconnect Environments command, live on every screen so its menu bar item stays enabled. */
export function installEnvironmentReconnect(): () => void {
  return registerCommands({
    "environments.reconnect": (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      reconnectEnvironments();
    },
  });
}
