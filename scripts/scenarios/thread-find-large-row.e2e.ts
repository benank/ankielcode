import { expect } from "e2e";

import { test, WEB } from "./ac.ts";

test("Find highlights a row with 200,000 matches", WEB, async ({ ac, app, screen, browser }) => {
  const project = await ac.project("find-proof");
  await ac.thread({ project, title: "Large row proof", messages: ["go"] });
  await ac.open();
  const thread = screen.getByRole("button", /^Large row proof,/);
  await expect(thread).toBeVisible({ timeout: 120_000 });
  await thread.tap();
  await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();
  await browser.keyboard.press("Control+f");
  const find = screen.getByRole("searchbox", "Find in thread");
  await expect(find).toBeVisible();
  // A DOM fixture reaches the real highlight effect without a giant replay recording.
  await browser.evaluate(`(() => {
    const scope = [...document.querySelectorAll("[data-thread-find-text]")].find((element) =>
      element.textContent.includes("first fixture turn complete"),
    );
    if (!scope) throw new Error("The replayed response is not mounted");
    scope.textContent = "e x".repeat(200_000);
    Object.assign(scope.style, { maxHeight: "180px", overflow: "hidden" });
    return true;
  })()`);
  await find.fill("e");
  try {
    await expect
      .poll(() =>
        browser.evaluate<number>(
          `(CSS.highlights.get("ankiel-thread-find")?.size ?? 0) +
         (CSS.highlights.get("ankiel-thread-find-active")?.size ?? 0)`,
        ),
      )
      .toBe(200_000);
  } finally {
    await app.screenshot("large-row-find");
  }
});
