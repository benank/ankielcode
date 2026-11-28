// @effect-diagnostics nodeBuiltinImport:off - tests inject swaps at the native open boundary.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeFSP from "node:fs/promises";
import {
  AssetAccessError,
  AssetPreviewTypeValidationError,
  SOURCE_CONTROL_MEDIA_ASSET,
  ThreadId,
  TurnItemId,
} from "@ankielcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { HttpServerResponse } from "effect/http";
import { vi } from "vite-plus/test";

import * as AssetSigner from "./AssetSigner.ts";
import * as WorkspacePreviewRevisions from "./WorkspacePreviewRevisions.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as AnkielProjectFileLoader from "../project/AnkielProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { assetFileResponse } from "../http.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import { symlinksSupported } from "@ankielcode/shared/testing/symlinks";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "ankiel-asset-access-test-",
});
const screenshotPng = new Uint8Array(24);
screenshotPng.set([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
new DataView(screenshotPng.buffer).setUint32(16, 390);
new DataView(screenshotPng.buffer).setUint32(20, 844);
const screenshotItem = {
  id: TurnItemId.make("tool-screenshot"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "mcp__ankiel-code__device_screenshot",
  input: { deviceId: "phone" },
  output: {
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from(screenshotPng).toString("base64"),
        },
      },
    ],
  },
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};

const oversizedScreenshotItem = {
  ...screenshotItem,
  id: TurnItemId.make("tool-screenshot-oversized"),
  output: {
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(14 * 1024 * 1024) },
      },
    ],
  },
};

const layerTest = Layer.mergeAll(
  NodeHttpPlatform.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({
    getTurnItem: ({ itemId }) =>
      Effect.succeed(
        itemId === screenshotItem.id
          ? screenshotItem
          : itemId === oversizedScreenshotItem.id
            ? oversizedScreenshotItem
            : null,
      ),
  }),
  layerConfig,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(AnkielProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(layerConfig)),
  AssetSigner.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer.pipe(Layer.provide(layerConfig))),
  ),
  WorkspacePreviewRevisions.layer,
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("AssetAccess", () => {
  it.effect(
    "rejects draft media escapes and disallowed types without enabling non-draft media",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-draft-boundary-" });
        const root = path.join(directory, "workspace");
        yield* fs.makeDirectory(root);
        for (const name of ["video.mp4", "audio.wav", "secret.txt"]) {
          yield* fs.writeFileString(path.join(root, name), "workspace bytes");
          yield* fs.writeFileString(path.join(directory, name), "outside bytes");
        }
        for (const [requestedPath, tag] of [
          ["../video.mp4", "AssetWorkspacePathValidationError"],
          ["../audio.wav", "AssetWorkspacePathValidationError"],
          ["secret.txt", "AssetPreviewTypeValidationError"],
        ] as const) {
          const error = yield* issueAssetUrl({
            resource: { _tag: "draft-workspace-file", cwd: root, path: requestedPath },
            workspaceRoot: root,
          }).pipe(Effect.flip);
          expect(error._tag).toBe(tag);
        }
        for (const name of ["video.mp4", "audio.wav"]) {
          const error = yield* issueAssetUrl({
            resource: { _tag: "workspace-file", threadId: ThreadId.make("thread-1"), path: name },
            workspaceRoot: root,
          }).pipe(Effect.flip);
          expect(error._tag).toBe("AssetPreviewTypeValidationError");
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects draft media symlinks escaping the workspace or targeting disallowed types",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-draft-symlink-" });
        const root = path.join(directory, "workspace");
        yield* fs.makeDirectory(root);
        const outside = path.join(directory, "outside.mp4");
        const secret = path.join(root, "secret.txt");
        yield* fs.writeFileString(outside, "outside bytes");
        yield* fs.writeFileString(secret, "private bytes");
        for (const [name, target] of [
          ["escape.mp4", outside],
          ["disguised.wav", secret],
        ] as const) {
          yield* fs.symlink(target, path.join(root, name));
          const error = yield* issueAssetUrl({
            resource: { _tag: "draft-workspace-file", cwd: root, path: name },
            workspaceRoot: root,
          }).pipe(Effect.flip);
          expect(["AssetWorkspaceAssetNotFoundError", "AssetPreviewTypeValidationError"]).toContain(
            error._tag,
          );
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a draft media path swapped after workspace containment validation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-draft-swap-" });
        const root = path.join(directory, "workspace");
        yield* fs.makeDirectory(root);
        const filePath = path.join(root, "video.mp4");
        const outside = path.join(directory, "outside.mp4");
        yield* fs.writeFileString(filePath, "workspace video");
        yield* fs.writeFileString(outside, "outside video");
        const canonicalFile = yield* fs.realPath(filePath);
        let swapped = false;
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          stat: Effect.fn(function* (requestedPath) {
            const info = yield* fs.stat(requestedPath);
            if (requestedPath === canonicalFile && !swapped) {
              swapped = true;
              yield* fs.remove(filePath);
              yield* fs.symlink(outside, filePath);
            }
            return info;
          }),
        });
        const result = yield* issueAssetUrl({
          resource: { _tag: "draft-workspace-file", cwd: root, path: "video.mp4" },
          workspaceRoot: root,
        }).pipe(Effect.result, Effect.provideService(FileSystem.FileSystem, swappingFileSystem));
        expect(swapped).toBe(true);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "AssetWorkspaceAssetNotFoundError" },
        });
      }).pipe(Effect.provide(layerTest)),
  );

  // Resolving `file://attacker.test/share/cat.jpg` from an agent's markdown sent the
  // Windows user's NTLM credentials to attacker.test.
  it.effect("never resolves a network media path outside the thread's project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolved: Array<string> = [];
      const recordingFileSystem = FileSystem.FileSystem.of({
        ...fs,
        realPath: (requestedPath) => {
          resolved.push(requestedPath);
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "realPath",
              pathOrDescriptor: requestedPath,
            }),
          );
        },
      });
      const share = "//nas.test/share/project";
      for (const resource of [
        {
          _tag: "media-file",
          threadId: ThreadId.make("thread-1"),
          path: "//attacker.test/s/a.png",
        },
        { _tag: "draft-workspace-file", cwd: share, path: "//attacker.test/s/a.png" },
        { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: `${share}/a.png` },
      ] as const) {
        const error = yield* issueAssetUrl({ resource, workspaceRoot: share }).pipe(
          Effect.provideService(FileSystem.FileSystem, recordingFileSystem),
          Effect.flip,
        );
        expect(error._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }
      expect(resolved).toEqual([path.resolve(`${share}/a.png`)]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects non-previewable files, disguised targets, and directories",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-media-validation-" });
        for (const name of ["report.md", "secret.txt", "secret.%70ng", "secret.png#private.txt"]) {
          const filePath = path.join(root, name);
          yield* fs.writeFileString(filePath, "not media");
          const error = yield* issueAssetUrl({
            resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
          }).pipe(Effect.flip);
          expect(error).toBeInstanceOf(AssetPreviewTypeValidationError);
        }
        const disguisedPath = path.join(root, "disguised.png");
        yield* fs.symlink(path.join(root, "secret.txt"), disguisedPath);
        const disguisedError = yield* issueAssetUrl({
          resource: {
            _tag: "media-file",
            threadId: ThreadId.make("thread-1"),
            path: disguisedPath,
          },
        }).pipe(Effect.flip);
        expect(disguisedError).toBeInstanceOf(AssetPreviewTypeValidationError);
        const directoryPath = path.join(root, "directory.png");
        yield* fs.makeDirectory(directoryPath);
        const directoryError = yield* issueAssetUrl({
          resource: {
            _tag: "media-file",
            threadId: ThreadId.make("thread-1"),
            path: directoryPath,
          },
        }).pipe(Effect.flip);
        expect(directoryError._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)("does not issue URLs for server state files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const stateFile = path.join(config.secretsDir, "example.bin");
      yield* fs.makeDirectory(config.secretsDir, { recursive: true });
      yield* fs.writeFile(stateFile, new Uint8Array(32).fill(7));
      yield* fs.writeFileString(config.dbPath, "SQLite format 3");
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-media-state-" });
      const alias = path.join(root, "alias");
      yield* fs.symlink(stateFile, alias);
      const threadId = ThreadId.make("thread-1");
      for (const resource of [
        { _tag: "media-file", threadId, path: stateFile, disposition: "attachment" },
        { _tag: "media-file", threadId, path: alias, disposition: "attachment" },
        {
          _tag: "media-file",
          threadId,
          path: path.join(config.secretsDir, "..", "secrets", "example.bin"),
          disposition: "attachment",
        },
        { _tag: "media-file", threadId, path: config.dbPath },
        { _tag: "draft-workspace-file", cwd: config.stateDir, path: "statev2.sqlite" },
        {
          _tag: "draft-workspace-file",
          cwd: config.stateDir,
          path: "statev2.sqlite",
          disposition: "attachment",
        },
      ] as const) {
        const error = yield* issueAssetUrl({ resource }).pipe(Effect.flip);
        expect(error._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }

      const icon = path.join(config.baseDir, "icon.png");
      yield* fs.symlink(stateFile, icon);
      yield* fs.writeFileString(path.join(config.baseDir, "page.html"), '<img src="icon.png">');
      const page = yield* issueAssetUrl({
        resource: { _tag: "draft-workspace-file", cwd: config.baseDir, path: "page.html" },
      });
      const pageToken = page.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length).split("/")[0]!;
      expect(yield* resolveAsset(pageToken, "icon.png")).toBeNull();
      const faviconError = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
        projectFaviconPath: icon,
      }).pipe(Effect.flip);
      expect(faviconError._tag).toBe("AssetProjectFaviconNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "binds media URLs to the canonical target and rejects symlink substitution",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-media-symlink-" });
        const filePath = path.join(root, "actual.svg");
        const aliasPath = path.join(root, "alias.png");
        const replacementPath = path.join(root, "other.svg");
        yield* fs.writeFileString(filePath, "<svg/>");
        yield* fs.writeFileString(replacementPath, "<svg>private</svg>");
        yield* fs.symlink(filePath, aliasPath);
        const canonicalFile = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: aliasPath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        const name = suffix.slice(separator + 1);
        const expected = { kind: "file", path: canonicalFile, mimeType: "image/svg+xml" };
        expect(yield* resolveAsset(token, name)).toMatchObject(expected);
        yield* fs.remove(aliasPath);
        yield* fs.symlink(replacementPath, aliasPath);
        expect(yield* resolveAsset(token, name)).toMatchObject(expected);
        yield* fs.remove(filePath);
        yield* fs.symlink(replacementPath, filePath);
        expect(yield* resolveAsset(token, name)).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a symlink swapped in after canonical validation but before open",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-media-open-race-" });
        const filePath = path.join(root, "recording.mp4");
        const secretPath = path.join(root, "secret.txt");
        yield* fs.writeFileString(filePath, "video");
        yield* fs.writeFileString(secretPath, "secret");
        const canonicalPath = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          stat: Effect.fn(function* (requestedPath) {
            const info = yield* fs.stat(requestedPath);
            if (requestedPath === canonicalPath) {
              yield* fs.remove(filePath);
              yield* fs.symlink(secretPath, filePath);
            }
            return info;
          }),
        });
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)).pipe(
            Effect.provideService(FileSystem.FileSystem, swappingFileSystem),
          ),
        ).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects an ancestor symlink race even when canonical path rechecks would pass",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-media-parent-race-" });
        const publicDirectory = path.join(root, "public");
        const privateDirectory = path.join(root, "private");
        yield* fs.makeDirectory(publicDirectory);
        yield* fs.makeDirectory(privateDirectory);
        const filePath = path.join(publicDirectory, "recording.mp4");
        yield* fs.writeFileString(filePath, "public video");
        yield* fs.writeFileString(path.join(privateDirectory, "recording.mp4"), "private video");
        const canonicalPath = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const native = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        const savedDirectory = path.join(root, "saved");
        const realpathSpy = vi.mocked(NodeFSP.realpath).mockImplementationOnce(async () => {
          await native.unlink(publicDirectory);
          await native.rename(savedDirectory, publicDirectory);
          const canonical = await native.realpath(canonicalPath);
          await native.rename(publicDirectory, savedDirectory);
          await native.symlink(privateDirectory, publicDirectory, "junction");
          return canonical;
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => realpathSpy.mockReset().mockImplementation(native.realpath)),
        );
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          realPath: Effect.fn(function* (requestedPath) {
            const canonical = yield* fs.realPath(requestedPath);
            if (requestedPath === canonicalPath) {
              yield* fs.rename(publicDirectory, savedDirectory);
              yield* Effect.promise(() =>
                NodeFSP.symlink(privateDirectory, publicDirectory, "junction"),
              );
            }
            return canonical;
          }),
        });
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)).pipe(
            Effect.provideService(FileSystem.FileSystem, swappingFileSystem),
          ),
        ).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps in-place edits readable but requires a new URL after atomic replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-media-replacement-" });
      const filePath = path.join(root, "recording.mp4");
      yield* fs.writeFileString(filePath, "original");
      const input = {
        resource: {
          _tag: "media-file" as const,
          threadId: ThreadId.make("thread-1"),
          path: filePath,
        },
      };
      const original = yield* issueAssetUrl(input);
      const suffix = original.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const token = suffix.slice(0, separator);
      const name = suffix.slice(separator + 1);
      yield* fs.writeFileString(filePath, "in-place edit");
      const edited = yield* resolveAsset(token, name);
      if (edited?.kind !== "file") throw new Error("Expected the edited media file");
      const editedResponse = HttpServerResponse.toWeb(yield* assetFileResponse(edited));
      expect(yield* Effect.promise(() => editedResponse.text())).toBe("in-place edit");

      const replacement = path.join(root, "replacement.mp4");
      yield* fs.writeFileString(replacement, "replacement");
      yield* fs.rename(replacement, filePath);
      expect(yield* resolveAsset(token, name)).toBeNull();

      const renewed = yield* issueAssetUrl(input);
      const renewedSuffix = renewed.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const renewedSeparator = renewedSuffix.indexOf("/");
      const renewedAsset = yield* resolveAsset(
        renewedSuffix.slice(0, renewedSeparator),
        renewedSuffix.slice(renewedSeparator + 1),
      );
      if (renewedAsset?.kind !== "file") throw new Error("Expected the replacement media file");
      const renewedResponse = HttpServerResponse.toWeb(yield* assetFileResponse(renewedAsset));
      expect(yield* Effect.promise(() => renewedResponse.text())).toBe("replacement");
      yield* fs.remove(filePath);
      expect(
        yield* resolveAsset(
          renewedSuffix.slice(0, renewedSeparator),
          renewedSuffix.slice(renewedSeparator + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects workspace files outside the authorized root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ankiel-asset-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ankiel-asset-outside-",
      });
      const htmlPath = path.join(outside, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>outside</p>");

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error.message).toBe("Workspace file path must be relative to the project root.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspacePathValidationError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)("refuses a favicon link whose target is not an image", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-asset-favicon-link-" }),
      );
      const pictures = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-asset-favicon-link-pictures-" }),
      );
      yield* fs.writeFileString(path.join(root, "page.xhtml"), "<html/>");
      yield* fs.writeFileString(path.join(root, "real.svg"), "<svg/>");
      const resolveIssued = (relativeUrl: string) => {
        const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        return resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
      };
      for (const link of [path.join(root, "favicon.svg"), path.join(pictures, "custom.svg")]) {
        const issue = issueAssetUrl({
          resource: { _tag: "project-favicon", cwd: root },
          ...(link.startsWith(pictures) ? { projectFaviconPath: link } : {}),
        });

        yield* fs.symlink(path.join(root, "page.xhtml"), link);
        expect((yield* issue.pipe(Effect.flip))._tag).toBe("AssetPreviewTypeValidationError");

        yield* fs.remove(link);
        yield* fs.symlink(path.join(root, "real.svg"), link);
        const issued = yield* issue;
        expect(yield* resolveIssued(issued.relativeUrl)).toEqual({
          kind: "file",
          path: path.join(root, "real.svg"),
        });

        yield* fs.remove(link);
        yield* fs.symlink(path.join(root, "page.xhtml"), link);
        // An outside icon's URL names its target, so repointing the link cannot change it.
        expect(yield* resolveIssued(issued.relativeUrl)).toEqual(
          link.startsWith(pictures) ? { kind: "file", path: path.join(root, "real.svg") } : null,
        );
        yield* fs.remove(link);
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("ignores a client favicon path hint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ankiel-asset-favicon-hint-",
      });
      yield* fileSystem.makeDirectory(path.join(root, "brand"));
      yield* fileSystem.writeFileString(path.join(root, "brand", "hint.svg"), "<svg>hint</svg>");
      yield* fileSystem.writeFileString(path.join(root, "brand", "saved.svg"), "<svg>saved</svg>");

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root, path: "brand/hint.svg" },
        projectFaviconPath: "brand/saved.svg",
      });

      expect(result.sourcePath).toBe(path.join("brand", "saved.svg"));
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-saved\.svg$/);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("refuses media no host keeps behind a credential, without echoing the URL", () =>
    Effect.gen(function* () {
      const encodeAssetAccessError = Schema.encodeEffect(Schema.fromJsonString(AssetAccessError));

      for (const url of [
        "https://example.com/shot.png",
        "https://example.com/shot.png?token=private-media-token",
      ]) {
        const error = yield* issueAssetUrl({
          resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: "/repo", url },
        }).pipe(Effect.flip);
        expect(error._tag).toBe("AssetGitHubMediaUrlValidationError");
        const encoded = yield* encodeAssetAccessError(error);
        expect(encoded).not.toContain(url);
      }
    }).pipe(Effect.provide(layerTest)),
  );
});
