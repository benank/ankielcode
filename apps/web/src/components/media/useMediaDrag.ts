import type { DesktopBridge } from "@ankielcode/contracts";
import { msg } from "gt-react";
import { useRef, type DragEvent, type PointerEvent } from "react";

import { m } from "../../i18n/messages";
import { isMacPlatform, isWindowsPlatform } from "../../lib/utils";
import { toastManager } from "../ui/toast";
import { resolveProtocolRelativeMediaUrl } from "./mediaContent";
import type { MediaActionSource } from "./MediaActions";

export type MediaDragKind = "html" | "native" | "none";

/**
 * How an image leaves the app when dragged. Blob, data and external web images use the
 * browser's own drag. Anything else may be a signed environment URL, a bearer credential an
 * HTML drag would put on the pasteboard, so it goes as a downloaded file or not at all.
 */
function mediaDragKind(
  source: Pick<MediaActionSource, "src" | "asset" | "reference">,
  nativeAvailable: boolean,
): MediaDragKind {
  const { src } = source;
  if (src === null) return "none";
  if (/^(?:blob|data):/i.test(src)) return "html";
  if (!/^https?:/i.test(src)) return "none";
  const external =
    source.asset === undefined &&
    source.reference?.kind === "url" &&
    resolveProtocolRelativeMediaUrl(source.reference.url) === src;
  if (external) return "html";
  return nativeAvailable ? "native" : "none";
}

type NativeDragBridge = Required<Pick<DesktopBridge, "prepareMediaDrag" | "startMediaDrag">>;

function nativeDragBridge(): NativeDragBridge | null {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!bridge?.prepareMediaDrag || !bridge.startMediaDrag) return null;
  if (!isMacPlatform(navigator.platform) && !isWindowsPlatform(navigator.platform)) return null;
  return { prepareMediaDrag: bridge.prepareMediaDrag, startMediaDrag: bridge.startMediaDrag };
}

const reportDragFailure = () =>
  toastManager.add({
    type: "error",
    title: m(msg("Unable to drag image")),
    description: m(msg("The image could not be downloaded. Check the connection and try again.")),
  });

/** Props for an `<img>` that drags out of the app; `enabled: false` turns dragging off. */
export function useMediaDrag(source: MediaActionSource, fileName: string, enabled = true) {
  const preparedRef = useRef<{ readonly src: string; readonly id: Promise<string | null> } | null>(
    null,
  );
  const bridge = nativeDragBridge();
  const kind = enabled && source.kind === "image" ? mediaDragKind(source, bridge !== null) : "none";
  if (kind === "none") return { draggable: false } as const;
  // An image drags by default; an explicit draggable="true" would change text selection.
  if (kind === "html" || bridge === null || source.src === null) return {};
  const src = source.src;

  // The download starts on pointer down so the file exists by the time the drag begins.
  const prepare = () => {
    const current = preparedRef.current;
    if (current?.src === src) return current.id;
    const id = bridge.prepareMediaDrag({ url: src, name: fileName }).catch(() => null);
    const prepared = { src, id };
    preparedRef.current = prepared;
    void id.then((value) => {
      if (value === null && preparedRef.current === prepared) preparedRef.current = null;
    });
    return id;
  };

  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button === 0 && event.pointerType === "mouse") void prepare();
    },
    onDragStart: (event: DragEvent<HTMLElement>) => {
      // The OS drag replaces the HTML one, which would carry the URL.
      event.preventDefault();
      event.stopPropagation();
      let released = false;
      window.addEventListener("pointerup", () => (released = true), { once: true });
      void prepare().then(async (id) => {
        if (released) return;
        // The drop target may move the file, so the next drag downloads it again.
        preparedRef.current = null;
        if (id === null || !(await bridge.startMediaDrag(id).catch(() => false))) {
          reportDragFailure();
        }
      });
    },
  } as const;
}
