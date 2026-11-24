import { expect } from "e2e";

import { test, WEB } from "./ankiel.ts";

test(
  "A seeded thread opens by its link and shows its history",
  WEB,
  async ({ ankiel, app, screen }) => {
    const project = await ankiel.project("demo");
    const thread = await ankiel.thread({
      project,
      title: "Earlier work",
      messages: ["first", "second"],
    });
    await ankiel.open(thread);

    await expect(screen.getByText("second fixture turn complete", { exact: false })).toBeVisible();
    await app.screenshot("thread");
  },
);
