import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

const { startDrag, media, icon } = vi.hoisted(() => ({
  startDrag: vi.fn(),
  media: vi.fn(),
  icon: { isEmpty: () => false, getSize: () => ({ width: 64, height: 32 }) },
}));
vi.mock("electron", () => ({
  nativeImage: { createFromPath: () => icon },
  app: { getFileIcon: async () => icon },
}));
vi.mock("./sessionMedia.ts", () => ({
  fetchSessionMedia: (_session: unknown, url: string) => Effect.sync(() => media(url)),
}));

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { installMediaDrag } from "./mediaDrag.ts";

type Handler = (
  raw: unknown,
  event: DesktopIpc.DesktopIpcInvokeEvent,
) => Effect.Effect<unknown, Schema.SchemaError>;

it.effect("downloads a drag file ahead, then starts the drag from the app window only", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const handlers = new Map<string, Handler>();
    yield* installMediaDrag().pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
      Effect.provideService(DesktopIpc.DesktopIpc, {
        handle: (method: DesktopIpc.DesktopIpcMethod<unknown, unknown>) =>
          Effect.sync(
            () => void handlers.set(method.channel, method.handler as unknown as Handler),
          ),
      } as unknown as DesktopIpc.DesktopIpc["Service"]),
      Effect.provideService(ElectronWindow.ElectronWindow, {
        main: Effect.succeedSome({ webContents: { id: 1, session: {}, startDrag } }),
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
    );
    const prepare = (url: string, sender = 1) =>
      handlers.get(IpcChannels.PREPARE_MEDIA_DRAG_CHANNEL)!(
        { url, name: "shot" },
        { sender: { id: sender } },
      );
    const start = (id: unknown, sender = 1) =>
      handlers.get(IpcChannels.START_MEDIA_DRAG_CHANNEL)!(id, { sender: { id: sender } });

    media.mockReturnValue({ status: 200, mimeType: "image/png", data: new Uint8Array([1]) });
    const signed = "https://host.example/api/assets/secret-token/shot.png";
    assert.isNull(yield* prepare(signed, 2));
    assert.isNull(yield* prepare("file:///etc/passwd"));
    media.mockReturnValueOnce({ status: 200, mimeType: "text/html", data: new Uint8Array([1]) });
    assert.isNull(yield* prepare(signed));
    media.mockReturnValueOnce({ status: 403, mimeType: "image/png", data: new Uint8Array([1]) });
    assert.isNull(yield* prepare(signed));

    const id = yield* prepare(signed);
    assert.isString(id);
    assert.strictEqual(yield* prepare(signed), id);
    assert.isFalse(yield* start(id, 2));
    assert.isFalse(yield* start("unknown"));
    assert.strictEqual(startDrag.mock.calls.length, 0);

    assert.isTrue(yield* start(id));
    const [{ file, icon: dragIcon }] = startDrag.mock.calls[0] as [{ file: string; icon: unknown }];
    assert.strictEqual(dragIcon, icon);
    assert.isTrue(file.endsWith("shot.png"));
    assert.notInclude(file, "secret-token");
    assert.deepEqual(yield* fs.readFile(file), new Uint8Array([1]));
    // A started drag is spent: the drop may have moved the file.
    assert.isFalse(yield* start(id));
    assert.notStrictEqual(yield* prepare(signed), id);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto)),
  ),
);

it.effect("does nothing on Linux", () =>
  Effect.gen(function* () {
    const handle = vi.fn(() => Effect.void);
    yield* installMediaDrag().pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        platform: "linux",
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
      Effect.provideService(DesktopIpc.DesktopIpc, {
        handle,
      } as unknown as DesktopIpc.DesktopIpc["Service"]),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
    );
    assert.strictEqual(handle.mock.calls.length, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeServices.layer, SecureRandom.layerWebCrypto)),
  ),
);
