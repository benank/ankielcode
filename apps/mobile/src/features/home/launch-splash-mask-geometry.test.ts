import { expect, it } from "vite-plus/test";

import {
  buildAnkielMarkPath,
  buildSplashCutoutPath,
  computeMarkFillOpacity,
  computeSplashScale,
  computeSplashTargetScale,
  SPLASH_DIP_SCALE,
  SPLASH_ICON_SIZE,
} from "./launch-splash-mask-geometry";

function parsePolygon(path: string): ReadonlyArray<readonly [number, number]> {
  const vertices: Array<readonly [number, number]> = [];
  for (const match of path.matchAll(/[ML](-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)) {
    vertices.push([Number(match[1]), Number(match[2])]);
  }
  return vertices;
}

function pointInPolygon(
  x: number,
  y: number,
  polygon: ReadonlyArray<readonly [number, number]>,
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

it("centers the A mark at the exact 95x100 launch size at scale 1", () => {
  const polygon = parsePolygon(buildAnkielMarkPath(393, 852, 1));
  expect(polygon).toHaveLength(7);

  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  expect(maxX - minX).toBeCloseTo(SPLASH_ICON_SIZE * 0.95, 3);
  expect(maxY - minY).toBeCloseTo(SPLASH_ICON_SIZE, 3);
  expect((minX + maxX) / 2).toBeCloseTo(393 / 2, 3);
  expect((minY + maxY) / 2).toBeCloseTo(852 / 2, 3);
});

it.each([
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone 16 Pro", width: 393, height: 852 },
  { name: "Android phone", width: 412, height: 915 },
  { name: "iPad Pro portrait", width: 1032, height: 1376 },
  { name: "iPad Pro landscape", width: 1376, height: 1032 },
])("fully clears all four viewport corners at targetScale on $name", ({ width, height }) => {
  const targetScale = computeSplashTargetScale(width, height);
  const polygon = parsePolygon(buildAnkielMarkPath(width, height, targetScale));

  for (const [x, y] of [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
    [width / 2, height / 2],
  ] as const) {
    expect(pointInPolygon(x, y, polygon), `(${x}, ${y}) inside expanded A`).toBe(true);
  }
});

it("builds an outer viewport rect plus inner A cutout path", () => {
  const cutout = buildSplashCutoutPath(400, 800, 1);
  expect(cutout.startsWith("M0 0H400V800H0Z M")).toBe(true);
});

it("dips smoothly before expanding exponentially and fading the light fill early", () => {
  const targetScale = computeSplashTargetScale(393, 852);
  expect(computeSplashScale(0, 0, targetScale)).toBe(1);
  expect(computeSplashScale(1, 0, targetScale)).toBeCloseTo(SPLASH_DIP_SCALE, 6);
  expect(computeSplashScale(1, 0.5, targetScale)).toBeCloseTo(
    Math.sqrt(SPLASH_DIP_SCALE * targetScale),
    4,
  );
  expect(computeSplashScale(1, 1, targetScale)).toBeCloseTo(targetScale, 4);

  expect(computeMarkFillOpacity(0)).toBe(1);
  expect(computeMarkFillOpacity(0.14)).toBeCloseTo(0.5, 4);
  expect(computeMarkFillOpacity(0.28)).toBe(0);
  expect(computeMarkFillOpacity(1)).toBe(0);
});
