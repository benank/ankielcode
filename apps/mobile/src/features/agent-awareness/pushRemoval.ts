import { runAtomCommand } from "@ankielcode/client-runtime/state/runtime";
import type { EnvironmentId } from "@ankielcode/contracts";
import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { pushEnvironment } from "../../state/push";

const UNREGISTER_TIMEOUT_MS = 3_000;

/**
 * Drops this phone's registration before an environment is forgotten. An offline one keeps it
 * until this device's session is revoked on that computer, which deletes the registration.
 */
export async function unregisterPushBeforeRemoval(environmentId: EnvironmentId): Promise<void> {
  if (Platform.OS !== "ios") return;
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  if (!AsyncResult.isSuccess(preferences) || preferences.value.pushNotificationsEnabled !== true) {
    return;
  }
  if (!appAtomRegistry.get(connectedEnvironmentIdsAtom).includes(environmentId)) return;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), UNREGISTER_TIMEOUT_MS);
  await runAtomCommand(
    appAtomRegistry,
    pushEnvironment.unregister,
    { environmentId, input: {} },
    { reportFailure: false, signal: abort.signal },
  );
  clearTimeout(timer);
}
