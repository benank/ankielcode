import { PullRequestProviderError } from "@ankielcode/source-control-core/server/PullRequestProvider";
import { PullRequestUnavailableError, SourceControlProviderKind } from "@ankielcode/contracts";
import * as McpProviderSessions from "@ankielcode/provider-core/server/McpProviderSessions";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  type ApplicationStoredEvent,
  CheckpointId,
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  type PullRequestCheck,
  type PullRequestDetail,
  type PullRequestComment,
  PullRequestOperationError,
  type PullRequestWatchUntil,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@ankielcode/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import { createAttachmentId } from "../attachmentStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@ankielcode/provider-core/server/driver";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestWatchReactor from "./PullRequestWatchReactor.ts";
import { PULL_REQUEST_WATCH_WAKE_LIMIT } from "./pullRequestWatch.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { layerNoTaskFolders } from "./ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import { shellStreamItemFromThreadShell } from "./ShellStream.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as DeviceHost from "../device/DeviceHost.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import type * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";

const makeEnabledPullRequestWatchReactor = PullRequestWatchReactor.make.pipe(
  Effect.provide(ServerSettings.layerTest({ githubIntegrationEnabled: true })),
);

const layerPlatformTest = Layer.mergeAll(
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
    runForThread: () => Effect.succeed({ status: "no-script" }),
  }),
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "ankiel-orchestration-v2-runtime-layer-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const alternateInstanceId = ProviderInstanceId.make("codex_alternate");

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);
const layerGitWorkflowTest = Layer.merge(
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  layerNoTaskFolders,
);
const layerProjectServiceTest = Layer.mock(ProjectService.ProjectService)({
  getById: () => Effect.succeedNone,
});

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by lifecycle tests"),
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
const alternateProviderInstance = {
  ...providerInstance,
  instanceId: alternateInstanceId,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test:alternate",
  },
  displayName: "Codex alternate test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: alternateInstanceId,
  },
} satisfies ProviderInstance;
const claudeInstanceId = ProviderInstanceId.make("claude_test");
const claudeDriver = ProviderDriverKind.make("claudeAgent");
const claudeProviderInstance = {
  ...providerInstance,
  instanceId: claudeInstanceId,
  driverKind: claudeDriver,
  continuationIdentity: { driverKind: claudeDriver, continuationKey: "claude:test" },
  displayName: "Claude test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: claudeInstanceId,
    driver: claudeDriver,
  },
} satisfies ProviderInstance;

const antigravityInstanceId = ProviderInstanceId.make("antigravity_test");
const antigravityDriver = ProviderDriverKind.make("antigravity");
const antigravityProviderInstance = {
  ...providerInstance,
  instanceId: antigravityInstanceId,
  driverKind: antigravityDriver,
  continuationIdentity: { driverKind: antigravityDriver, continuationKey: "antigravity:test" },
  displayName: "Antigravity test",
  orchestrationAdapter: {
    ...orchestrationAdapter,
    instanceId: antigravityInstanceId,
    driver: antigravityDriver,
    getCapabilities: () =>
      Effect.succeed({
        ...CodexProviderCapabilitiesV2,
        turns: { ...CodexProviderCapabilitiesV2.turns, supportsNativeGoals: true },
      }),
  },
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.merge(
  ModelManifest.layerTest,
  Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (instanceId) =>
      Effect.succeed(
        [
          providerInstance,
          alternateProviderInstance,
          claudeProviderInstance,
          antigravityProviderInstance,
        ].find((instance) => instanceId === instance.instanceId),
      ),
    listInstances: Effect.succeed([
      providerInstance,
      alternateProviderInstance,
      claudeProviderInstance,
      antigravityProviderInstance,
    ]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  }),
);

const watchedPullRequestDetail = (input: {
  readonly projectId: ProjectId;
  readonly number: number;
  readonly at: string;
}): PullRequestDetail => ({
  provider: SourceControlProviderKind.make("github"),
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    checksAlwaysReport: true,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: input.projectId,
  projectTitle: "Watch wake",
  workspaceRoot: "/workspace/watch",
  repository: "benank/ankielcode",
  number: input.number,
  title: "Watched pull request",
  body: "",
  url: `https://github.com/benank/ankielcode/pull/${input.number}`,
  author: { login: "agent-user", name: null, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  headSha: "abc1234def",
  baseBranch: "main",
  createdAt: input.at,
  updatedAt: input.at,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "lint", status: "failure", description: null, url: null }],
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewer: "agent-user",
});

const seedProject = (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly createdAt: string;
}) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: input.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        scripts: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    }),
  );

const moveProject = (projectId: ProjectId, workspaceRoot: string, updatedAt: string) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`move:${projectId}:${workspaceRoot}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: updatedAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.meta-updated",
      payload: { projectId, workspaceRoot, updatedAt },
    }),
  );

// Read-only oracle: projections still equal a replay of these unpruned test logs.
const layerProjectionReplayTest = ProjectionReplay.layer.pipe(
  Layer.provide(
    Layer.merge(
      EventStore.layerFromOrchestrationEventStore.pipe(
        Layer.provide(RuntimeLayer.layerEventInfrastructure),
      ),
      ProjectionStore.layer,
    ),
  ),
);

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  layerProjectionReplayTest,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

const layerLegacyImportTest = Layer.merge(RuntimeLayer.layer, layerProjectionReplayTest).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);

const layerScheduledTasksTest = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      // The orchestrator depends on this layer, so read the shell from its projection.
      Layer.unwrap(
        ProjectionStore.ProjectionStoreV2.pipe(
          Effect.map(({ getThreadShell }) =>
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) => getThreadShell(threadId).pipe(Effect.orDie),
            }),
          ),
        ),
      ).pipe(Layer.provide(ProjectionStore.layer)),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Scheduler.layer,
    ),
  ),
);
const bootedSimulatorReady: DeviceHost.DeviceHostAgentReady = {
  nodePath: process.execPath,
  hub: { origin: "http://device.test" },
  agentDevice: null,
  helpers: { serveSimAxSettings: null, serveSimCli: null },
  run: () => Effect.die("Thread cleanup must not run host commands"),
  releaseAgentSession: () => Effect.void,
  devices: {
    list: Effect.succeed({
      devices: [
        {
          id: "phone",
          name: "iPhone",
          platform: "ios",
          version: "26",
          booted: true,
          physical: false,
        },
      ],
      detail: undefined,
    }),
    boot: () => Effect.die("The simulator is already booted"),
    attach: () => Effect.void,
    shutdown: () => Effect.die("Thread cleanup must keep the simulator booted"),
    screenshot: () => Effect.die("unused screenshot"),
  },
};
const bootedSimulatorHost = DeviceHost.DeviceHost.of({
  id: "local",
  label: "Local",
  summary: Effect.succeed({
    id: "local",
    label: "Local",
    kind: "local",
    hubInstalled: true,
    agentDeviceInstalled: true,
    platforms: [{ platform: "ios", available: true }],
  }),
  platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
  ensureReady: () => Effect.succeed(bootedSimulatorReady),
  ensureAgentReady: () => Effect.succeed(bootedSimulatorReady),
  current: Effect.succeed(bootedSimulatorReady),
  stopAgent: Effect.void,
  stop: Effect.void,
});
const layerResourceCleanupTest = ResourceCleanupService.layer.pipe(
  Layer.provideMerge(layerScheduledTasksTest),
  Layer.provideMerge(
    Layer.effect(
      DeviceService.DeviceService,
      DeviceService.makeWithHosts(new Map([[bootedSimulatorHost.id, bootedSimulatorHost]])),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(PreviewManager.PreviewManager)({ close: () => Effect.void }),
      Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    ),
  ),
);

const layerProjectDeletionTest = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  ProjectionStore.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provideMerge(layerResourceCleanupTest),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  // Exposed so tests can reach the attachments directory that resource cleanup removes from.
  Layer.provideMerge(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provideMerge(layerPlatformTest),
);

it.layer(layerProjectDeletionTest)("project deletion during thread commands", (it) => {
  it.effect.each(["no fork", "a live fork"] as const)(
    "a queued edit's cleanup keeps a file earlier history still shows, with %s",
    (fork) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const key = `queued-edit-shared-file-${fork.replaceAll(" ", "-")}`;
        const threadId = ThreadId.make(key);
        const storedFile = (name: string) =>
          ({
            type: "image",
            id: createAttachmentId(threadId)!,
            name: `${name}.png`,
            mimeType: "image/png",
            sizeBytes: 5,
          }) as const;
        const shared = storedFile("shared");
        const dropped = storedFile("dropped");
        const filePath = (file: typeof shared) =>
          path.join(config.attachmentsDir, `${file.id}.png`);
        yield* fileSystem.writeFileString(filePath(shared), "bytes");
        yield* fileSystem.writeFileString(filePath(dropped), "bytes");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${key}:create`),
          createdBy: "user",
          creationSource: "web",
          threadId,
          projectId: ProjectId.make("queued-edit-shared-file-project"),
          title: "Shared file",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const writeRun = Effect.fn("test.writeQueuedEditRun")(function* (input: {
          readonly name: string;
          readonly ordinal: number;
          readonly status: "completed" | "queued";
          readonly attachments: ReadonlyArray<typeof shared>;
        }) {
          const now = yield* DateTime.now;
          const runId = RunId.make(`${key}:${input.name}`);
          const messageId = MessageId.make(`${key}:${input.name}`);
          const completed = input.status === "completed";
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`${key}:${input.name}:run`),
                type: "run.created",
                threadId,
                runId,
                occurredAt: now,
                payload: {
                  id: runId,
                  threadId,
                  ordinal: input.ordinal,
                  providerInstanceId: modelSelection.instanceId,
                  modelSelection,
                  providerThreadId: null,
                  userMessageId: messageId,
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: input.status,
                  requestedAt: now,
                  startedAt: completed ? now : null,
                  completedAt: completed ? now : null,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
              {
                id: EventId.make(`${key}:${input.name}:message`),
                type: "message.updated",
                threadId,
                runId,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId,
                  runId,
                  nodeId: null,
                  role: "user",
                  text: `Send ${input.name} work`,
                  attachments: input.attachments,
                  streaming: false,
                  createdBy: "user",
                  creationSource: "web",
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
          return runId;
        });

        const sourceRunId = yield* writeRun({
          name: "source",
          ordinal: 1,
          status: "completed",
          attachments: [shared],
        });
        if (fork !== "no fork") {
          const forkThreadId = ThreadId.make(`${key}:fork`);
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make(`${key}:fork`),
            sourceThreadId: threadId,
            targetThreadId: forkThreadId,
            sourcePoint: { type: "run", runId: sourceRunId },
            createdBy: "user",
            creationSource: "web",
          });
        }
        const queuedRunId = yield* writeRun({
          name: "queued",
          ordinal: 2,
          status: "queued",
          attachments: [shared, dropped],
        });
        yield* orchestrator.dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make(`${key}:edit`),
          threadId,
          runId: queuedRunId,
          text: "Send queued work without files",
          attachments: [],
        });
        yield* worker.drain();

        assert.isFalse(yield* fileSystem.exists(filePath(dropped)));
        assert.equal(yield* fileSystem.readFileString(filePath(shared)), "bytes");

        if (fork !== "no fork") {
          const laterRunId = yield* writeRun({
            name: "later",
            ordinal: 3,
            status: "completed",
            attachments: [shared],
          });
          const laterForkId = ThreadId.make(`${key}:later-fork`);
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make(`${key}:later-fork`),
            sourceThreadId: threadId,
            targetThreadId: laterForkId,
            sourcePoint: { type: "run", runId: laterRunId },
            createdBy: "user",
            creationSource: "web",
          });
          for (const id of [threadId, laterForkId]) {
            yield* orchestrator.dispatch({
              type: "thread.delete",
              commandId: CommandId.make(`${key}:delete:${id}`),
              threadId: id,
            });
            yield* worker.drain();
            assert.equal(yield* fileSystem.readFileString(filePath(shared)), "bytes");
          }
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`${key}:delete-first-fork`),
            threadId: ThreadId.make(`${key}:fork`),
          });
          yield* worker.drain();
          assert.isFalse(yield* fileSystem.exists(filePath(shared)));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("waits for an in-flight thread update before planning deletion", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const projectId = ProjectId.make("runtime-project-delete-concurrent");
      const threadId = ThreadId.make("runtime-thread-delete-concurrent");
      const updateCommandId = CommandId.make("runtime-thread-delete-concurrent-update");
      yield* projects.create({
        commandId: CommandId.make("runtime-project-delete-concurrent-create"),
        projectId,
        title: "Concurrent deletion",
        workspaceRoot: "/work/concurrent-deletion",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-thread-delete-concurrent-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId,
        title: "Original title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      const updateReady = yield* Deferred.make<void>();
      const releaseUpdate = yield* Deferred.make<void>();
      const deletionQueued = yield* Deferred.make<void>();
      const commitCommand = eventSink.commitCommand;
      const withLock = executor.withLock;
      let threadLockRequests = 0;
      const commitSpy = vi
        .spyOn(eventSink, "commitCommand")
        .mockImplementation((input) =>
          input.commandId === updateCommandId
            ? Deferred.succeed(updateReady, undefined).pipe(
                Effect.andThen(Deferred.await(releaseUpdate)),
                Effect.andThen(commitCommand(input)),
              )
            : commitCommand(input),
        );
      const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
        key,
        effect,
      ) => {
        if (key !== threadId || ++threadLockRequests !== 2) return withLock(key, effect);
        return Deferred.succeed(deletionQueued, undefined).pipe(
          Effect.andThen(withLock(key, effect)),
        );
      };
      const lockSpy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
      yield* Effect.gen(function* () {
        const updateFiber = yield* orchestrator
          .dispatch({
            type: "thread.metadata.update",
            commandId: updateCommandId,
            threadId,
            title: "Updated before deletion",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(updateReady),
          Fiber.join(updateFiber).pipe(
            Effect.andThen(Effect.die("The update completed before reaching its commit barrier.")),
          ),
        );
        const deleteFiber = yield* projects
          .delete({
            commandId: CommandId.make("runtime-project-delete-concurrent-delete"),
            projectId,
            force: true,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.raceFirst(
          Deferred.await(deletionQueued),
          Fiber.join(deleteFiber).pipe(
            Effect.andThen(Effect.die("Project deletion bypassed the in-flight thread command.")),
          ),
        );
        yield* Deferred.succeed(releaseUpdate, undefined);
        yield* Fiber.join(updateFiber);
        const deletedProject = yield* Fiber.join(deleteFiber);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.isNotNull(deletedProject.deletedAt);
        assert.isNotNull(projection.thread.deletedAt);
        assert.equal(projection.thread.title, "Updated before deletion");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            commitSpy.mockRestore();
            lockSpy.mockRestore();
          }),
        ),
      );
    }),
  );
});

const layerSharedApplicationDataPlaneTest = Layer.mergeAll(
  layerProjectionReplayTest,
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  RuntimeLayer.layerEventInfrastructure,
).pipe(
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
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
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerPlatformTest),
);

it.layer(layerTest)("OrchestrationV2LayerLive", (it) => {
  it.effect("captures and repeatedly rewinds non-Git conversations without losing run links", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ankiel-non-git-rewind-" });
      const threadId = ThreadId.make("runtime-non-git-rewind");
      const rollbackThread = vi.fn(
        ({ providerThread }: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
          Effect.succeed({
            providerThread: {
              ...providerThread,
              nativeThreadRef: {
                driver,
                nativeId: "rewound-native-thread",
                strength: "strong" as const,
              },
            },
          }),
      );
      const sessionSpy = vi.spyOn(sessions, "open").mockReturnValue(
        Effect.succeed({
          rollbackThread,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("non-git-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("non-git-project"),
        title: "Non-Git rewind",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
      });

      const completeMessage = (name: string) =>
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(name),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make(name),
            text: name,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.userMessageId === name)!;
          const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId)!;
          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === run.providerThreadId,
          )!;
          const now = yield* DateTime.now;
          const commandId = CommandId.make(`${name}-complete`);
          // The provider completion is the fixture boundary; capture and rollback use real effects.
          yield* outbox.cancelUnsettled({
            threadId,
            effectTypes: ["provider-turn.start"],
            reason: "provider completion supplied by fixture",
          });
          yield* eventSink.writeWithEffects({
            commandId,
            events: [
              {
                id: EventId.make(`${name}-run`),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "waiting", startedAt: now },
              },
              {
                id: EventId.make(`${name}-node`),
                type: "node.updated",
                threadId,
                runId: run.id,
                nodeId: node.id,
                occurredAt: now,
                payload: { ...node, status: "completed", completedAt: now },
              },
              {
                id: EventId.make(`${name}-turn`),
                type: "provider-turn.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make(`${name}-turn`),
                  providerThreadId: providerThread.id,
                  nodeId: node.id,
                  runAttemptId: run.activeAttemptId,
                  nativeTurnRef: null,
                  ordinal: run.ordinal,
                  status: "completed",
                  startedAt: now,
                  completedAt: now,
                },
              },
            ],
            effects: [
              {
                id: `${name}-capture`,
                commandId,
                threadId,
                request: {
                  type: "checkpoint.capture",
                  runId: run.id,
                  scopeId: node.checkpointScopeId!,
                },
              },
            ],
          });
          yield* worker.drain();
          const captured = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            captured.runs.find((candidate) => candidate.id === run.id)?.status,
            "completed",
          );
          const checkpoint = captured.checkpoints.find((candidate) => candidate.runId === run.id)!;
          assert.equal(checkpoint.status, "missing");
          return { run, checkpoint };
        });

      const first = yield* completeMessage("non-git-first");
      const second = yield* completeMessage("non-git-second");
      const before = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        before.checkpoints.find((checkpoint) => checkpoint.id === first.checkpoint.id)?.runId,
        first.run.id,
        "capturing a later run must preserve the earlier checkpoint's run link",
      );
      const baseline = before.checkpoints.find(
        (checkpoint) => checkpoint.ordinalWithinScope === 0,
      )!;
      assert.equal(baseline.status, "missing");
      for (const checkpoint of [baseline, first.checkpoint]) {
        for (const restoreFiles of [undefined, true]) {
          const commandId = CommandId.make(`non-git-files-${checkpoint.id}-${restoreFiles}`);
          yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId,
              threadId,
              checkpointId: checkpoint.id,
              scopeId: checkpoint.scopeId,
              ...(restoreFiles === undefined ? {} : { restoreFiles }),
            })
            .pipe(Effect.flip);
          assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
        }
      }
      assert.equal(rollbackThread.mock.calls.length, 0);

      const rewind = (name: string) =>
        Effect.gen(function* () {
          const commandId = CommandId.make(name);
          yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId,
            threadId,
            checkpointId: baseline.id,
            scopeId: baseline.scopeId,
            restoreFiles: false,
          });
          yield* worker.drain();
          assert.deepEqual(
            (yield* outbox.listByCommandId(commandId)).map((effect) => effect.status),
            ["succeeded"],
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.ok(projection.runs.every((run) => run.status === "rolled_back"));
          assert.isNull(projection.providerThreads[0]!.lastRunOrdinal);
          assert.equal(
            projection.providerThreads[0]!.nativeThreadRef?.nativeId,
            "rewound-native-thread",
          );
          assert.isNull(projection.thread.rollbackFailure);
        });

      yield* rewind("non-git-rewind-first");
      assert.equal(rollbackThread.mock.calls[0]![0].target.type, "thread_start");
      assert.deepEqual(
        rollbackThread.mock.calls[0]![0].providerThreadTurns.map((turn) => turn.id),
        [ProviderTurnId.make("non-git-first-turn"), ProviderTurnId.make("non-git-second-turn")],
      );
      const discardedCommandId = CommandId.make("non-git-discarded-target");
      yield* orchestrator
        .dispatch({
          type: "checkpoint.rollback",
          commandId: discardedCommandId,
          threadId,
          checkpointId: second.checkpoint.id,
          scopeId: second.checkpoint.scopeId,
          restoreFiles: false,
        })
        .pipe(Effect.flip);
      assert.deepEqual(yield* outbox.listByCommandId(discardedCommandId), []);
      assert.equal(rollbackThread.mock.calls.length, 1);

      const resent = yield* completeMessage("non-git-resent");
      assert.isAbove(resent.run.ordinal, second.run.ordinal);
      yield* rewind("non-git-rewind-again");
      assert.equal(rollbackThread.mock.calls.length, 2);
      assert.equal(rollbackThread.mock.calls[1]![0].target.type, "thread_start");
      assert.deepEqual(
        rollbackThread.mock.calls[1]![0].providerThreadTurns.map((turn) => turn.id),
        [ProviderTurnId.make("non-git-resent-turn")],
      );
    }).pipe(Effect.provide(Layer.merge(Layer.fresh(layerTest), NodeServices.layer))),
  );

  it.effect("rejects non-ready rollback targets before persisting events or effects", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("runtime-rollback-readiness");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-rollback-readiness-create"),
        threadId,
        projectId: ProjectId.make("runtime-rollback-readiness-project"),
        title: "Rollback readiness",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-rollback-readiness-message"),
        threadId,
        messageId: MessageId.make("runtime-rollback-readiness-message"),
        text: "Create the provider thread and checkpoint scope.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const scope = projection.checkpointScopes[0]!;
      const now = yield* DateTime.now;

      for (const status of ["missing", "error", "stale", "ready"] as const) {
        const checkpointId = CheckpointId.make("runtime-rollback-checkpoint");
        const commandId = CommandId.make(`runtime-rollback-${status}`);
        yield* eventSink.write({
          commandId: CommandId.make(`runtime-rollback-${status}-seed`),
          events: [
            {
              id: EventId.make(`runtime-rollback-${status}-event`),
              type: "checkpoint.captured",
              threadId,
              occurredAt: now,
              payload: {
                id: checkpointId,
                threadId,
                scopeId: scope.id,
                runId: null,
                nodeId: scope.nodeId,
                parentCheckpointId: null,
                ordinalWithinScope: 0,
                appRunOrdinal: null,
                ref: CheckpointRef.make(`refs/ankiel/runtime-rollback-${status}`),
                status,
                files: [],
                capturedAt: now,
              },
            },
          ],
        });
        const previousSequence = yield* orchestrator.getThreadEventSequence(threadId);
        const rollback = orchestrator.dispatch({
          type: "checkpoint.rollback",
          commandId,
          threadId,
          checkpointId,
          scopeId: scope.id,
        });

        if (status === "ready") {
          const accepted = yield* rollback;
          assert.deepEqual(
            accepted.storedEvents.map((stored) => stored.event.type),
            ["thread.metadata-updated", "checkpoint.rollback-requested"],
          );
          assert.deepEqual(
            (yield* outbox.listByCommandId(commandId)).map((effect) => effect.request.type),
            ["provider-thread.rollback"],
          );
          const path = yield* Path.Path.pipe(
            Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          );
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("runtime-rollback-ancestor-create"),
            threadId: ThreadId.make("runtime-rollback-ancestor"),
            projectId: ProjectId.make("runtime-rollback-readiness-project"),
            title: "Ancestor workspace owner",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: path.dirname(process.cwd()),
          });
          const overlapCommandId = CommandId.make("runtime-rollback-overlap");
          const overlapSequence = yield* orchestrator.getThreadEventSequence(threadId);
          const overlap = yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId: overlapCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
            })
            .pipe(Effect.flip);
          assert.match(String(overlap.cause), /isolated worktree/);
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), overlapSequence);
          assert.deepEqual(yield* outbox.listByCommandId(overlapCommandId), []);
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("runtime-rollback-share"),
            threadId,
            worktreePath: null,
          });
          const sharedCommandId = CommandId.make("runtime-rollback-shared");
          const sequence = yield* orchestrator.getThreadEventSequence(threadId);
          const shared = yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId: sharedCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
            })
            .pipe(Effect.flip);
          assert.match(String(shared.cause), /isolated worktree/);
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
          assert.deepEqual(yield* outbox.listByCommandId(sharedCommandId), []);
          const conversationOnly = yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make("runtime-rollback-conversation"),
            threadId,
            checkpointId,
            scopeId: scope.id,
            restoreFiles: false,
          });
          assert.deepEqual(
            conversationOnly.storedEvents.map((stored) => stored.event.type),
            ["thread.metadata-updated", "checkpoint.rollback-requested"],
          );
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("runtime-rollback-delete"),
            threadId,
          });
          const deletedCommandId = CommandId.make("runtime-rollback-deleted");
          const deletedSequence = yield* orchestrator.getThreadEventSequence(threadId);
          const deleted = yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId: deletedCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
              restoreFiles: false,
            })
            .pipe(Effect.flip);
          assert.instanceOf(deleted, Orchestrator.OrchestratorDispatchError);
          assert.equal(deleted.cause, `Thread ${threadId} is deleted.`);
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), deletedSequence);
          assert.deepEqual(yield* outbox.listByCommandId(deletedCommandId), []);
        } else {
          const error = yield* rollback.pipe(Effect.flip);
          assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
          assert.equal(
            error.cause,
            `Checkpoint ${checkpointId} is ${status} and cannot be restored.`,
          );
          assert.equal(yield* orchestrator.getThreadEventSequence(threadId), previousSequence);
          assert.deepEqual(
            yield* eventSink.readByCommandId({ commandId }).pipe(Stream.runCollect),
            [],
          );
          assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
          if (status === "error") {
            // A failed capture still pins the conversation.
            const conversationCommandId = CommandId.make("runtime-rollback-error-conversation");
            const conversationOnly = yield* orchestrator.dispatch({
              type: "checkpoint.rollback",
              commandId: conversationCommandId,
              threadId,
              checkpointId,
              scopeId: scope.id,
              restoreFiles: false,
            });
            assert.deepEqual(
              conversationOnly.storedEvents.map((stored) => stored.event.type),
              ["thread.metadata-updated", "checkpoint.rollback-requested"],
            );
            assert.deepEqual(
              (yield* outbox.listByCommandId(conversationCommandId)).map(
                (effect) => effect.request.type,
              ),
              ["provider-thread.rollback"],
            );
          }
        }
      }
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("resolves delivery intent against the active run and starts after it completes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const threadId = ThreadId.make("runtime-delivery-intent");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-delivery-intent-create"),
        threadId,
        projectId: ProjectId.make("runtime-delivery-intent-project"),
        title: "Delivery intent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-delivery-intent-first"),
        threadId,
        messageId: MessageId.make("runtime-delivery-intent-first"),
        text: "Start work.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });
      const initial = yield* orchestrator.getThreadProjection(threadId);
      const run = initial.runs[0]!;
      const providerThread = initial.providerThreads[0]!;
      const now = yield* DateTime.now;
      const providerSession = {
        id: providerThread.providerSessionId!,
        driver,
        providerInstanceId: modelSelection.instanceId,
        status: "running" as const,
        cwd: process.cwd(),
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const providerTurn = {
        id: ProviderTurnId.make("runtime-delivery-intent-turn"),
        providerThreadId: providerThread.id,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      };
      yield* eventSink.write({
        commandId: CommandId.make("runtime-delivery-intent-running"),
        events: [
          {
            id: EventId.make("runtime-delivery-intent-run-event"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "running", startedAt: now },
          },
          {
            id: EventId.make("runtime-delivery-intent-session-event"),
            type: "provider-session.attached",
            threadId,
            occurredAt: now,
            payload: providerSession,
          },
          {
            id: EventId.make("runtime-delivery-intent-turn-event"),
            type: "provider-turn.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: providerTurn,
          },
        ],
      });
      const sessionSpy = vi.spyOn(sessions, "get").mockReturnValue(
        Effect.succeedSome({
          providerSession,
        } as ProviderAdapter.ProviderAdapterV2SessionRuntime),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));

      const steerCommandId = CommandId.make("runtime-delivery-intent-auto");
      const steerMessageId = MessageId.make("runtime-delivery-intent-auto");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: steerCommandId,
        threadId,
        messageId: steerMessageId,
        text: "Include this in the active work.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "auto",
      });
      const steered = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(steered.runs, 1);
      assert.equal(
        steered.messages.find((message) => message.id === steerMessageId)?.runId,
        run.id,
      );
      assert.deepEqual(
        (yield* outbox.listByCommandId(steerCommandId)).map((effect) => effect.request),
        [
          {
            type: "provider-turn.steer",
            providerSessionId: providerSession.id,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
            messageId: steerMessageId,
            modelSelection: run.modelSelection,
            steerFollowUpAfterRunOrdinal: run.ordinal,
          },
        ],
      );

      yield* eventSink.write({
        commandId: CommandId.make("runtime-delivery-intent-completed"),
        events: [
          {
            id: EventId.make("runtime-delivery-intent-run-completed"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
          {
            id: EventId.make("runtime-delivery-intent-turn-completed"),
            type: "provider-turn.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...providerTurn, status: "completed", completedAt: now },
          },
        ],
      });
      const nextCommandId = CommandId.make("runtime-delivery-intent-next");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: nextCommandId,
        threadId,
        messageId: MessageId.make("runtime-delivery-intent-next"),
        text: "The previous run finished before this arrived.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "restart",
      });
      const restarted = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        restarted.runs.map((candidate) => candidate.status),
        ["completed", "starting"],
      );
      assert.deepEqual(
        (yield* outbox.listByCommandId(nextCommandId)).map((effect) => effect.request.type),
        ["provider-turn.start"],
      );
    }),
  );

  const seedPendingQuestion = Effect.fnUntraced(function* (
    threadId: ThreadId,
    runId: RunId | null,
    responseCapability: OrchestrationV2RuntimeRequest["responseCapability"],
  ) {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const requestId = RuntimeRequestId.make(`${threadId}:request`);
    const nodeId = NodeId.make(`${threadId}:node`);
    const itemId = TurnItemId.make(`${threadId}:item`);
    yield* eventSink.write({
      commandId: CommandId.make(`${threadId}:seed`),
      events: [
        {
          id: EventId.make(`${threadId}:node-event`),
          type: "node.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make(`${threadId}:request-event`),
          type: "runtime-request.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability,
            createdAt: now,
            resolvedAt: null,
          },
        },
        {
          id: EventId.make(`${threadId}:item-event`),
          type: "turn-item.updated",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: itemId,
            type: "user_input_request",
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            requestId,
            questions: [
              { id: "color", header: "Color", question: "Which color?", options: [] },
              {
                id: "sizes",
                header: "Sizes",
                question: "Which sizes?",
                options: [],
                multiSelect: true,
              },
              {
                id: "note",
                header: "Note",
                question: "Anything else?",
                options: [],
                required: false,
              },
            ],
          },
        },
      ],
    });
    return { requestId, nodeId, itemId };
  });

  it.effect("answers an async question after its provider exits and commits the answer once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("runtime-async-question");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("runtime-async-question-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("runtime-async-question-project"),
        title: "Async question",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      const { requestId, nodeId, itemId } = yield* seedPendingQuestion(threadId, null, {
        type: "message",
      });
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const now = yield* DateTime.now;
      const beforeSnooze = yield* orchestrator.getThreadProjection(threadId);
      const snooze = {
        type: "thread.snooze" as const,
        commandId: CommandId.make("runtime-async-question-snooze"),
        threadId,
        snoozedUntil: "2099-07-25T09:00:00.000Z",
      };
      yield* orchestrator.dispatch(snooze);
      const snoozed = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(snoozed.thread.snoozedUntil);
      assert.deepEqual(snoozed.runtimeRequests, beforeSnooze.runtimeRequests);
      assert.deepEqual(snoozed.turnItems, beforeSnooze.turnItems);
      assert.deepEqual(snoozed.nodes, beforeSnooze.nodes);
      assert.deepEqual(snoozed.runs, beforeSnooze.runs);

      // A question arriving after an earlier snooze must be acknowledged even
      // when the user picks the same wake time again.
      const priorSnooze = DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 1_000);
      yield* eventSink.write({
        commandId: CommandId.make("runtime-async-question-earlier-snooze"),
        events: [
          {
            id: EventId.make("runtime-async-question-earlier-snooze-event"),
            type: "thread.snoozed",
            threadId,
            occurredAt: priorSnooze,
            payload: { ...snoozed.thread, snoozedAt: priorSnooze },
          },
        ],
      });
      yield* orchestrator.dispatch({
        ...snooze,
        commandId: CommandId.make("runtime-async-question-resnooze"),
      });
      assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.snoozedAt, now);
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("runtime-async-question-wake"),
        threadId,
        reason: "user",
      });
      const awake = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(awake.thread.snoozedUntil);
      assert.deepEqual(awake.runtimeRequests, beforeSnooze.runtimeRequests);

      const beforeInvalid = yield* orchestrator.getThreadProjection(threadId);
      const beforeSequence = yield* eventSink.latestSequence();
      for (const [index, answers] of [
        { color: " ", sizes: ["Small"] },
        { color: "Blue", sizes: ["Small", " "] },
        { color: "Blue", sizes: ["Small"], extra: " " },
      ].entries()) {
        const commandId = CommandId.make(`runtime-async-question-invalid:${index}`);
        const invalid = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId,
            threadId,
            requestId,
            answers,
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure", JSON.stringify(answers));
        assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), beforeInvalid);
        assert.equal(yield* eventSink.latestSequence(), beforeSequence);
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
      }

      const command = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make("runtime-async-question-answer"),
        threadId,
        requestId,
        answers: { color: "  Blue  ", sizes: [], note: "" },
      };
      const accepted = yield* orchestrator.dispatch(command);
      const repeated = yield* orchestrator.dispatch(command);
      assert.equal(repeated.sequence, accepted.sequence);
      const answered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(answered.runtimeRequests[0]?.status, "resolved");
      assert.deepEqual(answered.runtimeRequests[0]?.answers, command.answers);
      assert.equal(answered.nodes.find((node) => node.id === nodeId)?.status, "completed");
      assert.equal(answered.turnItems.find((item) => item.id === itemId)?.status, "completed");
      const answeredItem = answered.turnItems.find((item) => item.id === itemId);
      assert.equal(answeredItem?.type, "user_input_request");
      if (answeredItem?.type === "user_input_request") {
        assert.deepEqual(answeredItem.questionAnswer, {
          requestId,
          answers: command.answers,
          attachmentsByQuestionId: {},
          questionTextById: {
            color: "Which color?",
            sizes: "Which sizes?",
            note: "Anything else?",
          },
        });
      }
      assert.equal(answered.messages.length, 1);
      assert.equal(answered.messages[0]?.text, "Which color?\nBlue\n\nWhich sizes?\nNone selected");
      assert.equal(answered.messages[0]?.role, "user");
      assert.equal(answered.runs.length, 1);
      assert.deepEqual(
        (yield* outbox.listByCommandId(command.commandId)).map((effect) => effect.request.type),
        ["provider-turn.start"],
      );

      const duplicate = yield* orchestrator
        .dispatch({
          ...command,
          commandId: CommandId.make("runtime-async-question-duplicate"),
        })
        .pipe(Effect.result);
      assert.equal(duplicate._tag, "Failure");
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).messages.length, 1);
    }),
  );
});

it.layer(layerLegacyImportTest)("OrchestrationV2 legacy import", (it) => {
  it.effect("hydrates imported transcripts before commands and propagates hydration failures", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const metadataThreadId = ThreadId.make("runtime-layer-legacy-metadata-thread");
      const failureThreadId = ThreadId.make("runtime-layer-legacy-failure-thread");
      const projectId = ProjectId.make("runtime-layer-legacy-project");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${projectId},
          'Legacy project',
          '/tmp/runtime-layer-legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        ) VALUES
          (
            ${metadataThreadId},
            ${projectId},
            'Legacy metadata title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          ),
          (
            ${failureThreadId},
            ${projectId},
            'Legacy failure title',
            '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            '/tmp/runtime-layer-legacy-project',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-04T00:00:00.000Z',
            NULL,
            NULL,
            NULL,
            NULL
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:runtime-layer-legacy:1',
            ${metadataThreadId},
            NULL,
            'user',
            'First imported question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:2',
            ${metadataThreadId},
            NULL,
            'assistant',
            'First imported answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:3',
            ${metadataThreadId},
            NULL,
            'user',
            'Latest imported question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:runtime-layer-legacy:failure',
            ${failureThreadId},
            NULL,
            'user',
            'Imported context must load before archive',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          )
      `;

      yield* importer.reconcileShells;
      assert.isTrue((yield* maintenance.verify).valid);

      yield* threadManagement.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-legacy-metadata-update"),
        threadId: metadataThreadId,
        title: "Updated after import",
      });
      const updatedProjection = yield* threadManagement.getThreadProjection(metadataThreadId);
      assert.equal(updatedProjection.thread.title, "Updated after import");
      assert.deepEqual(
        updatedProjection.messages.map((message) => message.text),
        ["First imported question", "First imported answer", "Latest imported question"],
      );

      yield* sql`
        ALTER TABLE projection_thread_messages
        RENAME TO projection_thread_messages_unavailable
      `;
      const { projectionFailure, hydrationFailure } = yield* Effect.all({
        projectionFailure: threadManagement.getThreadProjection(failureThreadId).pipe(Effect.flip),
        hydrationFailure: threadManagement
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make("runtime-layer-legacy-failed-archive"),
            threadId: failureThreadId,
          })
          .pipe(Effect.flip),
      }).pipe(
        Effect.ensuring(
          sql`
            ALTER TABLE projection_thread_messages_unavailable
            RENAME TO projection_thread_messages
          `.pipe(Effect.orDie),
        ),
      );
      assert.instanceOf(projectionFailure, Orchestrator.OrchestratorProjectionError);
      assert.instanceOf(projectionFailure.cause, LegacyV1ThreadImporter.LegacyV1ThreadImportError);
      assert.instanceOf(hydrationFailure, Orchestrator.OrchestratorDispatchError);
      assert.instanceOf(hydrationFailure.cause, LegacyV1ThreadImporter.LegacyV1ThreadImportError);

      const projectionAfterFailure = yield* orchestrator.getThreadProjection(failureThreadId);
      assert.isNull(projectionAfterFailure.thread.archivedAt);

      yield* threadManagement.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-legacy-retried-archive"),
        threadId: failureThreadId,
      });
      const projectionAfterRetry = yield* threadManagement.getThreadProjection(failureThreadId);
      assert.isNotNull(projectionAfterRetry.thread.archivedAt);
    }),
  );
});

it.layer(layerTest)("OrchestrationV2LayerLive lifecycle", (it) => {
  it.effect("applies lifecycle commands idempotently and emits archive/removal shell deltas", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-lifecycle-thread");
      const projectId = ProjectId.make("runtime-layer-lifecycle-project");
      const project = {
        projectId,
        title: "Lifecycle project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        createdAt: "2026-09-07T00:00:00.000Z",
      } as const;
      yield* seedProject(project);
      const create = {
        type: "thread.create" as const,
        createdBy: "user" as const,
        creationSource: "web" as const,
        commandId: CommandId.make("runtime-layer-lifecycle-create"),
        threadId,
        projectId,
        title: "Lifecycle thread",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
      };

      const firstCreate = yield* orchestrator.dispatch(create);
      const retriedCreate = yield* orchestrator.dispatch(create);
      assert.equal(retriedCreate.sequence, firstCreate.sequence);
      assert.lengthOf(retriedCreate.storedEvents, 1);

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("runtime-layer-lifecycle-metadata"),
        threadId,
        title: "Renamed lifecycle thread",
        branch: "feature/v2",
        worktreePath: "/tmp/ankiel-v2-worktree",
      });
      const staleWorkspaceUpdate = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-layer-lifecycle-stale-workspace"),
          threadId,
          branch: "feature/stale",
          worktreePath: "/tmp/stale-worktree",
          expectedWorktreePath: null,
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleWorkspaceUpdate, Orchestrator.OrchestratorDispatchError);
      const projectionAfterStaleWorkspaceUpdate = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projectionAfterStaleWorkspaceUpdate.thread.branch, "feature/v2");
      assert.equal(
        projectionAfterStaleWorkspaceUpdate.thread.worktreePath,
        "/tmp/ankiel-v2-worktree",
      );
      const pullRequestSnapshot = yield* orchestrator.getShellSnapshot();
      const pullRequest = {
        projectId,
        repository: "owner/repository",
        number: 24,
        url: "https://github.com/owner/repository/pull/24",
      };
      yield* moveProject(projectId, "/workspace/moved", "2026-09-07T00:01:00.000Z");
      const staleProjectWorkspace = yield* orchestrator
        .dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make("runtime-layer-lifecycle-pr-sync-stale-project-workspace"),
          threadId,
          projectId,
          snapshotSequence: pullRequestSnapshot.snapshotSequence,
          expected: {
            workspaceRoot: "/workspace/project",
            branch: "feature/v2",
            worktreePath: "/tmp/ankiel-v2-worktree",
            linkedPullRequest: null,
            branchPullRequest: null,
          },
          branchPullRequest: pullRequest,
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleProjectWorkspace, Orchestrator.OrchestratorDispatchError);
      yield* moveProject(projectId, project.workspaceRoot, "2026-09-07T00:02:00.000Z");
      // An unrelated thread event during discovery must not drop the branch pull request.
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("runtime-layer-lifecycle-visit-during-pr-sync"),
        threadId,
        visitedAt: "2026-09-07T00:02:30.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.sync",
        commandId: CommandId.make("runtime-layer-lifecycle-pr-sync"),
        threadId,
        projectId,
        snapshotSequence: pullRequestSnapshot.snapshotSequence,
        expected: {
          workspaceRoot: "/workspace/project",
          branch: "feature/v2",
          worktreePath: "/tmp/ankiel-v2-worktree",
          linkedPullRequest: null,
          branchPullRequest: null,
        },
        branchPullRequest: pullRequest,
      });
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.branchPullRequest,
        pullRequest,
      );
      const stalePullRequestSync = yield* orchestrator
        .dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make("runtime-layer-lifecycle-pr-sync-stale"),
          threadId,
          projectId,
          snapshotSequence: pullRequestSnapshot.snapshotSequence,
          expected: {
            workspaceRoot: "/workspace/project",
            branch: "feature/v2",
            worktreePath: "/tmp/ankiel-v2-worktree",
            linkedPullRequest: null,
            branchPullRequest: null,
          },
          branchPullRequest: null,
        })
        .pipe(Effect.flip);
      assert.instanceOf(stalePullRequestSync, Orchestrator.OrchestratorDispatchError);
      const staleLinkedPullRequestReplacement = yield* orchestrator
        .dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make("runtime-layer-lifecycle-pr-sync-stale-replacement"),
          threadId,
          projectId,
          snapshotSequence: pullRequestSnapshot.snapshotSequence,
          expected: {
            workspaceRoot: "/workspace/project",
            branch: "feature/v2",
            worktreePath: "/tmp/ankiel-v2-worktree",
            linkedPullRequest: null,
            branchPullRequest: pullRequest,
          },
          branchPullRequest: pullRequest,
          linkedPullRequest: pullRequest,
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleLinkedPullRequestReplacement, Orchestrator.OrchestratorDispatchError);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("runtime-layer-lifecycle-runtime"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("runtime-layer-lifecycle-interaction"),
        threadId,
        interactionMode: "plan",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("runtime-layer-lifecycle-model"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-5.5" },
      });
      yield* orchestrator.dispatch({
        type: "thread.active.reorder",
        commandId: CommandId.make("runtime-layer-lifecycle-active-order"),
        threadId,
        orderKey: "a0",
      });
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).thread.activeOrderKey, "a0");

      const shellOf = (shell: Pick<OrchestrationV2ShellSnapshot, "threads">) =>
        shell.threads.find((thread) => thread.id === threadId)!;
      const untaggedShell = shellOf(yield* orchestrator.getShellSnapshot());
      yield* TestClock.adjust("1 minute");
      for (const [step, tag, tagged, expected] of [
        ["add", "demo", true, ["demo"]],
        ["retry", "demo", true, ["demo"]],
        ["add-other", "private", true, ["demo", "private"]],
        ["remove", "demo", false, ["private"]],
        ["remove-last", "private", false, []],
      ] as const) {
        yield* orchestrator.dispatch({
          type: "thread.tag.set",
          commandId: CommandId.make(`runtime-layer-lifecycle-tag-${step}`),
          threadId,
          tag,
          tagged,
        });
        assert.deepEqual(
          shellOf(yield* orchestrator.getShellSnapshot()).tags ?? [],
          expected,
          step,
        );
      }
      const taggedShell = shellOf(yield* orchestrator.getShellSnapshot());
      // Tags are not activity, so the thread keeps its place in thread lists.
      assert.equal(
        DateTime.toEpochMillis(taggedShell.updatedAt),
        DateTime.toEpochMillis(untaggedShell.updatedAt),
      );

      const preAutoProjection = yield* orchestrator.getThreadProjection(threadId);
      const staleAutoSettle = yield* orchestrator
        .dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("runtime-layer-lifecycle-auto-settle-stale"),
          threadId,
          snapshotAt: DateTime.makeUnsafe(
            DateTime.toEpochMillis(preAutoProjection.thread.updatedAt) - 1,
          ),
        })
        .pipe(Effect.flip);
      assert.instanceOf(staleAutoSettle, Orchestrator.OrchestratorDispatchError);
      yield* orchestrator.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make("runtime-layer-lifecycle-auto-settle"),
        threadId,
        snapshotAt: preAutoProjection.thread.updatedAt,
      });
      const autoSettledProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(autoSettledProjection.thread.settledOverride, "settled");
      assert.isNull(autoSettledProjection.thread.activeOrderKey);
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("runtime-layer-lifecycle-auto-unsettle"),
        threadId,
        reason: "user",
      });
      const postUnsettleProjection = yield* orchestrator.getThreadProjection(threadId);
      const overriddenAutoSettle = yield* orchestrator
        .dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("runtime-layer-lifecycle-auto-settle-overridden"),
          threadId,
          snapshotAt: postUnsettleProjection.thread.updatedAt,
        })
        .pipe(Effect.flip);
      assert.instanceOf(overriddenAutoSettle, Orchestrator.OrchestratorDispatchError);

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-lifecycle-settle"),
        threadId,
      });
      const settledProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(settledProjection.thread.settledOverride, "settled");
      assert.isNotNull(settledProjection.thread.settledAt);

      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("runtime-layer-lifecycle-unsettle"),
        threadId,
        reason: "user",
      });
      const activeProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(activeProjection.thread.settledOverride, "active");
      assert.isNull(activeProjection.thread.settledAt);
      assert.isNotNull(activeProjection.thread.unsettledAt);
      const activeShell = (yield* orchestrator.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.deepEqual(activeShell?.unsettledAt, activeProjection.thread.unsettledAt);

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-lifecycle-resettle"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("runtime-layer-lifecycle-pin-settled"),
        threadId,
      });
      const pinnedProjection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(pinnedProjection.thread.settledOverride, "active");
      assert.isNotNull(pinnedProjection.thread.unsettledAt);

      const archive = yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runtime-layer-lifecycle-archive"),
        threadId,
      });
      const archivedShell = yield* orchestrator.getShellSnapshot();
      assert.notInclude(
        archivedShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.include(
        archivedShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      const activeOnlyShell = yield* orchestrator.getShellSnapshot({ location: "active" });
      assert.notInclude(
        activeOnlyShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.lengthOf(activeOnlyShell.archivedThreads, 0);
      const archiveOnlyShell = yield* orchestrator.getShellSnapshot({ location: "archive" });
      assert.lengthOf(archiveOnlyShell.threads, 0);
      assert.include(
        archiveOnlyShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      assert.deepEqual(
        shellStreamItemFromThreadShell({
          stored: archive.storedEvents[0]!,
          shell: yield* orchestrator.getThreadShell(threadId),
        }),
        {
          kind: "thread.removed",
          sequence: archive.sequence,
          location: "active",
          threadId,
        },
      );

      const remove = yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("runtime-layer-lifecycle-delete"),
        threadId,
      });
      const deletedShell = yield* orchestrator.getShellSnapshot();
      assert.notInclude(
        deletedShell.threads.map((thread) => thread.id),
        threadId,
      );
      assert.notInclude(
        deletedShell.archivedThreads.map((thread) => thread.id),
        threadId,
      );
      assert.deepEqual(
        shellStreamItemFromThreadShell({
          stored: remove.storedEvents[0]!,
          shell: yield* orchestrator.getThreadShell(threadId),
        }),
        {
          kind: "thread.removed",
          sequence: remove.sequence,
          location: "active",
          threadId,
        },
      );

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed lifecycle thread");
      assert.equal(projection.thread.branch, "feature/v2");
      assert.equal(projection.thread.worktreePath, "/tmp/ankiel-v2-worktree");
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.equal(projection.thread.modelSelection.model, "gpt-5.5");
      assert.isNotNull(projection.thread.archivedAt);
      assert.isNotNull(projection.thread.deletedAt);
    }),
  );

  it.effect("keeps the branch pull request when linking another pull request", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("branch-pr-link");
      const projectId = ProjectId.make("branch-pr-project");
      yield* seedProject({
        projectId,
        title: "PR links",
        workspaceRoot: "/workspace/pr-links",
        defaultModelSelection: null,
        createdAt: "2026-09-17T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("branch-pr-create"),
        threadId,
        projectId,
        title: "PR links",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/pr-links",
        worktreePath: null,
      });
      const snapshot = yield* orchestrator.getShellSnapshot();
      yield* orchestrator.dispatch({
        type: "thread.pull-request.sync",
        commandId: CommandId.make("branch-pr-discover"),
        threadId,
        projectId,
        snapshotSequence: snapshot.snapshotSequence,
        expected: {
          workspaceRoot: "/workspace/pr-links",
          branch: "feature/pr-links",
          worktreePath: null,
          linkedPullRequest: null,
          branchPullRequest: null,
        },
        branchPullRequest: {
          projectId,
          repository: "benank/ankielcode",
          number: 1,
          url: "https://github.com/benank/ankielcode/pull/1",
        },
      });
      for (const [index, number] of [2, 2, 1, 3].entries()) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`branch-pr-link-${index}`),
          threadId,
          host: "GitHub.com",
          repository: "Benank/Ankielcode",
          number,
          url: `https://github.com/benank/ankielcode/pull/${number}`,
          source: "manual",
        });
        assert.deepEqual(
          (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map((link) => link.number),
          number === 3 ? [1, 2, 3] : [1, 2],
        );
      }
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("branch-pr-unlink"),
        threadId,
        host: "github.com",
        repository: "benank/ankielcode",
        number: 1,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("branch-pr-link-after-unlink"),
        threadId,
        host: "github.com",
        repository: "benank/ankielcode",
        number: 4,
        url: "https://github.com/benank/ankielcode/pull/4",
        source: "manual",
      });
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map((link) => link.number),
        [2, 3, 4],
      );
    }),
  );

  it.effect("keeps the branch pull request beside one opened in another repository", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("repository-pr-project");
      yield* seedProject({
        projectId,
        title: "Repository PR links",
        workspaceRoot: "/workspace/repository-pr-links",
        defaultModelSelection: null,
        createdAt: "2026-09-17T00:00:00.000Z",
      });
      const linkedNumbers = Effect.fn("linkedNumbers")(function* (
        id: string,
        created: { readonly repository: string; readonly number: number },
      ) {
        const threadId = ThreadId.make(id);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${id}-create`),
          threadId,
          projectId,
          title: "PR links",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/pr-links",
          worktreePath: null,
        });
        const snapshot = yield* orchestrator.getShellSnapshot();
        yield* orchestrator.dispatch({
          type: "thread.pull-request.sync",
          commandId: CommandId.make(`${id}-discover`),
          threadId,
          projectId,
          snapshotSequence: snapshot.snapshotSequence,
          expected: {
            workspaceRoot: "/workspace/repository-pr-links",
            branch: "feature/pr-links",
            worktreePath: null,
            linkedPullRequest: null,
            branchPullRequest: null,
          },
          branchPullRequest: {
            projectId,
            repository: "benank/ankielcode",
            number: 1,
            url: "https://github.com/benank/ankielcode/pull/1",
          },
        });
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`${id}-link`),
          threadId,
          host: "github.com",
          ...created,
          url: `https://github.com/${created.repository}/pull/${created.number}`,
          source: "created",
        });
        return (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map(
          (link) => `${link.repository}#${link.number}`,
        );
      });

      assert.deepEqual(
        yield* linkedNumbers("repository-pr-other", { repository: "benank/api", number: 7 }),
        ["benank/ankielcode#1", "benank/api#7"],
      );
      // A branch that moved on to a new pull request does not drag the old one along.
      assert.deepEqual(
        yield* linkedNumbers("repository-pr-same", { repository: "benank/ankielcode", number: 2 }),
        ["benank/ankielcode#2"],
      );
    }),
  );

  it.effect("retains multiple pull requests and dismissed stack members through rebuilds", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("runtime-multiple-pull-requests");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("multi-pr-create"),
        threadId,
        projectId: ProjectId.make("multi-pr-project"),
        title: "Stack",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "GitHub.com", repository: "Benank/Ankielcode" };
      for (const number of [1, 2]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`multi-pr-link-${number}`),
          threadId,
          ...key,
          number,
          url: `https://github.com/benank/ankielcode/pull/${number}`,
          source: number === 1 ? "manual" : "stack",
        });
      }
      const linked = yield* orchestrator.getThreadShell(threadId);
      assert.deepEqual(
        linked?.pullRequests?.map(({ host, repository, number }) => ({ host, repository, number })),
        [1, 2].map((number) => ({ host: "github.com", repository: "benank/ankielcode", number })),
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("multi-pr-dismiss"),
        threadId,
        ...key,
        number: 2,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("multi-pr-unlink"),
        threadId,
        ...key,
        number: 1,
      });
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.map(({ number, source }) => ({
          number,
          source,
        })),
        [{ number: 2, source: "stack-dismissed" }],
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("multi-pr-rediscover"),
        threadId,
        ...key,
        number: 2,
        url: "https://github.com/benank/ankielcode/pull/2",
        source: "stack",
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "stack-dismissed",
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "stack-dismissed",
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("multi-pr-restore"),
        threadId,
        ...key,
        number: 2,
        url: "https://github.com/benank/ankielcode/pull/2",
        source: "manual",
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "manual",
      );
    }),
  );

  it.effect("starts, records, and stops a pull request watch", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("runtime-pull-request-watch");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-project"),
        title: "Watch",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "benank/ankielcode", number: 7 };
      const url = "https://github.com/benank/ankielcode/pull/7";
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch,
      );

      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-start"),
        threadId,
        ...key,
        watching: true,
        link: { url, source: "agent" },
      });
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.source,
        "agent",
      );
      const started = yield* watchOf;
      assert.isDefined(started);
      if (started === undefined) return;

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("pr-watch-legacy-relink"),
        threadId,
        linkedPullRequest: { projectId: ProjectId.make("pr-watch-project"), ...key, url },
      });
      assert.deepEqual(yield* watchOf, started);

      const recorded = { ...started, headSha: "abc123", failedChecks: ["lint"], wakes: 1 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-record"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: recorded,
      });
      assert.deepEqual(yield* watchOf, recorded);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* watchOf, recorded);

      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-stop"),
        threadId,
        ...key,
        watching: false,
      });
      const late = yield* orchestrator
        .dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make("pr-watch-late-record"),
          threadId,
          ...key,
          startedAt: started.startedAt,
          watch: { ...recorded, wakes: 2 },
          wake: {
            messageId: MessageId.make("pr-watch-late-wake"),
            text: "Update",
            notification: { source: { kind: "monitor" }, outcome: "updated", summary: "#7" },
          },
        })
        .pipe(Effect.flip);
      assert.equal(late._tag, "OrchestratorDispatchError");
      assert.isUndefined(yield* watchOf);
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(messages, []);

      // A client start sends no CI state, so the link's last sync seeds it.
      yield* orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make("pr-watch-ci-running"),
        threadId,
        ...key,
        snapshot: {
          state: "open",
          title: "Watched pull request",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-02T12:30:00.000Z",
          checksState: "pending",
        },
        stack: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-client-start"),
        threadId,
        ...key,
        watching: true,
      });
      assert.isTrue((yield* watchOf)?.checksPending);
    }),
  );

  it.effect("keeps how long a watch holds across reads until the agent changes it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make("runtime-pull-request-watch-until-merged");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-until-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-project"),
        title: "Watch until merged",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "benank/ankielcode", number: 7 };
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch,
      );
      const watch = (id: string, until?: PullRequestWatchUntil) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(id),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/benank/ankielcode/pull/7", source: "agent" },
          ...(until !== undefined && { until }),
        });

      yield* watch("pr-watch-until-start");
      assert.isUndefined((yield* watchOf)?.until);

      yield* watch("pr-watch-until-on", "merged");
      const started = yield* watchOf;
      assert.equal(started?.until, "merged");
      if (started === undefined) return;

      // A read that began before the agent set it must not drop it.
      const { until: _read, ...readBefore } = started;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-until-record"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: { ...readBefore, headSha: "abc123", checksPending: false },
      });
      assert.equal((yield* watchOf)?.until, "merged");
      assert.equal((yield* watchOf)?.headSha, "abc123");

      yield* watch("pr-watch-until-again");
      assert.equal((yield* watchOf)?.until, "merged");
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal((yield* watchOf)?.until, "merged");

      yield* watch("pr-watch-until-off", "checks");
      assert.isUndefined((yield* watchOf)?.until);
      assert.equal((yield* watchOf)?.headSha, "abc123");
    }),
  );

  it.effect.each(["manual", "automatic"])("settling ends every pull request watch: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const threadId = ThreadId.make(`pr-watch-settle-${mode}`);
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`pr-watch-settle-create-${mode}`),
        threadId,
        projectId: ProjectId.make("pr-watch-settle-project"),
        title: "Settle watched PRs",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "benank/ankielcode" };
      for (const number of [7, 8]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-settle-start-${mode}-${number}`),
          threadId,
          ...key,
          number,
          watching: true,
          link: { url: `https://github.com/benank/ankielcode/pull/${number}`, source: "agent" },
        });
      }
      const before = yield* orchestrator.getThreadShell(threadId);
      const started = before?.pullRequests?.[0]?.watch;
      assert.isDefined(started);
      if (started === undefined || before === null) return;
      yield* orchestrator.dispatch({
        ...(mode === "manual"
          ? { type: "thread.settle" as const }
          : { type: "thread.auto-settle" as const, snapshotAt: before.updatedAt }),
        commandId: CommandId.make(`pr-watch-settle-${mode}`),
        threadId,
      });
      const expected = before.pullRequests?.map(({ watch, ...link }) => ({
        ...link,
        endedWatch: watch,
      }));
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pullRequests, expected);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pullRequests, expected);

      for (const wake of [
        undefined,
        {
          messageId: MessageId.make(`pr-watch-settle-late-wake-${mode}`),
          text: "Update",
          notification: {
            source: { kind: "monitor" as const },
            outcome: "updated" as const,
            summary: "#7",
          },
        },
      ]) {
        const late = yield* orchestrator
          .dispatch({
            type: "thread.pull-request-watch.sync",
            commandId: CommandId.make(`pr-watch-settle-late-${mode}-${wake !== undefined}`),
            threadId,
            ...key,
            number: 7,
            startedAt: started.startedAt,
            watch: { ...started, headSha: "late", wakes: 1 },
            ...(wake === undefined ? {} : { wake }),
          })
          .pipe(Effect.flip);
        assert.equal(late._tag, "OrchestratorDispatchError");
      }
      const restart = {
        type: "thread.pull-request.watch" as const,
        threadId,
        ...key,
        number: 7,
        watching: true,
      };
      const blocked = yield* orchestrator
        .dispatch({
          ...restart,
          commandId: CommandId.make(`pr-watch-settle-blocked-${mode}`),
        })
        .pipe(Effect.flip);
      assert.equal(blocked._tag, "OrchestratorDispatchError");
      assert.deepEqual((yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages, []);
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make(`pr-watch-settle-unsettle-${mode}`),
        threadId,
        reason: "user",
      });
      yield* orchestrator.dispatch({
        ...restart,
        commandId: CommandId.make(`pr-watch-settle-restart-${mode}`),
      });
      assert.isDefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);
    }),
  );

  it.effect("archiving ends watches, and an archived thread cannot start one", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-archive");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-archive-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-archive-project"),
        title: "Archive watched PR",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const watch = {
        type: "thread.pull-request.watch" as const,
        threadId,
        host: "github.com",
        repository: "benank/ankielcode",
        number: 7,
        watching: true,
        link: { url: "https://github.com/benank/ankielcode/pull/7", source: "agent" as const },
      };
      const watched = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch !== undefined,
      );
      yield* orchestrator.dispatch({
        ...watch,
        commandId: CommandId.make("pr-watch-archive-start"),
      });
      assert.isTrue(yield* watched);

      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("pr-watch-archive"),
        threadId,
      });
      assert.isFalse(yield* watched);
      const refused = yield* orchestrator
        .dispatch({ ...watch, commandId: CommandId.make("pr-watch-archive-restart") })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");

      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("pr-watch-unarchive"),
        threadId,
      });
      assert.isFalse(yield* watched);
    }),
  );

  it.effect.each([
    { reason: "failed", activityFails: false },
    { reason: "not-found", activityFails: false },
    { reason: "failed", activityFails: true },
    { reason: "not-found", activityFails: true },
    { reason: "forbidden", activityFails: true },
    { reason: "cli-unauthenticated", activityFails: false },
  ] as const)(
    "handles repeated host read failures: $reason (activity fails: $activityFails)",
    ({ reason, activityFails }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(
          `runtime-pull-request-watch-unreadable-${reason}-${activityFails}`,
        );
        const projectId = ProjectId.make(`pr-watch-unreadable-project-${reason}-${activityFails}`);
        yield* seedProject({
          projectId,
          title: "Watch unreadable",
          workspaceRoot: "/workspace/watch-unreadable",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-unreadable-create-${reason}-${activityFails}`),
          threadId,
          projectId,
          title: "Watch unreadable",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-unreadable-start-${reason}-${activityFails}`),
          threadId,
          host: "github.com",
          repository: "benank/ankielcode",
          number: 8,
          watching: true,
          link: { url: "https://github.com/benank/ankielcode/pull/8", source: "agent" },
        });
        let disconnected = false;
        let passed = false;
        let genericFailure = false;
        const activityFailures = yield* Queue.unbounded<void>();
        const readFailure = (operation: string, failure: typeof reason) =>
          failure === "cli-unauthenticated"
            ? new PullRequestUnavailableError({
                reason: failure,
                provider: SourceControlProviderKind.make("github"),
                requirement: "Run `gh auth login`.",
                cause: new Error("private subprocess output"),
              })
            : new PullRequestOperationError({
                operation,
                detail: "host read failed",
                cause: new PullRequestProviderError({
                  provider: SourceControlProviderKind.make("github"),
                  operation,
                  reason: failure,
                  detail: "host read failed",
                }),
              });
        const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              Layer.mock(PullRequestService.PullRequestService)({
                watchFingerprint: () => Effect.succeed(null),
                detail: () =>
                  genericFailure
                    ? Effect.die("host read failed")
                    : disconnected
                      ? (activityFails ? Queue.take(activityFailures) : Effect.void).pipe(
                          Effect.andThen(Effect.fail(readFailure("detail", reason))),
                        )
                      : Effect.succeed({
                          ...watchedPullRequestDetail({
                            projectId,
                            number: 8,
                            at: "2026-10-02T12:00:00.000Z",
                          }),
                          headSha: "abc1234def",
                          checks: [
                            {
                              name: "test",
                              status: passed ? ("success" as const) : ("pending" as const),
                              description: null,
                              url: null,
                              required: true,
                            },
                          ],
                        }),
                activity: () =>
                  disconnected && activityFails
                    ? Queue.offer(activityFailures, undefined).pipe(
                        Effect.andThen(Effect.fail(readFailure("activity", "failed"))),
                      )
                    : Effect.succeed({
                        comments: [],
                        commentCount: 0,
                        commentsTruncated: false,
                        reviewThreads: [],
                        commits: [],
                      }),
              }),
            ),
          ),
        );
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));
        const summaries = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
        );
        yield* sweep;
        assert.deepEqual(yield* summaries, []);
        disconnected = true;
        for (let pass = 0; pass < 15; pass += 1) {
          genericFailure = reason === "failed" && (pass === 0 || (pass >= 2 && pass <= 8));
          yield* TestClock.adjust("2 minutes");
          yield* sweep;
        }

        const thread = yield* orchestrator.getThreadShell(threadId);
        if (reason !== "failed") {
          assert.isUndefined(thread?.pullRequests?.[0]?.watch);
          const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
          const stopped = messages.filter((message) => message.notification !== undefined);
          assert.deepEqual(
            stopped.map((message) => message.notification?.summary),
            [
              reason === "cli-unauthenticated"
                ? "#8: stopped watching, host not set up on the server"
                : "#8: stopped watching, could not read it",
            ],
          );
          if (reason === "cli-unauthenticated") {
            assert.include(stopped[0]?.text, "Run `gh auth login`.");
            assert.notInclude(stopped[0]?.text, "private subprocess output");
          }
          return;
        }
        assert.isDefined(thread?.pullRequests?.[0]?.watch);
        assert.deepEqual(yield* summaries, []);
        disconnected = false;
        genericFailure = false;
        passed = true;
        yield* sweep;
        assert.deepEqual(yield* summaries, ["#8: checks passed"]);
        yield* TestClock.adjust("10 minutes");
        yield* sweep;
        assert.deepEqual(yield* summaries, ["#8: checks passed"]);
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-unreadable-stop-${reason}-${activityFails}`),
          threadId,
          host: "github.com",
          repository: "benank/ankielcode",
          number: 8,
          watching: false,
        });
        yield* worker.drain();
      }),
  );

  // regression: watched #26248 merged and its agent kept saying it was still watching
  it.effect("wakes once when a watched pull request merges, naming the merge commit", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-merged");
      const projectId = ProjectId.make("pr-watch-merged-project");
      yield* seedProject({
        projectId,
        title: "Watch merged",
        workspaceRoot: "/workspace/watch-merged",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-merged-create"),
        threadId,
        projectId,
        title: "Watch merged",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-merged-start"),
        threadId,
        host: "github.com",
        repository: "benank/ankielcode",
        number: 15,
        watching: true,
        link: { url: "https://github.com/benank/ankielcode/pull/15", source: "agent" },
      });
      const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(PullRequestService.PullRequestService)({
              detail: () =>
                Effect.succeed({
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 15,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  state: "merged" as const,
                  mergedAt: "2026-10-02T12:00:00.000Z",
                  mergeCommitSha: "3b2f958603a51d8c42c4ede02eee7b8cb310b2d9",
                  mergedBy: { login: "alexmarminge", name: null, avatarUrl: null },
                }),
              activity: () =>
                Effect.succeed({
                  comments: [],
                  commentCount: 0,
                  commentsTruncated: false,
                  reviewThreads: [],
                  commits: [],
                }),
            }),
          ),
        ),
      );
      yield* reactor.sweep;
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;

      assert.isUndefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);
      const wakes = (yield* orchestrator.getThreadRecords(threadId, ["messages"])).messages.filter(
        (message) => message.notification != null,
      );
      assert.deepEqual(
        wakes.map((message) => message.notification?.summary),
        ["#15: merged, stopped watching"],
      );
      assert.include(wakes[0]!.text, "merged into main by alexmarminge as 3b2f958");
    }),
  );

  it.effect.each([
    // The agent's merge of #19 needs no wake, but its command did not close #20.
    { name: "completed", status: "completed", wakes: ["#20: closed, stopped watching"] },
    // A merge command that failed ended nothing itself.
    {
      name: "failed",
      status: "failed",
      wakes: ["#19: merged, stopped watching", "#20: closed, stopped watching"],
    },
    {
      name: "exit-1",
      status: "completed",
      exitCode: 1,
      wakes: ["#19: merged, stopped watching", "#20: closed, stopped watching"],
    },
    {
      name: "failure-output",
      status: "completed",
      output: "GraphQL: Pull request is not mergeable\n<exited with exit code 1>",
      wakes: ["#19: merged, stopped watching", "#20: closed, stopped watching"],
    },
  ] as const)(
    "ends a watch without a wake when the thread's own agent merged it ($name)",
    ({ name: key, status: ended, wakes: expected, ...result }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-own-merge-${key}`);
        const projectId = ProjectId.make(`pr-watch-own-merge-${key}-project`);
        yield* seedProject({
          projectId,
          title: "Watch own merge",
          workspaceRoot: `/workspace/watch-own-merge-${key}`,
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-own-merge-${key}-create`),
          threadId,
          projectId,
          title: "Watch own merge",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        for (const number of [19, 20]) {
          yield* orchestrator.dispatch({
            type: "thread.pull-request.watch",
            commandId: CommandId.make(`pr-watch-own-merge-${key}-start-${number}`),
            threadId,
            host: "github.com",
            repository: "benank/ankielcode",
            number,
            watching: true,
            link: { url: `https://github.com/benank/ankielcode/pull/${number}`, source: "agent" },
          });
        }

        const states = new Map<number, PullRequestDetail["state"]>([
          [19, "open"],
          [20, "open"],
        ]);
        const detailReads = yield* Queue.unbounded<number>();
        const agentRead = yield* Deferred.make<void>();
        // Each of the reactor's subscribers reads every event, as each event sink stream does.
        const agentEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>({ replay: 16 });
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            detail: (input) =>
              Effect.sync(() => states.get(input.number)!).pipe(
                Effect.tap(() => Queue.offer(detailReads, input.number)),
                // Reads of an open pull request are slow, so the first sweep outlasts the merge.
                Effect.tap((state) => (state === "open" ? Effect.sleep("1 second") : Effect.void)),
                Effect.map((state) => ({
                  ...watchedPullRequestDetail({
                    projectId,
                    number: input.number,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  state,
                })),
              ),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
            // A fingerprint that never changes, so only a forced read sees an end.
            watchFingerprint: () => Effect.succeed({ status: "steady", remarks: "" }),
            invalidate: () => Effect.void,
            changes: () => Stream.never,
          }),
          Layer.succeed(Orchestrator.OrchestratorV2, {
            ...orchestrator,
            streamDomainEvents: Stream.fromPubSub(agentEvents),
          }),
          // Only the read at a command's end asks for one thread's watches.
          Layer.effect(
            ProjectionStore.ProjectionStoreV2,
            Effect.map(ProjectionStore.ProjectionStoreV2, (store) => ({
              ...store,
              getThreadsWithPullRequests: (thread?: ThreadId) =>
                store
                  .getThreadsWithPullRequests(thread)
                  .pipe(
                    Effect.tap(() =>
                      thread === undefined ? Effect.void : Deferred.succeed(agentRead, undefined),
                    ),
                  ),
            })),
          ),
        );
        const runId = RunId.make(`run:${threadId}:1`);
        const command = (status: "running" | typeof ended) =>
          Effect.map(DateTime.now, (at): OrchestrationV2DomainEvent => ({
            type: "turn-item.updated",
            id: EventId.make(`event:${threadId}:merge-${status}`),
            threadId,
            runId,
            occurredAt: at,
            payload: {
              id: TurnItemId.make(`item:${threadId}:merge`),
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status,
              title: null,
              startedAt: at,
              completedAt: status === "completed" ? at : null,
              updatedAt: at,
              type: "command_execution",
              input: "gh pr merge 19 --squash",
              ...(status === "running" ? {} : result),
            },
          }));
        const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* reactor.start();
        // The first sweep has read both as open, and has not recorded that yet.
        yield* Queue.take(detailReads);
        yield* Queue.take(detailReads);

        // While the agent merges #19, someone else closes #20.
        yield* PubSub.publish(agentEvents, yield* command("running"));
        states.set(19, "merged");
        states.set(20, "closed");
        // The command's end reads the thread's watches in full, after that sweep.
        yield* PubSub.publish(agentEvents, yield* command(ended));
        yield* Deferred.await(agentRead);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(detailReads);
        yield* Queue.take(detailReads);
        // A sweep waits for that read to finish.
        yield* reactor.sweep;
        yield* worker.drain();
        const thread = yield* orchestrator.getThreadShell(threadId);
        assert.isTrue(thread?.pullRequests?.every((link) => link.watch === undefined));
        const wakes = (yield* orchestrator.getThreadRecords(threadId, [
          "messages",
        ])).messages.flatMap((message) => message.notification?.summary ?? []);
        assert.sameMembers(wakes, [...expected]);
      }),
  );

  it.effect("a pull request closed, reopened, and then merged wakes once for each end", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-reopened");
      const projectId = ProjectId.make("pr-watch-reopened-project");
      yield* seedProject({
        projectId,
        title: "Watch reopened",
        workspaceRoot: "/workspace/watch-reopened",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-reopened-create"),
        threadId,
        projectId,
        title: "Watch reopened",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "benank/ankielcode", number: 16 };
      const watch = (id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-reopened-${id}`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/benank/ankielcode/pull/16", source: "agent" },
        });
      yield* watch("start");

      let state: PullRequestDetail["state"] = "closed";
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 16,
                at: "2026-10-02T12:00:00.000Z",
              }),
              state,
              checks: [{ name: "lint", status: "pending" as const, description: null, url: null }],
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );
      const watching = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch !== undefined,
      );
      const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
      yield* reactor.sweep;
      assert.deepEqual(yield* summaries, ["#16: closed, stopped watching"]);
      assert.isFalse(yield* watching);

      // Reopening does not restart the watch; the agent was told to watch again.
      state = "open";
      yield* watch("again");
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      assert.isTrue(yield* watching);
      assert.deepEqual(yield* summaries, ["#16: closed, stopped watching"]);

      // The link's own sync can see the merge before the watch reads it.
      state = "merged";
      yield* orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make("pr-watch-reopened-synced"),
        threadId,
        ...key,
        snapshot: {
          state: "merged",
          title: "Watched pull request",
          headBranch: "feature",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-02T12:30:00.000Z",
          mergedAt: "2026-10-02T12:30:00.000Z",
        },
        stack: null,
      });
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      assert.deepEqual(yield* summaries, [
        "#16: closed, stopped watching",
        "#16: merged, stopped watching",
      ]);
      assert.isFalse(yield* watching);
    }),
  );

  it.effect.each([
    // A transport failure, which an open pull request's watch outlasts.
    { name: "unreachable", reason: "failed" },
    // A rate limit pauses the watch before its detail read.
    { name: "rate-limited", reason: "rate-limited" },
  ] as const)(
    "wakes from a merged snapshot when the host cannot be read ($name)",
    ({ name, reason }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectId = ProjectId.make(`pr-watch-merged-unreadable-${name}-project`);
        yield* seedProject({
          projectId,
          title: "Watch merged unreadable",
          workspaceRoot: `/workspace/watch-merged-unreadable-${name}`,
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        const key = { host: "github.com", repository: "benank/ankielcode", number: 8 };
        // Another thread watches the same pull request, before its own link syncs.
        const [merged, unsynced] = (["merged", "unsynced"] as const).map((which) =>
          ThreadId.make(`runtime-pull-request-watch-merged-unreadable-${name}-${which}`),
        ) as [ThreadId, ThreadId];
        for (const threadId of [merged, unsynced]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}-create`),
            threadId,
            projectId,
            title: "Watch merged unreadable",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* orchestrator.dispatch({
            type: "thread.pull-request.watch",
            commandId: CommandId.make(`${threadId}-start`),
            threadId,
            ...key,
            watching: true,
            link: { url: "https://github.com/benank/ankielcode/pull/8", source: "agent" },
          });
        }
        yield* orchestrator.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(`${merged}-synced`),
          threadId: merged,
          ...key,
          snapshot: {
            state: "merged",
            title: "Watched pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-10-02T12:30:00.000Z",
            mergedAt: "2026-10-02T12:30:00.000Z",
          },
          stack: null,
        });
        const failure = (operation: string) =>
          new PullRequestOperationError({
            operation,
            detail: "host unreadable",
            cause: new PullRequestProviderError({
              provider: SourceControlProviderKind.make("github"),
              operation,
              reason,
              detail: "host unreadable",
            }),
          });
        const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              Layer.mock(PullRequestService.PullRequestService)({
                watchFingerprint: () =>
                  reason === "rate-limited"
                    ? Effect.fail(failure("watchFingerprint"))
                    : Effect.succeed(null),
                invalidate: () => Effect.void,
                detail: () => Effect.fail(failure("detail")),
                activity: () => Effect.fail(failure("activity")),
              }),
            ),
          ),
        );
        yield* reactor.sweep;
        yield* TestClock.adjust("10 minutes");
        yield* reactor.sweep;

        const watchOf = (threadId: ThreadId) =>
          Effect.map(
            orchestrator.getThreadShell(threadId),
            (thread) => thread?.pullRequests?.[0]?.watch,
          );
        assert.isUndefined(yield* watchOf(merged));
        assert.isDefined(yield* watchOf(unsynced));
        const wakes = (yield* orchestrator.getThreadRecords(merged, ["messages"])).messages.filter(
          (message) => message.notification != null,
        );
        assert.deepEqual(
          wakes.map((message) => message.notification?.summary),
          ["#8: merged, stopped watching"],
        );
        assert.include(wakes[0]!.text, "merged into main, so");
      }),
  );

  it.effect("ends a watch on a closed pull request whose activity cannot be read", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-closed-unreadable");
      const projectId = ProjectId.make("pr-watch-closed-unreadable-project");
      yield* seedProject({
        projectId,
        title: "Watch closed unreadable",
        workspaceRoot: "/workspace/watch-closed-unreadable",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-closed-unreadable-create"),
        threadId,
        projectId,
        title: "Watch closed unreadable",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-closed-unreadable-start"),
        threadId,
        host: "github.com",
        repository: "benank/ankielcode",
        number: 8,
        watching: true,
        link: { url: "https://github.com/benank/ankielcode/pull/8", source: "agent" },
      });
      const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(PullRequestService.PullRequestService)({
              watchFingerprint: () => Effect.succeed(null),
              detail: () =>
                Effect.succeed({
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 8,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  state: "closed" as const,
                }),
              activity: () => Effect.die("host unreachable"),
            }),
          ),
        ),
      );
      yield* reactor.sweep;

      const thread = yield* orchestrator.getThreadShell(threadId);
      assert.isUndefined(thread?.pullRequests?.[0]?.watch);
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(
        messages.flatMap((message) => message.notification?.summary ?? []),
        ["#8: closed, stopped watching"],
      );
    }),
  );

  it.effect.each([
    // Failures from before the watch stay baseline, even with checks still running.
    {
      label: "finished failing",
      atStart: "failing",
      reads: [
        { lint: "failure", test: "success" },
        { lint: "failure", test: "success" },
      ],
      told: [[], []],
    },
    {
      label: "failing and still running",
      atStart: "failing",
      reads: [
        { lint: "failure", test: "pending" },
        { lint: "failure", test: "failure" },
      ],
      told: [[], ["test"]],
    },
    // Pending CI had no failure, so one the first read finds landed after the start.
    {
      label: "pending",
      atStart: "pending",
      reads: [
        { lint: "failure", test: "pending" },
        { lint: "failure", test: "failure" },
      ],
      told: [["lint"], ["test"]],
    },
  ] as const)(
    "reports only failures after a watch that starts on $label CI",
    ({ label, atStart, reads, told }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-start-${label}`);
        const projectId = ProjectId.make("pr-watch-start-project");
        yield* seedProject({
          projectId,
          title: "Watch start",
          workspaceRoot: "/workspace/watch-start",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-start-create-${label}`),
          threadId,
          projectId,
          title: "Watch start",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const key = { host: "github.com", repository: "benank/ankielcode", number: 13 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`pr-watch-start-link-${label}`),
          threadId,
          ...key,
          url: "https://github.com/benank/ankielcode/pull/13",
          source: "manual",
        });
        yield* orchestrator.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(`pr-watch-start-sync-${label}`),
          threadId,
          ...key,
          snapshot: {
            state: "open",
            title: "Watched pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-10-02T12:00:00.000Z",
            checksState: atStart,
          },
          stack: null,
        });
        // A client start, which carries no CI state of its own.
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-start-watch-${label}`),
          threadId,
          ...key,
          watching: true,
        });

        let read = 0;
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            detail: () =>
              Effect.sync(() => ({
                ...watchedPullRequestDetail({
                  projectId,
                  number: 13,
                  at: "2026-10-02T12:00:00.000Z",
                }),
                headSha: "ad70160aaa",
                checks: Object.entries(reads[read]!).map(([name, status]) => ({
                  name,
                  status,
                  description: null,
                  url: null,
                })),
              })),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
          }),
        );
        const texts = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) => messages.map((message) => message.text),
        );
        const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
        for (const [index, names] of told.entries()) {
          read = index;
          const before = (yield* texts).length;
          if (index > 0) yield* TestClock.adjust("10 minutes");
          yield* reactor.sweep;
          yield* worker.drain();
          const wakes = (yield* texts).slice(before);
          assert.equal(wakes.length, names.length === 0 ? 0 : 1);
          // The finished section lists every failing check, so only the failed one counts here.
          const failedSections = wakes.map((text) => text.split("- Every check has finished")[0]!);
          for (const name of ["lint", "test"]) {
            assert.equal(
              failedSections.some((text) => text.includes(`  - ${name}`)),
              names.includes(name as never),
              `read ${index} told ${name}`,
            );
          }
        }
      }),
  );

  it.effect("baselines a new watch across restarts and reports later changes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-told");
      const projectId = ProjectId.make("pr-watch-told-project");
      yield* seedProject({
        projectId,
        title: "Watch told",
        workspaceRoot: "/workspace/watch-told",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-told-create"),
        threadId,
        projectId,
        title: "Watch told",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const watch = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-told-${id}`),
          threadId,
          host: "github.com",
          repository: "benank/ankielcode",
          number: 12,
          watching: on,
          link: { url: "https://github.com/benank/ankielcode/pull/12", source: "agent" },
        });
      yield* watch(true, "start");

      let headSha = "ad70160aaa";
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 12,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha,
              checks: ["lint", "test"].map((name) => ({
                name,
                status: "success" as const,
                description: null,
                url: null,
                required: true,
              })),
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );

      const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
      yield* reactor.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, []);
      const baseline = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.equal(baseline?.headSha, headSha);
      assert.isTrue(baseline?.passed);
      assert.deepEqual(baseline?.passedChecks, ["lint", "test"]);
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, []);

      const restarted = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, []);

      headSha = "bbbbbbbbbb";
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      yield* watch(false, "stop");
      yield* watch(true, "again");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);

      headSha = "cccccccccc";
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed", "#12: checks passed"]);
      yield* watch(false, "end");
    }),
  );

  it.effect.each([
    ["an idle", false],
    ["a busy", true],
  ] as const)(
    "wakes %s thread once for a pass that changed several of its pull requests",
    ([, busy]) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-pass-${busy}`);
        const projectId = ProjectId.make(`pr-watch-pass-project-${busy}`);
        yield* seedProject({
          projectId,
          title: "Watch pass",
          workspaceRoot: "/workspace/watch-pass",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-pass-create-${busy}`),
          threadId,
          projectId,
          title: "Watch pass",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const numbers = [12, 13, 14];
        for (const number of numbers) {
          yield* orchestrator.dispatch({
            type: "thread.pull-request.watch",
            commandId: CommandId.make(`pr-watch-pass-start-${busy}-${number}`),
            threadId,
            host: "github.com",
            repository: "benank/ankielcode",
            number,
            watching: true,
            link: { url: `https://github.com/benank/ankielcode/pull/${number}`, source: "agent" },
          });
        }
        if (busy) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("pr-watch-pass-busy"),
            threadId,
            messageId: MessageId.make("pr-watch-pass-busy"),
            text: "Keep this run active.",
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          });
        }
        let status: "pending" | "failure" = "pending";
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            detail: (input) =>
              Effect.sync(() => ({
                ...watchedPullRequestDetail({
                  projectId,
                  number: input.number,
                  at: "2026-10-02T12:00:00.000Z",
                }),
                headSha: `head${input.number}`,
                checks: [{ name: "test", status, description: null, url: null, required: true }],
              })),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
          }),
        );

        const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
        yield* reactor.sweep;
        status = "failure";
        yield* reactor.sweep;
        const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
        const wakes = messages.filter((message) => message.notification !== undefined);
        const stamps = wakes.map(({ notification }) =>
          notification?.source.kind === "monitor"
            ? [notification.source.pullRequest, ...(notification.source.otherPullRequests ?? [])]
                .map((stamp) => stamp?.number)
                .toSorted()
            : [],
        );
        assert.deepEqual(stamps, [numbers]);
        for (const number of numbers) assert.include(wakes[0]!.text, `#${number}`);
        if (!busy) return;

        // A pull request unwatched while the wake waited leaves it; the others still start.
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("pr-watch-pass-stop-12"),
          threadId,
          host: "github.com",
          repository: "benank/ankielcode",
          number: 12,
          watching: false,
        });
        const active = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("pr-watch-pass-interrupt"),
          threadId,
          runId: active.id,
        });
        yield* orchestrator.resumeQueuedRuns;
        const after = yield* orchestrator.getThreadProjection(threadId);
        const woken = after.messages.find((message) => message.id === wakes[0]!.id)!;
        assert.notInclude(woken.text, "#12");
        for (const number of [13, 14]) assert.include(woken.text, `#${number}`);
        assert.notEqual(
          after.runs.find((run) => run.userMessageId === woken.id)?.status,
          "cancelled",
        );
      }),
  );

  it.effect(
    "records when a watched PR's checks finish, unless a push cleared that during the read",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("runtime-pull-request-watch-quiet");
        const projectId = ProjectId.make("pr-watch-quiet-project");
        yield* seedProject({
          projectId,
          title: "Watch quiet",
          workspaceRoot: "/workspace/watch-quiet",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("pr-watch-quiet-create"),
          threadId,
          projectId,
          title: "Watch quiet",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        // Two watches, as with a stack, so news on both wakes the thread once for both.
        for (const number of [17, 18]) {
          yield* orchestrator.dispatch({
            type: "thread.pull-request.watch",
            commandId: CommandId.make(`pr-watch-quiet-start-${number}`),
            threadId,
            host: "github.com",
            repository: "benank/ankielcode",
            number,
            watching: true,
            link: { url: `https://github.com/benank/ankielcode/pull/${number}`, source: "agent" },
          });
        }

        let e2e: PullRequestCheck["status"] = "pending";
        let comments: ReadonlyArray<PullRequestComment> = [];
        let gate: {
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            detail: (input) =>
              Effect.gen(function* () {
                if (gate !== null) {
                  yield* Deferred.succeed(gate.started, undefined);
                  yield* Deferred.await(gate.release);
                }
                return {
                  ...watchedPullRequestDetail({
                    projectId,
                    number: input.number,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  checks: [
                    { name: "test", status: "failure" as const, description: null, url: null },
                    { name: "e2e", status: e2e, description: null, url: null },
                  ],
                };
              }),
            activity: () =>
              Effect.sync(() => ({
                comments,
                commentCount: comments.length,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              })),
          }),
        );
        const summaries = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
        );
        const checksPending = Effect.map(orchestrator.getThreadShell(threadId), (thread) => {
          const answers = (thread?.pullRequests ?? []).map((link) => link.watch?.checksPending);
          assert.lengthOf(answers, 2);
          assert.strictEqual(answers[0], answers[1]);
          return answers[0];
        });

        const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
        yield* reactor.sweep;
        assert.deepEqual(yield* summaries, []);
        assert.isTrue(yield* checksPending);
        const reopen = (id: string) =>
          orchestrator.dispatch({
            type: "thread.pull-request-watch.checks-reopen",
            commandId: CommandId.make(`pr-watch-quiet-${id}`),
            threadId,
          });
        // A push forgets a running answer too, so a read begun before it cannot settle it.
        yield* reopen("push-pending");
        assert.isUndefined(yield* checksPending);

        e2e = "success";
        yield* TestClock.adjust("10 minutes");
        yield* reactor.sweep;
        assert.deepEqual(yield* summaries, ["#17: checks finished; #18: checks finished"]);
        assert.isFalse(yield* checksPending);

        // A push clears the answer while a read with news is in flight. That read's answer is the
        // old head's, so the answer stays cleared while its news still wakes the agent.
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        gate = { started, release };
        comments = [
          {
            id: "comment-1",
            kind: "issue-comment",
            author: { login: "reviewer", name: null, avatarUrl: null },
            body: "Looks good once CI passes.",
            createdAt: "2999-01-01T00:00:00.000Z",
            url: null,
            path: null,
            reviewState: null,
          },
        ];
        yield* TestClock.adjust("10 minutes");
        const inFlight = yield* reactor.sweep.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        yield* reopen("push");
        // Another push before the watch read again finds nothing to clear, which is fine.
        yield* reopen("push-again");
        gate = null;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(inFlight);
        assert.lengthOf(yield* summaries, 2);
        assert.isUndefined(yield* checksPending);

        // The next sweep reads it again though nothing on the host changed.
        yield* TestClock.adjust("2 minutes");
        yield* reactor.sweep;
        assert.isFalse(yield* checksPending);
      }),
  );

  it.effect.each(["pending", "action-required"] as const)("recovers %s watches", (initialStatus) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make(`runtime-pull-request-watch-owed-${initialStatus}`);
      const projectId = ProjectId.make(`pr-watch-owed-project-${initialStatus}`);
      yield* seedProject({
        projectId,
        title: "Watch owed",
        workspaceRoot: "/workspace/watch-owed",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`pr-watch-owed-create-${initialStatus}`),
        threadId,
        projectId,
        title: "Watch owed",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const watch = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-owed-${initialStatus}-${id}`),
          threadId,
          host: "github.com",
          repository: "benank/ankielcode",
          number: 12,
          watching: on,
          link: { url: "https://github.com/benank/ankielcode/pull/12", source: "agent" },
        });
      yield* watch(true, "start");

      let remainingStatus: "pending" | "action-required" | "success" = initialStatus;
      const approval = initialStatus === "action-required";
      const runUrl = "https://github.com/benank/ankielcode/actions/runs/123";
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 12,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha: "ad70160aaa",
              checks: ["lint", "test"].map((name) => ({
                name,
                status: name === "test" ? remainingStatus : ("success" as const),
                description: null,
                url: name === "test" ? `${runUrl}/job/7` : null,
                required: name === "lint",
              })),
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );

      const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
      yield* reactor.sweep;
      yield* worker.drain();
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, []);

      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.[
          approval ? "awaitingApproval" : "owedChecks"
        ],
        approval ? [runUrl] : ["test"],
      );
      // The fresh reactor reloads the nonempty obligation from the persisted watch.
      const restarted = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, []);

      // A new watch on the same pull request knows what the last one told, and that its checks
      // were still running. A finished answer may be an older head's, so it reads again.
      yield* watch(false, "stop");
      yield* watch(true, "again");
      assert.strictEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.checksPending,
        approval ? undefined : true,
      );
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, []);

      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.[
          approval ? "awaitingApproval" : "owedChecks"
        ],
        approval ? [runUrl] : ["test"],
      );
      remainingStatus = "success";
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);
      yield* TestClock.adjust("10 minutes");
      yield* restarted.sweep;
      yield* worker.drain();
      assert.deepEqual(yield* summaries, ["#12: checks passed"]);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch?.owedChecks,
        [],
      );
      yield* watch(false, "end");
    }),
  );

  // regression: #21155 watching a pull request again repeated news the thread already got
  it.effect("a watch that ends on the comment limit keeps what its last pass saw", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-limit");
      const projectId = ProjectId.make("pr-watch-limit-project");
      yield* seedProject({
        projectId,
        title: "Watch limit",
        workspaceRoot: "/workspace/watch-limit",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-limit-create"),
        threadId,
        projectId,
        title: "Watch limit",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "benank/ankielcode", number: 13 };
      const watch = (id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-limit-${id}`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/benank/ankielcode/pull/13", source: "agent" },
        });
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0],
      );
      yield* watch("start");
      const started = (yield* watchOf)?.watch;
      assert.isDefined(started);
      if (started === undefined) return;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-limit-told"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: {
          ...started,
          headSha: "abc1234def",
          passed: true,
          passedChecks: ["lint"],
          wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1,
        },
      });

      let status: "pending" | "success" = "pending";
      const commentAt = DateTime.formatIso(
        DateTime.add(DateTime.makeUnsafe(started.startedAt), { seconds: 1 }),
      );
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({ projectId, number: 13, at: commentAt }),
              checks: [{ name: "lint", status, description: null, url: null, required: true }],
            })),
          activity: () =>
            Effect.succeed({
              comments: [
                {
                  id: "reviewer-comment",
                  kind: "issue-comment" as const,
                  author: { login: "reviewer", name: null, avatarUrl: null },
                  body: "One more thing.",
                  createdAt: commentAt,
                  url: "https://github.com/benank/ankielcode/pull/13#comment",
                  path: null,
                  reviewState: null,
                },
              ],
              commentCount: 1,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const summaries = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) => messages.flatMap((message) => message.notification?.summary ?? []),
      );
      const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
      yield* reactor.sweep;
      const ended = yield* watchOf;
      assert.isUndefined(ended?.watch);
      assert.isFalse(ended?.endedWatch?.passed);
      assert.deepEqual(yield* summaries, ["#13: new comments, stopped watching"]);

      status = "success";
      yield* TestClock.adjust("10 minutes");
      yield* watch("again");
      yield* reactor.sweep;
      assert.deepEqual(yield* summaries, [
        "#13: new comments, stopped watching",
        "#13: checks passed",
      ]);
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-limit-end"),
        threadId,
        ...key,
        watching: false,
      });
    }),
  );

  // regression: #23701 a head no check runs on never woke the watch
  it.effect("wakes once when no checks report on the head, without saying they passed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-no-checks");
      const projectId = ProjectId.make("pr-watch-no-checks-project");
      yield* seedProject({
        projectId,
        title: "Watch no checks",
        workspaceRoot: "/workspace/watch-no-checks",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-no-checks-create"),
        threadId,
        projectId,
        title: "Watch no checks",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "benank/ankielcode", number: 14 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-no-checks-start"),
        threadId,
        ...key,
        watching: true,
        link: { url: "https://github.com/benank/ankielcode/pull/14", source: "agent" },
      });

      // A docs-only push that path filters keep every workflow off.
      let headSha = "6074dd48ff";
      let checks: PullRequestDetail["checks"] = [];
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 14,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha,
              checks,
            })),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const wakes = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) =>
          messages.filter(
            (message) => message.notification !== undefined && message.notification !== null,
          ),
      );
      const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
      const anHourOfSweeps = Effect.gen(function* () {
        for (let pass = 0; pass < 6; pass++) {
          yield* reactor.sweep;
          yield* TestClock.adjust("10 minutes");
        }
        yield* reactor.sweep;
      });

      yield* anHourOfSweeps;
      const told = yield* wakes;
      assert.equal(told.length, 1, "one wake for a head with no checks");
      assert.notMatch(told[0]!.text, /\bpass/i);
      assert.notEqual(told[0]!.notification?.outcome, "completed");

      // An empty read on a head whose checks were seen is a failed read, not "no checks".
      headSha = "7777777777";
      checks = [{ name: "lint", status: "pending", description: null, url: null, required: true }];
      // Without a fingerprint, a quiet pull request is read again only once the reread is due.
      yield* TestClock.adjust("10 minutes");
      yield* reactor.sweep;
      checks = [];
      yield* anHourOfSweeps;
      assert.equal((yield* wakes).length, 1);

      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-no-checks-end"),
        threadId,
        ...key,
        watching: false,
      });
    }),
  );

  it.effect(
    "reads a watched pull request when the host reports a change, and wakes once per change",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make("runtime-pull-request-watch-host-event");
        const projectId = ProjectId.make("pr-watch-host-event-project");
        yield* seedProject({
          projectId,
          title: "Watch host events",
          workspaceRoot: "/workspace/watch-host-event",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("pr-watch-host-event-create"),
          threadId,
          projectId,
          title: "Watch host events",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const key = { host: "github.com", repository: "benank/ankielcode", number: 15 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("pr-watch-host-event-start"),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/benank/ankielcode/pull/15", source: "agent" },
        });

        let checks: PullRequestDetail["checks"] = [
          { name: "lint", status: "pending", description: null, url: null, required: true },
        ];
        let fingerprints = 0;
        const events = yield* Queue.unbounded<void>();
        const following = yield* Deferred.make<void>();
        const detailReads = yield* Queue.unbounded<void>();
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            detail: () =>
              Queue.offer(detailReads, undefined).pipe(
                Effect.as({
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 15,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  headSha: "aaaaaaaaaa",
                  checks,
                }),
              ),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
            // A fresh fingerprint every time, so every pass reads the detail.
            watchFingerprint: () =>
              Effect.sync(() => ({ status: String(++fingerprints), remarks: "" })),
            invalidate: () => Effect.void,
            changes: () =>
              Stream.fromEffectDrain(Deferred.succeed(following, undefined)).pipe(
                Stream.concat(Stream.fromQueue(events)),
              ),
          }),
        );
        const wakes = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) =>
            messages.filter(
              (message) => message.notification !== undefined && message.notification !== null,
            ),
        );
        const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* reactor.start();
        // The feed starts after the first sweep has read the pull request.
        yield* Deferred.await(following);
        yield* Queue.take(detailReads);

        checks = [
          { name: "lint", status: "failure", description: null, url: null, required: true },
        ];
        yield* Queue.offer(events, undefined);
        // The clock never moves, so no sweep can be the one that reads the failure.
        yield* Queue.take(detailReads);
        // Nothing new: this read must compare against the watch the last one recorded.
        yield* Queue.offer(events, undefined);
        yield* Queue.take(detailReads);
        // A sweep waits for the change read in flight.
        yield* reactor.sweep;
        yield* worker.drain();
        const woken = yield* wakes;
        assert.lengthOf(woken, 1);
        assert.include(woken[0]!.notification?.summary ?? "", "failed");

        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("pr-watch-host-event-end"),
          threadId,
          ...key,
          watching: false,
        });
      }),
  );

  it.effect(
    "reads a pull request when its watch starts, so checks that pass before a sweep wake",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("runtime-pull-request-watch-start-read");
        const projectId = ProjectId.make("pr-watch-start-read-project");
        yield* seedProject({
          projectId,
          title: "Watch start read",
          workspaceRoot: "/workspace/watch-start-read",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("pr-watch-start-read-create"),
          threadId,
          projectId,
          title: "Watch start read",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });

        let checks: PullRequestDetail["checks"] = [
          { name: "lint", status: "pending", description: null, url: null, required: true },
        ];
        const detailReads = yield* Queue.unbounded<void>();
        const watchListings = yield* Queue.unbounded<void>();
        const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>({ replay: 16 });
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            // Earlier tests can leave watches in other projects; only this one's reads count.
            detail: (input) =>
              (input.projectId === projectId
                ? Queue.offer(detailReads, undefined)
                : Effect.void
              ).pipe(
                Effect.as({
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 16,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  headSha: "bbbbbbbbbb",
                  checks,
                }),
              ),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
            invalidate: () => Effect.void,
            changes: () => Stream.never,
          }),
          // Each subscriber reads every event, as each event sink stream does, and replay means one
          // that subscribes late misses none.
          Layer.mock(Orchestrator.OrchestratorV2)({
            dispatch: orchestrator.dispatch,
            streamDomainEvents: Stream.fromPubSub(domainEvents),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadsWithPullRequests: (id) =>
              projections
                .getThreadsWithPullRequests(id)
                .pipe(Effect.tap(() => Queue.offer(watchListings, undefined))),
          }),
        );
        const wakes = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) =>
            messages.filter(
              (message) => message.notification !== undefined && message.notification !== null,
            ),
        );
        const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* reactor.start();
        // The first sweep listed watches before this one existed, so it cannot be the read below.
        yield* Queue.take(watchListings);

        const key = { host: "github.com", repository: "benank/ankielcode", number: 16 };
        const started = yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("pr-watch-start-read-start"),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/benank/ankielcode/pull/16", source: "agent" },
        });
        yield* PubSub.publishAll(
          domainEvents,
          started.storedEvents.map((stored) => stored.event),
        );
        // The clock never moves, so no sweep can be the read that sees the checks running.
        yield* Queue.take(detailReads);

        checks = [
          { name: "lint", status: "success", description: null, url: null, required: true },
        ];
        // A sweep waits for the watch-start read in flight.
        yield* reactor.sweep;
        yield* worker.drain();
        const woken = yield* wakes;
        assert.lengthOf(woken, 1);
        assert.equal(woken[0]!.notification?.summary, "#16: checks passed");

        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make("pr-watch-start-read-end"),
          threadId,
          ...key,
          watching: false,
        });
        yield* worker.drain();
      }),
  );

  it.effect("wakes for checks that complete after the no-checks notice on the same head", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-late-checks");
      const projectId = ProjectId.make("pr-watch-late-checks-project");
      yield* seedProject({
        projectId,
        title: "Watch late checks",
        workspaceRoot: "/workspace/watch-late-checks",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-late-checks-create"),
        threadId,
        projectId,
        title: "Watch late checks",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "benank/ankielcode", number: 14 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-late-checks-start"),
        threadId,
        ...key,
        watching: true,
        link: { url: "https://github.com/benank/ankielcode/pull/14", source: "agent" },
      });

      const headSha = "6074dd48ff";
      let checks: PullRequestDetail["checks"] = [];
      let activityUnavailable = false;
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () =>
            Effect.sync(() => ({
              ...watchedPullRequestDetail({
                projectId,
                number: 14,
                at: "2026-10-02T12:00:00.000Z",
              }),
              headSha,
              checks,
            })),
          activity: () =>
            activityUnavailable
              ? Effect.die("comments unavailable")
              : Effect.succeed({
                  comments: [],
                  commentCount: 0,
                  commentsTruncated: false,
                  reviewThreads: [],
                  commits: [],
                }),
        }),
      );
      const wakes = Effect.map(
        orchestrator.getThreadRecords(threadId, ["messages"]),
        ({ messages }) =>
          messages.filter(
            (message) => message.notification !== undefined && message.notification !== null,
          ),
      );
      const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));
      yield* sweep;
      assert.lengthOf(yield* wakes, 0);
      yield* TestClock.adjust("20 minutes");
      yield* sweep;
      const noChecks = yield* wakes;
      assert.lengthOf(noChecks, 1);
      assert.include(noChecks[0]!.text, "No checks have reported");
      assert.equal(noChecks[0]!.notification?.outcome, "updated");

      checks = [{ name: "lint", status: "pending", description: null, url: null, required: true }];
      yield* TestClock.adjust("10 minutes");
      yield* sweep;
      assert.lengthOf(yield* wakes, 1);

      activityUnavailable = true;
      checks = [{ name: "lint", status: "success", description: null, url: null, required: true }];
      yield* TestClock.adjust("10 minutes");
      yield* sweep;
      const completed = yield* wakes;
      assert.lengthOf(completed, 2);
      assert.equal(completed[1]!.notification?.summary, "#14: checks passed");
      assert.include(completed[1]!.text, "All 1 required check passed on 6074dd4.");
      assert.equal(completed[1]!.notification?.outcome, "completed");

      yield* TestClock.adjust("1 hour");
      yield* sweep;
      const settled = yield* wakes;
      assert.lengthOf(settled, 2);
      assert.lengthOf(
        settled.filter((message) => message.text.includes("No checks have reported")),
        1,
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("pr-watch-late-checks-end"),
        threadId,
        ...key,
        watching: false,
      });
      yield* worker.drain();
    }),
  );

  it.effect.each([true, false])(
    "reads a quiet head when its no-checks notice comes due (fingerprint: %s)",
    (fingerprinted) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-due-${fingerprinted}`);
        const projectId = ProjectId.make(`pr-watch-due-project-${fingerprinted}`);
        yield* seedProject({
          projectId,
          title: "Watch no-checks deadline",
          workspaceRoot: "/workspace/watch-due",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-due-create-${fingerprinted}`),
          threadId,
          projectId,
          title: "Watch no-checks deadline",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const key = { host: "github.com", repository: "benank/ankielcode", number: 14 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-due-start-${fingerprinted}`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://github.com/benank/ankielcode/pull/14", source: "agent" },
        });

        let reads = 0;
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            // The host reports the same fingerprint throughout, so only the deadline can prompt a read.
            watchFingerprint: () =>
              Effect.succeed(fingerprinted ? { status: "quiet", remarks: "none" } : null),
            invalidate: () => Effect.void,
            detail: () =>
              Effect.sync(() => {
                reads++;
                return {
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 14,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  headSha: "6074dd48ff",
                  checks: [],
                };
              }),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
          }),
        );
        const wakes = Effect.map(
          orchestrator.getThreadRecords(threadId, ["messages"]),
          ({ messages }) =>
            messages.filter((message) => message.text.includes("No checks have reported")),
        );
        const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));

        yield* sweep;
        yield* TestClock.adjust("10 minutes");
        yield* sweep;
        assert.lengthOf(yield* wakes, 0);

        yield* TestClock.adjust("6 minutes");
        yield* sweep;
        const told = yield* wakes;
        assert.lengthOf(told, 1);
        assert.include(told[0]!.text, "after 16 minutes");

        // The notice clears the deadline, so the watch returns to its quiet cadence.
        const readsAfterNotice = reads;
        yield* TestClock.adjust("2 minutes");
        yield* sweep;
        assert.equal(reads, readsAfterNotice);
        assert.lengthOf(yield* wakes, 1);

        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-due-end-${fingerprinted}`),
          threadId,
          ...key,
          watching: false,
        });
        yield* worker.drain();
      }),
  );

  it.effect.each([true, false])(
    "rereads pending checks only on a fingerprint change when it covers them (covers: %s)",
    (coversDetail) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threadId = ThreadId.make(`runtime-pull-request-watch-covers-${coversDetail}`);
        const projectId = ProjectId.make(`pr-watch-covers-project-${coversDetail}`);
        yield* seedProject({
          projectId,
          title: "Watch pending checks",
          workspaceRoot: "/workspace/watch-covers",
          defaultModelSelection: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-covers-create-${coversDetail}`),
          threadId,
          projectId,
          title: "Watch pending checks",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const key = { host: "gitlab.com", repository: "acme/web", number: 15 };
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-covers-start-${coversDetail}`),
          threadId,
          ...key,
          watching: true,
          link: { url: "https://gitlab.com/acme/web/-/merge_requests/15", source: "agent" },
        });

        let reads = 0;
        let status = "running";
        const host = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(PullRequestService.PullRequestService)({
            watchFingerprint: () => Effect.sync(() => ({ status, remarks: "none", coversDetail })),
            invalidate: () => Effect.void,
            detail: (input) =>
              Effect.sync(() => {
                // Watches left by earlier cases in this layer are swept too.
                if (input.projectId === projectId) reads++;
                return {
                  ...watchedPullRequestDetail({
                    projectId,
                    number: 15,
                    at: "2026-10-02T12:00:00.000Z",
                  }),
                  headSha: "6074dd48ff",
                  checks: [
                    {
                      name: "lint",
                      status: "pending",
                      description: null,
                      url: null,
                      required: true,
                    },
                  ],
                };
              }),
            activity: () =>
              Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              }),
          }),
        );
        const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sweep = reactor.sweep.pipe(Effect.andThen(worker.drain()));

        yield* sweep;
        yield* TestClock.adjust("2 minutes");
        yield* sweep;
        assert.equal(reads, coversDetail ? 1 : 2);

        status = "passed";
        yield* TestClock.adjust("2 minutes");
        yield* sweep;
        assert.equal(reads, coversDetail ? 2 : 3);

        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-covers-end-${coversDetail}`),
          threadId,
          ...key,
          watching: false,
        });
        yield* worker.drain();
      }),
  );

  // regression: #21155 watching a pull request again repeated news the thread already got
  it.effect("watching a dismissed stack layer again keeps what its last watch told", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-pull-request-watch-dismissed");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("pr-watch-dismissed-create"),
        threadId,
        projectId: ProjectId.make("pr-watch-dismissed-project"),
        title: "Watch dismissed",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "benank/ankielcode", number: 14 };
      const url = "https://github.com/benank/ankielcode/pull/14";
      const watchOf = Effect.map(
        orchestrator.getThreadShell(threadId),
        (thread) => thread?.pullRequests?.[0]?.watch,
      );
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make("pr-watch-dismissed-link"),
        threadId,
        ...key,
        url,
        source: "stack",
      });
      const watching = (on: boolean, id: string) =>
        orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-dismissed-${id}`),
          threadId,
          ...key,
          watching: on,
          link: { url, source: "agent" },
        });
      yield* watching(true, "start");
      const started = yield* watchOf;
      assert.isDefined(started);
      if (started === undefined) return;
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("pr-watch-dismissed-told"),
        threadId,
        ...key,
        startedAt: started.startedAt,
        watch: { ...started, headSha: "abc1234def", passed: true, passedChecks: ["lint"] },
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make("pr-watch-dismissed-unlink"),
        threadId,
        ...key,
      });
      yield* watching(true, "again");
      const again = yield* watchOf;
      assert.equal(again?.headSha, "abc1234def");
      assert.isTrue(again?.passed);
      yield* watching(false, "end");
    }),
  );

  it.effect("persists each merge queue removal wake across reactor restarts", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("queue-removal-watch");
      const projectId = ProjectId.make("queue-removal-project");
      yield* seedProject({
        projectId,
        title: "Queue removal",
        workspaceRoot: "/workspace/watch",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("queue-removal-create"),
        threadId,
        projectId,
        title: "Queue removal",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("queue-removal-start"),
        threadId,
        host: "github.com",
        repository: "benank/ankielcode",
        number: 7,
        watching: true,
        link: { url: "https://github.com/benank/ankielcode/pull/7", source: "agent" },
      });
      let removal: PullRequestDetail["mergeQueueRemoval"];
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          watchFingerprint: () =>
            Effect.succeed({ status: removal?.id ?? "green", remarks: "none" }),
          invalidate: () => Effect.void,
          detail: () =>
            Effect.succeed({
              ...watchedPullRequestDetail({ projectId, number: 7, at: "2026-10-02T12:00:00.000Z" }),
              checks: [{ name: "lint", status: "success", description: null, url: null }],
              ...(removal === undefined ? {} : { mergeQueueRemoval: removal }),
            }),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
      yield* reactor.sweep;
      yield* worker.drain();
      removal = {
        id: "first",
        removedAt: "2000-01-01T00:00:00Z",
        reason: "Required checks failed",
      };
      yield* reactor.sweep;
      yield* worker.drain();
      const persisted = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.equal(persisted?.mergeQueueRemovalId, "first");
      const restarted = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
      yield* restarted.sweep;
      yield* worker.drain();
      removal = { ...removal, id: "second" };
      yield* restarted.sweep;
      yield* worker.drain();
      yield* restarted.sweep;
      yield* worker.drain();
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      const removals = messages.filter(
        (message) => message.notification?.summary === "#7: removed from merge queue",
      );
      assert.lengthOf(removals, 2);
      for (const message of removals) {
        assert.equal(message.notification?.outcome, "failed");
        assert.include(message.text, "Required checks failed");
      }
      assert.equal(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch
          ?.mergeQueueRemovalId,
        "second",
      );
    }),
  );

  it.effect.each([
    "single page",
    "paginated",
    "page failure",
    "repeated cursor",
    "missing comments",
    "thread list truncated",
    "hidden reply",
  ])("wakes a watched thread once: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`runtime-pull-request-watch-wake-${mode}`);
      const projectId = ProjectId.make(`pr-watch-wake-project-${mode}`);
      yield* seedProject({
        projectId,
        title: "Watch wake",
        workspaceRoot: "/workspace/watch",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`pr-watch-wake-create-${mode}`),
        threadId,
        projectId,
        title: "Watch wake",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "benank/ankielcode", number: 7 };
      const url = "https://github.com/benank/ankielcode/pull/7";
      yield* orchestrator.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(`pr-watch-wake-link-${mode}`),
        threadId,
        ...key,
        url,
        source: "agent",
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`pr-watch-wake-start-${mode}`),
        threadId,
        ...key,
        watching: true,
      });

      const at = "2026-10-02T12:00:00.000Z";
      const detail = watchedPullRequestDetail({ projectId, number: key.number, at });
      const initialWatch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.isDefined(initialWatch);
      const remark: PullRequestComment = {
        id: "review-1",
        kind: "review-comment",
        author: { login: "reviewer", name: null, avatarUrl: null },
        body: "One more thing.",
        createdAt: "2999-01-01T00:00:03.000Z",
        url: null,
        path: "src/index.ts",
        reviewState: null,
      };
      const firstTen = Array.from({ length: 10 }, (_, index) => ({
        ...remark,
        id: `old-${index}`,
        createdAt: "1900-01-01T00:00:00.000Z",
      }));
      const eleventh = {
        ...remark,
        id: "reply-11",
        body: "Eleventh reply.",
        createdAt: "2999-01-01T00:00:01.000Z",
      };
      const twelfth = {
        ...remark,
        id: "reply-12",
        body: "Twelfth reply.",
        createdAt: "2999-01-01T00:00:02.000Z",
      };
      const incomplete = mode !== "single page" && mode !== "paginated" && mode !== "hidden reply";
      let recovering = false;
      let pagesRead = 0;
      const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(PullRequestService.PullRequestService)({
              detail: () => Effect.succeed(detail),
              activity: () =>
                Effect.succeed({
                  comments:
                    mode === "single page"
                      ? [remark]
                      : [...firstTen, { ...remark, kind: "issue-comment" }],
                  commentCount: mode === "single page" ? 1 : 13,
                  commentsTruncated: mode !== "single page",
                  reviewThreadsTruncated: mode === "thread list truncated" && !recovering,
                  reviewThreads:
                    mode === "single page"
                      ? []
                      : [
                          {
                            id: "review-thread",
                            path: "src/index.ts",
                            line: 1,
                            side: "right",
                            isResolved: false,
                            isOutdated: false,
                            comments: firstTen,
                            commentCount: mode === "hidden reply" ? 13 : 12,
                            nextCommentsCursor: "after-10",
                          },
                        ],
                  commits: [],
                }),
              threadComments: (input) => {
                pagesRead += 1;
                assert.equal(input.threadId, "review-thread");
                if (input.cursor === "after-10") {
                  return Effect.succeed({ comments: [eleventh], nextCursor: "after-11" });
                }
                assert.equal(input.cursor, "after-11");
                if (!recovering && mode === "page failure") {
                  return Effect.fail(
                    new PullRequestOperationError({
                      operation: "threadComments",
                      detail: "Page unavailable",
                    }),
                  );
                }
                if (!recovering && mode === "repeated cursor") {
                  return Effect.succeed({ comments: [eleventh], nextCursor: "after-11" });
                }
                if (!recovering && mode === "missing comments") {
                  return Effect.succeed({ comments: [], nextCursor: null });
                }
                return Effect.succeed({
                  comments: [eleventh, twelfth],
                  nextCursor: null,
                  ...(mode === "hidden reply" ? { hiddenCount: 1 } : {}),
                });
              },
            }),
          ),
        ),
      );
      if (incomplete) {
        yield* reactor.sweep;
        const held = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
        assert.equal(held?.remarksThrough, initialWatch?.remarksThrough);
        assert.deepEqual(held?.remarkIds, initialWatch?.remarkIds);
        assert.deepEqual(held?.failedChecks, ["lint"]);
        const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
        assert.deepEqual(messages, []);
        yield* TestClock.adjust("1 millis");
        recovering = true;
      }
      yield* reactor.sweep;
      const pagesBefore = pagesRead;
      yield* reactor.sweep;
      assert.equal(pagesRead, pagesBefore);

      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(
        messages.flatMap((message) =>
          message.notification === undefined ? [] : [message.notification.summary],
        ),
        ["#7: new comments"],
      );
      if (mode !== "single page") {
        const wake = messages.at(-1);
        assert.include(wake?.text ?? "", "3 new comments");
        assert.include(wake?.text ?? "", "Eleventh reply.");
        assert.include(wake?.text ?? "", "Twelfth reply.");
      }
      const watch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.equal(watch?.remarksThrough, remark.createdAt);
      assert.deepEqual(watch?.remarkIds, [remark.id]);
      assert.deepEqual(
        { headSha: watch?.headSha, failedChecks: watch?.failedChecks, wakes: watch?.wakes },
        { headSha: "abc1234def", failedChecks: ["lint"], wakes: 1 },
      );
    }),
  );

  const createWatchedThread = Effect.fnUntraced(function* (name: string, reopened = false) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`pr-wake-${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}-create`),
      threadId,
      projectId: ProjectId.make(`${threadId}-project`),
      title: "Watch wake",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: process.cwd(),
    });
    const key = { host: "github.com", repository: "benank/ankielcode", number: 7 };
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`${threadId}-watch`),
      threadId,
      ...key,
      watching: true,
      link: { url: "https://github.com/benank/ankielcode/pull/7", source: "agent" },
    });
    let watch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
    assert.isDefined(watch);
    const snapshotSyncedAt = reopened
      ? DateTime.formatIso(yield* DateTime.now)
      : "2026-10-02T12:00:00.000Z";
    if (reopened) {
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`${threadId}-end-watch`),
        threadId,
        ...key,
        startedAt: watch.startedAt,
        watch: null,
      });
      yield* TestClock.adjust("1 millis");
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`${threadId}-rewatch`),
        threadId,
        ...key,
        watching: true,
      });
      watch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
      assert.isDefined(watch);
    }
    return { threadId, key, watch, snapshotSyncedAt };
  });

  it.effect.each([
    "unwatch",
    "unlink",
    "new watch",
    "merged",
    "closed",
    "newer head",
    "comments then newer head",
    "comment limit",
    "still watching",
    "closed notice",
    "closed notice unlinked and relinked",
    "reopened",
  ] as const)("revalidates a queued pull-request wake before promotion: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const { threadId, key, watch, snapshotSyncedAt } = yield* createWatchedThread(
        `queued-${mode}`,
        mode === "reopened",
      );
      const finalNotice =
        mode === "closed notice" || mode === "closed notice unlinked and relinked";
      const deliverable =
        mode === "still watching" ||
        mode === "closed notice" ||
        mode === "reopened" ||
        mode === "comments then newer head" ||
        mode === "comment limit";
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}-active`),
        threadId,
        messageId: MessageId.make(`${threadId}-active`),
        text: "Active work",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const wakeMessageId = MessageId.make(`${threadId}-wake`);
      const recordedWatch = { ...watch, headSha: "abc123", wakes: 1 };
      yield* orchestrator.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`${threadId}-wake`),
        threadId,
        ...key,
        startedAt: watch.startedAt,
        watch: finalNotice ? null : recordedWatch,
        wake: {
          messageId: wakeMessageId,
          text: finalNotice ? "Closed, stopped watching" : "Checks failed",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: finalNotice ? "#7: closed, stopped watching" : "#7: checks failed",
          },
          ...(mode === "comments then newer head" || mode === "comment limit"
            ? { includesRemarks: true }
            : {}),
        },
      });
      const userMessageId = MessageId.make(`${threadId}-user`);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}-user`),
        threadId,
        messageId: userMessageId,
        text: "User follow-up",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const activeRun = before.runs.find((run) => run.status === "starting");
      const wakeRun = before.runs.find((run) => run.userMessageId === wakeMessageId);
      const userRun = before.runs.find((run) => run.userMessageId === userMessageId);
      assert.isDefined(activeRun);
      assert.isDefined(wakeRun);
      assert.isDefined(userRun);
      assert.equal(wakeRun.status, "queued");
      assert.equal(userRun.status, "queued");

      if (mode === "unwatch" || mode === "new watch") {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`${threadId}-unwatch`),
          threadId,
          ...key,
          watching: false,
        });
        if (mode === "new watch") {
          yield* TestClock.adjust("1 millis");
          yield* orchestrator.dispatch({
            type: "thread.pull-request.watch",
            commandId: CommandId.make(`${threadId}-rewatch`),
            threadId,
            ...key,
            watching: true,
          });
          const restarted = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]
            ?.watch;
          assert.isDefined(restarted);
          assert.notEqual(restarted.startedAt, watch.startedAt);
          yield* orchestrator.dispatch({
            type: "thread.pull-request-watch.sync",
            commandId: CommandId.make(`${threadId}-same-head`),
            threadId,
            ...key,
            startedAt: restarted.startedAt,
            watch: { ...restarted, headSha: recordedWatch.headSha },
          });
        }
      } else if (mode === "unlink" || mode === "closed notice unlinked and relinked") {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.unlink",
          commandId: CommandId.make(`${threadId}-unlink`),
          threadId,
          ...key,
        });
        if (mode === "closed notice unlinked and relinked") {
          yield* orchestrator.dispatch({
            type: "thread.pull-request.link",
            commandId: CommandId.make(`${threadId}-relink`),
            threadId,
            ...key,
            url: "https://github.com/benank/ankielcode/pull/7",
            source: "manual",
          });
        }
      } else if (
        mode === "merged" ||
        mode === "closed" ||
        mode === "closed notice" ||
        mode === "reopened"
      ) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(`${threadId}-snapshot`),
          threadId,
          ...key,
          snapshot: {
            state: mode === "merged" ? "merged" : "closed",
            title: "Watched pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            // A delayed sync can still report the closure from before this watch restarted.
            syncedAt: snapshotSyncedAt,
          },
          stack: null,
        });
      } else if (mode === "comment limit") {
        yield* orchestrator.dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make(`${threadId}-exhausted`),
          threadId,
          ...key,
          startedAt: watch.startedAt,
          watch: null,
          endedWatch: recordedWatch,
          wake: {
            messageId: MessageId.make(`${threadId}-exhausted`),
            text: "New comments, stopped watching",
            notification: {
              source: { kind: "monitor" },
              outcome: "updated",
              summary: "#7: new comments, stopped watching",
            },
            includesRemarks: true,
          },
        });
      } else if (mode === "newer head" || mode === "comments then newer head") {
        yield* orchestrator.dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make(`${threadId}-advance`),
          threadId,
          ...key,
          startedAt: watch.startedAt,
          watch: { ...recordedWatch, headSha: "def456" },
        });
      }

      const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
      const completedAt = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`${threadId}-completed`),
            type: "run.updated",
            threadId,
            runId: activeRun.id,
            ...(activeRun.rootNodeId === null ? {} : { nodeId: activeRun.rootNodeId }),
            providerInstanceId: activeRun.providerInstanceId,
            occurredAt: completedAt,
            payload: { ...activeRun, status: "completed", completedAt },
          },
        ],
      });
      yield* eventSink.stream({ threadId, afterSequence }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "starting",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        after.runs.find((run) => run.id === wakeRun.id)?.status,
        deliverable ? "starting" : "cancelled",
      );
      assert.equal(
        after.runs.find((run) => run.id === userRun.id)?.status,
        deliverable ? "queued" : "starting",
      );
      if (!deliverable) {
        assert.equal(
          after.attempts.find((attempt) => attempt.id === wakeRun.activeAttemptId)?.status,
          "cancelled",
        );
        assert.equal(
          after.nodes.find((node) => node.id === wakeRun.rootNodeId)?.status,
          "cancelled",
        );
        assert.isFalse(after.turnItems.some((item) => item.runId === wakeRun.id));
      }
      assert.deepEqual(
        after.messages
          .filter((message) => message.id === wakeMessageId)
          .map((message) => message.notification?.summary),
        [finalNotice ? "#7: closed, stopped watching" : "#7: checks failed"],
      );
    }),
  );

  it.effect.each(["open", "merged", "closed", "closed notice", "reopened"] as const)(
    "revalidates a pull-request wake before idle dispatch: %s",
    (mode) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, key, watch, snapshotSyncedAt } = yield* createWatchedThread(
          `idle-${mode}`,
          mode === "reopened",
        );
        yield* orchestrator.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(`${threadId}-snapshot`),
          threadId,
          ...key,
          snapshot: {
            state: mode === "closed notice" || mode === "reopened" ? "closed" : mode,
            title: "Watched pull request",
            headBranch: "feature",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: snapshotSyncedAt,
          },
          stack: null,
        });
        const wakeMessageId = MessageId.make(`${threadId}-wake`);
        yield* orchestrator.dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make(`${threadId}-wake`),
          threadId,
          ...key,
          startedAt: watch.startedAt,
          watch: mode === "closed notice" ? null : { ...watch, headSha: "abc123", wakes: 1 },
          wake: {
            messageId: wakeMessageId,
            text: mode === "closed notice" ? "Closed, stopped watching" : "Checks failed",
            notification: {
              source: { kind: "monitor" },
              outcome: "updated",
              summary:
                mode === "closed notice" ? "#7: closed, stopped watching" : "#7: checks failed",
            },
          },
        });
        const after = yield* orchestrator.getThreadProjection(threadId);
        const deliverable = mode === "open" || mode === "closed notice" || mode === "reopened";
        assert.deepEqual(
          after.runs.map((run) => [run.userMessageId, run.status]),
          deliverable ? [[wakeMessageId, "starting"]] : [],
        );
        assert.deepEqual(
          after.messages.map((message) => message.id),
          deliverable ? [wakeMessageId] : [],
        );
      }),
  );

  it.effect("reads each watched PR as soon as its own fingerprint lands", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("pr-watch-pipeline-project");
      yield* seedProject({
        projectId,
        title: "Watch pipeline",
        workspaceRoot: "/workspace/watch-pipeline",
        defaultModelSelection: null,
        createdAt: "2026-10-01T00:00:00.000Z",
      });
      for (const number of [21, 22]) {
        const threadId = ThreadId.make(`runtime-pull-request-watch-pipeline-${number}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`pr-watch-pipeline-create-${number}`),
          threadId,
          projectId,
          title: "Watch pipeline",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`pr-watch-pipeline-start-${number}`),
          threadId,
          host: "github.com",
          repository: "benank/ankielcode",
          number,
          watching: true,
          link: { url: `https://github.com/benank/ankielcode/pull/${number}`, source: "agent" },
        });
      }
      const at = "2026-10-02T12:00:00.000Z";
      const readHead = (number: number) =>
        orchestrator
          .getThreadShell(ThreadId.make(`runtime-pull-request-watch-pipeline-${number}`))
          .pipe(Effect.map((thread) => thread?.pullRequests?.[0]?.watch?.headSha));
      // #21's host answers only after #22 has been read, so waiting on every fingerprint first
      // never finishes.
      const read22 = yield* Deferred.make<void>();
      const host = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(PullRequestService.PullRequestService)({
          watchFingerprint: (input) =>
            input.number === 21
              ? Deferred.await(read22).pipe(Effect.as(null))
              : Effect.succeed(null),
          detail: (input) =>
            (input.number === 22 ? Deferred.succeed(read22, undefined) : Effect.void).pipe(
              Effect.as(watchedPullRequestDetail({ projectId, number: input.number, at })),
            ),
          activity: () =>
            Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            }),
        }),
      );
      const reactor = yield* makeEnabledPullRequestWatchReactor.pipe(Effect.provide(host));
      yield* reactor.sweep;
      assert.equal(yield* readHead(21), "abc1234def");
      assert.equal(yield* readHead(22), "abc1234def");
    }),
  );

  it.effect("persists rejected command receipts across retries", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const command = {
        type: "thread.archive" as const,
        commandId: CommandId.make("runtime-layer-rejected-command"),
        threadId: ThreadId.make("runtime-layer-missing-thread"),
      };

      const first = yield* orchestrator.dispatch(command).pipe(Effect.flip);
      const retry = yield* orchestrator.dispatch(command).pipe(Effect.flip);

      assert.equal(first._tag, "OrchestratorProjectionError");
      assert.equal(retry._tag, "OrchestratorCommandPreviouslyRejectedError");
    }),
  );

  it.effect(
    "admits restart continuations once and rejects a stale continuation behind newer work",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("runtime-layer-restart-continuation");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("restart-create"),
          threadId,
          projectId: ProjectId.make("restart-project"),
          title: "Restart",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/tmp/runtime-layer-restart",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("restart-user-message"),
          threadId,
          messageId: MessageId.make("restart-user-message"),
          text: "Original work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const original = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        yield* eventSink.commitCommand({
          commandId: CommandId.make("restart-cancel"),
          threadId,
          commandType: "provider-runtime.reconcile",
          acceptedAt: now,
          events: [
            {
              id: EventId.make("restart-cancel-event"),
              type: "run.updated",
              threadId,
              runId: original.id,
              occurredAt: now,
              payload: { ...original, status: "cancelled", completedAt: now },
            },
            {
              id: EventId.make("restart-cut-wake-event"),
              type: "run.created",
              threadId,
              runId: RunId.make("restart-cut-wake"),
              occurredAt: now,
              payload: {
                ...original,
                id: RunId.make("restart-cut-wake"),
                ordinal: 2,
                status: "cancelled",
                startedAt: null,
                completedAt: now,
              },
            },
          ],
          effects: [],
        });
        const command = {
          type: "message.dispatch" as const,
          createdBy: "agent" as const,
          creationSource: "server" as const,
          commandId: CommandId.make("restart-automatic-message"),
          threadId,
          messageId: MessageId.make("restart-automatic-message"),
          text: "Continue where you left off.",
          notification: {
            source: { kind: "system" as const },
            outcome: "updated" as const,
            summary: "Ankiel Code restarted and resumed this turn",
            detail: "Continue where you left off.",
          },
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" as const },
          restartContinuationOfRunId: original.id,
        };
        yield* orchestrator.dispatch(command);
        yield* orchestrator.dispatch(command);
        const admitted = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(admitted.runs, 3);
        assert.equal(admitted.runs[2]?.restartContinuationOfRunId, original.id);
        const continuationItems = admitted.turnItems.filter(
          (item) => item.runId === admitted.runs[2]?.id,
        );
        assert.isFalse(continuationItems.some((item) => item.type === "user_message"));
        assert.deepInclude(
          continuationItems.flatMap((item) =>
            item.type === "notification" ? [[item.summary, item.detail]] : [],
          ),
          ["Ankiel Code restarted and resumed this turn", "Continue where you left off."],
        );
        yield* orchestrator.dispatch({
          ...command,
          commandId: CommandId.make("restart-stale-race"),
          messageId: MessageId.make("restart-stale-race"),
        });
        const raced = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(raced.runs, 3);
        assert.isFalse(raced.messages.some((message) => message.id === "restart-stale-race"));
      }),
  );

  it.effect("rejects settling a thread while a run is active", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-active-settle-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-active-settle-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-active-settle-project"),
        title: "Active settle",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-active-settle",
      });
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-active-settle-initial"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-active-settle-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-active-settle-message"),
        text: "Keep this run active.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const nonEmptyClaim = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("runtime-layer-active-settle-empty-claim"),
          threadId,
          worktreePath: "/tmp/reassigned-after-message",
          expectedEmpty: true,
        })
        .pipe(Effect.flip);
      assert.instanceOf(nonEmptyClaim, Orchestrator.OrchestratorDispatchError);

      const error = yield* orchestrator
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make("runtime-layer-active-settle"),
          threadId,
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.equal(error.cause, `Thread ${threadId} is still running. Stop it before settling.`);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "starting");
      assert.isNull(projection.thread.settledOverride);
      assert.isNull(projection.thread.settledAt);
      assert.isNotNull(projection.thread.unsettledAt);
    }),
  );

  it.effect("keeps a pull request watch its agent started after asking to settle", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const projectId = ProjectId.make("runtime-layer-settle-then-watch-project");
      const threadId = ThreadId.make("runtime-layer-settle-then-watch-thread");

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-settle-then-watch-create"),
        threadId,
        projectId,
        title: "Settle then watch",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-settle-then-watch",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-settle-then-watch-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-settle-then-watch-message"),
        text: "Settle this thread, then watch the pull request.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
      if (run === undefined) return yield* Effect.die(new Error("Run missing."));

      // The deferred settle `settleThread` forks for its own agent's active run.
      const settleRequest = yield* threadManagement
        .settleAfterRun({ projectId, threadId, runId: run.id })
        .pipe(Effect.forkChild);
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("runtime-layer-settle-then-watch-watch"),
        threadId,
        host: "github.com",
        repository: "benank/ankielcode",
        number: 7,
        watching: true,
        link: { url: "https://github.com/benank/ankielcode/pull/7", source: "agent" },
      });
      assert.isDefined((yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch);

      const now = yield* DateTime.now;
      yield* eventSink.write({
        commandId: CommandId.make("runtime-layer-settle-then-watch-completed"),
        events: [
          {
            id: EventId.make("runtime-layer-settle-then-watch-completed"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          },
        ],
      });
      yield* Fiber.join(settleRequest);

      const shell = yield* orchestrator.getThreadShell(threadId);
      assert.isDefined(shell?.pullRequests?.[0]?.watch);
      assert.isNull(shell?.settledOverride ?? null);
    }),
  );

  it.effect.each([false, true])(
    "promotes only one queued run after each terminal run (notification: %s)",
    (automatic) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make(`runtime-layer-serialized-queue-thread-${automatic}`);

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-serialized-queue-create-${automatic}`),
          threadId,
          projectId: ProjectId.make(`runtime-layer-serialized-queue-project-${automatic}`),
          title: "Serialized queue",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-serialized-queue-active-${automatic}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-serialized-queue-active-${automatic}`),
          text: "Active",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: automatic ? "agent" : "user",
          creationSource: automatic ? "provider" : "web",
          ...(automatic
            ? {
                notification: {
                  source: { kind: "monitor" as const },
                  outcome: "updated" as const,
                  summary: "Monitor updated",
                  detail: "Build is green",
                },
              }
            : {}),
          commandId: CommandId.make(`runtime-layer-serialized-queue-first-${automatic}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-serialized-queue-first-${automatic}`),
          text: "First queued",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`runtime-layer-serialized-queue-second-${automatic}`),
          threadId,
          messageId: MessageId.make(`runtime-layer-serialized-queue-second-${automatic}`),
          text: "Second queued",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });

        const before = yield* orchestrator.getThreadProjection(threadId);
        const activeRun = before.runs.find((run) => run.status === "starting");
        const queuedRuns = before.runs
          .filter((run) => run.status === "queued")
          .toSorted((left, right) => left.ordinal - right.ordinal);
        const firstQueuedRun = queuedRuns[0];
        const secondQueuedRun = queuedRuns[1];
        assert.isDefined(activeRun);
        assert.isDefined(firstQueuedRun);
        assert.isDefined(secondQueuedRun);
        assert.isFalse(
          before.turnItems.some(
            (item) =>
              item.type === "user_message" &&
              (item.messageId === firstQueuedRun.userMessageId ||
                item.messageId === secondQueuedRun.userMessageId),
          ),
          "queued messages must not exist as turn items before dispatch",
        );

        const promotedRunIds = yield* Queue.unbounded<RunId>();
        const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
        yield* eventSink.stream({ threadId, afterSequence }).pipe(
          Stream.runForEach((stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "starting"
              ? Queue.offer(promotedRunIds, stored.event.payload.id)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        const activeCompletedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`runtime-layer-serialized-queue-active-completed-${automatic}`),
              type: "run.updated",
              threadId,
              runId: activeRun.id,
              ...(activeRun.rootNodeId === null ? {} : { nodeId: activeRun.rootNodeId }),
              providerInstanceId: activeRun.providerInstanceId,
              occurredAt: activeCompletedAt,
              payload: {
                ...activeRun,
                status: "completed",
                completedAt: activeCompletedAt,
              },
            },
          ],
        });

        assert.equal(yield* Queue.take(promotedRunIds), firstQueuedRun.id);
        const afterFirstPromotion = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          afterFirstPromotion.runs.find((run) => run.id === firstQueuedRun.id)?.status,
          "starting",
        );
        assert.equal(
          afterFirstPromotion.runs.find((run) => run.id === secondQueuedRun.id)?.status,
          "queued",
        );
        const promotedMessageItem = afterFirstPromotion.turnItems.find(
          (item) =>
            item.runId === firstQueuedRun.id &&
            (item.type === "user_message" || item.type === "notification"),
        );
        assert.isDefined(promotedMessageItem);
        if (automatic) {
          assert.equal(promotedMessageItem.type, "notification");
          assert.equal(
            afterFirstPromotion.messages.find(
              (message) => message.id === firstQueuedRun.userMessageId,
            )?.text,
            "First queued",
          );
          assert.equal(
            afterFirstPromotion.messages.find(
              (message) => message.id === firstQueuedRun.userMessageId,
            )?.notification?.summary,
            "Monitor updated",
          );
          assert.isFalse(
            afterFirstPromotion.turnItems.some(
              (item) =>
                item.type === "user_message" && item.messageId === firstQueuedRun.userMessageId,
            ),
          );
        } else {
          assert.equal(promotedMessageItem.type, "user_message");
        }
        assert.isTrue(
          promotedMessageItem.startedAt !== null &&
            DateTime.toEpochMillis(promotedMessageItem.startedAt) >=
              DateTime.toEpochMillis(activeCompletedAt),
        );

        const promotedFirst = afterFirstPromotion.runs.find((run) => run.id === firstQueuedRun.id);
        assert.isDefined(promotedFirst);
        const firstCompletedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`runtime-layer-serialized-queue-first-completed-${automatic}`),
              type: "run.updated",
              threadId,
              runId: promotedFirst.id,
              ...(promotedFirst.rootNodeId === null ? {} : { nodeId: promotedFirst.rootNodeId }),
              providerInstanceId: promotedFirst.providerInstanceId,
              occurredAt: firstCompletedAt,
              payload: {
                ...promotedFirst,
                status: "completed",
                completedAt: firstCompletedAt,
              },
            },
          ],
        });

        assert.equal(yield* Queue.take(promotedRunIds), secondQueuedRun.id);
        const afterSecondPromotion = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          afterSecondPromotion.runs.find((run) => run.id === firstQueuedRun.id)?.status,
          "completed",
        );
        assert.equal(
          afterSecondPromotion.runs.find((run) => run.id === secondQueuedRun.id)?.status,
          "starting",
        );
      }),
  );

  it.effect("keeps the queue after a user interrupts the active run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("runtime-layer-interrupted-queue");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`${threadId}:create`),
        threadId,
        projectId: ProjectId.make(`${threadId}:project`),
        title: "Interrupted queue",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: process.cwd(),
      });
      for (const [index, text] of ["Active", "Queued"].entries()) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:message:${index}`),
          threadId,
          messageId: MessageId.make(`${threadId}:message:${index}`),
          text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
        });
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      const activeRun = before.runs[0]!;
      const queuedRun = before.runs[1]!;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${threadId}:interrupt`),
        threadId,
        runId: activeRun.id,
        holdQueue: true,
      });

      yield* orchestrator.resumeQueuedRuns;
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === activeRun.id)?.status, "interrupted");
      assert.equal(after.runs.find((run) => run.id === queuedRun.id)?.status, "queued");
      assert.isTrue(after.runs.find((run) => run.id === queuedRun.id)?.queueHeld);
      assert.isFalse(after.turnItems.some((item) => item.runId === queuedRun.id));
    }),
  );

  it.effect.each([
    { trigger: "startup", started: true },
    { trigger: "shutdown", started: true },
    { trigger: "startup", started: false },
    { trigger: "shutdown", started: false },
  ] as const)(
    "preserves and holds queued messages across $trigger with started=$started until explicitly resumed",
    ({ trigger, started }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const recovery = yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService;
        const threadId = ThreadId.make(`queue-hold-${trigger}-${started}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Recover queue",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
        });
        for (const [index, text] of ["Active", "First queued", "Second queued"].entries()) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${threadId}:message:${index}`),
            threadId,
            messageId: MessageId.make(`${threadId}:message:${index}`),
            text,
            attachments: [],
            modelSelection,
            dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
          });
        }
        const before = yield* orchestrator.getThreadProjection(threadId);
        const source = before.runs[0]!;
        if (started) {
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make(`${threadId}:started`),
                type: "run.updated",
                threadId,
                occurredAt: yield* DateTime.now,
                payload: { ...source, status: "running", startedAt: yield* DateTime.now },
              },
              {
                id: EventId.make(`${threadId}:accepted`),
                type: "provider-turn.updated",
                threadId,
                runId: source.id,
                occurredAt: yield* DateTime.now,
                payload: {
                  id: ProviderTurnId.make(`${threadId}:turn`),
                  providerThreadId: source.providerThreadId!,
                  nodeId: source.rootNodeId!,
                  runAttemptId: source.activeAttemptId,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt: yield* DateTime.now,
                  completedAt: null,
                },
              },
            ],
          });
        }
        const queued = before.runs.filter((run) => run.status === "queued");
        assert.equal(queued.length, 2);
        yield* recovery.reconcile(trigger);
        yield* recovery.reconcile("startup");
        const maintenance = yield* ProjectionReplay.ProjectionReplay;
        assert.isTrue((yield* maintenance.rebuild).valid);
        assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          held.runs.map((run) => run.status),
          [started ? "cancelled" : "queued", "queued", "queued"],
        );
        if (!started) {
          assert.deepInclude(
            held.runs.find((run) => run.id === source.id),
            {
              status: "queued",
              queueHeld: true,
              queuePosition: 1,
            },
          );
        }
        if (!started) {
          const prompt = held.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === source.userMessageId,
          );
          assert.deepInclude(prompt, {
            inputIntent: "queued_turn",
            status: "pending",
            startedAt: null,
            completedAt: null,
          });
        }
        for (const [index, run] of queued.entries()) {
          assert.deepEqual(
            held.runs.find((row) => row.id === run.id),
            { ...run, queueHeld: true, ...(started ? {} : { queuePosition: index + 2 }) },
          );
          assert.deepEqual(
            held.messages.find((row) => row.id === run.userMessageId),
            before.messages.find((row) => row.id === run.userMessageId),
          );
          assert.equal(
            held.attempts.find((row) => row.id === run.activeAttemptId)?.status,
            "pending",
          );
          assert.equal(held.nodes.find((row) => row.id === run.rootNodeId)?.status, "pending");
        }
        const first = queued[0]!;
        const second = started ? queued[1]! : source;
        if (started) {
          yield* orchestrator.dispatch({
            type: "queued-run.edit",
            commandId: CommandId.make(`${threadId}:edit`),
            threadId,
            runId: second.id,
            text: "Edited second message",
          });
          yield* orchestrator.dispatch({
            type: "queued-run.reorder",
            commandId: CommandId.make(`${threadId}:reorder`),
            threadId,
            runId: second.id,
            beforeRunId: first.id,
          });
        }
        assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
        const resume = {
          type: "queue.resume" as const,
          commandId: CommandId.make(`${threadId}:resume`),
          threadId,
        };
        yield* orchestrator.dispatch(resume);
        yield* orchestrator.dispatch(resume);
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(resumed.runs.find((run) => run.id === second.id)?.status, "starting");
        assert.equal(resumed.runs.find((run) => run.id === first.id)?.status, "queued");
        assert.isFalse(resumed.runs.some((run) => run.status === "queued" && run.queueHeld));
        assert.equal(
          resumed.messages.find((row) => row.id === second.userMessageId)?.text,
          started ? "Edited second message" : "Active",
        );
        if (!started) {
          assert.equal(
            resumed.attempts.find((row) => row.id === source.activeAttemptId)?.status,
            "pending",
          );
          assert.equal(
            resumed.nodes.find((row) => row.id === source.rootNodeId)?.status,
            "pending",
          );
          // Recovery command identities include the restart timestamp.
          yield* TestClock.adjust("1 millis");
          yield* recovery.reconcile("startup");
          yield* orchestrator.dispatch({
            ...resume,
            commandId: CommandId.make(`${threadId}:resume-again`),
          });
          const starts = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
            CommandId.make(`command:system:start-queued:${source.id}`),
          );
          const pendingStarts = starts.filter((effect) => effect.status === "pending");
          assert.lengthOf(pendingStarts, 1);
          assert.deepEqual(pendingStarts[0]?.request, {
            type: "provider-turn.start",
            runId: source.id,
          });
        }
        const afterRetries = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          afterRetries.runs.length,
          3,
          "resume retries must not duplicate messages or runs",
        );
        assert.lengthOf(afterRetries.messages, before.messages.length);
      }),
  );

  it.effect("edits and removes queued runs", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("runtime-layer-queued-edit-thread");
      const attachment = (name: string) =>
        ({
          type: "image",
          id: `runtime-layer-queued-edit-${name}`,
          name: `${name}.png`,
          mimeType: "image/png",
          sizeBytes: 128,
        }) as const;
      const kept = attachment("kept");
      const shared = attachment("shared");
      const dropped = attachment("dropped");
      const effectRequests = (commandId: string) =>
        Effect.map(outbox.listByCommandId(CommandId.make(commandId)), (effects) =>
          effects.map((effect) => effect.request),
        );

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-create"),
        threadId,
        projectId: ProjectId.make("runtime-layer-queued-edit-project"),
        title: "Edit queued work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/runtime-layer-queued-edit",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-active-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-queued-edit-active-message"),
        text: "Keep the provider occupied.",
        attachments: [shared],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-queued-edit-queued-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-queued-edit-queued-message"),
        text: "Original queued text.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });

      const before = yield* orchestrator.getThreadProjection(threadId);
      const queuedRun = before.runs.find((run) => run.status === "queued");
      assert.isDefined(queuedRun);

      const editedSelection = {
        ...modelSelection,
        model: "gpt-5.5",
        options: [
          { id: "reasoningEffort", value: "medium" },
          { id: "serviceTier", value: "priority" },
        ],
      };
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-edit"),
        threadId,
        runId: queuedRun.id,
        text: "Updated queued text.",
        modelSelection: editedSelection,
      });

      const afterEdit = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterEdit.messages.find((message) => message.id === queuedRun.userMessageId)?.text,
        "Updated queued text.",
      );
      assert.deepEqual(
        afterEdit.runs.find((run) => run.id === queuedRun.id)?.modelSelection,
        editedSelection,
      );
      assert.deepEqual(afterEdit.thread.modelSelection, before.thread.modelSelection);
      const editedItem = afterEdit.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === queuedRun.userMessageId,
      );
      assert.isUndefined(editedItem, "editing queue state must not create a timeline turn item");

      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-attachments"),
        threadId,
        runId: queuedRun.id,
        text: "Updated queued text with an attachment.",
        attachments: [kept, shared, dropped],
      });
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-drop-attachments"),
        threadId,
        runId: queuedRun.id,
        text: "Updated queued text with an attachment.",
        attachments: [kept],
      });
      const afterAttachmentEdit = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        afterAttachmentEdit.messages
          .find((message) => message.id === queuedRun.userMessageId)
          ?.attachments.map((attachment) => attachment.id),
        [kept.id],
      );
      assert.deepEqual(
        yield* effectRequests("runtime-layer-queued-edit-drop-attachments"),
        [
          {
            type: "attachment.cleanup",
            attachmentIds: [shared.id, dropped.id],
            skipReferenced: true,
          },
        ],
        "dropped files are queued for a cleanup that skips files the thread still references",
      );

      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("runtime-layer-queued-edit-text-only"),
        threadId,
        runId: queuedRun.id,
        text: "Text-only edit keeps attachments.",
      });
      const afterTextOnlyEdit = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        afterTextOnlyEdit.messages
          .find((message) => message.id === queuedRun.userMessageId)
          ?.attachments.map((attachment) => attachment.id),
        [kept.id],
        "an edit without attachments must leave the stored attachments untouched",
      );
      assert.deepEqual(yield* effectRequests("runtime-layer-queued-edit-text-only"), []);
      assert.deepEqual(
        afterTextOnlyEdit.runs.find((run) => run.id === queuedRun.id)?.modelSelection,
        editedSelection,
      );

      const emptyEditError = yield* orchestrator
        .dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("runtime-layer-queued-edit-empty"),
          threadId,
          runId: queuedRun.id,
          text: "   ",
        })
        .pipe(Effect.flip);
      assert.equal(emptyEditError._tag, "OrchestratorCommandRejectedError");

      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("runtime-layer-queued-edit-cancel"),
        threadId,
        runId: queuedRun.id,
      });

      const afterCancel = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterCancel.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
      assert.equal(
        afterCancel.attempts.find((attempt) => attempt.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.equal(
        afterCancel.nodes.find((node) => node.runId === queuedRun.id)?.status,
        "cancelled",
      );
      assert.isFalse(
        afterCancel.visibleTurnItems.some(
          (row) => row.item.type === "user_message" && row.item.runId === queuedRun.id,
        ),
        "removed queued message must not surface as a transcript row",
      );
      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);

      const cancelAgainError = yield* orchestrator
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("runtime-layer-queued-edit-cancel-again"),
          threadId,
          runId: queuedRun.id,
        })
        .pipe(Effect.flip);
      assert.equal(cancelAgainError._tag, "OrchestratorDispatchError");
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("pending provider interruption", (it) => {
  it.effect("interrupts a pending provider start without launching provider work", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const effectWorker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const projectId = ProjectId.make("runtime-layer-pending-interrupt-project");
      const threadId = ThreadId.make("runtime-layer-pending-interrupt-thread");

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-pending-interrupt-project-create"),
        projectId,
        title: "Pending interrupt project",
        workspaceRoot: "/tmp/runtime-layer-pending-interrupt-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-pending-interrupt-create"),
        threadId,
        projectId,
        title: "Pending interrupt",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-pending-interrupt-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-pending-interrupt-message"),
        text: "Do not reach the provider.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const starting = yield* orchestrator.getThreadProjection(threadId);
      const run = starting.runs[0];
      assert.isDefined(run);
      assert.equal(run.status, "starting");

      const interrupt = yield* threadManagement.interruptThread({
        projectId,
        commandId: CommandId.make("runtime-layer-pending-interrupt-command"),
        threadId,
        runId: run.id,
        reason: "Cancelled before provider start",
      });
      assert.equal(interrupt.type, "interrupt_requested");

      const interrupted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(interrupted.runs[0]?.status, "interrupted");
      assert.equal(interrupted.attempts[0]?.status, "interrupted");
      assert.equal(
        interrupted.nodes.find((node) => node.kind === "root_turn")?.status,
        "interrupted",
      );
      assert.deepEqual(
        interrupted.turnItems.filter((item) => item.runId === run.id).map((item) => item.type),
        ["user_message", "run_interrupt_request", "run_interrupt_result"],
      );
      assert.deepEqual(interrupted.providerTurns, []);
      assert.isFalse(yield* effectWorker.runOnce());
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("snooze projection", (it) => {
  it.effect("carries snooze, settle and title state through the V2 shell projection", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projectId = ProjectId.make("runtime-layer-snoozed-project");
      const threadId = ThreadId.make("runtime-layer-snoozed-thread");
      const snoozedUntil = "2099-07-25T09:00:00.000Z";

      yield* projects.create({
        commandId: CommandId.make("runtime-layer-snoozed-project-create"),
        projectId,
        title: "Snoozed shell projection",
        workspaceRoot: "/tmp/runtime-layer-snoozed-project",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-thread-create"),
        threadId,
        projectId,
        title: "New thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze"),
        threadId,
        snoozedUntil,
      });

      const firstProjection = yield* orchestrator.getThreadProjection(threadId);
      const firstSnoozedAt = firstProjection.thread.snoozedAt;
      assert.isNotNull(firstSnoozedAt);

      // Restamp snoozedAt for identical wake times so previously waking failures do not keep the thread awake.
      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-again"),
        threadId,
        snoozedUntil,
      });

      const shell = yield* orchestrator.getShellSnapshot();
      const thread = shell.threads.find((candidate) => candidate.id === threadId);
      assert.isDefined(thread);
      assert.equal(DateTime.formatIso(thread.snoozedUntil!), snoozedUntil);
      assert.equal(
        DateTime.toEpochMillis(thread.snoozedAt!),
        DateTime.toEpochMillis(firstSnoozedAt!) + 1_000,
      );
      assert.deepEqual(thread.updatedAt, thread.snoozedAt);

      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-wake"),
        threadId,
        reason: "user",
      });
      const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.provide(ProjectionStore.layer),
      );
      const [candidate] = yield* projections.getSettlementCandidates(threadId);
      assert.deepEqual(candidate?.lastSnoozeWakeAt, yield* DateTime.now);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("runtime-layer-snoozed-thread-settle"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("runtime-layer-snoozed-thread-snooze-after-wake"),
        threadId,
        snoozedUntil,
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-snoozed-message"),
        threadId,
        messageId: MessageId.make("runtime-layer-snoozed-message"),
        text: "Wake this thread.",
        titleSeed: "Woken thread",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });

      const awakened = yield* orchestrator.getThreadProjection(threadId);
      assert.isNull(awakened.thread.snoozedUntil);
      assert.isNull(awakened.thread.snoozedAt);
      assert.isNull(awakened.thread.settledOverride);
      assert.isNull(awakened.thread.settledAt);
      assert.equal(awakened.thread.title, "Woken thread");
      assert.equal(
        awakened.thread.titleRegeneration?.requestId,
        CommandId.make("runtime-layer-snoozed-message"),
      );
    }),
  );
});

it.layer(Layer.fresh(layerSharedApplicationDataPlaneTest))("PR link events", (it) => {
  it.effect("persists only the changed PR link and replays it without losing other links", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("compact-pr-sync");
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("compact-pr-create"),
        threadId,
        projectId: ProjectId.make("compact-pr-project"),
        title: "PR sync",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const key = { host: "github.com", repository: "benank/ankielcode" };
      const repositoryWebUrl = "https://github.com/benank/ankielcode/pull/2";
      for (const number of [1, 2]) {
        yield* orchestrator.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`compact-pr-link-${number}`),
          threadId,
          ...key,
          number,
          url: `https://github.com/benank/ankielcode/pull/${number}`,
          source: "manual",
          ...(number === 2 ? { repositoryWebUrl } : {}),
        });
      }
      const watchedLink = {
        url: "https://github.com/benank/ankielcode/pull/3",
        repositoryWebUrl: "https://github.com/benank/ankielcode/pull/3",
        source: "manual" as const,
      };
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("compact-pr-watch-new"),
        threadId,
        ...key,
        number: 3,
        watching: true,
        link: watchedLink,
      });
      yield* orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("compact-pr-watch-existing"),
        threadId,
        ...key,
        number: 2,
        watching: true,
      });
      const before = yield* orchestrator.getThreadShell(threadId);
      yield* orchestrator.dispatch({
        type: "thread.pull-request-link.sync",
        commandId: CommandId.make("compact-pr-sync"),
        threadId,
        ...key,
        number: 2,
        snapshot: {
          state: "open",
          title: "Updated PR",
          headBranch: "feature/pr",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-13T12:00:00.000Z",
        },
        stack: {
          kind: "native",
          id: "updated",
          number: 2,
          url: "https://github.com/benank/ankielcode/pull/2",
          base: "main",
          layers: [],
        },
      });
      const rows = yield* sql<{ event_type: string; payload_json: string }>`
        SELECT event_type, payload_json FROM orchestration_events
        WHERE command_id = ${"compact-pr-sync"}
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.event_type, "thread.pull-request-link-updated");
      const payload = JSON.parse(rows[0]!.payload_json);
      assert.equal(payload.number, 2);
      assert.isUndefined(payload.pullRequests);
      const after = yield* orchestrator.getThreadShell(threadId);
      assert.equal(after?.pullRequests?.length, 3);
      assert.deepEqual(after?.pullRequests?.[0], before?.pullRequests?.[0]);
      assert.deepEqual(after?.pullRequests?.[2], before?.pullRequests?.[2]);
      assert.equal(after?.pullRequests?.[1]?.stack?.id, "updated");
      assert.propertyVal(after?.pullRequests?.[1], "repositoryWebUrl", repositoryWebUrl);
      assert.deepInclude(after?.pullRequests?.[2], watchedLink);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(
        (yield* orchestrator.getThreadShell(threadId))?.pullRequests,
        after?.pullRequests,
      );
    }),
  );
});

it.layer(layerSharedApplicationDataPlaneTest)("shared application data plane", (it) => {
  it.effect("orders retained project transactions and V2 thread transactions in one source", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("runtime-layer-shared-project");
      const threadId = ThreadId.make("runtime-layer-shared-thread");
      const projectInput = {
        commandId: CommandId.make("runtime-layer-shared-project-create"),
        projectId,
        title: "Shared application source",
        workspaceRoot: "/tmp/runtime-layer-shared-project",
      };

      const created = yield* projects.create(projectInput);
      const retried = yield* projects.create(projectInput);
      assert.deepEqual(retried, created);

      const delivered = yield* Queue.unbounded<ApplicationStoredEvent>();
      yield* applicationEvents.streamApplicationEvents().pipe(
        Stream.take(2),
        Stream.runForEach((event) => Queue.offer(delivered, event)),
        Effect.forkScoped,
      );

      const projectEvent = yield* Queue.take(delivered);
      assert.isTrue("aggregateKind" in projectEvent && projectEvent.aggregateId === projectId);

      const threadResult = yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("runtime-layer-shared-thread-create"),
        threadId,
        projectId,
        title: "Shared thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const threadEvent = yield* Queue.take(delivered);

      assert.equal(threadEvent.sequence, threadResult.sequence);
      assert.isAbove(threadEvent.sequence, projectEvent.sequence);
      assert.isTrue("aggregateKind" in projectEvent);
      assert.isTrue("event" in threadEvent);
      assert.equal((yield* projects.getById(projectId))._tag, "Some");

      const retainedReceipts = yield* sql<{
        readonly aggregate_kind: string;
        readonly aggregate_id: string;
      }>`
        SELECT aggregate_kind, aggregate_id
        FROM orchestration_command_receipts
        ORDER BY result_sequence ASC
      `;
      assert.deepEqual(retainedReceipts, [
        { aggregate_kind: "project", aggregate_id: projectId },
        { aggregate_kind: "thread", aggregate_id: threadId },
      ]);

      const retiredWrites = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_v2_events) +
          (SELECT COUNT(*) FROM orchestration_v2_command_receipts) AS count
      `;
      assert.equal(retiredWrites[0]?.count, 0);
    }),
  );
});
