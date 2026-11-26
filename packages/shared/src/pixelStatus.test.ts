import { describe, expect, it } from "vite-plus/test";

import { PIXEL_STATUS_PITCH, pixelStripSteps } from "./pixelStatus.ts";

// React Native's native interpolation: the segment before the first input at or past the value.
function interpolate(range: ReturnType<typeof pixelStripSteps>, value: number) {
  const { inputRange, outputRange } = range;
  let index = 1;
  while (index < inputRange.length - 1 && inputRange[index]! < value) index++;
  const [inMin, inMax] = [inputRange[index - 1]!, inputRange[index]!];
  const [outMin, outMax] = [outputRange[index - 1]!, outputRange[index]!];
  return inMin === inMax
    ? outMin
    : outMin + ((value - inMin) * (outMax - outMin)) / (inMax - inMin);
}

describe("pixelStripSteps", () => {
  it("only ever lands the strip on a whole frame, held for an equal share", () => {
    const frameCount = 16;
    const steps = pixelStripSteps(frameCount);
    for (let sample = 0; sample <= 1000; sample++) {
      const progress = sample / 1000;
      const expectedFrame = Math.min(Math.floor(progress * frameCount), frameCount - 1);
      const offset = interpolate(steps, progress) / -PIXEL_STATUS_PITCH;
      // A boundary sample may still show the frame it is leaving.
      expect([expectedFrame, expectedFrame - 1]).toContain(offset);
    }
    expect(interpolate(steps, 1)).toBe(-(frameCount - 1) * PIXEL_STATUS_PITCH);
  });
});
