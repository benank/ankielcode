import * as EffectOutbox from "./EffectOutbox.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@ankielcode/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@ankielcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@ankielcode/provider-core/server/driver";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@ankielcode/provider-core/server/ProviderContinuationRequests";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import { PROVIDER_STOP_REASON_SIGNAL } from "@ankielcode/provider-core/server/subagentProjection";

const layerPlatformTest = Layer.merge(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "ankiel-orchestration-v2-delegated-completion-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.merge(
  ModelManifest.layerTest,
  Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  }),
);

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ThreadCommandExecutor.layer,
  EffectOutbox.layer,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      readRepositoryIdentity: () => Effect.succeed(null),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      refreshRepositoryIdentity: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerPlatformTest),
);

const seedParentWithTerminalTask = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly taskId: NodeId;
  readonly deliveryState: "pending" | "delivered" | "claimed" | "acknowledged" | "disposed";
  readonly completionWake?: "always" | "settled_only";
  readonly deliveryTaskIds?: ReadonlyArray<NodeId>;
  readonly parentRunStatus?: "running" | "completed";
  readonly siblingTasks?: ReadonlyArray<{
    readonly id: NodeId;
    readonly deliveryState: "delivered" | "claimed";
  }>;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const providerThreadId = ProviderThreadId.make(
      `provider-thread:${String(input.threadId).replace("thread:", "")}`,
    );

    yield* projects.create({
      commandId: CommandId.make(`command:seed-project:${input.threadId}`),
      projectId: input.projectId,
      title: "Delegated completion delivery",
      workspaceRoot: `/workspace/${input.projectId}`,
    });

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:seed-create:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Delegated completion delivery",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-projection:${input.threadId}`),
      events: [
        {
          id: EventId.make(`event:seed-provider-thread:${input.threadId}`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: input.rootNodeId,
            nativeThreadRef: {
              driver,
              nativeId: `native:${input.threadId}`,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: input.now,
            updatedAt: input.now,
          },
        },
        {
          id: EventId.make(`event:seed-run:${input.threadId}`),
          type: "run.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:seed-user:${input.threadId}`),
            rootNodeId: input.rootNodeId,
            activeAttemptId: null,
            status: input.parentRunStatus ?? "running",
            requestedAt: input.now,
            startedAt: input.now,
            completedAt: input.parentRunStatus === "completed" ? input.now : null,
            checkpointId: null,
            contextHandoffId: null,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 2,
              delivery:
                input.deliveryTaskIds === undefined
                  ? null
                  : {
                      generation: 1,
                      messageId: MessageId.make(`message:delegated-delivery:${input.threadId}`),
                      taskIds: input.deliveryTaskIds,
                    },
            },
          },
        },
        ...[
          { id: input.taskId, deliveryState: input.deliveryState },
          ...(input.siblingTasks ?? []),
        ].map((task) => ({
          id: EventId.make(`event:seed-task:${input.threadId}:${task.id}`),
          type: "subagent.updated" as const,
          threadId: input.threadId,
          runId: input.runId,
          nodeId: task.id,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: task.id,
            threadId: input.threadId,
            runId: input.runId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned" as const,
            createdBy: "agent" as const,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Inspect the delivered ownership edge.",
            title: null,
            model: null,
            completionWake: input.completionWake ?? "settled_only",
            completionDelivery: {
              state: task.deliveryState,
              observedByRunId: task.deliveryState === "acknowledged" ? input.runId : null,
            },
            status: "completed" as const,
            result: "child finished",
            startedAt: input.now,
            completedAt: input.now,
            updatedAt: input.now,
          },
        })),
      ],
    });
  });

it.layer(layerTest)("delegated completion delivery repairs", (it) => {
  it.effect(
    "interrupting a completion wake disposes both cohorts without reviving them on late results",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("stop-wake-parent");
        const originRunId = RunId.make("stop-wake-origin");
        const incomingTaskId = NodeId.make("stop-wake-incoming");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId: ProjectId.make("stop-wake-project"),
          runId: originRunId,
          rootNodeId: NodeId.make("stop-wake-origin-root"),
          taskId: incomingTaskId,
          deliveryState: "claimed",
          deliveryTaskIds: [incomingTaskId],
          completionWake: "always",
          now,
        });
        const origin = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* sink.write({
          events: [
            {
              ...runEvent({ threadId, runId: originRunId, ordinal: 1, status: "completed", now }),
              payload: { ...origin, status: "completed", completedAt: now },
            },
          ],
        });
        const delivery = origin.delegatedCompletion!.delivery!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make("stop-wake-start"),
          threadId,
          messageId: delivery.messageId,
          text: "Delegated task completed",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
          delegatedCompletion: {
            parentRunId: originRunId,
            generation: delivery.generation,
            taskIds: delivery.taskIds,
          },
        });
        yield* orchestrator.resumeQueuedRuns;
        const wake = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === delivery.messageId,
        )!;
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make("stop-wake-delegate"),
          parentThreadId: threadId,
          parentRunId: wake.id,
          parentNodeId: wake.rootNodeId!,
          task: "Do the next round",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
        });
        const delegated = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.runId === wake.id,
        )!;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop-wake-interrupt"),
          threadId,
          runId: wake.id,
        });
        const stopped = yield* orchestrator.getThreadProjection(threadId);
        for (const runId of [originRunId, wake.id]) {
          const run = stopped.runs.find((row) => row.id === runId)!;
          assert.equal(run.delegatedCompletion?.disposition, "stopped");
          assert.isNull(run.delegatedCompletion?.delivery);
        }
        assert.equal(stopped.runs.find((run) => run.id === wake.id)?.status, "interrupted");
        for (const taskId of [incomingTaskId, delegated.id]) {
          assert.equal(
            stopped.subagents.find((task) => task.id === taskId)?.completionDelivery?.state,
            "disposed",
          );
        }
        assert.equal(
          stopped.subagents.find((task) => task.id === incomingTaskId)?.result,
          "child finished",
        );

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("stop-wake-newer-work"),
          threadId,
          messageId: MessageId.make("stop-wake-newer-work"),
          text: "Start unrelated work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });
        yield* orchestrator.resumeQueuedRuns;
        const newer = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(newer.runs.at(-1)?.status, "starting");

        const childThreadId = delegated.childThreadId!;
        const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
        const afterSequence = yield* sink.latestSequence();
        yield* sink.write({
          events: [
            {
              ...runEvent({
                threadId: childThreadId,
                runId: childRun.id,
                ordinal: childRun.ordinal,
                status: "completed",
                now,
              }),
              payload: { ...childRun, status: "completed", completedAt: now },
            },
          ],
        });
        yield* sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === delegated.id &&
              stored.event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const finished = yield* orchestrator.getThreadProjection(threadId);
        const lateTask = finished.subagents.find((task) => task.id === delegated.id)!;
        assert.equal(lateTask.status, "completed");
        assert.isNotNull(lateTask.result);
        assert.equal(lateTask.completionDelivery?.state, "disposed");
        assert.deepEqual(finished.runs, newer.runs);
        assert.deepEqual(finished.messages, newer.messages);
      }),
  );

  it.effect(
    "treats repeated acknowledge and dispose with distinct command IDs as successful no-ops",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:delegated-delivery-a2");
        const projectId = ProjectId.make("project:delegated-delivery-a2");
        const runId = RunId.make("run:delegated-delivery-a2");
        const rootNodeId = NodeId.make("node:delegated-delivery-a2-root");
        const taskId = NodeId.make("node:delegated-delivery-a2-task");

        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId,
          deliveryState: "delivered",
          completionWake: "always",
          now,
        });

        const firstAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-task-status"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const secondAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-thread-read"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });

        const firstAckTask = firstAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondAckTask = secondAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstAckTask);
        assert.isDefined(secondAckTask);
        if (
          firstAckTask?.event.type !== "subagent.updated" ||
          secondAckTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Acknowledge events missing."));
        }
        assert.equal(firstAckTask.event.payload.completionDelivery?.state, "acknowledged");
        assert.equal(secondAckTask.event.payload.completionDelivery?.state, "acknowledged");
        assert.deepEqual(
          secondAckTask.event.payload.completionDelivery,
          firstAckTask.event.payload.completionDelivery,
        );
        assert.deepEqual(
          secondAckTask.event.payload.updatedAt,
          firstAckTask.event.payload.updatedAt,
        );
        assert.equal(secondAck.storedEvents.length, 1);

        const afterAck = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterAck.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "acknowledged",
            observedByRunId: runId,
          },
        );

        const firstDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-task-status"),
          parentThreadId: threadId,
          taskId,
        });
        const secondDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-thread-read"),
          parentThreadId: threadId,
          taskId,
        });

        const firstDisposeTask = firstDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondDisposeTask = secondDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstDisposeTask);
        assert.isDefined(secondDisposeTask);
        if (
          firstDisposeTask?.event.type !== "subagent.updated" ||
          secondDisposeTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Dispose events missing."));
        }
        assert.equal(firstDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.equal(secondDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.deepEqual(
          secondDisposeTask.event.payload.completionDelivery,
          firstDisposeTask.event.payload.completionDelivery,
        );
        assert.equal(secondDispose.storedEvents.length, 1);

        const afterDispose = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterDispose.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );

        const acknowledgeAfterDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-after-dispose"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const acknowledgedTask = acknowledgeAfterDispose.storedEvents.find(
          (stored) => stored.event.type === "subagent.updated",
        );
        if (acknowledgedTask?.event.type !== "subagent.updated") {
          return yield* Effect.die(new Error("Acknowledge-after-dispose event missing."));
        }
        assert.deepEqual(acknowledgedTask.event.payload.completionDelivery, {
          state: "disposed",
          observedByRunId: null,
        });
        assert.equal(acknowledgeAfterDispose.storedEvents.length, 1);

        const afterStaleAcknowledge = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterStaleAcknowledge.subagents.find((candidate) => candidate.id === taskId)
            ?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );
      }),
  );

  it.effect.each([
    { command: "acknowledge", before: "running", after: "failed", capture: false },
    { command: "acknowledge", before: "waiting", after: "completed", capture: true },
    { command: "accept", before: "waiting", after: "completed", capture: true },
    { command: "wake-policy", before: "running", after: "completed", capture: true },
  ] as const)(
    "keeps a $after run that settled between $command's read and commit",
    ({ command, before, after, capture }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const race = `${command}-settle-race-${after}`;
        const threadId = ThreadId.make(`thread:${race}`);
        const runId = RunId.make(`run:${race}`);
        const taskId = NodeId.make(`node:${race}-task`);
        const checkpointId = CheckpointId.make(`checkpoint:${race}`);
        const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
        const commandType = {
          acknowledge: "delegated_task.completion-delivery.acknowledge",
          accept: "notification.delivery.accept",
          "wake-policy": "delegated_task.wake-policy",
        }[command];
        yield* seedParentWithTerminalTask({
          threadId,
          projectId: ProjectId.make(`project:${race}`),
          runId,
          rootNodeId: NodeId.make(`node:${race}-root`),
          taskId,
          ...(command === "wake-policy"
            ? { deliveryState: "pending" }
            : { deliveryState: "claimed", deliveryTaskIds: [taskId] }),
          now,
        });
        const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:${race}-before`),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: { ...parent, status: before },
            },
            {
              id: EventId.make(`event:${race}-message`),
              type: "message.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: messageId,
                threadId,
                runId,
                nodeId: parent.rootNodeId,
                role: "user",
                text: "Background task finished",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "server",
                createdAt: now,
                updatedAt: now,
                delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
              },
            },
          ],
        });
        const { delegatedCompletion: _cohort, ...settledRun } = parent;
        const commit = sink.commitCommand;
        let settled = false;
        let planned: OrchestrationV2Run["delegatedCompletion"];
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi.spyOn(sink, "commitCommand").mockImplementation((input) =>
              Effect.gen(function* () {
                if (!settled && input.commandType === commandType) {
                  settled = true;
                  const plannedRun = input.events.find((event) => event.type === "run.updated");
                  planned =
                    plannedRun?.type === "run.updated"
                      ? plannedRun.payload.delegatedCompletion
                      : undefined;
                  // The provider turn ends (or its checkpoint lands) after the command read the run.
                  yield* commit({
                    commandId: CommandId.make(`command:${race}`),
                    threadId,
                    commandType: capture ? "checkpoint.capture" : "provider.event",
                    acceptedAt: now,
                    effects: [],
                    events: [
                      {
                        id: EventId.make(`event:${race}-settled`),
                        type: "run.updated",
                        threadId,
                        runId,
                        occurredAt: now,
                        payload: {
                          ...settledRun,
                          status: after,
                          completedAt: now,
                          checkpointId: capture ? checkpointId : null,
                        },
                      },
                    ],
                  });
                }
                return yield* commit(input);
              }),
            ),
          ),
          () =>
            orchestrator.dispatch(
              command === "accept"
                ? {
                    type: "notification.delivery.accept",
                    commandId: CommandId.make(`command:${race}:accept`),
                    threadId,
                    messageId,
                  }
                : command === "wake-policy"
                  ? {
                      type: "delegated_task.wake-policy",
                      commandId: CommandId.make(`command:${race}:wake-policy`),
                      parentThreadId: threadId,
                      taskId,
                      completionWake: "always",
                    }
                  : {
                      type: "delegated_task.completion-delivery.acknowledge",
                      commandId: CommandId.make(`command:${race}:task-status`),
                      parentThreadId: threadId,
                      taskId,
                      observedByRunId: runId,
                    },
            ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        assert.isTrue(settled);
        const finished = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          finished.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
          { acknowledge: "acknowledged", accept: "delivered", "wake-policy": "claimed" }[command],
        );
        const run = finished.runs.find((candidate) => candidate.id === runId)!;
        assert.deepEqual(
          {
            status: run.status,
            completedAt: run.completedAt,
            checkpointId: run.checkpointId,
            delegatedCompletion: run.delegatedCompletion,
          },
          {
            status: after,
            completedAt: now,
            checkpointId: capture ? checkpointId : null,
            delegatedCompletion: planned,
          },
        );
      }),
  );
});

const reconcileCommandId = (name: string) => CommandId.make(`command:runtime-reconcile:${name}`);

const runEvent = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
  readonly providerThreadId?: ProviderThreadId;
  readonly userMessageId?: MessageId;
  readonly delegatedCompletion?: OrchestrationV2Run["delegatedCompletion"];
}) => ({
  id: EventId.make(`event:${input.runId}:${input.status}`),
  type: "run.updated" as const,
  threadId: input.threadId,
  runId: input.runId,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: input.now,
  payload: {
    id: input.runId,
    threadId: input.threadId,
    ordinal: input.ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: input.providerThreadId ?? null,
    userMessageId: input.userMessageId ?? MessageId.make(`message:${input.runId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: input.status,
    requestedAt: input.now,
    startedAt: input.now,
    completedAt: input.status === "running" ? null : input.now,
    checkpointId: null,
    contextHandoffId: null,
    ...(input.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: input.delegatedCompletion }),
  },
});

const seedRestartCancelledChild = (input: {
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentRunId: RunId;
  readonly rootNodeId: NodeId;
  readonly name: string;
  readonly completionWake: "always" | "settled_only";
  readonly continuationPending: boolean;
  readonly runStatus?: "cancelled" | "completed" | "interrupted";
  readonly lostWork?: OrchestrationV2Run["restartCancelledBackgroundWork"];
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const taskId = NodeId.make(`node:${input.name}`);
    const childThreadId = ThreadId.make(`thread:${input.name}`);
    const childRunId = RunId.make(`run:${input.name}:1`);
    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-child:${input.name}`),
      events: [
        {
          id: EventId.make(`event:${input.name}:thread`),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: input.now,
          payload: {
            createdBy: "agent",
            creationSource: "server",
            id: childThreadId,
            projectId: input.projectId,
            title: input.name,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: input.parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: input.parentThreadId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
            createdAt: input.now,
            updatedAt: input.now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        {
          id: EventId.make(`event:${input.name}:task`),
          type: "subagent.updated",
          threadId: input.parentThreadId,
          runId: input.parentRunId,
          nodeId: taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: taskId,
            threadId: input.parentThreadId,
            runId: input.parentRunId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: `Run ${input.name}.`,
            title: null,
            model: null,
            completionWake: input.completionWake,
            status: "running",
            result: null,
            startedAt: input.now,
            completedAt: null,
            updatedAt: input.now,
          },
        },
      ],
    });
    const childRun = runEvent({
      threadId: childThreadId,
      runId: childRunId,
      ordinal: 1,
      status: input.runStatus ?? "cancelled",
      now: input.now,
    });
    yield* eventSink.writeWithEffects({
      commandId: reconcileCommandId(input.name),
      events: [
        input.lostWork === undefined
          ? childRun
          : {
              ...childRun,
              payload: { ...childRun.payload, restartCancelledBackgroundWork: input.lostWork },
            },
      ],
      effects: input.continuationPending
        ? [
            {
              id: `effect:restart-continuation:${childRunId}`,
              commandId: reconcileCommandId(input.name),
              threadId: childThreadId,
              request: { type: "provider-runtime.continue", sourceRunId: childRunId },
            },
          ]
        : [],
    });
    return { taskId, childThreadId, childRunId };
  });

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "subagent follow-ups",
  (it) => {
    it.effect("recovers a reserved delivery without loading conversation history", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:bounded-delivery-recovery");
        const runId = RunId.make("run:bounded-delivery-recovery");
        const taskId = NodeId.make("task:bounded-delivery-recovery");
        yield* seedParentWithTerminalTask({
          threadId,
          runId,
          taskId,
          projectId: ProjectId.make("project:bounded-delivery-recovery"),
          rootNodeId: NodeId.make("node:bounded-delivery-recovery"),
          deliveryState: "claimed",
          deliveryTaskIds: [taskId],
          completionWake: "always",
          now,
        });
        for (const suffix of ["first", "second"]) {
          yield* sink.write({
            events: [
              {
                id: EventId.make(`event:bounded-delivery-history:${suffix}`),
                type: "message.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`message:bounded-delivery-history:${suffix}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  createdBy: "user",
                  creationSource: "web",
                  role: "user",
                  text: "Unrelated historical input",
                  attachments: [],
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        }
        const statements: string[] = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              const query = span.attributes.get("db.query.text");
              if (typeof query === "string") statements.push(query);
            };
            return span;
          },
        });
        yield* orchestrator.recoverDelegatedTasks.pipe(Effect.withTracer(tracer));
        assert.isFalse(statements.some((query) => query.includes("MIN(ordinal)")));
        const messageReads = statements.filter((query) =>
          query.includes("FROM orchestration_v2_projection_messages"),
        );
        assert.isNotEmpty(messageReads);
        assert.isTrue(messageReads.every((query) => query.includes("message_id IN")));
        const wake = yield* requests.take;
        assert.equal(wake.delegatedCompletion?.parentRunId, runId);
      }),
    );
    it.effect("keeps a checkpoint completion committed between finalize's read and write", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:completion-capture-race");
        const projectId = ProjectId.make("project:completion-capture-race");
        const runId = RunId.make("run:completion-capture-race");
        const rootNodeId = NodeId.make("node:completion-capture-race");
        const checkpointId = CheckpointId.make("checkpoint:completion-capture-race");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make("node:completion-capture-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const waiting = { ...parent, status: "waiting" as const };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:completion-capture-waiting"),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: waiting,
            },
          ],
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: "completion-capture-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        const write = sink.writeWithEffects;
        let captured = false;
        const committedParentRuns: Array<OrchestrationV2Run> = [];
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi.spyOn(sink, "writeWithEffects").mockImplementation((input) =>
              Effect.gen(function* () {
                if (
                  !captured &&
                  input.events.some(
                    (event) =>
                      event.type === "run.updated" &&
                      event.payload.id === runId &&
                      event.payload.delegatedCompletion?.delivery != null,
                  )
                ) {
                  captured = true;
                  // Commit capture after finalize planned its stale waiting snapshot.
                  const { delegatedCompletion: _cohort, ...captureRun } = waiting;
                  yield* sink.commitCommand({
                    commandId: CommandId.make("command:completion-capture-race"),
                    threadId,
                    commandType: "checkpoint.capture",
                    acceptedAt: now,
                    effects: [],
                    events: [
                      {
                        id: EventId.make("event:completion-capture-completed"),
                        type: "run.updated",
                        threadId,
                        runId,
                        occurredAt: now,
                        payload: {
                          ...captureRun,
                          status: "completed",
                          completedAt: now,
                          checkpointId,
                        },
                      },
                    ],
                  });
                }
                const stored = yield* write(input);
                for (const { event } of stored) {
                  if (event.type === "run.updated" && event.payload.id === runId) {
                    committedParentRuns.push(event.payload);
                  }
                }
                return stored;
              }),
            ),
          ),
          () => orchestrator.recoverDelegatedTasks,
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        assert.isTrue(captured);
        assert.equal(committedParentRuns.length, 1);
        const committedParentRun = committedParentRuns[0];
        assert.equal(committedParentRun?.status, "completed");
        assert.deepEqual(committedParentRun?.completedAt, now);
        assert.equal(committedParentRun?.checkpointId, checkpointId);
        assert.deepEqual(committedParentRun?.delegatedCompletion?.delivery?.taskIds, [
          child.taskId,
        ]);
        const finished = yield* orchestrator.getThreadProjection(threadId);
        const completed = finished.runs.find((run) => run.id === runId)!;
        assert.equal(completed.status, "completed");
        assert.deepEqual(completed.completedAt, now);
        assert.equal(completed.checkpointId, checkpointId);
        assert.deepEqual(completed.delegatedCompletion?.delivery?.taskIds, [child.taskId]);
        const wake = yield* requests.take;
        assert.equal(wake.delegatedCompletion?.parentRunId, runId);
        const delivery = completed.delegatedCompletion!.delivery!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make("command:completion-capture-delivery"),
          threadId,
          messageId: delivery.messageId,
          text: "Child finished",
          attachments: [],
          delegatedCompletion: {
            parentRunId: runId,
            generation: delivery.generation,
            taskIds: delivery.taskIds,
          },
          dispatchMode: { type: "queue_after_active" },
        });
        const delivered = yield* orchestrator.getThreadProjection(threadId);
        const deliveryRun = delivered.runs.find((run) => run.userMessageId === delivery.messageId);
        assert.isDefined(deliveryRun);
        assert.notEqual(deliveryRun?.status, "queued");
      }),
    );
  },
);

it.layer(layerTest)("delegated tasks across a server restart", (it) => {
  it.effect.each([
    { name: "releases", key: "", pendingBackgroundTasks: [], released: true },
    {
      name: "keeps while an unawaited background command runs",
      key: "-background",
      pendingBackgroundTasks: [{ taskId: "dev-server", kind: "command" as const }],
      released: false,
    },
  ])(
    "queues a child result without creating a provider history handoff and $name its process",
    ({ key, pendingBackgroundTasks, released }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`thread:result-message${key}-parent`);
        const projectId = ProjectId.make(`project:result-message${key}`);
        const runId = RunId.make(`run:result-message${key}-parent`);
        const rootNodeId = NodeId.make(`node:result-message${key}-parent`);
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make(`node:result-message${key}-seed`),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: `result-message${key}-child`,
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        const parent = yield* orchestrator.getThreadProjection(threadId);
        const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
        const providerThreadId = ProviderThreadId.make(
          `provider-thread:result-message${key}-child`,
        );
        yield* eventSink.write({
          commandId: CommandId.make(`command:result-message${key}-child-provider`),
          events: [
            {
              id: EventId.make(`event:result-message${key}-child-session`),
              type: "provider-session.attached",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: {
                id: ProviderSessionId.make(`provider-session:result-message${key}-child`),
                driver,
                providerInstanceId: modelSelection.instanceId,
                status: "ready",
                cwd: "/repo",
                model: modelSelection.model,
                capabilities: {
                  ...CodexProviderCapabilitiesV2,
                  sessions: {
                    ...CodexProviderCapabilitiesV2.sessions,
                    supportsMultipleProviderThreadsPerSession: false,
                  },
                },
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
            },
            {
              id: EventId.make(`event:result-message${key}-child-provider`),
              type: "provider-thread.updated",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: {
                ...parent.providerThreads[0]!,
                id: providerThreadId,
                appThreadId: child.childThreadId,
                pendingBackgroundTasks,
              },
            },
            {
              id: EventId.make(`event:result-message${key}-child-run`),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: child.childRunId,
              occurredAt: now,
              payload: { ...childProjection.runs[0]!, providerThreadId },
            },
          ],
        });

        yield* orchestrator.recoverDelegatedTasks;
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        const task = recovered.subagents.find((candidate) => candidate.id === child.taskId)!;
        assert.equal(task.status, "completed");
        assert.isNotNull(task.result);
        assert.isEmpty(recovered.contextHandoffs);
        assert.equal(recovered.contextTransfers.length, 1);
        // A one-process-per-thread child releases its process once its result is recorded,
        // unless background work it did not await would die with it.
        assert.equal(
          (yield* orchestrator.getThreadProjection(child.childThreadId)).providerSessions.length,
          released ? 0 : 1,
        );

        const delivery = recovered.runs.find((candidate) => candidate.id === runId)!
          .delegatedCompletion!.delivery!;
        const messageId = delivery.messageId;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:result-message${key}-delivery`),
          threadId,
          messageId,
          text: "Delegated task finished.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: {
            parentRunId: runId,
            generation: delivery.generation,
            taskIds: [child.taskId],
          },
        });
        const queued = yield* orchestrator.getThreadProjection(threadId);
        assert.include(
          queued.messages.find((message) => message.id === messageId)?.text ?? "",
          task.result!,
        );
      }),
  );

  // regression: #34401 a parent's Stop killed a child's background build but its task read completed
  it.effect("reports a child its parent's Stop reached as interrupted", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const stoppedAt = DateTime.add(now, { seconds: 10 });
      const threadId = ThreadId.make("thread:stop-background-parent");
      const projectId = ProjectId.make("project:stop-background-parent");
      const runId = RunId.make("run:stop-background-parent");
      const rootNodeId = NodeId.make("node:stop-background-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:stop-background-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      // Background launches report their command finished at once; only the roster tracks the work.
      const seedStoppedChild = (name: string, parentStopped: boolean, reachedTurn: boolean) =>
        Effect.gen(function* () {
          const child = yield* seedRestartCancelledChild({
            parentThreadId: threadId,
            projectId,
            parentRunId: runId,
            rootNodeId,
            name,
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          const item = {
            threadId: child.childThreadId,
            runId: child.childRunId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
          };
          const scope = {
            type: "turn-item.updated" as const,
            threadId: child.childThreadId,
            runId: child.childRunId,
            providerInstanceId: modelSelection.instanceId,
          };
          yield* eventSink.write({
            commandId: CommandId.make(`command:${name}:stop`),
            events: [
              {
                ...scope,
                id: EventId.make(`event:${name}:command`),
                occurredAt: now,
                payload: {
                  ...item,
                  id: TurnItemId.make(`turn-item:${name}:command`),
                  type: "command_execution",
                  ordinal: 1,
                  status: "completed",
                  title: "Run build",
                  input: "./build.sh",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
              },
              {
                ...scope,
                id: EventId.make(`event:${name}:interrupt-request`),
                occurredAt: stoppedAt,
                payload: {
                  ...item,
                  id: TurnItemId.make(`turn-item:${name}:interrupt-request`),
                  // Stop interrupting background work names its provider turn; an idle run's marker does not.
                  providerTurnId: reachedTurn ? ProviderTurnId.make(`provider-turn:${name}`) : null,
                  type: "run_interrupt_request",
                  ordinal: 2,
                  status: "completed",
                  title: "Interrupt requested",
                  startedAt: stoppedAt,
                  completedAt: stoppedAt,
                  updatedAt: stoppedAt,
                  message: "Stopped by user",
                },
              },
            ],
          });
          if (parentStopped) {
            const task = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
              (row) => row.id === child.taskId,
            )!;
            yield* eventSink.write({
              commandId: CommandId.make(`command:${name}:parent-stop`),
              events: [
                {
                  id: EventId.make(`event:${name}:disposed`),
                  type: "subagent.updated",
                  threadId,
                  runId,
                  nodeId: task.id,
                  driver,
                  providerInstanceId: modelSelection.instanceId,
                  occurredAt: stoppedAt,
                  payload: {
                    ...task,
                    completionDelivery: { state: "disposed", observedByRunId: null },
                    updatedAt: stoppedAt,
                  },
                },
              ],
            });
          }
          return child;
        });
      const cut = yield* seedStoppedChild("stop-background-cut", true, true);
      const idle = yield* seedStoppedChild("stop-background-idle", true, false);
      const finished = yield* seedStoppedChild("stop-background-finished", false, true);

      yield* orchestrator.recoverDelegatedTasks;

      const settled = yield* orchestrator.getThreadProjection(threadId);
      const statusOf = (taskId: NodeId) =>
        settled.subagents.find((row) => row.id === taskId)?.status;
      assert.equal(statusOf(cut.taskId), "interrupted");
      assert.equal(statusOf(idle.taskId), "completed");
      assert.equal(statusOf(finished.taskId), "completed");
    }),
  );

  it.effect("cancelling a task whose child already finished keeps its completed result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:cancel-finished-parent");
      const projectId = ProjectId.make("project:cancel-finished-parent");
      const runId = RunId.make("run:cancel-finished-parent");
      const rootNodeId = NodeId.make("node:cancel-finished-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:cancel-finished-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      // The child run finished, but its parent row has not been finalized yet.
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "cancel-finished-child",
        completionWake: "always",
        continuationPending: false,
        runStatus: "completed",
        now,
      });
      const stopReason = "sessionStart hook (user): Plugin guard blocked this session.";
      yield* eventSink.write({
        commandId: CommandId.make("command:cancel-finished-child:stop-reason"),
        events: [
          {
            id: EventId.make("event:cancel-finished-child:stop-reason"),
            type: "turn-item.updated",
            threadId: child.childThreadId,
            runId: child.childRunId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: IdAllocator.derive.runSignalTurnItem({
                runId: child.childRunId,
                signal: PROVIDER_STOP_REASON_SIGNAL,
              }),
              type: "system_notice",
              level: "warning",
              threadId: child.childThreadId,
              runId: child.childRunId,
              nodeId: rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 98,
              status: "completed",
              title: "Stopped by the provider",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              message: stopReason,
            },
          },
        ],
      });
      yield* orchestrator.cancelDelegatedTask({
        parentThreadId: threadId,
        taskId: child.taskId,
        command: {
          type: "thread.stop",
          commandId: CommandId.make("cancel-finished-child"),
          threadId: child.childThreadId,
          stopDelegatedTasks: false,
        },
        stopDescendants: () => Effect.void,
      });
      const task = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
        (row) => row.id === child.taskId,
      );
      assert.equal(task?.status, "completed");
      assert.equal(
        task?.result,
        `Child task completed without an assistant result.\n\n${stopReason}`,
      );
      assert.isUndefined(task?.cancelledRunId);

      // Codex 0.169 reports a hook-stopped turn as interrupted; its reason is the interrupt result.
      const interrupted = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "cancel-finished-interrupted-child",
        completionWake: "always",
        continuationPending: false,
        runStatus: "interrupted",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:cancel-finished-interrupted-child:result"),
        events: [
          {
            id: EventId.make("event:cancel-finished-interrupted-child:result"),
            type: "turn-item.updated",
            threadId: interrupted.childThreadId,
            runId: interrupted.childRunId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: IdAllocator.derive.runSignalTurnItem({
                runId: interrupted.childRunId,
                signal: "interrupt-result",
              }),
              type: "run_interrupt_result",
              threadId: interrupted.childThreadId,
              runId: interrupted.childRunId,
              nodeId: rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 98,
              status: "interrupted",
              title: "Interrupted",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              message: stopReason,
            },
          },
        ],
      });
      yield* orchestrator.cancelDelegatedTask({
        parentThreadId: threadId,
        taskId: interrupted.taskId,
        command: {
          type: "thread.stop",
          commandId: CommandId.make("cancel-finished-interrupted-child"),
          threadId: interrupted.childThreadId,
          stopDelegatedTasks: false,
        },
        stopDescendants: () => Effect.void,
      });
      const interruptedTask = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
        (row) => row.id === interrupted.taskId,
      );
      assert.equal(
        interruptedTask?.result,
        `Child task ended with status interrupted.\n\n${stopReason}`,
      );
    }),
  );

  it.effect("delivers the child's report when a run queued behind it ends without text", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:silent-queued-parent");
      const projectId = ProjectId.make("project:silent-queued-parent");
      const runId = RunId.make("run:silent-queued-parent");
      const rootNodeId = NodeId.make("node:silent-queued-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:silent-queued-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "silent-queued-child",
        completionWake: "always",
        continuationPending: false,
        runStatus: "completed",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:silent-queued-child:queued"),
        events: [
          {
            id: EventId.make("event:silent-queued-child:report"),
            type: "message.updated",
            threadId: child.childThreadId,
            runId: child.childRunId,
            occurredAt: now,
            payload: {
              id: MessageId.make("message:silent-queued-child:report"),
              threadId: child.childThreadId,
              runId: child.childRunId,
              nodeId: null,
              role: "assistant",
              text: "REPORT-OK",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
            },
          },
          runEvent({
            threadId: child.childThreadId,
            runId: RunId.make("run:silent-queued-child:2"),
            ordinal: 2,
            status: "completed",
            now,
          }),
        ],
      });
      yield* orchestrator.recoverDelegatedTask(child.childThreadId);
      const task = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
        (row) => row.id === child.taskId,
      );
      assert.equal(task?.status, "completed");
      assert.equal(task?.result, "REPORT-OK");
    }),
  );

  it.effect(
    "recovers an unpublished child failure after its completion delivery was disposed",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:unpublished-failure-parent");
        const projectId = ProjectId.make("project:unpublished-failure-parent");
        const runId = RunId.make("run:unpublished-failure-parent");
        const rootNodeId = NodeId.make("node:unpublished-failure-parent-root");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make("node:unpublished-failure-parent-settled"),
          deliveryState: "delivered",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: "unpublished-failure-child",
          completionWake: "always",
          continuationPending: false,
          now,
        });
        // Skip the live terminal listener to model a committed failure whose
        // publication was interrupted. task_cancel then disposed its delivery.
        yield* eventSink.write({
          commandId: reconcileCommandId("unpublished-failure"),
          events: [
            runEvent({
              threadId: child.childThreadId,
              runId: child.childRunId,
              ordinal: 1,
              status: "failed",
              now,
            }),
          ],
        });
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:unpublished-failure-dispose"),
          parentThreadId: threadId,
          taskId: child.taskId,
        });
        yield* orchestrator.recoverDelegatedTasks;
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        const task = recovered.subagents.find((row) => row.id === child.taskId);
        assert.equal(task?.status, "failed");
        assert.equal(task?.result, "Child task ended with status failed.");
        assert.equal(task?.completionDelivery?.state, "disposed");
        assert.lengthOf(recovered.runs, 1);
        assert.lengthOf(
          recovered.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
          1,
        );
        yield* orchestrator.recoverDelegatedTasks;
        assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), recovered);
      }),
  );
});
