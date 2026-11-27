export const SPLASH_BACKGROUND_COLOR = "#121211";
export const SPLASH_MARK_COLOR = "#F2F2EE";
// Matches expo-splash-screen `imageWidth` in apps/mobile/app.config.ts for 1:1 handoff.
export const SPLASH_ICON_SIZE = 100;

// Motion measured frame by frame from X's iOS launch: an ease-out dip to 70%, then a zoom whose
// log-scale speed ramps up over 90ms and holds at about 0.41 per 60Hz frame.
export const SPLASH_DIP_SCALE = 0.7;
export const SPLASH_DIP_DURATION_MS = 250;
const EXPAND_RAMP_MS = 90;
const EXPAND_LOG_SPEED_PER_MS = 0.0246;
export const SPLASH_REDUCED_MOTION_FADE_MS = 200;

// Non-overlapping 7-vertex outline of the Ankiel A mark normalized to a 200x200 square
// centered at (0, 0). A single simple polygon avoids evenodd self-cancellation at the apex.
export const ANKIEL_MARK_VERTICES = [
  [-0.064, -0.5],
  [0.064, -0.5],
  [0.475, 0.5],
  [0.31065, 0.5],
  [0, -0.2559],
  [-0.31065, 0.5],
  [-0.475, 0.5],
] as const;

// The zoom pivots on the mark's center, which sits in the gap under the A's inner apex, so the
// legs pass off screen and the gap grows to cover it.
const INNER_APEX_NY = -0.2559;
const INNER_LEG_SLOPE = 0.31065 / (0.5 - INNER_APEX_NY);
const TARGET_MARGIN = 1.05;

/** The scale at which the whole viewport sits inside the gap between the A's legs. */
export function computeSplashTargetScale(width: number, height: number): number {
  const halfWidth = Math.max(1, width) / 2;
  const halfHeight = Math.max(1, height) / 2;
  const scale =
    (halfWidth + INNER_LEG_SLOPE * halfHeight) /
    (SPLASH_ICON_SIZE * INNER_LEG_SLOPE * -INNER_APEX_NY);
  return scale * TARGET_MARGIN;
}

export function computeSplashExpandDurationMs(targetScale: number): number {
  "worklet";
  return EXPAND_RAMP_MS / 2 + Math.log(targetScale / SPLASH_DIP_SCALE) / EXPAND_LOG_SPEED_PER_MS;
}

/** Log-scale growth after `elapsedMs` of the zoom: a smoothstep speed ramp, then constant speed. */
function expandLogGrowth(elapsedMs: number): number {
  "worklet";
  if (elapsedMs >= EXPAND_RAMP_MS) {
    return EXPAND_LOG_SPEED_PER_MS * (elapsedMs - EXPAND_RAMP_MS / 2);
  }
  const u = elapsedMs / EXPAND_RAMP_MS;
  return EXPAND_LOG_SPEED_PER_MS * EXPAND_RAMP_MS * (u * u * u - (u * u * u * u) / 2);
}

/** `dipProgress` is eased; `expandProgress` is linear time over the expand duration. */
export function computeSplashScale(
  dipProgress: number,
  expandProgress: number,
  targetScale: number,
): number {
  "worklet";
  if (expandProgress <= 0) {
    return 1 - (1 - SPLASH_DIP_SCALE) * dipProgress;
  }
  const durationMs = computeSplashExpandDurationMs(targetScale);
  return Math.min(
    targetScale,
    SPLASH_DIP_SCALE * Math.exp(expandLogGrowth(Math.min(1, expandProgress) * durationMs)),
  );
}

/**
 * The dark background stays until the A covers the viewport, then fades while the A grows
 * past the edges, reaching zero when the viewport sits inside the gap between its legs.
 */
export function computeSplashBackgroundOpacity(
  scale: number,
  width: number,
  height: number,
  targetScale: number,
): number {
  "worklet";
  const coverScale = Math.max(width / (SPLASH_ICON_SIZE * 0.95), height / SPLASH_ICON_SIZE);
  if (scale <= coverScale) return 1;
  if (scale >= targetScale) return 0;
  return 1 - Math.log(scale / coverScale) / Math.log(targetScale / coverScale);
}

export function buildAnkielMarkPath(width: number, height: number, scale: number): string {
  "worklet";
  const cx = width / 2;
  const cy = height / 2;
  const unit = SPLASH_ICON_SIZE * scale;

  const x0 = cx + -0.064 * unit;
  const y0 = cy + -0.5 * unit;
  const x1 = cx + 0.064 * unit;
  const x2 = cx + 0.475 * unit;
  const y2 = cy + 0.5 * unit;
  const x3 = cx + 0.31065 * unit;
  const y4 = cy + INNER_APEX_NY * unit;
  const x5 = cx + -0.31065 * unit;
  const x6 = cx + -0.475 * unit;

  return `M${x0} ${y0}L${x1} ${y0}L${x2} ${y2}L${x3} ${y2}L${cx} ${y4}L${x5} ${y2}L${x6} ${y2}Z`;
}
