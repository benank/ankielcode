import {
  type DesktopNotificationEvent,
  type DesktopNotificationInput,
  DesktopNotificationInputSchema,
} from "@ankielcode/contracts";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  CLOSE_NOTIFICATION_CHANNEL,
  NOTIFICATION_EVENT_CHANNEL,
  SHOW_NOTIFICATION_CHANNEL,
} from "../channels.ts";

/** Electron options for a notification; Linux notifications carry no buttons. */
export function notificationOptions(
  platform: NodeJS.Platform,
  input: DesktopNotificationInput,
): Electron.NotificationConstructorOptions {
  const buttons = platform === "linux" ? null : input.buttons;
  return {
    id: input.id,
    groupId: input.groupId,
    title: input.title,
    body: input.body,
    silent: !input.sound,
    // Windows drops clicks after a toast moves into the Action Center.
    ...(platform === "win32" ? { timeoutType: "never" as const } : {}),
    ...(buttons?.type === "approval"
      ? {
          actions: [
            { type: "button" as const, text: buttons.approve },
            { type: "button" as const, text: buttons.deny },
          ],
        }
      : buttons?.type === "reply"
        ? { hasReply: true, replyPlaceholder: buttons.placeholder }
        : {}),
  };
}

export const installDesktopNotifications = Effect.fn("desktop.ipc.installDesktopNotifications")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const app = yield* ElectronApp.ElectronApp;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const platform = yield* HostProcess.Platform;
    const runFork = Effect.runForkWith(yield* Effect.context<ElectronWindow.ElectronWindow>());
    // Held until handled: macOS removes a collected notification from Notification Center.
    const shown = new Map<string, Electron.Notification>();

    const withMain = (use: (window: Electron.BrowserWindow) => Effect.Effect<void>) =>
      runFork(
        electronWindow.main.pipe(
          Effect.flatMap((window) =>
            Option.isSome(window) && !window.value.isDestroyed() ? use(window.value) : Effect.void,
          ),
        ),
      );
    const emit = (event: DesktopNotificationEvent) =>
      withMain((window) =>
        Effect.sync(() => window.webContents.send(NOTIFICATION_EVENT_CHANNEL, event)),
      );
    const forget = (id: string, notification: Electron.Notification) => {
      if (shown.get(id) === notification) shown.delete(id);
    };
    const close = (id: string) => {
      const notification = shown.get(id);
      shown.delete(id);
      notification?.close();
      if (platform === "darwin") Electron.Notification.remove(id);
    };
    const requestAttention = () => {
      if (Electron.BrowserWindow.getFocusedWindow()) return;
      if (platform === "darwin") Electron.app.dock?.bounce("informational");
      else if (platform === "win32") {
        withMain((window) => Effect.sync(() => window.flashFrame(true)));
      }
    };

    const show = (input: DesktopNotificationInput) => {
      close(input.id);
      const { id } = input;
      const notification = new Electron.Notification(notificationOptions(platform, input));
      shown.set(id, notification);
      notification.on("click", () => {
        forget(id, notification);
        withMain((window) => electronWindow.reveal(window));
        emit({ id, type: "click", text: "" });
      });
      notification.on("action", (details) => {
        forget(id, notification);
        emit({ id, type: details.actionIndex === 0 ? "approve" : "deny", text: "" });
      });
      notification.on("reply", (details) => {
        forget(id, notification);
        emit({ id, type: "reply", text: details.reply });
      });
      notification.on("close", () => forget(id, notification));
      notification.on("failed", (_event, error) => {
        forget(id, notification);
        runFork(Effect.logWarning("Could not show notification", { error }));
        emit({ id, type: "failed", text: "" });
      });
      notification.show();
      if (input.attention) requestAttention();
    };

    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SHOW_NOTIFICATION_CHANNEL,
        payload: DesktopNotificationInputSchema,
        result: Schema.Void,
        handler: (input) => Effect.sync(() => show(input)),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: CLOSE_NOTIFICATION_CHANNEL,
        payload: Schema.String.check(Schema.isMaxLength(64)),
        result: Schema.Void,
        handler: (id) => Effect.sync(() => close(id)),
      }),
    );
    if (platform === "win32") {
      yield* app.on("browser-window-focus", (_event: unknown, window: Electron.BrowserWindow) => {
        if (!window.isDestroyed()) window.flashFrame(false);
      });
    }
    // Nothing answers a notification after quit, so none outlives the app.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const id of shown.keys()) close(id);
      }),
    );
  },
);
