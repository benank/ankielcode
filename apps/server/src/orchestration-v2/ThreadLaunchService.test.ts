import * as DocumentText from "../provider/DocumentText.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import { assert, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ChatAttachmentId,
  ComposerContextId,
  type ChatAttachment,
  CommandId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@ankielcode/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:launch-test");
const otherProjectId = ProjectId.make("project:launch-other");
const dispatchIntakeCommand = (
  command: Parameters<typeof ThreadMessageIntake.dispatchCommand>[0],
) => ThreadMessageIntake.dispatchCommand(command, { managesProviders: true });
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  trackedFolders: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const otherProject = {
  ...project,
  id: otherProjectId,
  title: "Other",
  workspaceRoot: "/other-repo",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const claudeModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
} as const;
const claudeAdapter = {
  instanceId: claudeModelSelection.instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

interface HarnessOptions {
  readonly closeTerminal?: TerminalManager.TerminalManager["Service"]["close"];
  readonly adapters?: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>;
  readonly managedFolders?: Layer.Layer<ManagedProjectFolders.ManagedProjectFolders>;
  /** Defaults to a project that tracks no repository, so worktrees are single checkouts. */
  readonly taskFolders?: Layer.Layer<TaskFolders.TaskFolders>;
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly fetchWorktreeBaseCommit?: GitWorkflow.GitWorkflowService["Service"]["fetchWorktreeBaseCommit"];
  readonly remoteExists?: GitWorkflow.GitWorkflowService["Service"]["remoteExists"];
  readonly hasCommit?: GitWorkflow.GitWorkflowService["Service"]["hasCommit"];
  readonly renameBranch?: GitWorkflow.GitWorkflowService["Service"]["renameBranch"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  readonly generateBranchName?: TextGeneration.TextGeneration["Service"]["generateBranchName"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly getLaunchSettings?: ServerSettings.ServerSettingsService["Service"]["getSettings"];
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
  readonly dispatch?: (
    command: Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0],
    dispatch: ThreadManagement.ThreadManagementService["Service"]["dispatch"],
  ) => ReturnType<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>;
  readonly isGitRepository?: CheckpointStore.CheckpointStore["Service"]["isGitRepository"];
}

function makeHarness(options: HarnessOptions = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(options.adapters ?? [adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest(options.serverSettings);
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const renameBranch = vi.fn(
    options.renameBranch ?? ((input) => Effect.succeed({ branch: input.newBranch })),
  );
  const removeWorktree = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["removeWorktree"]>[0]) =>
      Effect.void,
  );
  const deleteLocalBranch = vi.fn(
    (_input: Parameters<GitWorkflow.GitWorkflowService["Service"]["deleteLocalBranch"]>[0]) =>
      Effect.void,
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const closeTerminal = vi.fn(options.closeTerminal ?? (() => Effect.void));
  const generateBranchName = vi.fn(
    options.generateBranchName ?? (() => Effect.succeed({ branch: "generated-branch" })),
  );
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: closeTerminal }),
    Layer.mock(CheckpointStore.CheckpointStore)({
      isGitRepository: options.isGitRepository ?? (() => Effect.succeed(true)),
    }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      listPage: () => Effect.die("unused"),
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some(project)
            : id === otherProjectId
              ? Option.some(otherProject)
              : Option.none(),
        ),
      getByWorkspaceRoot: () => Effect.succeedSome(project),
      workspaceScanDirectory: () => Effect.die("unused"),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      repositoryRoot: () => Effect.succeed(project.workspaceRoot),
      createWorktree,
      renameBranch,
      fetchWorktreeBaseCommit:
        options.fetchWorktreeBaseCommit ??
        (() => Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" })),
      hasCommit: options.hasCommit ?? (() => Effect.succeed(false)),
      currentBranch: () => Effect.succeed(null),
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "main" }),
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: () => Effect.succeed("main"),
      remoteExists: options.remoteExists ?? (() => Effect.succeed(true)),
      remoteBranchExists: () => Effect.succeed(true),
      listLocalBranchNames: () => Effect.succeed([]),
      removeWorktree,
      deleteLocalBranch,
      ...options.git,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle,
      generateBranchName,
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(options.providers),
    options.taskFolders ??
      Layer.mock(TaskFolders.TaskFolders)({ plan: () => Effect.succeed(null) }),
    options.managedFolders ??
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
        folderForThread: () => Effect.succeedNone,
      }),
  );
  const interceptDispatch = options.dispatch;
  const layerLaunchThreads =
    interceptDispatch === undefined
      ? layerThreadManagement
      : Layer.effect(
          ThreadManagement.ThreadManagementService,
          Effect.gen(function* () {
            const threads = yield* ThreadManagement.ThreadManagementService;
            return ThreadManagement.ThreadManagementService.of({
              ...threads,
              dispatch: (command) => interceptDispatch(command, threads.dispatch),
            });
          }),
        ).pipe(Layer.provide(layerThreadManagement));
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerExternalServices,
        layerLaunchThreads,
        layerReceipts,
        layerOrchestrator,
        IdAllocator.layer,
        options.getLaunchSettings === undefined
          ? Layer.empty
          : Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: options.getLaunchSettings,
            }),
      ),
    ),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
              defaultThreadEnvMode: null,
              hasCustomTitle: false,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: project.scripts,
              trackedFolders: [],
              pinnedAt: null,
              archivedAt: null,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
              deletedAt: project.deletedAt,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        layerProjectedProjects,
        layerExternalServices,
        NodeServices.layer,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerLaunch,
      layerRegistry,
      layerThreadManagement,
      layerTitleRegeneration,
      layerOutbox,
      layerDatabase,
      layerExternalServices,
    ),
    createWorktree,
    removeWorktree,
    deleteLocalBranch,
    renameBranch,
    generateBranchName,
    generateThreadTitle,
    runSetup,
    closeTerminal,
  };
}

function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace?: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
}) {
  return {
    commandId: CommandId.make(input.command),
    threadId: ThreadId.make(input.thread),
    projectId,
    title: "New thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: input.workspace ?? { type: "root" as const },
    ...(input.message === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(`${input.message}:id`),
            text: input.message,
            attachments: [],
          },
        }),
    createdBy: "user" as const,
    creationSource: "web" as const,
  };
}

it.effect(
  "returns no dispatched thread when sending an automation to a missing thread fails",
  () => {
    const harness = makeHarness();
    const layerScheduledTasks = ScheduledTasks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          harness.layer,
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    return Effect.gen(function* () {
      const tasks = yield* ScheduledTasks.ScheduledTaskService;
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId } = yield* launches.launch(
        launchInput({ command: "command:missing", thread: "thread:missing" }),
      );
      const { task } = yield* tasks.upsert({
        title: "Daily audit",
        prompt: "Audit performance and crashes.",
        enabled: false,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      });
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("command:missing:delete"),
        threadId,
      });
      const result = yield* tasks.runNow({ id: task.id });
      assert.equal(result.task.lastRunStatus, "failed");
      assert.isNull(result.threadId);
      assert.equal(result.task.threadId, threadId);
    }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerScheduledTasks)));
  },
);

it.effect("a run asked for a result stores what its agent submits once it fits the schema", () => {
  const harness = makeHarness({ runSetup: () => Effect.never });
  const outputSchema = {
    type: "object",
    properties: { verdict: { enum: ["merge", "fix-first"] } },
    required: ["verdict"],
  };
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const input = launchInput({
      command: "command:output:launch",
      thread: "thread:output",
      message: "Review it",
      workspace: { type: "worktree", baseRef: "main" },
    });
    const launched = yield* launches.launch({
      ...input,
      initialMessage: { ...input.initialMessage!, outputSchema },
    });
    const submit = (command: string, json: string) =>
      threads.submitRunOutput({
        threadId: launched.threadId,
        commandId: CommandId.make(command),
        json,
      });

    const rejected = yield* submit("command:output:bad", '{"verdict":"maybe"}').pipe(Effect.flip);
    assert.equal(rejected._tag, "ThreadManagementRunOutputRejectedError");
    // What did not fit is kept as the cause, for the agent that wrote it and nobody's logs.
    assert.equal(rejected.message, "The result does not match the schema.");
    assert.include(
      String((rejected as { cause?: { message?: string } }).cause?.message),
      "verdict",
    );
    const unparsed = yield* submit("command:output:text", "merge").pipe(Effect.flip);
    assert.include(unparsed.message, "not valid JSON");

    const accepted = yield* submit("command:output:good", '{"verdict":"merge","note":"kept"}');
    const stored = (yield* threads.getThreadProjection(launched.threadId)).runs.find(
      (run) => run.id === accepted.runId,
    );
    assert.deepStrictEqual(stored?.outputSchema, outputSchema);
    // Kept as submitted, including what the schema does not name.
    assert.deepStrictEqual(stored?.output?.value, { verdict: "merge", note: "kept" });

    // Asking for a result never joins the running turn, and a plain turn has nothing to submit to.
    const next = yield* threads.sendToThread({
      projectId,
      commandId: CommandId.make("command:output:next"),
      threadId: launched.threadId,
      messageId: MessageId.make("message:output:next"),
      text: "Review it again",
      attachments: [],
      mode: "steer",
      outputSchema,
      createdBy: "agent",
      creationSource: "mcp",
    });
    assert.equal(next.delivery, "queued");
    assert.deepStrictEqual(next.run.outputSchema, outputSchema);
    assert.isUndefined(next.run.output);
    const unusable = yield* threads
      .sendToThread({
        projectId,
        commandId: CommandId.make("command:output:unusable"),
        threadId: launched.threadId,
        messageId: MessageId.make("message:output:unusable"),
        text: "Review it again",
        attachments: [],
        mode: "queue",
        outputSchema: { $ref: "#/$defs/Missing" },
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(unusable));
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a run that was not asked for a result rejects a submission", () => {
  const harness = makeHarness({ runSetup: () => Effect.never });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:no-output:launch",
        thread: "thread:no-output",
        message: "Just talk",
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    const rejected = yield* threads
      .submitRunOutput({
        threadId: launched.threadId,
        commandId: CommandId.make("command:no-output:submit"),
        json: "{}",
      })
      .pipe(Effect.flip);
    assert.include(rejected.message, "not asked for a result");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("a rejected initial message leaves no title change and no new thread", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ adapters: [adapter, claudeAdapter] });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:launch:reused-title-failure");
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("command:launch:reused-title-failure:create"),
        threadId,
        projectId,
        title: "Original title",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });

      const commandId = CommandId.make("command:launch:reused-title-failure");
      const failed = yield* launches
        .launch({
          ...launchInput({
            command: commandId,
            thread: threadId,
            message: "Generate a provisional title",
          }),
          reuseExistingThread: true,
          title: "Generate a provisional title",
          generateTitle: true,
          modelSelection: {
            instanceId: ProviderInstanceId.make("missing-provider"),
            model: "missing-model",
          },
        })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(failed));
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Original title");
      assert.isUndefined(projection.thread.titleRegeneration);
      assert.isEmpty(projection.messages);
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make(`${commandId}:initial-message`)));

      // The orchestrator refuses this goal command, after the launch's own checks pass.
      const newThreadId = ThreadId.make("thread:launch:rejected-new-thread");
      const rejected = yield* launches
        .launch({
          ...launchInput({
            command: "command:launch:rejected-new-thread",
            thread: newThreadId,
            message: "/goal pause",
          }),
          modelSelection: claudeModelSelection,
        })
        .pipe(Effect.flip);
      if (rejected._tag !== "ThreadLaunchError") {
        assert.fail(`expected ThreadLaunchError, got ${rejected._tag}`);
      }
      assert.equal(rejected.operation, "create-thread");
      assert.isNull(yield* threads.getThreadShell(newThreadId));
    }).pipe(Effect.provide(harness.layer));
  }),
);

/** Settles once preparation releases the run, or fails it. */
const preparationSettled = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.streamStoredEventsFrom({ threadId }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          (stored.commandId?.endsWith(":release") === true ||
            stored.event.payload.status === "failed"),
      ),
      Stream.runHead,
    );
    return yield* threads.getThreadProjection(threadId);
  });

it.effect.each(["stable", "upstream/release"])(
  "launches from %s with the fetched commit and remote PR base",
  (baseRef) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "launch-remote-base-" });
      const cwd = `${directory}/repo`;
      const remote = `${directory}/remote.git`;
      const worktreePath = `${directory}/worktree`;
      yield* fs.makeDirectory(cwd);
      const command = (at: string, args: string[]) =>
        git.execute({ operation: "launch-test", cwd: at, args });
      yield* command(cwd, ["init", "-b", "stable"]);
      yield* command(cwd, ["config", "user.name", "Test"]);
      yield* command(cwd, ["config", "user.email", "test@example.test"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "initial"]);
      const localHead = (yield* command(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      yield* command(cwd, ["init", "--bare", remote]);
      yield* command(cwd, ["remote", "add", "upstream", remote]);
      yield* command(cwd, ["push", "-u", "upstream", "stable:release"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "remote advance"]);
      yield* command(cwd, ["push", "upstream", "stable:release"]);
      const remoteHead = (yield* command(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      yield* command(cwd, ["reset", "--hard", localHead]);
      yield* command(cwd, ["update-ref", "-d", "refs/remotes/upstream/release"]);

      const setupStarted = yield* Deferred.make<void>();
      const harness = makeHarness({
        hasCommit: ({ refName }) =>
          command(cwd, ["rev-parse", "--verify", `${refName}^{commit}`]).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        git: {
          resolveWorktreeBaseRemote: (input) => git.resolveWorktreeBaseRemote({ ...input, cwd }),
          hasRefNamed: () => Effect.succeed(false),
          listLocalBranchNames: () => git.listLocalBranchNames(cwd),
        },
        fetchWorktreeBaseCommit: (input) => git.fetchWorktreeBaseCommit({ ...input, cwd }),
        createWorktree: (input, options) =>
          git.createWorktree({ ...input, cwd, path: worktreePath }, options),
        runSetup: () =>
          Deferred.succeed(setupStarted, undefined).pipe(
            Effect.as({ status: "no-script" as const }),
          ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const workspace = {
          type: "worktree" as const,
          baseRef,
          branch: "feature",
          startFromOrigin: true,
        };
        yield* launches.checkWorktreeBase({ projectId, workspaceStrategy: workspace });
        const launched = yield* launches.launch(
          launchInput({
            command: "command:launch:remote-base",
            thread: "thread:launch:remote-base",
            workspace,
          }),
        );
        yield* Deferred.await(setupStarted);
        const projection = yield* threads.getThreadProjection(launched.threadId);
        assert.equal(projection.thread.worktreePath, worktreePath);
        assert.equal(
          (yield* command(worktreePath, ["rev-parse", "HEAD"])).stdout.trim(),
          remoteHead,
        );
        const preview = yield* git.getReviewDiffPreview({ cwd: worktreePath });
        const comparisonBase = preview.sources.find(
          (source) => source.kind === "branch-range",
        )!.baseRef;
        assert.equal(
          (yield* command(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`])).stdout.trim(),
          remoteHead,
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "launch-remote-git-" })),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);

const withRealGitRepo = <A, E, R>(
  run: (repo: {
    readonly directory: string;
    readonly cwd: string;
    readonly worktreePath: string;
    readonly command: (
      at: string,
      args: string[],
    ) => ReturnType<GitVcsDriver.GitVcsDriver["Service"]["execute"]>;
    readonly harness: (options?: HarnessOptions) => ReturnType<typeof makeHarness>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "launch-base-fallback-" });
    const cwd = `${directory}/repo`;
    const worktreePath = `${directory}/worktree`;
    yield* fs.makeDirectory(cwd);
    const command = (at: string, args: string[]) =>
      git.execute({ operation: "launch-test", cwd: at, args });
    yield* command(cwd, ["init", "-b", "beta"]);
    yield* command(cwd, ["config", "user.name", "Test"]);
    yield* command(cwd, ["config", "user.email", "test@example.test"]);
    const harness = (options: HarnessOptions = {}) =>
      makeHarness({
        hasCommit: ({ refName }) =>
          command(cwd, ["rev-parse", "--verify", `${refName}^{commit}`]).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        fetchWorktreeBaseCommit: (input) => git.fetchWorktreeBaseCommit({ ...input, cwd }),
        createWorktree: (input, progress) =>
          git.createWorktree({ ...input, cwd, path: worktreePath }, progress),
        ...options,
        git: {
          resolveWorktreeBaseRemote: (input) => git.resolveWorktreeBaseRemote({ ...input, cwd }),
          resolvePrimaryRemoteName: () => git.resolvePrimaryRemoteName(cwd),
          resolveDefaultBranchName: (_cwd, remoteName) =>
            git.resolveDefaultBranchName(cwd, remoteName),
          currentBranch: () =>
            command(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
              Effect.map((result) => result.stdout.trim() || null),
              Effect.orElseSucceed(() => null),
            ),
          hasRefNamed: () => Effect.succeed(false),
          ...options.git,
        },
      });
    return yield* run({ directory, cwd, worktreePath, command, harness });
  }).pipe(
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "launch-base-git-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );

const launchFromBase = (harness: ReturnType<typeof makeHarness>, baseRef: string) =>
  Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:base-fallback",
        thread: "thread:launch:base-fallback",
        message: "Build the feature",
        workspace: { type: "worktree", baseRef, branch: "feature", startFromOrigin: true },
      }),
    );
    const projection = yield* preparationSettled(launched.threadId);
    assert.equal(projection.runs[0]?.status, "starting");
  }).pipe(Effect.provide(harness.layer));

it.effect("re-bases a stored base that no longer exists on the remote default branch", () =>
  withRealGitRepo(({ directory, cwd, worktreePath, command, harness }) =>
    Effect.gen(function* () {
      const remote = `${directory}/remote.git`;
      yield* command(cwd, ["commit", "--allow-empty", "-m", "initial"]);
      yield* command(cwd, ["init", "--bare", remote]);
      yield* command(cwd, ["remote", "add", "origin", remote]);
      yield* command(cwd, ["push", "-u", "origin", "beta"]);
      yield* command(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/beta"]);
      const remoteHead = (yield* command(cwd, ["rev-parse", "beta"])).stdout.trim();
      yield* command(cwd, ["checkout", "--detach"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "local only"]);

      // Tasks saved before the base followed the default branch still record "main".
      yield* launchFromBase(harness(), "main");
      assert.equal((yield* command(worktreePath, ["rev-parse", "HEAD"])).stdout.trim(), remoteHead);
    }),
  ),
);

it.effect("rejects a preparation retry after the project disables its provider", () => {
  let fetchAttempts = 0;
  const harness = makeHarness({
    fetchWorktreeBaseCommit: () =>
      fetchAttempts++ === 0
        ? Effect.fail(
            new GitCommandError({
              operation: "GitVcsDriver.fetchRemote",
              command: "git",
              cwd: project.workspaceRoot,
              detail: "Git could not reach the remote.",
              exitCode: 128,
            }),
          )
        : Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "command:launch:disabled-preparation-retry",
        thread: "thread:launch:disabled-preparation-retry",
        message: "Start from origin",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      }),
    );
    yield* preparationSettled(launched.threadId);
    yield* settings.updateSettings({
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
      },
    });

    const error = yield* launches
      .retryPreparation({
        commandId: CommandId.make("command:launch:disabled-preparation-retry:retry"),
        threadId: launched.threadId,
        runId: launched.projection.runs[0]!.id,
      })
      .pipe(Effect.flip);

    assert.equal(error._tag, "ThreadManagementProviderInstanceDisabledError");
    assert.equal((yield* threads.getThreadProjection(launched.threadId)).runs[0]?.status, "failed");
    assert.equal(fetchAttempts, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("fails a run whose preparation failure could not be stored until storage recovers", () =>
  Effect.gen(function* () {
    const storageFull = yield* Deferred.make<void>();
    let rejectedWrites = 0;
    let preparations = 0;
    const harness = makeHarness({
      fetchWorktreeBaseCommit: () =>
        Effect.sync(() => preparations++).pipe(
          Effect.andThen(
            Effect.fail(
              new GitCommandError({
                operation: "GitVcsDriver.fetchRemote",
                command: "git",
                cwd: project.workspaceRoot,
                detail: "Git could not reach the remote.",
                exitCode: 128,
              }),
            ),
          ),
        ),
      dispatch: (command, dispatch) =>
        command.type !== "prepared-run.fail"
          ? dispatch(command)
          : Effect.suspend(() => {
              if (rejectedWrites >= 2) return dispatch(command);
              rejectedWrites += 1;
              return Deferred.succeed(storageFull, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    new Orchestrator.OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause: new Error("SQLITE_FULL: database or disk is full"),
                    }),
                  ),
                ),
              );
            }),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "command:launch:storage-full",
        thread: "thread:launch:storage-full",
        message: "First message",
        workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
      });
      const launched = yield* launches.launch(input);
      yield* Deferred.await(storageFull);
      yield* TestClock.adjust("0 seconds");
      yield* launches.launch(input);
      yield* TestClock.adjust("0 seconds");
      assert.equal(preparations, 1);
      yield* TestClock.adjust("1 second");
      yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "run.updated" && stored.event.payload.status === "failed",
        ),
        Stream.runHead,
      );
      assert.equal(rejectedWrites, 2);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("replays a server-allocated launch", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId: _unusedThreadId, ...rest } = launchInput({
        command: "command:launch:allocated-retry",
        thread: "unused",
        message: "Only once",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const first = yield* launches.launch(rest);
      // One commit holds the thread and its first run, so no client sees the thread idle between.
      const launchCommits = yield* threads
        .streamStoredEventsFrom({ threadId: first.threadId })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "thread.created" || stored.event.type === "run.created",
          ),
          Stream.take(2),
          Stream.runCollect,
        );
      assert.deepEqual(
        Array.from(launchCommits, (stored) => stored.commandId),
        [rest.commandId, rest.commandId],
      );
      yield* Deferred.await(setupEntered);
      const retry = yield* launches.launch(rest);
      assert.equal(first.threadId, retry.threadId);
      assert.isFalse(first.resumed);
      assert.isTrue(retry.resumed);
      // Clients drop their pending copy once the thread reaches the message's commit.
      assert.isNumber(first.sequence);
      assert.equal(retry.sequence, first.sequence);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      assert.equal(retry.projection.messages.length, 1);
      assert.equal(retry.projection.runs.length, 1);
      assert.equal(retry.projection.messages[0]?.id, first.projection.messages[0]?.id);
      assert.equal(retry.projection.runs[0]?.id, first.projection.runs[0]?.id);
      yield* Deferred.succeed(allowSetup, undefined);
      yield* threads.streamStoredEventsFrom({ threadId: first.threadId }).pipe(
        Stream.filter(
          (stored) =>
            stored.commandId === CommandId.make(`${rest.commandId}:release`) &&
            stored.event.type === "run.updated",
        ),
        Stream.runHead,
      );
      const settled = yield* launches.launch(rest);
      assert.equal(settled.threadId, first.threadId);
      assert.isTrue(settled.resumed);
      assert.equal(settled.projection.messages[0]?.id, first.projection.messages[0]?.id);
      assert.equal(settled.projection.runs[0]?.id, first.projection.runs[0]?.id);
      assert.equal(harness.runSetup.mock.calls.length, 1);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("an agent's launch never starts work above the modes it asks for", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    // The first launch, at full access, creates the thread without a message.
    const created = yield* launches.launch(
      launchInput({ command: "command:launch:narrowed-retry", thread: "thread:narrowed" }),
    );
    // The same key comes back from a narrower agent, now carrying a message,
    // as a retry or a concurrent launch that lost the create would.
    const failed = yield* launches
      .launch({
        ...launchInput({
          command: "command:launch:narrowed-retry",
          thread: "thread:narrowed",
          message: "Run this",
        }),
        runtimeMode: "approval-required",
        interactionMode: "plan",
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.flip);
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "dispatch-message");
    const projection = yield* threads.getThreadProjection(created.threadId);
    assert.equal(projection.runs.length, 0);
    assert.equal(projection.messages.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects a server-allocated launch replay with a mismatching thread id", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:allocated-mismatch",
      thread: "unused",
      message: "Mismatch",
    });
    const first = yield* launches.launch(rest);
    const failed = yield* launches
      .launch({
        ...rest,
        threadId: ThreadId.make("thread:launch:allocated-mismatch"),
      })
      .pipe(Effect.flip);
    assert.notEqual(first.threadId, ThreadId.make("thread:launch:allocated-mismatch"));
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "create-thread");
    assert.include(String(failed.cause), "cannot be replayed");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("does not treat an unrelated accepted command receipt as a launch", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make("thread:launch:unrelated-receipt");
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:launch:unrelated-receipt:create"),
      threadId,
      projectId,
      title: "Existing",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("command:launch:unrelated-receipt"),
      threadId,
      expectedEmpty: true,
    });
    const { threadId: _unusedThreadId, ...rest } = launchInput({
      command: "command:launch:unrelated-receipt",
      thread: "unused",
      message: "Should not become a launch",
    });
    const failed = yield* launches.launch(rest).pipe(Effect.flip);
    if (failed._tag !== "ThreadLaunchError") {
      assert.fail(`expected ThreadLaunchError, got ${failed._tag}`);
    }
    assert.equal(failed.operation, "create-thread");
    assert.include(String(failed.cause), "cannot be replayed");
    const projection = yield* threads.getThreadProjection(threadId);
    assert.equal(projection.messages.length, 0);
    assert.equal(projection.runs.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("bounds concurrent first launches to one thread per command", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const { threadId: _unusedThreadId, ...rest } = launchInput({
        command: "command:launch:concurrent-allocated",
        thread: "unused",
        message: "Race me",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const results = yield* Effect.all(
        [launches.launch(rest).pipe(Effect.exit), launches.launch(rest).pipe(Effect.exit)],
        { concurrency: "unbounded" },
      );
      const winner = results.find(Exit.isSuccess);
      assert.isDefined(winner);
      const threadId = winner!.value.threadId;
      for (const result of results) {
        if (Exit.isSuccess(result)) {
          assert.equal(result.value.threadId, threadId);
          continue;
        }
        const error = Cause.findErrorOption(result.cause).pipe(Option.getOrThrow);
        if (error._tag !== "ThreadLaunchError") {
          assert.fail(`expected ThreadLaunchError, got ${error._tag}`);
        }
        assert.equal(error.operation, "create-thread");
        assert.include(String(error.cause), "cannot be replayed");
        const retried = yield* launches.launch(rest);
        assert.equal(retried.threadId, threadId);
      }
      const projectThreads = yield* threads.listProjectThreads({
        projectId,
        includeSubagents: false,
      });
      assert.equal(projectThreads.length, 1);
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.runs.length, 1);
      yield* Deferred.await(setupEntered);
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("does not let a failing same-command caller strand a concurrent durable launch", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const allowSetup = yield* Deferred.make<void>();
    const harness = makeHarness({
      runSetup: () =>
        Deferred.succeed(setupEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowSetup)),
          Effect.as({ status: "no-script" as const }),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const command = "command:launch:failed-owner-race";
      const [failed, launched] = yield* Effect.all(
        [
          launches
            .launch({
              ...launchInput({
                command,
                thread: "thread:launch:failed-owner-race",
                message: "This invalid reuse fails",
                workspace: { type: "worktree", baseRef: "main" },
              }),
              reuseExistingThread: true,
            })
            .pipe(Effect.exit),
          launches.launch(
            launchInput({
              command,
              thread: "thread:launch:successful-peer",
              message: "This peer persists",
              workspace: { type: "worktree", baseRef: "main" },
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.isTrue(Exit.isFailure(failed));
      assert.equal(launched.projection.runs[0]?.status, "preparing");
      const entered = yield* Deferred.await(setupEntered).pipe(
        Effect.timeoutOption(Duration.seconds(2)),
      );
      assert.isTrue(Option.isSome(entered));
      assert.equal(harness.runSetup.mock.calls.length, 1);
      yield* Deferred.succeed(allowSetup, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect(
  "schedules an accepted preparing message exactly once, from its accepted worktree base",
  () =>
    Effect.gen(function* () {
      const setupEntered = yield* Deferred.make<void>();
      const allowSetup = yield* Deferred.make<void>();
      const fetched: Array<string> = [];
      const harness = makeHarness({
        fetchWorktreeBaseCommit: ({ refName }) =>
          Effect.sync(() => {
            fetched.push(refName);
            return null;
          }),
        hasCommit: ({ refName }) => Effect.succeed(refName === "main"),
        runSetup: () =>
          Deferred.succeed(setupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(allowSetup)),
            Effect.as({ status: "no-script" as const }),
          ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const input = launchInput({
          command: "command:launch:accepted-before-fork",
          thread: "thread:launch:accepted-before-fork",
          message: "Resume preparation",
          workspace: { type: "worktree", baseRef: "main" },
        });
        const messageId = MessageId.make("message:launch:accepted-before-fork");

        yield* threads.dispatch({
          type: "thread.create",
          commandId: input.commandId,
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: null,
          worktreePath: null,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${input.commandId}:initial-message`),
          threadId: input.threadId,
          messageId,
          text: "Resume preparation",
          attachments: [],
          modelSelection: input.modelSelection,
          dispatchMode: {
            type: "defer_start",
            workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
          },
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        });
        const preparing = yield* threads.getThreadProjection(input.threadId);
        assert.equal(preparing.runs[0]?.status, "preparing");

        const [first, second] = yield* Effect.all(
          [launches.launch(input), launches.launch(input)],
          {
            concurrency: "unbounded",
          },
        );
        yield* Deferred.await(setupEntered);
        assert.isTrue(first.resumed);
        assert.isTrue(second.resumed);
        assert.equal(harness.runSetup.mock.calls.length, 1);
        assert.deepEqual(fetched, ["main"]);
        yield* Deferred.succeed(allowSetup, undefined);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("shared intake preserves durable attachment bytes after a lost launch result", () => {
  const harness = makeHarness();
  const layerFiles = ServerConfig.layerTest(process.cwd(), {
    prefix: "ankiel-message-intake-",
  }).pipe(Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))));
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const pendingId = createPendingAttachmentId();
    assert.isNotNull(pendingId);
    const attachment: ChatAttachment = {
      type: "image",
      id: ChatAttachmentId.make(pendingId),
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const pendingPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment,
    });
    assert.isNotNull(pendingPath);
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFile(pendingPath, new Uint8Array([1, 2, 3, 4]));
    const input = {
      ...launchInput({ command: "intake-launch", thread: "intake-thread" }),
      initialMessage: {
        messageId: MessageId.make("intake-first"),
        text: "First [file](ankiel-context://v1/file/intake-file)",
        context: {
          version: 1 as const,
          records: [
            {
              version: 1 as const,
              contextId: ComposerContextId.make("intake-file"),
              kind: "file" as const,
              label: attachment.name,
              attachmentId: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
            },
          ],
        },
        attachments: [attachment],
      },
    };
    const failed = yield* ThreadMessageIntake.launchThread(input).pipe(
      Effect.provideService(ThreadLaunch.ThreadLaunchService, {
        launch: (request) =>
          launches.launch(request).pipe(
            Effect.andThen(
              new ThreadLaunch.ThreadLaunchError({
                operation: "create-thread",
                commandId: request.commandId,
                projectId,
                cause: "lost result after acceptance",
              }),
            ),
          ),
        checkWorktreeBase: launches.checkWorktreeBase,
        isNonGitProject: launches.isNonGitProject,
        retryPreparation: launches.retryPreparation,
        prepareRun: launches.prepareRun,
      }),
      Effect.flip,
    );
    assert.equal(failed._tag, "ThreadLaunchError");
    const accepted = yield* threads.getThreadProjection(input.threadId);
    const stored = accepted.messages.find(
      (message) => message.id === input.initialMessage.messageId,
    );
    assert.isDefined(stored);
    assert.notEqual(stored.attachments[0]?.id, attachment.id);
    const record = stored.context?.records[0];
    assert.isDefined(record);
    assert.equal((record as { attachmentId: string }).attachmentId, stored.attachments[0]?.id);
    const userItem = accepted.turnItems.find(
      (item) => item.type === "user_message" && item.messageId === stored.id,
    );
    assert.ok(userItem?.type === "user_message");
    assert.deepEqual(userItem.context, stored.context);
    const storedPath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: stored.attachments[0]!,
    });
    assert.isNotNull(storedPath);
    assert.deepEqual(yield* fs.readFile(storedPath), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(yield* fs.readFile(pendingPath), new Uint8Array([1, 2, 3, 4]));

    const replayed = yield* ThreadMessageIntake.launchThread(input);
    assert.equal(replayed.projection.messages[0]?.id, stored.id);
    assert.deepEqual(replayed.projection.messages[0]?.attachments, stored.attachments);
    const claimedFiles = Effect.map(fs.readDirectory(config.attachmentsDir), (files) =>
      files.filter((name) => !name.startsWith("pending-")),
    );
    assert.equal((yield* claimedFiles).length, 1);

    const duplicate = yield* ThreadMessageIntake.launchThread({
      ...input,
      commandId: CommandId.make("intake-duplicate-create"),
      initialMessage: { ...input.initialMessage, messageId: MessageId.make("intake-duplicate") },
    }).pipe(Effect.result);
    assert.ok(Result.isFailure(duplicate));
    assert.ok(duplicate.failure._tag === "ThreadLaunchError");
    assert.equal(duplicate.failure.operation, "create-thread");
    assert.propertyVal(duplicate.failure.cause, "_tag", "OrchestratorThreadAlreadyExistsError");
    assert.equal((yield* claimedFiles).length, 1);
    assert.deepEqual(yield* fs.readFile(storedPath), new Uint8Array([1, 2, 3, 4]));
    assert.deepEqual(yield* fs.readFile(pendingPath), new Uint8Array([1, 2, 3, 4]));

    const missingProject = yield* ThreadMessageIntake.launchThread({
      ...input,
      commandId: CommandId.make("intake-no-project"),
      projectId: ProjectId.make("missing-project"),
    }).pipe(Effect.flip);
    assert.equal(missingProject._tag, "ThreadLaunchError");
    assert.equal((yield* claimedFiles).length, 1);
    const missingThread = yield* dispatchIntakeCommand({
      type: "message.dispatch",
      commandId: CommandId.make("intake-no-thread"),
      threadId: ThreadId.make("missing-thread"),
      messageId: MessageId.make("intake-missing"),
      text: "Missing",
      attachments: [attachment],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.flip);
    assert.equal(missingThread._tag, "OrchestratorProjectionError");
    assert.equal((yield* claimedFiles).length, 1);

    const dispatch = dispatchIntakeCommand({
      type: "message.dispatch",
      commandId: CommandId.make("intake-dispatch"),
      threadId: input.threadId,
      messageId: MessageId.make("intake-second"),
      text: "Second",
      attachments: [attachment],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* dispatch;
    yield* dispatch;
    const queuedProjection = yield* threads.getThreadProjection(input.threadId);
    const queuedRun = queuedProjection.runs.find(
      (run) => run.userMessageId === MessageId.make("intake-second"),
    );
    assert.isDefined(queuedRun);
    assert.equal(queuedRun.status, "queued");
    const queuedMessage = queuedProjection.messages.find(
      (message) => message.id === queuedRun.userMessageId,
    );
    assert.isDefined(queuedMessage);
    const file: ChatAttachment = {
      type: "file",
      id: ChatAttachmentId.make(createPendingAttachmentId("pdf")),
      name: "queued.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
    };
    const filePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: file,
    });
    assert.isNotNull(filePath);
    yield* fs.writeFile(filePath, new Uint8Array([5, 6, 7, 8]));
    const edit = dispatchIntakeCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("intake-edit"),
      threadId: input.threadId,
      runId: queuedRun.id,
      text: "Edited with a file",
      attachments: [...queuedMessage.attachments, file],
    });
    yield* edit;
    yield* edit;
    const editedProjection = yield* threads.getThreadProjection(input.threadId);
    const editedMessage = editedProjection.messages.find(
      (message) => message.id === queuedRun.userMessageId,
    );
    assert.isDefined(editedMessage);
    assert.equal(editedMessage.attachments.length, 2);
    assert.deepEqual(editedMessage.attachments[0], queuedMessage.attachments[0]);
    assert.notEqual(editedMessage.attachments[1]?.id, file.id);
    const durableFilePath = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: editedMessage.attachments[1]!,
    });
    assert.isNotNull(durableFilePath);
    assert.deepEqual(yield* fs.readFile(durableFilePath), new Uint8Array([5, 6, 7, 8]));
    assert.deepEqual(yield* fs.readFile(filePath), new Uint8Array([5, 6, 7, 8]));
    const beforeRejectedEdit = (yield* claimedFiles).length;
    const rejectedEdit = yield* dispatchIntakeCommand({
      type: "queued-run.edit",
      commandId: CommandId.make("intake-edit-rejected"),
      threadId: input.threadId,
      runId: queuedRun.id,
      text: "",
      attachments: [file],
    }).pipe(Effect.flip);
    assert.equal(rejectedEdit._tag, "OrchestratorCommandRejectedError");
    assert.equal((yield* claimedFiles).length, beforeRejectedEdit);
    assert.deepEqual(yield* fs.readFile(filePath), new Uint8Array([5, 6, 7, 8]));
    const send = ThreadMessageIntake.sendToThread({
      commandId: CommandId.make("intake-send"),
      projectId,
      threadId: input.threadId,
      messageId: MessageId.make("intake-third"),
      text: "Third",
      attachments: [attachment],
      mode: "queue",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* send;
    yield* send;
    assert.equal((yield* claimedFiles).length, 4);
    const final = yield* threads.getThreadProjection(input.threadId);
    assert.equal(final.messages.length, 3);
    for (const message of final.messages) {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: message.attachments[0]!,
      });
      assert.isNotNull(path);
      assert.deepEqual(yield* fs.readFile(path), new Uint8Array([1, 2, 3, 4]));
    }
  }).pipe(Effect.provide(Layer.mergeAll(harness.layer, layerFiles)));
});

it.effect(
  "deletes a claimed worktree's branch when setup is cancelled before checkout returns",
  () =>
    Effect.gen(function* () {
      const claimed = yield* Deferred.make<void>();
      const harness = makeHarness({
        createWorktree: (_input, options) =>
          (options?.progress?.onWorktreeClaimed?.("/repo-worktrees/feature") ?? Effect.void).pipe(
            Effect.andThen(Deferred.succeed(claimed, undefined)),
            Effect.andThen(Effect.never),
          ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
        const launched = yield* launches.launch(
          launchInput({
            command: "launch:cancel-claimed",
            thread: "thread:cancel-claimed",
            message: "Start",
            workspace: { type: "worktree", baseRef: "main" },
          }),
        );
        yield* Deferred.await(claimed);
        assert.isTrue(yield* tracker.cancel(launched.threadId));
        assert.equal(harness.removeWorktree.mock.calls[0]?.[0].path, "/repo-worktrees/feature");
        assert.equal(
          harness.deleteLocalBranch.mock.calls[0]?.[0].refName,
          harness.createWorktree.mock.calls[0]?.[0].newRefName,
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each(["origin/master", ":/initial"])(
  "refuses a worktree in a non-Git project before checking base %s",
  (baseRef) =>
    Effect.gen(function* () {
      const harness = makeHarness({
        git: { repositoryRoot: () => Effect.succeed(null) },
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const result = yield* launches
          .checkWorktreeBase({
            projectId,
            workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: true },
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, ThreadLaunch.ThreadLaunchNotRepositoryError);
          assert.deepInclude(result.failure, {
            projectId,
            projectTitle: project.title,
            workspaceRoot: project.workspaceRoot,
          });
        }
        yield* launches.checkWorktreeBase({ projectId, workspaceStrategy: { type: "root" } });
        yield* launches.checkWorktreeBase({
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath: "/existing-worktree" },
        });
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("refuses a new worktree whose explicit branch already exists", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "launch-branch-exists-" });
    const cwd = `${directory}/repo`;
    const temporaryBranch = "ankielcode/0b5e7a1c-3f2d-4e8a-9b6c-1d2e3f4a5b6c";
    yield* fs.makeDirectory(cwd);
    const command = (args: string[]) => git.execute({ operation: "launch-test", cwd, args });
    yield* command(["init", "-b", "main"]);
    yield* command(["config", "user.name", "Test"]);
    yield* command(["config", "user.email", "test@example.test"]);
    yield* command(["commit", "--allow-empty", "-m", "initial"]);
    yield* command(["branch", "feature/idle"]);
    yield* command(["branch", temporaryBranch]);
    // Resolves as `refs/heads/feature/tagged` although no such branch exists.
    yield* command(["tag", "refs/heads/feature/tagged"]);
    yield* command(["worktree", "add", "-b", "feature/taken", `${directory}/taken`]);
    const harness = makeHarness({
      hasCommit: ({ refName }) =>
        command(["rev-parse", "--verify", `${refName}^{commit}`]).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      git: { listLocalBranchNames: () => git.listLocalBranchNames(cwd) },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const check = (branch: string, baseRef = "main") =>
        launches
          .checkWorktreeBase({
            projectId,
            workspaceStrategy: { type: "worktree", baseRef, branch },
          })
          .pipe(
            Effect.match({
              onSuccess: () => [branch, "accepted"],
              onFailure: (error) => [branch, error._tag],
            }),
          );
      assert.deepEqual(
        yield* Effect.forEach(
          ["feature/idle", "feature/taken", temporaryBranch, "feature/fresh", "feature/tagged"],
          (branch) => check(branch),
        ),
        [
          ["feature/idle", "ThreadLaunchBranchExistsError"],
          ["feature/taken", "ThreadLaunchBranchExistsError"],
          [temporaryBranch, "ThreadLaunchBranchExistsError"],
          ["feature/fresh", "accepted"],
          ["feature/tagged", "accepted"],
        ],
      );
      // A `:/text` base skips the base check but not the branch check.
      assert.deepEqual(yield* check("feature/taken", ":/initial"), [
        "feature/taken",
        "ThreadLaunchBranchExistsError",
      ]);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(
    Effect.provide(
      GitVcsDriver.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "launch-branch-exists-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect.each([
  { requested: "werkstatt/baseline", blocking: "werkstatt" },
  { requested: "foo", blocking: "foo/bar" },
])("refuses a new worktree branch $requested that collides with branch $blocking", (testCase) =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: () => Effect.succeed(true),
      git: { listLocalBranchNames: () => Effect.succeed(["main", "werkstatt", "foo/bar"]) },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const workspace = { type: "worktree" as const, baseRef: "main", branch: testCase.requested };
      const commandId = CommandId.make("launch:branch-conflict");
      const check = (branch: string) =>
        launches.checkWorktreeBase({
          commandId,
          projectId,
          workspaceStrategy: { ...workspace, branch },
        });
      yield* check("werkstatt-baseline");
      const error = yield* check(testCase.requested).pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "ThreadLaunchBranchConflictError",
        branch: testCase.requested,
        conflictingBranch: testCase.blocking,
      });
      yield* launches.launch(
        launchInput({ command: commandId, thread: "thread:branch-conflict", workspace }),
      );
      yield* check(testCase.requested);
    }).pipe(Effect.provide(harness.layer));
  }),
);
