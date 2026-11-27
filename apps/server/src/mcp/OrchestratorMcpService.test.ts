import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EnvironmentId,
  MessageId,
  NodeId,
  type Project,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
  ScheduledTaskId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@ankielcode/contracts";
import { checkpointWorkspace } from "@ankielcode/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import {
  OrchestratorDispatchError,
  OrchestratorThreadAboveModeLimitError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type { ProjectionRecordFilter } from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

describe("OrchestratorMcpService", () => {
  it.effect("retries terminal acknowledgement with a fresh command id", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
      const childThreadId = ThreadId.make("thread:mcp-ack-child");
      const childRunId = RunId.make("run:mcp-ack-child");
      const taskId = NodeId.make("node:mcp-ack-task");
      const resultTransferId = ContextTransferId.make("transfer:mcp-ack-result");
      const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const acknowledgementAttempts = yield* Ref.make(0);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            title: "Merge",
            driver: "codex",
            model: "gpt-5.6-terra",
            result: "terminal result",
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [
          {
            id: childRunId,
            ordinal: 1,
            status: "completed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:00:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
          {
            id: RunId.make("run:mcp-ack-continuation"),
            ordinal: 2,
            status: "failed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:02:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00Z"),
          },
        ],
        contextTransfers: [
          {
            id: resultTransferId,
            type: "subagent_result",
            sourceThreadId: childThreadId,
            targetThreadId: parentThreadId,
            sourcePoint: { runId: childRunId },
          },
        ],
        messages: [
          {
            id: MessageId.make("message:mcp-ack-result"),
            runId: childRunId,
            role: "assistant",
            text: "terminal result",
            createdAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
            updatedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
        ],
        turnItems: [],
        subagents: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let hasNestedWork = true;
      let settleAfterTaskRead = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.sync(() => {
              if (threadId !== parentThreadId) {
                return hasNestedWork
                  ? {
                      ...childProjection,
                      contextTransfers: [],
                      subagents: [
                        { ...parentProjection.subagents[0]!, status: "running" as const },
                      ],
                    }
                  : childProjection;
              }
              const snapshot = hasNestedWork
                ? {
                    ...parentProjection,
                    subagents: parentProjection.subagents.map((task) => ({
                      ...task,
                      result: null,
                      status: "running" as const,
                    })),
                  }
                : parentProjection;
              if (settleAfterTaskRead) {
                settleAfterTaskRead = false;
                hasNestedWork = false;
              }
              return snapshot;
            }),
          delegatedTaskResultPending: () => Effect.succeed(false),
          dispatch: (command) =>
            Ref.update(acknowledgementCommandIds, (commandIds) => [
              ...commandIds,
              String(command.commandId),
            ]).pipe(
              Effect.andThen(Ref.updateAndGet(acknowledgementAttempts, (count) => count + 1)),
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(new Error("simulated acknowledgement failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-ack"),
        requestNamespace: "provider-session:mcp-ack",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-ack",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const pending = yield* service.taskStatus(scope, taskId);
        assert.equal(pending.status, "running");
        assert.equal(pending.workState, "waiting_for_children");
        assert.isNull(pending.summary);
        assert.isNull(pending.resultContextTransferId);
        assert.equal(yield* Ref.get(acknowledgementAttempts), 0);
        hasNestedWork = false;
        const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(error.code, "orchestration_error");

        // Completion lands after task selection, before the remaining parent/child reads.
        hasNestedWork = true;
        settleAfterTaskRead = true;
        const result = yield* service.taskStatus(scope, taskId);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "terminal result");
        assert.equal(result.latestTerminalRunId, childRunId);
        assert.equal(result.latestTerminalStatus, "completed");
        assert.equal(result.resultContextTransferId, resultTransferId);
        const commandIds = yield* Ref.get(acknowledgementCommandIds);
        assert.equal(commandIds.length, 2);
        assert.notEqual(commandIds[0], commandIds[1]);

        const missing = yield* service
          .taskStatus(scope, NodeId.make("node:mcp-ack-missing"))
          .pipe(Effect.flip);
        assert.equal(missing.code, "task_not_found");
        assert.include(missing.message, "No delegated task with id node:mcp-ack-missing");
        assert.include(missing.message, `${taskId} (Merge)`);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("does not dispose delivery when the child stop fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(Effect.fail(new Error("simulated stop failure") as never)),
            ),
          stopDelegatedTasks: () => Effect.void,
          cancelDelegatedTask: ({ command, stopDescendants }) =>
            stopDescendants(() => Effect.die("No remote descendants in this test")).pipe(
              Effect.andThen(Ref.update(dispatched, (commands) => [...commands, command])),
              Effect.andThen(
                Effect.fail(
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: new Error("simulated stop failure"),
                  }) as never,
                ),
              ),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-failed"),
        requestNamespace: "provider-session:mcp-cancel-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-failed-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.equal(
          error.message,
          `Unable to stop delegated task ${taskId}: simulated stop failure`,
        );
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses to cancel a task whose child now runs above the parent's modes", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId, runtimeMode: "approval-required", interactionMode: "plan" },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child" },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
          cancelDelegatedTask: ({ command, stopDescendants }) =>
            stopDescendants(() => Effect.die("No remote descendants in this test")).pipe(
              Effect.andThen(Ref.update(dispatched, (commands) => [...commands, command])),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-above-modes" })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  const cancelOverRaisedGrandchild = (child: {
    readonly deleted: boolean;
    readonly raisedDuringStop?: boolean;
  }) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-grandchild-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-grandchild-child");
      const grandchildThreadId = ThreadId.make("thread:mcp-cancel-grandchild-grandchild");
      const taskId = NodeId.make("node:mcp-cancel-grandchild-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const stoppedBelow = yield* Ref.make(false);
      const subagentReads = yield* Ref.make<ReadonlyArray<ProjectionRecordFilter | undefined>>([]);
      const appOwnedTask = (
        id: string,
        threadId: ThreadId,
        childId: ThreadId,
        settled?: "settled",
      ) => ({
        id: NodeId.make(id),
        threadId,
        origin: "app_owned",
        childThreadId: childId,
        driver: "codex",
        model: "gpt-5.6-terra",
        status: settled === undefined ? "running" : "completed",
        result: settled === undefined ? null : "Done.",
        completionDelivery: { state: settled === undefined ? "pending" : "delivered" },
      });
      // Older tasks the parent and child dispatched and that have long settled.
      const settledThreadId = ThreadId.make("thread:mcp-cancel-grandchild-settled");
      const projections = new Map([
        [
          parentThreadId,
          {
            thread: {
              id: parentThreadId,
              runtimeMode: "approval-required",
              interactionMode: "default",
            },
            runs: [],
            contextTransfers: [],
            subagents: [
              appOwnedTask(
                "node:mcp-cancel-grandchild-old",
                parentThreadId,
                settledThreadId,
                "settled",
              ),
              appOwnedTask(taskId, parentThreadId, childThreadId),
            ],
          },
        ],
        [
          childThreadId,
          {
            thread: { id: childThreadId, title: "Child" },
            runs: [{ id: RunId.make("run:mcp-cancel-grandchild-child"), status: "running" }],
            contextTransfers: [],
            messages: [],
            subagents: [
              appOwnedTask(
                "node:mcp-cancel-grandchild-done",
                childThreadId,
                settledThreadId,
                "settled",
              ),
              appOwnedTask("node:mcp-cancel-grandchild-below", childThreadId, grandchildThreadId),
            ],
            providerThreads: [],
            providerTurns: [],
            runtimeRequests: [],
          },
        ],
        [
          settledThreadId,
          {
            thread: { id: settledThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
        [
          grandchildThreadId,
          {
            thread: { id: grandchildThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            providerTurns: [],
            runtimeRequests: [],
          },
        ],
      ]) as unknown as ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId, fields, filter) =>
            ((fields as ReadonlyArray<string>).includes("subagents")
              ? Ref.update(subagentReads, (reads) => [...reads, filter])
              : Effect.void
            ).pipe(Effect.as(projections.get(threadId)!)),
          listAppOwnedChildThreadIds: (threadId) =>
            Effect.succeed(
              projections
                .get(threadId)!
                .subagents.flatMap((task) =>
                  task.origin === "app_owned" && task.childThreadId !== null
                    ? [task.childThreadId]
                    : [],
                ),
            ),
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === grandchildThreadId && child.raisedDuringStop !== true
                ? liveThreadShell(threadId)
                : threadId === childThreadId && child.deleted
                  ? null
                  : liveThreadShell(threadId, { runtimeMode: "approval-required" }),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
          cancelDelegatedTask: ({ command, stopDescendants }) =>
            stopDescendants(() => Effect.die("No remote descendants in this test")).pipe(
              Effect.andThen(Ref.update(dispatched, (commands) => [...commands, command])),
            ),
          stopDelegatedTasks: () =>
            Effect.gen(function* () {
              const limit = yield* DispatchModeLimit;
              if (child.raisedDuringStop === true && limit?.refused !== undefined) {
                const refusal: DispatchModeRefusal = {
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                };
                yield* Ref.set(limit.refused, refusal);
                return yield* new OrchestratorThreadAboveModeLimitError({
                  commandId: CommandId.make("stop-grandchild"),
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                });
              }
              yield* Ref.set(stoppedBelow, true);
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-grandchild"),
        requestNamespace: "provider-session:mcp-cancel-grandchild",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-grandchild",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      return yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-grandchild-above-modes" })
          .pipe(Effect.flip);
        // No read decodes every task a thread has dispatched.
        for (const filter of yield* Ref.get(subagentReads)) {
          assert.isTrue(
            filter?.subagentIds !== undefined || filter?.omitSettledSubagents !== undefined,
          );
        }
        return {
          code: error.code,
          dispatched: yield* Ref.get(dispatched),
          stoppedBelow: yield* Ref.get(stoppedBelow),
        };
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    });

  it.effect("refuses to cancel a task when a task under it now runs above the parent's modes", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: false }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );
});

describe("OrchestratorMcpService provider resolution", () => {
  const parentThreadId = ThreadId.make("thread:mcp-providers-parent");
  const childThreadId = ThreadId.make("thread:mcp-providers-child");
  const parentRunId = RunId.make("run:mcp-providers-parent");
  const parentNodeId = NodeId.make("node:mcp-providers-root");
  const taskId = NodeId.make("node:mcp-providers-task");
  const projectId = ProjectId.make("project:mcp-providers");
  const codexInstanceId = ProviderInstanceId.make("codex");

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-providers"),
    requestNamespace: "provider-session:mcp-providers",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-providers",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const providerSnapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model?: string;
    readonly enabled?: boolean;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: input.enabled !== false,
    version: input.enabled === false ? null : "test",
    status: input.enabled === false ? "disabled" : "ready",
    auth: { status: input.enabled === false ? "unknown" : "authenticated" },
    ...(input.enabled === false
      ? { message: "Provider is disabled in Ankiel Code settings." }
      : {}),
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  const providerRegistryLayer = (providers: ReadonlyArray<ServerProvider>) =>
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      }),
    );

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } = { instanceId: codexInstanceId, model: "gpt-5.4" },
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP parent",
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: codexInstanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: { id: childThreadId, title: "Child" },
    runs: [],
    contextTransfers: [],
    messages: [],
    subagents: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  it.effect("leaves a result undelivered when the caller goes away after its wait times out", () =>
    Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>();
      const upgrading = yield* Deferred.make<void>();
      const finishUpgrade = yield* Deferred.make<void>();
      const dispatched = yield* Ref.make<ReadonlyArray<{ readonly type: string }>>([]);
      let task: Record<string, unknown> = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        providerInstanceId: codexInstanceId,
        driver: "codex",
        childThreadId,
        model: "gpt-5.4",
        status: "running",
        result: null,
      };
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.sync(() =>
              threadId === parentThreadId ? parentProjection([task]) : childProjection,
            ),
          getThreadEventSequence: () => Effect.succeed(0),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: () =>
            Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.wake-policy"
                  ? Deferred.succeed(upgrading, undefined).pipe(
                      Effect.andThen(Deferred.await(finishUpgrade)),
                    )
                  : Effect.void,
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
              } as never),
            ),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const waiting = yield* service
          .delegateTask(scope, { task: "Review the change.", mode: "wait", timeoutMs: 500 })
          .pipe(Effect.forkChild);
        yield* Deferred.await(subscribed);
        yield* TestClock.adjust(Duration.millis(500));
        yield* Deferred.await(upgrading);
        yield* Effect.sync(() => waiting.interruptUnsafe());
        task = { ...task, status: "completed", result: "Reviewed." };
        yield* Deferred.succeed(finishUpgrade, undefined);
        yield* Fiber.await(waiting);
        assert.notInclude(
          (yield* Ref.get(dispatched)).map((command) => command.type),
          "delegated_task.completion-delivery.acknowledge",
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect.each([
    { name: "ten-minute default", timeoutMs: undefined, budgetMs: 600_000 },
    { name: "one-hour maximum", timeoutMs: 3_600_000, budgetMs: 3_600_000 },
  ])("keeps a secret request pending for its $name", (scenario) =>
    Effect.gen(function* () {
      const pending = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<void>();
      const statuses = yield* Ref.make<ReadonlyArray<string>>([]);
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed({ ...parentProjection([]), turnItems: [] }),
          dispatch: (command) => {
            if (command.type !== "secret_request.record") return Effect.die("Unexpected command");
            return Ref.update(statuses, (values) => [...values, command.secretStatus]).pipe(
              Effect.andThen(Deferred.succeed(pending, undefined)),
              Effect.as({} as never),
            );
          },
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([]),
        adapterRegistryLayer([]),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const waiting = yield* service
          .requestSecret(scope, {
            label: "Token",
            reason: "Connect the account.",
            ...(scenario.timeoutMs === undefined ? {} : { timeoutMs: scenario.timeoutMs }),
          })
          .pipe(
            Effect.tap(() => Deferred.succeed(returned, undefined)),
            Effect.forkChild,
          );
        yield* Deferred.await(pending);
        yield* TestClock.adjust(Duration.millis(scenario.budgetMs - 1));
        assert.isFalse(yield* Deferred.isDone(returned));
        assert.deepEqual(yield* Ref.get(statuses), ["pending"]);
        yield* TestClock.adjust(Duration.millis(1));
        assert.include(yield* Fiber.join(waiting), { status: "timed_out" });
        assert.deepEqual(yield* Ref.get(statuses), ["pending", "cancelled"]);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  // Command receipts dedupe by commandId, so a later run reusing the identity gets no card.
  it.effect("opens a new secret card when a later run reuses a clientRequestId", () =>
    Effect.gen(function* () {
      const runId = yield* Ref.make(parentRunId);
      const pending = yield* Queue.unbounded<{
        readonly commandId: CommandId;
        readonly turnItemId: string;
      }>();
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Ref.get(runId).pipe(
              Effect.map((id) => {
                const projection = parentProjection([]);
                return {
                  ...projection,
                  runs: projection.runs.map((run) => ({ ...run, id })),
                  turnItems: [],
                };
              }),
            ),
          dispatch: (command) => {
            if (command.type !== "secret_request.record") return Effect.die("Unexpected command");
            return (
              command.secretStatus === "pending"
                ? Queue.offer(pending, {
                    commandId: command.commandId,
                    turnItemId: command.turnItemId,
                  })
                : Effect.void
            ).pipe(Effect.as({} as never));
          },
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([]),
        adapterRegistryLayer([]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const ask = Effect.gen(function* () {
          const call = yield* service
            .requestSecret(scope, {
              label: "Router API key",
              reason: "Reads the firewall rules.",
              clientRequestId: "router-key",
              timeoutMs: 1_000,
            })
            .pipe(Effect.forkChild);
          const card = yield* Queue.take(pending);
          yield* TestClock.adjust(Duration.seconds(1));
          assert.include(yield* Fiber.join(call), { status: "timed_out" });
          return card;
        });

        const first = yield* ask;
        assert.deepEqual(yield* ask, first);
        yield* Ref.set(runId, RunId.make("run:mcp-providers-parent-later"));
        const later = yield* ask;
        assert.notEqual(later.commandId, first.commandId);
        assert.notEqual(later.turnItemId, first.turnItemId);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    }),
  );

  it.effect("rejects delegation to a provider without a registered adapter", () =>
    Effect.gen(function* () {
      const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
      const forkShadow = yield* buildUnavailableProviderSnapshot({
        driverKind: "forkOnly",
        instanceId: forkOnlyInstanceId,
        reason: "Driver 'forkOnly' is not registered in this build.",
        checkedAt: "2026-09-13T00:00:00.000Z",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          forkShadow,
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const byInstance = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: forkOnlyInstanceId },
            mode: "async",
            clientRequestId: "delegate-fork-1",
          })
          .pipe(Effect.flip);
        assert.equal(byInstance.code, "provider_unavailable");
        assert.isTrue(byInstance.message.includes("No V2 provider adapter is registered."));

        const byDriver = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("forkOnly") },
            mode: "async",
            clientRequestId: "delegate-fork-2",
          })
          .pipe(Effect.flip);
        assert.equal(byDriver.code, "provider_unavailable");
        assert.isTrue(
          byDriver.message.includes("No V2 provider adapter is registered for driver forkOnly."),
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "retrying an accepted driver-only delegation replays even after the project disables every candidate",
    () =>
      Effect.gen(function* () {
        const altInstanceId = ProviderInstanceId.make("codex-alt");
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const accepted = yield* Ref.make(false);
        const everyCandidateDisabled = yield* Ref.make(false);
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Ref.get(accepted).pipe(
                Effect.map((isAccepted) =>
                  threadId === parentThreadId
                    ? parentProjection(isAccepted ? [task] : [])
                    : childProjection,
                ),
              ),
            hasReceipt: () => Ref.get(accepted),
            isProviderInstanceEnabledForProject: () =>
              Ref.get(everyCandidateDisabled).pipe(Effect.map((disabled) => !disabled)),
            assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
              Effect.all([Ref.get(accepted), Ref.get(everyCandidateDisabled)]).pipe(
                Effect.flatMap(([isAccepted, disabled]) =>
                  isAccepted || !disabled
                    ? Effect.void
                    : Effect.fail(
                        new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                          projectId,
                          instanceId,
                        }),
                      ),
                ),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(Ref.set(accepted, true)),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: altInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId, altInstanceId]),
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          ServerSettings.layerTest(),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const first = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(first.status, "running");

          yield* Ref.set(everyCandidateDisabled, true);

          const retry = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(retry.status, "running");

          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 2);
          const retryCommand = commands[1] as {
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(retryCommand.modelSelection.instanceId, codexInstanceId);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect.each([
    { name: "parent instance", parentEnabled: true, model: "gpt-5.4" },
    { name: "alternate instance", parentEnabled: false, model: "gpt-5.5" },
  ])(
    "replays accepted creation on the $name without authorizing new disabled work",
    ({ parentEnabled, model }) =>
      Effect.gen(function* () {
        const altInstanceId = ProviderInstanceId.make("codex-alt");
        const driver = ProviderDriverKind.make("codex");
        const cwd = yield* checkpointWorkspace("mcp-create-retry");
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(
          [codexInstanceId, altInstanceId].map((instanceId) => ({
            instanceId,
            driver,
            getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
            openSession: () =>
              Effect.die("These tests exercise committed commands before provider execution."),
          })),
        );
        const layerDatabase = SqlitePersistence.layerMemory;
        const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
          { name: "mcp-create-retry", runtimePolicyOverride: { cwd } },
          layerRegistry,
          { databaseLayer: layerDatabase, runEffectWorker: false },
        );
        const layerSettings = ServerSettings.layerTest({
          providerInstances: {
            [codexInstanceId]: { driver: "codex", enabled: true },
            [altInstanceId]: { driver: "codex", enabled: true },
          },
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [codexInstanceId]: { enabled: parentEnabled } } },
          },
        });
        const layerThreads = ThreadManagementService.layer.pipe(
          Layer.provideMerge(layerOrchestrator),
          Layer.provide(
            LegacyV1ThreadImporter.layer.pipe(
              Layer.provide(layerOrchestrator),
              Layer.provide(layerDatabase),
            ),
          ),
          Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
          Layer.provideMerge(layerSettings),
        );
        const layerTest = layerOrchestratorService.pipe(
          Layer.provideMerge(layerThreads),
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              layerRegistry,
              layerSettings,
              providerRegistryLayer([
                providerSnapshot({ instanceId: codexInstanceId, driver, model: "gpt-5.4" }),
                providerSnapshot({ instanceId: altInstanceId, driver, model: "gpt-5.5" }),
              ]),
              Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "MCP parent",
            modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("parent:message"),
            text: "Create a thread.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const request = {
            threads: [{ target: { driverKind: driver, model } }],
            clientRequestId: "create-retry",
          };
          const first = yield* service.createThreads(scope, request);
          const child = first.threads[0]!;
          const selection = parentEnabled
            ? { instanceId: codexInstanceId, model: "gpt-5.4" }
            : { instanceId: altInstanceId, model: "gpt-5.5" };
          assert.equal(first.threads.length, 1);
          assert.equal(child.providerInstanceId, selection.instanceId);
          assert.equal(child.model, selection.model);
          assert.deepEqual(yield* service.createThreads(scope, request), first);

          // The creation receipt exists, but this prompt has not been accepted yet.
          const withPrompt = {
            ...request,
            threads: [{ ...request.threads[0]!, prompt: "Start work." }],
          };
          const started = yield* service.createThreads(scope, withPrompt);
          assert.equal(started.threads[0]?.threadId, child.threadId);
          const before = yield* orchestrator.getThreadProjection(child.threadId);
          assert.deepEqual(before.runs[0]?.modelSelection, selection);
          assert.equal(before.messages.length, 1);
          const empty = yield* service.createThreads(scope, {
            ...request,
            clientRequestId: "empty",
          });
          const raised = yield* service.createThreads(scope, {
            ...request,
            clientRequestId: "raised",
          });
          const raisedId = raised.threads[0]!.threadId;
          yield* orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("raise-created-thread"),
            threadId: raisedId,
            runtimeMode: "full-access",
          });
          const rejected = yield* service
            .createThreads(scope, { ...withPrompt, clientRequestId: "raised" })
            .pipe(Effect.flip);
          assert.equal(rejected.code, "runtime_mode_escalation_denied");
          assert.equal((yield* orchestrator.getThreadProjection(raisedId)).runs.length, 0);

          const emojiAtLimit = yield* service.createThreads(scope, {
            threads: [{ ...request.threads[0]!, prompt: `${"a".repeat(76)}😀 and more work.` }],
            clientRequestId: "emoji-title",
          });
          const titled = yield* orchestrator.getThreadProjection(emojiAtLimit.threads[0]!.threadId);
          assert.equal(titled.thread.title, `${"a".repeat(76)}...`);
          // One commit holds a prompted thread and its run, so no client sees it idle between.
          const promptedCommits = yield* orchestrator
            .streamStoredEventsFrom({ threadId: titled.thread.id })
            .pipe(
              Stream.filter(
                ({ event }) => event.type === "thread.created" || event.type === "run.created",
              ),
              Stream.take(2),
              Stream.runCollect,
            );
          assert.equal(promptedCommits[0]?.commandId, promptedCommits[1]?.commandId);

          yield* settings.updateSettings({
            projectSettingsOverrides: {
              [projectId]: {
                providerInstances: {
                  [codexInstanceId]: { enabled: false },
                  [altInstanceId]: { enabled: false },
                },
              },
            },
          });
          assert.deepEqual(yield* service.createThreads(scope, withPrompt), started);
          const after = yield* orchestrator.getThreadProjection(child.threadId);
          assert.deepEqual(after.thread.modelSelection, selection);
          assert.deepEqual(after.runs, before.runs);
          assert.deepEqual(after.messages, before.messages);

          const freshError = yield* service
            .createThreads(scope, {
              ...request,
              clientRequestId: "fresh",
            })
            .pipe(Effect.flip);
          assert.equal(freshError.code, "provider_unavailable");
          const promptError = yield* service
            .createThreads(scope, {
              ...withPrompt,
              clientRequestId: "empty",
            })
            .pipe(Effect.flip);
          assert.equal(promptError.code, "invalid_request");
          assert.include(promptError.message, "disabled");
          const untouched = yield* orchestrator.getThreadProjection(empty.threads[0]!.threadId);
          assert.equal(untouched.messages.length, 0);
          assert.equal(untouched.runs.length, 0);
        }).pipe(Effect.provide(layerTest));
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  describe("scheduled tasks at modes above the caller's", () => {
    const projectId = ProjectId.make("project:scheduled");
    const boundThreadId = ThreadId.make("thread:scheduled-bound");
    const task = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
      id: ScheduledTaskId.make("scheduled-task:webhook"),
      title: "On push",
      prompt: "Do {{body.instruction}}",
      enabled: true,
      schedule: { type: "webhook", signature: null },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
      webhook: {
        path: "/hooks/scheduled-task/secret",
        url: "https://ankiel.example/hooks/secret",
        hasSecret: false,
      },
      ...overrides,
    });
    const supervisedClient: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled"),
      requestNamespace: "client:scheduled",
      thread: undefined,
      client: {
        sessionId: "scheduled",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      tasks: ReadonlyArray<ScheduledTask>,
      boundThread: OrchestrationV2ThreadShell | null,
      upserted: Ref.Ref<number>,
      saved: ScheduledTask = tasks[0]!,
      /** Stores each keyed create under the id its key derives, as the real service does. */
      created?: Ref.Ref<ReadonlyArray<ScheduledTask>>,
    ) =>
      OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            resolvePrimaryRemoteName: () => Effect.succeed("origin"),
            resolveDefaultBranchName: () => Effect.succeed("main"),
            resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) =>
                Effect.succeed(threadId === boundThreadId ? boundThread : null),
            }),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: (id) =>
                Effect.succeedSome({
                  id,
                  workspaceRoot: "/repo/scheduled",
                  defaultModelSelection: saved.modelSelection,
                } as Project),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () =>
                created === undefined
                  ? Effect.succeed({ tasks })
                  : Ref.get(created).pipe(Effect.map((stored) => ({ tasks: stored }))),
              upsert: (input) =>
                Ref.update(upserted, (count) => count + 1).pipe(
                  Effect.andThen(
                    created === undefined || input.commandId === undefined
                      ? Effect.void
                      : Ref.set(created, [
                          {
                            ...saved,
                            id: ScheduledTaskService.scheduledTaskIdForCommand(input.commandId),
                          },
                        ]),
                  ),
                  Effect.as({ task: saved }),
                ),
            }),
          ),
        ),
      );

    it.effect("lists a webhook task without its URL to a caller that may run it", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) => mcp.listScheduledTasks(supervisedClient, { projectId })),
          Effect.provide(service([task({})], null, upserted)),
        );
        assert.deepEqual(
          listed.tasks.map((summary) => [summary.webhookUrl, summary.webhookSignature]),
          [[undefined, "none"]],
        );
      }),
    );

    it.effect("returns a webhook URL when creating a task, not when updating it", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const hook = task({});
        const timer = task({
          schedule: { type: "interval", everyMs: 3_600_000 },
          webhook: undefined,
        });
        const created = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.scheduleTask(supervisedClient, {
              projectId,
              prompt: hook.prompt,
              schedule: { type: "webhook" },
            }),
          ),
          Effect.provide(service([hook], null, upserted)),
        );
        assert.equal(created.webhookUrl, "https://ankiel.example/hooks/secret");
        const converted = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.updateScheduledTask(supervisedClient, {
              scheduledTaskId: timer.id,
              schedule: { type: "webhook" },
            }),
          ),
          Effect.provide(service([timer], null, upserted, hook)),
        );
        assert.equal(converted.webhookUrl, undefined);
      }),
    );

    it.effect(
      "refuses to replay a creation over a task whose thread now runs above the caller",
      () =>
        Effect.gen(function* () {
          const upserted = yield* Ref.make(0);
          const created = yield* Ref.make<ReadonlyArray<ScheduledTask>>([]);
          const bound = task({ threadId: boundThreadId });
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
            Effect.provide(
              service(
                [bound],
                liveThreadShell(boundThreadId, { runtimeMode: "full-access" }),
                upserted,
                bound,
                created,
              ),
            ),
          );
          const create = (prompt: string) =>
            mcp.scheduleTask(supervisedClient, {
              projectId,
              prompt,
              schedule: { type: "webhook" },
              freshSession: true,
              clientRequestId: "nightly",
            });
          yield* create("Check the build");
          const error = yield* create("Something else").pipe(Effect.flip);
          assert.equal(error.code, "runtime_mode_escalation_denied");
          assert.equal(yield* Ref.get(upserted), 1);
        }),
    );
  });
});

describe("OrchestratorMcpService thread lookup", () => {
  const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:thread-lookup"),
    requestNamespace: "client:thread-lookup",
    thread: undefined,
    client: { sessionId: "thread-lookup", label: "Claude Code", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const service = (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    sent: Ref.Ref<number>,
    overrides: Partial<ThreadManagementService.ThreadManagementService["Service"]> = {},
  ) =>
    layerOrchestratorService.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(shells.find((shell) => shell.id === threadId) ?? null),
            sendToThread: () => Ref.update(sent, (count) => count + 1).pipe(Effect.as({} as never)),
            ...overrides,
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ),
      ),
    );

  it.effect("refuses waiting without orchestration capability before reading the target", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* mcp
          .waitForThread({ ...client, capabilities: new Set() }, { threadId: bareId })
          .pipe(Effect.flip);
        assert.equal(error.code, "capability_denied");
      }).pipe(
        Effect.provide(
          service([], sent, {
            getThreadShell: () => Effect.die("Unauthorized target access"),
          }),
        ),
      );
    }),
  );
});
