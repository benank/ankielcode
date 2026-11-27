import * as NodeSqlite from "node:sqlite";

import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@ankielcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";

declare module "node:sqlite" {
  interface StatementSync {
    // Node 26 has this; @types/node 24 does not declare it yet.
    stat(counter: "vmStep"): number;
  }
}

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect(
  "records approval feedback and targets only its runtime request without dispatching a parent turn",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:approval-feedback");
      const sessionId = ProviderSessionId.make("session:approval-feedback");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-approval-feedback"),
        threadId,
        projectId: ProjectId.make("project:approval-feedback"),
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* projections.apply({
        id: EventId.make("session:approval-feedback"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const name of ["child", "other"]) {
        yield* projections.apply({
          id: EventId.make(`request:${name}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(name),
            nodeId: NodeId.make(`node:${name}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: sessionId,
              supportsFeedback: name === "child",
            },
            createdAt: now,
            resolvedAt: null,
          },
        });
      }
      const commandId = CommandId.make("respond:approval-feedback");
      const feedback = "Run it in a safer manner.";
      for (const [index, invalid] of [
        { requestId: RuntimeRequestId.make("other"), decision: "decline" as const, feedback },
        { requestId: RuntimeRequestId.make("child"), decision: "accept" as const, feedback },
        { requestId: RuntimeRequestId.make("child"), decision: "decline" as const, feedback: "  " },
      ].entries()) {
        const rejectedId = CommandId.make(`invalid-feedback:${index}`);
        const rejected = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: rejectedId,
            threadId,
            ...invalid,
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(rejected));
        assert.deepEqual(yield* outbox.listByCommandId(rejectedId), []);
      }
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId,
        requestId: RuntimeRequestId.make("child"),
        decision: "decline",
        feedback,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(
        projection.runtimeRequests.find((request) => request.id === "child")?.feedback,
        feedback,
      );
      assert.equal(
        projection.runtimeRequests.find((request) => request.id === "other")?.status,
        "pending",
      );
      assert.equal(projection.messages.at(-1)?.text, feedback);
      const feedbackMessageId = MessageId.make("approval-feedback:child");
      assert.ok(
        projection.visibleTurnItems.some(
          ({ item }) =>
            item.type === "user_message" &&
            item.messageId === feedbackMessageId &&
            item.text === feedback,
        ),
      );
      const history = yield* projections.getTimelinePage(threadId, { limit: 20, view: "messages" });
      assert.ok(
        history.items.some(
          ({ item }) =>
            item.type === "user_message" &&
            item.messageId === feedbackMessageId &&
            item.text === feedback,
        ),
      );
      assert.equal(projection.runs.length, 0);
      assert.deepEqual(
        (yield* outbox.listByCommandId(commandId)).map((effect) => effect.request),
        [
          {
            type: "runtime-request.respond",
            providerSessionId: sessionId,
            requestId: RuntimeRequestId.make("child"),
            decision: "decline",
            feedback,
          },
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the store's read failure as the cause when a command projection fails", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const now = DateTime.formatIso(yield* DateTime.now);
    const unreadableMessage = ThreadId.make("thread:control-unreadable-message");
    const unreadableRequest = ThreadId.make("thread:control-unreadable-request");
    for (const threadId of [unreadableMessage, unreadableRequest]) {
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId: ProjectId.make("project:control-unreadable"),
        title: "Unreadable",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }
    yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('obsolete-user', ${unreadableMessage}, NULL, NULL, 'user', 0, ${now}, ${now}, '{"obsolete":true}')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES ('request:unreadable', ${unreadableRequest}, 'node:unreadable', 'user-input', 'pending', ${now}, '{}')`;
    for (const command of [
      {
        type: "queue.resume",
        commandId: CommandId.make("resume-unreadable"),
        threadId: unreadableMessage,
      },
      {
        type: "thread.user-input.dismiss",
        commandId: CommandId.make("dismiss-unreadable"),
        threadId: unreadableRequest,
        requestId: RuntimeRequestId.make("request:unreadable"),
      },
    ] as const) {
      const failure = yield* orchestrator.dispatch(command).pipe(Effect.flip);
      assert.instanceOf(failure, Orchestrator.OrchestratorProjectionError);
      assert.instanceOf(failure.cause, ProjectionStore.ProjectionStoreReadError);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps delegated child pull-request links independent of the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:parent-pr");
    const projectId = ProjectId.make("project:parent-pr");
    const parentPullRequest = {
      projectId,
      repository: "benank/ankielcode",
      number: 123,
      url: "https://github.com/benank/ankielcode/pull/123",
    };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-parent-pr"),
      threadId: parentThreadId,
      projectId,
      title: "Parent with a linked PR",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/parent-pr",
      worktreePath: "/repo-worktree",
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-parent-pr"),
      threadId: parentThreadId,
      linkedPullRequest: parentPullRequest,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-parent-pr"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:parent-pr"),
      text: "Delegate a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* projections.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;
    const failedSpans: Array<string> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          if (Exit.isFailure(exit)) failedSpans.push(span.name);
        };
        return span;
      },
    });
    yield* orchestrator
      .dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate-parent-pr"),
        parentThreadId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "Review the changes",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.withTracer(tracer));
    // The child thread is created by this command; a failed span here reads as an error in traces.
    assert.deepEqual(failedSpans, []);
    const updatedParent = yield* projections.getThreadProjection(parentThreadId);
    assert.deepEqual(updatedParent.subagents[0]!.modelSelection, modelSelection);
    const childThreadId = updatedParent.subagents[0]!.childThreadId!;
    const child = yield* projections.getThreadProjection(childThreadId);
    assert.isNull(child.thread.linkedPullRequest);
    assert.deepEqual(child.thread.pullRequests, []);
    assert.equal(child.thread.branch, parent.thread.branch);
    assert.equal(child.thread.worktreePath, parent.thread.worktreePath);
    assert.equal(child.thread.lineage.parentThreadId, parentThreadId);

    const childPullRequest = {
      ...parentPullRequest,
      number: 456,
      url: "https://github.com/benank/ankielcode/pull/456",
    };
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-child-pr"),
      threadId: childThreadId,
      linkedPullRequest: childPullRequest,
    });
    const linkedChild = yield* projections.getThreadProjection(childThreadId);
    assert.deepEqual(linkedChild.thread.linkedPullRequest, childPullRequest);
    assert.deepEqual(
      linkedChild.thread.pullRequests?.map((link) => link.number),
      [456],
    );
    const parentAfterChildLink = yield* projections.getThreadProjection(parentThreadId);
    assert.deepEqual(parentAfterChildLink.thread.linkedPullRequest, parentPullRequest);
    assert.deepEqual(parentAfterChildLink.thread.pullRequests, parent.thread.pullRequests);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])("rejects thread.create for an existing id (deleted: %s)", (deleted) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:duplicate-create:${deleted}`);
    const create = {
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:duplicate-create"),
      title: "Original",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      importedNativeThread: {
        ref: { driver: adapter.driver, nativeId: "native-original", strength: "strong" },
      },
    } as const;
    const failedSpans: Array<string> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          if (Exit.isFailure(exit)) failedSpans.push(span.name);
        };
        return span;
      },
    });
    yield* orchestrator.dispatch(create).pipe(Effect.withTracer(tracer));
    // The id check expects a miss; a failed span there reads as an error in Tempo.
    assert.deepEqual(failedSpans, []);
    if (deleted) {
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`delete:${threadId}`),
        threadId,
      });
    }
    const before = yield* projections.getThread(threadId);
    assert.isNotNull(before.activeProviderThreadId);
    assert.equal(before.deletedAt !== null, deleted);
    const sequence = yield* orchestrator.getThreadEventSequence(threadId);
    yield* TestClock.adjust("1 second");
    const duplicate = {
      ...create,
      commandId: CommandId.make(`duplicate:${threadId}`),
      title: "Replacement",
      importedNativeThread: undefined,
    };
    const outcome = yield* orchestrator.dispatch(duplicate).pipe(Effect.result);
    assert.ok(Result.isFailure(outcome), "duplicate create must be rejected");
    const refused = outcome.failure;
    assert.equal(refused._tag, "OrchestratorThreadAlreadyExistsError");
    assert.equal(refused.message, `Thread ${threadId} already exists. Use a new thread id.`);
    assert.deepEqual(yield* projections.getThread(threadId), before);
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
    const retried = yield* orchestrator.dispatch(duplicate).pipe(Effect.flip);
    assert.equal(retried._tag, "OrchestratorCommandPreviouslyRejectedError");
    assert.include(retried.message, refused.message);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ends a task a removed linked environment was running, without waking its parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:remote-parent");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-remote-parent"),
      threadId,
      projectId: ProjectId.make("project:remote-parent"),
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-remote-parent"),
      threadId,
      messageId: MessageId.make("message:remote-parent"),
      text: "Delegate the work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-remote-parent"),
      parentThreadId: threadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Do the work there",
      completionWake: "always",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const local = yield* projections.getThreadRecords(threadId, ["subagents", "turnItems"], {
      turnItemTypes: ["subagent"],
    });
    const task = local.subagents[0]!;
    const item = local.turnItems.find((candidate) => candidate.type === "subagent")!;
    // What a remote task recorded before linked environments were removed.
    const remote = { driver: ProviderDriverKind.make("remote"), childThreadId: null };
    const remoteChild = { environmentId: "env-gone", threadId: "thread-there", label: "There" };
    const legacyTask = { ...task, ...remote, remoteChild };
    yield* eventSink.write({
      commandId: CommandId.make("command:remote-parent:legacy"),
      events: [
        {
          id: EventId.make("event:remote-parent:task"),
          type: "subagent.updated",
          threadId,
          runId: parentRun.id,
          nodeId: task.id,
          occurredAt: now,
          payload: legacyTask,
        },
        {
          id: EventId.make("event:remote-parent:item"),
          type: "turn-item.updated",
          threadId,
          runId: parentRun.id,
          nodeId: task.id,
          occurredAt: now,
          payload: { ...item, ...remote },
        },
        {
          id: EventId.make("event:remote-parent:run"),
          type: "run.updated",
          threadId,
          runId: parentRun.id,
          occurredAt: now,
          payload: { ...parentRun, status: "completed", completedAt: now },
        },
      ],
    });
    const effectCount = () =>
      sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`.pipe(
        Effect.map((rows) => rows[0]!.count),
      );
    const effectsBefore = yield* effectCount();

    yield* orchestrator.recoverDelegatedTasks;

    const ended = yield* projections.getThreadRecords(threadId, [
      "subagents",
      "nodes",
      "turnItems",
      "runs",
    ]);
    assert.deepEqual(
      [
        ended.subagents.find((candidate) => candidate.id === task.id)?.status,
        ended.nodes.find((node) => node.id === task.id)?.status,
        ended.turnItems.find((candidate) => candidate.type === "subagent")?.status,
        ended.runs.map((run) => run.status),
      ],
      ["cancelled", "cancelled", "cancelled", ["completed"]],
    );
    assert.equal(yield* effectCount(), effectsBefore);
    const sequence = yield* orchestrator.getThreadEventSequence(threadId);
    yield* orchestrator.recoverDelegatedTasks;
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("records a secret card without reading the thread's history", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:long-cards");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-long-cards"),
      threadId,
      projectId: ProjectId.make("project:long-cards"),
      title: "Cards",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-long-cards"),
      threadId,
      messageId: MessageId.make("message:long-cards"),
      text: "Ask for a token",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]!;
    const providerTurnId = ProviderTurnId.make("provider-turn:long-cards");
    yield* projections.apply({
      id: EventId.make("event:long-cards:provider-turn"),
      type: "provider-turn.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: providerTurnId,
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    const cardSpans = ["orchestrationV2.dispatch.secretRequestRecord"];
    const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const recordStatements = Effect.provideService(
      Statement.CurrentTransformer,
      (statement, _make, _fiber, span) => {
        for (
          let parent = Option.some<Tracer.AnySpan>(span);
          Option.isSome(parent) && parent.value._tag === "Span";
          parent = parent.value.parent
        ) {
          if (cardSpans.includes(parent.value.name)) {
            statements.push(statement.compile());
            break;
          }
        }
        return Effect.succeed(statement);
      },
    );
    const card = {
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId!,
      reason: "Needed for the work",
    };
    yield* orchestrator
      .dispatch({
        ...card,
        type: "secret_request.record",
        commandId: CommandId.make("record-long-cards:secret"),
        turnItemId: TurnItemId.make("item:long-cards:secret"),
        label: "Token",
        secretStatus: "pending",
      })
      .pipe(recordStatements);
    const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["secret_request"],
    });
    assert.deepEqual(
      turnItems.map((item) => [item.type, item.providerTurnId]),
      [["secret_request", providerTurnId]],
    );

    // A card reads its own run, so the rows and VM steps of its reads, which are deterministic,
    // must stay flat on a copy where the thread has thousands of older runs.
    const copyPath = "file:/card-reads?vfs=memdb";
    using copy = new NodeSqlite.DatabaseSync(copyPath);
    yield* sql`VACUUM INTO ${copyPath}`;
    const replay = () =>
      statements
        .filter(([query]) => /^\s*(SELECT|WITH)\b/.test(query))
        .reduce(
          (total, [query, params]) => {
            const statement = copy.prepare(query);
            const rows = statement.all(...(params as ReadonlyArray<NodeSqlite.SQLInputValue>));
            return {
              rows: total.rows + rows.length,
              steps: total.steps + statement.stat("vmStep"),
            };
          },
          { rows: 0, steps: 0 },
        );
    const short = replay();
    const history: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
      ["runs", "run_id", []],
      ["run_attempts", "attempt_id", ["run_id"]],
      ["nodes", "node_id", ["run_id"]],
      ["provider_turns", "provider_turn_id", ["run_attempt_id"]],
    ];
    for (const [table, key, renamed] of history) {
      const name = `orchestration_v2_projection_${table}`;
      const columns = copy
        .prepare(`SELECT name FROM pragma_table_info('${name}')`)
        .all()
        .map((column) => String(column.name));
      const values = columns.map((column) =>
        column === key || renamed.includes(column)
          ? `${column} || ':history:' || history.n`
          : column === "ordinal"
            ? "ordinal + history.n"
            : column,
      );
      copy.exec(`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 2000)
        INSERT INTO ${name} (${columns.join(", ")})
        SELECT ${values.join(", ")} FROM ${name}, history WHERE thread_id = '${threadId}'`);
    }
    const long = replay();
    assert.equal(long.rows, short.rows);
    assert.isAtMost(long.steps, short.steps * 1.1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("replays a thread.create receipt without changing the thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:create-receipt-replay");
    const create = {
      type: "thread.create",
      commandId: CommandId.make("create:receipt-replay"),
      threadId,
      projectId: ProjectId.make("project:duplicate-create"),
      title: "Original",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    } as const;
    const original = yield* orchestrator.dispatch(create);
    const before = yield* projections.getThread(threadId);
    const replayed = yield* orchestrator.dispatch(create);
    assert.equal(replayed.sequence, original.sequence);
    // Marked so client analytics do not count the retry again.
    assert.deepEqual(replayed, { ...original, replayed: true });
    assert.deepEqual(yield* projections.getThread(threadId), before);
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), original.sequence);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("explicit settle clears snooze atomically and stays idempotent after re-snoozing", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:settle-snoozed");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-snoozed"),
      threadId,
      projectId: ProjectId.make("project:settle-snoozed"),
      title: "Snoozed thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const settledAt = DateTime.add(now, { seconds: 1 });
    const snoozedUntil = DateTime.add(now, { hours: 1 });
    for (const round of [1, 2]) {
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make(`snooze-before-settle-${round}`),
        threadId,
        snoozedUntil: DateTime.formatIso(snoozedUntil),
      });
      assert.deepInclude(yield* projections.getThread(threadId), {
        snoozedUntil,
        snoozedAt: yield* DateTime.now,
      });
      yield* TestClock.adjust("1 second");
      const commandId = CommandId.make(`settle-snoozed-${round}`);
      yield* orchestrator.dispatch({ type: "thread.settle", commandId, threadId });
      const expected = {
        settledOverride: "settled",
        settledAt,
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: yield* DateTime.now,
      } as const;
      const committed = yield* events.readByCommandId({ commandId }).pipe(Stream.runCollect);
      assert.lengthOf(committed, 1);
      assert.equal(committed[0]?.event.type, "thread.settled");
      assert.deepInclude(committed[0]?.event.payload, expected);
      const settled = yield* projections.getThreadShell(threadId);
      assert.deepInclude(settled, expected);
      assert.deepInclude((yield* projections.getThreadProjection(threadId)).thread, expected);

      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`settle-again-${round}`),
        threadId,
      });
      assert.deepEqual(yield* projections.getThreadShell(threadId), settled);
    }
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle-after-snooze"),
      threadId,
      reason: "user",
    });
    const active = {
      settledOverride: "active",
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
    } as const;
    assert.deepInclude(yield* projections.getThreadShell(threadId), active);
    assert.deepInclude((yield* projections.getThreadProjection(threadId)).thread, active);

    // Undo of a settle restores the cleared Active anchor instead of stamping a new one.
    for (const restoreUnsettledAt of [DateTime.formatIso(now), null]) {
      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`settle-before-undo-${restoreUnsettledAt}`),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make(`undo-settle-${restoreUnsettledAt}`),
        threadId,
        reason: "user",
        restoreUnsettledAt,
      });
      assert.deepInclude(yield* projections.getThreadShell(threadId), {
        ...active,
        unsettledAt: restoreUnsettledAt === null ? null : now,
      });
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a user message dispatched first stays run 1 when its lineage read is slow", () => {
  const threadId = ThreadId.make("thread:dispatch-order");
  // A file database serves projection reads from a reader worker, so the lineage read a user
  // dispatch makes before taking the thread lock can yield. This gate holds it open instead.
  const lineageReadEntered = Deferred.makeUnsafe<void>();
  const lineageReadRelease = Deferred.makeUnsafe<void>();
  let gateArmed = false;
  const layerGatedLineageRead = ProviderReplayHarness.layerWithRegistry(
    { name: "dispatch-order" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      runEffectWorker: false,
      wrapProjectionStore: (store) => ({
        ...store,
        getThread: (id) => {
          if (!gateArmed || id !== threadId) return store.getThread(id);
          gateArmed = false;
          return Deferred.succeed(lineageReadEntered, undefined).pipe(
            Effect.andThen(Deferred.await(lineageReadRelease)),
            Effect.andThen(store.getThread(id)),
          );
        },
      }),
    },
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-dispatch-order"),
      threadId,
      projectId: ProjectId.make("project:dispatch-order"),
      title: "Dispatch order",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const message = (id: string, createdBy: "user" | "agent") =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text: id,
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy,
        creationSource: createdBy === "user" ? "web" : "server",
      });

    gateArmed = true;
    const user = yield* message("message:user-first", "user").pipe(Effect.forkChild);
    yield* Deferred.await(lineageReadEntered);
    // Agent messages skip the lineage read, so this one would take a free thread lock first.
    const agent = yield* message("message:agent-second", "agent").pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.succeed(lineageReadRelease, undefined);
    yield* Fiber.join(agent);
    yield* Fiber.join(user);

    const { runs } = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      runs.toSorted((left, right) => left.ordinal - right.ordinal).map((run) => run.userMessageId),
      [MessageId.make("message:user-first"), MessageId.make("message:agent-second")],
    );
  }).pipe(Effect.provide(layerGatedLineageRead));
});
