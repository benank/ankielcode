import * as Notifications from "expo-notifications";

import { setAndroidThreadOnScreen } from "./androidNotifications";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { routeAgentNotificationResponseOnce, threadDeepLinkOnScreen } from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

/** Called with the workspace pathname on every root navigation state change. */
export function setAgentNotificationPathname(pathname: string): void {
  setAndroidThreadOnScreen(threadDeepLinkOnScreen(pathname));
}

/**
 * App-lifetime notification routing: agent alerts stay quiet in the foreground, and taps
 * (including the cold-start tap) open the notification's deep link through `navigate`.
 */
export function installAgentNotificationNavigation(navigate: (href: string) => void): () => void {
  const handledResponseIds = new Set<string>();
  Notifications.setNotificationHandler({
    handleNotification: (notification) =>
      Promise.resolve(foregroundNotificationBehavior(notification)),
  });

  const handleResponse = (response: Notifications.NotificationResponse): void => {
    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate });
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  void consumeLastAgentNotificationResponse({
    getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
    clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
    handleResponse,
  });

  return () => {
    subscription.remove();
    Notifications.setNotificationHandler(null);
  };
}
