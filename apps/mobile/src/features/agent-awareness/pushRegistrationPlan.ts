import type { EnvironmentId, PushAlertKind, PushRegisterInput } from "@ankielcode/contracts";

import type { Preferences } from "../../persistence/mobile-preferences";

export const PUSH_ALERT_KINDS: readonly PushAlertKind[] = [
  "completed",
  "failed",
  "approval",
  "input",
];

/** The server caps the locale at 35 characters. */
const MAX_LOCALE_LENGTH = 35;

export function pushAlertKinds(preferences: Preferences): readonly PushAlertKind[] {
  const chosen = preferences.pushNotificationKinds;
  return chosen === undefined
    ? PUSH_ALERT_KINDS
    : PUSH_ALERT_KINDS.filter((kind) => chosen.includes(kind));
}

/**
 * What the push preference asks of every connected environment, as one string so a preference
 * write that leaves push alone changes nothing. "unset" was never turned on, so it asks nothing.
 */
export function pushPreferenceKey(preferences: Preferences): string {
  if (preferences.pushNotificationsEnabled === undefined) return "unset";
  if (!preferences.pushNotificationsEnabled) return "off";
  return `on:${pushAlertKinds(preferences).join(",")}`;
}

export interface PushDevice {
  readonly token: string;
  readonly appId: string;
  readonly apnsEnvironment: "sandbox" | "production";
}

/** `input` null unregisters. */
export interface PushTarget {
  readonly key: string;
  readonly input: PushRegisterInput | null;
}

export function pushTarget(input: {
  readonly preferenceKey: string;
  readonly device: PushDevice | null;
  readonly locale: string;
}): PushTarget | null {
  const { preferenceKey, device } = input;
  if (preferenceKey === "unset") return null;
  if (preferenceKey === "off") return { key: "off", input: null };
  // Turned on, but the token is still being read.
  if (device === null) return null;
  const kinds = preferenceKey.slice("on:".length).split(",").filter(isPushAlertKind);
  const locale = input.locale.slice(0, MAX_LOCALE_LENGTH);
  return {
    key: [device.token, device.apnsEnvironment, kinds.join(","), locale].join("|"),
    input: {
      platform: "ios",
      token: device.token,
      appId: device.appId,
      apnsEnvironment: device.apnsEnvironment,
      kinds,
      locale,
    },
  };
}

function isPushAlertKind(value: string): value is PushAlertKind {
  return (PUSH_ALERT_KINDS as readonly string[]).includes(value);
}

/**
 * Per-environment bookkeeping for one connection each: an environment is synced once per
 * connection and target, and forgotten when it disconnects so a reconnect registers again.
 * A failed attempt counts as applied, so an older server without the RPC is not retried on every
 * unrelated change; the next connection or target tries again.
 */
export class PushSyncState {
  private readonly applied = new Map<EnvironmentId, string>();
  private readonly inFlight = new Set<EnvironmentId>();
  /** In flight when their connection dropped, so the answer belongs to the old connection. */
  private readonly stale = new Set<EnvironmentId>();

  /** The environments to send `target` to now. Marks them in flight. */
  take(connected: ReadonlySet<EnvironmentId>, target: PushTarget | null): EnvironmentId[] {
    for (const environmentId of this.applied.keys()) {
      if (!connected.has(environmentId)) this.applied.delete(environmentId);
    }
    for (const environmentId of this.inFlight) {
      if (!connected.has(environmentId)) this.stale.add(environmentId);
    }
    if (target === null) return [];
    const due = [...connected].filter(
      (environmentId) =>
        !this.inFlight.has(environmentId) && this.applied.get(environmentId) !== target.key,
    );
    for (const environmentId of due) this.inFlight.add(environmentId);
    return due;
  }

  settle(environmentId: EnvironmentId, key: string): void {
    this.inFlight.delete(environmentId);
    if (!this.stale.delete(environmentId)) this.applied.set(environmentId, key);
  }

  /** The target last applied on this connection, if any. */
  appliedKey(environmentId: EnvironmentId): string | undefined {
    return this.applied.get(environmentId);
  }
}
