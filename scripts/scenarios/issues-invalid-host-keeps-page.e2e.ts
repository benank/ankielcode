import { expect } from "e2e";

import { test, WEB } from "./ac.ts";

test("An invalid host filter keeps the Issues page open", WEB, async ({ ac, app, browser }) => {
  await ac.project("demo");
  await ac.open("/issues?host=true");

  await app.screenshot("issues-invalid-host");
  await expect(browser.locator("h1")).toHaveText("Issues");
});
