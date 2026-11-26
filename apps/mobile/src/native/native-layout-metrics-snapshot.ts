import type { NativeLayoutMetrics } from "../lib/reserved-regions";

// The latest metrics outside React, for decisions made before the first screen renders.
// Kept free of react-native imports so module-level callers such as Dialog stay cheap to load.
let latestMetrics: NativeLayoutMetrics | null = null;
const metricsWaiters = new Set<(metrics: NativeLayoutMetrics) => void>();

export function publishNativeLayoutMetrics(next: NativeLayoutMetrics) {
  latestMetrics = next;
  for (const settle of metricsWaiters) settle(next);
}

/** Resolves with the first native layout metrics, or null after `timeoutMs` without any. */
export function firstNativeLayoutMetrics(timeoutMs: number) {
  if (latestMetrics) return Promise.resolve(latestMetrics);
  return new Promise<NativeLayoutMetrics | null>((resolve) => {
    const settle = (metrics: NativeLayoutMetrics | null) => {
      metricsWaiters.delete(settle);
      clearTimeout(timeout);
      resolve(metrics);
    };
    const timeout = setTimeout(() => settle(null), timeoutMs);
    metricsWaiters.add(settle);
  });
}

export function currentNativeLayoutMetrics() {
  return latestMetrics;
}
