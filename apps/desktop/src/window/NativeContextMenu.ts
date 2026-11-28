import * as Option from "effect/Option";

import type * as Electron from "electron";
import { msg } from "gt-i18n";

import * as ElectronShell from "../electron/ElectronShell.ts";
import { m } from "../i18n/messages.ts";

export type NativeContextMenuAction =
  | { readonly type: "reload" }
  | { readonly type: "replace-misspelling"; readonly word: string }
  | { readonly type: "learn-spelling"; readonly word: string }
  | { readonly type: "look-up" }
  | { readonly type: "open-link"; readonly url: string }
  | { readonly type: "copy-text"; readonly text: string }
  | { readonly type: "copy-image" };

export type NativeContextMenuParams = Pick<
  Electron.ContextMenuParams,
  | "misspelledWord"
  | "dictionarySuggestions"
  | "linkURL"
  | "mediaType"
  | "selectionText"
  | "isEditable"
  | "editFlags"
>;

export interface NativeContextMenuInput {
  readonly params: NativeContextMenuParams;
  readonly platform: NodeJS.Platform;
  readonly isBrowserContents: boolean;
}

const LOOK_UP_MAX_LENGTH = 24;

function parseMailtoAddress(rawUrl: string): Option.Option<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Option.none();
  }
  if (url.protocol !== "mailto:" || url.pathname === "") return Option.none();
  try {
    return Option.some(decodeURIComponent(url.pathname));
  } catch {
    return Option.some(url.pathname);
  }
}

function lookUpSubject(selection: string): string {
  const collapsed = selection.replace(/\s+/g, " ").trim();
  const characters = Array.from(collapsed);
  return characters.length > LOOK_UP_MAX_LENGTH
    ? `${characters.slice(0, LOOK_UP_MAX_LENGTH).join("").trimEnd()}…`
    : collapsed;
}

/**
 * The native menu for a right-click Chromium did not claim. Each item appears only when it does
 * something, so empty space gets no menu at all.
 */
export function buildNativeContextMenuTemplate(
  input: NativeContextMenuInput,
  run: (action: NativeContextMenuAction) => void,
): Electron.MenuItemConstructorOptions[] {
  const { params, platform } = input;
  const isMac = platform === "darwin";
  const selection = params.selectionText.trim();
  // The main renderer hosts untrusted frames too, so only web links open or share.
  const webLink = ElectronShell.parseWebExternalUrl(params.linkURL);
  const sections: Electron.MenuItemConstructorOptions[][] = [];

  if (input.isBrowserContents) {
    sections.push([{ label: m(msg("Reload")), click: () => run({ type: "reload" }) }]);
  }

  if (params.misspelledWord) {
    const word = params.misspelledWord;
    const suggestions = params.dictionarySuggestions.slice(0, 5);
    sections.push([
      ...suggestions.map((suggestion): Electron.MenuItemConstructorOptions => ({
        label: suggestion,
        click: () => run({ type: "replace-misspelling", word: suggestion }),
      })),
      ...(suggestions.length === 0 ? [{ label: m(msg("No suggestions")), enabled: false }] : []),
      { label: m(msg("Learn Spelling")), click: () => run({ type: "learn-spelling", word }) },
    ]);
  }

  if (isMac && selection !== "") {
    sections.push([
      {
        label: m(msg("Look Up “{selection}”"), { selection: lookUpSubject(selection) }),
        click: () => run({ type: "look-up" }),
      },
    ]);
  }

  const linkItems: Electron.MenuItemConstructorOptions[] = [];
  if (Option.isSome(webLink)) {
    const url = webLink.value;
    linkItems.push({ label: m(msg("Open Link")), click: () => run({ type: "open-link", url }) });
  }
  if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
    const text = params.linkURL;
    linkItems.push({ label: m(msg("Copy Link")), click: () => run({ type: "copy-text", text }) });
  }
  const mailtoAddress = parseMailtoAddress(params.linkURL);
  if (Option.isSome(mailtoAddress)) {
    const text = mailtoAddress.value;
    linkItems.push({
      label: m(msg("Copy Email Address")),
      click: () => run({ type: "copy-text", text }),
    });
  }
  sections.push(linkItems);

  if (params.mediaType === "image") {
    sections.push([{ label: m(msg("Copy Image")), click: () => run({ type: "copy-image" }) }]);
  }

  // Shortcut hints only, matching ElectronMenu: the page already handles these chords.
  const editItem = (
    role: "cut" | "copy" | "paste" | "selectAll",
    label: string,
    accelerator: string,
    enabled: boolean,
  ): Electron.MenuItemConstructorOptions => ({
    role,
    label,
    accelerator,
    ...(isMac ? {} : { registerAccelerator: false }),
    enabled,
  });
  const copy = editItem(
    "copy",
    m(msg("Copy", { $context: "Edit menu item" })),
    "CmdOrCtrl+C",
    params.editFlags.canCopy,
  );
  if (params.isEditable) {
    sections.push([
      editItem(
        "cut",
        m(msg("Cut", { $context: "Edit menu item" })),
        "CmdOrCtrl+X",
        params.editFlags.canCut,
      ),
      copy,
      editItem(
        "paste",
        m(msg("Paste", { $context: "Edit menu item" })),
        "CmdOrCtrl+V",
        params.editFlags.canPaste,
      ),
      editItem(
        "selectAll",
        m(msg("Select All", { $context: "Edit menu item" })),
        "CmdOrCtrl+A",
        params.editFlags.canSelectAll,
      ),
    ]);
  } else if (selection !== "" && params.editFlags.canCopy) {
    sections.push([copy]);
  }

  if (isMac) {
    const sharingItem: Electron.SharingItem | undefined = Option.isSome(webLink)
      ? { urls: [webLink.value] }
      : selection !== ""
        ? { texts: [params.selectionText] }
        : undefined;
    if (sharingItem) {
      sections.push([{ role: "shareMenu", label: m(msg("Share")), sharingItem }]);
    }
  }

  return sections
    .filter((section) => section.length > 0)
    .flatMap((section, index): Electron.MenuItemConstructorOptions[] =>
      index === 0 ? section : [{ type: "separator" }, ...section],
    );
}
