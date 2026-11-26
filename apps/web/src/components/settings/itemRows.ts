export const ITEM_ROW_CLASSNAME = "first:rounded-t-xl last:rounded-b-xl px-3 py-3 sm:px-4";

export const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

/** The one look for a card a settings form picks between; layout stays with the caller. */
export function selectionCardClassName(selected: boolean) {
  return selected
    ? "rounded-lg border border-foreground/60 bg-accent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    : "rounded-lg border border-border/60 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
}
