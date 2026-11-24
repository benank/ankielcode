import { expect } from "e2e";

import { test, WEB } from "./ac.ts";

test(
  "A seeded thread opens by its link and shows its history",
  WEB,
  async ({ ac, app, screen }) => {
    const project = await ac.project("demo");
    const thread = await ac.thread({
      project,
      title: "Earlier work",
      messages: ["first", "second"],
    });
    await ac.open(thread);

    await expect(screen.getByText("second fixture turn complete", { exact: false })).toBeVisible();
    await app.screenshot("thread");
  },
);
