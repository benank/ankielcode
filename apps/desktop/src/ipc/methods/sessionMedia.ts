import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

const READ_MEDIA_MAX_BYTES = 256 * 1024 * 1024;

// No URL field: media URLs can carry signed tokens.
class MediaReadError extends Schema.TaggedError<MediaReadError>()("MediaReadError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Reads http(s) media as the app window's `<img>` would, with its cookies; null on network failure. */
export const fetchSessionMedia = (session: Electron.Session, url: string) =>
  Effect.tryPromise({
    try: async () => {
      // Like an <img>, send the session's cookies.
      const response = await session.fetch(url, { credentials: "include" });
      const mimeType = response.headers.get("content-type") ?? "";
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return { status: response.status, mimeType, data: new Uint8Array() };
      }
      // The whole body is held in memory, so stop before a huge file can exhaust the main process.
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > READ_MEDIA_MAX_BYTES) {
          return { status: 413, mimeType, data: new Uint8Array() };
        }
        chunks.push(chunk);
      }
      return { status: response.status, mimeType, data: Buffer.concat(chunks) };
    },
    catch: (cause) => new MediaReadError({ message: "Could not read media.", cause }),
  }).pipe(Effect.orElseSucceed(() => null));
