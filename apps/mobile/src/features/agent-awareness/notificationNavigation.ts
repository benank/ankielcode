import * as Notifications from "expo-notifications";

import { setAndroidThreadOnScreen } from "./androidNotifications";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import {
  installAgentNotificationCategories,
  performAgentNotificationAction,
} from "./notificationActionRunner";
import { routeAgentNotificationResponseOnce, threadDeepLinkOnScreen } from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

/** Called with the workspace pathname on every root navigation state change. */
export function setAgentNotificationPathname(pathname: string): void {
  setAndroidThreadOnScreen(threadDeepLinkOnScreen(pathname));
}

/**
 * App-lifetime notification routing: agent alerts stay quiet in the foreground, and taps
 * (including the cold-start tap) open the notification's deep link through `navigate`. A button
 * (Approve, Deny, Reply) opens the same thread and then sends its answer there.
 */
export function installAgentNotificationNavigation(navigate: (href: string) => void): () => void {
  const handledResponseIds = new Set<string>();
  Notifications.setNotificationHandler({
    handleNotification: (notification) =>
      Promise.resolve(foregroundNotificationBehavior(notification)),
  });

  const disposeCategories = installAgentNotificationCategories();
  const handleResponse = (response: Notifications.NotificationResponse): void => {
    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate,
      perform: (action) => void performAgentNotificationAction(action),
    });
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  void consumeLastAgentNotificationResponse({
    getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
    clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
    handleResponse,
  });

  return () => {
    disposeCategories();
    subscription.remove();
    Notifications.setNotificationHandler(null);
  };
}
