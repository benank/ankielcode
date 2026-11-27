import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@ankielcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";

const forkCases = (
  [
    ["codex", "interrupted"],
    ["claudeAgent", "failed"],
  ] as const
).map(([driverName, status]) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "test-model" };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `fork-boundary-${driver}` },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  );

  return { driver, status, instanceId, modelSelection, layer };
});

const writeParentRun = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  /** Preparing, failed, and interrupted runs asked for a new worktree. */
  readonly status:
    | "preparing"
    | "running"
    | "queued"
    | "completed"
    | "rolled_back"
    | "failed"
    | "interrupted";
  readonly text: string;
  /** A checkpointed run on a native provider thread, which `latest_stable` forks start from. */
  readonly stable?: boolean;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { driver, instanceId, modelSelection } = forkCases[0]!;
    const messageId = MessageId.make(`${input.runId}:message`);
    const providerThreadId = input.stable
      ? ProviderThreadId.make(`${input.runId}:provider-thread`)
      : null;
    const setupUnfinished =
      input.status === "preparing" || input.status === "failed" || input.status === "interrupted";
    yield* eventSink.write({
      events: [
        ...(providerThreadId === null
          ? []
          : [
              {
                id: EventId.make(`${input.runId}:provider-thread`),
                type: "provider-thread.updated" as const,
                threadId: input.threadId,
                occurredAt: now,
                payload: {
                  id: providerThreadId,
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: null,
                  appThreadId: input.threadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver,
                    nativeId: `${input.runId}:native`,
                    strength: "strong" as const,
                  },
                  nativeConversationHeadRef: null,
                  status: "idle" as const,
                  firstRunOrdinal: input.ordinal,
                  lastRunOrdinal: input.ordinal,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ]),
        {
          id: EventId.make(`${input.runId}:created`),
          type: "run.created",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: messageId,
            rootNodeId: null,
            activeAttemptId: null,
            status: input.status,
            queuePosition: null,
            requestedAt: now,
            startedAt: setupUnfinished ? null : now,
            completedAt:
              input.status === "preparing" ||
              input.status === "running" ||
              input.status === "queued"
                ? null
                : now,
            checkpointId: input.stable ? CheckpointId.make(`${input.runId}:checkpoint`) : null,
            contextHandoffId: null,
            ...(setupUnfinished
              ? { workspacePreparation: { type: "worktree" as const, baseRef: "main" } }
              : {}),
          },
        },
        {
          id: EventId.make(`${input.runId}:item`),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`${input.runId}:item`),
            threadId: input.threadId,
            runId: input.runId,
            nodeId: null,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal * 100,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            messageId,
            text: input.text,
            attachments: [],
          },
        },
      ],
    });
  });

const createParent = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make("side-chat-project"),
      title: "Side chat parent",
      modelSelection: forkCases[0]!.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const forkSideChat = (commandId: string, sourceThreadId: ThreadId, targetThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make(commandId),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "latest_stable" },
      sideChat: true,
      createdBy: "user",
      creationSource: "web",
    });
  });

const askSideChat = (
  threadId: ThreadId,
  commandId: string,
  modelSelection?: (typeof forkCases)[number]["modelSelection"],
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(commandId),
      threadId,
      messageId: MessageId.make(commandId),
      text: "What is the main thread doing?",
      attachments: [],
      ...(modelSelection === undefined ? {} : { modelSelection }),
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("resolves an explicit checkpoint fork to its source run", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const parentId = ThreadId.make("checkpoint-fork-parent");
    const childId = ThreadId.make("checkpoint-fork-child");
    const runId = RunId.make("checkpoint-fork-run");
    const checkpointId = CheckpointId.make("checkpoint-fork-checkpoint");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId,
      ordinal: 1,
      status: "completed",
      text: "Work",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("checkpoint-fork-captured"),
          type: "checkpoint.captured",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: checkpointId,
            threadId: parentId,
            scopeId: CheckpointScopeId.make("checkpoint-fork-scope"),
            runId,
            nodeId: NodeId.make("checkpoint-fork-node"),
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref: CheckpointRef.make("refs/ankiel/checkpoint-fork/1"),
            status: "ready",
            files: [],
            capturedAt: now,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("checkpoint-fork"),
      sourceThreadId: parentId,
      targetThreadId: childId,
      sourcePoint: { type: "checkpoint", checkpointId },
      createdBy: "user",
      creationSource: "mcp",
    });
    const child = yield* orchestrator.getThreadShell(childId);
    assert.deepEqual(child?.forkedFrom, { type: "run", threadId: parentId, runId });
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("a fresh send in a fork that has not run yet starts without the fork's context", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("fresh-fork-parent");
    const forkId = ThreadId.make("fresh-fork-child");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("fresh-fork-parent-run"),
      ordinal: 1,
      status: "completed",
      text: "Work",
      stable: true,
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fresh-fork"),
      sourceThreadId: parentId,
      targetThreadId: forkId,
      sourcePoint: { type: "latest_stable" },
      createdBy: "user",
      creationSource: "web",
    });
    const scheduled = yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("fresh-fork-scheduled"),
        threadId: forkId,
        messageId: MessageId.make("fresh-fork-scheduled"),
        scheduledTaskId: ScheduledTaskId.make("fresh-fork-task"),
        text: "Scheduled",
        attachments: [],
        freshContext: true,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.include(String(scheduled.cause), "still being applied");
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("fresh-fork-send"),
      threadId: forkId,
      messageId: MessageId.make("fresh-fork-send"),
      text: "Start over",
      attachments: [],
      freshContext: true,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const fork = yield* orchestrator.getThreadProjection(forkId);
    assert.isTrue(fork.runs.at(-1)?.freshContext === true);
    assert.deepEqual(
      fork.contextTransfers.filter((transfer) => transfer.type === "fork").map((t) => t.status),
      ["superseded"],
    );
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("closing a side chat deletes it only while unused; a deleted parent takes no more", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("side-chat-close-parent");
    const unused = ThreadId.make("side-chat-close-unused");
    const used = ThreadId.make("side-chat-close-used");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: RunId.make("side-chat-close-parent-run"),
      ordinal: 1,
      status: "completed",
      text: "Parent work",
      stable: true,
    });
    yield* forkSideChat("side-chat-close-fork-unused", parentId, unused);
    yield* forkSideChat("side-chat-close-fork-used", parentId, used);
    yield* askSideChat(used, "side-chat-close-used-message");
    const close = (threadId: ThreadId) =>
      orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`side-chat-close:${threadId}`),
        threadId,
        onlyIfUnused: true,
      });

    yield* close(unused);
    yield* close(used);
    assert.isNotNull((yield* orchestrator.getThreadProjection(unused)).thread.deletedAt);
    assert.isNull((yield* orchestrator.getThreadProjection(used)).thread.deletedAt);

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("side-chat-close-delete-parent"),
      threadId: parentId,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(used)).thread.deletedAt);
    const orphan = yield* forkSideChat(
      "side-chat-close-orphan",
      parentId,
      ThreadId.make("side-chat-close-orphan"),
    ).pipe(Effect.flip);
    assert.include(String(orphan.cause), "was deleted");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect(
  "archiving a parent stops and archives its side chats; unarchiving brings them back",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const { driver, instanceId } = forkCases[0]!;
      const parentId = ThreadId.make("side-chat-archive-parent");
      const busy = ThreadId.make("side-chat-archive-busy");
      const archivedFirst = ThreadId.make("side-chat-archive-archived-first");
      const delegating = ThreadId.make("side-chat-archive-delegating");
      yield* createParent(parentId);
      yield* writeParentRun({
        threadId: parentId,
        runId: RunId.make("side-chat-archive-parent-run"),
        ordinal: 1,
        status: "completed",
        text: "Parent work",
        stable: true,
      });
      yield* forkSideChat("side-chat-archive-fork-busy", parentId, busy);
      yield* forkSideChat("side-chat-archive-fork-archived-first", parentId, archivedFirst);
      yield* forkSideChat("side-chat-archive-fork-delegating", parentId, delegating);
      const runningRunId = RunId.make("side-chat-archive-busy-running");
      const queuedRunId = RunId.make("side-chat-archive-busy-queued");
      yield* writeParentRun({
        threadId: busy,
        runId: runningRunId,
        ordinal: 1,
        status: "running",
        text: "Run a long command",
      });
      yield* writeParentRun({
        threadId: busy,
        runId: queuedRunId,
        ordinal: 2,
        status: "queued",
        text: "Then this",
      });
      const now = yield* DateTime.now;
      for (const threadId of [parentId, busy]) {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${threadId}:session`),
              type: "provider-session.attached",
              threadId,
              driver,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: ProviderSessionId.make(`${threadId}:session`),
                driver,
                providerInstanceId: instanceId,
                status: "running",
                cwd: "/workspace",
                model: "test-model",
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
            },
          ],
        });
      }
      const delegatingRunId = RunId.make("side-chat-archive-delegating-run");
      yield* writeParentRun({
        threadId: delegating,
        runId: delegatingRunId,
        ordinal: 1,
        status: "completed",
        text: "Delegate a review",
      });
      const taskId = NodeId.make("side-chat-archive-delegated-task");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${taskId}:running`),
            type: "subagent.updated",
            threadId: delegating,
            occurredAt: now,
            payload: {
              id: taskId,
              threadId: delegating,
              runId: delegatingRunId,
              parentNodeId: NodeId.make("side-chat-archive-delegating-node"),
              origin: "app_owned",
              createdBy: "agent",
              driver,
              providerInstanceId: instanceId,
              providerThreadId: null,
              childThreadId: ThreadId.make("side-chat-archive-delegated-child"),
              nativeTaskRef: null,
              prompt: "Review the changes",
              title: null,
              model: null,
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            },
          },
        ],
      });
      const archive = (commandId: string, threadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(commandId),
          threadId,
        });
      const archivedAt = (threadId: ThreadId) =>
        orchestrator
          .getThreadProjection(threadId)
          .pipe(Effect.map(({ thread }) => thread.archivedAt));

      // Archiving a side chat on its own leaves its parent alone.
      yield* archive("side-chat-archive-only-child", archivedFirst);
      const childArchivedAt = yield* archivedAt(archivedFirst);
      assert.isNotNull(childArchivedAt);
      assert.isNull(yield* archivedAt(parentId));
      yield* TestClock.adjust("1 second");

      yield* archive("side-chat-archive-parent", parentId);
      assert.isNotNull(yield* archivedAt(parentId));
      const archivedBusy = yield* orchestrator.getThreadProjection(busy);
      assert.isNotNull(archivedBusy.thread.archivedAt);
      assert.equal(archivedBusy.runs.find((run) => run.id === queuedRunId)?.status, "cancelled");
      assert.isEmpty(archivedBusy.providerSessions);
      assert.deepEqual(yield* archivedAt(archivedFirst), childArchivedAt);
      // Archive refuses a thread still waiting on delegated tasks, so the cascade leaves it active.
      assert.isNull(yield* archivedAt(delegating));

      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("side-chat-archive-unarchive-parent"),
        threadId: parentId,
      });
      assert.isNull(yield* archivedAt(parentId));
      assert.isNull(yield* archivedAt(busy));
      assert.deepEqual(yield* archivedAt(archivedFirst), childArchivedAt);
    }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect("merge-back rejects a second fork's context until the first is consumed", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentId = ThreadId.make("merge-back-guard-parent");
    const parentRunId = RunId.make("merge-back-guard-parent-run");
    yield* createParent(parentId);
    yield* writeParentRun({
      threadId: parentId,
      runId: parentRunId,
      ordinal: 1,
      status: "completed",
      text: "Parent work",
    });
    const forkAndRun = (name: string) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`merge-back-guard-${name}`);
        const runId = RunId.make(`merge-back-guard-${name}-run`);
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`merge-back-guard-fork-${name}`),
          sourceThreadId: parentId,
          targetThreadId: threadId,
          sourcePoint: { type: "run", runId: parentRunId },
          sideChat: true,
          createdBy: "user",
          creationSource: "web",
        });
        yield* writeParentRun({ threadId, runId, ordinal: 1, status: "completed", text: name });
        return { threadId, runId };
      });
    const mergeBack = (commandId: string, fork: { threadId: ThreadId; runId: RunId }) =>
      orchestrator.dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make(commandId),
        sourceThreadId: fork.threadId,
        targetThreadId: parentId,
        sourcePoint: { type: "run", runId: fork.runId },
        createdBy: "user",
        creationSource: "web",
      });
    const first = yield* forkAndRun("first");
    const second = yield* forkAndRun("second");

    yield* mergeBack("merge-back-guard-first", first);
    const refusedFresh = yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("merge-back-guard-fresh-send"),
        threadId: parentId,
        messageId: MessageId.make("merge-back-guard-fresh-send"),
        text: "Start over",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        freshContext: true,
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.flip);
    assert.include(
      String(refusedFresh.cause),
      "Send a message without /clear to apply the merged context first.",
    );
    const rejected = yield* mergeBack("merge-back-guard-second", second).pipe(Effect.flip);
    assert.include(String(rejected.cause), "pending context from another side chat or fork");
    yield* mergeBack("merge-back-guard-first-again", first);
    // That pending merge-back targets the parent, so it does not block one into `first`.
    const nested = { threadId: ThreadId.make("merge-back-guard-nested") };
    const nestedRunId = RunId.make("merge-back-guard-nested-run");
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("merge-back-guard-fork-nested"),
      sourceThreadId: first.threadId,
      targetThreadId: nested.threadId,
      sourcePoint: { type: "run", runId: first.runId },
      createdBy: "user",
      creationSource: "web",
    });
    yield* writeParentRun({
      threadId: nested.threadId,
      runId: nestedRunId,
      ordinal: 1,
      status: "completed",
      text: "nested",
    });
    yield* orchestrator.dispatch({
      type: "thread.merge_back",
      commandId: CommandId.make("merge-back-guard-nested"),
      sourceThreadId: nested.threadId,
      targetThreadId: first.threadId,
      sourcePoint: { type: "run", runId: nestedRunId },
      createdBy: "user",
      creationSource: "web",
    });

    const parent = yield* orchestrator.getThreadProjection(parentId);
    assert.deepEqual(
      parent.contextTransfers
        .filter((transfer) => transfer.type === "merge_back")
        .map((transfer) => [transfer.sourceThreadId, transfer.status]),
      [
        [first.threadId, "superseded"],
        [first.threadId, "pending"],
      ],
    );

    // Archiving or deleting a parent cascades only to side chats, so the full fork can still merge back.
    const mergeNestedInto = (commandId: string) =>
      orchestrator
        .dispatch({
          type: "thread.merge_back",
          commandId: CommandId.make(commandId),
          sourceThreadId: nested.threadId,
          targetThreadId: first.threadId,
          sourcePoint: { type: "run", runId: nestedRunId },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.flip);
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("merge-back-guard-archive-first"),
      threadId: first.threadId,
    });
    const intoArchived = yield* mergeNestedInto("merge-back-guard-into-archived");
    assert.equal(intoArchived._tag, "OrchestratorDispatchError");
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("merge-back-guard-delete-first"),
      threadId: first.threadId,
    });
    const intoDeleted = yield* mergeNestedInto("merge-back-guard-into-deleted");
    assert.equal(intoDeleted._tag, "OrchestratorDispatchError");
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

const runForkWithFailingNativeSource = (forkFailures: number) => {
  const driver = ProviderDriverKind.make("claudeAgent");
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const modelSelection = { instanceId, model: "test-model" };
  const started = Deferred.makeUnsafe<ProviderAdapter.ProviderAdapterV2TurnInput>();
  let forkCalls = 0;
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: "/tmp/fork-missing-native-source",
            model: modelSelection.model,
            capabilities: ClaudeProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          ensureThread: ({ threadId, existingProviderThread }) =>
            Effect.succeed({
              ...existingProviderThread!,
              appThreadId: threadId,
              nativeThreadRef: { driver, nativeId: "native-fresh-fork", strength: "strong" },
              status: "idle",
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) => Deferred.succeed(started, turn).pipe(Effect.asVoid),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: ({ sourceProviderThread, targetThreadId }) =>
            ++forkCalls <= forkFailures
              ? Effect.fail(
                  new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver,
                    providerThreadId: sourceProviderThread.id,
                    cause:
                      "Session not found: native-deleted-source; authorization=BearerSyntheticSecret",
                  }),
                )
              : Effect.succeed({
                  ...sourceProviderThread,
                  appThreadId: targetThreadId,
                  nativeThreadRef: { driver, nativeId: "native-forked", strength: "strong" },
                  updatedAt: now,
                }),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const now = yield* DateTime.now;
    const sourceThreadId = ThreadId.make("fork-missing-source");
    const targetThreadId = ThreadId.make("fork-missing-target");
    const providerThreadId = ProviderThreadId.make("fork-missing-native-thread");
    const sourceRunId = RunId.make("fork-missing-source-run");
    const userMessageId = MessageId.make("fork-missing-source-message");

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fork-missing-create-source"),
      threadId: sourceThreadId,
      projectId: ProjectId.make("fork-missing-project"),
      title: "Fork missing source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("fork-missing-provider-thread"),
          type: "provider-thread.updated",
          threadId: sourceThreadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: sourceThreadId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: "native-deleted-source", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("fork-missing-source-run"),
          type: "run.created",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: sourceRunId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId,
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            queuePosition: null,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make("fork-missing-user-item"),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("fork-missing-user-item"),
            threadId: sourceThreadId,
            runId: sourceRunId,
            nodeId: null,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            messageId: userMessageId,
            text: "FORKED_SOURCE_MARKER",
            attachments: [],
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-missing-fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: sourceRunId },
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("fork-missing-continue"),
      threadId: targetThreadId,
      messageId: MessageId.make("fork-missing-continue"),
      text: "Continue the fork",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    // Run every start attempt so the last one runs with willRetry false.
    for (let attempt = 0; attempt < 5; attempt++) {
      yield* worker.drain();
      yield* TestClock.adjust("1 second");
    }

    const projection = yield* orchestrator.getThreadProjection(targetThreadId);
    assert.deepEqual(
      projection.turnItems.flatMap((item) => (item.type === "error" ? [item.title] : [])),
      [],
    );
    assert.equal(projection.runs[0]?.status, "running");
    return { projection, turn: yield* Deferred.await(started), forkCalls };
  }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        { name: "fork-missing-native-source" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { runEffectWorker: false },
      ),
    ),
  );
};

it.effect("a native fork whose source session is gone starts fresh with the source history", () =>
  Effect.gen(function* () {
    const { projection, turn } = yield* runForkWithFailingNativeSource(Number.POSITIVE_INFINITY);
    // Resolving the fork transfer stops later sends from retrying the native fork.
    assert.equal(projection.contextTransfers[0]?.status, "resolved_portable");
    assert.isNull(projection.providerThreads[0]?.forkedFrom);
    assert.include(JSON.stringify(turn), "FORKED_SOURCE_MARKER");
    const notices = projection.turnItems.flatMap((item) =>
      item.type === "system_notice" ? [item.message] : [],
    );
    assert.lengthOf(notices, 1);
    assert.include(notices[0], "Session not found: native-deleted-source");
    assert.notInclude(notices[0], "BearerSyntheticSecret");
  }),
);
