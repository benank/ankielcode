import { SecretReference } from "@ankielcode/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { unsupportedSecretNotice } from "./settingsSecretNotice.ts";

const decodeSecretReference = Schema.decodeSync(SecretReference);

describe("unsupportedSecretNotice", () => {
  it("names the secret provider a saved reference reads from", () => {
    const reference = decodeSecretReference({
      provider: "1password",
      reference: "op://vault/item/field",
    });
    expect(unsupportedSecretNotice(reference)).toBe(
      "Read from the secret provider “1password”, which Ankiel Code no longer supports. Enter the value to replace it.",
    );
  });

  it("says nothing about a typed value or an empty field", () => {
    expect(unsupportedSecretNotice("sk-live")).toBeNull();
    expect(unsupportedSecretNotice("")).toBeNull();
    expect(unsupportedSecretNotice(undefined)).toBeNull();
  });
});
