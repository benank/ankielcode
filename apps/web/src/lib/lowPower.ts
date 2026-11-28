import type { DesktopBridge } from "@ankielcode/contracts";

/**
 * Mirrors the desktop shell's power state onto `data-low-power`, which turns off glass and the
 * activity shimmer in index.css. Windows and Linux announce no unplug, so focus asks again.
 */
export function trackLowPower(
  bridge: Pick<DesktopBridge, "getLowPowerState" | "onLowPowerStateChange"> | undefined,
  root: HTMLElement = document.documentElement,
  target: Window = window,
): () => void {
  if (!bridge?.getLowPowerState || !bridge.onLowPowerStateChange) return () => {};
  let changes = 0;
  const apply = (lowPower: boolean) => {
    changes += 1;
    root.toggleAttribute("data-low-power", lowPower);
  };
  const ask = () => {
    const asked = changes;
    void bridge.getLowPowerState?.().then(
      // A push that landed while this read was in flight is newer.
      (lowPower) => {
        if (changes === asked) apply(lowPower);
      },
      () => {},
    );
  };
  const unsubscribe = bridge.onLowPowerStateChange(apply);
  target.addEventListener("focus", ask);
  ask();
  return () => {
    unsubscribe();
    target.removeEventListener("focus", ask);
  };
}

/** Jumps instead of animating a scroll when motion is reduced or the machine is saving power. */
export function prefersInstantScroll(): boolean {
  return (
    document.documentElement.hasAttribute("data-low-power") ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
