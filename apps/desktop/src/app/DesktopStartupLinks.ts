// @effect-diagnostics nodeBuiltinImport:off -- Reads user-opened .ankielpair files with fstat and a hard byte cap; pre-ready FileSystem only implements a synchronous subset.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { providerAuthReturnUrl } from "@ankielcode/shared/providerAuthReturnUrl";
import {
  PAIRING_HANDOFF_ACTIVITY_TYPE,
  PAIRING_INVITE_MAX_FILE_BYTES,
  buildPairingInviteAppLink,
  decodePairingInviteFile,
  isPairingInviteFilePath,
  parsePairingInviteUserInfo,
  readPairingAppLink,
  readPairingInviteAppLink,
  readThreadAppLink,
} from "@ankielcode/shared/remote";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUserData from "./DesktopUserData.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

class PairingInviteFileReadError extends Schema.TaggedError<PairingInviteFileReadError>()(
  "PairingInviteFileReadError",
  {
    operation: Schema.Literals(["stat", "open", "read"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} pairing invite file at ${this.filePath}.`;
  }
}

const readPairingInviteFile = Effect.fn("desktop.startupLinks.readPairingInviteFile")(function* (
  filePath: string,
) {
  const preStat = yield* Effect.tryPromise({
    try: () => NodeFSP.stat(filePath),
    catch: (cause) => new PairingInviteFileReadError({ operation: "stat", filePath, cause }),
  });
  if (!preStat.isFile()) return { status: "not-regular-file" } as const;
  if (preStat.size > PAIRING_INVITE_MAX_FILE_BYTES) {
    return { status: "too-large", size: preStat.size } as const;
  }

  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        NodeFSP.open(filePath, NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0)),
      catch: (cause) => new PairingInviteFileReadError({ operation: "open", filePath, cause }),
    }),
    (handle) =>
      Effect.gen(function* () {
        const info = yield* Effect.tryPromise({
          try: () => handle.stat(),
          catch: (cause) => new PairingInviteFileReadError({ operation: "stat", filePath, cause }),
        });
        if (!info.isFile()) return { status: "not-regular-file" } as const;
        if (info.size > PAIRING_INVITE_MAX_FILE_BYTES) {
          return { status: "too-large", size: info.size } as const;
        }

        const buffer = Buffer.allocUnsafe(PAIRING_INVITE_MAX_FILE_BYTES + 1);
        let totalBytes = 0;
        while (totalBytes < buffer.length) {
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, totalBytes, buffer.length - totalBytes, null),
            catch: (cause) =>
              new PairingInviteFileReadError({ operation: "read", filePath, cause }),
          });
          if (bytesRead === 0) break;
          totalBytes += bytesRead;
        }
        if (totalBytes > PAIRING_INVITE_MAX_FILE_BYTES) {
          return { status: "too-large", size: totalBytes } as const;
        }

        const invite = decodePairingInviteFile(buffer.toString("utf8", 0, totalBytes));
        return invite === null
          ? ({ status: "invalid-payload" } as const)
          : ({ status: "ok", invite } as const);
      }),
    (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
  );
});

export class DesktopStartupLinks extends Context.Service<
  DesktopStartupLinks,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      | ElectronApp.ElectronApp
      | ElectronWindow.ElectronWindow
      | DesktopWebLinks.DesktopWebLinks
      | Scope.Scope
    >;
  }
>()("@ankielcode/desktop/app/DesktopStartupLinks") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;

  // Must not yield: userData and the single-instance lock settle before Electron emits ready.
  const userDataPath = yield* DesktopUserData.resolveUserDataPath(environment);
  yield* electronApp.setPath("userData", userDataPath);

  // Interrupt before runtime construction because quit is asynchronous.
  if (!(yield* electronApp.requestSingleInstanceLock)) {
    yield* electronApp.quit;
    return yield* Effect.interrupt;
  }
  // Chromium opens these caches at the first event-loop turn, before ready.
  yield* DesktopUserData.clearStaleGpuCaches({
    userDataPath,
    electronVersion: process.versions.electron,
  });

  const pendingSecondInstances: Array<readonly string[]> = [];
  let handleSecondInstance = (argv: readonly string[]) => {
    pendingSecondInstances.push(argv);
  };
  yield* electronApp.on("second-instance", (_event: unknown, argv: readonly string[]) => {
    handleSecondInstance(argv);
  });
  // macOS hands launch links, files, and Handoff activities before configure runs.
  const pendingOpenUrls: Array<string> = [];
  let handleOpenUrl = (url: string) => {
    pendingOpenUrls.push(url);
    return true;
  };
  yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: string) => {
    if (handleOpenUrl(url)) event.preventDefault();
  });

  const pendingOpenFiles: Array<string> = [];
  let handleOpenFile = (filePath: string) => {
    if (!DesktopWebLinks.isWebPageFile(filePath) && !isPairingInviteFilePath(filePath)) {
      return false;
    }
    pendingOpenFiles.push(filePath);
    return true;
  };
  yield* electronApp.on("open-file", (event: { preventDefault: () => void }, filePath: string) => {
    if (handleOpenFile(filePath)) event.preventDefault();
  });

  yield* electronApp.on(
    "will-continue-activity",
    (event: { preventDefault: () => void }, type: string) => {
      if (type === PAIRING_HANDOFF_ACTIVITY_TYPE) event.preventDefault();
    },
  );

  const pendingContinueActivities: Array<{ readonly type: string; readonly userInfo: unknown }> =
    [];
  let handleContinueActivity = (type: string, userInfo: unknown) => {
    if (type !== PAIRING_HANDOFF_ACTIVITY_TYPE) return false;
    pendingContinueActivities.push({ type, userInfo });
    return parsePairingInviteUserInfo(userInfo) !== null;
  };
  yield* electronApp.on(
    "continue-activity",
    (event: { preventDefault: () => void }, type: string, userInfo: unknown) => {
      if (handleContinueActivity(type, userInfo)) event.preventDefault();
    },
  );

  return DesktopStartupLinks.of({
    configure: Effect.gen(function* () {
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);

      const resumeProviderAuth = (value: string | undefined) => {
        const destination = providerAuthReturnUrl(value);
        const expectedOrigin = `${ElectronProtocol.getDesktopScheme(environment.isDevelopment)}://app`;
        if (!destination?.startsWith(`${expectedOrigin}/`)) return false;
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isNone(mainWindow)) return;
            yield* Effect.promise(() => mainWindow.value.loadURL(destination));
            yield* electronWindow.reveal(mainWindow.value);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not return to provider setup", cause),
            ),
          ),
        );
        return true;
      };
      const openAppLink = (value: string | undefined) => {
        if (
          !value ||
          (readPairingAppLink(value) === null &&
            readThreadAppLink(value) === null &&
            readPairingInviteAppLink(value) === null)
        ) {
          return false;
        }
        void runPromise(webLinks.receive(value));
        return true;
      };
      const openPairingInviteFile = Effect.fn("desktop.startupLinks.openPairingInviteFile")(
        function* (filePath: string) {
          const result = yield* readPairingInviteFile(filePath).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not read pairing invite file", {
                filePath,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
          if (result === null) return;
          if (result.status !== "ok") {
            yield* Effect.logWarning("Ignoring invalid pairing invite file", {
              filePath,
              reason: result.status,
              ...("size" in result ? { size: result.size } : {}),
            });
            return;
          }
          yield* webLinks.receive(buildPairingInviteAppLink(result.invite));
        },
      );
      const openPairingInviteArg = (value: string | undefined) => {
        if (!value || !isPairingInviteFilePath(value)) return false;
        void runPromise(openPairingInviteFile(value));
        return true;
      };

      const args = yield* HostProcess.Arguments;
      args.some((value) => openAppLink(value) || openPairingInviteArg(value));

      const openWebLink = (url: string) => {
        if (!DesktopWebLinks.isWebLink(url)) return false;
        void runPromise(webLinks.receive(url));
        return true;
      };
      handleOpenUrl = (url) => resumeProviderAuth(url) || openWebLink(url) || openAppLink(url);
      for (const url of pendingOpenUrls.splice(0)) handleOpenUrl(url);

      handleOpenFile = (filePath) => {
        if (DesktopWebLinks.isWebPageFile(filePath)) {
          void runPromise(webLinks.receive(NodeURL.pathToFileURL(filePath).href));
          return true;
        }
        if (isPairingInviteFilePath(filePath)) {
          void runPromise(openPairingInviteFile(filePath));
          return true;
        }
        return false;
      };
      for (const filePath of pendingOpenFiles.splice(0)) handleOpenFile(filePath);

      handleContinueActivity = (type, userInfo) => {
        if (type !== PAIRING_HANDOFF_ACTIVITY_TYPE) return false;
        const invite = parsePairingInviteUserInfo(userInfo);
        if (invite === null) {
          void runPromise(Effect.logWarning("Ignoring invalid pairing Handoff activity payload"));
          return false;
        }
        void runPromise(webLinks.receive(buildPairingInviteAppLink(invite)));
        return true;
      };
      for (const activity of pendingContinueActivities.splice(0)) {
        handleContinueActivity(activity.type, activity.userInfo);
      }

      handleSecondInstance = (argv) => {
        if (
          argv?.some(
            (value) =>
              resumeProviderAuth(value) || openAppLink(value) || openPairingInviteArg(value),
          )
        ) {
          return;
        }
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) yield* electronWindow.reveal(mainWindow.value);
          }),
        );
      };
      for (const argv of pendingSecondInstances.splice(0)) handleSecondInstance(argv);
    }).pipe(Effect.withSpan("desktop.startupLinks.configure")),
  });
});

export const layer = Layer.effect(DesktopStartupLinks, make);
