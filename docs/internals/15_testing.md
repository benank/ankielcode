# Testing

CI runs no tests. `vp run check:changed` runs the tests beside the files you changed, and that is the only test run a change gets. So every test has to earn its runtime.

## What to test

- Test what would hurt if it broke silently: orchestration and event-sourcing, provider protocol translation, auth and permission guards, persistence and migrations, external-format parsing, and race fixes. Skip what types already guarantee, trivial logic, copy, smoke runs, mock-call mirrors, callback wiring, and static markup.
- Extend before you add. Add a row or an assertion to an existing case or table before writing a new `it`.
- Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper, at each call site, or in web and mobile copies of the same logic.
- Write a browser test only for behavior that needs a real browser (layout and scrolling, focus and pointer input, real workers). Logic a component calls gets a unit test beside it (`*.logic.test.ts`); a browser test file costs seconds before its first test runs.
- Bug fixes: a logic, data, state, or protocol bug gets the fewest tests that fail on `main`, then the fix. A purely visual bug gets before/after captures and no test.
- In review, ask for a test only when it would catch a real regression.

## Waiting for work

The server is event-sourced, and side effects run after the command commits. Drain the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the persisted event or `Deferred` that marks the milestone. A test that needs a sleep, a poll, or a longer timeout to pass is wrong.

- `it.effect` runs on a `TestClock`; `Effect.sleep` advances only through `TestClock.adjust`. `it.live` is for subprocess or network fixtures.
- No per-test timeouts or `retry`, and no `performance.now()` / `Date.now()` deltas. Flaky tests are fixed, not retried.
- Browser tests assert through `expect.element` or `vi.waitFor`, never `requestAnimationFrame` or `transitionend`. `vi.mock` factories must not spread a real module that pulls in Shiki or the diff workers.
- No committed `.only`, `fit`, or `fdescribe`. Say why a skipped test is skipped in a comment above it.
- Lint enforces these: `ankielcode/no-test-timeout-or-focus`, `ankielcode/no-frame-waits-in-browser-tests`, `ankielcode/no-wall-clock-in-tests`, `ankielcode/no-real-time-wait-in-tests`, `ankielcode/no-polling-loop-in-tests`.

## Web browser tests

Web browser tests are `*.browser.test.{ts,tsx}` and render with `await using screen = await render(...)` from `apps/web/test/render.tsx` (`ankielcode/require-disposable-render` enforces it).

- Set up what the test drives after mounting (fake timers, late spies) after the render, so it disposes before the unmount.
- A helper that renders and then waits puts the screen in an `AsyncDisposableStack` and `move()`s it out only on success, so a failed wait still unmounts.
- No lifecycle hooks and no module-level mutable state; reset shared mock state with a `setup()` call at the top of the test.
- `router` is on by default. Pass `router: false` only with a one-line comment saying why.

```tsx
it("saves on Enter", async () => {
  const onSave = vi.fn();
  await using screen = await render(<TitleEditor onSave={onSave} />, { router: "/threads/1" });
  await userEvent.type(screen.getByRole("textbox"), "Title{Enter}");
  expect(onSave).toHaveBeenCalledWith("Title");
});
```
