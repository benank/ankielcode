import { afterEach, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@ankielcode/contracts";
import { vi } from "vite-plus/test";

const composerDraftFileMocks = vi.hoisted(() => {
  let document = JSON.stringify({ schemaVersion: 1, drafts: {} });
  let readError: Error | null = null;
  let writeError: Error | null = null;
  let releaseRead: (() => void) | null = null;
  let readBarrier = Promise.resolve();
  let nextWriteBarrier: Promise<void> | null = null;
  let onWrite: (() => void) | null = null;
  const writes: string[] = [];
  const readImage = vi.fn(async () => "YWJj");

  return {
    readImage,
    blockRead() {
      readBarrier = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    },
    releaseRead() {
      releaseRead?.();
      releaseRead = null;
    },
    getDocument() {
      return document;
    },
    setDocument(value: unknown) {
      document = JSON.stringify(value);
    },
    setReadError(error: Error | null) {
      readError = error;
    },
    setWriteError(error: Error | null) {
      writeError = error;
    },
    setNextWriteBarrier(barrier: Promise<void> | null) {
      nextWriteBarrier = barrier;
    },
    setOnWrite(callback: (() => void) | null) {
      onWrite = callback;
    },
    getWrites(): ReadonlyArray<string> {
      return writes;
    },
    resetWrites() {
      writes.length = 0;
    },
    Directory: class {
      create() {}

      list() {
        return [];
      }
    },
    File: class {
      exists = true;
      size = 3;
      parentDirectory = null;
      uri = "file:///documents/attachment.png";

      create() {}

      async copy() {}

      moveSync() {}

      async text() {
        await readBarrier;
        if (readError) throw readError;
        return document;
      }

      async base64() {
        return readImage();
      }

      write(value: string) {
        if (writeError) {
          throw writeError;
        }
        if (nextWriteBarrier) {
          const barrier = nextWriteBarrier;
          nextWriteBarrier = null;
          return barrier.then(() => {
            document = value;
            writes.push(value);
            onWrite?.();
          });
        }
        document = value;
        writes.push(value);
        onWrite?.();
      }
    },
  };
});

const composerAttachmentCleanupMocks = vi.hoisted(() => ({
  remove: vi.fn(async (_uri: string) => undefined),
  releaseUploads: vi.fn(async () => undefined),
}));

const pickMedia = vi.hoisted(() => vi.fn());
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: pickMedia }));

const incomingShareStorageMocks = vi.hoisted(() => ({
  load: vi.fn<typeof import("../features/sharing/incoming-share-storage").loadIncomingShareDrafts>(
    async () => [],
  ),
}));

vi.mock("expo-file-system", () => ({
  Directory: composerDraftFileMocks.Directory,
  File: composerDraftFileMocks.File,
  FileMode: {},
  Paths: { document: { uri: "file:///documents" } },
}));

vi.mock("../lib/composerImages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/composerImages")>()),
  removePersistedComposerAttachmentFile: composerAttachmentCleanupMocks.remove,
}));

vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "0000" }));
vi.mock("./assets", () => ({ assetEnvironment: {} }));
vi.mock("./attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("./session", () => ({ environmentSession: {} }));
vi.mock("@ankielcode/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => Symbol("rpc-command"),
  executeAtomQuery: () => {
    throw new Error("Unexpected network query in the inline read test");
  },
  runAtomCommand: () => {
    throw new Error("Unexpected network command in the inline read test");
  },
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../lib/attachmentUpload", () => ({
  releasePendingAttachmentUploads: composerAttachmentCleanupMocks.releaseUploads,
}));

vi.mock("../features/sharing/incoming-share-storage", () => ({
  loadIncomingShareDrafts: incomingShareStorageMocks.load,
}));
import { appAtomRegistry } from "./atom-registry";
import { threadOutboxManager } from "./thread-outbox";
import {
  clearComposerDraftsEnvironment,
  composerDraftsAtom,
  composerCloudDraftsAtom,
  ensureComposerDraftsLoaded,
  type ComposerDraft,
  flushComposerDrafts,
  modelOptionMemoryAtom,
  releaseUnusedComposerAttachmentFiles,
  resetComposerDraftsLoadState,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
  setStickyComposerModelSelection,
  stickyComposerModelSelectionAtom,
} from "./use-composer-drafts";

const DRAFT: ComposerDraft = {
  text: "hello",
  attachments: [],
};
afterEach(() => {
  vi.useRealTimers();
  resetComposerDraftsLoadState();
  composerDraftFileMocks.setDocument({ schemaVersion: 1, drafts: {} });
  composerDraftFileMocks.setReadError(null);
  composerDraftFileMocks.setWriteError(null);
  composerDraftFileMocks.setNextWriteBarrier(null);
  composerDraftFileMocks.setOnWrite(null);
  composerDraftFileMocks.resetWrites();
  composerDraftFileMocks.readImage.mockReset();
  composerDraftFileMocks.readImage.mockResolvedValue("YWJj");
  appAtomRegistry.set(composerDraftsAtom, {});
  appAtomRegistry.set(composerCloudDraftsAtom, { accountId: null, signedOut: {} });
  appAtomRegistry.set(stickyComposerModelSelectionAtom, null);
  appAtomRegistry.set(modelOptionMemoryAtom, {});
  appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
  composerAttachmentCleanupMocks.remove.mockClear();
  composerAttachmentCleanupMocks.releaseUploads.mockReset();
  composerAttachmentCleanupMocks.releaseUploads.mockResolvedValue(undefined);
  incomingShareStorageMocks.load.mockReset();
  incomingShareStorageMocks.load.mockResolvedValue([]);
});

describe("mobile composer drafts", () => {
  it("merges persisted option memory without replacing newer choices", async () => {
    composerDraftFileMocks.setDocument({
      schemaVersion: 1,
      drafts: {},
      modelOptionMemory: {
        pi: {
          "xai/grok-4.6": [{ id: "thinking", value: "high" }],
          "openai/gpt-5.4": [{ id: "thinking", value: "medium" }],
        },
      },
    });
    appAtomRegistry.set(modelOptionMemoryAtom, {
      pi: { "xai/grok-4.6": [{ id: "thinking", value: "xhigh" }] },
    });

    ensureComposerDraftsLoaded();
    await waitForComposerDraftsLoaded();

    expect(appAtomRegistry.get(modelOptionMemoryAtom)).toEqual({
      pi: {
        "xai/grok-4.6": [{ id: "thinking", value: "xhigh" }],
        "openai/gpt-5.4": [{ id: "thinking", value: "medium" }],
      },
    });
  });

  it("flush waits for pending hydration instead of clobbering disk", async () => {
    vi.useFakeTimers();
    composerDraftFileMocks.setDocument({
      schemaVersion: 1,
      drafts: {
        "environment-1:thread-1": DRAFT,
      },
      stickyModelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      },
    });
    composerDraftFileMocks.blockRead();
    composerDraftFileMocks.resetWrites();

    ensureComposerDraftsLoaded();
    await Promise.resolve();

    setComposerDraftText("new-task:environment-1:project-1", "New prompt");

    const flush = flushComposerDrafts();
    await vi.advanceTimersByTimeAsync(200);

    expect(composerDraftFileMocks.getWrites()).toHaveLength(0);

    composerDraftFileMocks.releaseRead();
    await flush;

    const written = JSON.parse(composerDraftFileMocks.getDocument());
    expect(written.drafts["environment-1:thread-1"]).toEqual(DRAFT);
    expect(written.drafts["new-task:environment-1:project-1"]).toEqual({
      text: "New prompt",
      attachments: [],
    });
    expect(written.stickyModelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it.each(["read", "decode"] as const)(
    "preserves saved drafts and attachment files when the draft %s fails",
    async (failure) => {
      vi.useFakeTimers();
      const file = {
        id: "saved-file",
        type: "file" as const,
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        fileUri: "file:///documents/ankiel-composer-attachments/report.pdf",
      };
      composerDraftFileMocks.setDocument({
        schemaVersion: failure === "decode" ? 999 : 1,
        drafts: { "environment-1:saved": { text: "Saved draft", attachments: [file] } },
      });
      const original = composerDraftFileMocks.getDocument();
      if (failure === "read") {
        composerDraftFileMocks.setReadError(new Error("storage unavailable"));
      }

      await expect(releaseUnusedComposerAttachmentFiles([file])).rejects.toMatchObject({
        operation: failure,
      });
      setComposerDraftText("environment-1:new", "Keep my new edits too");
      await expect(flushComposerDrafts()).rejects.toMatchObject({ operation: failure });

      expect(composerDraftFileMocks.getDocument()).toBe(original);
      expect(composerAttachmentCleanupMocks.remove).not.toHaveBeenCalled();
    },
  );

  it("serializes environment cleanup after an older queued write", async () => {
    vi.useFakeTimers();
    composerDraftFileMocks.setDocument({ schemaVersion: 1, drafts: {} });
    composerDraftFileMocks.resetWrites();
    let releaseFirstWrite!: () => void;
    const firstWriteBarrier = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    composerDraftFileMocks.setNextWriteBarrier(firstWriteBarrier);
    let writeCount = 0;
    const bothWritesCommitted = new Promise<void>((resolve) => {
      composerDraftFileMocks.setOnWrite(() => {
        writeCount += 1;
        if (writeCount === 2) {
          resolve();
        }
      });
    });

    appAtomRegistry.set(composerDraftsAtom, {
      "environment-1:thread-1": DRAFT,
      "environment-2:thread-2": { text: "keep", attachments: [] },
    });
    setStickyComposerModelSelection({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    });
    await vi.advanceTimersByTimeAsync(200);

    const clear = clearComposerDraftsEnvironment(EnvironmentId.make("environment-1"));
    await Promise.resolve();

    expect(composerDraftFileMocks.getWrites()).toHaveLength(0);

    releaseFirstWrite();
    await clear;
    await bothWritesCommitted;

    expect(JSON.parse(composerDraftFileMocks.getDocument())).toEqual({
      schemaVersion: 1,
      drafts: {
        "environment-2:thread-2": { text: "keep", attachments: [] },
      },
      stickyModelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      },
    });
  });
});
