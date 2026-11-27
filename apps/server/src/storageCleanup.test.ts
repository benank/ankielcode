import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import type * as Digest from "effect/crypto/Digest";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { SCAN_CACHE_FILE_NAME } from "./usage/usageScanCache.ts";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "./persistence/Sqlite.ts";
import { checkpointRefForScopeOrdinal } from "./orchestration-v2/CheckpointService.ts";
import {
  DEFAULT_SERVER_SETTINGS,
  type WorktreeKeepWhen,
  type StorageCleanupSettings,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@ankielcode/contracts";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import * as ServerConfig from "./config.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as TaskFolders from "./workspace/TaskFolders.ts";
import { layerTaskFoldersWithGit } from "./workspace/TaskFolders.testkit.ts";
import * as GitManager from "./git/GitManager.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as Settings from "./serverSettings.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ServerActivation } from "./serverActivation.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@ankielcode/contracts";
import * as DateTime from "effect/DateTime";
import { storageCleanupPullRequestMerged, storageCleanupThreadIdle } from "./storageCleanup.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS, DEFAULT_SERVER_SETTINGS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS, DEFAULT_SERVER_SETTINGS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(
        storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS, DEFAULT_SERVER_SETTINGS),
      ).toBe(false);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while background work is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }],
          },
          NOW_MS,
          DEFAULT_SERVER_SETTINGS,
        ),
      ).toBe(false);
    },
  );

  it.each(["completed", "interrupted", "cancelled", "rolled_back"] as const)(
    "retains %s while a runtime request is pending",
    (status) => {
      expect(
        storageCleanupThreadIdle(
          {
            ...candidateWithStatus(status),
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-1"),
              kind: "command",
              createdAt: at(0),
            },
          },
          NOW_MS,
          DEFAULT_SERVER_SETTINGS,
        ),
      ).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle(
        { ...candidate(), activeRunId: RunId.make("run") },
        NOW_MS,
        DEFAULT_SERVER_SETTINGS,
      ),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle(
        { ...candidate(), latestUserMessageAt: at(-1_000) },
        NOW_MS,
        DEFAULT_SERVER_SETTINGS,
      ),
    ).toBe(false);
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

describe("merged pull request cleanup", () => {
  const HEAD_SHA = "a".repeat(40);
  const integrated = {
    branch: "feature",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    integrated: true,
  };
  const squashed = { ...integrated, integrated: false };
  const pullRequest = (
    overrides: Partial<NonNullable<Parameters<typeof storageCleanupPullRequestMerged>[0]>> = {},
  ) => ({
    state: "merged" as const,
    headRef: "feature",
    baseRef: "main",
    headSha: HEAD_SHA,
    ...overrides,
  });

  it("removes a worktree whose head reached the default branch through a merged pull request", () => {
    expect(storageCleanupPullRequestMerged(pullRequest({ headSha: null }), integrated)).toBe(true);
  });

  it("removes a squash-merged worktree when the pull request names its exact head", () => {
    expect(storageCleanupPullRequestMerged(pullRequest(), squashed)).toBe(true);
  });

  it.each([
    ["has a later commit than the merged head", { headSha: "c".repeat(40) }],
    ["was merged into a release branch", { baseRef: "release" }],
    ["was merged into its stack parent", { baseRef: "stack-parent" }],
    ["was merged without a reported head commit", { headSha: null }],
    ["belongs to a different branch", { headRef: "other" }],
    ["is still open", { state: "open" }],
    ["was closed without merging", { state: "closed" }],
  ] as const)("keeps a squash worktree whose pull request %s", (_name, overrides) => {
    expect(storageCleanupPullRequestMerged(pullRequest(overrides), squashed)).toBe(false);
  });

  it("keeps a worktree with no pull request, or one that is not merged", () => {
    expect(storageCleanupPullRequestMerged(null, squashed)).toBe(false);
    expect(storageCleanupPullRequestMerged(null, integrated)).toBe(false);
    expect(storageCleanupPullRequestMerged(pullRequest({ state: "open" }), integrated)).toBe(false);
  });
});

const allocatedBytes = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(
    Effect.map((stat) =>
      Option.getOrElse(
        Option.map(stat.blocks, (blocks) => Number(blocks) * 512),
        () => Number(stat.size),
      ),
    ),
  );

const cleanupFixture = (
  storageCleanup: StorageCleanupSettings = {
    ...DEFAULT_SERVER_SETTINGS.storageCleanup,
    worktreeAfterDays: 8,
    worktreeOnDelete: true,
  },
  sqlOverride?: SqlClient.SqlClient,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-repo-" }));
    const command = (cwd: string, args: string[]) =>
      git.execute({ operation: "cleanup-test", cwd, args });
    yield* command(repo, ["init", "-b", "main"]);
    yield* command(repo, ["config", "user.email", "cleanup@example.test"]);
    yield* command(repo, ["config", "user.name", "Cleanup test"]);
    yield* fs.writeFileString(`${repo}/tracked.txt`, "original\n");
    yield* fs.writeFileString(`${repo}/.gitignore`, ".env\ndist/\nnode_modules/\n");
    yield* command(repo, ["add", "."]);
    yield* command(repo, ["commit", "-m", "initial"]);
    yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
    const worktree = `${config.worktreesDir}/feature`;
    yield* command(repo, ["worktree", "add", "-b", "feature", worktree]);
    let settings: import("@ankielcode/contracts").ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      storageCleanup,
    };
    let threads = [shell({ branch: "feature", worktreePath: worktree })];
    let deletedThreads: OrchestrationV2ThreadShell[] = [];
    let storedWorktreePaths: string[] = [worktree];
    let projectRoots = [repo];
    let editBeforeRemoval = false;
    let openSessionCwd: string | null = null;
    let sessionLive = true;
    let sessionLiveChecks = 0;
    let onLiveCheck: Effect.Effect<void> = Effect.void;
    let outboxStatus: string | null = null;
    let scheduledThreadIds: string[] = [];
    let branchPullRequests: Record<string, GitManager.GitBranchPullRequest> = {};
    let fullStatusCalls = 0;
    let statusCommands = 0;
    let gitInspections = 0;
    let snapshotReads = 0;
    let terminalListener: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | undefined;
    let taskFolders: Pick<TaskFolders.TaskFolders["Service"], "find" | "remove"> = {
      find: () => Effect.succeed(null),
      remove: () => Effect.succeed({ removed: [], kept: [] }),
    };
    let events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.empty;
    const activated = yield* Deferred.make<void>();
    const context = yield* Layer.build(StorageCleanup.layer).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, {
        ...git,
        execute: (input) =>
          Effect.gen(function* () {
            gitInspections++;
            if (input.args[0] === "status") statusCommands++;
            // Before Git's own clean check: inside `git worktree remove`, or on
            // Windows the same status check the removal makes before deleting.
            if (
              editBeforeRemoval &&
              (input.args.includes("remove") || input.args.includes("--porcelain"))
            )
              yield* fs.writeFileString(`${worktree}/tracked.txt`, "late edit\n");
            return yield* git.execute(input);
          }),
        statusDetailsLocal: (...args) => {
          fullStatusCalls++;
          return git.statusDetailsLocal(...args);
        },
      }),
      Effect.provideService(Settings.ServerSettingsService, {
        getSettings: Effect.sync(() => settings),
        subscribeChanges: Effect.succeed(Stream.empty),
      } as unknown as Settings.ServerSettingsService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        list: () => Effect.sync(() => projectRoots.map((workspaceRoot) => ({ workspaceRoot }))),
        listShells: () =>
          Effect.sync(() =>
            projectRoots.map((workspaceRoot, index) => ({
              id: ProjectId.make(`project-${index + 1}`),
              workspaceRoot,
            })),
          ),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getShellSnapshot: (input?: { location?: string }) =>
          Effect.sync(() => {
            snapshotReads++;
            const visible = threads.filter((thread) => thread.deletedAt === null);
            return {
              threads:
                input?.location === "archive"
                  ? []
                  : visible.filter((thread) => thread.archivedAt === null),
              archivedThreads:
                input?.location === "active"
                  ? []
                  : visible.filter((thread) => thread.archivedAt !== null),
            };
          }),
        getThreadWorktreePaths: (input?: { includeArchived?: boolean }) =>
          Effect.sync(() =>
            threads.flatMap((thread) =>
              thread.deletedAt === null &&
              (input?.includeArchived === true || thread.archivedAt === null) &&
              thread.worktreePath !== null
                ? [{ threadId: thread.id, worktreePath: thread.worktreePath }]
                : [],
            ),
          ),
        getThreadShell: (threadId: ThreadId) =>
          Effect.sync(() => threads.find((thread) => thread.id === threadId) ?? null),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        getShellSnapshot: (input?: { threadIds?: ReadonlyArray<ThreadId> }) =>
          Effect.sync(() => ({
            threads: threads.filter((thread) => input?.threadIds?.includes(thread.id) ?? true),
            archivedThreads: [],
          })),
        dispatch: (command: OrchestrationV2ServerCommand) =>
          Effect.sync(() => {
            if (command.type === "thread.metadata.update" && command.branch != null) {
              const branch = command.branch;
              threads = threads.map((thread) =>
                thread.id === command.threadId && thread.branch === command.expectedBranch
                  ? { ...thread, branch }
                  : thread,
              );
            }
            return { sequence: 0, storedEvents: [] };
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.provideService(GitWorkflowService.GitWorkflowService, {
        currentBranch: (cwd: string) =>
          command(cwd, ["branch", "--show-current"]).pipe(
            Effect.map((result) => result.stdout.trim() || null),
          ),
      } as unknown as GitWorkflowService.GitWorkflowService["Service"]),
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        isLive: () =>
          Effect.sync(() => {
            sessionLiveChecks++;
            return sessionLive;
          }).pipe(Effect.tap(() => Effect.suspend(() => onLiveCheck))),
      } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
      Effect.provideService(Orchestrator.OrchestratorV2, {
        streamDomainEvents: Stream.suspend(() => events),
      } as unknown as Orchestrator.OrchestratorV2["Service"]),
      Effect.provideService(
        SqlClient.SqlClient,
        sqlOverride ??
          (((strings: TemplateStringsArray) =>
            Effect.sync(() =>
              strings.join("").includes("retained_checkpoint_threads")
                ? []
                : openSessionCwd !== null &&
                    strings.join("").includes("projection_provider_sessions")
                  ? [
                      {
                        payload_json: JSON.stringify({
                          id: "session-1",
                          driver: "codex",
                          providerInstanceId: "codex",
                          status: "ready",
                          cwd: openSessionCwd,
                          model: null,
                          capabilities: CodexProviderCapabilitiesV2,
                          createdAt: "2026-06-01T12:00:00.000Z",
                          updatedAt: "2026-06-01T12:00:00.000Z",
                          lastError: null,
                        }),
                      },
                    ]
                  : outboxStatus !== null &&
                      strings.join("").includes("orchestration_v2_effect_outbox")
                    ? [{ status: outboxStatus }]
                    : strings.join("").includes("deleted_at IS NOT NULL")
                      ? deletedThreads.map((thread) => ({
                          payload_json: JSON.stringify(thread),
                          workspaceRoot: repo,
                        }))
                      : strings.join("").includes('AS "worktreePath"')
                        ? [
                            ...threads.flatMap((thread) => thread.worktreePath ?? []),
                            ...storedWorktreePaths,
                          ].map((worktreePath) => ({ worktreePath }))
                        : strings.join("").includes("scheduled_tasks")
                          ? scheduledThreadIds.map((threadId) => ({ threadId }))
                          : [],
            )) as unknown as SqlClient.SqlClient),
      ),
      Effect.provideService(GitManager.GitManager, {
        invalidateStatus: () => Effect.void,
        branchPullRequest: (input: { branch: string }) =>
          Effect.sync(() => branchPullRequests[input.branch] ?? null),
      } as unknown as GitManager.GitManager["Service"]),
      Effect.provideService(TerminalManager.TerminalManager, {
        subscribeMetadata: (
          listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
        ) =>
          Effect.sync(() => {
            terminalListener = listener;
            return () => {};
          }),
      } as unknown as TerminalManager.TerminalManager["Service"]),
      Effect.provideService(ServerActivation, Deferred.await(activated)),
      Effect.provideService(TaskFolders.TaskFolders, {
        find: (target: string) => taskFolders.find(target),
        remove: (input: Parameters<TaskFolders.TaskFolders["Service"]["remove"]>[0]) =>
          taskFolders.remove(input),
      } as unknown as TaskFolders.TaskFolders["Service"]),
    );
    return {
      service: Context.get(context, StorageCleanup.StorageCleanup),
      repo,
      setTaskFolders: (service: typeof taskFolders) => {
        taskFolders = service;
      },
      setTerminals: (terminals: TerminalSummary[]) =>
        terminalListener?.({ type: "snapshot", terminals }) ?? Effect.void,
      editBeforeRemoval: () => {
        editBeforeRemoval = true;
      },
      fs,
      worktree,
      config,
      command,
      enableFiles: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            browserArtifactsAfterDays: 8,
            logsAfterDays: 8,
          },
        };
      },
      setSettings: (next: Partial<typeof settings>) => {
        settings = { ...settings, ...next };
      },
      setPolicy: (worktreeKeepWhen: WorktreeKeepWhen) => {
        settings = {
          ...settings,
          storageCleanup: { ...settings.storageCleanup, worktreeKeepWhen },
        };
      },
      disable: () => {
        settings = {
          ...settings,
          storageCleanup: {
            ...settings.storageCleanup,
            worktreeAfterDays: null,
            worktreeOnDelete: false,
          },
        };
      },
      setThreads: (next: typeof threads) => {
        threads = next;
      },
      setBranchPullRequests: (next: typeof branchPullRequests) => {
        branchPullRequests = next;
      },
      threadBranches: () => threads.map((thread) => thread.branch),
      setOnLiveCheck: (hook: Effect.Effect<void>) => {
        onLiveCheck = hook;
      },
      setOutboxStatus: (status: string | null) => {
        outboxStatus = status;
      },
      setScheduledThreadIds: (next: string[]) => {
        scheduledThreadIds = next;
      },
      setDeletedThreads: (next: OrchestrationV2ThreadShell[]) => {
        deletedThreads = next;
      },
      setStoredWorktreePaths: (paths: string[]) => {
        storedWorktreePaths = paths;
      },
      setProjectRoots: (roots: string[]) => {
        projectRoots = roots;
      },
      setSessionLive: (live: boolean) => {
        sessionLive = live;
      },
      setOpenSessionCwd: (cwd: string | null) => {
        openSessionCwd = cwd;
      },
      openTerminal: (paths: { cwd: string; worktreePath: string | null }) =>
        terminalListener?.({
          type: "upsert",
          terminal: {
            threadId: "thread-1",
            terminalId: "terminal-1",
            status: "running",
            pid: 1,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: "Terminal",
            updatedAt: "2026-06-10T12:00:00.000Z",
            ...paths,
          },
        }) ?? Effect.void,
      gitInspections: () => gitInspections,
      fullStatusCalls: () => fullStatusCalls,
      statusCommands: () => statusCommands,
      snapshotReads: () => snapshotReads,
      sessionLiveChecks: () => sessionLiveChecks,
      activate: (domainEvents: Stream.Stream<OrchestrationV2DomainEvent>) => {
        events = domainEvents;
        return Deferred.succeed(activated, undefined);
      },
    };
  });
const pausedMeasurementFixture = (storageCleanup?: StorageCleanupSettings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const measuring = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let measuredPath: string | undefined;
    const fixture = yield* cleanupFixture(storageCleanup).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        readDirectory: (directory, options) =>
          Effect.gen(function* () {
            if (directory === measuredPath) {
              yield* Deferred.succeed(measuring, undefined);
              yield* Deferred.await(resume);
            }
            return yield* fs.readDirectory(directory, options);
          }),
      }),
    );
    measuredPath = yield* fs.realPath(fixture.worktree);
    return { ...fixture, measuring, resume };
  });
const cleanupTestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "storage-cleanup-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const annexWorktree = Effect.fnUntraced(function* (
  fixture: Effect.Success<ReturnType<typeof cleanupFixture>>,
  worktree: string,
) {
  const adminDir = (yield* fixture.command(worktree, ["rev-parse", "--absolute-git-dir"])).stdout;
  yield* fixture.fs.remove(`${worktree}/.git`);
  yield* fixture.fs.symlink(adminDir.trim(), `${worktree}/.git`);
});

const runCleanupTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Digest.Digest
    | ServerConfig.ServerConfig
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | Scope.Scope
  >,
) => effect.pipe(Effect.provide(cleanupTestLayer));

const legacyCheckpointRef = (threadId: string, turn: number) =>
  `refs/ankiel/checkpoints/${Base64Url.encode(threadId)}/turn/${turn}`;

const checkpointCleanupFixture = Effect.fn("test.checkpointCleanupFixture")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fixture = yield* cleanupFixture(DEFAULT_SERVER_SETTINGS.storageCleanup, sql);
  const { repo, worktree, command } = fixture;
  const timestamp = DateTime.formatIso(at(0));
  yield* sql`INSERT INTO projection_projects ${sql.insert({
    project_id: "project-1",
    title: "Checkpoint cleanup",
    workspace_root: repo,
    scripts_json: "[]",
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: timestamp,
  })}`;
  const addThread = Effect.fn("test.addCheckpointThread")(function* (
    id: string,
    options: { deleted?: boolean; archived?: boolean; source?: string; legacyOnly?: boolean } = {},
  ) {
    const scopeId = CheckpointScopeId.make(`scope:${id}`);
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
      thread_id: id,
      project_id: "project-1",
      title: id,
      default_provider: "codex",
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_at: timestamp,
      updated_at: timestamp,
      archived_at: options.archived ? timestamp : null,
      deleted_at: options.deleted ? timestamp : null,
      payload_json: JSON.stringify({
        worktreePath: worktree,
        forkedFrom: options.source ? { type: "run", threadId: options.source } : null,
      }),
    })}`;
    if (!options.legacyOnly)
      yield* sql`INSERT INTO orchestration_v2_projection_checkpoint_scopes ${sql.insert({
        scope_id: scopeId,
        thread_id: id,
        node_id: `node:${id}`,
        kind: "root_run",
        ordinal_within_parent: 0,
        advances_app_run_count: 1,
        created_at: timestamp,
        payload_json: JSON.stringify({ cwd: worktree }),
      })}`;
    const refs: string[] = options.legacyOnly
      ? [legacyCheckpointRef(id, 0)]
      : [
          yield* checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 0 }),
          yield* checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 1 }),
          legacyCheckpointRef(id, 0),
        ];
    for (const ref of refs) yield* command(repo, ["update-ref", ref, "HEAD"]);
    return refs;
  });
  const listRefs = () =>
    git
      .execute({
        operation: "cleanup-test.list-checkpoints",
        cwd: repo,
        args: ["for-each-ref", "--format=%(refname)", "refs/ankiel/"],
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .pipe(Effect.map(({ stdout }) => stdout.trim().split("\n").filter(Boolean).sort()));
  return { ...fixture, sql, addThread, listRefs };
});

describe("checkpoint ref cleanup", () => {
  it.live("prunes refs owned by deleted threads after their worktree is removed", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, repo, worktree, command, addThread, listRefs } =
          yield* checkpointCleanupFixture();
        yield* addThread("deleted", { deleted: true });
        yield* addThread("imported-deleted", { deleted: true, legacyOnly: true });
        const retained = [
          ...(yield* addThread("active")),
          ...(yield* addThread("archived", { archived: true })),
          legacyCheckpointRef("unknown-owner", 0),
        ];
        yield* command(repo, ["update-ref", retained.at(-1)!, "HEAD"]);
        yield* command(repo, ["pack-refs", "--all"]);
        yield* command(repo, ["worktree", "remove", worktree]);
        yield* service.runNow;
        expect(yield* listRefs()).toEqual(retained.sort());
      }).pipe(Effect.provide(Sqlite.layerMemory)),
    ),
  );

  it.live("keeps deleted fork ancestry while a live or archived descendant needs it", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, sql, addThread, listRefs } = yield* checkpointCleanupFixture();
        const root = yield* addThread("root", { deleted: true });
        const intermediate = yield* addThread("intermediate", { deleted: true, source: "root" });
        const child = yield* addThread("child", { archived: true, source: "intermediate" });
        yield* service.runNow;
        expect(yield* listRefs()).toEqual([...root, ...intermediate, ...child].sort());
        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = 'deleted' WHERE thread_id = 'child'`;
        yield* service.runNow;
        expect(yield* listRefs()).toEqual([]);
      }).pipe(Effect.provide(Sqlite.layerMemory)),
    ),
  );

  it.live("waits for a deleted thread's pending checkpoint effects", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, sql, addThread, listRefs } = yield* checkpointCleanupFixture();
        const refs = yield* addThread("capturing", { deleted: true });
        yield* sql`INSERT INTO orchestration_v2_effect_outbox ${sql.insert({
          effect_id: "capture",
          command_id: "capture",
          thread_id: "capturing",
          effect_type: "checkpoint.capture",
          payload_json: "{}",
          status: "running",
          available_at: "2026-01-01T00:00:00Z",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        })}`;
        yield* service.runNow;
        expect(yield* listRefs()).toEqual(refs.toSorted());
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'`;
        yield* service.runNow;
        expect(yield* listRefs()).toEqual([]);
      }).pipe(Effect.provide(Sqlite.layerMemory)),
    ),
  );

  it.live("deletes a symbolic checkpoint ref without its target or neighbouring refs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, repo, command, addThread, listRefs } = yield* checkpointCleanupFixture();
        const refs = yield* addThread("deleted", { deleted: true });
        yield* command(repo, ["symbolic-ref", refs[0]!, "refs/heads/main"]);
        const retained = [
          "refs/ankiel/unrelated/0",
          `${refs[1]}-other`,
          refs[1]!.replace(/1$/, "2/nested"),
        ];
        for (const ref of retained) yield* command(repo, ["update-ref", ref, "HEAD"]);
        yield* service.runNow;
        expect(yield* listRefs()).toEqual(retained.sort());
        yield* command(repo, ["show-ref", "--verify", "refs/heads/main"]);
      }).pipe(Effect.provide(Sqlite.layerMemory)),
    ),
  );
});

it.live.each(["repository", "uppercase", "bare"] as const)(
  "keeps a worktree holding an ignored nested %s",
  (kind) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command, setPolicy } = yield* cleanupFixture();
        setPolicy("tracked-changes");
        const nested = `${worktree}/dist/nested`;
        if (kind === "uppercase") {
          yield* command(repo, ["worktree", "add", "-b", "nested", nested]);
        } else {
          yield* command(repo, [
            "clone",
            "--no-hardlinks",
            ...(kind === "bare" ? ["--bare"] : []),
            repo,
            nested,
          ]);
        }
        if (kind === "uppercase") yield* fs.rename(`${nested}/.git`, `${nested}/.GIT`);
        yield* fs.writeFileString(`${nested}/uncommitted.txt`, "irreplaceable work\n");
        expect((yield* command(worktree, ["status", "--porcelain"])).stdout).toBe("");
        const report = yield* service.runNow;
        expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
          outcome: "kept",
          reason: "Contains a nested Git repository",
        });
        expect(yield* fs.readFileString(`${nested}/uncommitted.txt`)).toBe("irreplaceable work\n");
        expect(
          (yield* command(nested, [
            ...(kind === "uppercase"
              ? [
                  `--git-dir=${(yield* fs.readFileString(`${nested}/.GIT`)).trim().slice(8)}`,
                  "--work-tree=.",
                ]
              : []),
            "-c",
            "safe.bareRepository=all",
            "rev-parse",
            "--is-bare-repository",
          ])).stdout.trim(),
        ).toBe(String(kind === "bare"));
      }),
    ),
);

const submoduleCleanupFixture = () =>
  Effect.gen(function* () {
    const fixture = yield* cleanupFixture();
    const { command, repo, worktree } = fixture;
    const submodule = `${worktree}/module`;
    const child = `${submodule}/child`;
    for (const [cwd, name] of [
      [worktree, "module"],
      [submodule, "child"],
    ] as const) {
      yield* command(cwd, ["-c", "protocol.file.allow=always", "submodule", "add", repo, name]);
      yield* command(`${cwd}/${name}`, ["config", "user.name", "Cleanup test"]);
      yield* command(`${cwd}/${name}`, ["config", "user.email", "cleanup@example.test"]);
    }
    const recordSubmodules = () =>
      Effect.gen(function* () {
        yield* command(submodule, ["commit", "-am", "record child"]);
        yield* command(submodule, ["push", "origin", "HEAD:submodule"]);
        yield* command(worktree, ["commit", "-am", "record module"]);
      });
    yield* recordSubmodules();
    return { ...fixture, submodule, child, recordSubmodules };
  });

it.live("keeps an ignored repository inside a registered submodule", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, repo, worktree, submodule, command, setPolicy } =
        yield* submoduleCleanupFixture();
      setPolicy("tracked-changes");
      const nested = `${submodule}/dist/nested`;
      yield* command(repo, ["clone", "--no-hardlinks", repo, nested]);
      yield* fs.writeFileString(`${nested}/uncommitted.txt`, "keep me");
      const report = yield* service.runNow;
      expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
        outcome: "kept",
        reason: "Contains a nested Git repository",
      });
      expect(yield* fs.readFileString(`${nested}/uncommitted.txt`)).toBe("keep me");
    }),
  ),
);

it.live("removes a task folder's clean worktrees and keeps the one with uncommitted work", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, repo, command, setTaskFolders, setThreads } = yield* cleanupFixture();
      const trackedRepository = Effect.fnUntraced(function* (name: string) {
        const folder = `${repo}/dist/${name}`;
        yield* fs.makeDirectory(folder, { recursive: true });
        yield* command(folder, ["init", "-b", "main"]);
        yield* command(folder, ["config", "user.email", "cleanup@example.test"]);
        yield* command(folder, ["config", "user.name", "Cleanup test"]);
        yield* fs.writeFileString(`${folder}/tracked.txt`, "original\n");
        yield* command(folder, ["add", "."]);
        yield* command(folder, ["commit", "-m", "initial"]);
        return { name, path: folder };
      });
      const api = yield* trackedRepository("api");
      const web = yield* trackedRepository("web");
      const context = yield* Layer.build(
        layerTaskFoldersWithGit({
          workspaceRoot: repo,
          trackedFolders: [api, web],
          thread: null,
        }).pipe(Layer.provide(NodeCrypto.layer)),
      );
      const taskFolders = Context.get(context, TaskFolders.TaskFolders);
      const plan = yield* taskFolders.plan({ projectId: ProjectId.make("project-1") });
      const { taskFolder } = yield* taskFolders.create({
        plan: plan!,
        branch: "task",
        projectStart: { refName: "main", baseRefName: "main" },
        startFromOrigin: false,
        projectCommands: true,
      });
      const root = taskFolder.root;
      // A nested worktree's uncommitted work must survive its thread's cleanup.
      yield* fs.writeFileString(`${root}/dist/api/tracked.txt`, "uncommitted\n");
      setTaskFolders(taskFolders);
      setThreads([shell({ branch: "task", worktreePath: root })]);

      const report = yield* service.runNow;

      expect(
        report.entries
          .filter((entry) => entry.path?.startsWith(root))
          .map(({ path, outcome, reason }) => ({ path, outcome, reason }))
          .toSorted((left, right) => left.path!.localeCompare(right.path!)),
      ).toEqual([
        { path: root, outcome: "kept", reason: "Holds a repository that was kept" },
        {
          path: `${root}/dist/api`,
          outcome: "kept",
          reason: "Has uncommitted changes (1 file)",
        },
        { path: `${root}/dist/web`, outcome: "removed", reason: expect.any(String) },
      ]);
      expect(
        report.entries.find((entry) => entry.path === `${root}/dist/web`)?.bytes,
      ).toBeGreaterThan(0);
      expect(yield* fs.readFileString(`${root}/dist/api/tracked.txt`)).toBe("uncommitted\n");
      expect(yield* fs.exists(`${root}/dist/web`)).toBe(false);
      // The thread is alive, so the record keeps the whole layout for when it resumes.
      expect((yield* taskFolders.find(root))?.repositories).toHaveLength(2);

      yield* command(`${root}/dist/api`, ["checkout", "--", "tracked.txt"]);
      // Git deletes the checkout, then fails on metadata it cannot delete.
      const adminDir = (yield* command(`${root}/dist/api`, [
        "rev-parse",
        "--absolute-git-dir",
      ])).stdout.trim();
      const stuck = `${adminDir}/scratch`;
      yield* fs.makeDirectory(stuck);
      yield* fs.writeFileString(`${stuck}/f`, "x\n");
      yield* fs.chmod(stuck, 0o555);
      yield* Effect.addFinalizer(() => fs.chmod(stuck, 0o755).pipe(Effect.ignore));
      const second = yield* service.runNow;

      expect(second.entries.filter((entry) => entry.path?.startsWith(root))).toEqual(
        [`${root}/dist/api`, root].map((path) =>
          expect.objectContaining({ path, outcome: "kept" }),
        ),
      );
      expect(yield* fs.exists(`${root}/dist/api`)).toBe(false);
      // The checkout is gone, so the folder goes and only the record keeps the metadata in view.
      expect(
        (yield* service.runNow).entries.filter((entry) => entry.path?.startsWith(root)),
      ).toEqual(
        [
          { path: `${root}/dist/api`, outcome: "failed" },
          { path: root, outcome: "removed" },
        ].map((entry) => expect.objectContaining(entry)),
      );
      expect(yield* fs.exists(root)).toBe(false);
      yield* fs.chmod(stuck, 0o755);
      expect((yield* service.runNow).entries).toEqual([
        expect.objectContaining({ path: `${root}/dist/api`, outcome: "removed" }),
      ]);
      expect(yield* fs.exists(adminDir)).toBe(false);
      expect(yield* fs.readFileString(`${api.path}/tracked.txt`)).toBe("original\n");
    }),
  ),
);

it.live("keeps unpushed submodule history after checkout and deinitialization", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command, recordSubmodules } =
        yield* submoduleCleanupFixture();
      yield* command(child, ["checkout", "-b", "local-only"]);
      yield* fs.writeFileString(`${child}/tracked.txt`, "unpublished work\n");
      yield* command(child, ["commit", "-am", "local work"]);
      const local = (yield* command(child, ["rev-parse", "HEAD"])).stdout.trim();
      yield* recordSubmodules();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(yield* fs.readFileString(`${child}/tracked.txt`)).toBe("unpublished work\n");

      yield* command(child, ["checkout", "main"]);
      yield* recordSubmodules();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      const childGit = (yield* command(child, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      yield* command(submodule, ["submodule", "deinit", "child"]);
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(
        (yield* command(worktree, [
          "--git-dir",
          childGit,
          "rev-parse",
          "refs/heads/local-only",
        ])).stdout.trim(),
      ).toBe(local);
      expect(
        (yield* command(worktree, ["--git-dir", childGit, "show", "local-only:tracked.txt"]))
          .stdout,
      ).toBe("unpublished work\n");
      yield* command(worktree, ["--git-dir", childGit, "branch", "-D", "local-only"]);
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("remote-tracking") });
      expect(
        (yield* command(worktree, ["--git-dir", childGit, "show", `${local}:tracked.txt`])).stdout,
      ).toBe("unpublished work\n");
    }),
  ),
);

it.live("keeps submodules when stored repository metadata is malformed", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, submodule, child, command, setPolicy } =
        yield* submoduleCleanupFixture();
      setPolicy("tracked-changes");
      const childGit = (yield* command(child, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      yield* command(submodule, ["submodule", "deinit", "child"]);
      yield* fs.writeFileString(`${childGit}/HEAD`, "not a ref\n");
      yield* fs.writeFileString(`${worktree}/notes.txt`, "keep while the worktree stays\n");
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "kept", reason: expect.stringContaining("inspected") });
      expect(yield* fs.exists(worktree)).toBe(true);
      expect(yield* fs.readFileString(`${childGit}/HEAD`)).toBe("not a ref\n");
      expect(yield* fs.readFileString(`${worktree}/notes.txt`)).toBe(
        "keep while the worktree stays\n",
      );
    }),
  ),
);

it.live("preserves late tracked edits when submodules were never initialized", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      const { service, fs, worktree, command } = fixture;
      const head = (yield* command(worktree, ["rev-parse", "HEAD"])).stdout.trim();
      yield* fs.writeFileString(
        `${worktree}/.gitmodules`,
        '[submodule "module"]\n\tpath = module\n\turl = /unused\n',
      );
      yield* command(worktree, ["add", ".gitmodules"]);
      yield* command(worktree, ["update-index", "--add", "--cacheinfo", `160000,${head},module`]);
      yield* command(worktree, ["commit", "-m", "record uninitialized module"]);
      yield* fs.makeDirectory(`${worktree}/module`);
      fixture.editBeforeRemoval();
      expect(
        (yield* service.runNow).entries.find((entry) => entry.path === worktree),
      ).toMatchObject({ outcome: "failed" });
      expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("late edit\n");
    }),
  ),
);

describe("subagent worktree ownership", () => {
  it.effect("keeps a checkout two top-level threads store through a symlinked parent", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeSettledAfterDays: 8,
      });
      const linkedParent = `${yield* fixture.fs.makeTempDirectoryScoped({ prefix: "cleanup-link-" })}/worktrees`;
      yield* fixture.fs.symlink(fixture.config.worktreesDir, linkedParent);
      const settled = { branch: "feature", settledAt: at(-20 * DAY_MS) };
      fixture.setThreads([
        shell({ ...settled, worktreePath: fixture.worktree }),
        shell({ ...settled, id: ThreadId.make("other"), worktreePath: `${linkedParent}/feature` }),
      ]);
      const report = yield* fixture.service.runNow;
      expect(report.entries).toEqual([
        expect.objectContaining({ outcome: "kept", reason: "Shared by 2 threads" }),
      ]);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
    }).pipe(Effect.provide(cleanupTestLayer)),
  );

  it.effect("keeps a checkout two top-level threads store in different case on Windows", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeSettledAfterDays: 8,
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"));
      const settled = { branch: "feature", settledAt: at(-20 * DAY_MS) };
      fixture.setThreads([
        shell({ ...settled, worktreePath: fixture.worktree }),
        shell({
          ...settled,
          id: ThreadId.make("other"),
          worktreePath: fixture.worktree.toUpperCase(),
        }),
      ]);
      const report = yield* fixture.service.runNow;
      expect(report.entries).toEqual([
        expect.objectContaining({ outcome: "kept", reason: "Shared by 2 threads" }),
      ]);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
    }).pipe(Effect.provide(cleanupTestLayer)),
  );

  it.effect.each([
    "running",
    "pending",
    "activity",
    "unrelated",
    "settled",
    "resettled",
    "null-branch",
    "stale-branch",
  ] as const)("cancels removal when a child changes during measurement (%s)", (change) =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* pausedMeasurementFixture();
        const root = shell({ branch: "feature", worktreePath: fixture.worktree });
        const child = {
          ...root,
          id: ThreadId.make("child"),
          settledAt: change === "resettled" ? at(-20 * DAY_MS) : null,
          lineage: {
            parentThreadId: root.id,
            rootThreadId: root.id,
            relationshipToParent: "subagent" as const,
          },
        };
        fixture.setThreads([child, root]);
        const run = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.measuring);
        fixture.setThreads([
          root,
          {
            ...child,
            branch:
              change === "null-branch"
                ? null
                : change === "stale-branch"
                  ? "ankiel/15a6e5ae"
                  : child.branch,
            settledAt: change === "settled" ? at(-20 * DAY_MS) : child.settledAt,
            updatedAt: change === "settled" || change === "resettled" ? at(0) : child.updatedAt,
            status: change === "running" ? "running" : "idle",
            pendingBackgroundTasks:
              change === "pending" ? [{ taskId: "task", kind: "command" }] : [],
            latestRunCompletedAt: change === "activity" ? at(-DAY_MS) : null,
          },
          ...(change === "unrelated" ? [shell({ ...root, id: ThreadId.make("other") })] : []),
        ]);
        yield* Deferred.succeed(fixture.resume, undefined);
        expect((yield* Fiber.join(run)).entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Thread activity or shared worktree changed since check",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );
});

describe("deleted thread worktrees", () => {
  const parent = (worktreePath: string) =>
    shell({ branch: "feature", worktreePath, deletedAt: at(-DAY_MS) });
  // Deleting the parent leaves its native subagent thread in the projection.
  const subagent = (
    owner: OrchestrationV2ThreadShell,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ) =>
    shell({
      id: ThreadId.make("child"),
      title: "Subagent",
      branch: "feature",
      worktreePath: owner.worktreePath,
      status: "completed",
      createdBy: "agent",
      creationSource: "provider",
      lineage: {
        rootThreadId: owner.id,
        parentThreadId: owner.id,
        relationshipToParent: "subagent",
      },
      ...overrides,
    });

  it.effect("leaves a deleted owner's subagent on the owner's saved branch", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      const owner = parent(fixture.worktree);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([subagent(owner)]);
      yield* fixture.command(fixture.worktree, ["switch", "-c", "renamed"]);
      expect((yield* fixture.service.runNow).entries[0]).toMatchObject({
        threadId: owner.id,
        outcome: "kept",
        reason: "Repository or branch changed",
      });
      // The deleted owner cannot follow, so moving its subagent would split their records.
      expect(fixture.threadBranches()).toEqual(["feature"]);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );
});

describe("orphan worktree reports", () => {
  it.live.each(["nested", "direct", "annexed"] as const)(
    "reports a linked orphan's size without removing its files (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const orphan = `${fixture.config.worktreesDir}/${location === "nested" ? "repository/" : ""}orphan`;
          yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "orphan", orphan]);
          if (location === "annexed") yield* annexWorktree(fixture, orphan);
          const sizes = yield* Effect.forEach(
            // Links are not measured, and the annexed `.git` is one.
            (yield* fixture.fs.readDirectory(orphan)).filter(
              (name) => location !== "annexed" || name !== ".git",
            ),
            (name) => allocatedBytes(fixture.fs, `${orphan}/${name}`),
          );
          const outside = yield* fixture.fs.makeTempDirectoryScoped();
          yield* fixture.fs.writeFileString(`${outside}/external`, "outside data");
          yield* fixture.fs.symlink(outside, `${orphan}/linked-directory`);
          yield* fixture.fs.symlink(`${outside}/missing`, `${orphan}/dangling-link`);
          yield* fixture.fs.utimes(orphan, 1, 1);
          const report = yield* fixture.service.runNow;
          expect(report.entries).toEqual([
            {
              kind: "worktree",
              outcome: "kept",
              reason: "No thread uses this worktree",
              path: orphan,
              projectPath: null,
              threadId: null,
              threadTitle: null,
              bytes: sizes.reduce((sum, size) => sum + size, 0),
              files: null,
            },
          ]);
          expect(report.bytesFreed).toBe(0);
          expect(yield* fixture.fs.readFileString(`${orphan}/tracked.txt`)).toBe("original\n");
          expect(yield* fixture.fs.readFileString(`${outside}/external`)).toBe("outside data");
          expect(
            (yield* fixture.command(orphan, ["rev-parse", "--is-inside-work-tree"])).stdout.trim(),
          ).toBe("true");
        }),
      ),
  );

  it.live.each(["active", "outside-active-snapshot"] as const)(
    "does not report a folder referenced by a thread (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          const worktreePath = `${fixture.config.worktreesDir}/repository/referenced`;
          yield* fixture.command(fixture.repo, [
            "worktree",
            "add",
            "-b",
            "referenced",
            worktreePath,
          ]);
          fixture.setThreads(
            location === "active"
              ? [shell({ branch: "referenced", worktreePath, status: "running" })]
              : [],
          );
          if (location !== "active")
            fixture.setStoredWorktreePaths([fixture.worktree, worktreePath]);
          yield* fixture.fs.utimes(worktreePath, 1, 1);
          const report = yield* fixture.service.runNow;
          expect(report.entries.filter((entry) => entry.threadId === null)).toEqual([]);
          expect(yield* fixture.fs.exists(worktreePath)).toBe(true);
        }),
      ),
  );

  it.live.each(["exact", "nested", "symlink"] as const)(
    "does not report a folder containing a project checkout (%s)",
    (location) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture();
          fixture.setThreads([]);
          const worktreePath = `${fixture.config.worktreesDir}/repository/project-checkout`;
          yield* fixture.fs.makeDirectory(`${worktreePath}/nested`, { recursive: true });
          const alias = `${fixture.repo}/alias`;
          if (location === "symlink") yield* fixture.fs.symlink(`${worktreePath}/nested`, alias);
          fixture.setProjectRoots([
            fixture.repo,
            location === "exact"
              ? worktreePath
              : location === "nested"
                ? `${worktreePath}/nested`
                : alias,
          ]);
          yield* fixture.fs.utimes(worktreePath, 1, 1);
          expect((yield* fixture.service.runNow).entries).toEqual([]);
          expect(yield* fixture.fs.exists(worktreePath)).toBe(true);
        }),
      ),
  );

  it.live("reports ordinary folders with an honest reason and keeps their files", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const folder = `${fixture.config.worktreesDir}/repository/leftover`;
        yield* fixture.fs.makeDirectory(folder, { recursive: true });
        yield* fixture.fs.writeFileString(`${folder}/payload`, "leftover data");
        yield* fixture.fs.utimes(folder, 1, 1);
        const report = yield* fixture.service.runNow;
        expect(report.entries).toEqual([
          expect.objectContaining({
            path: folder,
            outcome: "kept",
            bytes: yield* allocatedBytes(fixture.fs, `${folder}/payload`),
            reason: "No thread uses this folder, and it isn't a git worktree",
          }),
        ]);
        expect(report.bytesFreed).toBe(0);
        expect(yield* fixture.fs.readFileString(`${folder}/payload`)).toBe("leftover data");
      }),
    ),
  );
});

describe("storage cleanup reports and local file policies", () => {
  it.effect("keeps a thread's worktree folder that lost its .git link", () =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture();
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, archivedAt: at(-DAY_MS) }),
        ]);
        yield* fixture.fs.remove(`${fixture.worktree}/.git`);
        yield* fixture.fs.makeDirectory(`${fixture.worktree}/node_modules`);
        const report = yield* fixture.service.runNow;
        expect(report.entries).toEqual([
          expect.objectContaining({ path: fixture.worktree, outcome: "kept" }),
        ]);
        expect(yield* fixture.fs.exists(`${fixture.worktree}/node_modules`)).toBe(true);
      }),
    ),
  );
  it.live.each([
    ["before-check", "stored"],
    ["while-measuring", "stored"],
    ["before-check", "symlinked parent"],
    ["while-measuring", "symlinked parent"],
  ] as const)(
    "keeps a worktree protected by a missing project root (%s, %s spelling)",
    ([timing, spelling]) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* pausedMeasurementFixture();
          let worktree = fixture.worktree;
          if (spelling === "symlinked parent") {
            const linkedParent = `${yield* fixture.fs.makeTempDirectoryScoped({ prefix: "cleanup-link-" })}/worktrees`;
            yield* fixture.fs.symlink(fixture.config.worktreesDir, linkedParent);
            worktree = `${linkedParent}/feature`;
            fixture.setThreads([shell({ branch: "feature", worktreePath: worktree })]);
          }
          if (timing === "before-check")
            fixture.setProjectRoots([fixture.repo, `${worktree}/removed-checkout`]);
          const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
          if (timing === "while-measuring") {
            yield* Deferred.await(fixture.measuring);
            fixture.setProjectRoots([fixture.repo, `${worktree}/removed-checkout`]);
          }
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(cleanup);
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Contains a project checkout",
          });
          expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
            "original\n",
          );
        }),
      ),
  );
  it.live("lets a turn acquire the checkout during accounting and protects its new activity", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* pausedMeasurementFixture();
        const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.measuring);
        yield* withWorkspaceLease(
          fixture.worktree,
          Effect.sync(() => {
            fixture.setThreads([
              shell({
                branch: "feature",
                worktreePath: fixture.worktree,
                status: "running",
              }),
            ]);
          }),
        );
        yield* Deferred.succeed(fixture.resume, undefined);
        const report = yield* Fiber.join(cleanup);
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Thread activity or shared worktree changed since check",
          bytes: null,
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );
  it.live("keeps a worktree when the inspection cannot read its directories", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { service, worktree } = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory) => fs.readDirectory(`${directory}/missing-directory`),
          }),
        );
        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Worktree could not be fully inspected",
          bytes: null,
          files: null,
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.effect("removes a worktree owned by a repository other than the project root", () =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture();
        const { fs, command, config } = fixture;
        const oldRepo = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-old-repo-" }),
        );
        yield* command(oldRepo, ["init", "-b", "main"]);
        yield* command(oldRepo, ["config", "user.email", "cleanup@example.test"]);
        yield* command(oldRepo, ["config", "user.name", "Cleanup test"]);
        yield* fs.writeFileString(`${oldRepo}/tracked.txt`, "original\n");
        yield* command(oldRepo, ["add", "."]);
        yield* command(oldRepo, ["commit", "-m", "initial"]);
        yield* fs.makeDirectory(`${config.worktreesDir}/old-repo`, { recursive: true });
        const oldWorktree = `${config.worktreesDir}/old-repo/feature`;
        yield* command(oldRepo, ["worktree", "add", "-b", "feature", oldWorktree]);
        fixture.setThreads([shell({ branch: "feature", worktreePath: oldWorktree })]);
        const report = yield* fixture.service.runNow;
        expect(report.entries.find((entry) => entry.path === oldWorktree)).toMatchObject({
          outcome: "removed",
        });
        expect(yield* fs.exists(oldWorktree)).toBe(false);
        expect((yield* command(oldRepo, ["worktree", "list", "--porcelain"])).stdout).not.toContain(
          oldWorktree,
        );
      }),
    ),
  );
  it.effect.each([
    [
      "its owner's branch is cleared",
      (worktree: string) => [shell({ branch: null, worktreePath: worktree, updatedAt: at(0) })],
    ],
    [
      "its owner's branch changes",
      (worktree: string) => [shell({ branch: "other", worktreePath: worktree, updatedAt: at(0) })],
    ],
    [
      "its thread starts",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree, status: "running" }),
      ],
    ],
    [
      "another thread starts using it",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree }),
        shell({ id: ThreadId.make("thread-2"), branch: "feature", worktreePath: worktree }),
      ],
    ],
    [
      "an archived thread starts using it",
      (worktree: string) => [
        shell({ branch: "feature", worktreePath: worktree }),
        shell({
          id: ThreadId.make("thread-2"),
          branch: "feature",
          worktreePath: worktree,
          archivedAt: at(-DAY_MS),
        }),
      ],
    ],
  ] as const)("keeps a worktree when %s during size measurement", ([, threadsWhileMeasuring]) =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* pausedMeasurementFixture();
        const { fs, worktree } = fixture;
        fixture.setPolicy("tracked-changes");
        yield* fs.writeFileString(`${worktree}/notes.txt`, "untracked\n");
        const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
        yield* Deferred.await(fixture.measuring);
        fixture.setThreads(threadsWhileMeasuring(worktree));
        yield* Deferred.succeed(fixture.resume, undefined);
        const report = yield* Fiber.join(cleanup);
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Thread activity or shared worktree changed since check",
          bytes: null,
        });
        expect(report.bytesFreed).toBe(0);
        expect(yield* fs.exists(worktree)).toBe(true);
        expect(yield* fs.readFileString(`${worktree}/notes.txt`)).toBe("untracked\n");
      }),
    ),
  );
  it.live("removes a clean detached worktree only when every commit is on a branch", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, command } = yield* cleanupFixture();
        yield* command(worktree, ["checkout", "--detach"]);
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "unpushed\n");
        yield* command(worktree, ["commit", "-am", "unpushed"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept" });
        yield* command(worktree, ["checkout", "--detach", "main"]);
        yield* command(worktree, ["-c", "sequence.editor=echo break >>", "rebase", "-i", "--root"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept" });
        yield* command(worktree, ["rebase", "--abort"]);
        yield* command(worktree, ["checkout", "-b", "topic", "main"]);
        yield* command(worktree, ["commit", "--allow-empty", "-m", "topic"]);
        yield* command(worktree, ["checkout", "--detach", "main"]);
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "autostashed\n");
        yield* command(worktree, ["merge", "--autostash", "--no-ff", "--no-commit", "topic"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept" });
        yield* command(worktree, ["merge", "--abort"]);
        expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("autostashed\n");
        yield* command(worktree, ["checkout", "--", "tracked.txt"]);
        yield* command(worktree, ["bisect", "start"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept" });
        yield* command(worktree, ["bisect", "reset"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
      }),
    ),
  );
  it.live(
    "keeps worktree commits present on nondefault main but absent from advertised trunk",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const { service, fs, repo, worktree, command, setThreads } = yield* cleanupFixture({
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeUnchanged: true,
          });
          setThreads([
            shell({ branch: "feature", worktreePath: worktree, archivedAt: at(-DAY_MS) }),
          ]);
          const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
          yield* command(remote, ["init", "--bare", "-b", "trunk"]);
          yield* command(repo, ["remote", "add", "origin", remote]);
          yield* command(repo, ["push", "origin", "main:trunk"]);
          yield* fs.writeFileString(`${worktree}/tracked.txt`, "unmerged work\n");
          yield* command(worktree, ["commit", "-am", "unmerged work"]);
          yield* command(repo, ["push", "origin", "feature:main"]);
          expect(
            (yield* command(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]).pipe(Effect.exit))
              ._tag,
          ).toBe("Failure");

          const report = yield* service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Has commits beyond the default branch",
          });
          expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("unmerged work\n");
        }),
      ),
  );
  it.live("keeps the worktree when the remote default is unavailable even if main exists", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command, setThreads } = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeUnchanged: true,
        });
        setThreads([shell({ branch: "feature", worktreePath: worktree, archivedAt: at(-DAY_MS) })]);
        const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
        yield* command(remote, ["init", "--bare", "-b", "trunk"]);
        yield* command(repo, ["remote", "add", "origin", remote]);
        // The remote HEAD names an unborn trunk; main exists but is not its default.
        yield* command(repo, ["push", "origin", "main"]);

        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Default branch is unavailable",
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.live("preserves tracked edits written after the final status check", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setPolicy("tracked-changes");
        fixture.editBeforeRemoval();
        yield* fixture.fs.writeFileString(`${fixture.worktree}/notes.txt`, "untracked\n");
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({ outcome: "failed", bytes: null, files: null });
        expect(report.bytesFreed).toBe(0);
        expect(report.entries[0]?.reason).toContain("contains modified or untracked files");
        expect(yield* fixture.fs.readFileString(`${fixture.worktree}/tracked.txt`)).toBe(
          "late edit\n",
        );
        expect(yield* fixture.fs.exists(`${fixture.worktree}/notes.txt`)).toBe(false);
      }),
    ),
  );
  it.live("keeps staged edits in tracked-only mode", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy, command } = yield* cleanupFixture();
        setPolicy("tracked-changes");
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "staged\n");
        yield* command(worktree, ["add", "tracked.txt"]);
        expect((yield* service.runNow).entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Has uncommitted changes (1 file)",
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
  it.live.each(["--assume-unchanged", "--skip-worktree"] as const)(
    "keeps tracked edits that git status hides (%s)",
    (flag) =>
      runCleanupTest(
        Effect.gen(function* () {
          const { service, fs, worktree, command } = yield* cleanupFixture();
          yield* command(worktree, ["update-index", flag, "tracked.txt"]);
          yield* fs.writeFileString(`${worktree}/tracked.txt`, "hidden edit\n");
          expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept" });
          expect(yield* fs.readFileString(`${worktree}/tracked.txt`)).toBe("hidden edit\n");
        }),
      ),
  );
  // macOS and Windows file systems reject names that are not valid UTF-8.
  it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "keeps hidden edits to files whose names are not valid UTF-8",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const { service, fs, worktree, command } = yield* cleanupFixture();
          const git = yield* GitVcsDriver.GitVcsDriver;
          // Git unquotes C-quoted paths on stdin, which reaches a name a JS string cannot.
          const quoted = '"bad-\\377.txt"';
          const stdin = (args: string[], input: string) =>
            git.execute({ operation: "cleanup-test", cwd: worktree, args, stdin: input });
          const blob = (content: string) =>
            stdin(["hash-object", "-w", "--stdin"], content).pipe(
              Effect.map((result) => result.stdout.trim()),
            );
          const original = yield* blob("original\n");
          yield* stdin(["update-index", "--index-info"], `100644 ${original}\t${quoted}\n`);
          yield* stdin(["checkout-index", "--stdin"], `${quoted}\n`);
          yield* command(worktree, ["commit", "-m", "bad name"]);
          // The committed content moves on while the file on disk keeps the other version.
          const edited = yield* blob("edited\n");
          yield* stdin(["update-index", "--index-info"], `100644 ${edited}\t${quoted}\n`);
          yield* command(worktree, ["commit", "-m", "edit"]);
          yield* stdin(["update-index", "--assume-unchanged", "--stdin"], `${quoted}\n`);
          expect((yield* command(worktree, ["status", "--porcelain"])).stdout).toBe("");
          expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept" });
          expect((yield* fs.readDirectory(worktree)).some((name) => name.startsWith("bad-"))).toBe(
            true,
          );
        }),
      ),
  );
  it.live.each([
    ["uncommitted-changes", "untracked", "Local changes exceed the inspection limit"],
    ["any-local-files", "ignored", "Ignored files exceed the inspection limit"],
  ] as const)(
    "keeps a worktree under %s when its %s file listing exceeds the inspection limit",
    ([policy, kind, reason]) =>
      runCleanupTest(
        Effect.gen(function* () {
          const { service, fs, worktree, setPolicy } = yield* cleanupFixture();
          setPolicy(policy);
          const files = Array.from({ length: 3000 }, (_, i) =>
            kind === "untracked"
              ? `${worktree}/many/untracked-file-with-a-long-name-${i}.txt`
              : `${worktree}/many/ignored-directory-with-a-long-name-${i}/.env`,
          );
          yield* fs.makeDirectory(`${worktree}/many`);
          yield* Effect.forEach(
            files,
            (file) =>
              Effect.gen(function* () {
                if (kind === "ignored") yield* fs.makeDirectory(file.slice(0, -"/.env".length));
                yield* fs.writeFileString(file, "local\n");
              }),
            { concurrency: 64, discard: true },
          );
          expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept", reason });
          expect(yield* fs.exists(files[0]!)).toBe(true);
        }),
      ),
  );
  it.live.each([
    { kind: "logs", name: "server.log.1", label: "rotated logs" },
    { kind: "browser-artifacts", name: "capture.png", label: "browser artifacts" },
  ] as const)("skips dangling symlinks during $kind cleanup", ({ kind, name, label }) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, config, enableFiles, disable } = yield* cleanupFixture();
        disable();
        enableFiles();
        const directory = kind === "logs" ? `${config.logsDir}/nested` : config.browserArtifactsDir;
        yield* fs.makeDirectory(directory, { recursive: true });
        const expired = `${directory}/${name}`;
        const dangling = `${directory}/00-dangling-${name}`;
        const linked = `${directory}/01-linked-${name}`;
        yield* fs.symlink("missing", dangling);
        yield* fs.symlink(directory, linked);
        yield* fs.writeFileString(expired, "expired");
        yield* fs.utimes(expired, 1, 1);

        const report = yield* service.runNow;
        expect(report.entries.filter((entry) => entry.kind === kind)).toMatchObject([
          { outcome: "removed", reason: `Removed 1 ${label}`, files: 1, bytes: 7 },
        ]);
        expect((yield* fs.readDirectory(directory)).toSorted()).toEqual([
          `00-dangling-${name}`,
          `01-linked-${name}`,
        ]);
      }),
    ),
  );
  it.live("keeps external rotated logs when a scanned directory is replaced by a symlink", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        yield* fs.makeDirectory(config.logsDir, { recursive: true });
        const nested = `${yield* fs.realPath(config.logsDir)}/nested`;
        const outside = yield* fs.makeTempDirectoryScoped();
        const expired = `${outside}/server.log.1`;
        yield* fs.makeDirectory(nested);
        yield* fs.writeFileString(expired, "external log");
        yield* fs.utimes(expired, 1, 1);

        const { service, enableFiles, disable } = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory, options) =>
              Effect.gen(function* () {
                if (directory === nested) {
                  yield* fs.rename(nested, `${nested}-original`);
                  yield* fs.symlink(outside, nested);
                }
                return yield* fs.readDirectory(directory, options);
              }),
          }),
        );
        disable();
        enableFiles();
        const report = yield* service.runNow;
        expect(yield* fs.exists(expired)).toBe(true);
        expect(report.entries.find((entry) => entry.kind === "logs")).toMatchObject({
          outcome: "kept",
          reason: "No expired files",
        });
      }),
    ),
  );
});

describe("settled worktree rechecks", () => {
  it.effect.each(["autoResumeLimitedThreads", "snoozeLimitedThreads"] as const)(
    "keeps a usage-limited checkout when %s is enabled during measurement",
    (preference) =>
      runCleanupTest(
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW_MS);
          const fixture = yield* pausedMeasurementFixture();
          fixture.setSettings({ autoResumeLimitedThreads: false, snoozeLimitedThreads: false });
          fixture.setThreads([
            shell({
              branch: "feature",
              worktreePath: fixture.worktree,
              status: "failed",
              latestRunId: RunId.make("limited-run"),
              lastErrorClass: "usage_limit",
              usageLimitResetAt: DateTime.formatIso(at(DAY_MS)),
            }),
          ]);
          const run = yield* fixture.service.runNow.pipe(Effect.forkChild);
          yield* Deferred.await(fixture.measuring);
          fixture.setSettings({ [preference]: true });
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(run);
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason: "Settings changed since check",
          });
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
  it.effect("keeps a task folder when settings change after its checks began", () =>
    runCleanupTest(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture();
        fixture.setSettings({
          autoResumeLimitedThreads: false,
          storageCleanup: {
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeSettledAfterDays: 0,
          },
        });
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(0) }),
        ]);
        let removals = 0;
        fixture.setTaskFolders({
          find: () =>
            Effect.sync(() => {
              fixture.setSettings({ autoResumeLimitedThreads: true });
              return {
                root: fixture.worktree,
                projectId: ProjectId.make("project-1"),
                projectRoot: fixture.repo,
                anchor: fixture.repo,
                projectPath: fixture.worktree,
                projectIsWorktree: true,
                repositories: [],
              };
            }),
          remove: () =>
            Effect.sync(() => {
              removals += 1;
              return { removed: [], kept: [] };
            }),
        });
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Settings changed since check",
        });
        expect(removals).toBe(0);
      }),
    ),
  );
  it.effect.each([{ settledAt: null }, { settledAt: at(DAY_MS) }])(
    "keeps a checkout changed during measurement (%j)",
    (change) =>
      runCleanupTest(
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW_MS);
          const fixture = yield* pausedMeasurementFixture();
          const thread = shell({
            branch: "feature",
            worktreePath: fixture.worktree,
            settledAt: at(0),
          });
          fixture.setSettings({
            storageCleanup: {
              ...DEFAULT_SERVER_SETTINGS.storageCleanup,
              worktreeSettledAfterDays: 0,
            },
          });
          fixture.setThreads([thread]);
          const run = yield* fixture.service.runNow.pipe(Effect.forkChild);
          yield* Deferred.await(fixture.measuring);
          fixture.setThreads([{ ...thread, ...change }]);
          yield* Deferred.succeed(fixture.resume, undefined);
          const report = yield* Fiber.join(run);
          expect(report.entries[0]?.reason).toBe(
            "Thread activity or shared worktree changed since check",
          );
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );
});

it.effect("keeps saved usage data when removing a settled checkout", () =>
  runCleanupTest(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture();
      fixture.setSettings({
        storageCleanup: { ...DEFAULT_SERVER_SETTINGS.storageCleanup, worktreeSettledAfterDays: 0 },
      });
      fixture.setThreads([
        shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(0) }),
      ]);
      yield* fixture.fs.makeDirectory(fixture.config.stateDir, { recursive: true });
      const cachePath = `${fixture.config.stateDir}/${SCAN_CACHE_FILE_NAME}`;
      const savedUsage = JSON.stringify({ tokens: 12345, cost: 1.25 });
      yield* fixture.fs.writeFileString(cachePath, savedUsage);
      expect((yield* fixture.service.runNow).counts.removed).toBe(1);
      expect(yield* fixture.fs.readFileString(cachePath)).toBe(savedUsage);
    }),
  ),
);
