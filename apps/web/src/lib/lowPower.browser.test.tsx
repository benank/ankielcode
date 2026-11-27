import type { DesktopBridge } from "@ankielcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../test/render";
import { ComposerSurface } from "../components/chat/ComposerSurface";
import { prefersInstantScroll, trackLowPower } from "./lowPower";

type LowPowerBridge = Pick<DesktopBridge, "getLowPowerState" | "onLowPowerStateChange">;

function fakeBridge() {
  const reads: Array<(lowPower: boolean) => void> = [];
  const answers: Array<Promise<boolean>> = [];
  let push: ((lowPower: boolean) => void) | undefined;
  const bridge: LowPowerBridge = {
    getLowPowerState: () => {
      const answer = new Promise<boolean>((resolve) => reads.push(resolve));
      answers.push(answer);
      return answer;
    },
    onLowPowerStateChange: (listener) => {
      push = listener;
      return () => {
        push = undefined;
      };
    },
  };
  return { bridge, reads, answers, push: (lowPower: boolean) => push?.(lowPower) };
}

const root = document.documentElement;
const lowPower = () => root.hasAttribute("data-low-power");

// Whatever a test leaves on the shared root is cleared when it ends.
const lowPowerCleared = () => ({
  [Symbol.dispose]: () => root.removeAttribute("data-low-power"),
});

describe("trackLowPower", () => {
  it("applies the shell's state, keeps a push over an older read, and asks again on focus", async () => {
    using _cleared = lowPowerCleared();
    const { bridge, reads, answers, push } = fakeBridge();
    const stop = trackLowPower(bridge);
    expect(reads).toHaveLength(1);
    reads[0]!(true);
    // trackLowPower's handler was attached first, so it has run once the answer settles.
    await answers[0];
    expect(lowPower()).toBe(true);

    window.dispatchEvent(new Event("focus"));
    expect(reads).toHaveLength(2);
    push(false);
    expect(lowPower()).toBe(false);
    reads[1]!(true);
    await answers[1];
    expect(lowPower()).toBe(false);

    window.dispatchEvent(new Event("focus"));
    reads[2]!(true);
    await answers[2];
    expect(lowPower()).toBe(true);
    expect(prefersInstantScroll()).toBe(true);

    stop();
    push(false);
    window.dispatchEvent(new Event("focus"));
    expect(lowPower()).toBe(true);
    expect(reads).toHaveLength(3);
  });

  it("does nothing without a desktop bridge", () => {
    trackLowPower(undefined)();
    expect(lowPower()).toBe(false);
    expect(prefersInstantScroll()).toBe(false);
  });
});

describe("glass and shimmer cost", () => {
  const beforeFilter = (element: Element) => getComputedStyle(element, "::before").backdropFilter;

  it("turns the composer glass opaque while working, while the feed scrolls, and on low power", async () => {
    using _cleared = lowPowerCleared();
    await using screen = await render(
      <div data-testid="column">
        <ComposerSurface.Shell data-testid="resting" />
        <ComposerSurface.Shell data-testid="working" data-working />
        <div className="surface-glass" data-testid="surface" />
        <span className="live-activity-focus" data-testid="shimmer" />
      </div>,
      { router: false },
    );
    const column = screen.getByTestId("column").element();
    const resting = screen.getByTestId("resting").element();
    const working = screen.getByTestId("working").element();
    const surface = screen.getByTestId("surface").element();
    const shimmer = screen.getByTestId("shimmer").element();
    expect(beforeFilter(resting)).toContain("blur(12px)");
    expect(beforeFilter(working)).toContain("blur(0px)");
    expect(getComputedStyle(working).getPropertyValue("--glass-opacity").trim()).toBe("100%");

    column.setAttribute("data-timeline-scrolling", "");
    expect(beforeFilter(resting)).toContain("blur(0px)");
    column.removeAttribute("data-timeline-scrolling");
    expect(beforeFilter(resting)).toContain("blur(12px)");

    expect(getComputedStyle(surface).backdropFilter).toContain("blur(12px)");
    expect(getComputedStyle(shimmer).animationName).toBe("live-activity-focus");
    root.setAttribute("data-low-power", "");
    expect(beforeFilter(resting)).toContain("blur(0px)");
    expect(getComputedStyle(surface).backdropFilter).toContain("blur(0px)");
    expect(getComputedStyle(shimmer).animationName).toBe("none");
    expect(getComputedStyle(shimmer).opacity).toBe("0");
  });
});
