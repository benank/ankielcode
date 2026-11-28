import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  EventId,
  ProviderInstanceId,
  MessageId,
  RunId,
  type OrchestrationV2Run,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type ServerSettings as ContractServerSettings,
  type ServerSettingsPatch,
} from "@ankielcode/contracts";
import { applyServerSettingsPatch } from "@ankielcode/shared/serverSettings";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

type SettlementShell = OrchestrationV2ThreadShell &
  Pick<ProjectionStore.ProjectionSettlementCandidate, "latestResumingMessageAt">;

function shell(overrides: Partial<SettlementShell> = {}): SettlementShell {
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
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    latestResumingMessageAt: overrides.latestUserMessageAt ?? null,
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

describe("isAutoSettlementCandidate", () => {
  it("settles a thread whose only background work is a command left running", () => {
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({
          pendingBackgroundTasks: [
            { taskId: "dev", kind: "command", description: "vp run dev --share" },
          ],
        }),
        NOW_MS,
      ),
    ).toBe(true);
  });

  it("keeps snoozed threads parked until a fresh failure or timer wake", () => {
    const snoozed = shell({
      snoozedUntil: at(60 * 60 * 1_000),
      snoozedAt: at(-60 * 60 * 1_000),
    });
    expect(ThreadSettlementService.isAutoSettlementCandidate(snoozed, NOW_MS)).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-30 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-2 * 60 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: snoozed.snoozedAt }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: null }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      ThreadSettlementService.isAutoSettlementCandidate(
        shell({ ...snoozed, snoozedUntil: at(-1) }),
        NOW_MS,
      ),
    ).toBe(true);
  });
});

describe("resolveAutoSettlementAt", () => {
  it("settles an idle thread at its last activity once the inactivity window passes", () => {
    const thread = shell({ latestUserMessageAt: at(-5 * DAY_MS) });
    const resolve = (autoSettleAfterDays: number | null) =>
      ThreadSettlementService.resolveAutoSettlementAt({
        thread,
        nowMs: NOW_MS,
        autoSettleAfterDays,
      });
    expect(resolve(3)).toEqual(at(-5 * DAY_MS));
    expect(resolve(7)).toBeNull();
    expect(resolve(null)).toBeNull();
  });
});

const NOW = "2026-08-28T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("settlement-project");

type AutoSettleCommand = Extract<OrchestrationV2Command, { readonly type: "thread.auto-settle" }>;

const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(1));

function makeProject(
  id: ProjectId = PROJECT_ID,
  workspaceRoot = "/workspace/project",
): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

function makeThread(id: string, overrides: Partial<SettlementShell> = {}): SettlementShell {
  return shell({
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title: id,
    createdAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    latestUserMessageAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
    ...overrides,
  });
}

type SettlementSnapshot = Omit<OrchestrationV2ShellSnapshot, "threads"> & {
  readonly threads: ReadonlyArray<SettlementShell>;
};

function makeSnapshot(
  threads: ReadonlyArray<SettlementShell>,
  projects: ReadonlyArray<OrchestrationProjectShell> = [makeProject()],
): SettlementSnapshot {
  return {
    schemaVersion: 1,
    snapshotSequence: 1,
    projects,
    threads,
    archivedThreads: [],
  };
}

interface HarnessOptions {
  readonly snapshot: SettlementSnapshot;
  readonly settings?: ContractServerSettings;
  readonly existingWorktreePaths?: ReadonlyArray<string>;
  readonly unreadablePaths?: ReadonlyArray<string>;
  readonly onDispatch?: (command: AutoSettleCommand) => Effect.Effect<void>;
  readonly onScriptRun?: (
    input: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput,
  ) => Effect.Effect<void>;
  readonly onCloseIdle?: () => Effect.Effect<void>;
  readonly hasActiveSubprocess?: (input: { readonly threadId: string }) => Effect.Effect<boolean>;
  readonly currentThreads?: ReadonlyArray<OrchestrationV2AppThread>;
  readonly projections?: ProjectionStore.ProjectionStoreV2Shape;
}

const makeHarness = Effect.fn("makeThreadSettlementHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const snapshots = yield* Ref.make(options.snapshot);
  const snapshotReadCount = yield* Ref.make(0);
  const snapshotReads = yield* Queue.unbounded<number>();
  const candidateReads = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
  const settings = yield* Ref.make(options.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsReadCount = yield* Ref.make(0);
  const settingsChanges = yield* PubSub.unbounded<ContractServerSettings>();
  const commands = yield* Ref.make<ReadonlyArray<AutoSettleCommand>>([]);
  const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
  const observedEvents = yield* Queue.unbounded<EventId>();
  const closedIdle = yield* Queue.unbounded<{ readonly threadId: string }>();
  const scriptRuns =
    yield* Queue.unbounded<ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput>();

  const updateSettings = (patch: ServerSettingsPatch) =>
    Effect.gen(function* () {
      const next = applyServerSettingsPatch(yield* Ref.get(settings), patch);
      yield* Ref.set(settings, next);
      yield* PubSub.publish(settingsChanges, next);
      return next;
    });

  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) => {
    if (command.type !== "thread.auto-settle") {
      return Effect.die(new Error(`Unexpected command: ${command.type}`));
    }
    return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1, storedEvents: [] }),
    );
  };

  const serverSettings = ServerSettings.ServerSettingsService.of({
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.update(settingsReadCount, (count) => count + 1).pipe(
      Effect.andThen(Ref.get(settings)),
    ),
    updateSettings,
    updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
    withSettingsSnapshot: (use) => Ref.get(settings).pipe(Effect.flatMap(use)),
    streamChanges: Stream.fromPubSub(settingsChanges),
    subscribeChanges: PubSub.subscribe(settingsChanges).pipe(
      Effect.map((subscription) => Stream.fromSubscription(subscription)),
    ),
  });

  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () => Ref.get(snapshots).pipe(Effect.map((snapshot) => snapshot.projects)),
      getShell: (projectId) =>
        Ref.get(snapshots).pipe(
          Effect.map((snapshot) =>
            Option.fromNullishOr(snapshot.projects.find((project) => project.id === projectId)),
          ),
        ),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      ...options.projections,
      getSettlementCandidates: (threadId) =>
        Ref.update(candidateReads, (reads) => [...reads, threadId]).pipe(
          Effect.andThen(Ref.updateAndGet(snapshotReadCount, (count) => count + 1)),
          Effect.tap((count) => Queue.offer(snapshotReads, count)),
          Effect.andThen(
            options.projections?.getSettlementCandidates(threadId) ??
              Ref.get(snapshots).pipe(
                Effect.map((snapshot) =>
                  threadId === undefined
                    ? snapshot.threads
                    : snapshot.threads.filter((thread) => thread.id === threadId),
                ),
              ),
          ),
        ),
      getThread: (threadId) => {
        if (options.projections) return options.projections.getThread(threadId);
        const thread = options.currentThreads?.find((candidate) => candidate.id === threadId);
        return thread
          ? Effect.succeed(thread)
          : Effect.die(new Error(`Unexpected thread read: ${threadId}`));
      },
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromPubSub(domainEvents).pipe(
        Stream.tap((event) => Queue.offer(observedEvents, event.id)),
      ),
      dispatch,
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      closeOnSettle: (input) =>
        Queue.offer(closedIdle, input).pipe(Effect.andThen(options.onCloseIdle?.() ?? Effect.void)),
      hasActiveSubprocess: (input) => options.hasActiveSubprocess?.(input) ?? Effect.succeed(false),
    }),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
      runForThread: (input) =>
        Queue.offer(scriptRuns, input).pipe(
          Effect.andThen(options.onScriptRun?.(input) ?? Effect.void),
          Effect.as({ status: "no-script" } as const),
        ),
    }),
    Layer.succeed(ServerSettings.ServerSettingsService, serverSettings),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(SecureRandom.SecureRandom, testCrypto),
    FileSystem.layerNoop({
      exists: (path) =>
        options.unreadablePaths?.includes(path)
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "exists",
                pathOrDescriptor: path,
              }),
            )
          : Effect.succeed(options.existingWorktreePaths?.includes(path) ?? false),
    }),
    Path.layer,
  );

  return {
    activation,
    settings,
    snapshots,
    snapshotReadCount,
    settingsReadCount,
    snapshotReads,
    candidateReads,
    commands,
    closedIdle,
    scriptRuns,
    observedEvents,
    publishEvent: (event: OrchestrationV2DomainEvent) => PubSub.publish(domainEvents, event),
    updateSettings,
    layer: Layer.effect(
      ThreadSettlementService.ThreadSettlementServiceV2,
      ThreadSettlementService.make,
    ).pipe(Layer.provide(layerDependencies)),
  };
});

const startHarness = Effect.fn("startThreadSettlementHarness")(function* (
  reactor: ThreadSettlementService.ThreadSettlementServiceV2["Service"],
  activation: Deferred.Deferred<void>,
  snapshotReads: Queue.Queue<number>,
) {
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(snapshotReads);
  yield* reactor.drain;
});

const projectionStoreSql = ProjectionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const appThread = (
  id: string,
  settledOverride: OrchestrationV2AppThread["settledOverride"],
  worktreePath: string | null = null,
): OrchestrationV2AppThread => {
  const threadId = ThreadId.make(id);
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: PROJECT_ID,
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride,
    settledAt: settledOverride === "settled" ? DateTime.makeUnsafe(NOW) : null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};
const settledEvent = (thread: OrchestrationV2AppThread): OrchestrationV2DomainEvent => ({
  type: "thread.settled",
  id: EventId.make(`event:settled:${thread.id}`),
  threadId: thread.id,
  occurredAt: DateTime.makeUnsafe(NOW),
  payload: thread,
});

describe("ThreadSettlementServiceV2 worker", () => {
  it.effect("skips settings decisions for recent threads", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const threads = Array.from({ length: 32 }, (_, index) =>
        makeThread(`recent-${index}`, {
          updatedAt: DateTime.makeUnsafe(NOW),
          latestUserMessageAt: DateTime.makeUnsafe(Date.parse(NOW) - 2 * DAY_MS),
        }),
      );
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot(threads),
        settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 3 },
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        assert.deepEqual(yield* Ref.get(fixture.commands), []);
        assert.equal(yield* Ref.get(fixture.settingsReadCount), 2);
        yield* fixture.updateSettings({ sidebarAutoSettleAfterDays: 1 });
        yield* Queue.take(fixture.snapshotReads);
        yield* service.drain;
        assert.deepEqual(
          new Set((yield* Ref.get(fixture.commands)).map((command) => command.threadId)),
          new Set(threads.map((thread) => thread.id)),
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
  it.effect("does not auto-settle a thread whose terminal has an active subprocess", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const thread = makeThread("active-terminal");
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([thread]),
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          sidebarAutoSettleAfterDays: 3,
        },
        hasActiveSubprocess: ({ threadId }) => Effect.succeed(threadId === thread.id),
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([]);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("drains idle subagents of a settled parent and retries busy children", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const parent = appThread("subagent-parent", "settled");
      const child = (id: string, overrides: Partial<OrchestrationV2AppThread> = {}) => ({
        ...appThread(id, null),
        branch: "feature",
        lineage: {
          rootThreadId: parent.id,
          parentThreadId: parent.id,
          relationshipToParent: "subagent" as const,
        },
        ...overrides,
      });
      const empty = child("empty");
      const recent = child("recent");
      const busy = child("busy");
      const marker = appThread("marker", "settled");
      for (const thread of [
        parent,
        empty,
        recent,
        busy,
        marker,
        child("pinned", { pinnedAt: DateTime.makeUnsafe(NOW) }),
        child("opted-out", { autoSettleDisabledAt: DateTime.makeUnsafe(NOW) }),
      ]) {
        yield* store.apply({
          type: "thread.created",
          id: EventId.make(`created:${thread.id}`),
          threadId: thread.id,
          occurredAt: thread.createdAt,
          payload: thread,
        });
      }
      const run = (threadId: ThreadId, status: "running" | "completed"): OrchestrationV2Run => ({
        id: RunId.make(`run:${threadId}`),
        threadId,
        ordinal: 1,
        providerInstanceId: parent.providerInstanceId,
        modelSelection: parent.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${threadId}`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: DateTime.makeUnsafe(NOW),
        startedAt: DateTime.makeUnsafe(NOW),
        completedAt: status === "completed" ? DateTime.makeUnsafe(NOW) : null,
        checkpointId: null,
        contextHandoffId: null,
      });
      for (const payload of [run(recent.id, "completed"), run(busy.id, "running")]) {
        yield* store.apply({
          type: "run.created",
          id: EventId.make(`created:${payload.id}`),
          threadId: payload.threadId,
          occurredAt: DateTime.makeUnsafe(NOW),
          payload,
        });
      }
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([]),
        projections: store,
        settings: { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 2 },
        onDispatch: (command) =>
          store.getThread(command.threadId).pipe(
            Effect.flatMap((thread) =>
              store.apply(
                settledEvent({
                  ...thread,
                  settledOverride: "settled",
                  settledAt: DateTime.makeUnsafe(NOW),
                }),
              ),
            ),
            Effect.orDie,
          ),
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        const commands = yield* Ref.get(fixture.commands);
        expect(commands.map((command) => command.threadId).toSorted()).toEqual([
          empty.id,
          recent.id,
        ]);
        for (const command of commands) {
          expect(command.snapshotAt).toEqual(DateTime.makeUnsafe(NOW));
          expect(command.settledAt).toBeUndefined();
        }
        const finished: OrchestrationV2DomainEvent = {
          type: "run.updated",
          id: EventId.make("busy:completed"),
          threadId: busy.id,
          occurredAt: DateTime.makeUnsafe(NOW),
          payload: run(busy.id, "completed"),
        };
        yield* store.apply(finished);
        yield* fixture.publishEvent(finished);
        // Cleanup of the following event marks delivery of the run event before draining.
        yield* fixture.publishEvent(settledEvent(marker));
        expect(yield* Queue.take(fixture.closedIdle)).toEqual({ threadId: marker.id });
        yield* service.drain;
        expect((yield* Ref.get(fixture.commands)).map((command) => command.threadId)).toEqual([
          empty.id,
          recent.id,
          busy.id,
        ]);
      }).pipe(Effect.provide(fixture.layer));
    }).pipe(Effect.provide(projectionStoreSql)),
  );
});

describe("ThreadSettlementServiceV2 terminals", () => {
  it.effect.each(["re-engaged", "deleted"] as const)(
    "skips settlement actions for a thread %s before the event ran",
    (state) =>
      Effect.gen(function* () {
        const settled = appThread("stale-thread", "settled", "/worktrees/stale");
        const current =
          state === "re-engaged"
            ? { ...settled, settledOverride: "active" as const }
            : { ...settled, deletedAt: DateTime.makeUnsafe(NOW) };
        const marker = appThread("marker-thread", "settled", "/worktrees/marker");
        const fixture = yield* makeHarness({
          snapshot: makeSnapshot([]),
          currentThreads: [current, marker],
          existingWorktreePaths: ["/worktrees/stale", "/worktrees/marker"],
        });

        yield* Effect.gen(function* () {
          const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
          yield* startHarness(service, fixture.activation, fixture.snapshotReads);
          yield* fixture.publishEvent(settledEvent(settled));
          yield* fixture.publishEvent(settledEvent(marker));
          assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: marker.id });
          assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
        }).pipe(Effect.provide(fixture.layer));
      }),
  );

  it.effect("runs the settle script in the thread's own worktree", () =>
    Effect.gen(function* () {
      const warnings: string[] = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(JSON.stringify(message));
      });
      const shared = appThread("shared-checkout-thread", "settled");
      const missing = appThread("removed-worktree-thread", "settled", "/worktrees/removed");
      const worktree = appThread("worktree-thread", "settled", "/worktrees/thread");
      const scriptless = makeProject(ProjectId.make("scriptless-project"));
      const missingScriptless = {
        ...appThread("removed-worktree-scriptless-thread", "settled", "/worktrees/scriptless"),
        projectId: scriptless.id,
      };
      const teardown = {
        id: "teardown",
        name: "Teardown",
        command: "docker compose down",
        icon: "configure",
        runOnWorktreeCreate: false,
        runOnSettle: true,
      } as const;
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([], [{ ...makeProject(), scripts: [teardown] }, scriptless]),
        currentThreads: [shared, missing, missingScriptless, worktree],
        existingWorktreePaths: ["/worktrees/thread"],
      });

      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        yield* fixture.publishEvent(settledEvent(shared));
        yield* fixture.publishEvent(settledEvent(missing));
        yield* fixture.publishEvent(settledEvent(missingScriptless));
        yield* fixture.publishEvent(settledEvent(worktree));
        const run = yield* Queue.take(fixture.scriptRuns);
        assert.strictEqual(run.threadId, worktree.id);
        assert.strictEqual(run.worktreePath, "/worktrees/thread");
        assert.strictEqual(run.trigger, "settle");
        // A removed worktree skips a configured settle script; the log is its only trace.
        assert.strictEqual(warnings.length, 1);
        assert.include(warnings[0], missing.id);
        assert.include(warnings[0], "/worktrees/removed");
      }).pipe(
        Effect.provide(
          fixture.layer.pipe(
            Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
          ),
        ),
      );
    }),
  );

  it.effect("skips the settle script for a subagent in its parent's worktree", () =>
    Effect.gen(function* () {
      const parent = appThread("subagent-parent", "settled", "/worktrees/parent");
      const subagent = (id: string, worktreePath: string) => ({
        ...appThread(id, "settled", worktreePath),
        lineage: {
          parentThreadId: parent.id,
          relationshipToParent: "subagent" as const,
          rootThreadId: parent.id,
        },
      });
      const shared = subagent("subagent-shared", "/worktrees/parent");
      const own = subagent("subagent-own", "/worktrees/own");
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([]),
        currentThreads: [parent, shared, own],
        existingWorktreePaths: ["/worktrees/parent", "/worktrees/own"],
      });

      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        // Events run in order, so the first run belongs to the second event
        // only if the shared-worktree child was skipped. Both still close.
        yield* fixture.publishEvent(settledEvent(shared));
        yield* fixture.publishEvent(settledEvent(own));
        assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: shared.id });
        assert.deepStrictEqual(yield* Queue.take(fixture.closedIdle), { threadId: own.id });
        assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, own.id);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("runs the settle script once when a settlement is re-emitted", () =>
    Effect.gen(function* () {
      const repeated = appThread("repeated-thread", "settled", "/worktrees/repeated");
      const marker = appThread("marker-thread", "settled", "/worktrees/marker");
      const fixture = yield* makeHarness({
        snapshot: makeSnapshot([]),
        currentThreads: [repeated, marker],
        existingWorktreePaths: ["/worktrees/repeated", "/worktrees/marker"],
      });

      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* startHarness(service, fixture.activation, fixture.snapshotReads);
        yield* fixture.publishEvent(settledEvent(repeated));
        yield* fixture.publishEvent(settledEvent(repeated));
        yield* fixture.publishEvent(settledEvent(marker));
        assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, repeated.id);
        assert.strictEqual((yield* Queue.take(fixture.scriptRuns)).threadId, marker.id);
      }).pipe(Effect.provide(fixture.layer));
    }),
  );
});
