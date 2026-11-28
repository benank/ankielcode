import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { isMacPlatform } from "./utils";

const TEXT_ENTRY_SELECTOR =
  'textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]';
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Includes focused descendants of open shadow roots, whose key events target the host. */
function isTextEntry(target: Element): boolean {
  let element = target;
  while (element.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (element instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(element.type);
  return element.closest(TEXT_ENTRY_SELECTOR) !== null;
}

function isSelectAllKey(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
) {
  const mac = isMacPlatform(navigator.platform);
  return (
    event.key.toLowerCase() === "a" &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    !event.shiftKey &&
    !event.altKey
  );
}

/**
 * Select All inside a read-only surface selects that surface's rendered content, not the whole
 * window. A text field keeps the native behavior, which already stays inside the field.
 */
export function selectRenderedContentOnSelectAll(event: ReactKeyboardEvent<HTMLElement>) {
  // React bubbles keys from portaled children (dialogs, popovers) through this surface.
  if (
    !isSelectAllKey(event) ||
    event.defaultPrevented ||
    !(event.target instanceof Element) ||
    !event.currentTarget.contains(event.target) ||
    isTextEntry(event.target)
  ) {
    return;
  }
  event.preventDefault();
  window.getSelection()?.selectAllChildren(event.currentTarget);
}

/**
 * The same scoping for a surface read by clicking its text. That click can leave focus on the
 * body, so the key never reaches the surface; the last press or the selection says where the
 * reader is instead. Runs after React handlers, so anything that claimed the key wins.
 */
export function scopeSelectAllTo(surface: HTMLElement): () => void {
  const doc = surface.ownerDocument;
  let pressedInside = false;
  const onPointerDown = (event: PointerEvent) => {
    pressedInside = event.target instanceof Node && surface.contains(event.target);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isSelectAllKey(event) || event.defaultPrevented) return;
    const focused = doc.activeElement;
    if (focused && isTextEntry(focused)) return;
    const unfocused = focused === null || focused === doc.body || focused === doc.documentElement;
    const anchor = doc.getSelection()?.anchorNode ?? null;
    const reading =
      (focused !== null && surface.contains(focused)) ||
      (unfocused && (pressedInside || (anchor !== null && surface.contains(anchor))));
    if (!reading) return;
    event.preventDefault();
    doc.getSelection()?.selectAllChildren(surface);
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown);
  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown);
  };
}
