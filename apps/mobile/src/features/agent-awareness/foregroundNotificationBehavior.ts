import type { Notification, NotificationBehavior } from "expo-notifications";

import { extractAgentNotificationDeepLink } from "./notificationPayload";

const SHOW: NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

const SUPPRESS: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/** The open app already shows what an agent alert says, so agent alerts stay quiet in it. */
export function foregroundNotificationBehavior(notification: Notification): NotificationBehavior {
  return extractAgentNotificationDeepLink({ notification }) === null ? SHOW : SUPPRESS;
}
