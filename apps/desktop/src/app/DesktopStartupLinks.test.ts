import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import {
  PAIRING_HANDOFF_ACTIVITY_TYPE,
  PAIRING_INVITE_MAX_FILE_BYTES,
  buildPairingAppLink,
  buildPairingInviteAppLink,
  buildThreadAppLink,
  encodePairingInviteFile,
  readPairingInviteAppLink,
  toPairingInviteUserInfo,
  type PairingInvitePayload,
} from "@ankielcode/shared/remote";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopStartupLinks from "./DesktopStartupLinks.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";

const sampleInvite: PairingInvitePayload = {
  version: 1,
  inviteId: "inv_test123",
  environmentId: "env_local_1",
  baseUrl: "https://relay.example.com/h/abcdefghijklmnopqrstuvwxyz/",
  label: "MacBook Pro",
  expiresAt: "2026-12-01T00:00:00.000Z",
};

const sampleInviteLink = buildPairingInviteAppLink(sampleInvite);

interface StartupLinksHarness {
  readonly baseDir: string;
  readonly emit: (eventName: string, ...args: Array<unknown>) => void;
  readonly makeEvent: () => {
    readonly preventDefault: () => void;
    readonly defaultPrevented: boolean;
  };
  readonly receivedQueue: Queue.Queue<string>;
  readonly warningQueue: Queue.Queue<string>;
}

const withStartupLinksHarness = <A, E, R>(
  use: (
    harness: StartupLinksHarness,
  ) => Effect.Effect<
    A,
    E,
    | R
    | DesktopStartupLinks.DesktopStartupLinks
    | ElectronApp.ElectronApp
    | ElectronWindow.ElectronWindow
    | DesktopWebLinks.DesktopWebLinks
  >,
  args: readonly string[] = ["electron"],
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "ankiel-desktop-startup-links-test-",
    });
    const receivedQueue = yield* Queue.unbounded<string>();
    const warningQueue = yield* Queue.unbounded<string>();
    const listeners = new Map<string, Array<(...args: Array<unknown>) => void>>();

    const emit = (eventName: string, ...eventArgs: Array<unknown>) => {
      for (const listener of listeners.get(eventName) ?? []) {
        listener(...eventArgs);
      }
    };

    const makeEvent = () => {
      let defaultPrevented = false;
      return {
        preventDefault: () => {
          defaultPrevented = true;
        },
        get defaultPrevented() {
          return defaultPrevented;
        },
      };
    };

    const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
      metadata: Effect.die("unused metadata"),
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
      on: (eventName, listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const registered = listeners.get(eventName) ?? [];
            registered.push(listener as unknown as (...args: Array<unknown>) => void);
            listeners.set(eventName, registered);
          }),
          () =>
            Effect.sync(() => {
              const registered = listeners.get(eventName);
              if (!registered) return;
              const index = registered.indexOf(
                listener as unknown as (...args: Array<unknown>) => void,
              );
              if (index >= 0) registered.splice(index, 1);
            }),
        ).pipe(Effect.asVoid),
    } satisfies ElectronApp.ElectronApp["Service"]);

    const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
      create: () => Effect.die("unused create"),
      main: Effect.succeedNone,
      currentMainOrFirst: Effect.succeedNone,
      focusedMainOrFirst: Effect.succeedNone,
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      prepareReveal: () => Effect.succeed(true),
      reveal: () => Effect.void,
      sendAll: () => Effect.void,
      destroyAll: Effect.void,
      syncAllAppearance: () => Effect.void,
    } satisfies ElectronWindow.ElectronWindow["Service"]);

    const webLinksLayer = Layer.succeed(DesktopWebLinks.DesktopWebLinks, {
      receive: (url) => Queue.offer(receivedQueue, url).pipe(Effect.asVoid),
      setRendererReady: () => Effect.void,
    } satisfies DesktopWebLinks.DesktopWebLinks["Service"]);

    const loggerLayer = Logger.layer(
      [
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") {
            Queue.offerUnsafe(
              warningQueue,
              Array.isArray(message) ? message.map(String).join(" ") : String(message),
            );
          }
        }),
      ],
      { mergeWithExisting: false },
    );

    const environmentLayer = DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/src",
      homeDirectory: baseDir,
      platform: "darwin",
      processArch: "arm64",
      appVersion: "1.2.3",
      appPath: "/repo",
      isPackaged: false,
      resourcesPath: "/missing/resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ ANKIEL_HOME: baseDir })),
      ),
    );

    const startupLinksLayer = DesktopStartupLinks.layer.pipe(
      Layer.provide(DesktopPreReadyFileSystem.layer),
      Layer.provideMerge(environmentLayer),
      Layer.provideMerge(electronAppLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtimeLayer = Layer.mergeAll(
      startupLinksLayer,
      electronAppLayer,
      electronWindowLayer,
      webLinksLayer,
      loggerLayer,
      Layer.succeed(HostProcess.Arguments, args),
    );

    return yield* use({
      baseDir,
      emit,
      makeEvent,
      receivedQueue,
      warningQueue,
    }).pipe(Effect.provide(runtimeLayer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopStartupLinks", () => {
  it.effect(
    "buffers cold continue-activity events before configure and handles warm Handoff invites",
    () =>
      withStartupLinksHarness((harness) =>
        Effect.gen(function* () {
          const startupLinks = yield* DesktopStartupLinks.DesktopStartupLinks;
          const userInfo = toPairingInviteUserInfo(sampleInvite);

          const coldWillContinuePairingEvent = harness.makeEvent();
          harness.emit(
            "will-continue-activity",
            coldWillContinuePairingEvent,
            PAIRING_HANDOFF_ACTIVITY_TYPE,
          );
          assert.isTrue(coldWillContinuePairingEvent.defaultPrevented);

          const coldWillContinueOtherEvent = harness.makeEvent();
          harness.emit(
            "will-continue-activity",
            coldWillContinueOtherEvent,
            "NSUserActivityTypeBrowsingWeb",
          );
          assert.isFalse(coldWillContinueOtherEvent.defaultPrevented);

          const coldValidEvent = harness.makeEvent();
          harness.emit(
            "continue-activity",
            coldValidEvent,
            PAIRING_HANDOFF_ACTIVITY_TYPE,
            userInfo,
          );
          assert.isTrue(coldValidEvent.defaultPrevented);

          const coldUnrelatedEvent = harness.makeEvent();
          harness.emit("continue-activity", coldUnrelatedEvent, "NSUserActivityTypeBrowsingWeb", {
            webpageURL: "https://example.com",
          });
          assert.isFalse(coldUnrelatedEvent.defaultPrevented);

          const coldInvalidEvent = harness.makeEvent();
          harness.emit("continue-activity", coldInvalidEvent, PAIRING_HANDOFF_ACTIVITY_TYPE, {
            version: "1",
            inviteId: "bad/id",
          });
          assert.isFalse(coldInvalidEvent.defaultPrevented);

          yield* startupLinks.configure;

          const coldLink = yield* Queue.take(harness.receivedQueue);
          assert.strictEqual(coldLink, sampleInviteLink);
          assert.deepStrictEqual(readPairingInviteAppLink(coldLink), sampleInvite);
          assert.strictEqual(
            yield* Queue.take(harness.warningQueue),
            "Ignoring invalid pairing Handoff activity payload",
          );

          const warmValidEvent = harness.makeEvent();
          harness.emit(
            "continue-activity",
            warmValidEvent,
            PAIRING_HANDOFF_ACTIVITY_TYPE,
            userInfo,
          );
          assert.isTrue(warmValidEvent.defaultPrevented);
          assert.strictEqual(yield* Queue.take(harness.receivedQueue), sampleInviteLink);

          const warmUnrelatedEvent = harness.makeEvent();
          harness.emit("continue-activity", warmUnrelatedEvent, "com.apple.other", userInfo);
          assert.isFalse(warmUnrelatedEvent.defaultPrevented);

          const warmInvalidEvent = harness.makeEvent();
          harness.emit("continue-activity", warmInvalidEvent, PAIRING_HANDOFF_ACTIVITY_TYPE, null);
          assert.isFalse(warmInvalidEvent.defaultPrevented);
          assert.strictEqual(
            yield* Queue.take(harness.warningQueue),
            "Ignoring invalid pairing Handoff activity payload",
          );

          assert.equal(yield* Queue.size(harness.receivedQueue), 0);
        }),
      ),
  );

  it.effect(
    "handles cold and warm open-file for .ankielpair and HTML files while rejecting invalid invite files",
    () =>
      withStartupLinksHarness((harness) =>
        Effect.gen(function* () {
          const startupLinks = yield* DesktopStartupLinks.DesktopStartupLinks;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const coldInvitePath = path.join(harness.baseDir, "cold-invite.ankielpair");
          const warmInvitePath = path.join(harness.baseDir, "warm-invite.ANKIELPAIR");
          const htmlPath = path.join(harness.baseDir, "preview.html");
          const oversizedPath = path.join(harness.baseDir, "oversized.ankielpair");
          const malformedPath = path.join(harness.baseDir, "malformed.ankielpair");
          const directoryPath = path.join(harness.baseDir, "folder.ankielpair");
          const missingPath = path.join(harness.baseDir, "missing.ankielpair");
          const secretMarker = "SECRET_INVITE_TOKEN_DO_NOT_LOG";

          yield* fs.writeFileString(coldInvitePath, encodePairingInviteFile(sampleInvite));
          yield* fs.writeFileString(warmInvitePath, encodePairingInviteFile(sampleInvite));
          yield* fs.writeFileString(htmlPath, "<html></html>");
          yield* fs.writeFileString(
            oversizedPath,
            `${encodePairingInviteFile(sampleInvite)}${" ".repeat(PAIRING_INVITE_MAX_FILE_BYTES)}`,
          );
          yield* fs.writeFileString(malformedPath, `{"secret":"${secretMarker}"`);
          yield* fs.makeDirectory(directoryPath);

          const coldInviteEvent = harness.makeEvent();
          harness.emit("open-file", coldInviteEvent, coldInvitePath);
          assert.isTrue(coldInviteEvent.defaultPrevented);

          const coldHtmlEvent = harness.makeEvent();
          harness.emit("open-file", coldHtmlEvent, htmlPath);
          assert.isTrue(coldHtmlEvent.defaultPrevented);

          const unrelatedFileEvent = harness.makeEvent();
          harness.emit("open-file", unrelatedFileEvent, path.join(harness.baseDir, "notes.txt"));
          assert.isFalse(unrelatedFileEvent.defaultPrevented);

          yield* startupLinks.configure;

          const coldReceived = yield* Queue.takeN(harness.receivedQueue, 2);
          assert.isTrue(coldReceived.includes(sampleInviteLink));
          assert.isTrue(
            coldReceived.some((url) => url.startsWith("file://") && url.endsWith("/preview.html")),
          );

          const warmInviteEvent = harness.makeEvent();
          harness.emit("open-file", warmInviteEvent, warmInvitePath);
          assert.isTrue(warmInviteEvent.defaultPrevented);
          assert.strictEqual(yield* Queue.take(harness.receivedQueue), sampleInviteLink);

          for (const badPath of [oversizedPath, malformedPath, directoryPath, missingPath]) {
            const event = harness.makeEvent();
            harness.emit("open-file", event, badPath);
            assert.isTrue(event.defaultPrevented);
            const warning = yield* Queue.take(harness.warningQueue);
            assert.notInclude(warning, secretMarker);
          }

          assert.equal(yield* Queue.size(harness.receivedQueue), 0);
        }),
      ),
  );

  it.effect(
    "forwards pair-invite, pair, thread links, and .ankielpair paths across args, open-url, and second-instance",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: "ankiel-desktop-startup-args-test-",
        });
        const argInvitePath = path.join(tempDir, "arg-invite.ankielpair");
        const secondInstanceInvitePath = path.join(tempDir, "second-instance.ankielpair");
        yield* fs.writeFileString(argInvitePath, encodePairingInviteFile(sampleInvite));
        yield* fs.writeFileString(secondInstanceInvitePath, encodePairingInviteFile(sampleInvite));

        const pairLink = buildPairingAppLink("https://remote.example.com/#token=abc");
        const threadLink = buildThreadAppLink({ environmentId: "env-1", threadId: "thread-1" });
        const devInviteLink = buildPairingInviteAppLink(sampleInvite, "ankielcode-dev");

        yield* withStartupLinksHarness(
          (harness) =>
            Effect.gen(function* () {
              const startupLinks = yield* DesktopStartupLinks.DesktopStartupLinks;

              const coldOpenUrlEvent = harness.makeEvent();
              harness.emit("open-url", coldOpenUrlEvent, sampleInviteLink);
              assert.isTrue(coldOpenUrlEvent.defaultPrevented);

              yield* startupLinks.configure;

              const coldLinks = yield* Queue.takeN(harness.receivedQueue, 2);
              assert.deepStrictEqual(
                new Set(coldLinks),
                new Set([devInviteLink, sampleInviteLink]),
              );

              const warmPairEvent = harness.makeEvent();
              harness.emit("open-url", warmPairEvent, pairLink);
              assert.isTrue(warmPairEvent.defaultPrevented);
              assert.strictEqual(yield* Queue.take(harness.receivedQueue), pairLink);

              const warmThreadEvent = harness.makeEvent();
              harness.emit("open-url", warmThreadEvent, threadLink);
              assert.isTrue(warmThreadEvent.defaultPrevented);
              assert.strictEqual(yield* Queue.take(harness.receivedQueue), threadLink);

              harness.emit("second-instance", {}, ["electron", sampleInviteLink]);
              assert.strictEqual(yield* Queue.take(harness.receivedQueue), sampleInviteLink);

              harness.emit("second-instance", {}, ["electron", secondInstanceInvitePath]);
              assert.strictEqual(yield* Queue.take(harness.receivedQueue), sampleInviteLink);

              assert.equal(yield* Queue.size(harness.receivedQueue), 0);
            }),
          ["electron", devInviteLink],
        );

        yield* withStartupLinksHarness(
          (harness) =>
            Effect.gen(function* () {
              const startupLinks = yield* DesktopStartupLinks.DesktopStartupLinks;
              yield* startupLinks.configure;
              assert.strictEqual(yield* Queue.take(harness.receivedQueue), sampleInviteLink);
              assert.equal(yield* Queue.size(harness.receivedQueue), 0);
            }),
          ["electron", argInvitePath],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
