import { expect, it } from "vite-plus/test";

import {
  buildAnkielMarkPath,
  computeSplashBackgroundOpacity,
  computeSplashExpandDurationMs,
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

const viewports = [
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone 17 Pro", width: 402, height: 874 },
  { name: "iPhone 17 Pro Max", width: 440, height: 956 },
  { name: "iPad Pro portrait", width: 1032, height: 1376 },
  { name: "iPad Pro landscape", width: 1376, height: 1032 },
];

function segmentsCross(
  [ax, ay]: readonly [number, number],
  [bx, by]: readonly [number, number],
  [cx, cy]: readonly [number, number],
  [dx, dy]: readonly [number, number],
): boolean {
  const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return (
    side(ax, ay, bx, by, cx, cy) !== side(ax, ay, bx, by, dx, dy) &&
    side(cx, cy, dx, dy, ax, ay) !== side(cx, cy, dx, dy, bx, by)
  );
}

it.each(viewports)(
  "leaves the whole $name viewport between the legs at targetScale",
  ({ width, height }) => {
    const targetScale = computeSplashTargetScale(width, height);
    const polygon = parsePolygon(buildAnkielMarkPath(width, height, targetScale));
    const corners = [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ] as const;

    for (const [x, y] of [...corners, [width / 2, height / 2] as const]) {
      expect(pointInPolygon(x, y, polygon), `(${x}, ${y}) clear of the A`).toBe(false);
    }
    for (let i = 0; i < corners.length; i++) {
      for (let j = 0; j < polygon.length; j++) {
        expect(
          segmentsCross(
            corners[i]!,
            corners[(i + 1) % corners.length]!,
            polygon[j]!,
            polygon[(j + 1) % polygon.length]!,
          ),
        ).toBe(false);
      }
    }
  },
);

it("follows X's dip and zoom speed curve", () => {
  const targetScale = computeSplashTargetScale(402, 874);
  const durationMs = computeSplashExpandDurationMs(targetScale);
  const at = (elapsedMs: number) => computeSplashScale(1, elapsedMs / durationMs, targetScale);

  expect(computeSplashScale(0, 0, targetScale)).toBe(1);
  expect(computeSplashScale(1, 0, targetScale)).toBeCloseTo(SPLASH_DIP_SCALE, 6);
  // Measured from X: the zoom's log-scale steps per 60Hz frame ramp to about 0.41.
  const steps = [1, 2, 3, 4, 5, 6].map((frame) =>
    Math.log(at((frame * 1000) / 60) / at(((frame - 1) * 1000) / 60)),
  );
  expect(steps.map((step) => Math.round(step * 100) / 100)).toEqual([
    0.01, 0.08, 0.18, 0.29, 0.38, 0.41,
  ]);
  expect(at(durationMs)).toBeCloseTo(targetScale, 4);
});

it("keeps the background until the A covers the screen, then fades it by the end", () => {
  const targetScale = computeSplashTargetScale(402, 874);
  const coverScale = 874 / SPLASH_ICON_SIZE;
  expect(computeSplashBackgroundOpacity(1, 402, 874, targetScale)).toBe(1);
  expect(computeSplashBackgroundOpacity(coverScale, 402, 874, targetScale)).toBe(1);
  expect(
    computeSplashBackgroundOpacity(Math.sqrt(coverScale * targetScale), 402, 874, targetScale),
  ).toBeCloseTo(0.5, 4);
  expect(computeSplashBackgroundOpacity(targetScale, 402, 874, targetScale)).toBe(0);
});
