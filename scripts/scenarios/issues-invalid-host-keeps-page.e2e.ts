import { expect } from "e2e";

import { test, WEB } from "./ankiel.ts";

test("An invalid host filter keeps the Issues page open", WEB, async ({ ankiel, app, browser }) => {
  await ankiel.project("demo");
  await ankiel.open("/issues?host=true");

  await app.screenshot("issues-invalid-host");
  await expect(browser.locator("h1")).toHaveText("Issues");
});
