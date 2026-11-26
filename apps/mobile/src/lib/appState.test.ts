import { describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  enabled: false,
  listeners: new Set<(enabled: boolean) => void>(),
  appStateListeners: new Set<() => void>(),
}));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: () => void) => {
      native.appStateListeners.add(listener);
      return { remove: () => native.appStateListeners.delete(listener) };
    },
  },
  AccessibilityInfo: {
    addEventListener: (_event: string, listener: (enabled: boolean) => void) => {
      native.listeners.add(listener);
      return { remove: () => native.listeners.delete(listener) };
    },
    isReduceMotionEnabled: () => Promise.resolve(native.enabled),
  },
}));

import { readReduceMotionEnabled, subscribeAppState, subscribeReduceMotion } from "./appState";

describe("app state store", () => {
  it("fans one native listener out to every subscriber", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeAppState(first);
    const unsubscribeSecond = subscribeAppState(second);
    expect(native.appStateListeners.size).toBe(1);

    for (const emit of native.appStateListeners) emit();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    unsubscribeFirst();
    expect(native.appStateListeners.size).toBe(1);
    unsubscribeSecond();
    expect(native.appStateListeners.size).toBe(0);

    const unsubscribeAgain = subscribeAppState(first);
    expect(native.appStateListeners.size).toBe(1);
    unsubscribeAgain();
  });
});

describe("reduce motion store", () => {
  it("reseeds from native after observation stops and restarts", async () => {
    native.enabled = false;
    const unsubscribe = subscribeReduceMotion(() => undefined);
    await Promise.resolve();
    expect(readReduceMotionEnabled()).toBe(false);
    unsubscribe();

    // Changed while nobody listened: no event reaches the store.
    native.enabled = true;
    const unsubscribeAgain = subscribeReduceMotion(() => undefined);
    // Unknown until the reseed lands, which reads as reduced, not the stale false.
    expect(readReduceMotionEnabled()).toBe(true);
    await Promise.resolve();
    expect(readReduceMotionEnabled()).toBe(true);
    unsubscribeAgain();
  });

  it("ignores a seed that resolves after the last unsubscribe", async () => {
    native.enabled = false;
    subscribeReduceMotion(() => undefined)();
    await Promise.resolve();
    expect(readReduceMotionEnabled()).toBe(true);
  });
});
