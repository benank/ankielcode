import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

const NAME_MAX_LENGTH = 120;
const FALLBACK_STEM = "image";
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/webp": "webp",
};

/**
 * A file name that is safe on every platform: no separators, reserved characters or device
 * names, and an extension from the media type when the name has none. It comes from the
 * attachment or alt text, never from the URL, which can carry a signed token.
 */
function mediaDragFileName(name: string, mimeType: string): string {
  const cleaned = [...(name.split(/[/\\]/).at(-1) ?? "")]
    .map((char) => (char.charCodeAt(0) < 0x20 || '<>:"|?*\u007f'.includes(char) ? "_" : char))
    .join("")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  const dot = cleaned.lastIndexOf(".");
  let stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  let extension = dot > 0 ? cleaned.slice(dot + 1) : "";
  if (extension === "")
    extension = EXTENSIONS[mimeType.split(";", 1)[0]!.trim().toLowerCase()] ?? "";
  if (stem === "") stem = FALLBACK_STEM;
  if (WINDOWS_RESERVED_STEM.test(stem)) stem = `_${stem}`;
  const suffix = extension === "" ? "" : `.${extension.slice(0, 16)}`;
  return `${stem.slice(0, NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

/**
 * Temp files for drags out of the app, one directory per file so each keeps its own name.
 * The root is this process's own and is removed when the scope closes, on quit.
 */
export const makeMediaDragFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const random = yield* SecureRandom.SecureRandom;
  let root: string | null = null;

  const ensureRoot = Effect.gen(function* () {
    if (root !== null) return root;
    const created = yield* fs.makeTempDirectory({ prefix: "ankiel-drag-" });
    root = created;
    yield* Scope.addFinalizer(
      scope,
      fs.remove(created, { recursive: true, force: true }).pipe(Effect.ignore),
    );
    return created;
  });

  return {
    write: Effect.fn("DesktopMediaDragFiles.write")(function* (
      name: string,
      mimeType: string,
      data: Uint8Array,
    ) {
      const directory = path.join(yield* ensureRoot, yield* random.uuidV4());
      yield* fs.makeDirectory(directory);
      const file = path.join(directory, mediaDragFileName(name, mimeType));
      yield* fs.writeFile(file, data);
      return file;
    }),
  };
});
