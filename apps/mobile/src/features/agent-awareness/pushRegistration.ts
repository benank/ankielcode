import { runAtomCommand } from "@ankielcode/client-runtime/state/runtime";
import type { EnvironmentId, PushRegisterInput } from "@ankielcode/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Application from "expo-application";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { getActiveLocale, subscribeActiveLocale } from "../../i18n/messages";
import { createDebugLogger } from "../../lib/debugLog";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { pushEnvironment } from "../../state/push";
import {
  type PushDevice,
  PushSyncState,
  pushPreferenceKey,
  pushTarget,
} from "./pushRegistrationPlan";

const pushDebug = createDebugLogger("push-registration");
const TOKEN_TIMEOUT_MS = 20_000;

/** Only iOS registers: Android has no push transport yet. */
export const pushSupportedOnPlatform = Platform.OS === "ios";

export type PushDeviceStatus = "unknown" | "reading" | "ready" | "unavailable";

/** "unavailable" means this build can't get an APNs token, such as a personal-team build. */
export const pushDeviceStatusAtom = Atom.make<PushDeviceStatus>("unknown").pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:push-device-status"),
);

const pushPreferenceKeyAtom = Atom.make((get) => {
  const preferences = get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) ? pushPreferenceKey(preferences.value) : null;
}).pipe(Atom.withLabel("mobile:push-preference-key"));

let device: PushDevice | null = null;
let pendingDevice: Promise<PushDevice | null> | null = null;
const deviceListeners = new Set<() => void>();

function withTimeout<A>(promise: Promise<A>): Promise<A> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out")), TOKEN_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function apnsEnvironment(): Promise<PushDevice["apnsEnvironment"]> {
  const environment = await Application.getIosPushNotificationServiceEnvironmentAsync().catch(
    () => null,
  );
  if (environment === "development") return "sandbox";
  // Null on the simulator, which only a development build runs on.
  return environment === null && __DEV__ ? "sandbox" : "production";
}

function setDevice(next: PushDevice): void {
  device = next;
  appAtomRegistry.set(pushDeviceStatusAtom, "ready");
  for (const listener of deviceListeners) listener();
}

/** Reads the APNs token once per launch; a failure is retried on the next call. */
export function loadPushDevice(): Promise<PushDevice | null> {
  if (!pushSupportedOnPlatform) return Promise.resolve(null);
  if (device !== null) return Promise.resolve(device);
  pendingDevice ??= (async () => {
    appAtomRegistry.set(pushDeviceStatusAtom, "reading");
    try {
      const appId = Application.applicationId;
      if (!appId) throw new Error("No bundle id");
      const [token, environment] = await Promise.all([
        withTimeout(Notifications.getDevicePushTokenAsync()),
        apnsEnvironment(),
      ]);
      if (typeof token.data !== "string" || token.data.length === 0) throw new Error("No token");
      setDevice({ token: token.data, appId, apnsEnvironment: environment });
      return device;
    } catch (error) {
      pushDebug.log("push token unavailable", { error: String(error) });
      appAtomRegistry.set(pushDeviceStatusAtom, "unavailable");
      return null;
    } finally {
      pendingDevice = null;
    }
  })();
  return pendingDevice;
}

export type PushPermission = "granted" | "denied" | "undetermined";

export async function readPushPermission(): Promise<PushPermission> {
  const permission = await Notifications.getPermissionsAsync();
  if (permission.granted) return "granted";
  return permission.canAskAgain ? "undetermined" : "denied";
}

/** Asks for permission and the token when the user turns push on. */
export async function preparePushNotifications(): Promise<PushPermission | "unavailable"> {
  let permission = await readPushPermission();
  if (permission === "undetermined") {
    const requested = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: false, allowSound: true },
    });
    permission = requested.granted ? "granted" : "denied";
  }
  if (permission !== "granted") return permission;
  return (await loadPushDevice()) === null ? "unavailable" : "granted";
}

/**
 * Keeps every connected environment's registration in line with the preference: on launch, on
 * each connect, on token and locale changes, and when the alert kinds change.
 */
export function installPushRegistration(): () => void {
  if (!pushSupportedOnPlatform) return () => undefined;
  const state = new PushSyncState();
  let disposed = false;

  const sync = () => {
    if (disposed) return;
    const preferenceKey = appAtomRegistry.get(pushPreferenceKeyAtom);
    if (preferenceKey === null) return;
    if (preferenceKey.startsWith("on:") && device === null) void loadPushDevice();
    const target = pushTarget({ preferenceKey, device, locale: getActiveLocale() });
    const connected = new Set(appAtomRegistry.get(connectedEnvironmentIdsAtom));
    const due = state.take(connected, target);
    if (target === null) return;
    for (const environmentId of due) void send(environmentId, target.key, target.input);
  };

  const send = async (
    environmentId: EnvironmentId,
    key: string,
    input: PushRegisterInput | null,
  ) => {
    const result =
      input === null
        ? await runAtomCommand(
            appAtomRegistry,
            pushEnvironment.unregister,
            { environmentId, input: {} },
            { reportFailure: false },
          )
        : await runAtomCommand(
            appAtomRegistry,
            pushEnvironment.register,
            { environmentId, input },
            { reportFailure: false },
          );
    if (result._tag === "Failure") {
      pushDebug.log("push sync failed", { environmentId, unregister: input === null });
    }
    state.settle(environmentId, key);
    sync();
  };

  deviceListeners.add(sync);
  const unsubscribers = [
    appAtomRegistry.subscribe(pushPreferenceKeyAtom, sync, { immediate: true }),
    appAtomRegistry.subscribe(connectedEnvironmentIdsAtom, sync),
    subscribeActiveLocale(sync),
  ];
  const tokenSubscription = Notifications.addPushTokenListener((token) => {
    if (device === null || typeof token.data !== "string" || token.data === device.token) return;
    setDevice({ ...device, token: token.data });
  });
  return () => {
    disposed = true;
    deviceListeners.delete(sync);
    for (const unsubscribe of unsubscribers) unsubscribe();
    tokenSubscription.remove();
  };
}
