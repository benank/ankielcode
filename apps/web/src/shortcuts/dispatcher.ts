import {
  isDesktopMenuCommand,
  type KeybindingCommand,
  type ResolvedKeybindingsConfig,
} from "@ankielcode/contracts";

import { resolveShortcutCommand, type ShortcutMatchContext } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "../state/server";

/** Return `false` to let the next scope handle the event. */
export type CommandHandler = (event: KeyboardEvent) => boolean | void;

export type CommandHandlers = Partial<Record<KeybindingCommand, CommandHandler>>;

export interface CommandScopeOptions {
  /** Read at event time; a scope whose guard fails is skipped. */
  readonly when?: (event: KeyboardEvent) => boolean;
  /** When-clause context the dispatcher cannot know (terminalOpen, previewOpen), read at event time. */
  readonly context?: () => Partial<ShortcutMatchContext>;
  readonly keybindings?: () => ResolvedKeybindingsConfig;
  /** For shortcuts that are not keybinding commands (Escape, "/"); runs before command lookup. */
  readonly onKeyDown?: CommandHandler;
  /**
   * Run in the capture phase, ahead of focused widgets that consume the key
   * themselves (the terminal encodes Ctrl+Shift+T and stops propagation).
   */
  readonly capture?: boolean;
  /**
   * Hear every bubbling keydown after the scopes ran, with whether one of them
   * (or the page) consumed it. Observers never consume. For listeners that react to keys other
   * scopes may also handle, such as scroll keys.
   */
  readonly observe?: (event: KeyboardEvent, consumed: boolean) => void;
  /**
   * Whether the desktop menu bar offers these commands, for screens they do nothing on. `when`
   * guards keys and is not read for menu clicks. Defaults to always.
   */
  readonly menu?: () => boolean;
}

interface CommandScope {
  readonly commands: CommandHandlers;
  readonly options: CommandScopeOptions;
}

// Within each list the newest scope wins.
const globalScopes: CommandScope[] = [];
const captureScopes: CommandScope[] = [];
const observerScopes: CommandScope[] = [];
const menuCommandListeners = new Set<() => void>();

function notifyMenuCommands() {
  for (const listener of menuCommandListeners) listener();
}

function readFocusContext(event: KeyboardEvent): Partial<ShortcutMatchContext> {
  return {
    terminalFocus: isTerminalFocused(),
    previewFocus: isPreviewFocused(),
    editableFocus: isEditableFocused(event.target),
    modelPickerOpen: isModelPickerOpen(),
  };
}

function isInsideConfirmation(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="alertdialog"]') !== null;
}

function scopeCommandHandler(scope: CommandScope, event: KeyboardEvent) {
  const { commands, options } = scope;
  const command = resolveShortcutCommand(
    event,
    options.keybindings?.() ?? appAtomRegistry.get(primaryServerKeybindingsAtom),
    { context: { ...readFocusContext(event), ...options.context?.() } },
  );
  return command === null ? undefined : commands[command];
}

function runScope(scope: CommandScope, event: KeyboardEvent): boolean {
  const { options } = scope;
  if (options.when && !options.when(event)) return false;
  if (options.onKeyDown && options.onKeyDown(event) !== false) return true;
  const handler = scopeCommandHandler(scope, event);
  if (handler === undefined) return false;
  if (isInsideConfirmation(event.target)) {
    event.preventDefault();
    return true;
  }
  return handler(event) !== false;
}

/**
 * Whether a bubble-phase command is bound to this keydown, for widgets that would otherwise
 * consume it. Capture scopes have already run (and declined) by the time a widget sees it.
 */
export function hasCommandForKeyDown(event: KeyboardEvent): boolean {
  return globalScopes.some(
    (scope) =>
      (!scope.options.when || scope.options.when(event)) &&
      scopeCommandHandler(scope, event) !== undefined,
  );
}

function runScopes(scopes: readonly CommandScope[], event: KeyboardEvent): boolean {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (event.defaultPrevented) return true;
    const scope = scopes[index];
    if (scope && runScope(scope, event)) return true;
  }
  return false;
}

function dispatchCaptureKeyDown(event: KeyboardEvent): void {
  runScopes(captureScopes, event);
}

function dispatchKeyDown(event: KeyboardEvent): void {
  const consumed = runScopes(globalScopes, event) || event.defaultPrevented;
  for (const scope of observerScopes.slice()) scope.options.observe?.(event, consumed);
}

let keydownInstalled = false;
function ensureKeydownListener() {
  if (keydownInstalled || typeof window === "undefined") return;
  keydownInstalled = true;
  window.addEventListener("keydown", dispatchCaptureKeyDown, true);
  window.addEventListener("keydown", dispatchKeyDown);
}

function pushScope(list: CommandScope[], scope: CommandScope): () => void {
  ensureKeydownListener();
  list.push(scope);
  notifyMenuCommands();
  return () => {
    const index = list.lastIndexOf(scope);
    if (index !== -1) list.splice(index, 1);
    notifyMenuCommands();
  };
}

/** App-global commands, registered once at module level or bootstrap. */
export function registerCommands(
  commands: CommandHandlers,
  options: CommandScopeOptions = {},
): () => void {
  const scopes = options.observe ? observerScopes : options.capture ? captureScopes : globalScopes;
  return pushScope(scopes, { commands, options });
}

type MenuActionHandler = () => void;
const menuActionHandlers = new Map<string, MenuActionHandler[]>();
let menuActionInstalled = false;

/** Runs whenever a command scope or menu action is registered or removed. */
export function subscribeMenuCommands(listener: () => void): () => void {
  menuCommandListeners.add(listener);
  return () => {
    menuCommandListeners.delete(listener);
  };
}

// Newest scope first, capture scopes ahead of the rest, as a keydown reaches them.
function* menuCommandHandlers(command: KeybindingCommand) {
  for (const scopes of [captureScopes, globalScopes]) {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const scope = scopes[index];
      const handler = scope?.commands[command];
      if (handler && (scope.options.menu?.() ?? true)) yield handler;
    }
  }
}

/** Whether a menu bar item for this action would reach a handler on the current screen. */
export function isMenuActionAvailable(action: string): boolean {
  if ((menuActionHandlers.get(action)?.length ?? 0) > 0) return true;
  return isDesktopMenuCommand(action) && !menuCommandHandlers(action).next().done;
}

/** A menu click runs the command's own handler; menu bar commands fall back to the key scopes. */
function dispatchMenuAction(action: string): void {
  const handler = menuActionHandlers.get(action)?.at(-1);
  if (handler) return handler();
  if (!isDesktopMenuCommand(action)) return;
  // Handlers read and claim a keydown; the menu has none, so it hands them an inert one.
  const event = new KeyboardEvent("keydown");
  for (const run of menuCommandHandlers(action)) {
    if (run(event) !== false) return;
  }
}

function ensureMenuActionListener() {
  if (menuActionInstalled || typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (typeof bridge?.onMenuAction !== "function") return;
  menuActionInstalled = true;
  bridge.onMenuAction(dispatchMenuAction);
}

/** Desktop menu actions; the newest handler for an action wins. */
export function registerMenuAction(action: string, handler: MenuActionHandler): () => void {
  ensureMenuActionListener();
  const handlers = menuActionHandlers.get(action) ?? [];
  handlers.push(handler);
  menuActionHandlers.set(action, handlers);
  notifyMenuCommands();
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index !== -1) handlers.splice(index, 1);
    notifyMenuCommands();
  };
}
