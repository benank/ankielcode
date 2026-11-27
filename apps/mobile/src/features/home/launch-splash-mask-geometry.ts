export const SPLASH_BACKGROUND_COLOR = "#121211";
export const SPLASH_MARK_COLOR = "#F2F2EE";
// Matches expo-splash-screen `imageWidth` in apps/mobile/app.config.ts for 1:1 handoff.
export const SPLASH_ICON_SIZE = 100;

export const SPLASH_DIP_SCALE = 0.86;
export const SPLASH_DIP_DURATION_MS = 95;
export const SPLASH_EXPAND_DURATION_MS = 420;
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

// Center of the solid apex (midpoint between top edge -0.5 and inner apex -0.2559) and the
// radius of the largest circle fully inscribed inside it, both normalized to iconSize.
export const ANKIEL_MARK_PIVOT_NY = -0.37795;
export const ANKIEL_MARK_APEX_RADIUS = 0.1055;
const CORNER_CLEARANCE_MARGIN = 1.12;
const MARK_FADE_END_PROGRESS = 0.28;

export function computeSplashTargetScale(width: number, height: number): number {
  const iconSize = SPLASH_ICON_SIZE;
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const pivotY = safeHeight / 2 + ANKIEL_MARK_PIVOT_NY * iconSize;
  const maxDx = safeWidth / 2;
  const maxDy = Math.max(pivotY, safeHeight - pivotY);
  const maxCornerDistance = Math.hypot(maxDx, maxDy);
  const apexRadius = ANKIEL_MARK_APEX_RADIUS * iconSize;
  return Math.max(1, Math.ceil((maxCornerDistance / apexRadius) * CORNER_CLEARANCE_MARGIN));
}

export function computeSplashScale(
  dipProgress: number,
  expandProgress: number,
  targetScale: number,
): number {
  "worklet";
  if (expandProgress <= 0) {
    return 1 - (1 - SPLASH_DIP_SCALE) * dipProgress;
  }
  // Exponential interpolation in log-scale keeps visual expansion speed steady across the screen.
  return SPLASH_DIP_SCALE * Math.pow(targetScale / SPLASH_DIP_SCALE, expandProgress);
}

export function computeMarkFillOpacity(expandProgress: number): number {
  "worklet";
  if (expandProgress <= 0) return 1;
  if (expandProgress >= MARK_FADE_END_PROGRESS) return 0;
  return 1 - expandProgress / MARK_FADE_END_PROGRESS;
}

export function buildAnkielMarkPath(width: number, height: number, scale: number): string {
  "worklet";
  const iconSize = SPLASH_ICON_SIZE;
  const cx = width / 2;
  const cy = height / 2;
  const pivotY = cy + ANKIEL_MARK_PIVOT_NY * iconSize;
  const unit = iconSize * scale;

  const x0 = cx + -0.064 * unit;
  const y0 = pivotY + (-0.5 - ANKIEL_MARK_PIVOT_NY) * unit;
  const x1 = cx + 0.064 * unit;
  const y1 = y0;
  const x2 = cx + 0.475 * unit;
  const y2 = pivotY + (0.5 - ANKIEL_MARK_PIVOT_NY) * unit;
  const x3 = cx + 0.31065 * unit;
  const y3 = y2;
  const x4 = cx;
  const y4 = pivotY + (-0.2559 - ANKIEL_MARK_PIVOT_NY) * unit;
  const x5 = cx + -0.31065 * unit;
  const y5 = y2;
  const x6 = cx + -0.475 * unit;
  const y6 = y2;

  return `M${x0} ${y0}L${x1} ${y1}L${x2} ${y2}L${x3} ${y3}L${x4} ${y4}L${x5} ${y5}L${x6} ${y6}Z`;
}

export function buildSplashCutoutPath(width: number, height: number, scale: number): string {
  "worklet";
  return `M0 0H${width}V${height}H0Z ${buildAnkielMarkPath(width, height, scale)}`;
}
