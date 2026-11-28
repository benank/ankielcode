import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  ContextHandoffId,
  ContextTransferId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
} from "@ankielcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import {
  withCheckpointRestoreReservation,
  withWorkspaceLease,
} from "../workspace/workspaceLease.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import {
  layerThreadWorktreeRestore,
  ThreadWorktreeRestore,
} from "../workspace/restoreMissingWorktree.ts";
import { layerNoTaskFolders } from "./ProviderTurnStartService.testkit.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

const managedWorktreesDir = "/tmp/provider-turn-start-worktrees";
// fs.realpath applies `..` and `.` before following symlinks.
const normalize = (target: string) => {
  const parts: Array<string> = [];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
};
const layerWorktreeLocation = (worktreesDir = managedWorktreesDir) =>
  Layer.mergeAll(
    Path.layer,
    Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as ServerConfig.ServerConfig["Service"]),
    ServerSettings.layerTest(),
  );

function startWithMissingWorktree(
  worktreePath: string,
  realPaths: Record<string, string> = {
    [managedWorktreesDir]: managedWorktreesDir,
    [`${managedWorktreesDir}/project`]: `${managedWorktreesDir}/project`,
  },
) {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const pruneWorktrees = vi.fn(() => Effect.void);
  let worktreeExists = false;
  const createWorktree = vi.fn(() =>
    Effect.sync(() => {
      worktreeExists = true;
      return {} as never;
    }),
  );
  const listLocalBranchNames = vi.fn(() => Effect.succeed(["feature/restore"]));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" }),
        }),
        Layer.mock(ThreadWorktreeRestore)({ takeRecreated: () => Effect.undefined }),
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({}),
        Layer.succeed(FileSystem.FileSystem, {
          exists: () => Effect.succeed(worktreeExists),
          realPath: (target: string) =>
            normalize(target) in realPaths
              ? Effect.succeed(realPaths[normalize(target)])
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "realPath",
                    pathOrDescriptor: target,
                  }),
                ),
        } as never),
        layerWorktreeLocation(),
        layerNoTaskFolders,
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees,
          createWorktree,
          listLocalBranchNames,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => {
            projectionReadCount += 1;
            return Effect.succeed(projection);
          },
          getTurnStartContext: () => {
            projectionReadCount += 1;
            return Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            });
          },
          getRuntimeRecoveryProjection: () => {
            projectionReadCount += 1;
            return Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: "simulated inherited-background projection failure",
              }),
            );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  const start = Effect.gen(function* () {
    return yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId, willRetry: true })
      .pipe(Effect.flip);
  }).pipe(Effect.provide(layer), Effect.runPromise);
  return {
    start,
    pruneWorktrees,
    createWorktree,
    writeIfRunCurrent,
    startRootRun,
    projectionReads: () => projectionReadCount,
  };
}

it.each([
  {
    label: "<managed>/<repo>/<branch>",
    worktreePath: `${managedWorktreesDir}/project/feature-restore`,
    recreated: true,
  },
  {
    label: "the real path of a symlinked managed folder",
    worktreePath: "/real-worktrees/project/feature-restore",
    realPaths: { [managedWorktreesDir]: "/real-worktrees", "/real-worktrees": "/real-worktrees" },
    recreated: true,
  },
  {
    label: "a path outside the managed folder",
    worktreePath: "/tmp/provider-turn-start-project/.git/hooks",
    recreated: false,
  },
  {
    label: "a symlink inside the managed folder that leads out",
    worktreePath: `${managedWorktreesDir}/project/hooks`,
    realPaths: {
      [managedWorktreesDir]: managedWorktreesDir,
      [`${managedWorktreesDir}/project`]: "/tmp/provider-turn-start-project/.git",
    },
    recreated: false,
  },
  {
    label: "a folder nested below a worktree",
    worktreePath: `${managedWorktreesDir}/project/feature-restore/link/hooks`,
    recreated: false,
  },
  {
    label: "'..' out of the managed folder",
    worktreePath: `${managedWorktreesDir}/project/../../outside`,
    recreated: false,
  },
  {
    // Left raw on purpose: git follows `link` before applying `..`.
    label: "'..' after a symlink inside the managed folder",
    worktreePath: `${managedWorktreesDir}/project/x/link/../../hooks`,
    realPaths: {
      [managedWorktreesDir]: managedWorktreesDir,
      [`${managedWorktreesDir}/project`]: `${managedWorktreesDir}/project`,
      [`${managedWorktreesDir}/project/x`]: `${managedWorktreesDir}/project/x`,
      [`${managedWorktreesDir}/project/x/link`]: "/tmp/provider-turn-start-project/.git/refs/heads",
    },
    recreated: false,
  },
  { label: "a relative path", worktreePath: "project/feature-restore", recreated: false },
])("recreates a missing worktree only at the managed location: $label", async (input) => {
  const harness = startWithMissingWorktree(input.worktreePath, input.realPaths);
  await harness.start;
  expect(harness.createWorktree).toHaveBeenCalledTimes(input.recreated ? 1 : 0);
});

const restoreLeaseExists = vi.fn(() => Effect.succeed(false));
const restoreLeaseCreateWorktree = vi.fn(() => Effect.succeed({} as never));
const layerRestoreLeaseTest = layerThreadWorktreeRestore.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerNoTaskFolders,
      Layer.succeed(FileSystem.FileSystem, {
        exists: restoreLeaseExists,
        realPath: (target: string) => Effect.succeed(normalize(target)),
      } as never),
      layerWorktreeLocation(),
      Layer.mock(GitWorkflow.GitWorkflowService)({
        pruneWorktrees: () => Effect.void,
        createWorktree: restoreLeaseCreateWorktree,
        listLocalBranchNames: () => Effect.succeed(["feature/restore"]),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: () =>
          Effect.succeedSome({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
      }),
    ),
  ),
);

effectIt.effect("restores a missing worktree before a send only under the workspace lease", () =>
  Effect.gen(function* () {
    const worktreePath = `${managedWorktreesDir}/project/feature-restore`;
    const { restore, takeRecreated } = yield* ThreadWorktreeRestore;
    yield* withWorkspaceLease(
      worktreePath,
      Effect.gen(function* () {
        const restoring = yield* restore({
          id: ThreadId.make("thread_send_restore_lease"),
          projectId: ProjectId.make("project_send_restore_lease"),
          worktreePath,
          branch: "feature/restore",
        }).pipe(Effect.forkChild({ startImmediately: true }));
        expect(restoreLeaseExists).not.toHaveBeenCalled();
        return restoring;
      }),
    ).pipe(Effect.flatMap(Fiber.join));
    expect(restoreLeaseCreateWorktree).toHaveBeenCalledTimes(1);
    // Turn start finds the checkout present, so it runs setup from this hand-over, once.
    const threadId = ThreadId.make("thread_send_restore_lease");
    expect(yield* takeRecreated(threadId)).toMatchObject({ worktreePath });
    expect(yield* takeRecreated(threadId)).toBeUndefined();
  }).pipe(Effect.provide(layerRestoreLeaseTest)),
);

effectIt.effect("restores into a leftover worktree folder that cannot itself be removed", () => {
  const worktreePath = `${managedWorktreesDir}/project/feature-restore`;
  // Windows refuses to remove a folder that is still some process's cwd.
  const remove = vi.fn((target: string) =>
    target === worktreePath
      ? Effect.fail(
          PlatformError.systemError({
            _tag: "Busy",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: target,
          }),
        )
      : Effect.void,
  );
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  return Effect.gen(function* () {
    const { restore } = yield* ThreadWorktreeRestore;
    yield* restore({
      id: ThreadId.make("thread_leftover_restore"),
      projectId: ProjectId.make("project_leftover_restore"),
      worktreePath,
      branch: "feature/restore",
    });
    expect(remove).toHaveBeenCalledWith(`${worktreePath}/node_modules`, { recursive: true });
    expect(createWorktree).toHaveBeenCalledTimes(1);
  }).pipe(
    Effect.provide(
      layerThreadWorktreeRestore.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerNoTaskFolders,
            Layer.succeed(FileSystem.FileSystem, {
              exists: (target: string) => Effect.succeed(!target.endsWith("/.git")),
              readDirectory: () => Effect.succeed(["node_modules"]),
              stat: () => Effect.succeed({ type: "Directory" }),
              realPath: (target: string) => Effect.succeed(normalize(target)),
              remove,
            } as never),
            layerWorktreeLocation(),
            Layer.mock(GitWorkflow.GitWorkflowService)({
              pruneWorktrees: () => Effect.void,
              createWorktree,
              listLocalBranchNames: () => Effect.succeed(["feature/restore"]),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeedSome({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
            }),
          ),
        ),
      ),
    ),
  );
});

function makeLocalCommandHarness(input: {
  readonly text: string;
  readonly manualContinuation?: boolean;
  readonly nativeResumeUnsupported?: boolean;
  readonly steeringRestart?: boolean;
  readonly nativeGoals?: boolean;
  readonly canForkWhileSourceRunning?: boolean;
  readonly exposesNativeTurnId?: boolean;
  readonly goalDriver?: "opencode" | "antigravity";
  readonly worktreePath?: string;
  readonly worktreesDir?: string;
  readonly workspaceRoot?: string;
  readonly gitWorkflow?: GitWorkflow.GitWorkflowService["Service"];
  readonly fileSystem?: FileSystem.FileSystem;
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly recreatedBeforeDispatch?: boolean;
  readonly previousNativeSession?: boolean;
  readonly previousMessages?: ReadonlyArray<string>;
  readonly createdBy?: "agent" | "system";
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly logoutFailure?: string;
  readonly openFailure?: unknown;
  readonly ensureThreadFailure?: unknown;
  readonly historyReadFailureAfterFallback?: unknown;
  readonly resumeFailure?: ProviderAdapter.ProviderAdapterV2Error;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
  readonly failReadsAfterRunning?: boolean;
  readonly missingProviderSession?: boolean;
  readonly recoveryReadFailure?: string;
  readonly previousTurn?: {
    readonly runStatus: "failed" | "completed" | "interrupted";
    readonly turnStatus: "running" | "completed" | "interrupted";
    readonly differentThread?: boolean;
    readonly liveSession?: boolean;
    readonly interruptFailure?: boolean;
    readonly interruptCurrentRun?: boolean;
    /** Puts the running turn on an attempt a steering restart superseded. */
    readonly supersededTurn?: boolean;
  };
  /**
   * A side chat whose context targets this run, an earlier run that failed or was cancelled before
   * the provider, or an earlier run that delivered it. `nativeForkFrom` plans a native fork of the
   * parent. `switchedProvider` puts the earlier run and its context on another provider thread.
   */
  readonly sideChat?: {
    readonly contextRun: "current" | "failed" | "cancelled" | "delivered";
    readonly unsentResume?: boolean;
    readonly repeatedResume?: boolean;
    readonly acceptedResume?: boolean;
    readonly restartedResume?: boolean;
    readonly nativeForkFrom?: "idle" | "busy";
    readonly sourceBoundary?: "native" | "synthetic";
    readonly sourceRolledBack?: boolean;
    readonly switchedProvider?: boolean;
    readonly threadRuntimeMode?: OrchestrationV2ThreadProjection["thread"]["runtimeMode"];
  };
}) {
  const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
  const threadId = ThreadId.make("thread-native-account-command");
  const runId = RunId.make("run-native-account-command");
  const rootNodeId = NodeId.make("root-native-account-command");
  const attemptId = RunAttemptId.make("attempt-native-account-command");
  const providerThreadId = ProviderThreadId.make("new-provider-thread");
  const providerSessionId = ProviderSessionId.make("new-provider-session");
  const oldProviderThreadId = ProviderThreadId.make("existing-native-provider-thread");
  const oldInstanceId = ProviderInstanceId.make("antigravity-personal");
  const newInstanceId = ProviderInstanceId.make("codex-personal");
  const checkpointScopeId = CheckpointScopeId.make("scope-native-account-command");
  const messageId = MessageId.make("message-native-account-command");
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    ...(input.manualContinuation ? { manualContinuationOfRunId: RunId.make("stopped-run") } : {}),
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: { instanceId: newInstanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver: ProviderDriverKind.make(
      input.nativeGoals === undefined ? "codex" : (input.goalDriver ?? "opencode"),
    ),
    providerInstanceId: newInstanceId,
    providerSessionId: input.missingProviderSession === true ? null : providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    attachments: [],
    streaming: false,
    createdBy: input.createdBy ?? "user",
    creationSource: input.createdBy === undefined ? "web" : "mcp",
    ...(input.scheduledTaskId === undefined ? {} : { scheduledTaskId: input.scheduledTaskId }),
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      projectId: ProjectId.make("project-native-account-command"),
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: input.worktreePath === undefined ? null : "feature/restore",
      worktreePath: input.worktreePath ?? null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [
      ...(input.previousNativeSession
        ? [
            {
              ...run,
              id: RunId.make("previous-native-run"),
              ordinal: 1,
              status: "completed" as const,
              providerInstanceId: oldInstanceId,
              providerThreadId: oldProviderThreadId,
            },
          ]
        : []),
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: newInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: input.steeringRestart ? "steering_restart" : "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      ...(input.previousNativeSession
        ? [
            {
              ...providerThread,
              id: oldProviderThreadId,
              providerInstanceId: oldInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              lastRunOrdinal: 1,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("antigravity"),
                nativeId: "existing-session",
                strength: "strong" as const,
              },
            },
          ]
        : []),
      providerThread,
    ],
    messages: [
      ...(input.previousMessages ?? []).map((text, index) => ({
        ...message,
        id: MessageId.make(`previous-message-${index}`),
        text,
      })),
      message,
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/native-account-command",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
  const parentThreadId = ThreadId.make("side-chat-parent");
  const parentRunId = RunId.make("side-chat-parent-run");
  const parentProviderThread = {
    ...providerThread,
    id: ProviderThreadId.make("side-chat-parent-provider-thread"),
    appThreadId: parentThreadId,
    nativeThreadRef: {
      driver: providerThread.driver,
      nativeId: "side-chat-parent-native",
      strength: "strong" as const,
    },
  };
  const parentProviderTurn = (ordinal: number, attemptRunId: RunId) => ({
    attempt: {
      ...projection.attempts[0]!,
      id: RunAttemptId.make(`side-chat-parent-attempt-${ordinal}`),
      runId: attemptRunId,
      providerThreadId: parentProviderThread.id,
      status: "completed" as const,
    },
    turn: {
      id: ProviderTurnId.make(`side-chat-parent-turn-${ordinal}`),
      providerThreadId: parentProviderThread.id,
      nodeId: rootNodeId,
      runAttemptId: RunAttemptId.make(`side-chat-parent-attempt-${ordinal}`),
      nativeTurnRef:
        ordinal === 1 && input.sideChat?.sourceBoundary === "synthetic"
          ? null
          : {
              driver: providerThread.driver,
              nativeId: `side-chat-parent-native-turn-${ordinal}`,
              strength: "strong" as const,
            },
      ordinal,
      status: "completed" as const,
      startedAt: now,
      completedAt: now,
    },
  });
  const parentRolledBackRunId = RunId.make("side-chat-parent-rolled-back-run");
  const parentTurns = [
    parentProviderTurn(1, parentRunId),
    parentProviderTurn(2, parentRolledBackRunId),
  ];
  const parentRecords = {
    ...projection,
    thread: { ...projection.thread, id: parentThreadId },
    runs: [
      {
        ...run,
        id: parentRunId,
        threadId: parentThreadId,
        ordinal: 1,
        providerThreadId: parentProviderThread.id,
        activeAttemptId: parentTurns[0]!.attempt.id,
        status:
          input.sideChat?.sourceRolledBack === true
            ? ("rolled_back" as const)
            : ("completed" as const),
        completedAt: now,
      },
      {
        ...run,
        id: parentRolledBackRunId,
        threadId: parentThreadId,
        ordinal: 2,
        providerThreadId: parentProviderThread.id,
        activeAttemptId: parentTurns[1]!.attempt.id,
        status: "rolled_back" as const,
        completedAt: now,
      },
      ...(input.sideChat?.nativeForkFrom === "busy"
        ? [
            {
              ...run,
              id: RunId.make("side-chat-parent-busy-run"),
              threadId: parentThreadId,
              ordinal: 3,
              providerThreadId: parentProviderThread.id,
              status: "running" as const,
            },
          ]
        : []),
    ],
    providerThreads: [parentProviderThread],
    attempts: parentTurns.map(({ attempt }) => attempt),
    providerTurns: parentTurns.map(({ turn }) => turn),
    turnItems: [],
  };
  if (input.sideChat !== undefined) {
    const earlierRunId = RunId.make("side-chat-earlier-run");
    projection = {
      ...projection,
      thread: {
        ...projection.thread,
        runtimeMode: input.sideChat.threadRuntimeMode ?? "full-access",
        lineage: {
          parentThreadId,
          relationshipToParent: "fork",
          rootThreadId: parentThreadId,
          sideChat: true,
        },
      },
      runs:
        input.sideChat.contextRun === "current"
          ? projection.runs
          : [
              {
                ...run,
                id: earlierRunId,
                ordinal: 1,
                userMessageId: MessageId.make("side-chat-earlier-message"),
                activeAttemptId: RunAttemptId.make("side-chat-earlier-attempt"),
                ...(input.sideChat.switchedProvider
                  ? { providerThreadId: oldProviderThreadId }
                  : {}),
                status:
                  input.sideChat.contextRun === "delivered"
                    ? "completed"
                    : input.sideChat.contextRun,
                completedAt: now,
              },
              run,
            ],
      contextTransfers:
        input.sideChat.nativeForkFrom === undefined
          ? []
          : [
              {
                id: ContextTransferId.make("side-chat-fork"),
                type: "fork",
                sourceThreadId: parentThreadId,
                targetThreadId: threadId,
                sourcePoint: { threadId: parentThreadId, runId: parentRunId },
                basePoint: null,
                sourceProviderInstanceId: newInstanceId,
                targetProviderInstanceId: newInstanceId,
                targetRunId: runId,
                status: "pending",
                resolution: null,
                createdBy: "user",
                error: null,
                createdAt: now,
                updatedAt: now,
                consumedAt: null,
              },
            ],
      contextHandoffs: [
        {
          id: ContextHandoffId.make("side-chat-context"),
          transferId: ContextTransferId.make("side-chat-fork"),
          threadId,
          targetRunId: input.sideChat.contextRun === "current" ? runId : earlierRunId,
          fromProviderThreadIds: [],
          toProviderThreadId: input.sideChat.switchedProvider
            ? oldProviderThreadId
            : providerThreadId,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText: "SIDE_CHAT_CONTEXT",
          createdByProviderInstanceId: null,
          createdAt: now,
          updatedAt: now,
          ...(input.sideChat.contextRun === "delivered"
            ? {
                delivery: {
                  nativeThreadId: "side-chat-native",
                  status: "inline" as const,
                  itemIds: [],
                },
              }
            : {}),
        },
      ],
    };
  }
  if (input.sideChat?.unsentResume) {
    const originalMessageId = MessageId.make("original-unsent-message");
    projection = {
      ...projection,
      runs: [
        {
          ...run,
          id: RunId.make("stopped-run"),
          manualContinuationOfRunId: undefined,
          userMessageId: originalMessageId,
          status: "interrupted",
          ordinal: 1,
        },
        ...projection.runs,
      ],
      messages: [
        { ...message, id: originalMessageId, text: "Original request" },
        ...projection.messages,
      ],
    };
  }
  if (input.sideChat?.repeatedResume) {
    const retry = RunId.make("stopped-resume");
    projection = {
      ...projection,
      runs: projection.runs
        .map((r) => (r.id === runId ? { ...r, manualContinuationOfRunId: retry } : r))
        .concat({
          ...run,
          id: retry,
          manualContinuationOfRunId: RunId.make("stopped-run"),
          status: "interrupted",
        }),
    };
  }
  if (input.sideChat?.acceptedResume) {
    const acceptedId = RunAttemptId.make("accepted-original");
    projection = {
      ...projection,
      attempts: [
        ...projection.attempts,
        {
          ...projection.attempts[0]!,
          id: acceptedId,
          runId: RunId.make("stopped-run"),
          providerThreadId: oldProviderThreadId,
          status: "interrupted",
        },
        ...(input.sideChat.restartedResume
          ? [
              {
                ...projection.attempts[0]!,
                id: RunAttemptId.make("unaccepted-replacement"),
                runId: RunId.make("stopped-run"),
                attemptOrdinal: 2,
                reason: "steering_restart" as const,
                status: "interrupted" as const,
              },
            ]
          : []),
      ],
      providerTurns: [
        ...projection.providerTurns,
        {
          id: ProviderTurnId.make("accepted-original-turn"),
          runAttemptId: acceptedId,
          providerThreadId: oldProviderThreadId,
          nodeId: rootNodeId,
          ordinal: 1,
          nativeTurnRef: null,
          status: "interrupted",
          startedAt: now,
          completedAt: now,
        },
      ],
    };
  }
  if ("historyReadFailureAfterFallback" in input || "resumeFailure" in input) {
    const nativeThreadRef = {
      driver: providerThread.driver,
      nativeId: "native-resume-thread",
      strength: "strong" as const,
    };
    projection = {
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id === providerThreadId ? { ...candidate, nativeThreadRef } : candidate,
      ),
    };
  }
  const previousTurnId = ProviderTurnId.make("previous-provider-turn");
  if (input.previousTurn !== undefined) {
    const previousRunId = RunId.make("previous-failed-run");
    const previousAttemptId = RunAttemptId.make("previous-failed-attempt");
    const steeredAttemptId = RunAttemptId.make("previous-steered-attempt");
    const previousProviderThreadId = input.previousTurn.differentThread
      ? oldProviderThreadId
      : providerThreadId;
    projection = {
      ...projection,
      attempts: [
        {
          id: previousAttemptId,
          runId: previousRunId,
          attemptOrdinal: 1,
          rootNodeId: NodeId.make("previous-root"),
          providerInstanceId: newInstanceId,
          providerThreadId: previousProviderThreadId,
          providerTurnId: null,
          reason: "initial",
          status: input.previousTurn.supersededTurn === true ? "superseded" : "interrupted",
          startedAt: now,
          completedAt: now,
        },
        ...(input.previousTurn.supersededTurn === true
          ? [
              {
                id: steeredAttemptId,
                runId: previousRunId,
                attemptOrdinal: 2,
                rootNodeId: NodeId.make("previous-steered-root"),
                providerInstanceId: newInstanceId,
                providerThreadId: previousProviderThreadId,
                providerTurnId: null,
                reason: "steering_restart" as const,
                status: "interrupted" as const,
                startedAt: null,
                completedAt: now,
              },
            ]
          : []),
        ...projection.attempts,
      ],
      runs: [
        {
          ...run,
          id: previousRunId,
          ordinal: 1,
          status: input.previousTurn.runStatus,
          rootNodeId:
            input.previousTurn.supersededTurn === true
              ? NodeId.make("previous-steered-root")
              : NodeId.make("previous-root"),
          activeAttemptId:
            input.previousTurn.supersededTurn === true ? steeredAttemptId : previousAttemptId,
          providerThreadId: previousProviderThreadId,
          completedAt: now,
        },
        run,
      ],
      providerThreads: [
        {
          ...providerThread,
          nativeThreadRef: {
            driver: providerThread.driver,
            nativeId: "existing-native-conversation",
            strength: "strong",
          },
        },
      ],
      providerTurns: [
        // The steered attempt reached the provider once; only the earlier attempt's
        // turn is still running when the run was interrupted.
        ...(input.previousTurn.supersededTurn === true
          ? [
              {
                id: ProviderTurnId.make("previous-steered-turn"),
                providerThreadId: previousProviderThreadId,
                nodeId: NodeId.make("previous-steered-root"),
                runAttemptId: steeredAttemptId,
                ordinal: 0,
                nativeTurnRef: null,
                status: "interrupted" as const,
                startedAt: now,
                completedAt: now,
              },
            ]
          : []),
        {
          id: previousTurnId,
          providerThreadId: previousProviderThreadId,
          nodeId: NodeId.make("previous-root"),
          runAttemptId: previousAttemptId,
          ordinal: 1,
          nativeTurnRef: null,
          status: input.previousTurn.turnStatus,
          startedAt: now,
          completedAt: input.previousTurn.turnStatus === "running" ? null : now,
        },
      ],
    };
  }
  let providerBusy =
    (input.previousTurn?.runStatus === "failed" ||
      input.previousTurn?.runStatus === "interrupted") &&
    input.previousTurn.turnStatus === "running" &&
    !input.previousTurn.differentThread &&
    input.previousTurn.liveSession !== false;
  const interruptTurn = vi.fn((request: ProviderAdapter.ProviderAdapterV2InterruptInput) =>
    Effect.gen(function* () {
      expect(request.providerTurnId).toBe(previousTurnId);
      expect(request.providerThread.id).toBe(providerThreadId);
      if (input.previousTurn?.interruptFailure) {
        return yield* new ProviderAdapter.ProviderAdapterInterruptError({
          driver: providerThread.driver,
          providerThreadId,
          providerTurnId: request.providerTurnId,
          cause: "provider interrupt failed",
        });
      }
      providerBusy = false;
      if (input.previousTurn?.interruptCurrentRun) interruptRun();
    }),
  );
  const events: Array<OrchestrationV2DomainEvent> = [];
  const interruptRun = () => {
    projection = {
      ...projection,
      runs: projection.runs.map((candidate) =>
        candidate.id === runId
          ? { ...candidate, status: "interrupted", completedAt: now }
          : candidate,
      ),
    };
  };
  const ensureThread = vi.fn(() =>
    Effect.sync(() => {
      if (input.interruptRunBeforeOpenFailure === true) interruptRun();
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: input.ensureThreadFailure,
          }),
        ),
      ),
    ),
  );
  const fallbackEnsureThread = vi.fn(() => Effect.succeed(providerThread));
  const providerSession = {
    id: providerSessionId,
    driver: providerThread.driver,
    providerInstanceId: newInstanceId,
    status: "ready",
    cwd: "/tmp/native-account-command",
    model: null,
    capabilities: {
      ...CodexProviderCapabilitiesV2,
      threads: {
        ...CodexProviderCapabilitiesV2.threads,
        canForkWhileSourceRunning:
          input.canForkWhileSourceRunning ??
          CodexProviderCapabilitiesV2.threads.canForkWhileSourceRunning,
      },
      turns: {
        ...CodexProviderCapabilitiesV2.turns,
        exposesNativeTurnId:
          input.exposesNativeTurnId ?? CodexProviderCapabilitiesV2.turns.exposesNativeTurnId,
        ...(input.nativeGoals === undefined ? {} : { supportsNativeGoals: input.nativeGoals }),
      },
    },
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  const resumeFallbackSession = {
    driver: providerThread.driver,
    providerSession,
    resumeThread: () =>
      Effect.fail(
        input.resumeFailure ??
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: "native thread is gone",
          }),
      ),
    ensureThread: fallbackEnsureThread,
  };
  const startTurn = vi.fn((_turn: ProviderAdapter.ProviderAdapterV2TurnInput) => Effect.void);
  const sideChatThread = {
    ...providerThread,
    nativeThreadRef: {
      driver: providerThread.driver,
      nativeId: "side-chat-native",
      strength: "strong" as const,
    },
  };
  const forkThread = vi.fn<ProviderAdapter.ProviderAdapterV2SessionRuntime["forkThread"]>(() =>
    Effect.succeed(sideChatThread),
  );
  const sideChatSession = {
    driver: providerThread.driver,
    providerSession,
    ensureThread: () => Effect.succeed(sideChatThread),
    resumeThread: () => Effect.succeed(sideChatThread),
    forkThread,
    startTurn,
    resumeTurn: input.nativeResumeUnsupported
      ? undefined
      : (input: ProviderAdapter.ProviderAdapterV2ResumeTurnInput) =>
          startTurn(ProviderAdapter.resumeTurnInput(input)),
  };
  const open = vi.fn(() =>
    input.sideChat !== undefined
      ? Effect.succeed(sideChatSession as never)
      : input.interruptOpen === true
        ? Effect.interrupt
        : "historyReadFailureAfterFallback" in input || "resumeFailure" in input
          ? Effect.succeed(resumeFallbackSession as never)
          : "ensureThreadFailure" in input
            ? Effect.succeed({ driver: providerThread.driver, ensureThread } as never)
            : "openFailure" in input
              ? Effect.sync(() => {
                  if (input.interruptRunBeforeOpenFailure === true) interruptRun();
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ProviderSessionManager.ProviderSessionOpenError({
                        instanceId: newInstanceId,
                        providerSessionId,
                        cause: input.openFailure,
                      }),
                    ),
                  ),
                )
              : input.failReadsAfterRunning === true || input.previousTurn !== undefined
                ? Effect.succeed({
                    driver: providerThread.driver,
                    providerSession,
                    ensureThread: () => Effect.succeed(providerThread),
                    resumeThread: () => Effect.succeed(projection.providerThreads[0]),
                  } as never)
                : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn<
    (
      input: RunExecutionService.RunExecutionServiceV2StartRootRunInput,
    ) => Effect.Effect<void, RunExecutionService.RunExecutionServiceV2Error>
  >((runInput) =>
    input.sideChat !== undefined
      ? (runInput.resume
          ? runInput.session.resumeTurn!({
              ...runInput,
              messageId: runInput.message.messageId,
            } as never)
          : runInput.session.startTurn(runInput as never)
        ).pipe(Effect.orDie)
      : input.failReadsAfterRunning === true || input.previousTurn !== undefined
        ? Effect.suspend(() =>
            providerBusy ? Effect.die("The previous provider turn is still running.") : Effect.void,
          )
        : Effect.die("A local command must not start a native turn."),
  );
  const failReadIfRunning = Effect.suspend(() =>
    input.failReadsAfterRunning === true &&
    projection.runs.find((candidate) => candidate.id === runId)?.status === "running"
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "database unavailable" }),
        )
      : Effect.void,
  );
  const tryHandlePromptCommand = vi.fn(() =>
    input.logoutFailure === undefined
      ? Effect.succeed(true)
      : Effect.fail(
          new ProviderSetupError({
            instanceId: oldInstanceId,
            operation: "logout",
            detail: input.logoutFailure,
          }),
        ),
  );
  const writeIfRunCurrent = vi.fn<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>(
    ({ events: incoming, activeAttemptId, expectedStatus }) =>
      "writeFailure" in input
        ? Effect.fail(
            new EventSink.EventSinkWriteError({
              eventCount: incoming.length,
              cause: input.writeFailure,
            }),
          )
        : Effect.sync(() => {
            const current = projection.runs.find((candidate) => candidate.id === runId);
            const committed =
              current !== undefined &&
              current.activeAttemptId === activeAttemptId &&
              current.status === expectedStatus;
            if (committed) {
              for (const event of incoming) {
                expect(isDomainEvent(event)).toBe(true);
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
            }
            return { committed, storedEvents: [] };
          }),
  );
  const resolveRuntimePolicy = vi.fn(
    ({ thread }: Parameters<RuntimePolicy.RuntimePolicyV2Shape["resolve"]>[0]) =>
      Effect.succeed({
        cwd: thread.worktreePath ?? "/tmp/native-account-command",
        runtimeMode: thread.runtimeMode,
      } as never),
  );
  const createWorktree = vi.fn<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>(() =>
    Effect.succeed({} as never),
  );
  const getThreadRecords = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"]>((id) =>
    Effect.succeed(id === parentThreadId ? parentRecords : projection),
  );
  const prepareProviderHandoff = vi.fn<
    ContextHandoffService.ContextHandoffServiceV2["Service"]["prepareProviderHandoff"]
  >((handoff) =>
    input.sideChat?.nativeForkFrom === undefined
      ? Effect.die("history read must fail first")
      : Effect.succeed({
          ...handoff,
          id: ContextHandoffId.make("side-chat-fork-context"),
          createdByProviderInstanceId: handoff.toProviderInstanceId,
          status: "ready",
          summaryMessageId: null,
          summaryText: "PARENT_HISTORY",
          updatedAt: handoff.createdAt,
        }),
  );
  const getTurnStartContext = vi.fn(() =>
    Effect.succeed({
      ...projection,
      hasConversation: projection.messages.some(
        (m) =>
          m.role === "user" &&
          (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
      ),
    }),
  );
  const getRuntimeRecoveryProjection = vi.fn<
    ProjectionStore.ProjectionStoreV2Shape["getRuntimeRecoveryProjection"]
  >(() =>
    input.recoveryReadFailure !== undefined
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({
            threadId,
            cause: input.recoveryReadFailure,
          }),
        )
      : Effect.as(failReadIfRunning, {
          ...projection,
          hasConversation: projection.messages.some(
            (m) =>
              m.role === "user" &&
              (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
          ),
        }),
  );
  const getRun = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getRun"]>((_threadId, id) =>
    Effect.as(
      failReadIfRunning,
      projection.runs.find((candidate) => candidate.id === id),
    ),
  );
  const recreatedBeforeDispatch = { pending: input.recreatedBeforeDispatch === true };
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff,
        }),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent,
          write: ({ events: incoming }) =>
            Effect.sync(() => {
              for (const event of incoming) {
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
              return [];
            }),
        }),
        IdAllocator.layer,
        Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({}),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: input.runSetup ?? (() => Effect.succeed({ status: "no-script" })),
        }),
        Layer.mock(ThreadWorktreeRestore)({
          takeRecreated: () =>
            Effect.sync(() => {
              if (!recreatedBeforeDispatch.pending || input.worktreePath === undefined) return;
              recreatedBeforeDispatch.pending = false;
              return {
                project: {
                  workspaceRoot: input.workspaceRoot ?? "/tmp/native-account-project",
                } as never,
                worktreePath: input.worktreePath,
              };
            }),
        }),
        layerWorktreeLocation(input.worktreesDir),
        layerNoTaskFolders,
        input.fileSystem === undefined
          ? FileSystem.layerNoop({ exists: () => Effect.succeed(true) })
          : Layer.succeed(FileSystem.FileSystem, input.fileSystem),
        input.gitWorkflow === undefined
          ? Layer.mock(GitWorkflow.GitWorkflowService)({
              pruneWorktrees: () => Effect.void,
              listLocalBranchNames: () => Effect.succeed(["feature/restore"]),
              createWorktree,
            })
          : Layer.succeed(GitWorkflow.GitWorkflowService, input.gitWorkflow),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              workspaceRoot: input.workspaceRoot ?? "/tmp/native-account-project",
            } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords,
          getTurnStartContext,
          getRuntimeRecoveryProjection,
          getRun,
          getTurnStartHistory: () =>
            input.sideChat !== undefined || input.previousTurn !== undefined
              ? Effect.succeed([])
              : Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: input.historyReadFailureAfterFallback,
                  }),
                ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open,
          get: () =>
            Effect.succeed(
              input.previousTurn?.liveSession === false
                ? Option.none()
                : Option.some({
                    driver: providerThread.driver,
                    providerSessionId,
                    interruptTurn,
                  } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
            ),
        }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({ tryHandlePromptCommand }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({
          startRootRun,
          forkBaseline: () => Effect.succeed(Effect.void),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: resolveRuntimePolicy,
        }),
      ),
    ),
  );
  return {
    layer,
    interruptRun,
    getThreadRecords,
    getTurnStartContext,
    getRuntimeRecoveryProjection,
    getRun,
    setProjection: (next: OrchestrationV2ThreadProjection) => {
      projection = next;
    },
    resolveRuntimePolicy,
    createWorktree,
    open,
    fallbackEnsureThread,
    writeIfRunCurrent,
    startRootRun,
    startTurn,
    forkThread,
    prepareProviderHandoff,
    interruptTurn,
    tryHandlePromptCommand,
    events,
    oldInstanceId,
    newInstanceId,
    attemptId,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
    startWithRetry: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
      });
    }).pipe(Effect.provide(layer)),
  };
}

function layerStartEffectWorker(
  harness: ReturnType<typeof makeLocalCommandHarness>,
  control: Partial<ProviderTurnControlService.ProviderTurnControlServiceV2["Service"]> = {},
) {
  const executor = EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        harness.layer,
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)(control),
        Layer.mock(RunFinalizationService.RunFinalizationService)({}),
        Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
        Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
        Layer.mock(ThreadTitleRegenerationService.ThreadTitleRegenerationService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        ServerSettings.layerTest(),
      ),
    ),
  );
  return EffectWorker.layerWithOptions({ maxAttempts: 2 }).pipe(
    Layer.provideMerge(
      Layer.merge(executor, EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    ),
  );
}

const enqueueStart = (
  projection: OrchestrationV2ThreadProjection,
  request?: EffectOutbox.OrchestrationEffectRequestV2,
) =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const run = projection.runs.at(-1)!;
    yield* outbox.enqueue([
      {
        id: "effect:failed-start",
        commandId: CommandId.make("command:failed-start"),
        threadId: run.threadId,
        request: request ?? { type: "provider-turn.start", runId: run.id },
      },
    ]);
    return { storedEffect: outbox.get("effect:failed-start").pipe(Effect.map(Option.getOrThrow)) };
  });

effectIt.effect("retries a failed settlement past the start budget until it is persisted", () => {
  const harness = makeLocalCommandHarness({ text: "Continue", missingProviderSession: true });
  harness.writeIfRunCurrent.mockImplementationOnce(({ events }) =>
    Effect.fail(
      new EventSink.EventSinkWriteError({
        eventCount: events.length,
        cause: "storage unavailable",
      }),
    ),
  );

  return Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const { storedEffect } = yield* enqueueStart(harness.projection());
    yield* worker.drain();
    yield* TestClock.adjust("100 millis");
    expect(yield* worker.drain()).toBe(1);
    expect(yield* storedEffect).toMatchObject({ status: "pending", attemptCount: 2 });
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);

    yield* TestClock.adjust("200 millis");
    expect(yield* worker.drain()).toBe(1);
    expect(yield* storedEffect).toMatchObject({ status: "succeeded", attemptCount: 3 });
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toHaveLength(1);
  }).pipe(Effect.provide(layerStartEffectWorker(harness)));
});

effectIt.effect("preserves a replacement committed after the final pre-running start read", () => {
  const harness = makeLocalCommandHarness({ text: "Continue", missingProviderSession: true });
  const read = harness.getTurnStartContext.getMockImplementation()!;
  let reads = 0;
  let replacement: OrchestrationV2ThreadProjection;
  harness.getTurnStartContext.mockImplementation(() =>
    Effect.suspend(() => {
      const snapshot = read();
      reads++;
      if (reads === 2) {
        const projection = harness.projection();
        const attemptId = RunAttemptId.make("replacement-before-fallback");
        const rootNodeId = NodeId.make("replacement-root-before-fallback");
        replacement = {
          ...projection,
          runs: projection.runs.map((run) => ({ ...run, activeAttemptId: attemptId, rootNodeId })),
          attempts: [
            ...projection.attempts,
            { ...projection.attempts[0]!, id: attemptId, rootNodeId },
          ],
          nodes: [...projection.nodes, { ...projection.nodes[0]!, id: rootNodeId }],
        };
        harness.setProjection(replacement);
      }
      return snapshot;
    }),
  );
  return Effect.gen(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const { storedEffect } = yield* enqueueStart(harness.projection());
    yield* worker.drain();
    yield* TestClock.adjust("100 millis");
    expect(yield* worker.drain()).toBe(1);
    expect(harness.projection()).toEqual(replacement!);
    expect(harness.events).toEqual([]);
    expect(yield* storedEffect).toMatchObject({ status: "succeeded", attemptCount: 2 });
  }).pipe(Effect.provide(layerStartEffectWorker(harness)));
});

effectIt.effect("leaves a managed worktree folder without .git that holds user files", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worktreesDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ankiel-leftover-" });
    const worktreePath = path.join(worktreesDir, "project", "restore");
    yield* fileSystem.makeDirectory(path.join(worktreePath, "node_modules"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(worktreePath, "notes.md"), "keep me");
    const harness = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      worktreesDir,
      fileSystem,
      failReadsAfterRunning: true,
    });
    yield* harness.start;
    expect(harness.createWorktree).not.toHaveBeenCalled();
    expect(yield* fileSystem.readFileString(path.join(worktreePath, "notes.md"))).toBe("keep me");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

effectIt.effect("recovers an abandoned failed turn before continuing its native conversation", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
    });

    yield* harness.start;

    expect(harness.interruptTurn).toHaveBeenCalledOnce();
    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    expect(harness.projection().providerTurns[0]).toMatchObject({
      status: "interrupted",
      completedAt: expect.anything(),
    });
    expect(harness.startRootRun).toHaveBeenCalledOnce();
    expect(harness.startRootRun.mock.calls[0]?.[0].providerThread.nativeThreadRef?.nativeId).toBe(
      "existing-native-conversation",
    );
  }),
);

effectIt.effect("refuses unsupported resume instead of manufacturing a user prompt", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "",
      manualContinuation: true,
      nativeResumeUnsupported: true,
      sideChat: { contextRun: "delivered" },
    });
    yield* harness.start;
    expect(harness.startTurn).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().turnItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          failure: expect.objectContaining({
            message:
              "This provider cannot resume without a new message. Send a message to continue.",
          }),
        }),
      ]),
    );
  }),
);

effectIt.effect("does not start the continuation if recording recovery fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.projection().providerTurns[0]?.status).toBe("running");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect("does not resume a continuation stopped while recovery was in flight", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", interruptCurrentRun: true },
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

// regression: #12341 a turn start overlapping a checkpoint restore wrote into the checkout
// The filesystem is synchronous so the turn start either reaches the provider or parks on the
// lease before the restore is released; realPath models the symlink alias and missing worktrees.
effectIt.effect.each([
  {
    overlap: "a project-root thread during a restore of the project checkout",
    restorePath: "/tmp/native-account-project",
    worktreePath: undefined,
    realPaths: {},
    missing: [],
  },
  {
    overlap: "a symlink alias of the restoring checkout",
    restorePath: "/tmp/restore-overlap/link",
    worktreePath: "/tmp/restore-overlap/checkout",
    realPaths: { "/tmp/restore-overlap/link": "/tmp/restore-overlap/checkout" },
    missing: [],
  },
  {
    overlap: "a directory inside the restoring checkout",
    restorePath: "/tmp/restore-overlap/checkout",
    worktreePath: "/tmp/restore-overlap/checkout/packages/app",
    realPaths: {},
    missing: [],
  },
  {
    overlap: "a not-yet-recreated worktree under a symlink alias of the restoring one",
    restorePath: "/tmp/restore-overlap/link/missing-child",
    worktreePath: "/tmp/restore-overlap/checkout/missing-child",
    realPaths: { "/tmp/restore-overlap/link": "/tmp/restore-overlap/checkout" },
    missing: [
      "/tmp/restore-overlap/link/missing-child",
      "/tmp/restore-overlap/checkout/missing-child",
    ],
  },
] as const)(
  "does not start provider work in $overlap until the restore finishes",
  ({ restorePath, worktreePath, realPaths, missing }) =>
    Effect.gen(function* () {
      const order: Array<string> = [];
      const releaseRestore = yield* Deferred.make<void>();
      const restoreEntered = yield* Deferred.make<void>();
      const fileSystem = FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        realPath: (candidate) =>
          (missing as ReadonlyArray<string>).includes(candidate)
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "realPath",
                  pathOrDescriptor: candidate,
                }),
              )
            : Effect.succeed((realPaths as Record<string, string>)[candidate] ?? candidate),
      });
      const harness = makeLocalCommandHarness({
        text: "Continue",
        ...(worktreePath === undefined ? {} : { worktreePath }),
        fileSystem,
        failReadsAfterRunning: true,
      });
      const open = harness.open.getMockImplementation()!;
      harness.open.mockImplementation(() =>
        Effect.sync(() => order.push("provider session opened")).pipe(Effect.andThen(open())),
      );
      // The reservation CheckpointRollbackServiceV2.execute holds around its
      // isolation check, provider rollback, and git restore of `restorePath`.
      const restore = yield* withCheckpointRestoreReservation(
        fileSystem,
        yield* Path.Path,
        restorePath,
        Deferred.succeed(restoreEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRestore)),
          Effect.andThen(Effect.sync(() => order.push("checkpoint files restored"))),
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(restoreEntered);
      const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(releaseRestore, undefined);
      yield* Fiber.join(restore);
      yield* Fiber.join(startup);
      expect(order).toEqual(["checkpoint files restored", "provider session opened"]);
    }).pipe(Effect.provide(Path.layer)),
);

effectIt.effect("terminalizes a starting run when its provider session cannot open", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("DESCRIPTION is not valid ACP JSON"),
    });

    yield* harness.start;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAttemptId: harness.attemptId,
        expectedStatus: "starting",
      }),
    );
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "DESCRIPTION is not valid ACP JSON",
        },
      },
    ]);
  }),
);

effectIt.effect("fails rather than retries a provider thread request with an unknown outcome", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: { _tag: "CodexAppServerUnresponsiveError", method: "thread/start" },
    });

    yield* harness.startWithRetry;

    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
  }),
);

effectIt.effect("fails rather than starts a fresh thread when a resume outcome is unknown", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      resumeFailure: new ProviderAdapter.ProviderAdapterEventStreamError({
        driver: ProviderDriverKind.make("codex"),
        providerSessionId: ProviderSessionId.make("resume-provider-session"),
        cause: { _tag: "CodexAppServerUnresponsiveError", method: "thread/resume" },
      }),
    });

    const exit = yield* Effect.exit(harness.startWithRetry);

    expect(exit._tag).toBe("Success");
    expect(harness.fallbackEnsureThread).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
  }),
);

effectIt.effect("fails the run instead of replacing a native thread another client holds", () =>
  Effect.gen(function* () {
    const detail = "This conversation is open in another Codex client.";
    const harness = makeLocalCommandHarness({
      text: "Continue",
      resumeFailure: new ProviderAdapter.ProviderAdapterThreadInUseError({
        driver: ProviderDriverKind.make("codex"),
        providerThreadId: ProviderThreadId.make("new-provider-thread"),
        detail,
        cause: new Error("thread native-resume-thread already has an active writer"),
      }),
    });

    const exit = yield* Effect.exit(harness.start);

    expect(harness.fallbackEnsureThread).not.toHaveBeenCalled();
    expect(exit._tag).toBe("Success");
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.providerThreads.at(-1)?.nativeThreadRef?.nativeId).toBe(
      "native-resume-thread",
    );
    expect(projection.contextHandoffs).toEqual([]);
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider turn failed to start",
        failure: { class: "provider_error", message: detail },
      },
    ]);
  }),
);

effectIt.effect.each(["not_loaded", "error"] as const)(
  "signs out the existing native provider before opening the newly selected provider with status %s",
  (providerThreadStatus) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });
      const initial = harness.projection();
      harness.setProjection({
        ...initial,
        providerThreads: initial.providerThreads.map((thread) =>
          thread.id === "new-provider-thread"
            ? { ...thread, status: providerThreadStatus }
            : thread,
        ),
      });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
        sentByPerson: true,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
      expect(
        projection.providerThreads.find((thread) => thread.id === "new-provider-thread")?.status,
      ).toBe(providerThreadStatus);
    }),
);
