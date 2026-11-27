import {
  DESKTOP_MENU_COMMANDS,
  type DesktopMenu,
  type DesktopMenuCommand,
  type KeybindingShortcut,
} from "@ankielcode/contracts";
import type * as Electron from "electron";
import { msg } from "gt-i18n";

import { m } from "../i18n/messages.ts";
import { menuAccelerator } from "../electron/ElectronMenu.ts";

const COMMAND_TITLES: Record<DesktopMenuCommand, () => string> = {
  "chat.new": () => m(msg("New Thread", { $context: "menu bar command" })),
  "chat.find": () => m(msg("Find", { $context: "menu command that focuses search" })),
  "sidebar.toggle": () => m(msg("Toggle Sidebar")),
  "terminal.toggle": () => m(msg("Toggle Terminal")),
  "rightPanel.toggle": () => m(msg("Toggle Right Panel")),
  "threadPanel.toggle": () => m(msg("Toggle Thread Panel")),
  "diff.toggle": () => m(msg("Toggle Diff")),
  "preview.toggle": () => m(msg("Toggle Browser")),
  "navigation.back": () =>
    m(msg("Back", { $context: "menu command that returns to the previous screen" })),
  "navigation.forward": () =>
    m(msg("Forward", { $context: "menu command that goes to the next screen" })),
  "commandPalette.toggle": () => m(msg("Command Palette")),
  "thread.previous": () => m(msg("Previous Thread")),
  "thread.next": () => m(msg("Next Thread")),
  "thread.jump.1": () => m(msg("Go to Thread {index}"), { index: "1" }),
  "thread.jump.2": () => m(msg("Go to Thread {index}"), { index: "2" }),
  "thread.jump.3": () => m(msg("Go to Thread {index}"), { index: "3" }),
  "thread.jump.4": () => m(msg("Go to Thread {index}"), { index: "4" }),
  "thread.jump.5": () => m(msg("Go to Thread {index}"), { index: "5" }),
  "thread.jump.6": () => m(msg("Go to Thread {index}"), { index: "6" }),
  "thread.jump.7": () => m(msg("Go to Thread {index}"), { index: "7" }),
  "thread.jump.8": () => m(msg("Go to Thread {index}"), { index: "8" }),
  "thread.jump.9": () => m(msg("Go to Thread {index}"), { index: "9" }),
  "thread.stop": () =>
    m(msg("Stop", { $context: "menu command that interrupts the running turn" })),
  "thread.settle": () => m(msg("Settle or Un-settle")),
  "thread.pin": () => m(msg("Pin or Unpin")),
  "thread.copyReference": () => m(msg("Copy PR Link or Thread")),
  "thread.regenerateTitle": () => m(msg("Regenerate Title")),
};

export interface DesktopMenuCommandState {
  readonly platform: NodeJS.Platform;
  readonly shortcuts: ReadonlyMap<DesktopMenuCommand, KeybindingShortcut>;
  readonly enabled: ReadonlySet<DesktopMenuCommand>;
}

/**
 * The renderer keeps the keyboard: its handlers know the focus and when-clauses a native
 * accelerator cannot, so these accelerators are labels and only a pointer click runs a command.
 */
export function desktopMenuCommandItems(
  menu: DesktopMenu,
  state: DesktopMenuCommandState,
  run: (command: DesktopMenuCommand) => void,
): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];
  for (const entry of DESKTOP_MENU_COMMANDS) {
    if (entry.menu !== menu) continue;
    if ("separatorBefore" in entry && items.length > 0) items.push({ type: "separator" });
    const shortcut = state.shortcuts.get(entry.command);
    const accelerator = shortcut && menuAccelerator(shortcut, state.platform);
    items.push({
      id: entry.command,
      label: COMMAND_TITLES[entry.command](),
      enabled: state.enabled.has(entry.command),
      ...(accelerator === undefined
        ? {}
        : {
            accelerator,
            ...(state.platform === "darwin" ? {} : { registerAccelerator: false }),
          }),
      click: (_item, _window, event) => {
        // A key that reached the menu was already offered to the page, which declined it.
        if (event.triggeredByAccelerator === true) return;
        run(entry.command);
      },
    });
  }
  return items;
}
