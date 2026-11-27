import {
  DESKTOP_MENU_COMMANDS,
  type DesktopBridge,
  type DesktopMenuCommand,
  type KeybindingShortcut,
  type ResolvedKeybindingsConfig,
} from "@ankielcode/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { effectiveShortcutsForCommand, type ShortcutMatchContext } from "../keybindings";
import { isMacPlatform } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "../state/server";
import { isMenuActionAvailable, registerCommands, subscribeMenuCommands } from "./dispatcher";

// Commands that only apply on part of a screen are labelled as they run there.
const FIND_OPEN = { threadFindOpen: true };
const MENU_SHORTCUT_CONTEXT: Partial<Record<DesktopMenuCommand, Partial<ShortcutMatchContext>>> = {
  "chat.findNext": FIND_OPEN,
  "chat.findPrevious": FIND_OPEN,
};

interface DesktopMenuStateSources {
  readonly isAvailable: (command: DesktopMenuCommand) => boolean;
  readonly keybindings: () => ResolvedKeybindingsConfig;
  readonly send: NonNullable<DesktopBridge["setMenuState"]>;
}

/**
 * Reports what changed since the last report: one entry per flipped flag or moved binding,
 * gathered over a microtask so re-registering effects net to nothing.
 */
function createDesktopMenuStateReporter({
  isAvailable,
  keybindings,
  send,
}: DesktopMenuStateSources) {
  const sentEnabled = new Map<DesktopMenuCommand, boolean>();
  const sentShortcuts = new Map<DesktopMenuCommand, string>();
  let shortcutsStale = true;
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const enabled: Record<string, boolean> = {};
    const shortcuts: Record<string, KeybindingShortcut | null> = {};
    const bindings = shortcutsStale ? keybindings() : null;
    shortcutsStale = false;
    for (const { command } of DESKTOP_MENU_COMMANDS) {
      const available = isAvailable(command);
      if (sentEnabled.get(command) !== available) {
        sentEnabled.set(command, available);
        enabled[command] = available;
      }
      if (bindings === null) continue;
      // The binding a neutral screen would run, as the app's own shortcut hints show it.
      const shortcut =
        effectiveShortcutsForCommand(bindings, command, {
          context: MENU_SHORTCUT_CONTEXT[command] ?? {},
        })[0] ?? null;
      const key = JSON.stringify(shortcut);
      if (sentShortcuts.get(command) !== key) {
        sentShortcuts.set(command, key);
        shortcuts[command] = shortcut;
      }
    }
    const hasEnabled = Object.keys(enabled).length > 0;
    const hasShortcuts = Object.keys(shortcuts).length > 0;
    if (!hasEnabled && !hasShortcuts) return;
    void send({
      ...(hasEnabled ? { enabled } : {}),
      ...(hasShortcuts ? { shortcuts } : {}),
    }).catch(() => undefined);
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };

  return {
    refresh: schedule,
    refreshShortcuts: () => {
      shortcutsStale = true;
      schedule();
    },
  };
}

type CloseChordEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "isComposing"
>;

/**
 * Cmd+W on macOS that no tab, terminal or dialog claimed, which closes the window like any Mac
 * app. The desktop keeps the chord from the menu, so the renderer decides; elsewhere closing
 * the window quits, so Ctrl+W stays a no-op.
 */
function isUnclaimedCloseWindowChord(
  event: CloseChordEvent,
  consumed: boolean,
  platform: string,
): boolean {
  return (
    !consumed &&
    !event.repeat &&
    !event.isComposing &&
    isMacPlatform(platform) &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "w"
  );
}

/** Keeps the desktop menu bar's enabled items and accelerators in step with the renderer. */
export function installDesktopMenuState(router: AnyRouter): () => void {
  const closeWindow = window.desktopBridge?.closeWindow;
  const disposeClose =
    closeWindow === undefined
      ? () => undefined
      : registerCommands(
          {},
          {
            // Observers run after every scope, with whether one of them consumed the key.
            observe: (event, consumed) => {
              if (!isUnclaimedCloseWindowChord(event, consumed, navigator.platform)) return;
              event.preventDefault();
              void closeWindow().catch(() => undefined);
            },
          },
        );
  const send = window.desktopBridge?.setMenuState;
  if (send === undefined) return disposeClose;
  const reporter = createDesktopMenuStateReporter({
    isAvailable: isMenuActionAvailable,
    keybindings: () => appAtomRegistry.get(primaryServerKeybindingsAtom),
    send,
  });
  reporter.refresh();
  const disposers = [
    disposeClose,
    subscribeMenuCommands(reporter.refresh),
    // Scopes offer their commands per route.
    router.subscribe("onResolved", reporter.refresh),
    appAtomRegistry.subscribe(primaryServerKeybindingsAtom, reporter.refreshShortcuts),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
