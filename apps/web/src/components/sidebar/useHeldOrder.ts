import { useEffect, useLayoutEffect, useState } from "react";

// Activity moves threads often; holding the order this long keeps rows from jumping under the pointer.
const SIDEBAR_RESORT_DELAY_MS = 3000;
const REORDER_ANIMATION_MS = 280;

/**
 * The held order with today's membership: held keys keep their relative order,
 * and keys the held order has not seen yet take their place in `desired`.
 */
function mergeHeldOrder(held: readonly string[], desired: readonly string[]): string[] {
  const wanted = new Set(desired);
  const kept = held.filter((key) => wanted.has(key));
  const keptSet = new Set(kept);
  const merged: string[] = [];
  let next = 0;
  for (const key of desired) {
    if (keptSet.has(key)) merged.push(kept[next++]!);
    else merged.push(key);
  }
  return merged;
}

function sameOrder(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function captureRowTops(): Map<string, number> {
  const tops = new Map<string, number>();
  for (const row of document.querySelectorAll<HTMLElement>("[data-thread-item]")) {
    tops.set(row.dataset.threadItem!, row.getBoundingClientRect().top);
  }
  return tops;
}

function playRowReorder(before: ReadonlyMap<string, number>) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const row of document.querySelectorAll<HTMLElement>("[data-thread-item]")) {
    const was = before.get(row.dataset.threadItem!);
    if (was === undefined) continue;
    const offset = was - row.getBoundingClientRect().top;
    if (Math.abs(offset) < 1) continue;
    row.animate([{ transform: `translateY(${offset}px)` }, { transform: "none" }], {
      duration: REORDER_ANIMATION_MS,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
  }
}

/**
 * Follows `items` at once when threads come or go, but holds a reorder for a few
 * seconds, then slides every moved row to its new place at once.
 */
export function useHeldOrder<T>(items: readonly T[], keyOf: (item: T) => string): readonly T[] {
  const desired = items.map(keyOf);
  const [held, setHeld] = useState<readonly string[]>(desired);
  const [resort, setResort] = useState<ReadonlyMap<string, number> | null>(null);
  const [playedResort, setPlayedResort] = useState(resort);
  if (playedResort !== resort) {
    setPlayedResort(resort);
    setHeld(desired);
  }
  const order = playedResort !== resort ? desired : mergeHeldOrder(held, desired);
  const settled = sameOrder(order, desired);
  if (settled && !sameOrder(held, desired)) setHeld(desired);

  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- A timer is the clock the resort waits on.
  useEffect(() => {
    if (settled) return;
    const timer = window.setTimeout(() => setResort(captureRowTops()), SIDEBAR_RESORT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [settled]);

  // oxlint-disable-next-line ankielcode/no-unreasoned-state-sync -- Measures committed rows to animate them from where they were.
  useLayoutEffect(() => {
    if (resort !== null) playRowReorder(resort);
  }, [resort]);

  if (settled) return items;
  const byKey = new Map(items.map((item) => [keyOf(item), item] as const));
  return order.map((key) => byKey.get(key)!);
}
