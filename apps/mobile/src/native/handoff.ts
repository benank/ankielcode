import {
  PAIRING_HANDOFF_ACTIVITY_TYPE,
  toPairingInviteUserInfo,
  type PairingInvitePayload,
} from "@ankielcode/shared/remote";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface AnkielHandoffNativeModule {
  startPairingActivity(
    activityType: string,
    title: string,
    userInfo: Record<string, string>,
    expiresAtEpochMs?: number | null,
  ): void;
  stopPairingActivity(): void;
}

/** iOS only; null on Android and in dev clients built before the module shipped. */
const nativeHandoff = requireOptionalNativeModule<AnkielHandoffNativeModule>("AnkielHandoff");

export function isHandoffSupported(): boolean {
  return Platform.OS === "ios" && nativeHandoff !== null;
}

export function startPairingHandoffActivity(input: {
  readonly title: string;
  readonly invite: PairingInvitePayload;
}): boolean {
  if (Platform.OS !== "ios" || nativeHandoff === null) {
    return false;
  }
  const userInfo = toPairingInviteUserInfo(input.invite);
  const parsedExpiresAt = input.invite.expiresAt ? Date.parse(input.invite.expiresAt) : Number.NaN;
  const expiresAtEpochMs = Number.isFinite(parsedExpiresAt) ? parsedExpiresAt : null;
  nativeHandoff.startPairingActivity(
    PAIRING_HANDOFF_ACTIVITY_TYPE,
    input.title,
    userInfo,
    expiresAtEpochMs,
  );
  return true;
}

export function stopPairingHandoffActivity(): void {
  if (Platform.OS !== "ios" || nativeHandoff === null) {
    return;
  }
  nativeHandoff.stopPairingActivity();
}
