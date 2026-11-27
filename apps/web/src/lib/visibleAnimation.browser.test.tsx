import type { CSSProperties } from "react";
import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../test/render";
import { PIERRE_TREE_UNSAFE_CSS } from "../pierre-tree-theme";

it("holds every looping indicator still while the window is unfocused", async () => {
  using _cleared = {
    [Symbol.dispose]: () => document.documentElement.removeAttribute("data-window-blurred"),
  };
  await using screen = await render(
    <div>
      <span className="motion-safe:animate-status-pulse" data-testid="indicator" />
      <span className="motion-safe:animate-skeleton" data-testid="indicator" />
      <span className="motion-safe:visible-animate-spin" data-testid="indicator" />
      <span className="live-activity-focus" data-testid="indicator" />
      <span className="live-activity-focus-counter" data-testid="indicator" />
      <span
        className="pixel-status-strip"
        data-testid="indicator"
        style={
          {
            "--pixel-duration": "1s",
            "--pixel-frames": "4",
            "--pixel-iterations": "infinite",
          } as CSSProperties
        }
      />
      <span className="motion-safe:animate-status-ping" data-testid="ping" />
      <div data-testid="tree-host" />
    </div>,
    { router: false },
  );
  // The Pierre file tree renders its loading icon inside a shadow root.
  const shadow = screen.getByTestId("tree-host").element().attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${PIERRE_TREE_UNSAFE_CSS}</style><svg data-icon-name="ankiel-tree-icon-loading"></svg>`;
  const indicators = [
    ...screen
      .getByTestId("indicator")
      .elements()
      .map((element) => {
        // Visible animations run only while observed on screen; mark them running directly.
        (element as HTMLElement).style.setProperty("--visible-animation-state", "running");
        return element;
      }),
    shadow.querySelector("svg")!,
  ];
  const playStates = () =>
    indicators.map((element) => getComputedStyle(element).animationPlayState);
  const ping = () => getComputedStyle(screen.getByTestId("ping").element()).animationName;
  expect(ping()).toBe("status-ping");
  expect(indicators.map((element) => getComputedStyle(element).animationName)).not.toContain(
    "none",
  );
  expect(new Set(playStates())).toEqual(new Set(["running"]));

  document.documentElement.setAttribute("data-window-blurred", "");
  expect(new Set(playStates())).toEqual(new Set(["paused"]));
  // Paused mid-burst, a ping would hold its ring; it rests as it does under reduced motion.
  expect(ping()).toBe("none");

  document.documentElement.removeAttribute("data-window-blurred");
  expect(new Set(playStates())).toEqual(new Set(["running"]));
  expect(ping()).toBe("status-ping");
});
