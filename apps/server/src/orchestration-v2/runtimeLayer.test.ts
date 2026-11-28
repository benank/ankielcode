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
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
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
