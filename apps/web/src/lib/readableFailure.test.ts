import { describe, expect, it } from "vite-plus/test";

import { readableFailure } from "./readableFailure";

describe("readableFailure", () => {
  it("replaces a host tool's bare failure with the hint", () => {
    expect(readableFailure(new Error("GitHub CLI failed."), "Try again.")).toBe("Try again.");
    expect(readableFailure(new Error("Branch is protected."), "Try again.")).toBe(
      "Branch is protected.",
    );
  });

  it("cuts a long detail short without splitting a character", () => {
    expect(readableFailure("x".repeat(900), "Try again.")).toBe(`${"x".repeat(319)}…`);
  });
});
