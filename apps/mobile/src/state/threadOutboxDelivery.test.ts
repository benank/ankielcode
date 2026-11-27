import { acknowledgedThreadMessagesAtom } from "./acknowledged-thread-messages";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@ankielcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  canOperate: true,
  threadState: null as unknown as import("effect/reactivity").Atom.Writable<{
    readonly data: import("effect/Option").Option<{
      readonly messages: ReadonlyArray<{ readonly id: string }>;
    }>;
    readonly sequence: number;
  }>,
  manager: null as unknown as ReturnType<
    typeof import("./thread-outbox-manager").createThreadOutboxManager
  >,
  removePersistedFile: vi.fn(async () => undefined),
  removeOutboxMessage: vi.fn(async (_message: QueuedThreadMessage) => undefined),
  prepareTurnAttachments: vi.fn<typeof import("../lib/attachmentUpload").prepareTurnAttachments>(),
  draftFile: (() => {
    let document = "";
    let writeError: Error | null = null;
    return {
      setDocument(value: unknown) {
        document = JSON.stringify(value);
      },
      setWriteError(error: Error | null) {
        writeError = error;
      },
      Directory: class {
        create() {}
      },
      File: class {
        exists = true;
        parentDirectory = null;

        create() {}

        moveSync() {}

        async text() {
          return document;
        }

        write(value: string) {
          if (writeError) {
            throw writeError;
          }
          document = value;
        }
      },
    };
  })(),
}));

vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("expo-file-system", () => ({
  Directory: harness.draftFile.Directory,
  File: harness.draftFile.File,
  Paths: { document: "/documents" },
}));

vi.mock("../lib/composerImages", () => ({
  removePersistedComposerAttachmentFile: harness.removePersistedFile,
}));

vi.mock("../lib/uuid", () => ({
  uuidv4: () => "00000000-0000-4000-8000-000000000000",
  randomHex: () => "abcd",
}));

vi.mock("../lib/attachmentUpload", () => ({
  prepareTurnAttachments: harness.prepareTurnAttachments,
}));
vi.mock("./composer-attachment-uploads", () => ({ uploadComposerAttachmentShared: vi.fn() }));

vi.mock("./projects", () => ({ environmentProjects: {} }));

vi.mock("./workspace", () => ({ workspaceConnections: {} }));

vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { serverEnvironment: { configValueAtom: Atom.family(() => Atom.make(null)) } };
});

vi.mock("./git", () => ({ gitEnvironment: {} }));

vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  harness.threadState = Atom.make({
    data: Option.none<{ readonly messages: ReadonlyArray<{ readonly id: string }> }>(),
    sequence: 0,
  }).pipe(Atom.keepAlive);
  return {
    threadEnvironment: {},
    environmentThreadDetails: { stateAtom: () => harness.threadState },
  };
});

vi.mock("./session", () => ({
  environmentSession: {},
  readEnvironmentScope: () => harness.canOperate,
  sessionHasScope: () => harness.canOperate,
}));

vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make<Record<string, boolean>>({}).pipe(Atom.keepAlive),
    dispatchingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    retryingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    threadOutboxShellStatusesAtom: Atom.make(new Map()),
  };
});

vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  harness.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async () => undefined,
      remove: (message) => harness.removeOutboxMessage(message),
    },
  });
  const manager = harness.manager;
  return {
    threadOutboxManager: manager,
    flushThreadOutbox: async () => undefined,
    confirmThreadOutboxMessageQueued: (message: never) => manager.confirmQueued(message),
    updateThreadOutboxMessage: (message: never, expectedRevision?: number) =>
      manager.update(message, expectedRevision),
    threadOutboxRevision: (messageId: never) => manager.revisionOf(messageId),
  };
});

import * as Option from "effect/Option";
import { appAtomRegistry } from "./atom-registry";
import { pendingThreadCreationOutcomesAtom } from "./pending-thread-creation";
import { threadComposerErrorsAtom } from "./thread-composer-error";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import * as composerDrafts from "./use-composer-drafts";
import { editingQueuedMessageIdsAtom } from "./use-thread-outbox";
import { type DeliveryRetry, recoverEditedCreationAfterDelivery } from "./threadOutboxDelivery";

function queuedMessage(input: {
  readonly messageId: string;
  readonly text: string;
  readonly fileUri?: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.text,
    attachments: input.fileUri
      ? [
          {
            id: `file-${input.messageId}`,
            type: "file",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
            fileUri: input.fileUri,
          },
        ]
      : [],
    createdAt: "2026-08-24T12:00:00.000Z",
  };
}

function remainingMessages(): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(appAtomRegistry.get(harness.manager.queuedMessagesByThreadKeyAtom)).flat();
}

beforeEach(() => {
  appAtomRegistry.set(acknowledgedThreadMessagesAtom, []);
  appAtomRegistry.set(harness.threadState, { data: Option.none(), sequence: 0 });
  harness.canOperate = true;
  harness.draftFile.setDocument({ schemaVersion: 1, drafts: {} });
});

afterEach(() => {
  appAtomRegistry.set(harness.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(composerDrafts.composerDraftsAtom, {});
  appAtomRegistry.set(composerDrafts.composerCloudDraftsAtom, { accountId: null, signedOut: {} });
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
  appAtomRegistry.set(pendingThreadCreationOutcomesAtom, {});
  appAtomRegistry.set(threadComposerErrorsAtom, {});
  harness.draftFile.setWriteError(null);
  harness.removePersistedFile.mockClear();
  harness.removeOutboxMessage.mockClear();
  harness.prepareTurnAttachments.mockReset();
});

/** True once a delivery step handled its message, false when it asks to retry. */
const handled = (step: Effect.Effect<void, DeliveryRetry>) =>
  step.pipe(Effect.as(true), Effect.catchTags({ DeliveryRetry: () => Effect.succeed(false) }));

describe("thread outbox delivered creation recovery", () => {
  it.effect("keeps an edit accepted while the older payload is persisted to the draft", () =>
    Effect.gen(function* () {
      const message = queuedMessage({
        messageId: "message-recovery-race",
        text: "original queued text",
        fileUri: "file:///documents/ankiel-composer-attachments/report.pdf",
      });
      const originalMergeComposerDraftContent = composerDrafts.mergeComposerDraftContent;
      const mergeCompleted = Promise.withResolvers<void>();
      const releaseRecovery = Promise.withResolvers<void>();
      const mergeSpy = vi
        .spyOn(composerDrafts, "mergeComposerDraftContent")
        .mockImplementation(async (draftKey, content) => {
          const result = await originalMergeComposerDraftContent(draftKey, content);
          mergeCompleted.resolve();
          await releaseRecovery.promise;
          return result;
        });

      try {
        yield* Effect.promise(() => harness.manager.enqueue(message));
        const recovery = yield* Effect.forkChild(
          handled(recoverEditedCreationAfterDelivery(message)),
          { startImmediately: true },
        );
        yield* Effect.promise(() => mergeCompleted.promise);

        const newer = { ...message, text: "edited while recovery persisted the draft" };
        yield* Effect.promise(() => harness.manager.update(newer));

        releaseRecovery.resolve();
        expect(yield* Fiber.join(recovery)).toBe(false);

        expect(remainingMessages()).toEqual([newer]);
        expect(
          composerDrafts.getComposerDraftSnapshot(`${message.environmentId}:${message.threadId}`),
        ).toMatchObject({ text: message.text, attachments: [] });
        expect(harness.removePersistedFile).not.toHaveBeenCalled();
      } finally {
        releaseRecovery.resolve();
        mergeSpy.mockRestore();
      }
    }),
  );

  it.effect("leaves recovery to an editor that opens while the draft persists", () =>
    Effect.gen(function* () {
      const message = queuedMessage({
        messageId: "message-recovery-editor",
        text: "recover this text",
        fileUri: "file:///documents/ankiel-composer-attachments/editor.pdf",
      });
      const originalMergeComposerDraftContent = composerDrafts.mergeComposerDraftContent;
      const mergeCompleted = Promise.withResolvers<void>();
      const releaseRecovery = Promise.withResolvers<void>();
      const mergeSpy = vi
        .spyOn(composerDrafts, "mergeComposerDraftContent")
        .mockImplementation(async (draftKey, content) => {
          const result = await originalMergeComposerDraftContent(draftKey, content);
          mergeCompleted.resolve();
          await releaseRecovery.promise;
          return result;
        });

      try {
        yield* Effect.promise(() => harness.manager.enqueue(message));
        const recovery = yield* Effect.forkChild(
          handled(recoverEditedCreationAfterDelivery(message)),
          { startImmediately: true },
        );
        yield* Effect.promise(() => mergeCompleted.promise);
        appAtomRegistry.set(editingQueuedMessageIdsAtom, { [message.messageId]: true });

        releaseRecovery.resolve();
        expect(yield* Fiber.join(recovery)).toBe(true);

        expect(remainingMessages()).toEqual([message]);
        expect(
          composerDrafts.getComposerDraftSnapshot(`${message.environmentId}:${message.threadId}`),
        ).toMatchObject({ text: message.text, attachments: [] });
        expect(harness.removePersistedFile).not.toHaveBeenCalled();
      } finally {
        releaseRecovery.resolve();
        mergeSpy.mockRestore();
      }
    }),
  );

  it.effect("retries a failed removal without duplicating recovered draft content", () =>
    Effect.gen(function* () {
      const message = queuedMessage({
        messageId: "message-recovery-removal",
        text: "recover once",
        fileUri: "file:///documents/ankiel-composer-attachments/retry.pdf",
      });
      const draftKey = `${message.environmentId}:${message.threadId}`;
      const removeSpy = vi
        .spyOn(harness.manager, "remove")
        .mockRejectedValueOnce(new Error("storage unavailable"));

      try {
        yield* Effect.promise(() => harness.manager.enqueue(message));

        expect(yield* handled(recoverEditedCreationAfterDelivery(message))).toBe(false);
        expect(remainingMessages()).toEqual([message]);

        expect(yield* handled(recoverEditedCreationAfterDelivery(message))).toBe(true);

        const draft = composerDrafts.getComposerDraftSnapshot(draftKey);
        expect(draft.text).toBe(message.text);
        expect(draft.attachments).toEqual(message.attachments);
        expect(remainingMessages()).toEqual([]);
        expect(harness.removePersistedFile).not.toHaveBeenCalled();
      } finally {
        removeSpy.mockRestore();
      }
    }),
  );

  it.effect("keeps the queue entry when the recovered draft cannot persist", () =>
    Effect.gen(function* () {
      const message = queuedMessage({
        messageId: "message-recovery-persistence",
        text: "recover after persistence returns",
      });
      yield* Effect.promise(() => harness.manager.enqueue(message));
      harness.draftFile.setWriteError(new Error("disk full"));

      expect(yield* handled(recoverEditedCreationAfterDelivery(message))).toBe(false);

      expect(remainingMessages()).toEqual([message]);
    }),
  );
});
