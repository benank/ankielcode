import { expect } from "e2e";

import { test, WEB } from "./ac.ts";

const FILE = "quarterly-figures.md";

test(
  "The file citation tooltip shows the size even after workspace search finds the file",
  WEB,
  async ({ ac, app, browser, screen }) => {
    const project = await ac.project("demo", { [FILE]: "x".repeat(2048) });
    const thread = await ac.thread({
      project,
      title: "Review figures",
      messages: [`See :codex-file-citation{path="${FILE}" line_range_start="1"}`],
    });
    await ac.open(thread);

    await screen.getByRole("textbox").pressSequentially(`@${FILE}`);
    await screen.getByRole("option", FILE, { exact: false }).hover();
    await browser.keyboard.press("Escape");
    await screen.getByRole("button", /^Agent See/).tap();
    await screen.getByRole("link", /^quarterly-figures\.md/).hover();

    try {
      await expect(
        browser.locator('[data-slot="tooltip-viewport"]:has-text("quarterly-figures.md")'),
      ).toContainText("2 KB");
    } finally {
      await app.screenshot("cited-file-tooltip");
    }
  },
);
