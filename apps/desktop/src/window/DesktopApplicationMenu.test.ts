import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { DesktopUpdateCheckResult, DesktopUpdateState } from "@ankielcode/contracts";
import * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  webContents: { getAllWebContents: vi.fn(() => []), getFocusedWebContents: vi.fn() },
}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerElectronApp = Layer.succeed(ElectronApp.ElectronApp, {
  metadata: Effect.die("unexpected metadata read"),
  name: Effect.succeed("Ankiel Code"),
  systemLocale: Effect.succeed("en-US"),
  preferredSystemLanguages: Effect.succeed(["en-US"]),
  whenReady: Effect.void,
  requestSingleInstanceLock: Effect.succeed(true),
  quit: Effect.void,
  exit: () => Effect.void,
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  getAppMetrics: Effect.succeed([]),
  setAsDefaultProtocolClient: () => Effect.succeed(true),
  setDesktopName: () => Effect.void,
  setDockIcon: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  onBeforeQuitForUpdate: () => Effect.void,
  removeCommandLineSwitch: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronApp["Service"]);

interface MenuServices {
  readonly checkResult?: DesktopUpdateCheckResult;
  readonly shownMessageBox?: Deferred.Deferred<Electron.MessageBoxOptions>;
  readonly templates?: Array<readonly Electron.MenuItemConstructorOptions[]>;
  readonly enabledChanges?: Array<ReadonlyMap<string, boolean>>;
}

const layerElectronShell = Layer.succeed(ElectronShell.ElectronShell, {
  openExternal: () => Effect.succeed(true),
  openSystemSettings: () => Effect.succeed(false),
  copyText: () => Effect.void,
} satisfies ElectronShell.ElectronShell["Service"]);

const layerElectronDialog = ({ shownMessageBox }: MenuServices) =>
  Layer.succeed(ElectronDialog.ElectronDialog, {
    pickFolder: () => Effect.succeedNone,
    pickFiles: () => Effect.succeed([]),
    showMessageBox: (options) =>
      (shownMessageBox ? Deferred.succeed(shownMessageBox, options) : Effect.void).pipe(
        Effect.as({ response: options.cancelId ?? 0, checkboxChecked: false }),
      ),
    showErrorBox: () => Effect.void,
  } satisfies ElectronDialog.ElectronDialog["Service"]);

const layerDesktopUpdates = ({ checkResult }: MenuServices) =>
  Layer.succeed(DesktopUpdates.DesktopUpdates, {
    getState: Effect.die("unexpected getState"),
    isActionActive: Effect.succeed(false),
    isInstallActive: Effect.succeed(false),
    subscribe: Effect.die("unexpected subscribe"),
    emitState: Effect.void,
    disabledReason: Effect.succeedNone,
    configure: Effect.void,
    setChannel: () => Effect.die("unexpected setChannel"),
    check: () => (checkResult ? Effect.succeed(checkResult) : Effect.die("unexpected check")),
    download: Effect.die("unexpected download"),
    install: Effect.die("unexpected install"),
    installPrepared: () => Effect.die("unexpected installPrepared"),
  } satisfies DesktopUpdates.DesktopUpdates["Service"]);

const layerDesktopWindow = (selectedAction: Deferred.Deferred<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: (action) => Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: (direction) =>
      Deferred.succeed(selectedAction, `zoom-${direction}`).pipe(Effect.asVoid),
    runMainContentsCommand: (command) =>
      Deferred.succeed(selectedAction, `main-${command}`).pipe(Effect.asVoid),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindow["Service"]);

const layerElectronMenu = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
  platform: NodeJS.Platform,
  { templates, enabledChanges }: MenuServices,
) =>
  Layer.effect(
    ElectronMenu.ElectronMenu,
    ElectronMenu.make.pipe(
      Effect.map((menu) => ({
        ...menu,
        setApplicationMenu: (template: readonly Electron.MenuItemConstructorOptions[]) =>
          Effect.sync(() => templates?.push(template)).pipe(
            Effect.andThen(Deferred.succeed(applicationMenuTemplate, template)),
            Effect.asVoid,
          ),
        setApplicationMenuItemsEnabled: (enabled: ReadonlyMap<string, boolean>) =>
          Effect.sync(() => {
            enabledChanges?.push(new Map(enabled));
          }),
      })),
    ),
  ).pipe(Layer.provide(Layer.succeed(HostProcess.Platform, platform)));

const configureMenu = (
  selectedAction: Deferred.Deferred<string>,
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
  environment: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  services: MenuServices = {},
) =>
  Effect.gen(function* () {
    const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
    yield* menu.configure;
    return menu;
  }).pipe(
    Effect.provide(
      DesktopApplicationMenu.layer.pipe(
        Layer.provideMerge(
          layerElectronMenu(
            applicationMenuTemplate,
            environment.platform ?? environmentInput.platform,
            services,
          ),
        ),
        Layer.provideMerge(layerElectronShell),
        Layer.provideMerge(layerDesktopWindow(selectedAction)),
        Layer.provideMerge(layerDesktopUpdates(services)),
        Layer.provideMerge(layerElectronDialog(services)),
        Layer.provideMerge(layerElectronApp),
        Layer.provideMerge(
          DesktopEnvironment.layer({ ...environmentInput, ...environment }).pipe(
            Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
          ),
        ),
      ),
    ),
  );

const checkForUpdatesFromMacMenu = (state: Partial<DesktopUpdateState>) =>
  Effect.gen(function* () {
    const applicationMenuTemplate =
      yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
    const shownMessageBox = yield* Deferred.make<Electron.MessageBoxOptions>();
    yield* configureMenu(
      yield* Deferred.make<string>(),
      applicationMenuTemplate,
      { platform: "darwin" },
      {
        checkResult: {
          checked: true,
          state: {
            ...createInitialDesktopUpdateState(
              "0.1.5",
              { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
              "latest",
            ),
            enabled: true,
            ...state,
          },
        },
        shownMessageBox,
      },
    );

    const appMenu = (yield* Deferred.await(applicationMenuTemplate))[0];
    if (!Array.isArray(appMenu?.submenu)) {
      throw new Error("Expected the macOS app menu submenu to be an array.");
    }
    const checkForUpdates = appMenu.submenu.find((item) => item.label === "Check for Updates...");
    if (typeof checkForUpdates?.click !== "function") {
      throw new Error("Expected Check for Updates... menu item to have a click handler.");
    }

    // Every stub completes synchronously, so the menu action has finished when click returns.
    checkForUpdates.click(
      {} as Electron.MenuItem,
      {} as Electron.BrowserWindow,
      {} as KeyboardEvent,
    );
    const dialog = yield* Deferred.poll(shownMessageBox);
    if (Option.isNone(dialog)) {
      throw new Error("Check for Updates... finished without showing any dialog.");
    }
    return yield* dialog.value;
  });

const pressPasteAsText = (
  template: readonly Electron.MenuItemConstructorOptions[],
): ((focused: object) => void) => {
  const editMenu = template.find((item) => item.label === "Edit");
  if (!Array.isArray(editMenu?.submenu)) {
    throw new Error("Expected Edit menu submenu to be an array.");
  }
  const pasteAsTextItem = editMenu.submenu.find((item) => item.label === "Paste as Text");
  assert.equal(pasteAsTextItem?.accelerator, "CmdOrCtrl+Shift+V");
  const click = pasteAsTextItem?.click;
  if (typeof click !== "function") {
    throw new Error("Expected Paste as Text menu item to have a click handler.");
  }
  return (focused) => {
    using _focused = vi
      .spyOn(Electron.webContents, "getFocusedWebContents")
      .mockReturnValue(focused as Electron.WebContents);
    click({} as Electron.MenuItem, undefined, {
      triggeredByAccelerator: true,
    } as unknown as KeyboardEvent);
  };
};

const flattenMenu = (
  template: readonly Electron.MenuItemConstructorOptions[],
): Electron.MenuItemConstructorOptions[] =>
  template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flattenMenu(item.submenu) : []),
  ]);

const findItem = (
  template: readonly Electron.MenuItemConstructorOptions[],
  id: string,
): Electron.MenuItemConstructorOptions => {
  const item = flattenMenu(template).find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Expected a menu item with id ${id}.`);
  return item;
};

describe("DesktopApplicationMenu", () => {
  it.effect.each(["linux", "win32"] as const)(
    "leaves the %s accelerator to Chromium instead of injecting a paste",
    (platform) =>
      Effect.gen(function* () {
        const selectedAction = yield* Deferred.make<string>();
        const applicationMenuTemplate =
          yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

        yield* configureMenu(selectedAction, applicationMenuTemplate, { platform });

        const focused = { isDestroyed: () => false, pasteAndMatchStyle: vi.fn() };
        pressPasteAsText(yield* Deferred.await(applicationMenuTemplate))(focused);
        assert.equal(focused.pasteAndMatchStyle.mock.calls.length, 0);
        assert.isFalse(yield* Deferred.isDone(selectedAction));
      }),
  );

  it.effect("pastes natively and synchronously for the macOS accelerator", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate, { platform: "darwin" });
      const press = pressPasteAsText(yield* Deferred.await(applicationMenuTemplate));

      const host = { isDestroyed: () => false, pasteAndMatchStyle: vi.fn() };
      press(host);
      assert.equal(host.pasteAndMatchStyle.mock.calls.length, 1);

      // Electron reports a mounted preview guest as focused while the host's composer has focus.
      const guest = {
        isDestroyed: () => false,
        pasteAndMatchStyle: vi.fn(),
        hostWebContents: host,
      };
      press(guest);
      assert.equal(host.pasteAndMatchStyle.mock.calls.length, 2);
      assert.equal(guest.pasteAndMatchStyle.mock.calls.length, 0);
      assert.isFalse(yield* Deferred.isDone(selectedAction));
    }),
  );

  it.effect("registers macOS command-plus once and routes it through main-window zoom", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate, { platform: "darwin" });

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      assert.isDefined(viewMenu);
      if (!Array.isArray(viewMenu.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }

      assert.isUndefined(
        viewMenu.submenu.find((item) =>
          ["zoom", "reload", "devtools"].some((role) => item.role?.toLowerCase().includes(role)),
        ),
      );

      const shiftedEqual = viewMenu.submenu.filter(
        (item) => item.accelerator === "CmdOrCtrl+Shift+=",
      );
      assert.lengthOf(shiftedEqual, 1);
      assert.lengthOf(
        viewMenu.submenu.filter((item) => item.accelerator === "CmdOrCtrl+numadd"),
        1,
      );
      const zoomIn = shiftedEqual[0];
      assert.isDefined(zoomIn);
      assert.isFalse(zoomIn.visible);
      if (typeof zoomIn.click !== "function") {
        throw new Error("Expected Zoom In menu item to have a click handler.");
      }

      zoomIn.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "zoom-in");
    }),
  );

  it.effect("closes focused DevTools with Cmd/Ctrl+W, and the window from Close Window", () =>
    Effect.gen(function* () {
      for (const platform of ["darwin", "linux", "win32"] as const) {
        const applicationMenuTemplate =
          yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
        yield* configureMenu(yield* Deferred.make<string>(), applicationMenuTemplate, {
          platform,
        });

        const items = flattenMenu(yield* Deferred.await(applicationMenuTemplate));
        assert.isUndefined(
          items.find((item) => item.role === "close"),
          platform,
        );
        // Electron's default windowMenu submenu includes a close role.
        assert.isUndefined(
          items.find((item) => item.role === "windowMenu" && item.submenu === undefined),
          platform,
        );
        const closeItems = items.filter((item) => item.accelerator === "CmdOrCtrl+W");
        assert.lengthOf(closeItems, 1, platform);
        const closeItem = closeItems[0];
        assert.equal(
          closeItem?.label,
          platform === "darwin" ? "Close Window" : "Close Developer Tools",
          platform,
        );
        assert.isFunction(closeItem?.click);
        const appContents = {
          isDestroyed: () => false,
          isDevToolsFocused: () => false,
          closeDevTools: vi.fn(),
        };
        const inspectedContents = {
          ...appContents,
          isDevToolsFocused: () => true,
          closeDevTools: vi.fn(),
        };
        const window = { close: vi.fn() };
        using allContents = vi
          .spyOn(Electron.webContents, "getAllWebContents")
          .mockReturnValue([
            appContents as unknown as Electron.WebContents,
            inspectedContents as unknown as Electron.WebContents,
          ]);
        const press = () =>
          closeItem?.click?.(
            {} as Electron.MenuItem,
            window as unknown as Electron.BaseWindow,
            { triggeredByAccelerator: true } as unknown as KeyboardEvent,
          );
        press();
        assert.equal(inspectedContents.closeDevTools.mock.calls.length, 1);
        assert.equal(appContents.closeDevTools.mock.calls.length, 0);
        assert.equal(window.close.mock.calls.length, 0);

        allContents.mockReturnValue([appContents as unknown as Electron.WebContents]);
        press();
        assert.equal(appContents.closeDevTools.mock.calls.length, 0);
        assert.equal(window.close.mock.calls.length, platform === "darwin" ? 1 : 0, platform);
      }
    }),
  );

  it.effect("keeps Reload and Developer Tools out of packaged builds", () =>
    Effect.gen(function* () {
      for (const isPackaged of [true, false]) {
        const applicationMenuTemplate =
          yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
        yield* configureMenu(yield* Deferred.make<string>(), applicationMenuTemplate, {
          isPackaged,
        });
        const labels = flattenMenu(yield* Deferred.await(applicationMenuTemplate)).map(
          (item) => item.label,
        );
        for (const label of ["Reload", "Force Reload", "Toggle Developer Tools"]) {
          assert.equal(labels.includes(label), !isPackaged, `${label}, packaged: ${isPackaged}`);
        }
      }
    }),
  );

  it.effect("runs a clicked command in the renderer, never one its key already reached", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      yield* configureMenu(selectedAction, applicationMenuTemplate, { platform: "darwin" });

      const newThread = findItem(yield* Deferred.await(applicationMenuTemplate), "chat.new");
      const click = newThread.click;
      if (typeof click !== "function") throw new Error("Expected New Thread to have a click.");
      const window = {} as Electron.BaseWindow;
      click({} as Electron.MenuItem, window, {
        triggeredByAccelerator: true,
      } as unknown as KeyboardEvent);
      assert.isFalse(yield* Deferred.isDone(selectedAction));

      click({} as Electron.MenuItem, window, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "chat.new");
    }),
  );

  it.effect("starts disabled, then follows the renderer's enabled commands and bindings", () =>
    Effect.gen(function* () {
      const templates: Array<readonly Electron.MenuItemConstructorOptions[]> = [];
      const enabledChanges: Array<ReadonlyMap<string, boolean>> = [];
      const menu = yield* configureMenu(
        yield* Deferred.make<string>(),
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>(),
        { platform: "darwin" },
        { templates, enabledChanges },
      );
      const latest = () => templates.at(-1) ?? [];
      assert.isFalse(findItem(latest(), "sidebar.toggle").enabled);
      assert.isUndefined(findItem(latest(), "sidebar.toggle").accelerator);

      yield* menu.setCommandState({ enabled: { "sidebar.toggle": true, "not.a.command": true } });
      assert.lengthOf(templates, 1);
      assert.deepStrictEqual(enabledChanges, [new Map([["sidebar.toggle", true]])]);

      // Repeating a value changes nothing.
      yield* menu.setCommandState({ enabled: { "sidebar.toggle": true } });
      assert.lengthOf(enabledChanges, 1);

      const shortcut = {
        key: "b",
        modKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      };
      yield* menu.setCommandState({ shortcuts: { "sidebar.toggle": shortcut } });
      assert.lengthOf(templates, 2);
      assert.equal(findItem(latest(), "sidebar.toggle").accelerator, "CommandOrControl+B");
      assert.isTrue(findItem(latest(), "sidebar.toggle").enabled);

      yield* menu.setCommandState({ shortcuts: { "sidebar.toggle": { ...shortcut } } });
      assert.lengthOf(templates, 2);

      yield* menu.setCommandState({ shortcuts: { "sidebar.toggle": null } });
      assert.lengthOf(templates, 3);
      assert.isUndefined(findItem(latest(), "sidebar.toggle").accelerator);
    }),
  );

  it.effect("shows command accelerators off macOS without registering them", () =>
    Effect.gen(function* () {
      const templates: Array<readonly Electron.MenuItemConstructorOptions[]> = [];
      const menu = yield* configureMenu(
        yield* Deferred.make<string>(),
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>(),
        { platform: "win32" },
        { templates },
      );
      yield* menu.setCommandState({
        shortcuts: {
          "chat.new": {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
        },
      });
      const newThread = findItem(templates.at(-1) ?? [], "chat.new");
      assert.equal(newThread.accelerator, "CommandOrControl+N");
      assert.isFalse(newThread.registerAccelerator);
    }),
  );

  it.effect("reloads the main window even while a browser page has focus", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      if (!Array.isArray(viewMenu?.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }
      const reload = viewMenu.submenu.find((item) => item.label === "Reload");
      assert.equal(reload?.accelerator, "CmdOrCtrl+R");
      if (typeof reload?.click !== "function") {
        throw new Error("Expected Reload menu item to have a click handler.");
      }

      reload.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "main-reload");
    }),
  );
  it.effect("tells the user which update the menu check found", () =>
    Effect.gen(function* () {
      const dialog = yield* checkForUpdatesFromMacMenu({
        status: "available",
        availableVersion: "0.1.7",
      });
      assert.include(`${dialog.title ?? ""} ${dialog.message} ${dialog.detail ?? ""}`, "0.1.7");
    }),
  );

  it.effect("tells the user a downloaded update is ready when the menu check runs", () =>
    Effect.gen(function* () {
      const dialog = yield* checkForUpdatesFromMacMenu({
        status: "downloaded",
        availableVersion: "0.1.7",
        downloadedVersion: "0.1.7",
        downloadPercent: 100,
      });
      assert.include(`${dialog.title ?? ""} ${dialog.message} ${dialog.detail ?? ""}`, "0.1.7");
    }),
  );

  it.effect("labels every role item so the menu follows the UI language", () =>
    Effect.gen(function* () {
      // Electron's role defaults are English on every platform, so each role item needs a label.
      for (const platform of ["darwin", "linux", "win32"] as const) {
        const applicationMenuTemplate =
          yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
        yield* configureMenu(yield* Deferred.make<string>(), applicationMenuTemplate, {
          platform,
        });

        const unlabeled: string[] = [];
        const collect = (template: readonly Electron.MenuItemConstructorOptions[]) => {
          for (const item of template) {
            if (item.role !== undefined && typeof item.label !== "string") {
              unlabeled.push(item.role);
            }
            if (Array.isArray(item.submenu)) collect(item.submenu);
          }
        };
        collect(yield* Deferred.await(applicationMenuTemplate));
        assert.deepStrictEqual(unlabeled, [], platform);
      }
    }),
  );
});
