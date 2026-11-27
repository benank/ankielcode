import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  type DesktopMenuCommand,
  type DesktopMenuState,
  type DesktopUpdateChannel,
  type DesktopUpdateState,
  isDesktopMenuCommand,
  type KeybindingShortcut,
} from "@ankielcode/contracts";
import * as Electron from "electron";
import { msg } from "gt-i18n";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { applyLanguage, m, onLocaleChange } from "../i18n/messages.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import { isInstallableDesktopUpdateState } from "../updates/updateMachine.ts";
import { desktopMenuCommandItems } from "./DesktopMenuCommands.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedError<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
    /** Applies the renderer's shortcuts and enabled commands for the menu bar. */
    readonly setCommandState: (state: DesktopMenuState) => Effect.Effect<void>;
  }
>()("@ankielcode/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog;

const { logInfo: logUpdaterInfo } = makeComponentLogger("desktop-updater");

const { logError: logMenuError } = makeComponentLogger("desktop-menu");

const sameShortcut = (left: KeybindingShortcut | null, right: KeybindingShortcut | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.key === right.key &&
    left.modKey === right.modKey &&
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey);

// True when DevTools had focus and closed, so the chord does not also close the window.
const closeFocusedDevTools = (): boolean => {
  const contents = Electron.webContents
    .getAllWebContents()
    .find((candidate) => !candidate.isDestroyed() && candidate.isDevToolsFocused());
  contents?.closeDevTools();
  return contents !== undefined;
};

const DOCS_URL = "https://github.com/benank/ankielcode/blob/main/docs/README.md";
const REPORT_ISSUE_URL = "https://github.com/benank/ankielcode/issues/new";

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action, {
    reveal: action !== "paste-as-text",
  });
});

const zoomMainWindow = Effect.fn("desktop.menu.zoomMainWindow")(function* (
  direction: DesktopWindow.MainWindowZoomDirection,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.zoomMain(direction);
});

const runMainContentsCommand = Effect.fn("desktop.menu.runMainContentsCommand")(function* (
  command: DesktopWindow.MainWindowContentsCommand,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.runMainContentsCommand(command);
});

const trackLabel = (channel: DesktopUpdateChannel) =>
  channel === "nightly"
    ? m(msg("Nightly", { $context: "release track" }))
    : m(msg("Stable", { $context: "release track" }));

// Restarting interrupts running tasks, so every install from the menu confirms first.
const confirmRestartToUpdate = Effect.fn("desktop.menu.confirmRestartToUpdate")(function* (
  updateState: DesktopUpdateState,
) {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const version = updateState.downloadedVersion ?? updateState.availableVersion;
  const { response } = yield* electronDialog.showMessageBox({
    type: "info",
    title: m(msg("Update ready")),
    message:
      version === null
        ? m(msg("A new version of Ankiel Code is ready to install."))
        : m(msg("Ankiel Code {version} is ready to install."), { version }),
    detail: m(
      msg("Ankiel Code will restart to install it. Any running tasks will be interrupted."),
    ),
    buttons: [m(msg("Restart", { $context: "button, restarts the app" })), m(msg("Later"))],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) yield* updates.install;
});

const checkForUpdatesFromMenu = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* updates.check("menu", { download: true });
  const updateState = result.state;

  if (updateState.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: m(msg("You're up to date!")),
      message: m(msg("Ankiel Code {version} is currently the newest version available."), {
        version: updateState.currentVersion,
      }),
      buttons: [m(msg("OK"))],
    });
  } else if (updateState.status === "available" || updateState.status === "downloading") {
    // The check started the download; it no longer asks first.
    yield* electronDialog.showMessageBox({
      type: "info",
      title: m(msg("Update downloading")),
      message:
        updateState.availableVersion === null
          ? m(msg("A new version of Ankiel Code is downloading."))
          : m(msg("Ankiel Code {version} is downloading."), {
              version: updateState.availableVersion,
            }),
      detail: m(msg("Choose Restart to Update in the menu once it's ready.")),
      buttons: [m(msg("OK"))],
    });
  } else if (updateState.status === "downloaded") {
    yield* confirmRestartToUpdate(updateState);
  } else if (updateState.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: m(msg("Update check failed")),
      message: m(msg("Could not check for updates.")),
      detail:
        updateState.trackMismatch !== undefined
          ? m(
              msg(
                "This {build} build can't update from the {saved} track on its own. Switch the update track back to {build}, or use Review beside Update track to retry the switch to {saved}.",
              ),
              {
                build: trackLabel(updateState.trackMismatch.buildChannel),
                saved: trackLabel(updateState.channel),
              },
            )
          : (updateState.message ?? m(msg("An unknown error occurred. Please try again later."))),
      buttons: [m(msg("OK"))],
    });
  }
}).pipe(Effect.withSpan("desktop.menu.checkForUpdates"));

const handleCheckForUpdatesMenuClick = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const disabledReason = yield* updates.disabledReason;
  if (Option.isSome(disabledReason)) {
    yield* logUpdaterInfo("manual update check requested, but updates are disabled", {
      disabledReason: disabledReason.value,
    });
    yield* electronDialog.showMessageBox({
      type: "info",
      title: m(msg("Updates unavailable")),
      message: m(msg("Automatic updates are not available right now.")),
      detail: disabledReason.value,
      buttons: [m(msg("OK"))],
    });
    return;
  }

  // Opening a window before backend confirmation can strand it on failed auth bootstrap.
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.activate;
  yield* checkForUpdatesFromMenu;
}).pipe(Effect.withSpan("desktop.menu.handleCheckForUpdatesClick"));

/** @public */
export const make = Effect.gen(function* () {
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronShell = yield* ElectronShell.ElectronShell;
  const clientSettings = yield* Effect.serviceOption(DesktopClientSettings.DesktopClientSettings);
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);
  const runFork = Effect.runForkWith(context);
  const runSync = Effect.runSyncWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  const updates = yield* DesktopUpdates.DesktopUpdates;
  // The downloaded update "Restart to Update" installs; the item shows only while one is ready.
  let readyUpdate: DesktopUpdateState | null = null;

  const shortcuts = new Map<DesktopMenuCommand, KeybindingShortcut>();
  // Disabled until the renderer reports the screen it shows.
  const enabled = new Set<DesktopMenuCommand>();
  let configured = false;

  const configure = Effect.gen(function* () {
    const commandItems = (menu: Parameters<typeof desktopMenuCommandItems>[0]) =>
      desktopMenuCommandItems(
        menu,
        { platform: environment.platform, shortcuts, enabled },
        (command) => runMenuEffect(command, dispatchMenuAction(command)),
      );
    const openUrlClick = (url: string) => () => {
      void runPromise(electronShell.openExternal(url));
    };
    const checkForUpdatesClick = () => {
      runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick);
    };
    const updateItems: Electron.MenuItemConstructorOptions[] = [
      { label: m(msg("Check for Updates...")), click: checkForUpdatesClick },
      {
        label: m(msg("Restart to Update")),
        visible: readyUpdate !== null,
        click: () => {
          if (readyUpdate !== null) {
            runMenuEffect("restart-to-update", confirmRestartToUpdate(readyUpdate));
          }
        },
      },
    ];
    const settingsClick = () => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    };
    const pasteAsTextClick = (
      _item: Electron.MenuItem,
      _window: Electron.BaseWindow | undefined,
      event: Electron.KeyboardEvent,
    ) => {
      if (event.triggeredByAccelerator === true) {
        // Chromium pastes this chord itself except on macOS. Paste synchronously there:
        // a renderer round trip can land after the terminal's own clipboard read.
        if (environment.platform === "darwin") {
          runSync(electronMenu.pasteAndMatchStyle);
        }
        return;
      }
      runMenuEffect("paste-as-text", dispatchMenuAction("paste-as-text"));
    };
    const zoomClick = (direction: DesktopWindow.MainWindowZoomDirection) => () => {
      runMenuEffect(`zoom-${direction}`, zoomMainWindow(direction));
    };
    const mainContentsClick = (command: DesktopWindow.MainWindowContentsCommand) => () => {
      runMenuEffect(command, runMainContentsCommand(command));
    };
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: environment.displayName,
        submenu: [
          { role: "about", label: m(msg("About {appName}"), { appName: environment.displayName }) },
          ...updateItems,
          { type: "separator" },
          {
            label: m(msg("Settings...")),
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          { role: "services", label: m(msg("Services", { $context: "macOS app menu item" })) },
          { type: "separator" },
          { role: "hide", label: m(msg("Hide {appName}"), { appName: environment.displayName }) },
          { role: "hideOthers", label: m(msg("Hide Others")) },
          {
            role: "unhide",
            label: m(msg("Show All", { $context: "macOS app menu item, shows hidden apps" })),
          },
          { type: "separator" },
          { role: "quit", label: m(msg("Quit {appName}"), { appName: environment.displayName }) },
        ],
      });
    }

    template.push(
      {
        label: m(msg("File", { $context: "menu bar title" })),
        submenu: [
          ...commandItems("file"),
          { type: "separator" },
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: m(msg("Settings...")),
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          // The app window never hands Cmd/Ctrl+W to the menu, so the chord only closes focused
          // DevTools; on macOS the renderer closes the window itself when nothing claims it.
          ...(environment.platform === "darwin"
            ? [
                {
                  label: m(msg("Close Window")),
                  accelerator: "CmdOrCtrl+W",
                  click: (_item: Electron.MenuItem, window: Electron.BaseWindow | undefined) => {
                    if (!closeFocusedDevTools()) window?.close();
                  },
                },
              ]
            : [
                {
                  label: m(msg("Close Developer Tools")),
                  accelerator: "CmdOrCtrl+W",
                  visible: false,
                  click: closeFocusedDevTools,
                },
                {
                  role: "quit" as const,
                  label:
                    environment.platform === "win32"
                      ? m(msg("Exit", { $context: "File menu item, quits the app" }))
                      : m(msg("Quit")),
                },
              ]),
        ],
      },
      {
        label: m(msg("Edit", { $context: "menu bar title" })),
        submenu: [
          { role: "undo", label: m(msg("Undo", { $context: "Edit menu item" })) },
          { role: "redo", label: m(msg("Redo", { $context: "Edit menu item" })) },
          { type: "separator" },
          { role: "cut", label: m(msg("Cut", { $context: "Edit menu item" })) },
          { role: "copy", label: m(msg("Copy", { $context: "Edit menu item" })) },
          { role: "paste", label: m(msg("Paste", { $context: "Edit menu item" })) },
          {
            label: m(msg("Paste as Text")),
            accelerator: "CmdOrCtrl+Shift+V",
            click: pasteAsTextClick,
          },
          { role: "delete", label: m(msg("Delete", { $context: "Edit menu item" })) },
          { type: "separator" },
          { role: "selectAll", label: m(msg("Select All", { $context: "Edit menu item" })) },
          { type: "separator" },
          ...commandItems("edit"),
          ...(environment.platform === "darwin"
            ? [
                { type: "separator" as const },
                {
                  label: m(msg("Spelling and Grammar")),
                  submenu: [
                    {
                      role: "toggleSpellChecker" as const,
                      label: m(msg("Check Spelling While Typing")),
                    },
                  ],
                },
                {
                  label: m(msg("Substitutions")),
                  submenu: [
                    { role: "showSubstitutions" as const, label: m(msg("Show Substitutions")) },
                    { type: "separator" as const },
                    { role: "toggleSmartQuotes" as const, label: m(msg("Smart Quotes")) },
                    { role: "toggleSmartDashes" as const, label: m(msg("Smart Dashes")) },
                    { role: "toggleTextReplacement" as const, label: m(msg("Text Replacement")) },
                  ],
                },
                {
                  label: m(msg("Speech", { $context: "menu, text-to-speech" })),
                  submenu: [
                    { role: "startSpeaking" as const, label: m(msg("Start Speaking")) },
                    { role: "stopSpeaking" as const, label: m(msg("Stop Speaking")) },
                  ],
                },
              ]
            : []),
        ],
      },
      {
        label: m(msg("View", { $context: "menu bar title" })),
        submenu: [
          ...commandItems("view"),
          { type: "separator" },
          /* Native reload/DevTools/zoom roles target focused guests; these commands must target the app. */
          ...(environment.isDevelopment || !environment.isPackaged
            ? [
                {
                  label: m(msg("Reload")),
                  accelerator: "CmdOrCtrl+R",
                  click: mainContentsClick("reload"),
                },
                {
                  label: m(msg("Force Reload")),
                  accelerator: "Shift+CmdOrCtrl+R",
                  click: mainContentsClick("forceReload"),
                },
                {
                  label: m(msg("Toggle Developer Tools")),
                  accelerator: environment.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
                  click: mainContentsClick("toggleDevTools"),
                },
                { type: "separator" as const },
              ]
            : []),
          { label: m(msg("Actual Size")), accelerator: "CmdOrCtrl+0", click: zoomClick("reset") },
          { label: m(msg("Zoom In")), accelerator: "CmdOrCtrl+=", click: zoomClick("in") },
          {
            label: m(msg("Zoom In")),
            accelerator: "CmdOrCtrl+Plus",
            visible: false,
            click: zoomClick("in"),
          },
          ...(environment.platform === "darwin"
            ? [
                {
                  label: m(msg("Zoom In")),
                  accelerator: "CmdOrCtrl+Shift+=",
                  visible: false,
                  click: zoomClick("in"),
                },
              ]
            : []),
          { label: m(msg("Zoom Out")), accelerator: "CmdOrCtrl+-", click: zoomClick("out") },
          // Keypad codes do not match number-row accelerators.
          {
            label: m(msg("Actual Size")),
            accelerator: "CmdOrCtrl+num0",
            visible: false,
            click: zoomClick("reset"),
          },
          {
            label: m(msg("Zoom In")),
            accelerator: "CmdOrCtrl+numadd",
            visible: false,
            click: zoomClick("in"),
          },
          {
            label: m(msg("Zoom Out")),
            accelerator: "CmdOrCtrl+numsub",
            visible: false,
            click: zoomClick("out"),
          },
          { type: "separator" },
          { role: "togglefullscreen", label: m(msg("Toggle Full Screen")) },
        ],
      },
      {
        label: m(msg("Go", { $context: "menu bar menu of navigation commands" })),
        submenu: commandItems("go"),
      },
      {
        label: m(msg("Thread", { $context: "menu bar title" })),
        submenu: commandItems("thread"),
      },
      {
        // Electron's default Window submenu adds a Ctrl+W close role off macOS.
        role: "windowMenu",
        label: m(msg("Window", { $context: "menu bar title" })),
        submenu: [
          { role: "minimize", label: m(msg("Minimize", { $context: "Window menu item" })) },
          {
            role: "zoom",
            label: m(msg("Zoom", { $context: "Window menu item, resizes the window" })),
          },
          ...(environment.platform === "darwin"
            ? [
                { type: "separator" as const },
                { role: "front" as const, label: m(msg("Bring All to Front")) },
              ]
            : []),
        ],
      },
      {
        role: "help",
        label: m(msg("Help", { $context: "menu bar title" })),
        submenu: [
          { label: m(msg("Documentation")), click: openUrlClick(DOCS_URL) },
          {
            label: m(msg("Keyboard Shortcuts")),
            click: () => runMenuEffect("open-keybindings", dispatchMenuAction("open-keybindings")),
          },
          { label: m(msg("Report an Issue")), click: openUrlClick(REPORT_ISSUE_URL) },
          { type: "separator" },
          ...updateItems,
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
    configured = true;
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  const setCommandState = Effect.fn("desktop.menu.setCommandState")(function* (
    state: DesktopMenuState,
  ) {
    let shortcutsChanged = false;
    for (const [command, shortcut] of Object.entries(state.shortcuts ?? {})) {
      if (!isDesktopMenuCommand(command)) continue;
      if (sameShortcut(shortcuts.get(command) ?? null, shortcut)) continue;
      shortcutsChanged = true;
      if (shortcut === null) shortcuts.delete(command);
      else shortcuts.set(command, shortcut);
    }
    const enabledChanges = new Map<string, boolean>();
    for (const [command, isEnabled] of Object.entries(state.enabled ?? {})) {
      if (!isDesktopMenuCommand(command) || enabled.has(command) === isEnabled) continue;
      if (isEnabled) enabled.add(command);
      else enabled.delete(command);
      enabledChanges.set(command, isEnabled);
    }
    if (!configured) return;
    // Accelerators are fixed once built; enabled flags flip in place.
    if (shortcutsChanged) yield* configure;
    else if (enabledChanges.size > 0)
      yield* electronMenu.setApplicationMenuItemsEnabled(enabledChanges);
  });

  // Load the saved language before the first build so the menu never starts in English.
  const applySavedLanguage = Effect.gen(function* () {
    if (Option.isNone(clientSettings)) return;
    const saved = yield* clientSettings.value.get.pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(saved)) {
      yield* applyLanguage(saved.value.language).pipe(
        Effect.provideService(ElectronApp.ElectronApp, electronApp),
      );
    }
  });

  // Readiness flips about once per release, so a rebuild is cheaper than tracking the item.
  const trackReadyUpdate = Effect.fn("desktop.menu.trackReadyUpdate")(function* (
    state: DesktopUpdateState,
  ) {
    const next = isInstallableDesktopUpdateState(state) ? state : null;
    const flipped = (next === null) !== (readyUpdate === null);
    readyUpdate = next;
    if (flipped && configured) yield* configure;
  });
  const updateStates = yield* updates.subscribe;
  yield* trackReadyUpdate(updateStates.latest);
  yield* updateStates.changes.pipe(Stream.runForEach(trackReadyUpdate), Effect.forkScoped);

  let rebuildsOnLocaleChange = false;
  return DesktopApplicationMenu.of({
    setCommandState,
    configure: applySavedLanguage.pipe(
      Effect.andThen(configure),
      Effect.tap(() =>
        Effect.sync(() => {
          if (rebuildsOnLocaleChange) return;
          rebuildsOnLocaleChange = true;
          onLocaleChange(() => runFork(configure));
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
