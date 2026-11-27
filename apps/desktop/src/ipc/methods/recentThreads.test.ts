import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

const { setMenu, setJumpList } = vi.hoisted(() => ({ setMenu: vi.fn(), setJumpList: vi.fn() }));
vi.mock("electron", () => ({
  app: {
    dock: { setMenu },
    setJumpList,
    getJumpListSettings: () => ({ removedItems: [] }),
  },
  Menu: { buildFromTemplate: (template: unknown) => template },
}));

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopWebLinks from "../../app/DesktopWebLinks.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { installRecentThreads } from "./recentThreads.ts";

type Handler = (raw: unknown) => Effect.Effect<unknown, Schema.SchemaError>;

const install = (platform: string) =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    yield* installRecentThreads().pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isPackaged: true,
        appPath: "/app",
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
      Effect.provideService(DesktopIpc.DesktopIpc, {
        handle: (method: DesktopIpc.DesktopIpcMethod<unknown, unknown>) =>
          Effect.sync(
            () => void handlers.set(method.channel, method.handler as unknown as Handler),
          ),
      } as unknown as DesktopIpc.DesktopIpc["Service"]),
      Effect.provideService(
        DesktopWebLinks.DesktopWebLinks,
        DesktopWebLinks.DesktopWebLinks.of({
          receive: () => Effect.void,
          setRendererReady: () => Effect.void,
        }),
      ),
    );
    return handlers.get(IpcChannels.SET_RECENT_THREADS_CHANNEL)!;
  });

const threads = [{ environmentId: "env", threadId: "thread", title: "Fix the build" }];

it.effect("shows recent threads in the dock menu on macOS and the jump list on Windows", () =>
  Effect.gen(function* () {
    yield* (yield* install("darwin"))(threads);
    assert.strictEqual(setMenu.mock.calls.length, 1);
    yield* (yield* install("win32"))(threads);
    assert.strictEqual(setJumpList.mock.calls.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("accepts the list on Linux without touching the shell", () =>
  Effect.gen(function* () {
    setMenu.mockClear();
    setJumpList.mockClear();
    yield* (yield* install("linux"))(threads);
    assert.strictEqual(setMenu.mock.calls.length, 0);
    assert.strictEqual(setJumpList.mock.calls.length, 0);
  }).pipe(Effect.scoped),
);
