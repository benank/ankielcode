import { secondTick } from "@ankielcode/client-runtime/clock";
import { useSyncExternalStore } from "react";

import { useScreenVisible } from "../../lib/useScreenVisible";

const subscribeNever = () => () => undefined;

/**
 * Retained routes stay mounted when hidden, so an ungated tick would keep
 * re-rendering them. Every visible label shares one module-level tick.
 */
export function useVisibleSecondClock(enabled: boolean): number {
  const ticking = useScreenVisible() && enabled;
  // While paused the snapshot still reads the shared tick, so resuming shows
  // the current second rather than the one the clock stopped on.
  return useSyncExternalStore(
    ticking ? secondTick.subscribe : subscribeNever,
    secondTick.getSnapshot,
    secondTick.getSnapshot,
  );
}
