import { expect } from "e2e";

import { test, WEB } from "./ac.ts";

test(
  "Tab moves from the add-project Git URL field to its submit button",
  WEB,
  async ({ ac, app, screen, browser }) => {
    await ac.project("demo");
    await ac.open();

    await screen.getByRole("combobox", "Projects").tap();
    await screen.getByRole("option", "Add project").tap();
    await screen.getByText("Git URL").tap();
    await screen.getByRole("combobox").fill("https://github.com/benank/ankielcode.git");
    const submit = screen.getByRole("button", "Continue (Enter)");
    await expect(submit).toBeEnabled();

    await browser.keyboard.press("Tab");
    await app.screenshot("after-tab");
    await expect(submit).toBeFocused();
  },
);
