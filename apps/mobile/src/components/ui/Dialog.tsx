import * as Haptics from "expo-haptics";
import { msg } from "gt-react-native";
import { ActionSheetIOS, Alert, Platform } from "react-native";

import { m } from "../../i18n/messages";
import { currentNativeLayoutMetrics } from "../../native/native-layout-metrics-snapshot";
import type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export function alert(...args: Parameters<typeof Alert.alert>): void {
  Alert.alert(...args);
}

export function confirm(request: ConfirmDialogRequest): void {
  const cancelText = request.cancelText ?? m(msg("Cancel"));
  if (request.presentation === "sheet" && canShowUnanchoredActionSheet()) {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: request.title,
        message: request.message,
        options: [request.confirmText, cancelText],
        destructiveButtonIndex: request.destructive ? 0 : undefined,
        cancelButtonIndex: 1,
      },
      (index) => (index === 0 ? confirmed(request) : request.onCancel?.()),
    );
    return;
  }
  Alert.alert(request.title, request.message, [
    { text: cancelText, style: "cancel", onPress: request.onCancel },
    {
      text: request.confirmText,
      style: request.destructive ? "destructive" : "default",
      onPress: () => confirmed(request),
    },
  ]);
}

// Without an anchor, React Native floats the sheet mid-screen on iPad and gives it no
// popover source on a regular-width phone window (an unfolded Duo).
function canShowUnanchoredActionSheet() {
  if (Platform.OS !== "ios" || Platform.isPad) return false;
  return currentNativeLayoutMetrics()?.horizontalSizeClass !== "regular";
}

function confirmed(request: ConfirmDialogRequest) {
  if (request.destructive) {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
  }
  request.onConfirm();
}

export function prompt(request: TextInputDialogRequest): void {
  Alert.prompt(
    request.title,
    request.message,
    [
      { text: request.cancelText ?? m(msg("Cancel")), style: "cancel", onPress: request.onCancel },
      { text: request.confirmText, onPress: (value) => request.onConfirm(value ?? "") },
    ],
    "plain-text",
    request.initialValue,
  );
}

export function Host() {
  return null;
}
