import { describe, expect, it } from "@effect/vitest";
import { EnvironmentNotRegisteredError } from "@ankielcode/client-runtime/connection";
import { isTransportConnectionErrorMessage } from "@ankielcode/client-runtime/errors";
import { EnvironmentRpcUnavailableError } from "@ankielcode/client-runtime/rpc";
import {
  CommandId,
  ComposerContextId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProviderInstanceId,
  ThreadId,
} from "@ankielcode/contracts";
import { AtomRegistry } from "effect/reactivity";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Socket from "effect/socket/Socket";
import { onTestFinished, vi } from "vite-plus/test";

const outboxFiles = vi.hoisted(() => new Map<string, string | Error>());

vi.mock("expo-file-system", () => {
  class Directory {
    create() {}

    list() {
      return Array.from(outboxFiles.keys(), (name) => new File(name));
    }
  }

  class File {
    readonly name: string;
    readonly parentDirectory = new Directory();

    constructor(...parts: [string] | [Directory, string]) {
      this.name = parts.length === 1 ? parts[0] : parts[1];
    }

    get exists() {
      return outboxFiles.has(this.name);
    }

    create() {
      outboxFiles.set(this.name, "");
    }

    write(contents: string) {
      outboxFiles.set(this.name, contents);
    }

    moveSync(file: File) {
      const contents = outboxFiles.get(this.name);
      if (contents === undefined) throw new Error("Missing file");
      outboxFiles.set(file.name, contents);
      outboxFiles.delete(this.name);
    }

    delete() {
      outboxFiles.delete(this.name);
    }

    async text(): Promise<string> {
      const contents = outboxFiles.get(this.name);
      if (contents instanceof Error) throw contents;
      if (contents === undefined) throw new Error("Missing file");
      return contents;
    }
  }

  return {
    File,
    Directory,
    Paths: { document: "/documents" },
  };
});

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import {
  expoThreadOutboxStorage,
  ThreadOutboxStorageError,
  type ThreadOutboxLoadResult,
  type ThreadOutboxStorage,
} from "./thread-outbox-storage";

function queuedMessage(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly messageId: string;
  readonly createdAt: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.messageId,
    attachments: [],
    createdAt: input.createdAt,
  };
}

describe("thread outbox", () => {
  it("retains structured context through a persisted offline queue round trip", () => {
    const message: QueuedThreadMessage = {
      ...queuedMessage({ messageId: "context-message", createdAt: "2026-09-06T12:00:00.000Z" }),
      text: "[Build](ankiel-context://v1/terminal/build-output)",
      context: {
        version: 1,
        records: [
          {
            version: 1,
            kind: "terminal",
            contextId: ComposerContextId.make("build-output"),
            label: "Build",
            terminalId: "main",
            terminalLabel: "Terminal",
            lineStart: 2,
            lineEnd: 2,
            text: "Build failed",
          },
        ],
      },
    };
    expect(
      decodeQueuedThreadMessage(JSON.parse(JSON.stringify(encodeQueuedThreadMessage(message)))),
    ).toEqual(message);
  });
  it.each(["read", "json", "schema"] as const)(
    "recovers usable messages without permitting cleanup after a record %s failure",
    async (failure) => {
      onTestFinished(() => outboxFiles.clear());
      const first = queuedMessage({
        messageId: "message-1",
        createdAt: "2026-06-08T10:00:01.000Z",
      });
      const second = queuedMessage({
        environmentId: "environment-2",
        messageId: "message-2",
        createdAt: "2026-06-08T10:00:02.000Z",
      });
      outboxFiles.set(
        "message-2.json",
        failure === "read"
          ? new Error("storage unavailable")
          : failure === "json"
            ? "{"
            : JSON.stringify({ ...second, schemaVersion: 999 }),
      );
      outboxFiles.set("message-1.json", JSON.stringify(encodeQueuedThreadMessage(first)));
      const unreadable = outboxFiles.get("message-2.json");

      await expect(expoThreadOutboxStorage.load()).resolves.toMatchObject({
        messages: [first],
        errors: [{ operation: "read-message", fileName: "message-2.json" }],
      });

      const registry = AtomRegistry.make();
      onTestFinished(() => registry.dispose());
      const manager = createThreadOutboxManager({
        registry,
        storage: expoThreadOutboxStorage,
        warn: () => {},
      });
      await expect(manager.load()).resolves.toBe(false);
      const recovered = registry.get(manager.queuedMessagesByThreadKeyAtom)[
        "environment-1:thread-1"
      ]![0]!;
      expect(recovered).toEqual(first);
      await expect(manager.confirmQueued(recovered)).resolves.toBe(true);
      const edited = { ...recovered, text: "Edited after recovery" };
      await expect(manager.update(edited)).resolves.toBe(true);
      const beforeRetry = registry.get(manager.queuedMessagesByThreadKeyAtom);
      await expect(manager.load()).resolves.toBe(false);
      expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toBe(beforeRetry);
      await expect(manager.clearEnvironment(first.environmentId)).rejects.toMatchObject({
        operation: "clear-environment-load",
      });
      expect(outboxFiles.get("message-2.json")).toBe(unreadable);
      expect(outboxFiles.has("message-1.json")).toBe(true);

      await expect(manager.remove(edited)).resolves.toBe(edited);
      expect(outboxFiles.has("message-1.json")).toBe(false);

      outboxFiles.set("message-2.json", JSON.stringify(encodeQueuedThreadMessage(second)));
      await expect(manager.load()).resolves.toBe(true);
      expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
        "environment-2:thread-1": [second],
      });
      await expect(expoThreadOutboxStorage.load()).resolves.toEqual({
        messages: [second],
        errors: [],
      });
    },
  );

  it("preserves queued messages when environment cleanup cannot read the outbox", async () => {
    const registry = AtomRegistry.make();
    onTestFinished(() => registry.dispose());
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const manager = createThreadOutboxManager({
      registry,
      warn: () => {},
      storage: {
        load: async () => {
          throw new Error("storage unavailable");
        },
        write: async (entry) => {
          stored.set(entry.messageId, entry);
        },
        remove: async (entry) => {
          stored.delete(entry.messageId);
        },
      },
    });
    await manager.enqueue(message);

    await expect(manager.clearEnvironment(message.environmentId)).rejects.toMatchObject({
      operation: "clear-environment-load",
    });
    expect([...stored.values()]).toEqual([message]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });
  });

  it("keeps in-session edits and removals when an incomplete load is retried", async () => {
    const registry = AtomRegistry.make();
    onTestFinished(() => registry.dispose());
    const message = queuedMessage({
      messageId: "message-retried",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<ThreadOutboxLoadResult>();
    const load = vi.fn<ThreadOutboxStorage["load"]>(async () => ({
      messages: [message],
      errors: [],
    }));
    load.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: { load, write: async () => {}, remove: async () => {} },
      warn: () => {},
    });
    const loading = manager.load();
    await started.promise;
    const edited = { ...message, text: "Accepted while storage was being read" };
    const writing = manager.enqueue(edited);
    response.resolve({
      messages: [message],
      errors: [
        new ThreadOutboxStorageError({
          operation: "read-message",
          environmentId: null,
          threadId: null,
          messageId: null,
          fileName: "unreadable.json",
          cause: new Error("unreadable record"),
        }),
      ],
    });
    await expect(loading).resolves.toBe(false);
    await writing;
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [edited],
    });
    await expect(manager.confirmQueued(edited)).resolves.toBe(true);

    await manager.remove(edited);
    await expect(manager.load()).resolves.toBe(true);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reads file-backed images from v4 queued messages", () => {
    const message = {
      ...queuedMessage({
        messageId: "message-image",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      attachments: [
        {
          id: "image-1",
          type: "image" as const,
          name: "photo.png",
          mimeType: "image/png",
          sizeBytes: 3,
          fileUri: "file:///documents/ankiel-composer-attachments/photo.png",
          previewUri: "file:///documents/ankiel-composer-attachments/photo.png",
          uploadedAttachmentId: "pending-photo-png",
          uploadEnvironmentId: EnvironmentId.make("environment-1"),
        },
      ],
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage({ ...message, schemaVersion: 4 })).toEqual(message);
  });

  it("persists the exact selector snapshot while remaining compatible with v1 messages", () => {
    const legacyMessage = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const selectedMessage = {
      ...legacyMessage,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      dispatchMode: "queue",
      compactBeforeSend: true,
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(selectedMessage))).toEqual(
      selectedMessage,
    );
    expect(
      resolveQueuedThreadSettings(legacyMessage, {
        modelSelection: selectedMessage.modelSelection,
        runtimeMode: selectedMessage.runtimeMode,
        interactionMode: selectedMessage.interactionMode,
      }),
    ).toEqual({
      modelSelection: selectedMessage.modelSelection,
      runtimeMode: selectedMessage.runtimeMode,
      interactionMode: selectedMessage.interactionMode,
    });
  });

  it("normalizes queued plan mode against the queued provider, not the current thread", () => {
    const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };
    const antigravity = {
      instanceId: ProviderInstanceId.make("google-personal"),
      model: "gemini-test-thinking",
      options: [{ id: "native-option", value: "keep-this-choice" }],
    };
    const providers = [
      { instanceId: codex.instanceId, showInteractionModeToggle: true, models: [] },
      { instanceId: antigravity.instanceId, showInteractionModeToggle: false, models: [] },
    ];
    const message = {
      ...queuedMessage({ messageId: "queued-plan", createdAt: "2026-09-02T10:00:00.000Z" }),
      text: "/plan inspect the project",
      modelSelection: antigravity,
      interactionMode: "plan",
    } satisfies QueuedThreadMessage;

    expect(
      resolveQueuedThreadSettings(
        message,
        { modelSelection: codex, runtimeMode: "approval-required", interactionMode: "plan" },
        providers,
      ),
    ).toEqual({
      modelSelection: antigravity,
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    expect(
      resolveQueuedThreadSettings(
        { ...message, modelSelection: codex },
        {
          modelSelection: antigravity,
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
        providers,
      ).interactionMode,
    ).toBe("plan");
  });

  // regression: #29729 Cursor runs its own Fast default when the turn carries no fastMode
  it("sends the Fast off the picker shows for a model without a Fast selection", () => {
    const cursor = { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2.5" };
    const providers = [
      {
        instanceId: cursor.instanceId,
        showInteractionModeToggle: true,
        models: [
          {
            slug: cursor.model,
            capabilities: {
              optionDescriptors: [
                { id: "fastMode", label: "Fast", type: "boolean", currentValue: true } as const,
              ],
            },
          },
        ],
      },
    ];
    const thread = {
      modelSelection: cursor,
      runtimeMode: "full-access",
      interactionMode: "default",
    } as const;
    const message = queuedMessage({ messageId: "fast", createdAt: "2026-11-03T10:00:00.000Z" });
    const fastOn = { ...cursor, options: [{ id: "fastMode", value: true }] };

    expect(resolveQueuedThreadSettings(message, thread, providers).modelSelection.options).toEqual([
      { id: "fastMode", value: false },
    ]);
    expect(
      resolveQueuedThreadSettings({ ...message, modelSelection: fastOn }, thread, providers)
        .modelSelection,
    ).toEqual(fastOn);
  });

  it("holds the mutation queue while persisted messages are loading", async () => {
    const registry = AtomRegistry.make();
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const stored = new Map([[message.messageId, message]]);
    let loadCalls = 0;
    let removeCalls = 0;
    let releaseInitialLoad!: () => void;
    const initialLoadBlocked = new Promise<void>((resolve) => {
      releaseInitialLoad = resolve;
    });
    const storage: ThreadOutboxStorage = {
      load: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          await initialLoadBlocked;
        }
        return { messages: [...stored.values()], errors: [] };
      },
      write: async () => undefined,
      remove: async (candidate) => {
        removeCalls += 1;
        stored.delete(candidate.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });

    const loading = manager.load();
    await Promise.resolve();
    const clearing = manager.clearEnvironment(message.environmentId);
    await Promise.resolve();
    await Promise.resolve();

    expect(loadCalls).toBe(1);
    expect(removeCalls).toBe(0);

    releaseInitialLoad();
    await Promise.all([loading, clearing]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("retries transport failures but drops deterministic command failures", () => {
    expect(shouldRetryThreadOutboxDelivery(new Error("Socket is not connected"))).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "ConnectionTransientError",
        message: "temporarily unavailable",
      }),
    ).toBe(true);
    expect(shouldRetryThreadOutboxDelivery(new Error("Thread no longer exists"))).toBe(false);
    expect(
      shouldRetryThreadOutboxDelivery(
        new OrchestrationDispatchCommandError({ message: "Thread no longer exists" }),
      ),
    ).toBe(false);
    expect(
      shouldRetryThreadOutboxDelivery(
        new EnvironmentAuthorizationError({
          message: "Missing scope",
          requiredScope: "orchestration:operate",
        }),
      ),
    ).toBe(false);
  });

  it("retries every in-flight transport failure by tag, not by message text", () => {
    const socketReasons = [
      new Socket.SocketReadError({ cause: new Error("The network connection was lost.") }),
      new Socket.SocketWriteError({ cause: new Error("Broken pipe") }),
      new Socket.SocketCloseError({ code: 1006 }),
      new Socket.SocketOpenError({ kind: "Timeout", cause: new Error("timeout") }),
    ];
    for (const reason of socketReasons) {
      const error = new RpcClientError.RpcClientError({ reason });
      expect(isTransportConnectionErrorMessage(error.message)).toBe(
        reason._tag === "SocketCloseError" || reason._tag === "SocketOpenError",
      );
      expect(shouldRetryThreadOutboxDelivery(error)).toBe(true);
    }
    expect(
      shouldRetryThreadOutboxDelivery(
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({
            message: "Error decoding message",
            cause: new Error("Unexpected end of JSON input"),
          }),
        }),
      ),
    ).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery(
        new EnvironmentRpcUnavailableError({
          environmentId: "environment-1",
          message: "Home is not connected.",
        }),
      ),
    ).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery(
        new EnvironmentNotRegisteredError({ environmentId: EnvironmentId.make("environment-1") }),
      ),
    ).toBe(true);
  });

  it("retains queued messages when settings synchronization fails before startTurn", () => {
    const deterministicFailure = new Error("Thread no longer exists");

    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("restore");
  });
});
