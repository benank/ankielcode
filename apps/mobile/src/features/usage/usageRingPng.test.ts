import { describe, expect, it } from "vite-plus/test";

import { usageRingPngUri } from "./usageRingPng";

describe("usageRingPngUri", () => {
  it("encodes a valid PNG data URI and caches repeated inputs", () => {
    const first = usageRingPngUri({
      percent: 42.4,
      activeColor: "#ffffff",
      trackColor: "#8e8e93",
    });
    const second = usageRingPngUri({
      percent: 42.1,
      activeColor: "#ffffff",
      trackColor: "#8e8e93",
    });

    expect(first.startsWith("data:image/png;base64,")).toBe(true);
    expect(second).toBe(first);

    const bytes = Buffer.from(first.slice("data:image/png;base64,".length), "base64");
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("produces distinct icons for empty, partial, and critical usage states", () => {
    const empty = usageRingPngUri({
      percent: undefined,
      activeColor: "#ffffff",
      trackColor: "#8e8e93",
    });
    const half = usageRingPngUri({
      percent: 50,
      activeColor: "#ffffff",
      trackColor: "#8e8e93",
    });
    const critical = usageRingPngUri({
      percent: 95,
      activeColor: "#ff3b30",
      trackColor: "#8e8e93",
    });

    expect(empty).not.toBe(half);
    expect(half).not.toBe(critical);
  });
});
