import { startFileDrag } from "./methods/fileDrag.ts";
import * as Effect from "effect/Effect";

import { receiveProviderAuthCallback, cancelProviderAuthCallback } from "./methods/providerAuth.ts";
import {
  appleSpeechAvailable,
  appleSpeechPrepare,
  appleSpeechTranscribe,
} from "./methods/appleSpeech.ts";
import * as DesktopIpc from "./DesktopIpc.ts";
import { installNotificationBadge } from "./methods/notificationBadge.ts";
import { installDesktopNotifications } from "./methods/notifications.ts";
import { installLowPowerState } from "./methods/lowPower.ts";
import { getClientSettings, setClientSettings } from "./methods/clientSettings.ts";
import { getConnectionCatalog, setConnectionCatalog } from "./methods/connectionCatalog.ts";
import {
  getHostEnvironmentId,
  getLocalEnvironmentEnabled,
  setLocalEnvironmentEnabled,
} from "./methods/localEnvironment.ts";
import {
  getAdvertisedEndpoints,
  getServerExposureState,
  setServerExposureMode,
  setTailscaleServeEnabled,
} from "./methods/serverExposure.ts";
import {
  bootstrapSshBearerSession,
  disconnectSshEnvironment,
  discoverSshHosts,
  ensureSshEnvironment,
  fetchSshEnvironmentDescriptor,
  fetchSshSessionState,
  resolveSshHost,
  resolveSshPasswordPrompt,
} from "./methods/sshEnvironment.ts";
import {
  checkForUpdate,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  setUpdateChannel,
} from "./methods/updates.ts";
import {
  getAppBranding,
  getLocalEnvironmentBootstraps,
  getLocalEnvironmentBearerToken,
  getSystemLocale,
  getPreferredSystemLanguages,
  getPrimaryPasteEnabled,
  getWindowFullscreenState,
  openExternal,
  readMedia,
  restartAudioService,
  openSystemSettings,
  checkSystemPermission,
  pasteAsText,
  probeRemoteEditors,
  revealWindow,
  closeWindow,
  pickFolder,
  toLocalBackendPath,
  pickProjectFavicon,
  pickThemeFiles,
  setMenuState,
  setTheme,
  setWindowBackground,
  syncHtmlFullscreen,
  showContextMenu,
} from "./methods/window.ts";
import {
  acknowledgeSnapShot,
  checkSnapShotShortcut,
  dismissSnapShotAnimation,
  getSnapShotState,
  setupSnapShot,
  previewSnapShotConfig,
  applySnapShotConfig,
  listPendingSnapShots,
  readSnapShot,
  requestSnapShotPermissions,
  setSnapShotAnimationDestination,
  setSnapShotShortcutSuppressed,
} from "./methods/snapShot.ts";
import * as PreviewIpc from "./methods/preview.ts";
import * as WebLinksIpc from "./methods/webLinks.ts";
import {
  completeLegacyLocalStorage,
  takeLegacyLocalStorage,
} from "./methods/legacyLocalStorage.ts";
import { getWslState, setWslBackendEnabled, setWslDistro, setWslOnly } from "./methods/wsl.ts";

export const installDesktopIpcHandlers = Effect.fn("desktop.ipc.installHandlers")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* installNotificationBadge();
  yield* installDesktopNotifications();
  yield* installLowPowerState();
  yield* PreviewIpc.installPreviewEventForwarding();

  yield* ipc.handle(WebLinksIpc.setReady);

  yield* ipc.handleSync(takeLegacyLocalStorage);
  yield* ipc.handle(completeLegacyLocalStorage);
  yield* ipc.handleSync(getAppBranding);
  yield* ipc.handleSync(getSystemLocale);
  yield* ipc.handleSync(getPreferredSystemLanguages);
  yield* ipc.handleSync(getPrimaryPasteEnabled);
  yield* ipc.handleSync(getWindowFullscreenState);
  yield* ipc.handleSync(getLocalEnvironmentBootstraps);
  yield* ipc.handleSync(getLocalEnvironmentEnabled);
  yield* ipc.handle(setLocalEnvironmentEnabled);
  yield* ipc.handle(getHostEnvironmentId);
  yield* ipc.handle(getLocalEnvironmentBearerToken);

  yield* ipc.handle(startFileDrag);
  yield* ipc.handle(restartAudioService);
  yield* ipc.handle(getClientSettings);
  yield* ipc.handle(setClientSettings);
  yield* ipc.handle(getConnectionCatalog);
  yield* ipc.handle(getSnapShotState);
  yield* ipc.handle(setupSnapShot);
  yield* ipc.handle(previewSnapShotConfig);
  yield* ipc.handle(applySnapShotConfig);
  yield* ipc.handle(requestSnapShotPermissions);
  yield* ipc.handle(checkSnapShotShortcut);
  yield* ipc.handle(setSnapShotShortcutSuppressed);
  yield* ipc.handle(listPendingSnapShots);
  yield* ipc.handle(readSnapShot);
  yield* ipc.handle(setSnapShotAnimationDestination);
  yield* ipc.handle(dismissSnapShotAnimation);
  yield* ipc.handle(acknowledgeSnapShot);
  yield* ipc.handle(setConnectionCatalog);

  yield* ipc.handle(discoverSshHosts);
  yield* ipc.handle(resolveSshHost);
  yield* ipc.handle(ensureSshEnvironment);
  yield* ipc.handle(disconnectSshEnvironment);
  yield* ipc.handle(fetchSshEnvironmentDescriptor);
  yield* ipc.handle(bootstrapSshBearerSession);
  yield* ipc.handle(fetchSshSessionState);
  yield* ipc.handle(resolveSshPasswordPrompt);

  yield* ipc.handle(getServerExposureState);
  yield* ipc.handle(setServerExposureMode);
  yield* ipc.handle(setTailscaleServeEnabled);
  yield* ipc.handle(getAdvertisedEndpoints);

  yield* ipc.handle(getWslState);
  yield* ipc.handle(setWslBackendEnabled);
  yield* ipc.handle(setWslDistro);
  yield* ipc.handle(setWslOnly);

  yield* ipc.handle(pickFolder);
  yield* ipc.handle(toLocalBackendPath);
  yield* ipc.handle(pickProjectFavicon);
  yield* ipc.handle(pickThemeFiles);
  yield* ipc.handle(setTheme);
  yield* ipc.handle(setWindowBackground);
  yield* ipc.handle(showContextMenu);
  yield* ipc.handle(setMenuState);
  yield* ipc.handle(openExternal);
  yield* ipc.handle(readMedia);
  yield* ipc.handle(receiveProviderAuthCallback);
  yield* ipc.handle(cancelProviderAuthCallback);
  yield* ipc.handle(openSystemSettings);
  yield* ipc.handle(checkSystemPermission);
  yield* ipc.handle(appleSpeechAvailable);
  yield* ipc.handle(appleSpeechPrepare);
  yield* ipc.handle(appleSpeechTranscribe);
  yield* ipc.handle(pasteAsText);
  yield* ipc.handle(revealWindow);
  yield* ipc.handle(closeWindow);
  yield* ipc.handle(syncHtmlFullscreen);
  yield* ipc.handle(probeRemoteEditors);
  yield* ipc.handle(getUpdateState);
  yield* ipc.handle(setUpdateChannel);
  yield* ipc.handle(downloadUpdate);
  yield* ipc.handle(installUpdate);
  yield* ipc.handle(checkForUpdate);
  for (const previewMethod of PreviewIpc.methods) {
    // Explicit types preserve the error/service union of these heterogeneous preview methods.
    yield* ipc.handle<
      Effect.Error<ReturnType<(typeof PreviewIpc.methods)[number]["handler"]>>,
      Effect.Services<ReturnType<(typeof PreviewIpc.methods)[number]["handler"]>>
    >(previewMethod);
  }
  yield* ipc.handle(PreviewIpc.listBrowserImportSources);
  yield* ipc.handle(PreviewIpc.importBrowserCookies);
});
