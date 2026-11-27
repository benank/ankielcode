import { scopeThreadRef } from "@ankielcode/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@ankielcode/contracts";
import { Suspense } from "react";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../test/render";
import { LazyThreadRouteView, ThreadRoutePlaceholder } from "./LazyThreadRouteView";

const chunk = vi.hoisted(() => {
  let arrive = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return { arrived, arrive: () => arrive() };
});

vi.mock("./ThreadRouteView", async () => {
  await chunk.arrived;
  const { use, useState } = await import("react");
  const never = new Promise<never>(() => {});
  function Suspends() {
    use(never);
    return null;
  }
  function ThreadRouteView() {
    const [suspended, setSuspended] = useState(false);
    return (
      <button type="button" onClick={() => setSuspended(true)}>
        Thread view
        {suspended ? <Suspends /> : null}
      </button>
    );
  }
  return { ThreadRouteView };
});

const target = {
  kind: "server",
  threadRef: scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1")),
} as const;

// The placeholder can sit on screen for the whole thread-chunk download; it must not repaint.
it("keeps the thread placeholder static", async () => {
  await using screen = await render(<ThreadRoutePlaceholder draft={false} background={false} />);
  const placeholder = screen.container.querySelector("[data-thread-route-placeholder]");
  expect(placeholder).not.toBeNull();
  expect(placeholder?.getAnimations({ subtree: true })).toEqual([]);
});

// A boundary of its own would hide and re-reveal the mounted thread view (and its editor) whenever
// something inside it suspends later; that suspension must reach the boundary above instead.
it("shows the placeholder only until the chunk lands, without a boundary of its own", async () => {
  await using screen = await render(
    <Suspense fallback={<p>Outer fallback</p>}>
      <LazyThreadRouteView target={target} background={false} />
    </Suspense>,
  );
  expect(screen.container.querySelector("[data-thread-route-placeholder]")).not.toBeNull();

  chunk.arrive();
  await expect.element(page.getByRole("button", { name: "Thread view" })).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Thread view" }));
  await expect.element(page.getByText("Outer fallback")).toBeVisible();
  expect(screen.container.querySelector("[data-thread-route-placeholder]")).toBeNull();
});
