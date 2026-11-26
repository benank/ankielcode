/** What a `PresentationSource` hands iOS when its media is dragged out of the app. */
export interface PresentationDragProps {
  readonly dragUri: string;
  readonly dragName: string;
  readonly dragMimeType: string;
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

const EXTENSION = /\.[a-z0-9]{1,16}$/i;
const MAX_NAME_LENGTH = 120;

function lastSegment(path: string): string {
  return path.split(/[\\/]/).at(-1)?.trim() ?? "";
}

function urlFileName(uri: string): string {
  const segment = uri.split(/[?#]/, 1)[0]!.split("/").at(-1) ?? "";
  try {
    return lastSegment(decodeURIComponent(segment));
  } catch {
    return lastSegment(segment);
  }
}

/**
 * Only files on the device and plain downloads: native code fetches http(s) lazily when
 * the drop asks for the data, without the app's auth headers.
 */
export function presentationDragProps(input: {
  readonly uri: string | null | undefined;
  readonly name: string | null | undefined;
  readonly mimeType?: string | null | undefined;
}): PresentationDragProps | undefined {
  if (!input.uri || !/^(?:https?|file):/i.test(input.uri)) return undefined;
  const uri = input.uri.split("#", 1)[0]!;
  const mimeType = (input.mimeType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const fromUrl = urlFileName(uri);
  let name = lastSegment(input.name ?? "") || fromUrl || "image";
  if (name.length > MAX_NAME_LENGTH) {
    const extension = EXTENSION.exec(name)?.[0] ?? "";
    name = name.slice(0, MAX_NAME_LENGTH - extension.length).trimEnd() + extension;
  }
  if (!EXTENSION.test(name)) {
    const extension = IMAGE_EXTENSIONS[mimeType] ?? EXTENSION.exec(fromUrl)?.[0].slice(1);
    if (extension) name = `${name}.${extension}`;
  }
  return { dragUri: uri, dragName: name, dragMimeType: mimeType };
}
