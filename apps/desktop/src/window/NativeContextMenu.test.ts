import { assert, describe, it } from "@effect/vitest";

import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import {
  buildNativeContextMenuTemplate,
  type NativeContextMenuAction,
  type NativeContextMenuParams,
} from "./NativeContextMenu.ts";

const emptySpace: NativeContextMenuParams = {
  misspelledWord: "",
  dictionarySuggestions: [],
  linkURL: "",
  mediaType: "none",
  selectionText: "",
  isEditable: false,
  editFlags: {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: true,
    canDelete: false,
    canSelectAll: true,
    canEditRichly: false,
  },
};

function build(
  params: Partial<Omit<NativeContextMenuParams, "editFlags">> & {
    readonly editFlags?: Partial<Electron.EditFlags>;
  },
  options: { platform?: NodeJS.Platform; isBrowserContents?: boolean } = {},
) {
  const actions: NativeContextMenuAction[] = [];
  const template = buildNativeContextMenuTemplate(
    {
      params: {
        ...emptySpace,
        ...params,
        editFlags: { ...emptySpace.editFlags, ...params.editFlags },
      },
      platform: options.platform ?? "darwin",
      isBrowserContents: options.isBrowserContents ?? false,
    },
    (action) => actions.push(action),
  );
  const labels = template.map((item) =>
    item.type === "separator" ? "-" : (item.label ?? item.role ?? "?"),
  );
  const click = (label: string) => {
    const item = template.find((candidate) => candidate.label === label);
    if (!item?.click) throw new Error(`no clickable "${label}" in ${JSON.stringify(labels)}`);
    item.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    return actions.at(-1);
  };
  return { template, labels, click };
}

describe("buildNativeContextMenuTemplate", () => {
  it("offers nothing on empty, non-editable space", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      assert.deepEqual(build({}, { platform }).template, []);
    }
  });

  it("keeps Reload for browser contents even on empty space", () => {
    const menu = build({}, { isBrowserContents: true });
    assert.deepEqual(menu.labels, ["Reload"]);
    assert.deepEqual(menu.click("Reload"), { type: "reload" });
  });

  it("shows the full edit block with shortcut hints in an editable field", () => {
    const menu = build(
      { isEditable: true, editFlags: { canCut: false, canCopy: false } },
      { platform: "linux" },
    );
    assert.deepEqual(
      menu.template.map((item) => [
        item.role,
        item.enabled,
        item.accelerator,
        item.registerAccelerator,
      ]),
      [
        ["cut", false, "CmdOrCtrl+X", false],
        ["copy", false, "CmdOrCtrl+C", false],
        ["paste", true, "CmdOrCtrl+V", false],
        ["selectAll", true, "CmdOrCtrl+A", false],
      ],
    );
    const mac = build({ isEditable: true });
    assert.isTrue(mac.template.every((item) => item.registerAccelerator === undefined));
  });

  it("offers Copy, Look Up and Share for a selection on macOS", () => {
    const menu = build({
      selectionText: "  ephemeral\n  configuration values that run long  ",
      editFlags: { canCopy: true },
    });
    assert.deepEqual(menu.labels, [
      "Look Up “ephemeral configuration…”",
      "-",
      "Copy",
      "-",
      "Share",
    ]);
    assert.deepEqual(menu.click("Look Up “ephemeral configuration…”"), { type: "look-up" });
    const share = menu.template.find((item) => item.role === "shareMenu");
    assert.deepEqual(share?.sharingItem, {
      texts: ["  ephemeral\n  configuration values that run long  "],
    });
  });

  it("offers only Copy for a selection on Windows and Linux", () => {
    for (const platform of ["win32", "linux"] as const) {
      const menu = build(
        { selectionText: "ephemeral", editFlags: { canCopy: true } },
        { platform },
      );
      assert.deepEqual(menu.labels, ["Copy"]);
    }
  });

  it("opens, copies and shares web links", () => {
    const menu = build({ linkURL: "https://example.com/a?b=1" });
    assert.deepEqual(menu.labels, ["Open Link", "Copy Link", "-", "Share"]);
    assert.deepEqual(menu.click("Open Link"), {
      type: "open-link",
      url: "https://example.com/a?b=1",
    });
    assert.deepEqual(menu.click("Copy Link"), {
      type: "copy-text",
      text: "https://example.com/a?b=1",
    });
    assert.deepEqual(menu.template.find((item) => item.role === "shareMenu")?.sharingItem, {
      urls: ["https://example.com/a?b=1"],
    });
    assert.deepEqual(build({ linkURL: "https://example.com/" }, { platform: "win32" }).labels, [
      "Open Link",
      "Copy Link",
    ]);
  });

  it("copies but never opens a non-web link from the menu", () => {
    const menu = build({ linkURL: "zed://ssh/alice@host/repo" });
    assert.deepEqual(menu.labels, ["Copy Link"]);
  });

  it("ignores links it cannot open or copy", () => {
    assert.deepEqual(build({ linkURL: "javascript:alert(1)" }).template, []);
  });

  it("copies the bare address of a mailto link", () => {
    const menu = build({ linkURL: "mailto:restaurant%40example.com?subject=Hi" });
    assert.deepEqual(menu.labels, ["Copy Email Address"]);
    assert.deepEqual(menu.click("Copy Email Address"), {
      type: "copy-text",
      text: "restaurant@example.com",
    });
  });

  it("copies images", () => {
    const menu = build({ mediaType: "image" }, { platform: "linux" });
    assert.deepEqual(menu.labels, ["Copy Image"]);
    assert.deepEqual(menu.click("Copy Image"), { type: "copy-image" });
  });

  it("puts suggestions and Learn Spelling above the edit block", () => {
    const menu = build(
      {
        isEditable: true,
        misspelledWord: "teh",
        dictionarySuggestions: ["the", "ten", "tea", "tech", "then", "they"],
        selectionText: "teh",
        editFlags: { canCopy: true, canCut: true },
      },
      { platform: "linux" },
    );
    assert.deepEqual(menu.labels, [
      "the",
      "ten",
      "tea",
      "tech",
      "then",
      "Learn Spelling",
      "-",
      "Cut",
      "Copy",
      "Paste",
      "Select All",
    ]);
    assert.deepEqual(menu.click("tea"), { type: "replace-misspelling", word: "tea" });
    assert.deepEqual(menu.click("Learn Spelling"), { type: "learn-spelling", word: "teh" });
  });

  it("still offers Learn Spelling when there are no suggestions", () => {
    const menu = build({ isEditable: true, misspelledWord: "ankiel" }, { platform: "win32" });
    assert.deepEqual(menu.labels.slice(0, 3), ["No suggestions", "Learn Spelling", "-"]);
    assert.isFalse(menu.template[0]?.enabled);
  });
});
