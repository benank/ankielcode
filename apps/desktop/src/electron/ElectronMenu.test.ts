import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import type * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const { menu } = vi.hoisted(() => ({
  menu: { template: [] as Electron.MenuItemConstructorOptions[] },
}));

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
      menu.template = template;
      return { popup: (options: Electron.PopupOptions) => options.callback?.() };
    },
  },
}));

import * as ElectronMenu from "./ElectronMenu.ts";

describe("ElectronMenu", () => {
  it.effect("shows ampersands in labels instead of reading them as mnemonics", () =>
    Effect.gen(function* () {
      const electronMenu = yield* ElectronMenu.make;
      yield* electronMenu.showContextMenu({
        window: { webContents: { getZoomFactor: () => 1 } } as Electron.BrowserWindow,
        items: [
          { id: "filter", label: "Filter by R&D" },
          { id: "more", label: "A&B", children: [{ id: "child", label: "C && D" }] },
        ],
        position: Option.none(),
        source: Option.none(),
      });

      assert.deepEqual(
        menu.template.map((item) => item.label),
        ["Filter by R&&D", "A&&B"],
      );
      const submenu = menu.template[1]!.submenu as Electron.MenuItemConstructorOptions[];
      assert.equal(submenu[0]!.label, "C &&&& D");
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );

  it.effect.each(["darwin", "win32"] as const)(
    "shows a context menu item's shortcut on %s without registering it",
    (platform) =>
      Effect.gen(function* () {
        const electronMenu = yield* ElectronMenu.make;
        yield* electronMenu.showContextMenu({
          window: { webContents: { getZoomFactor: () => 1 } } as Electron.BrowserWindow,
          items: [
            { id: "pin", label: "Pin", accelerator: { ...SHORTCUT, key: "p", shiftKey: true } },
            { id: "plain", label: "Plain" },
          ],
          position: Option.none(),
          source: Option.none(),
        });

        const [pin, plain] = menu.template;
        assert.equal(pin?.accelerator, "CommandOrControl+Shift+P");
        assert.equal(pin?.registerAccelerator, platform === "darwin" ? undefined : false);
        assert.isUndefined(plain?.accelerator);
      }).pipe(Effect.provideService(HostProcess.Platform, platform)),
  );
});

const SHORTCUT = {
  key: "k",
  modKey: true,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

describe("menuAccelerator", () => {
  it.each([
    [{ ...SHORTCUT }, "darwin", "CommandOrControl+K"],
    [{ ...SHORTCUT, key: "[", shiftKey: true }, "darwin", "CommandOrControl+Shift+["],
    [{ ...SHORTCUT, key: "+" }, "linux", "CommandOrControl+Plus"],
    [{ ...SHORTCUT, key: "arrowup", altKey: true }, "win32", "CommandOrControl+Alt+Up"],
    [{ ...SHORTCUT, key: "enter" }, "darwin", "CommandOrControl+ENTER"],
    [{ ...SHORTCUT, key: "f12" }, "linux", "CommandOrControl+F12"],
    [{ ...SHORTCUT, modKey: false, metaKey: true }, "darwin", "Super+K"],
    // A Command-less key equivalent would reach the macOS menu before the page.
    [{ ...SHORTCUT, modKey: false, ctrlKey: true }, "darwin", undefined],
    [{ ...SHORTCUT, modKey: false, ctrlKey: true }, "linux", "Control+K"],
    [{ ...SHORTCUT, modKey: false }, "darwin", undefined],
    // Keys Electron has no accelerator for are left unlabeled rather than failing the menu.
    [{ ...SHORTCUT, key: "dead" }, "linux", undefined],
    [{ ...SHORTCUT, key: "é" }, "linux", undefined],
  ] as const)("labels %o on %s as %s", (shortcut, platform, expected) => {
    assert.equal(ElectronMenu.menuAccelerator(shortcut, platform), expected);
  });
});
