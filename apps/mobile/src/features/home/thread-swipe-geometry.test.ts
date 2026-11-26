import { describe, expect, it } from "vite-plus/test";

import { fullSwipeSide, swipeFullThreshold, swipeReveal } from "./thread-swipe-geometry";

describe("swipeFullThreshold", () => {
  it("needs most of a wide row, and past the actions on a narrow one", () => {
    expect(swipeFullThreshold(58, 400)).toBeCloseTo(232);
    expect(swipeFullThreshold(116, 200)).toBeCloseTo(160);
  });
});

describe("swipeReveal", () => {
  it("measures each side in its own direction", () => {
    expect(swipeReveal(30, "leading")).toBe(30);
    expect(swipeReveal(30, "trailing")).toBe(0);
    expect(swipeReveal(-30, "trailing")).toBe(30);
    expect(swipeReveal(-30, "leading")).toBe(0);
  });
});

describe("fullSwipeSide", () => {
  const thresholds = { leading: 200, trailing: 220 };

  it("commits the side the row was pulled past its threshold", () => {
    expect(fullSwipeSide(200, thresholds)).toBe("leading");
    expect(fullSwipeSide(-220, thresholds)).toBe("trailing");
  });

  it("commits nothing short of a threshold", () => {
    expect(fullSwipeSide(199, thresholds)).toBeNull();
    expect(fullSwipeSide(-219, thresholds)).toBeNull();
  });

  it("never commits a leading swipe on a row without leading actions", () => {
    expect(fullSwipeSide(400, { leading: null, trailing: 220 })).toBeNull();
  });
});
