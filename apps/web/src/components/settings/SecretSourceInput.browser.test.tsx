import { SecretProviderId } from "@ankielcode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SecretSourceInput } from "./SecretSourceInput";

describe("SecretSourceInput", () => {
  it("shows a saved secret provider reference as unsupported and takes a typed value", async () => {
    const onChange = vi.fn();
    await using screen = await render(
      <SecretSourceInput
        aria-label="API key"
        value={{ provider: SecretProviderId.make("personal"), reference: "op://Private/key" }}
        onChange={onChange}
      />,
    );

    await expect
      .element(screen.getByText(/secret provider “personal”, which Ankiel Code no longer supports/))
      .toBeVisible();
    await expect.element(screen.getByText(/op:\/\//)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("API key"), "sk-typed");
    expect(onChange).toHaveBeenCalled();
  });
});
