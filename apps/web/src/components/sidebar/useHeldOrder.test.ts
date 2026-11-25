import { describe, expect, it } from "vite-plus/test";

import { mergeHeldOrder } from "./useHeldOrder";

describe("mergeHeldOrder", () => {
  it("keeps the held order while threads only move", () => {
    expect(mergeHeldOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual(["a", "b", "c"]);
  });

  it("drops threads that left and places new ones where they sort", () => {
    expect(mergeHeldOrder(["a", "b", "c"], ["d", "c", "a"])).toEqual(["d", "a", "c"]);
  });

  it("matches the desired order once nothing is held", () => {
    expect(mergeHeldOrder([], ["b", "a"])).toEqual(["b", "a"]);
  });
});
