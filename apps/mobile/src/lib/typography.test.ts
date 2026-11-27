import { describe, expect, it } from "vite-plus/test";

import { androidCappedLineHeight, CHROME_MAX_FONT_SCALE, chromeFontScale } from "./typography";

// RN's iOS multipliers for Large, xxxLarge and AX5.
const LARGE = 1;
const XXX_LARGE = 1.353;
const AX5 = 3.571;

describe("chromeFontScale", () => {
  it("follows the standard sizes and stops before the accessibility sizes", () => {
    expect(chromeFontScale(0.823)).toBe(0.823);
    expect(chromeFontScale(LARGE)).toBe(1);
    expect(chromeFontScale(XXX_LARGE)).toBe(XXX_LARGE);
    expect(chromeFontScale(AX5)).toBe(CHROME_MAX_FONT_SCALE);
  });
});

describe("androidCappedLineHeight", () => {
  it("leaves the line height alone while the cap does not bite", () => {
    expect(androidCappedLineHeight(17, LARGE, CHROME_MAX_FONT_SCALE)).toBeUndefined();
    expect(
      androidCappedLineHeight(17, CHROME_MAX_FONT_SCALE, CHROME_MAX_FONT_SCALE),
    ).toBeUndefined();
  });

  it("lands on the capped line height once Android scales it by the full font scale", () => {
    const fontScale = 2;
    const lineHeight = androidCappedLineHeight(17, fontScale, CHROME_MAX_FONT_SCALE);
    expect(lineHeight).toBeDefined();
    expect(lineHeight! * fontScale).toBeCloseTo(17 * CHROME_MAX_FONT_SCALE);
  });
});
