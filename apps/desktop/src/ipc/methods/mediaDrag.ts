import { DesktopMediaDragInputSchema } from "@ankielcode/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { makeMediaDragFiles } from "../../app/DesktopMediaDragFiles.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { fetchSessionMedia } from "./sessionMedia.ts";

const DRAG_ICON_SIZE = 128;

class MediaDragIconError extends Schema.TaggedError<MediaDragIconError>()(
  "MediaDragIconError",
  {},
) {}

/** The image itself, scaled down, or the file type's icon when it cannot be decoded. */
async function dragIcon(file: string): Promise<Electron.NativeImage> {
  const image = Electron.nativeImage.createFromPath(file);
  if (image.isEmpty()) return Electron.app.getFileIcon(file, { size: "normal" });
  const { width, height } = image.getSize();
  if (Math.max(width, height) <= DRAG_ICON_SIZE) return image;
  return image.resize(width >= height ? { width: DRAG_ICON_SIZE } : { height: DRAG_ICON_SIZE });
}

/**
 * Drags an image out of the app as a file (macOS and Windows). `startDrag` must run while the
 * drag gesture is live, so `prepare` downloads the file ahead, on pointer down, and `start`
 * reaches `startDrag` without awaiting anything.
 */
export const installMediaDrag = Effect.fn("desktop.ipc.installMediaDrag")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform !== "darwin" && environment.platform !== "win32") return;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const files = yield* makeMediaDragFiles;
  const random = yield* SecureRandom.SecureRandom;
  const prepared = new Map<
    string,
    { readonly url: string; readonly file: string; readonly icon: Electron.NativeImage }
  >();
  // The thumbnail and the full-size preview prepare the same image; one download serves both.
  const preparedByUrl = new Map<string, string>();

  const mainWindowFor = (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) =>
    Effect.map(electronWindow.main, (window) =>
      Option.isSome(window) && event?.sender.id === window.value.webContents.id
        ? window.value
        : null,
    );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.PREPARE_MEDIA_DRAG_CHANNEL,
      payload: DesktopMediaDragInputSchema,
      result: Schema.NullOr(Schema.String),
      handler: Effect.fn("desktop.ipc.mediaDrag.prepare")(
        function* (input, event) {
          const window = yield* mainWindowFor(event);
          if (window === null || !/^https?:$/.test(URL.parse(input.url)?.protocol ?? "")) {
            return null;
          }
          const existing = preparedByUrl.get(input.url);
          if (existing !== undefined) return existing;
          const media = yield* fetchSessionMedia(window.webContents.session, input.url);
          const mimeType = media?.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
          // An error or sign-in page must not become the dragged file.
          if (
            media === null ||
            media.status < 200 ||
            media.status >= 300 ||
            media.data.byteLength === 0 ||
            mimeType === "text/html"
          ) {
            return null;
          }
          const file = yield* files.write(input.name, mimeType, media.data);
          const icon = yield* Effect.tryPromise({
            try: () => dragIcon(file),
            catch: () => new MediaDragIconError(),
          });
          if (icon.isEmpty()) return null;
          const id = yield* random.uuidV4();
          prepared.set(id, { url: input.url, file, icon });
          preparedByUrl.set(input.url, id);
          return id;
        },
        Effect.orElseSucceed(() => null),
      ),
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: IpcChannels.START_MEDIA_DRAG_CHANNEL,
      payload: Schema.String,
      result: Schema.Boolean,
      handler: Effect.fn("desktop.ipc.mediaDrag.start")(function* (id, event) {
        const window = yield* mainWindowFor(event);
        const entry = prepared.get(id);
        if (window === null || entry === undefined) return false;
        // A drop can move the file away, so each prepared file is handed over once.
        prepared.delete(id);
        preparedByUrl.delete(entry.url);
        window.webContents.startDrag({ file: entry.file, icon: entry.icon });
        return true;
      }),
    }),
  );
});
