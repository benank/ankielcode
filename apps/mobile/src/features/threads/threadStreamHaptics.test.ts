import type { EnvironmentThread } from "@ankielcode/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@ankielcode/contracts";
import type * as MobilePreferences from "../../persistence/mobile-preferences";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const fixtures = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    selectionAsync: vi.fn(async () => {}),
    preferences: Atom.make<AsyncResult.AsyncResult<MobilePreferences.Preferences>>(
      AsyncResult.success({}),
    ),
    thread: Atom.make<EnvironmentThread | null>(null),
  };
});

vi.mock("expo-haptics", () => ({ selectionAsync: fixtures.selectionAsync }));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: fixtures.preferences }));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => fixtures.thread },
}));

import {
  shouldTickStreamHaptic,
  streamHapticsEnabled,
  threadStreamHaptics,
} from "./threadStreamHaptics";

const mark = (id: string, textLength: number) => ({ id, textLength });

describe("shouldTickStreamHaptic", () => {
  it("ticks for a new stream even inside the throttle window", () => {
    expect(
      shouldTickStreamHaptic({
        previous: mark("a", 40),
        latest: mark("b", 1),
        lastTickAt: 0,
        now: 10,
      }),
    ).toBe(true);
    expect(
      shouldTickStreamHaptic({ previous: null, latest: mark("a", 1), lastTickAt: 0, now: 10 }),
    ).toBe(true);
  });

  it("throttles growth of the same stream", () => {
    const growth = { previous: mark("a", 10), latest: mark("a", 20), lastTickAt: 1_000 };
    expect(shouldTickStreamHaptic({ ...growth, now: 1_200 })).toBe(false);
    expect(shouldTickStreamHaptic({ ...growth, now: 1_320 })).toBe(true);
  });

  it("stays quiet when nothing streams or the text did not grow", () => {
    expect(
      shouldTickStreamHaptic({ previous: mark("a", 10), latest: null, lastTickAt: 0, now: 5_000 }),
    ).toBe(false);
    expect(
      shouldTickStreamHaptic({
        previous: mark("a", 10),
        latest: mark("a", 10),
        lastTickAt: 0,
        now: 5_000,
      }),
    ).toBe(false);
  });
});

describe("stream haptics setting", () => {
  it("is on unless the user turned it off", () => {
    expect(streamHapticsEnabled({})).toBe(true);
    expect(streamHapticsEnabled({ streamHapticsEnabled: true })).toBe(true);
    expect(streamHapticsEnabled({ streamHapticsEnabled: false })).toBe(false);
  });

  const streamingThread = (id: string, text = "Hi") =>
    ({
      projection: { messages: [{ id, role: "assistant", streaming: true, text }] },
    }) as unknown as EnvironmentThread;

  const ticksWith = (preferences: AsyncResult.AsyncResult<MobilePreferences.Preferences>) => {
    fixtures.selectionAsync.mockClear();
    const registry = AtomRegistry.make();
    registry.set(fixtures.preferences, preferences);
    registry.mount(
      threadStreamHaptics({
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
      }),
    );
    registry.set(fixtures.thread, streamingThread("first"));
    return { registry, ticks: () => fixtures.selectionAsync.mock.calls.length };
  };

  it("ticks when a reply starts streaming with the setting unset", () => {
    expect(ticksWith(AsyncResult.success({})).ticks()).toBe(1);
  });

  it("stays silent when turned off or before preferences load", () => {
    expect(ticksWith(AsyncResult.success({ streamHapticsEnabled: false })).ticks()).toBe(0);
    expect(ticksWith(AsyncResult.initial(true)).ticks()).toBe(0);
  });

  it("stops ticking as soon as the setting turns off", () => {
    const { registry, ticks } = ticksWith(AsyncResult.success({}));
    registry.set(fixtures.preferences, AsyncResult.success({ streamHapticsEnabled: false }));
    registry.set(fixtures.thread, streamingThread("second"));
    expect(ticks()).toBe(1);
  });

  it("keeps its throttle when unrelated preferences change", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const { registry, ticks } = ticksWith(AsyncResult.success({}));
    registry.set(fixtures.preferences, AsyncResult.success({ codeWordBreak: true }));
    // A rebuilt tracker would forget the last tick and buzz on this growth.
    registry.set(fixtures.thread, streamingThread("first", "Hi there"));
    expect(ticks()).toBe(1);
  });
});
