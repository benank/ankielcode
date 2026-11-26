import type { EnvironmentId } from "@ankielcode/contracts";
import { useRef, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Home's rows stream live, so a pull reconnects the listed environments that are not connected
 * and reads any failed page of older settled threads again.
 */
export function useHomeRefresh(
  environmentIds: ReadonlyArray<EnvironmentId>,
  retryFailedPages: () => void,
) {
  const refreshEnvironments = useAtomCommand(environmentCatalog.refresh, "environment refresh");
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  // Android RefreshControl needs a true-to-false cycle to stop, even with nothing to reconnect.
  const refresh = () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    retryFailedPages();
    void refreshEnvironments(environmentIds).finally(() => {
      refreshingRef.current = false;
      setRefreshing(false);
    });
  };
  return { refreshing, refresh };
}
