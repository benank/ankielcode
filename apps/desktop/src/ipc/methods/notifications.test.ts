import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as HostProcess from "@ankielcode/shared/HostProcess";

const native = vi.hoisted(() => ({
  sent: [] as Array<{ options: Record<string, unknown>; emit: (...args: unknown[]) => void }>,
  close: vi.fn(),
  show: vi.fn(),
  remove: vi.fn(),
  bounce: vi.fn(),
  flashFrame: vi.fn(),
  send: vi.fn(),
  getFocusedWindow: vi.fn(() => null as object | null),
}));
vi.mock("electron", () => {
  class Notification {
    static remove = native.remove;
    private readonly listeners = new Map<string, (...args: unknown[]) => void>();
    constructor(options: Record<string, unknown>) {
      native.sent.push({
        options,
        emit: (event, ...args) => this.listeners.get(event as string)?.(...args),
      });
    }
    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, listener);
      return this;
    }
    show = native.show;
    close = native.close;
  }
  return {
    Notification,
    app: { dock: { bounce: native.bounce }, on: vi.fn(), removeListener: vi.fn() },
    BrowserWindow: { getFocusedWindow: native.getFocusedWindow },
  };
});

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { installDesktopNotifications, notificationOptions } from "./notifications.ts";

const approval = {
  id: "0123456789abcdef",
  groupId: "0123456789abcdef",
  title: "Approval needed",
  body: "Ship it",
  sound: true,
  attention: true,
  buttons: { type: "approval", approve: "Approve", deny: "Deny" },
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  native.sent = [];
  native.getFocusedWindow.mockReturnValue(null);
});

it("gives each platform the buttons it can show", () => {
  expect(notificationOptions("darwin", approval)).toMatchObject({
    id: approval.id,
    groupId: approval.groupId,
    silent: false,
    actions: [
      { type: "button", text: "Approve" },
      { type: "button", text: "Deny" },
    ],
  });
  const reply = { ...approval, sound: false, buttons: { type: "reply", placeholder: "Answer" } };
  expect(notificationOptions("win32", reply as never)).toMatchObject({
    silent: true,
    hasReply: true,
    replyPlaceholder: "Answer",
    timeoutType: "never",
  });
  const linux = notificationOptions("linux", approval);
  expect(linux.actions).toBeUndefined();
  expect(linux.hasReply).toBeUndefined();
});

it.effect("shows, answers, replaces and removes a thread's notification", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const mainWindow = { isDestroyed: () => false, webContents: { send: native.send } };
    const revealed: unknown[] = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* installDesktopNotifications();
        const event = { sender: { id: 1 } };
        const show = (input: unknown) =>
          Effect.promise(() =>
            Promise.resolve(handlers.get("desktop:show-notification")!(event, input)),
          );
        yield* Effect.promise(() =>
          expect(
            handlers.get("desktop:show-notification")!(event, { ...approval, id: "" }),
          ).rejects.toBeDefined(),
        );

        yield* show(approval);
        expect(native.show).toHaveBeenCalledTimes(1);
        expect(native.bounce).toHaveBeenCalledWith("informational");
        native.sent[0]!.emit("action", { actionIndex: 1 });
        yield* Effect.yieldNow;
        expect(native.send).toHaveBeenLastCalledWith("desktop:notification-event", {
          id: approval.id,
          type: "deny",
          text: "",
        });

        // Focused: a completion never asks for attention, and a newer one replaces the last.
        native.getFocusedWindow.mockReturnValue({});
        yield* show({ ...approval, attention: true, buttons: null });
        yield* show({ ...approval, attention: false, buttons: null });
        expect(native.bounce).toHaveBeenCalledTimes(1);
        expect(native.close).toHaveBeenCalledTimes(1);
        native.sent[2]!.emit("click");
        yield* Effect.yieldNow;
        expect(revealed).toEqual([mainWindow]);
        expect(native.send).toHaveBeenLastCalledWith("desktop:notification-event", {
          id: approval.id,
          type: "click",
          text: "",
        });

        yield* show(approval);
        native.sent[3]!.emit("failed", {}, "unsigned");
        yield* Effect.yieldNow;
        expect(native.send).toHaveBeenLastCalledWith("desktop:notification-event", {
          id: approval.id,
          type: "failed",
          text: "",
        });

        yield* show(approval);
        yield* Effect.promise(() =>
          Promise.resolve(handlers.get("desktop:close-notification")!(event, approval.id)),
        );
        expect(native.remove).toHaveBeenLastCalledWith(approval.id);
        native.close.mockClear();
        yield* show(approval);
      }),
    ).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provide([
        ElectronApp.layer,
        Layer.succeed(
          ElectronWindow.ElectronWindow,
          ElectronWindow.ElectronWindow.of({
            main: Effect.succeedSome(mainWindow),
            reveal: (window: unknown) => Effect.sync(() => void revealed.push(window)),
          } as unknown as ElectronWindow.ElectronWindow["Service"]),
        ),
        DesktopIpc.layerTest({
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
          removeHandler: (channel) => {
            handlers.delete(channel);
          },
          on: vi.fn(),
          removeAllListeners: vi.fn(),
        }),
      ]),
    );
    // Disposal removes what is still shown.
    expect(native.close).toHaveBeenCalledTimes(1);
    expect(handlers.size).toBe(0);
  }),
);
