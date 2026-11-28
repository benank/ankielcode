/**
 * The pixel status lights web and mobile draw beside a thread: a 5×5 dot-matrix per
 * frame, laid out once as a tall sprite strip so playing it only slides the strip.
 */
export type PixelStatusKind = "working" | "thinking" | "waiting" | "attention" | "failed" | "done";

// 0 is an unlit dot; 1–3 light it brighter.
export type PixelLevel = 0 | 1 | 2 | 3;
export type PixelFrame = ReadonlyArray<ReadonlyArray<PixelLevel>>;

const PIXEL_GRID_SIZE = 5;
const SIZE = PIXEL_GRID_SIZE;
const CELL = 3;
const DOT = 2;
const PAD = 1;
/** The square, in px, one frame fills. */
export const PIXEL_STATUS_BOX = SIZE * CELL - (CELL - DOT) + PAD * 2;
const BOX = PIXEL_STATUS_BOX;
// The gap below each frame keeps its glow out of the next.
export const PIXEL_STATUS_PITCH = BOX + 4;
const PITCH = PIXEL_STATUS_PITCH;

function frame(
  lit: ReadonlyArray<readonly [row: number, col: number, level: PixelLevel]>,
): PixelFrame {
  const grid = Array.from({ length: SIZE }, () => Array<PixelLevel>(SIZE).fill(0));
  for (const [row, col, level] of lit)
    grid[row]![col] = Math.max(grid[row]![col]!, level) as PixelLevel;
  return grid;
}

const PERIMETER = [
  [0, 0],
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [1, 4],
  [2, 4],
  [3, 4],
  [4, 4],
  [4, 3],
  [4, 2],
  [4, 1],
  [4, 0],
  [3, 0],
  [2, 0],
  [1, 0],
] as const;
const INNER_RING = [
  [1, 1],
  [1, 2],
  [1, 3],
  [2, 3],
  [3, 3],
  [3, 2],
  [3, 1],
  [2, 1],
] as const;

// A comet laps the border while a dim spark turns the other way inside it.
const WORKING = Array.from({ length: 16 }, (_, i) => {
  const at = (offset: number) => PERIMETER[(i - offset + 16) % 16]!;
  const inner = INNER_RING[(16 - i) % 8]!;
  return frame([
    [...at(0), 3],
    [...at(1), 2],
    [...at(2), 1],
    [...at(3), 1],
    [...inner, 1],
    [2, 2, i % 4 < 2 ? 2 : 1],
  ]);
});

// A wave rolls across, a column of light behind its crest.
const THINKING = Array.from({ length: 10 }, (_, i) =>
  frame(
    Array.from({ length: SIZE }, (_, col) => {
      const row = Math.round(2 - 1.6 * Math.sin((2 * Math.PI * (col - i / 2)) / SIZE));
      return [row, col, col === Math.floor(i / 2) ? 3 : 2] as const;
    }),
  ),
);

// Three dots hop in turn, then rest together.
const WAITING = Array.from({ length: 12 }, (_, i) => {
  const hopping = i < 9 ? Math.floor(i / 3) : -1;
  return frame(
    [0, 2, 4].map((col, dot) =>
      dot === hopping ? ([1, col, 3] as const) : ([2, col, hopping === -1 ? 2 : 1] as const),
    ),
  );
});

const BANG = [
  [0, 2],
  [1, 2],
  [2, 2],
  [4, 2],
] as const;
const bang = (level: PixelLevel) => BANG.map(([row, col]) => [row, col, level] as const);
// An exclamation that flashes, throws a ring of sparks, and dims.
const ATTENTION = [
  frame(bang(3)),
  frame(bang(3)),
  frame([...bang(3), [1, 1, 2], [1, 3, 2], [3, 1, 2], [3, 3, 2]]),
  frame([...bang(2), [0, 0, 2], [0, 4, 2], [4, 0, 2], [4, 4, 2]]),
  frame([...bang(1), [0, 0, 1], [0, 4, 1], [4, 0, 1], [4, 4, 1]]),
  frame(bang(1)),
  frame(bang(2)),
  frame(bang(3)),
];

const CROSS = [
  [0, 0],
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 4],
  [0, 4],
  [1, 3],
  [3, 1],
  [4, 0],
] as const;
const cross = (level: PixelLevel, center: PixelLevel = level) =>
  CROSS.map(([row, col]) => [row, col, row === 2 ? center : level] as const);
const FAILED = [
  frame(cross(1, 3)),
  frame(cross(2, 3)),
  frame(cross(3)),
  frame(cross(3)),
  frame(cross(2, 3)),
  frame(cross(3)),
];

// A still orb, brightest at its core.
const DONE = [
  [
    [0, 1, 2, 1, 0],
    [1, 2, 3, 2, 1],
    [2, 3, 3, 3, 2],
    [1, 2, 3, 2, 1],
    [0, 1, 2, 1, 0],
  ],
] satisfies PixelFrame[];

/**
 * Live work glows the fixed signal cyan; attention and failure take the theme's warning and error;
 * a finished thread's light glows the fixed signal green. Plain "done" dots stay muted silver.
 */
export type PixelStatusTone = "active" | "attention" | "failed" | "success" | "done";

export interface PixelAnimation {
  readonly frames: readonly PixelFrame[];
  readonly durationMs: number;
  /** A finite animation holds its last frame; reduced motion shows the rest frame. One frame stays still. */
  readonly iterations: number | "infinite";
  readonly tone: PixelStatusTone;
  /** Waiting reads quieter than working. */
  readonly dim?: boolean;
}

export const PIXEL_ANIMATIONS: Record<PixelStatusKind, PixelAnimation> = {
  working: { frames: WORKING, durationMs: 1200, iterations: "infinite", tone: "active" },
  thinking: { frames: THINKING, durationMs: 1100, iterations: "infinite", tone: "active" },
  waiting: { frames: WAITING, durationMs: 1800, iterations: "infinite", tone: "active", dim: true },
  attention: { frames: ATTENTION, durationMs: 1300, iterations: "infinite", tone: "attention" },
  failed: { frames: FAILED, durationMs: 1500, iterations: 3, tone: "failed" },
  done: { frames: DONE, durationMs: 0, iterations: 1, tone: "success" },
};

export const PIXEL_LEVEL_OPACITY = { 1: 0.4, 2: 0.7, 3: 1 } as const;

function dotPath(cells: ReadonlyArray<readonly [number, number]>, originY: number, grow = 0) {
  return cells
    .map(
      ([row, col]) =>
        `M${PAD + col * CELL - grow} ${originY + PAD + row * CELL - grow}h${DOT + grow * 2}v${DOT + grow * 2}h-${DOT + grow * 2}z`,
    )
    .join("");
}

/** Every unlit dot of one frame. */
export const PIXEL_GRID_PATH = dotPath(
  Array.from({ length: SIZE * SIZE }, (_, i) => [Math.floor(i / SIZE), i % SIZE] as const),
  0,
);

export interface PixelSpriteStrip {
  readonly height: number;
  readonly frameCount: number;
  readonly paths: ReadonlyArray<readonly [level: 1 | 2 | 3, d: string]>;
  /** Lit dots grown by a pixel, for a soft halo where a blur filter is unavailable. */
  readonly haloPath: string;
}

/**
 * Maps a linear 0→1 progress to the strip offset, holding each frame and jumping between them.
 * The step lives in the interpolation because native frame drivers blend their samples, which
 * would slide a stepped value partway between frames on any refresh rate but 60 Hz.
 */
export function pixelStripSteps(frameCount: number) {
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    inputRange.push(frame / frameCount, (frame + 1) / frameCount);
    outputRange.push(-frame * PITCH, -frame * PITCH);
  }
  return { inputRange, outputRange };
}

const STRIPS = new Map<PixelStatusKind, PixelSpriteStrip>();

export function pixelSpriteStrip(kind: PixelStatusKind): PixelSpriteStrip {
  const cached = STRIPS.get(kind);
  if (cached) return cached;
  const { frames } = PIXEL_ANIMATIONS[kind];
  const byLevel = { 1: [] as string[], 2: [] as string[], 3: [] as string[] };
  const halo: string[] = [];
  frames.forEach((grid, index) => {
    grid.forEach((cells, row) =>
      cells.forEach((level, col) => {
        if (level === 0) return;
        byLevel[level].push(dotPath([[row, col]], index * PITCH));
        if (level >= 2) halo.push(dotPath([[row, col]], index * PITCH, 1));
      }),
    );
  });
  const strip: PixelSpriteStrip = {
    height: frames.length * PITCH,
    frameCount: frames.length,
    paths: ([1, 2, 3] as const).flatMap((level) =>
      byLevel[level].length === 0 ? [] : [[level, byLevel[level].join("")] as const],
    ),
    haloPath: halo.join(""),
  };
  STRIPS.set(kind, strip);
  return strip;
}
