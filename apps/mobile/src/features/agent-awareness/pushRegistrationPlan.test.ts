import { EnvironmentId } from "@ankielcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PushSyncState, pushPreferenceKey, pushTarget } from "./pushRegistrationPlan";

const a = EnvironmentId.make("env-a");
const b = EnvironmentId.make("env-b");
const device = {
  token: "ab".repeat(32),
  appId: "com.example.app",
  apnsEnvironment: "sandbox",
} as const;

const target = (preferenceKey: string, locale = "en") =>
  pushTarget({ preferenceKey, device, locale });

describe("pushTarget", () => {
  it("asks nothing until push was turned on, and unregisters once it is turned off", () => {
    expect(pushTarget({ preferenceKey: pushPreferenceKey({}), device, locale: "en" })).toBeNull();
    expect(
      pushTarget({
        preferenceKey: pushPreferenceKey({ pushNotificationsEnabled: false }),
        device: null,
        locale: "en",
      }),
    ).toEqual({ key: "off", input: null });
    expect(
      pushTarget({
        preferenceKey: pushPreferenceKey({ pushNotificationsEnabled: true }),
        device: null,
        locale: "en",
      }),
    ).toBeNull();
  });

  it("registers the chosen kinds in a stable order", () => {
    const registered = target(
      pushPreferenceKey({
        pushNotificationsEnabled: true,
        pushNotificationKinds: ["input", "completed"],
      }),
      "pt-BR",
    );
    expect(registered?.input).toEqual({
      platform: "ios",
      token: device.token,
      appId: device.appId,
      apnsEnvironment: "sandbox",
      kinds: ["completed", "input"],
      locale: "pt-BR",
    });
  });
});

describe("PushSyncState", () => {
  it("syncs each environment once per connection and target", () => {
    const state = new PushSyncState();
    const on = target(pushPreferenceKey({ pushNotificationsEnabled: true }))!;

    expect(state.take(new Set([a, b]), on)).toEqual([a, b]);
    // In flight: a repeat trigger sends nothing more.
    expect(state.take(new Set([a, b]), on)).toEqual([]);
    state.settle(a, on.key);
    state.settle(b, on.key);
    expect(state.take(new Set([a, b]), on)).toEqual([]);

    // A new locale is a new target.
    const relocalized = target(pushPreferenceKey({ pushNotificationsEnabled: true }), "de")!;
    expect(state.take(new Set([a, b]), relocalized)).toEqual([a, b]);
    state.settle(a, relocalized.key);
    state.settle(b, relocalized.key);

    // A reconnect registers again.
    expect(state.take(new Set([b]), relocalized)).toEqual([]);
    expect(state.take(new Set([a, b]), relocalized)).toEqual([a]);
  });

  it("does not count an answer from a connection that dropped while it was in flight", () => {
    const state = new PushSyncState();
    const on = target(pushPreferenceKey({ pushNotificationsEnabled: true }))!;

    expect(state.take(new Set([a]), on)).toEqual([a]);
    state.take(new Set(), on);
    state.settle(a, on.key);
    expect(state.take(new Set([a]), on)).toEqual([a]);
  });
});
