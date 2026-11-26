/** Leading actions sit under the row's left edge; trailing ones under its right edge. */
export type SwipeSide = "leading" | "trailing";

/** How far a row must travel before letting go commits a side's full-swipe action. */
export function swipeFullThreshold(actionsWidth: number, rowWidth: number) {
  return Math.max(actionsWidth + 44, rowWidth * 0.58);
}

/** How far the row has moved to show `side`'s actions; 0 while it shows the other side. */
export function swipeReveal(translation: number, side: SwipeSide) {
  "worklet";
  return Math.max(side === "leading" ? translation : -translation, 0);
}

/** The side whose full swipe a release commits; a null threshold means that side has none. */
export function fullSwipeSide(
  translation: number,
  thresholds: { readonly leading: number | null; readonly trailing: number },
): SwipeSide | null {
  "worklet";
  if (thresholds.leading !== null && swipeReveal(translation, "leading") >= thresholds.leading) {
    return "leading";
  }
  return swipeReveal(translation, "trailing") >= thresholds.trailing ? "trailing" : null;
}
