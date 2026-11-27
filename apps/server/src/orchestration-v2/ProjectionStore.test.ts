import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadShellSnapshot,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type ThreadPullRequestLink,
  isLiveSubagentShell,
  isListedThreadLineage,
} from "@ankielcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { projectThreadAwarenessV2 } from "@ankielcode/shared/agentAwareness";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  buildBoundedThreadProjection,
  encodeThreadHistoryCursor,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";

import { layerReaderDatabase, traceSqlRouting } from "../persistence/testkit/SqliteRouting.ts";

declare module "node:sqlite" {
  interface StatementSync {
    // Node 26 has this; @types/node 24 does not declare it yet.
    stat(counter: "vmStep"): number;
  }
}

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const queryTransactions: Array<string | null> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") {
          statements.push(query);
          let parent = Option.getOrUndefined(span.parent);
          while (parent?._tag === "Span" && parent.name !== "sql.transaction") {
            parent = Option.getOrUndefined(parent.parent);
          }
          queryTransactions.push(parent?._tag === "Span" ? parent.spanId : null);
        }
      };
      return span;
    },
  });
  return { statements, tracer, queryTransactions };
};

/** The shell index flags every live shell and matches its shells on the fields subscriber trims read. */
const assertShellIndexCoversShells = Effect.fnUntraced(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const snapshot = yield* store.getShellSnapshot();
  const shells = snapshot.threads;
  const index = yield* store.listActiveShellIndex();
  const { tracer, statements, queryTransactions } = traceSqlStatements();
  const activity = yield* store.getAgentAwarenessSnapshot().pipe(Effect.withTracer(tracer));
  assert.equal(activity.snapshotSequence, snapshot.snapshotSequence);
  const awareness = (thread: Parameters<typeof projectThreadAwarenessV2>[0]["thread"]) =>
    projectThreadAwarenessV2({
      environmentId: EnvironmentId.make("test"),
      project: { title: "Test" },
      thread,
    });
  assert.deepEqual(
    activity.threads.map(awareness),
    shells.filter((thread) => isListedThreadLineage(thread.lineage)).map(awareness),
  );
  assert.deepEqual(
    activity.threads.map((thread) => [thread.id, thread.projectId, thread.latestRunCompletedAt]),
    shells
      .filter((thread) => isListedThreadLineage(thread.lineage))
      .map((thread) => [thread.id, thread.projectId, thread.latestRunCompletedAt]),
  );
  assert.isFalse(statements.some((statement) => /COUNT\(\*\)|GROUP BY/i.test(statement)));
  assert.isTrue(queryTransactions.every((transaction) => transaction !== null));
  assert.equal(new Set(queryTransactions).size, 1);
  for (const shell of [...shells, ...snapshot.archivedThreads]) {
    const targeted = yield* store
      .getAgentAwarenessSnapshot(shell.id)
      .pipe(Effect.withTracer(tracer));
    assert.deepEqual(targeted.threads.map(awareness), [awareness(shell)]);
    assert.deepEqual(targeted.threads[0]?.archivedAt, shell.archivedAt);
  }
  assert.isFalse(statements.some((statement) => /COUNT\(\*\)|GROUP BY/i.test(statement)));

  const iso = (value: DateTime.Utc | null | undefined) =>
    value == null ? null : DateTime.formatIso(value);
  const trimmed = (
    row: Pick<
      ProjectionStore.ActiveShellIndexEntry,
      | "id"
      | "projectId"
      | "lineage"
      | "settledOverride"
      | "settledAt"
      | "pinnedAt"
      | "pinOrderKey"
      | "snoozedUntil"
    >,
  ) => ({
    id: row.id,
    projectId: row.projectId,
    lineage: row.lineage,
    settledOverride: row.settledOverride,
    settledAt: iso(row.settledAt),
    pinnedAt: iso(row.pinnedAt),
    pinOrderKey: row.pinOrderKey ?? null,
    snoozedUntil: iso(row.snoozedUntil),
  });
  assert.deepEqual(index.map(trimmed), shells.map(trimmed));
  shells.forEach((shell, position) => {
    if (isLiveSubagentShell(shell)) assert.isTrue(index[position]?.mayBeLive, shell.id);
  });
});

const addRolledBackRecoveryCandidate = Effect.fn("addRolledBackRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:rolled-back`);
  const runId = RunId.make(`run:${suffix}:rolled-back`);
  const rootNodeId = NodeId.make(`node:${suffix}:rolled-back`);
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${suffix}:rolled-back`),
    rootNodeId,
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Rolled-back recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-created`),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: run,
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:rolled-back`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "abandoned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-rolled-back`),
    type: "run.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: { ...run, status: "rolled_back", completedAt: now },
  });

  return threadId;
});

it.effect("routes full projection reads to readers and retains uncommitted writer state", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const parentId = yield* addRolledBackRecoveryCandidate("reader-routing");
    const parent = yield* store.getThreadProjection(parentId);
    const threadId = ThreadId.make("thread:reader-routing:fork");
    yield* store.apply({
      id: EventId.make("event:reader-routing:fork"),
      type: "thread.created",
      threadId,
      occurredAt: parent.thread.createdAt,
      payload: {
        ...parent.thread,
        id: threadId,
        forkedFrom: { type: "run", threadId: parentId, runId: parent.runs[0]!.id },
      },
    });
    const messageId = MessageId.make("message:reader-routing");
    yield* store.apply({
      id: EventId.make("event:reader-routing:message"),
      type: "message.updated",
      threadId,
      occurredAt: parent.thread.createdAt,
      payload: {
        id: messageId,
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: "Committed message",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: parent.thread.createdAt,
        updatedAt: parent.thread.createdAt,
      },
    });
    const { queries, trace } = traceSqlRouting();
    yield* store.getAgentAwarenessSnapshot().pipe(trace);
    const projection = yield* store.getThreadProjection(threadId).pipe(trace);
    assert.equal(projection.thread.id, threadId);
    assert.deepEqual(
      projection.visibleTurnItems
        .filter((row) => row.visibility === "inherited")
        .map((row) => row.sourceItemId),
      parent.turnItems.map((item) => item.id),
    );
    assert.equal(
      (yield* store.getMessagesById(threadId, [messageId]).pipe(trace)).get(messageId)?.text,
      "Committed message",
    );
    assert.isAbove(queries.length, 1);
    assert.deepEqual([...new Set(queries.map((row) => row.connection))], ["reader"]);
    const commitRequested = yield* Deferred.make<void>();
    const writer = yield* Deferred.await(commitRequested).pipe(
      Effect.andThen(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, '$.title', 'Committed title')
          WHERE thread_id = ${threadId}
        `;
            yield* sql`
          UPDATE orchestration_v2_projection_turn_items
          SET payload_json = json_set(payload_json, '$.title', 'Committed command')
          WHERE thread_id = ${parentId}
        `;
          }),
        ),
      ),
      Effect.forkChild,
    );
    let commitInjected = false;
    const duringCommit = yield* store.getThreadProjection(threadId).pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) => {
        const [query] = statement.compile();
        if (!commitInjected && query.includes("FROM orchestration_v2_projection_turn_items")) {
          commitInjected = true;
          return Deferred.succeed(commitRequested, undefined).pipe(
            Effect.andThen(Fiber.join(writer).pipe(Effect.orDie)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      }),
    );
    assert.isTrue(commitInjected);
    assert.deepEqual(duringCommit, projection);
    const afterCommit = yield* store.getThreadProjection(threadId);
    assert.equal(afterCommit.thread.title, "Committed title");
    assert.equal(
      afterCommit.visibleTurnItems.find((row) => row.visibility === "inherited")?.item.title,
      "Committed command",
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.title', 'Uncommitted title')
        WHERE thread_id = ${threadId}
      `;
        yield* sql`
          UPDATE orchestration_v2_projection_messages
          SET payload_json = json_set(payload_json, '$.text', 'Uncommitted message')
          WHERE message_id = ${messageId}
        `;
        assert.equal(
          (yield* store.getMessagesById(threadId, [messageId])).get(messageId)?.text,
          "Uncommitted message",
        );
        assert.equal(
          (yield* store.getAgentAwarenessSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          )?.title,
          "Uncommitted title",
        );
        assert.equal(
          (yield* store.getThreadProjection(threadId)).thread.title,
          "Uncommitted title",
        );
      }),
    );
  }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(layerReaderDatabase)))),
);

it.effect("record reads restrict provider histories to delivery identities", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("delivery-identities");
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    for (const suffix of ["selected", "history"]) {
      const id = ProviderThreadId.make(`provider-thread:${suffix}`);
      yield* store.apply({
        id: EventId.make(`event:delivery-identities:${suffix}`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id,
          appThreadId: threadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          status: "active",
          firstRunOrdinal: 1,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    for (const [suffix, attempt] of [
      ["selected", "current"],
      ["history", "old"],
      ["runless", null],
    ] as const) {
      yield* store.apply({
        id: EventId.make(`event:delivery-turn:${suffix}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(`turn:${suffix}`),
          providerThreadId: ProviderThreadId.make("provider-thread:selected"),
          nodeId: NodeId.make("node:delivery"),
          runAttemptId: attempt === null ? null : RunAttemptId.make(attempt),
          nativeTurnRef: null,
          ordinal: suffix === "selected" ? 1 : suffix === "history" ? 2 : 3,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
    }
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerTurns"], {
        providerTurnAttemptIds: [RunAttemptId.make("current")],
      })).providerTurns.map((turn) => turn.id),
      ["turn:selected"],
    );
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerTurns"], {
        providerTurnAttemptIds: [],
      })).providerTurns,
      [],
    );
    const selected = yield* store.getThreadRecords(threadId, ["providerThreads"], {
      providerThreadIds: [ProviderThreadId.make("provider-thread:selected")],
    });
    assert.deepEqual(
      selected.providerThreads.map((row) => row.id),
      ["provider-thread:selected"],
    );
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: [],
      })).providerThreads,
      [],
    );
    const ownerNodeId = NodeId.make("node:delivery-identities:owner");
    yield* store.apply({
      id: EventId.make("event:delivery-identities:owner-node"),
      type: "node.updated",
      threadId,
      runId: RunId.make("run:delivery-identities:rolled-back"),
      nodeId: ownerNodeId,
      driver,
      occurredAt: now,
      payload: {
        id: ownerNodeId,
        threadId,
        runId: RunId.make("run:delivery-identities:rolled-back"),
        rootNodeId: NodeId.make("node:delivery-identities:rolled-back"),
        parentNodeId: NodeId.make("node:delivery-identities:rolled-back"),
        kind: "subagent",
        status: "completed",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: now,
      },
    });
    yield* store.apply({
      id: EventId.make("event:delivery-identities:owned"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make("provider-thread:owned"),
        appThreadId: ThreadId.make("thread:delivery-identities:child"),
        driver,
        providerInstanceId,
        providerSessionId: null,
        ownerNodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        status: "idle",
        firstRunOrdinal: 2,
        createdAt: now,
        updatedAt: now,
      },
    });
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerThreads"])).providerThreads.map(
        (row) => row.id,
      ),
      ["provider-thread:history", "provider-thread:selected", "provider-thread:owned"],
    );
    // Unselected history must not be decoded, even if its payload is unreadable.
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{}'
      WHERE provider_thread_id = 'provider-thread:history'`;
    assert.lengthOf(
      (yield* store.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: [ProviderThreadId.make("provider-thread:selected")],
      })).providerThreads,
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

// One thread holds every way a run can still matter after a compaction. A run is requested at
// its ordinal in minutes and ends 30 seconds later, unless the table says otherwise.
it.effect("a compacted thread reads every run, but records and prompts only for recent ones", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("compacted");
    const created = yield* DateTime.now;
    const at = (minutes: number) => DateTime.add(created, { minutes });
    const runId = (ordinal: number) => RunId.make(`run:compacted:${ordinal}`);
    const rootNodeId = (ordinal: number) => NodeId.make(`node:compacted:${ordinal}`);
    const attemptId = (ordinal: number) => RunAttemptId.make(`attempt:compacted:${ordinal}`);
    const providerThreadId = ProviderThreadId.make("provider-thread:compacted");
    const messageId = (ordinal: number) => MessageId.make(`message:compacted:${ordinal}`);
    const item = (
      ordinal: number,
      itemOrdinal: number,
      status: "completed" | "failed" | "running",
    ) => ({
      threadId,
      runId: runId(ordinal),
      nodeId: rootNodeId(ordinal),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: itemOrdinal,
      status,
      title: null,
      startedAt: at(ordinal),
      completedAt: status === "running" ? null : at(ordinal),
      updatedAt: at(ordinal),
    });
    const compaction = (ordinal: number, status: "completed" | "failed" | "running") =>
      store.apply({
        id: EventId.make(`event:compacted:compaction-${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId: runId(ordinal),
        nodeId: rootNodeId(ordinal),
        driver,
        occurredAt: at(ordinal),
        payload: {
          ...item(ordinal, ordinal * 10 + 1, status),
          id: TurnItemId.make(`item:compacted:compaction-${ordinal}`),
          type: "compaction",
          driver,
        },
      });
    for (const [ordinal, status, endedAt, fresh] of [
      [2, "queued", null],
      // A fresh-context run starts its own conversation, so its prompt is read for the schedule check.
      [3, "completed", undefined, true],
      // A held queue ran this old run after the compactions.
      [4, "completed", at(11.5)],
      [5, "completed"],
      [6, "completed"],
      [7, "completed"],
      [8, "completed"],
      [9, "completed"],
      [10, "completed"],
      [11, "completed"],
      [12, "completed"],
      [13, "rolled_back"],
      [14, "completed"],
      [15, "running", null],
    ] as const) {
      const text = `Prompt ${ordinal}`;
      const authored = { createdBy: "user", creationSource: "web" } as const;
      const nodeId = rootNodeId(ordinal);
      const ended = endedAt === undefined ? at(ordinal + 0.5) : endedAt;
      yield* store.apply({
        id: EventId.make(`event:compacted:run-${ordinal}`),
        type: "run.created",
        threadId,
        runId: runId(ordinal),
        nodeId,
        driver,
        providerInstanceId,
        occurredAt: at(ordinal),
        payload: {
          id: runId(ordinal),
          threadId,
          ordinal,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: messageId(ordinal),
          rootNodeId: nodeId,
          activeAttemptId: attemptId(ordinal),
          status,
          requestedAt: at(ordinal),
          startedAt: status === "queued" ? null : at(ordinal),
          completedAt: ended,
          checkpointId: null,
          contextHandoffId: null,
          ...(fresh === true ? { freshContext: true } : {}),
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:attempt-${ordinal}`),
        type: "run-attempt.created",
        threadId,
        runId: runId(ordinal),
        nodeId,
        driver,
        occurredAt: at(ordinal),
        payload: {
          id: attemptId(ordinal),
          runId: runId(ordinal),
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId,
          providerThreadId,
          providerTurnId: null,
          reason: "initial",
          status: ended === null ? "running" : "completed",
          startedAt: at(ordinal),
          completedAt: ended,
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:node-${ordinal}`),
        type: "node.updated",
        threadId,
        runId: runId(ordinal),
        nodeId,
        driver,
        occurredAt: at(ordinal),
        payload: {
          id: nodeId,
          threadId,
          runId: runId(ordinal),
          rootNodeId: nodeId,
          parentNodeId: null,
          kind: "root_turn",
          status: ended === null ? "running" : "completed",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: at(ordinal),
          completedAt: ended,
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:turn-${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: at(ordinal),
        payload: {
          id: ProviderTurnId.make(`turn:compacted:${ordinal}`),
          providerThreadId,
          nodeId,
          runAttemptId: attemptId(ordinal),
          nativeTurnRef: null,
          ordinal,
          status: ended === null ? "running" : "completed",
          startedAt: at(ordinal),
          completedAt: ended,
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:message-${ordinal}`),
        type: "message.updated",
        threadId,
        runId: runId(ordinal),
        occurredAt: at(ordinal),
        payload: {
          ...authored,
          id: messageId(ordinal),
          threadId,
          runId: runId(ordinal),
          nodeId,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdAt: at(ordinal),
          updatedAt: at(ordinal),
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:prompt-${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId: runId(ordinal),
        nodeId,
        driver,
        occurredAt: at(ordinal),
        payload: {
          ...authored,
          ...item(ordinal, ordinal * 10, status === "queued" ? "running" : "completed"),
          ...(status === "queued" ? { status: "pending" as const } : {}),
          id: TurnItemId.make(`item:compacted:prompt-${ordinal}`),
          type: "user_message",
          messageId: messageId(ordinal),
          inputIntent: status === "queued" ? "queued_turn" : "turn_start",
          text,
          attachments: [],
        },
      });
    }
    // Each collection as the ordinals of the runs it was read for. Run 1 is the helper's.
    const ordinals = (ids: ReadonlyArray<string | null>) =>
      [...new Set(ids.map((id) => Number(id?.split(":").at(-1)) || 1))].toSorted((a, b) => a - b);
    const read = (keepRunIds: ReadonlyArray<RunId> = [], keepMessageId = messageId(0)) =>
      store
        .getThreadRecords(
          threadId,
          ["runs", "attempts", "nodes", "providerTurns", "messages", "turnItems"],
          {
            messageRoles: ["user"],
            omitSettledLeafNodes: true,
            sinceLastCompaction: { keepRunIds, keepMessageId },
          },
        )
        .pipe(
          Effect.map((records) => ({
            runs: records.runs.length,
            attempts: ordinals(records.attempts.map((attempt) => attempt.runId)),
            nodes: ordinals(records.nodes.map((node) => node.runId)),
            providerTurns: ordinals(records.providerTurns.map((turn) => turn.runAttemptId)),
            messages: ordinals(records.messages.map((message) => message.runId)),
            turnItems: ordinals(records.turnItems.map((row) => row.runId)),
          })),
        );
    const all = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    // Every run is read. Turn items are the failed errors of every run, and the prompts of the
    // recent runs, of the fresh-context run 3 and of the run a model switch is measured from.
    // Run 1, the helper's, holds only a command item.
    const expected = (
      recent: ReadonlyArray<number>,
      prompts: ReadonlyArray<number> = [...recent, 3],
    ) => ({
      runs: 15,
      attempts: recent,
      nodes: recent,
      providerTurns: recent,
      messages: recent,
      turnItems: [...new Set([5, ...prompts])].toSorted((a, b) => a - b),
    });

    // Run 5 failed, and nothing is compacted yet, so the whole history is current.
    yield* store.apply({
      id: EventId.make("event:compacted:error-5"),
      type: "turn-item.updated",
      threadId,
      runId: runId(5),
      nodeId: rootNodeId(5),
      driver,
      occurredAt: at(5),
      payload: {
        ...item(5, 52, "failed"),
        id: TurnItemId.make("item:compacted:error-5"),
        type: "error",
        failure: {
          class: "usage_limit",
          message: "Plan limit reached.",
          resetAt: "2099-01-01T00:00:00.000Z",
          code: "usageLimitExceeded",
          retryable: null,
        },
      },
    });
    assert.deepEqual(yield* read(), { ...expected(all), turnItems: [1, ...all] });

    // The window starts at the compaction's run. Queued run 2 and held run 4 are older but had
    // not ended by then.
    yield* compaction(7, "completed");
    assert.deepEqual(yield* read(), expected([2, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15]));

    // The latest compaction wins.
    yield* compaction(11, "completed");
    const latest = expected([2, 4, 11, 12, 13, 14, 15]);
    assert.deepEqual(yield* read(), latest);

    // A compaction that was rolled back, failed or is still running does not move the window.
    yield* compaction(13, "completed");
    yield* compaction(14, "failed");
    yield* compaction(15, "running");
    assert.deepEqual(yield* read(), latest);

    // A named run and the run that holds a re-sent message are read too.
    assert.deepEqual(
      yield* read([runId(3)], messageId(6)),
      expected([2, 3, 4, 6, 11, 12, 13, 14, 15]),
    );

    // Only an unfiltered read with runs narrows its prompts; any other read keeps its filter.
    const itemRuns = (fields: ReadonlyArray<"runs" | "turnItems">, filter: object) =>
      store
        .getThreadRecords(threadId, fields, {
          sinceLastCompaction: { keepRunIds: [], keepMessageId: messageId(0) },
          ...filter,
        })
        .pipe(Effect.map((records) => ordinals(records.turnItems.map((row) => row.runId))));
    assert.deepEqual(yield* itemRuns(["runs", "turnItems"], { turnItemRunIds: [runId(5)] }), [5]);
    assert.deepEqual(yield* itemRuns(["runs", "turnItems"], { turnItemRunIds: [] }), []);
    assert.deepEqual(yield* itemRuns(["runs", "turnItems"], { turnItemRunId: runId(5) }), [5]);
    assert.deepEqual(yield* itemRuns(["runs", "turnItems"], { runIds: [runId(15)] }), [1, ...all]);
    assert.deepEqual(yield* itemRuns(["turnItems"], {}), [1, ...all]);

    // A command also skips the node and the provider thread of each settled task. Tasks ended on
    // both sides of the compaction; one ran in the provider thread the thread's own runs use.
    const addProviderThread = (id: ProviderThreadId, appThreadId: ThreadId) =>
      store.apply({
        id: EventId.make(`event:compacted:${id}`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: created,
        payload: {
          id,
          appThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          status: "idle",
          firstRunOrdinal: null,
          createdAt: created,
          updatedAt: created,
        },
      });
    yield* addProviderThread(providerThreadId, threadId);
    for (const [name, ordinal, delivery] of [
      ["old-delivered", 5, "delivered"],
      ["old-pending", 5, "pending"],
      ["old-own-thread", 5, "delivered"],
      ["recent-delivered", 12, "delivered"],
      ["recent-pending", 12, "pending"],
    ] as const) {
      const id = NodeId.make(`node:compacted:task:${name}`);
      const taskProviderThreadId =
        name === "old-own-thread"
          ? providerThreadId
          : ProviderThreadId.make(`provider-thread:compacted:task:${name}`);
      if (taskProviderThreadId !== providerThreadId) {
        yield* addProviderThread(
          taskProviderThreadId,
          ThreadId.make(`thread:compacted:child:${name}`),
        );
      }
      const task = {
        id,
        threadId,
        runId: runId(ordinal),
        parentNodeId: rootNodeId(ordinal),
        status: "completed",
        startedAt: at(ordinal),
        completedAt: at(ordinal),
      } as const;
      yield* store.apply({
        id: EventId.make(`event:compacted:task:${name}`),
        type: "subagent.updated",
        threadId,
        runId: runId(ordinal),
        nodeId: id,
        driver,
        providerInstanceId,
        occurredAt: at(ordinal),
        payload: {
          ...task,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: taskProviderThreadId,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Do the work",
          title: name,
          model: null,
          completionDelivery: { state: delivery, observedByRunId: null },
          result: null,
          updatedAt: at(ordinal),
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:task-node:${name}`),
        type: "node.updated",
        threadId,
        runId: runId(ordinal),
        nodeId: id,
        driver,
        occurredAt: at(ordinal),
        payload: {
          ...task,
          rootNodeId: rootNodeId(ordinal),
          kind: "subagent",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
        },
      });
    }
    const names = (ids: ReadonlyArray<string>) => ids.map((id) => id.split(":").at(-1)).toSorted();
    const readWithTasks = (filter: ProjectionStore.ProjectionRecordFilter) =>
      store
        .getThreadRecords(
          threadId,
          [
            "runs",
            "attempts",
            "nodes",
            "providerThreads",
            "providerTurns",
            "messages",
            "turnItems",
          ],
          { messageRoles: ["user"], omitSettledLeafNodes: true, ...filter },
        )
        .pipe(
          Effect.map((records) => ({
            runs: names(records.runs.map((run) => run.id)),
            turnItems: names(records.turnItems.map((row) => row.id)),
            attempts: names(records.attempts.map((attempt) => attempt.id)),
            rootNodes: names(
              records.nodes.flatMap((node) => (node.kind === "root_turn" ? [node.id] : [])),
            ),
            taskNodes: names(
              records.nodes.flatMap((node) => (node.kind === "subagent" ? [node.id] : [])),
            ),
            providerThreads: names(records.providerThreads.map((thread) => thread.id)),
            providerTurns: names(records.providerTurns.map((turn) => turn.id)),
            messages: names(records.messages.map((message) => message.id)),
          })),
        );
    const window = {
      sinceLastCompaction: { keepRunIds: [runId(3)], keepMessageId: messageId(6) },
    };
    const windowed = yield* readWithTasks(window);
    const unsettled = yield* readWithTasks({ omitSettledSubagentRecords: true });
    const both = yield* readWithTasks({ ...window, omitSettledSubagentRecords: true });
    // Each filter alone keeps records the other one drops.
    assert.deepEqual(windowed.taskNodes, ["recent-delivered", "recent-pending"]);
    assert.lengthOf(windowed.providerThreads, 5);
    assert.deepEqual(unsettled.taskNodes, ["old-pending", "recent-pending"]);
    assert.deepEqual(unsettled.providerThreads, ["compacted", "old-pending", "recent-pending"]);
    assert.lengthOf(unsettled.rootNodes, all.length);
    assert.lengthOf(unsettled.runs, 15);
    // Together: every run and the provider thread the runs use stay, and the windowed records are
    // read for the recent and named runs, less each settled task's node.
    const recentRuns = ["11", "12", "13", "14", "15", "2", "3", "4", "6"];
    assert.deepEqual(both, {
      ...unsettled,
      turnItems: windowed.turnItems,
      attempts: recentRuns,
      rootNodes: recentRuns,
      taskNodes: ["recent-pending"],
      providerTurns: recentRuns,
      messages: recentRuns,
    });
    const keptUnsettled = new Map(Object.entries(unsettled));
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(windowed).map(([key, kept]) => [
          key,
          kept.filter((name) => keptUnsettled.get(key)?.includes(name)),
        ]),
      ),
      both,
    );

    // A prompt that clients do not show cannot anchor a model switch. With the recent ones, and
    // run 4's, folded into async answers, the switch is measured from run 10, so its prompt is
    // read, with run 9's from the same batch.
    const storedRuns = (yield* store.getThreadRecords(threadId, ["runs"])).runs;
    for (const ordinal of [4, 11, 12, 14, 15]) {
      yield* store.apply({
        id: EventId.make(`event:compacted:async-run-${ordinal}`),
        type: "run.updated",
        threadId,
        occurredAt: at(ordinal),
        payload: {
          ...storedRuns.find((run) => run.id === runId(ordinal))!,
          userMessageId: MessageId.make(`async-answer:${ordinal}`),
        },
      });
      yield* store.apply({
        id: EventId.make(`event:compacted:async-${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId: runId(ordinal),
        nodeId: rootNodeId(ordinal),
        driver,
        occurredAt: at(ordinal),
        payload: {
          createdBy: "user",
          creationSource: "web",
          ...item(ordinal, ordinal * 10, "completed"),
          id: TurnItemId.make(`item:compacted:prompt-${ordinal}`),
          type: "user_message",
          messageId: MessageId.make(`async-answer:${ordinal}`),
          inputIntent: "turn_start",
          text: `Answer ${ordinal}`,
          attachments: [],
        },
      });
    }
    assert.deepEqual(
      (yield* read()).turnItems,
      expected([2, 4, 11, 12, 13, 14, 15], [2, 3, 4, 9, 10, 11, 12, 13, 14, 15]).turnItems,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("SQL queue readiness skips held runs without bypassing active work", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("held-queue");
    const { runs } = yield* store.getThreadProjection(threadId);
    const run = runs[0]!;
    const now = yield* DateTime.now;
    const held = { ...run, status: "queued" as const, queueHeld: true };
    yield* store.apply({
      id: EventId.make("held-queue:held"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: held,
    });
    assert.isFalse(yield* store.canStartQueuedRun(threadId));

    const wake = { ...run, id: RunId.make("held-queue:wake"), ordinal: 2 };
    for (const status of ["running", "queued", "completed"] as const) {
      yield* store.apply({
        id: EventId.make(`held-queue:wake:${status}`),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...wake, status },
      });
      assert.equal(yield* store.canStartQueuedRun(threadId), status === "queued");
    }
    assert.deepEqual((yield* store.getThreadProjection(threadId)).runs[0], held);
  }).pipe(Effect.provide(layerTest)),
);

const addOrphanedRecoveryCandidate = Effect.fn("addOrphanedRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:orphaned`);
  const runId = RunId.make(`run:${suffix}:missing`);
  const rootNodeId = NodeId.make(`node:${suffix}:orphaned`);

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Orphaned recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:orphaned`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "orphaned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });

  return threadId;
});

const restartCancelledWorkSurvivesStaleRunUpdate = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = yield* addRolledBackRecoveryCandidate("restart-cancelled-work-stale-update");
  const run = (yield* store.getThreadProjection(threadId)).runs[0]!;
  const now = yield* DateTime.now;
  const work = [{ kind: "subagent" as const, label: "Background subagent test" }];
  yield* store.apply({
    id: EventId.make("event:restart-cancelled-work-stale-update:recorded"),
    type: "run.background-work-cancelled",
    threadId,
    runId: run.id,
    providerInstanceId,
    occurredAt: now,
    payload: { runId: run.id, restartCancelledBackgroundWork: work },
  });
  yield* store.apply({
    id: EventId.make("event:restart-cancelled-work-stale-update:completed"),
    type: "run.updated",
    threadId,
    runId: run.id,
    providerInstanceId,
    occurredAt: now,
    payload: { ...run, status: "completed", completedAt: now },
  });
  const updated = (yield* store.getThreadProjection(threadId)).runs[0];
  assert.equal(updated?.status, "completed");
  assert.deepEqual(updated?.restartCancelledBackgroundWork, work);
});

const threadWorktreePathsIncludeArchivedOnRequest = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const create = (id: string, input: { worktreePath: string | null; archived?: boolean }) => {
    const threadId = ThreadId.make(id);
    const thread = {
      createdBy: "user" as const,
      creationSource: "web" as const,
      id: threadId,
      projectId: ProjectId.make("project:worktree-paths"),
      title: `Title for ${id}`,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: input.worktreePath === null ? null : id,
      worktreePath: input.worktreePath,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: input.archived === true ? now : null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return store
      .apply({
        id: EventId.make(`event:${id}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      })
      .pipe(Effect.as(thread));
  };
  yield* create("thread:active", { worktreePath: "/worktrees/active" });
  yield* create("thread:archived", { worktreePath: "/worktrees/archived", archived: true });
  yield* create("thread:local", { worktreePath: null });
  const deleted = yield* create("thread:deleted", { worktreePath: "/worktrees/deleted" });
  yield* store.apply({
    id: EventId.make("event:thread:deleted:deleted"),
    type: "thread.deleted",
    threadId: deleted.id,
    occurredAt: now,
    payload: { ...deleted, deletedAt: now },
  });

  assert.deepEqual(yield* store.getThreadWorktreePaths(), [
    { threadId: ThreadId.make("thread:active"), worktreePath: "/worktrees/active" },
  ]);
  assert.deepEqual(yield* store.getThreadWorktreePaths({ includeArchived: true }), [
    { threadId: ThreadId.make("thread:active"), worktreePath: "/worktrees/active" },
    { threadId: ThreadId.make("thread:archived"), worktreePath: "/worktrees/archived" },
  ]);
  assert.deepEqual(
    yield* store.getThreadLinkMetadata([
      deleted.id,
      ThreadId.make("thread:active"),
      ThreadId.make("thread:archived"),
      ThreadId.make("unknown"),
    ]),
    {
      [ThreadId.make("thread:active")]: {
        title: "Title for thread:active",
        projectId: ProjectId.make("project:worktree-paths"),
      },
      [ThreadId.make("thread:archived")]: {
        title: "Title for thread:archived",
        projectId: ProjectId.make("project:worktree-paths"),
      },
    },
  );
  assert.deepEqual(
    yield* store.getThreadTitles([
      deleted.id,
      ThreadId.make("thread:active"),
      ThreadId.make("thread:archived"),
    ]),
    {
      [ThreadId.make("thread:active")]: "Title for thread:active",
      [ThreadId.make("thread:archived")]: "Title for thread:archived",
    },
  );
});

const recordsAt = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, 0, second));
const recordsThreadCreated = (threadId: ThreadId) =>
  ({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    providerInstanceId,
    occurredAt: recordsAt(0),
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:records"),
      title: threadId,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: recordsAt(0),
      updatedAt: recordsAt(0),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  }) as never;

const snapshotsReadDeletedThreadAsMissing = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make("thread:records:deleted-snapshot");
  const created: { readonly payload: object } = recordsThreadCreated(threadId);
  yield* store.apply(created as never);
  assert.equal((yield* store.getThreadSnapshot(threadId)).projection.thread.id, threadId);
  yield* store.apply({
    id: EventId.make(`event:${threadId}:deleted`),
    type: "thread.deleted",
    threadId,
    providerInstanceId,
    occurredAt: recordsAt(1),
    payload: { ...created.payload, deletedAt: recordsAt(1) },
  } as never);

  for (const read of [
    store.getThreadSnapshot(threadId),
    store.getThreadSnapshotWindow(threadId, { rowLimit: 10 }),
  ]) {
    assert.equal((yield* Effect.flip(read))._tag, "ProjectionStoreThreadNotFoundError");
  }
  // Forks of the thread still read its rows.
  assert.equal((yield* store.getThreadProjection(threadId)).thread.id, threadId);
});

it.effect("SQL list older settled threads below a cursor", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const id = (name: string) => ThreadId.make(`thread:older:${name}`);
    const at = (day: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, day));
    const createThread = (input: {
      readonly name: string;
      readonly settledDay: number | null;
      readonly project?: string;
      readonly subagent?: boolean;
      readonly archived?: boolean;
      readonly snoozedUntilDay?: number;
    }) =>
      store.apply({
        id: EventId.make(`event:older:${input.name}`),
        type: "thread.created",
        threadId: id(input.name),
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: id(input.name),
          projectId: ProjectId.make(input.project ?? "project:a"),
          title: input.name,
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: input.subagent === true ? id("b") : null,
            relationshipToParent: input.subagent === true ? "subagent" : null,
            rootThreadId: input.subagent === true ? id("b") : id(input.name),
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: input.archived === true ? now : null,
          settledOverride: input.settledDay === null ? null : "settled",
          settledAt: input.settledDay === null ? null : at(input.settledDay),
          snoozedUntil: input.snoozedUntilDay === undefined ? null : at(input.snoozedUntilDay),
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
    yield* createThread({ name: "a", settledDay: 5 });
    yield* createThread({ name: "b", settledDay: 4 });
    yield* createThread({ name: "c", settledDay: 4 });
    yield* createThread({ name: "d", settledDay: 3, project: "project:b" });
    yield* createThread({ name: "snoozed", settledDay: 2, snoozedUntilDay: 30 });
    yield* createThread({ name: "recent", settledDay: 20 });
    yield* createThread({ name: "unsettled", settledDay: null });
    yield* createThread({ name: "child", settledDay: 1, subagent: true });
    yield* createThread({ name: "archived", settledDay: 1, archived: true });

    const list = (
      before: { readonly settledAt: string; readonly threadId?: ThreadId },
      limit: number,
      projectIds?: ReadonlyArray<ProjectId>,
    ) => store.listOlderSettledThreads({ before, projectIds, limit });
    const before = { settledAt: DateTime.formatIso(at(10)) };
    const first = yield* list(before, 2);
    assert.deepEqual(first, { threadIds: [id("a"), id("b")], counts: [] });
    assert.sameDeepMembers(
      [...(yield* list(before, 0)).counts],
      [
        { projectId: ProjectId.make("project:a"), count: 4 },
        { projectId: ProjectId.make("project:b"), count: 1 },
      ],
    );
    // A cursor without an id is strict, as the snapshot's cut is: the day-4 tie is not counted.
    assert.sameDeepMembers(
      [...(yield* list({ settledAt: DateTime.formatIso(at(4)) }, 0)).counts],
      [
        { projectId: ProjectId.make("project:a"), count: 1 },
        { projectId: ProjectId.make("project:b"), count: 1 },
      ],
    );
    // The cursor is the last row: the tie on day 4 continues by id.
    const next = yield* list({ settledAt: DateTime.formatIso(at(4)), threadId: id("b") }, 10);
    assert.deepEqual(next.threadIds, [id("c"), id("d"), id("snoozed")]);
    assert.deepEqual(yield* list(before, 25, []), { threadIds: [], counts: [] });
    yield* assertShellIndexCoversShells();
    const scoped = yield* list(before, 0, [ProjectId.make("project:b")]);
    assert.deepEqual(scoped, {
      threadIds: [],
      counts: [{ projectId: ProjectId.make("project:b"), count: 1 }],
    });
  }).pipe(Effect.provide(layerTest)),
);

// regression: #25806 pending request cards outlive the history window that drops their turn
it.effect("SQL snapshot windows keep cards for requests still pending", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:pending-request-window");
    yield* store.apply({
      id: EventId.make("event:pending-request-window:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:pending-request-window"),
        title: "Pending request window",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    let ordinal = 0;
    const itemBase = (runId: RunId, nodeId: NodeId, id: string) => ({
      id: TurnItemId.make(`item:pending-request-window:${id}`),
      threadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ++ordinal,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    const request = (id: string, nodeId: NodeId, kind: "user_input" | "command") => ({
      id: RuntimeRequestId.make(`request:pending-request-window:${id}`),
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind,
      responseCapability: {
        type: "live" as const,
        providerSessionId: ProviderSessionId.make("session:pending-request-window"),
      },
      createdAt: now,
    });
    const turnCount = THREAD_HISTORY_PAGE_POLICY.maxUserTurns + 4;
    for (let turn = 1; turn <= turnCount; turn += 1) {
      const runId = RunId.make(`run:pending-request-window:${turn}`);
      const nodeId = NodeId.make(`node:pending-request-window:${turn}`);
      yield* store.apply({
        id: EventId.make(`event:pending-request-window:run:${turn}`),
        type: "run.created",
        threadId,
        runId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: turn,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:pending-request-window:${turn}`),
          rootNodeId: nodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const items: Array<OrchestrationV2TurnItem> = [
        {
          ...itemBase(runId, nodeId, `message:${turn}`),
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make(`message:pending-request-window:${turn}`),
          inputIntent: "turn_start",
          text: `Turn ${turn}`,
          attachments: [],
        },
      ];
      if (turn === 1) {
        const question = {
          id: "scope",
          header: "Scope",
          question: "Which scope?",
          options: [{ label: "All", description: "Everything" }],
        };
        items.push(
          {
            ...itemBase(runId, nodeId, "question:pending"),
            status: "running",
            type: "user_input_request",
            requestId: request("question:pending", nodeId, "user_input").id,
            questions: [question],
          },
          {
            ...itemBase(runId, nodeId, "approval:pending"),
            status: "running",
            type: "approval_request",
            requestId: request("approval:pending", nodeId, "command").id,
            requestKind: "command",
            prompt: "rm -rf build",
          },
          {
            ...itemBase(runId, nodeId, "question:resolved"),
            type: "user_input_request",
            requestId: request("question:resolved", nodeId, "user_input").id,
            questions: [question],
          },
        );
        for (const [id, kind, status] of [
          ["question:pending", "user_input", "pending"],
          ["approval:pending", "command", "pending"],
          ["question:resolved", "user_input", "resolved"],
        ] as const) {
          yield* store.apply({
            id: EventId.make(`event:pending-request-window:request:${id}`),
            type: "runtime-request.updated",
            threadId,
            nodeId,
            driver,
            occurredAt: now,
            payload: {
              ...request(id, nodeId, kind),
              status,
              resolvedAt: status === "pending" ? null : now,
            },
          });
        }
      }
      for (const item of items) {
        yield* store.apply({
          id: EventId.make(`event:pending-request-window:${item.id}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: item,
        });
      }
    }

    const pendingCardIds = [
      TurnItemId.make("item:pending-request-window:question:pending"),
      TurnItemId.make("item:pending-request-window:approval:pending"),
    ];
    const { statements, tracer } = traceSqlStatements();
    const snapshot = yield* store
      .getThreadSnapshotWindow(threadId, {
        rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
        userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
      })
      .pipe(Effect.withTracer(tracer));
    const sql = yield* SqlClient.SqlClient;
    const query = statements.find(
      (statement) =>
        statement.includes("FROM orchestration_v2_projection_runtime_requests AS request") &&
        statement.includes("SELECT item.payload_json"),
    );
    assert.isDefined(query);
    const plan = (yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${query}`,
    )).map((row) => row.detail);
    assert.include(
      plan[0],
      "SEARCH request USING INDEX orchestration_v2_projection_runtime_requests_thread_status_idx",
    );
    assert.include(
      plan[1],
      "SEARCH item USING INDEX orchestration_v2_projection_turn_items_node_ordinal_idx",
    );
    const bounded = buildBoundedThreadProjection({
      projection: snapshot.projection,
      snapshotSequence: snapshot.snapshotSequence,
    });
    assert.isTrue(bounded.hasMoreHistory);
    assert.notInclude(
      bounded.projection.turnItems.map((item) => item.id),
      TurnItemId.make("item:pending-request-window:question:resolved"),
    );
    for (const projection of [snapshot.projection, bounded.projection]) {
      const visibleIds = projection.visibleTurnItems.map((row) => row.sourceItemId);
      assert.notInclude(visibleIds, TurnItemId.make("item:pending-request-window:message:1"));
      assert.includeMembers(
        projection.turnItems.map((item) => item.id),
        pendingCardIds,
      );
      for (const id of pendingCardIds) assert.notInclude(visibleIds, id);
    }
  }).pipe(Effect.provide(layerTest)),
);

// regression: #25621 SQLite rejects statements binding more than 32,766 variables
it.effect("lists every thread in the shell snapshot past SQLite's bound variable limit", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const templateId = ThreadId.make("thread:many:00000");
    yield* store.apply({
      id: EventId.make(`event:${templateId}:created`),
      type: "thread.created",
      threadId: templateId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: templateId,
        projectId: ProjectId.make("project:many"),
        title: "Many",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: templateId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const threadCount = 32_767;
    yield* sql`
      CREATE TEMP TABLE many_threads AS
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${threadCount - 1})
      SELECT t.*, n.i AS clone_index FROM orchestration_v2_projection_threads t, n
      WHERE t.thread_id = ${templateId}
    `;
    yield* sql`
      UPDATE many_threads SET
        thread_id = printf('thread:many:%05d', clone_index),
        payload_json = json_set(
          payload_json,
          '$.id', printf('thread:many:%05d', clone_index),
          '$.lineage.rootThreadId', printf('thread:many:%05d', clone_index)
        )
    `;
    yield* sql`ALTER TABLE many_threads DROP COLUMN clone_index`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads SELECT * FROM many_threads`;

    const [unscoped, active] = yield* Effect.all([
      store.getShellSnapshot(),
      store.getShellSnapshot({ location: "active" }),
    ]);
    assert.strictEqual(unscoped.threads.length, threadCount);
    assert.strictEqual(active.threads.length, threadCount);
  }).pipe(Effect.provide(layerTest)),
);

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  // regression: #21969 keep corrupt plan JSON in the typed read error
  it.effect("returns a typed read error for malformed stored plan JSON", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* addRolledBackRecoveryCandidate("corrupt-plan");
      const planId = PlanId.make("plan:corrupt");
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, node_id, kind, status, payload_json)
        VALUES (${planId}, ${threadId}, 'node:corrupt-plan', 'proposed_plan', 'active', '{broken')`;

      const failure = yield* store
        .getPlan(threadId, planId)
        .pipe(
          Effect.flip,
          Effect.ensuring(
            Effect.orDie(
              sql`DELETE FROM orchestration_v2_projection_plans WHERE plan_id = ${planId}`,
            ),
          ),
        );
      assert.strictEqual(failure._tag, "ProjectionStoreReadError");
    }),
  );
  it.effect(
    "snapshot reads report a deleted thread as missing",
    () => snapshotsReadDeletedThreadAsMissing,
  );
  it.effect(
    "worktree path and title lookups skip deleted threads, and can include archived ones",
    () => threadWorktreePathsIncludeArchivedOnRequest,
  );

  it.effect(
    "keeps restart-cancelled work through a stale run.updated",
    () => restartCancelledWorkSurvivesStaleRunUpdate,
  );
  it.effect("records restart-cancelled work without regressing a run that completed since", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("restart-cancelled-work");
      const run = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      yield* store.apply({
        id: EventId.make("event:restart-cancelled-work:completed"),
        type: "run.updated",
        threadId,
        runId: run.id,
        providerInstanceId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      const work = [{ kind: "subagent" as const, label: "Background subagent test" }];
      yield* store.apply({
        id: EventId.make("event:restart-cancelled-work:recorded"),
        type: "run.background-work-cancelled",
        threadId,
        runId: run.id,
        providerInstanceId,
        occurredAt: now,
        payload: { runId: run.id, restartCancelledBackgroundWork: work },
      });
      const recorded = (yield* store.getThreadProjection(threadId)).runs[0];
      assert.equal(recorded?.status, "completed");
      assert.deepEqual(recorded?.restartCancelledBackgroundWork, work);
      const [recovery] = (yield* store.getThreadRecords(threadId, ["runs"], {
        runIds: [run.id],
      })).runs;
      assert.equal(recovery?.status, "completed");
      assert.deepEqual(recovery?.restartCancelledBackgroundWork, work);
    }),
  );
  it.effect("preserves stored provider usage when a terminal update omits it", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:provider-usage-reload");
      const providerThreadId = ProviderThreadId.make("provider-thread:provider-usage-reload");
      const providerTurnId = ProviderTurnId.make("provider-turn:provider-usage-reload");
      const nodeId = NodeId.make("node:provider-usage-reload");
      const initialUsage = {
        usedTokens: 12_000,
        maxTokens: 200_000,
        inputTokens: 11_000,
        outputTokens: 1_000,
        updatedAt: "2026-08-29T12:00:00.000Z",
      } as const;
      const replacementUsage = {
        usedTokens: 18_000,
        maxTokens: 200_000,
        inputTokens: 16_000,
        outputTokens: 2_000,
        updatedAt: "2026-08-29T12:00:01.000Z",
      } as const;

      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:provider-usage-reload"),
          title: "Provider usage reload",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      const providerTurn = {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:running"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: { ...providerTurn, tokenUsage: initialUsage },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:completed"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: { ...providerTurn, status: "completed", completedAt: now },
      });

      const reloaded = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(reloaded.providerTurns[0]?.tokenUsage, initialUsage);
      assert.strictEqual(reloaded.providerTurns[0]?.status, "completed");

      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:replacement"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          ...providerTurn,
          status: "completed",
          completedAt: now,
          tokenUsage: replacementUsage,
        },
      });

      const replaced = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(replaced.providerTurns[0]?.tokenUsage, replacementUsage);
    }),
  );

  it.effect("pages a whole thread without re-reading its full timeline for every page", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:paged-scrollback");
      const runId = RunId.make("run:paged-scrollback");
      const itemCount = 600;
      yield* projectionStore.apply({
        id: EventId.make("event:paged-scrollback:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:paged-scrollback"),
          title: "Paged scrollback",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${runId}, ${threadId}, 1, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:paged-scrollback",
            rootNodeId: "node:paged-scrollback",
            activeAttemptId: null,
            status: "completed",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 0; ordinal < itemCount; ordinal += 1) {
        const id = `turn-item:paged-scrollback:${ordinal}`;
        const message = ordinal % 9 === 0;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            ${message ? "user_message" : "command_execution"}, 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `item ${ordinal}`,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              ...(message
                ? {
                    type: "user_message",
                    createdBy: "user",
                    creationSource: "web",
                    messageId: `message:paged-scrollback:${ordinal}`,
                    inputIntent: "turn_start",
                    text: `Turn ${ordinal}`,
                    attachments: [],
                  }
                : { type: "command_execution", input: "echo", output: "ok", exitCode: 0 }),
            })}
          )
        `;
      }
      // An unbounded read of every turn item in the thread costs O(thread) per page, so a full
      // scrollback that repeats it on each page is quadratic in thread length.
      const wholeThreadReads = (statements: ReadonlyArray<string>) =>
        statements.filter(
          (statement) =>
            /FROM orchestration_v2_projection_turn_items(\s+AS item)?\s+WHERE (item\.)?thread_id = \?\s*(ORDER BY|$)/.test(
              statement,
            ) && !/\bLIMIT\b/.test(statement),
        ).length;
      const snapshot = yield* projectionStore.getThreadSnapshot(threadId);

      const history = traceSqlStatements();
      let cursor: string | null = encodeThreadHistoryCursor({
        snapshotSequence: snapshot.snapshotSequence,
        sourceThreadId: threadId,
        sourceItemId: "absent",
        position: itemCount,
      });
      const historyIds: Array<string> = [];
      let historyPages = 0;
      while (cursor !== null) {
        const page: OrchestrationV2ThreadHistoryPage = yield* projectionStore
          .getThreadHistoryPage(threadId, cursor)
          .pipe(Effect.withTracer(history.tracer));
        historyIds.push(...page.items.map((row) => String(row.sourceItemId)));
        historyPages += 1;
        cursor = page.hasMoreHistory ? page.nextCursor : null;
      }
      assert.strictEqual(new Set(historyIds).size, itemCount);
      assert.isAtLeast(historyPages, 4);

      const timeline = traceSqlStatements();
      const timelineIds: Array<string> = [];
      let afterPosition = -1;
      let timelinePages = 0;
      for (let hasMore = true; hasMore;) {
        const page = yield* projectionStore
          .getTimelinePage(threadId, { view: "activity", afterPosition, limit: 100 })
          .pipe(Effect.withTracer(timeline.tracer));
        timelineIds.push(...page.items.map((row) => String(row.sourceItemId)));
        afterPosition = page.items.at(-1)?.position ?? afterPosition;
        timelinePages += 1;
        hasMore = page.hasMore;
      }
      assert.strictEqual(new Set(timelineIds).size, itemCount);
      assert.isAtLeast(timelinePages, 4);

      assert.isAtMost(
        wholeThreadReads(history.statements),
        1,
        `getThreadHistoryPage read the whole thread on each of ${historyPages} pages`,
      );
      assert.isAtMost(
        wholeThreadReads(timeline.statements),
        1,
        `getTimelinePage read the whole thread on each of ${timelinePages} pages`,
      );

      // A write to the thread a fork inherits from must reach the fork's next page.
      const forkThreadId = ThreadId.make("thread:paged-scrollback:fork");
      yield* projectionStore.apply({
        id: EventId.make("event:paged-scrollback:fork"),
        type: "thread.created",
        threadId: forkThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: forkThreadId,
          projectId: ProjectId.make("project:paged-scrollback"),
          title: "Paged scrollback fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: threadId,
            relationshipToParent: "fork",
            rootThreadId: threadId,
          },
          forkedFrom: { type: "run", threadId, runId },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const forkPage = () =>
        projectionStore.getTimelinePage(forkThreadId, { view: "activity", limit: 1 });
      const forkTotal = (yield* forkPage()).totalItems;
      assert.strictEqual((yield* forkPage()).totalItems, forkTotal);
      yield* projectionStore.apply({
        id: EventId.make("event:paged-scrollback:late-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("turn-item:paged-scrollback:late"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: itemCount,
          status: "completed",
          title: "late",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
          input: "echo",
        },
      });
      assert.strictEqual((yield* forkPage()).totalItems, forkTotal + 1);

      // Another store instance's write reaches this one only through the committed thread event.
      const directId = "turn-item:paged-scrollback:direct";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${directId}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${itemCount + 1},
          'command_execution', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id: directId,
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: itemCount + 1,
            status: "completed",
            title: "direct",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "command_execution",
            input: "echo",
          })}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          'event:paged-scrollback:direct', 'thread', ${threadId}, 1,
          'turn-item.updated', ${nowIso}, 'user', '{}', '{}', 2
        )
      `;
      assert.strictEqual((yield* forkPage()).totalItems, forkTotal + 2);

      // An agent started this thread, so the snapshot folds no work. Its cursor then names a
      // command that an older page folds into the run's one work group.
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = CASE WHEN ordinal = 0 THEN type ELSE 'assistant_message' END,
          payload_json = CASE
            WHEN ordinal = 0 THEN json_set(payload_json, '$.createdBy', 'agent')
            ELSE json_set(payload_json, '$.type', 'assistant_message',
              '$.messageId', turn_item_id, '$.streaming', json('false'))
          END
        WHERE thread_id = ${threadId} AND type = 'user_message'
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          'event:paged-scrollback:agent-started', 'thread', ${threadId}, 2,
          'turn-item.updated', ${nowIso}, 'user', '{}', '{}', 2
        )
      `;
      const window = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
        userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        deferWork: true,
      });
      const bounded = buildBoundedThreadProjection({
        projection: window.projection,
        snapshotSequence: window.snapshotSequence,
      });
      const loaded = [bounded.projection.visibleTurnItems];
      let earlier = bounded.hasMoreHistory ? bounded.historyCursor : null;
      while (earlier !== null) {
        assert.isBelow(loaded.length, 20);
        const page: OrchestrationV2ThreadHistoryPage = yield* projectionStore.getThreadHistoryPage(
          threadId,
          earlier,
          undefined,
          false,
          "deferred",
        );
        loaded.unshift(page.items);
        earlier = page.hasMoreHistory ? page.nextCursor : null;
      }
      const held = loaded.flat();
      const heldOrdinals = held.map((row) => row.item.ordinal);
      assert.deepEqual(
        heldOrdinals,
        [...new Set(heldOrdinals)].toSorted((left, right) => left - right),
      );
      const folded = held.find((row) => row.item.deferredWork !== undefined)?.item;
      assert.isAbove(folded?.deferredWork?.itemCount ?? 0, 150);
      const everyRow = yield* projectionStore.getTimelinePage(threadId, {
        view: "activity",
        limit: itemCount + 2,
      });
      // Every row is on the client, or is work that the folded row stands for.
      assert.deepEqual(
        everyRow.items
          .filter(
            ({ item }) =>
              !heldOrdinals.includes(item.ordinal) &&
              !(
                item.type === "command_execution" &&
                folded?.deferredWork !== undefined &&
                item.ordinal > folded.ordinal &&
                item.ordinal <= folded.deferredWork.lastOrdinal
              ),
          )
          .map(({ item }) => item.ordinal),
        [],
      );
    }),
  );

  it.effect("a page read from a window equals the page read from the full index", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      // Seeded, so every run builds the same threads.
      let seed = 0x5eed;
      const random = () => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed / 2 ** 32;
      };
      const chance = (probability: number) => random() < probability;
      const spans: Array<string> = [];
      const tracer = Tracer.make({
        span(options) {
          spans.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      });
      let windowReads = 0;
      let foldedGroups = 0;

      for (let round = 0; round < 5; round += 1) {
        const threadId = ThreadId.make(`thread:window-equivalence:${round}`);
        const created = {
          id: EventId.make(`event:window-equivalence:${round}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:window-equivalence"),
            title: "Window equivalence",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        } satisfies Parameters<typeof projectionStore.apply>[0];
        yield* projectionStore.apply(created);
        // The last thread puts three things below a window: a user turn under a hidden queued
        // turn, the start of a long run that folds, and the start of the run before it, which
        // has later rows among the first rows of the long run.
        const windowEdges = round === 4;
        // One run of each kind in a random order, then an active run. Every other thread has
        // one user turn and then only wake turns.
        // The fourth thread is a turn, many rolled-back rows, a late notification of that turn,
        // then 149 one-row turns. A page stops at that notification only if it counts as a turn.
        const kinds =
          round === 3
            ? ["rolled back", "late wake", ...Array.from({ length: 149 }, () => "one row")]
            : windowEdges
              ? ["short", "cancelled queued turn", "folds work", "long fold", "stopped"]
              : [
                  "rolled back",
                  "cancelled queued turn",
                  "held queued turn",
                  "replaced attempt",
                  "stopped",
                  "stopped",
                  "folds work",
                  "folds work",
                  "short",
                  "short",
                  "short",
                ]
                  .map((kind) => ({ kind, order: random() }))
                  .toSorted((left, right) => left.order - right.order)
                  .map(({ kind }) => kind);
        const agentDriven = round === 1;
        const runs: Array<unknown> = [];
        const attempts: Array<unknown> = [];
        const items: Array<unknown> = [];
        const tiedWithHidden: Array<TurnItemId> = [];
        const pageEnds: Array<string> = [];
        let ordinal = 0;
        for (const [index, kind] of [...kinds, "active"].entries()) {
          const run = index + 1;
          const runId = `run:window-equivalence:${round}:${run}`;
          const nodeId = `node:window-equivalence:${round}:${run}`;
          const status =
            kind === "active"
              ? "running"
              : kind === "rolled back"
                ? "rolled_back"
                : kind === "cancelled queued turn"
                  ? "cancelled"
                  : kind === "held queued turn"
                    ? "queued"
                    : kind === "short" && chance(0.5)
                      ? "interrupted"
                      : "completed";
          runs.push({
            id: runId,
            threadId,
            ordinal: run,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: `message:window-equivalence:${round}:${run}`,
            rootNodeId: nodeId,
            activeAttemptId: null,
            status,
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          });
          attempts.push({
            id: `attempt:window-equivalence:${round}:${run}`,
            runId,
            attemptOrdinal: 1,
            rootNodeId: nodeId,
            providerInstanceId,
            providerThreadId: "provider-thread:window-equivalence",
            providerTurnId: null,
            reason: "initial",
            status: kind === "replaced attempt" || chance(0.2) ? "superseded" : "completed",
            startedAt: nowIso,
            completedAt: nowIso,
          });
          // The first row after a rolled-back run shares the ordinal of that run's last row.
          let tie = kinds[index - 1] === "rolled back";
          if (tie)
            tiedWithHidden.push(
              TurnItemId.make(`turn-item:window-equivalence:${round}:${items.length}`),
            );
          const add = (type: string, fields: Record<string, unknown> = {}) => {
            if (ordinal === 0 || !(tie || chance(0.04))) ordinal += 1;
            tie = false;
            items.push({
              id: `turn-item:window-equivalence:${round}:${items.length}`,
              threadId,
              runId,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type,
              ...fields,
            });
          };
          const userMessage = (inputIntent: string) =>
            add("user_message", {
              createdBy: "user",
              creationSource: "web",
              messageId: `message:window-equivalence:${round}:${items.length}`,
              inputIntent,
              text: "Turn",
              attachments: [],
            });
          const notification = () =>
            add("notification", {
              source: { kind: "system" },
              outcome: "completed",
              summary: "Wake",
            });
          const wakes =
            kind === "one row"
              ? run % 10 !== 0
              : windowEdges
                ? ["folds work", "long fold", "stopped"].includes(kind)
                : kind !== "late wake" && (agentDriven ? run > 1 : chance(0.2));
          if (round === 3 && kind === "active")
            pageEnds.push(`turn-item:window-equivalence:${round}:${items.length}`);
          if (wakes) notification();
          else
            userMessage(
              kind === "cancelled queued turn" || kind === "held queued turn"
                ? "queued_turn"
                : "turn_start",
            );
          // A stopped run never folds, so it is long enough for page ends to fall inside it.
          const work =
            kind === "late wake"
              ? 420 + Math.floor(random() * 40)
              : kind === "stopped"
                ? 320 + Math.floor(random() * 60)
                : kind === "folds work"
                  ? 155 + Math.floor(random() * 60)
                  : kind === "long fold"
                    ? 300
                    : kind === "one row"
                      ? 0
                      : Math.floor(random() * 30);
          for (let row = 0; row < work; row += 1) {
            // The first rows of a long fold and the work of a late wake belong to the run before.
            const owner =
              (kind === "long fold" && row < 140) || kind === "late wake"
                ? {
                    runId: `run:window-equivalence:${round}:${run - 1}`,
                    nodeId: `node:window-equivalence:${round}:${run - 1}`,
                  }
                : {};
            if (chance(0.5))
              add("command_execution", { input: "echo", output: "ok", exitCode: 0, ...owner });
            else add("reasoning", { text: "", streaming: false, ...owner });
            // A reply deep in a stopped run: a page that ends on it has enough work below it
            // to fold, and only the stop request above it says that it does not.
            const reply = kind === "stopped" && row === 200;
            if (reply) pageEnds.push(`turn-item:window-equivalence:${round}:${items.length}`);
            // With these replies, the part of a long fold in one window is too small to fold,
            // and a shown row lies below the notification of a late wake.
            const replies = kind === "long fold" || kind === "late wake";
            if (reply || (replies && row % 5 === 0) || chance(0.02))
              add("assistant_message", {
                messageId: `message:window-equivalence:${round}:${items.length}`,
                text: "Reply",
                streaming: false,
              });
            // A late wake has no other input above its turn start.
            if (chance(0.01) && kind !== "late wake") notification();
            if (chance(0.004) && !agentDriven && !windowEdges && kind !== "late wake")
              userMessage("steer");
          }
          if (kind === "late wake") notification();
          if (kind === "stopped") add("run_interrupt_request", { message: "Stop" });
          if (kind === "replaced attempt" || (kind === "stopped" && chance(0.5)))
            add("run_interrupt_result", { message: "Stopped" });
          if (kind === "short" && chance(0.3))
            add("error", {
              status: "failed",
              failure: { class: "unknown", message: "Failed", code: null, retryable: false },
            });
        }
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          )
          SELECT json_extract(value, '$.id'), ${threadId}, json_extract(value, '$.ordinal'), 'codex',
            NULL, json_extract(value, '$.status'), ${nowIso}, ${nowIso}, value
          FROM json_each(${encodeUnknownJsonString(runs)})`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_run_attempts (
            attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
            provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
          )
          SELECT json_extract(value, '$.id'), ${threadId}, json_extract(value, '$.runId'), 1,
            json_extract(value, '$.rootNodeId'), ${providerInstanceId}, ${providerInstanceId},
            json_extract(value, '$.providerThreadId'), NULL, json_extract(value, '$.status'), value
          FROM json_each(${encodeUnknownJsonString(attempts)})`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          )
          SELECT json_extract(value, '$.id'), ${threadId}, json_extract(value, '$.runId'),
            json_extract(value, '$.nodeId'), NULL, NULL, NULL, json_extract(value, '$.ordinal'),
            json_extract(value, '$.type'), json_extract(value, '$.status'), ${nowIso}, value
          FROM json_each(${encodeUnknownJsonString(items)})`;

        // Applying an event drops the thread's cached index, as each event of a run does, so
        // each of these reads a window.
        const requests: Array<{
          readonly read: Effect.Effect<unknown, ProjectionStore.ProjectionStoreV2Error>;
          readonly page: unknown;
        }> = [];
        const windowed = <A>(read: Effect.Effect<A, ProjectionStore.ProjectionStoreV2Error>) =>
          Effect.gen(function* () {
            yield* projectionStore.apply(created);
            spans.length = 0;
            const page = yield* read.pipe(Effect.withTracer(tracer));
            if (spans.includes("ProjectionStore.readTimelineWindow")) windowReads += 1;
            requests.push({ read, page });
            return page;
          });
        const history = (
          cursor: string,
          throughEntryId?: string,
          conversationOnly?: boolean,
          workMode?: "deferred" | "work",
        ) =>
          projectionStore.getThreadHistoryPage(
            threadId,
            cursor,
            throughEntryId,
            conversationOnly,
            workMode,
          );
        const timeline = (options: ProjectionStore.ProjectionTimelinePageOptions) =>
          projectionStore.getTimelinePage(threadId, options);

        const { totalItems } = yield* windowed(timeline({ limit: 0 }));
        const newest = (yield* windowed(
          timeline({ view: "activity", afterPosition: totalItems - 2, limit: 1 }),
        )).items[0]!;
        const firstCursor = encodeThreadHistoryCursor({
          snapshotSequence: 0,
          sourceThreadId: threadId,
          sourceItemId: newest.sourceItemId,
          position: newest.position,
        });
        const groups = new Map<string, string>();
        for (const [conversationOnly, workMode] of [
          [false, "deferred"],
          [false, undefined],
          [true, undefined],
        ] as const) {
          for (let cursor: string | null = firstCursor; cursor !== null;) {
            const page: OrchestrationV2ThreadHistoryPage = yield* windowed(
              history(cursor, undefined, conversationOnly, workMode),
            );
            for (const { item } of page.items)
              if (item.deferredWork !== undefined) groups.set(item.id, item.deferredWork.cursor);
            cursor = page.nextCursor;
          }
        }
        for (const sourceItemId of pageEnds) {
          const cursor = encodeThreadHistoryCursor({
            snapshotSequence: 0,
            sourceThreadId: threadId,
            sourceItemId,
            position: 0,
          });
          yield* windowed(history(cursor, undefined, false, "deferred"));
        }
        foldedGroups += groups.size;
        for (const [anchorId, groupCursor] of groups) {
          for (let cursor: string | null = groupCursor; cursor !== null;)
            cursor = (yield* windowed(history(cursor, anchorId, false, "work"))).nextCursor;
        }
        for (const view of ["messages", "activity"] as const) {
          for (const afterPosition of [-1, Math.floor(totalItems / 3), totalItems - 5])
            yield* windowed(timeline({ view, afterPosition, limit: 20 }));
          for (const beforePosition of [
            Number.POSITIVE_INFINITY,
            Math.floor(totalItems / 3),
            totalItems - 5,
          ])
            yield* windowed(timeline({ view, beforePosition, limit: 20 }));
          yield* windowed(timeline({ view, afterPosition: 3, beforePosition: 40, limit: 20 }));
        }
        for (const itemId of [newest.sourceItemId, ...tiedWithHidden])
          yield* windowed(timeline({ itemId, limit: 1 }));

        // An attachment lookup and a jump to an entry read the full index and leave it cached,
        // so the same requests now come from it.
        yield* timeline({ attachmentId: "absent", limit: 1 });
        yield* history(firstCursor, "absent", false, "deferred");
        spans.length = 0;
        for (const { read, page } of requests)
          assert.deepEqual(yield* read.pipe(Effect.withTracer(tracer)), page);
        assert.notInclude(spans, "ProjectionStore.readTimelineWindow");
      }
      assert.isAtLeast(foldedGroups, 2);
      assert.isAbove(windowReads, 60);
    }),
  );

  // regression: #17141 shell snapshot decoding blocked other database reads
  it.effect("reads the shell snapshot first and decodes it in a separate step", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const createThread = (threadId: ThreadId) =>
        projectionStore.apply({
          id: EventId.make(`event:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:shell-read"),
            title: "Shell read",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
      const readThreadId = ThreadId.make("thread:shell-read:before");
      const laterThreadId = ThreadId.make("thread:shell-read:after");
      const shellIds = (snapshot: OrchestrationV2ThreadShellSnapshot) =>
        snapshot.threads
          .map((thread) => thread.id)
          .filter((id) => id === readThreadId || id === laterThreadId);

      yield* createThread(readThreadId);
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.linkedPullRequest', json(${JSON.stringify({
          projectId: "project:shell-read",
          repository: "acme/project",
          number: 42,
          url: "https://github.com/acme/project/pull/42",
        })})) WHERE thread_id = ${readThreadId}`;
      const [latest] = yield* sql<{ readonly sequence: number }>`
        SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events`;
      const trace = traceSqlStatements();
      const discovery = yield* projectionStore
        .getPullRequestSnapshot({})
        .pipe(Effect.withTracer(trace.tracer));
      assert.deepEqual(
        discovery.threads
          .map((thread) => thread.id)
          .filter((id) => id === readThreadId || id === laterThreadId),
        [readThreadId],
      );
      assert.strictEqual(discovery.snapshotSequence, latest?.sequence);
      assert.strictEqual(trace.queryTransactions.length, 2);
      assert.isNotNull(trace.queryTransactions[0]);
      assert.strictEqual(new Set(trace.queryTransactions).size, 1);
      assert.isFalse(
        trace.statements.some((query) =>
          /orchestration_v2_projection_(runs|messages|turn_items|provider_threads)/.test(query),
        ),
      );
      const fullShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === readThreadId,
      )!;
      const metadata = discovery.threads.find((thread) => thread.id === readThreadId)!;
      for (const key of Object.keys(metadata) as Array<keyof typeof metadata>) {
        assert.deepEqual(metadata[key], fullShell[key]);
      }
      const narrow = yield* projectionStore.getPullRequestSnapshot({ threadId: readThreadId });
      assert.deepEqual(
        narrow.threads,
        discovery.threads.filter((thread) => thread.id === readThreadId),
      );
      const settledPayload = (settledAt: string | null, archivedAt: string | null) => sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.settledAt', ${settledAt}, '$.archivedAt', ${archivedAt}),
          archived_at = ${archivedAt}
        WHERE thread_id = ${readThreadId}
      `;
      yield* settledPayload(DateTime.formatIso(now), null);
      assert.isFalse(
        (yield* projectionStore.getPullRequestSnapshot({ unsettledOnly: true })).threads.some(
          (thread) => thread.id === readThreadId,
        ),
      );
      assert.strictEqual(
        (yield* projectionStore.getPullRequestSnapshot({ threadId: readThreadId })).threads.length,
        1,
      );
      yield* settledPayload(null, DateTime.formatIso(now));
      assert.isFalse(
        (yield* projectionStore.getPullRequestSnapshot({})).threads.some(
          (thread) => thread.id === readThreadId,
        ),
      );
      assert.strictEqual(
        (yield* projectionStore.getPullRequestSnapshot({ threadId: readThreadId })).threads.length,
        1,
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-11-03T00:00:00.000Z' WHERE thread_id = ${readThreadId}`;
      assert.deepEqual(
        (yield* projectionStore.getPullRequestSnapshot({ threadId: readThreadId })).threads,
        [],
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${readThreadId}`;
      yield* settledPayload(null, null);
      const decode = yield* sql.withTransaction(projectionStore.readShellSnapshot());
      yield* createThread(laterThreadId);

      assert.deepEqual(shellIds(yield* decode), [readThreadId]);
      assert.sameMembers(shellIds(yield* projectionStore.getShellSnapshot()), [
        readThreadId,
        laterThreadId,
      ]);

      const [stored] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${laterThreadId}
      `;
      const setPayload = (payload: string) =>
        sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload}
          WHERE thread_id = ${laterThreadId}`;
      yield* setPayload("{}");
      const failure = yield* sql
        .withTransaction(projectionStore.readShellSnapshot())
        .pipe(
          Effect.flatMap(Effect.flip),
          Effect.ensuring(Effect.orDie(setPayload(stored!.payload_json))),
        );
      assert.strictEqual(failure._tag, "ProjectionStoreReadError");
    }),
  );

  it.effect("preserves delegated completion ownership across stale run and task updates", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const later = DateTime.add(now, { seconds: 1 });
      const threadId = ThreadId.make("thread:projection-delegated-completion");
      const projectId = ProjectId.make("project:projection-delegated-completion");
      const runId = RunId.make("run:projection-delegated-completion");
      const rootNodeId = NodeId.make("node:projection-delegated-completion-root");
      const taskId = NodeId.make("node:projection-delegated-completion-task");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Delegated completion projection",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-delegated-completion"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
        delegatedCompletion: {
          disposition: "stopped" as const,
          nextGeneration: 2,
          delivery: null,
        },
      };
      const task = {
        id: taskId,
        threadId,
        runId,
        parentNodeId: rootNodeId,
        origin: "app_owned" as const,
        createdBy: "agent" as const,
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Inspect the stop barrier.",
        title: null,
        model: null,
        completionWake: "always" as const,
        completionDelivery: {
          state: "disposed" as const,
          observedByRunId: null,
        },
        status: "running" as const,
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: run,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: task,
      });

      const output = { value: { verdict: "merge" }, submittedAt: "2026-11-11T00:00:00.000Z" };
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:output"),
        type: "run.output-submitted",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: { runId, output },
      });

      // Lifecycle writers hold the run as it was when the turn started.
      const { delegatedCompletion: _delegatedCompletion, ...staleRun } = run;
      const { completionDelivery: _completionDelivery, ...staleTask } = task;
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: later,
        payload: {
          ...staleRun,
          // An earlier submission, read before the latest one landed.
          output: { value: { verdict: "fix-first" }, submittedAt: "2026-11-10T00:00:00.000Z" },
          status: "interrupted",
          completedAt: later,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: later,
        payload: {
          ...staleTask,
          status: "interrupted",
          completedAt: later,
          updatedAt: later,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(projection.runs[0]?.delegatedCompletion, run.delegatedCompletion);
      assert.deepEqual(projection.runs[0]?.output, output);
      assert.deepEqual(projection.subagents[0]?.completionDelivery, task.completionDelivery);
      assert.deepEqual(
        (yield* projectionStore.getThreadRecords(threadId, ["subagents"], {
          omitSettledSubagents: true,
        })).subagents,
        [],
      );
    }),
  );

  it.effect("selects only threads with runtime state that needs recovery", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const settledThreadId = ThreadId.make("thread:recovery-candidates:settled");
      const runningThreadId = ThreadId.make("thread:recovery-candidates:running");
      const memberThreadId = ThreadId.make("thread:recovery-candidates:member");
      const childThreadId = ThreadId.make("thread:recovery-candidates:child");
      const rolledBackThreadId = yield* addRolledBackRecoveryCandidate("recovery-candidates");
      const orphanedThreadId = yield* addOrphanedRecoveryCandidate("recovery-candidates");
      const projectId = ProjectId.make("project:recovery-candidates");
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Recovery candidate",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });

      for (const threadId of [settledThreadId, runningThreadId, memberThreadId, childThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId),
        });
      }

      const runId = RunId.make("run:recovery-candidates:running");
      const rootNodeId = NodeId.make("node:recovery-candidates:running");
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:run-created"),
        type: "run.created",
        threadId: runningThreadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: runningThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:recovery-candidates:running"),
          rootNodeId,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const memberId = NodeId.make("node:recovery-candidates:member");
      const childRootNodeId = NodeId.make("node:recovery-candidates:child-root");
      const nativeTaskRef = { driver, nativeId: "workflow:agent:1", strength: "strong" as const };
      const memberNode = {
        id: memberId,
        threadId: memberThreadId,
        runId: null,
        parentNodeId: NodeId.make("node:recovery-candidates:coordinator-root"),
        rootNodeId: NodeId.make("node:recovery-candidates:coordinator-root"),
        kind: "subagent" as const,
        status: "running" as const,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:member"),
        type: "subagent.updated",
        threadId: memberThreadId,
        nodeId: memberId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: memberId,
          threadId: memberThreadId,
          runId: null,
          parentNodeId: memberNode.parentNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef,
          prompt: "Do the work",
          title: "Member",
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
      for (const [threadId, node] of [
        [memberThreadId, memberNode],
        [
          childThreadId,
          {
            ...memberNode,
            id: childRootNodeId,
            threadId: childThreadId,
            parentNodeId: null,
            rootNodeId: childRootNodeId,
            kind: "root_turn" as const,
          },
        ],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:node:${node.id}`),
          type: "node.updated",
          threadId,
          nodeId: node.id,
          driver,
          occurredAt: now,
          payload: node,
        });
      }

      const recoveryThreadIds = yield* projectionStore.getRecoveryThreadIds("runtime");
      assert.include(recoveryThreadIds, runningThreadId);
      assert.include(recoveryThreadIds, orphanedThreadId);
      assert.include(recoveryThreadIds, memberThreadId);
      assert.include(recoveryThreadIds, childThreadId);
      assert.notInclude(recoveryThreadIds, settledThreadId);
      assert.notInclude(recoveryThreadIds, rolledBackThreadId);
      const memberRecovery = yield* projectionStore.getRuntimeRecoveryProjection(memberThreadId);
      const childRecovery = yield* projectionStore.getRuntimeRecoveryProjection(childThreadId);
      assert.deepEqual(
        memberRecovery.subagents.map((subagent) => subagent.id),
        [memberId],
      );
      assert.deepEqual(
        memberRecovery.nodes.map((node) => node.id),
        [memberId],
      );
      assert.deepEqual(
        childRecovery.nodes.map((node) => node.id),
        [childRootNodeId],
      );
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:member-cancelled"),
        type: "subagent.updated",
        threadId: memberThreadId,
        nodeId: memberId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...memberRecovery.subagents[0]!,
          status: "cancelled",
          completedAt: now,
          updatedAt: now,
        },
      });
      assert.include(yield* projectionStore.getRecoveryThreadIds("runtime"), childThreadId);
    }),
  );

  it.effect("selects the latest waiting secret only from active runs", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const suffix = "shell-pending-secret";
      const threadId = yield* addRolledBackRecoveryCandidate(suffix);
      const runId = RunId.make(`run:${suffix}:rolled-back`);
      const nodeId = NodeId.make(`node:${suffix}:rolled-back`);
      const now = yield* DateTime.now;
      const addSecret = (id: string, ordinal: number, status: "waiting" | "completed") =>
        projectionStore.apply({
          id: EventId.make(`event:${id}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(id),
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status,
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: DateTime.add(now, { seconds: ordinal }),
            type: "secret_request",
            label: "Test credential",
            reason: "Test pending input",
            secretStatus: status === "waiting" ? "pending" : "saved",
          },
        });
      yield* addSecret("secret:a", 2, "waiting");
      yield* addSecret("secret:b", 3, "waiting");
      yield* addSecret("secret:c", 4, "completed");

      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET status = 'running', payload_json = json_set(payload_json, '$.status', 'running')
        WHERE run_id = ${runId}
      `;
      yield* assertShellIndexCoversShells();
      const secretOnlyShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      const secretOnlyProjection = yield* projectionStore.getThreadProjection(threadId);
      for (const shell of [
        secretOnlyShell,
        ProjectionStore.threadShellFromProjection(secretOnlyProjection),
      ]) {
        assert.equal(shell?.pendingRuntimeRequest?.id, "secret:b");
        assert.isTrue(shell?.pendingRuntimeRequest?.blocking);
        assert.isTrue(shell?.pendingRuntimeRequest?.userOnly);
      }

      const requestId = RuntimeRequestId.make(`request:${suffix}:async`);
      yield* projectionStore.apply({
        id: EventId.make(`event:${suffix}:async`),
        type: "runtime-request.updated",
        threadId,
        runId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: DateTime.subtract(now, { seconds: 1 }),
          resolvedAt: null,
        },
      });

      for (const responseCapability of [
        { type: "live", providerSessionId: ProviderSessionId.make("session:pending-secret") },
        { type: "message" },
      ] as const) {
        for (const fresh of [true, false]) {
          yield* projectionStore.apply({
            id: EventId.make("event:" + suffix + ":fresh-" + fresh),
            type: "runtime-request.updated",
            threadId,
            runId,
            nodeId,
            driver,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability,
              createdAt: fresh
                ? DateTime.add(now, { seconds: 5 })
                : DateTime.subtract(now, { seconds: 1 }),
              resolvedAt: null,
            },
          });
          for (const shell of [
            (yield* projectionStore.getShellSnapshot()).threads.find(
              (thread) => thread.id === threadId,
            ),
            ProjectionStore.threadShellFromProjection(
              yield* projectionStore.getThreadProjection(threadId),
            ),
          ]) {
            assert.equal(shell?.pendingRuntimeRequest?.id, fresh ? requestId : "secret:b");
          }
        }
      }

      for (const status of [
        "preparing",
        "starting",
        "running",
        "waiting",
        "completed",
        "rolled_back",
      ]) {
        yield* sql`
          UPDATE orchestration_v2_projection_runs
          SET status = ${status}, payload_json = json_set(payload_json, '$.status', ${status})
          WHERE run_id = ${runId}
        `;
        const shell = yield* projectionStore.getShellSnapshot();
        const thread = shell.threads.find((candidate) => candidate.id === threadId);
        assert.isDefined(thread);
        const projection = yield* projectionStore.getThreadProjection(threadId);
        const memoryShell = ProjectionStore.threadShellFromProjection(projection);
        const terminal = status === "completed" || status === "rolled_back";
        assert.deepEqual(
          [thread?.pendingRuntimeRequest?.id, memoryShell.pendingRuntimeRequest?.id],
          terminal ? [requestId, requestId] : ["secret:b", "secret:b"],
        );
        assert.deepEqual(
          [thread?.pendingRuntimeRequest?.blocking, memoryShell.pendingRuntimeRequest?.blocking],
          terminal ? [false, false] : [true, true],
        );
        assert.deepEqual(
          [thread?.pendingRuntimeRequest?.userOnly, memoryShell.pendingRuntimeRequest?.userOnly],
          terminal ? [undefined, undefined] : [true, true],
        );
      }
    }),
  );

  it.effect("counts history inherited by fork shells, but not by side chats", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-imported-fork-shell");
      const sourceThreadId = ThreadId.make("thread:projection-imported-fork-shell:source");
      const targetThreadId = ThreadId.make("thread:projection-imported-fork-shell:target");
      const sideChatThreadId = ThreadId.make("thread:projection-imported-fork-shell:side-chat");
      const sourceRunId = RunId.make("run:projection-imported-fork-shell:source");
      const rootNodeId = NodeId.make("node:projection-imported-fork-shell:source");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "system",
          creationSource: "server",
          id: sourceThreadId,
          projectId,
          title: "Imported fork source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          historyOrigin: "v1_import",
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      for (const [threadId, sideChat] of [
        [targetThreadId, false],
        [sideChatThreadId, true],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-imported-fork-shell:created:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId,
            title: "Imported fork target",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: sourceThreadId,
              relationshipToParent: "fork",
              rootThreadId: sourceThreadId,
              sideChat,
            },
            forkedFrom: {
              type: "run",
              threadId: sourceThreadId,
              runId: sourceRunId,
            },
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
      }
      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:source-run"),
        type: "run.created",
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRunId,
          threadId: sourceThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-imported-fork-shell:run"),
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const applyAssistantItem = (suffix: string, runId: RunId | null, ordinal: number) =>
        projectionStore.apply({
          id: EventId.make(`event:projection-imported-fork-shell:item:${suffix}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          ...(runId === null ? {} : { runId }),
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:projection-imported-fork-shell:${suffix}`),
            threadId: sourceThreadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(`message:projection-imported-fork-shell:${suffix}`),
            text: suffix,
            streaming: false,
          },
        });

      yield* applyAssistantItem("imported-one", null, 1);
      yield* applyAssistantItem("imported-two", null, 2);
      yield* applyAssistantItem("native-run", sourceRunId, 3);

      const shell = yield* projectionStore.getShellSnapshot();
      const targetShell = shell.threads.find((thread) => thread.id === targetThreadId);
      const targetProjection = yield* projectionStore.getThreadProjection(targetThreadId);

      assert.isDefined(targetShell);
      assert.equal(targetShell.itemCount, 0);
      assert.equal(targetShell.visibleItemCount, 4);
      assert.equal(targetProjection.visibleTurnItems.length, 4);

      const sideChatShell = shell.threads.find((thread) => thread.id === sideChatThreadId);
      assert.equal(sideChatShell?.visibleItemCount, 0);
      const sideChatProjection = yield* projectionStore.getThreadProjection(sideChatThreadId);
      assert.deepEqual(sideChatProjection.visibleTurnItems, []);
      const sideChatTimeline = yield* projectionStore.getTimelinePage(sideChatThreadId, {
        limit: 20,
        view: "activity",
      });
      assert.equal(sideChatTimeline.totalItems, 0);
    }),
  );

  it.effect("removes rolled back runs from the active visible projection", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:projection-rollback-prune");
      const projectId = ProjectId.make("project:projection-rollback-prune");
      const runId = RunId.make("run:projection-rollback-prune");
      const attemptId = RunAttemptId.make("attempt:projection-rollback-prune");
      const rootNodeId = NodeId.make("node:projection-rollback-prune:root");
      const assistantNodeId = NodeId.make("node:projection-rollback-prune:assistant");
      const providerThreadId = ProviderThreadId.make("provider-thread:projection-rollback-prune");
      const providerTurnId = ProviderTurnId.make("provider-turn:projection-rollback-prune");
      const userMessageId = MessageId.make("message:projection-rollback-prune:user");
      const assistantMessageId = MessageId.make("message:projection-rollback-prune:assistant");
      const userTurnItemId = TurnItemId.make("turn-item:projection-rollback-prune:user");
      const assistantTurnItemId = TurnItemId.make("turn-item:projection-rollback-prune:assistant");
      const backgroundTurnItemId = TurnItemId.make(
        "turn-item:projection-rollback-prune:background",
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Projection rollback prune",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThreadId,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:run-created"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:attempt-created"),
        type: "run-attempt.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:root-node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "completed",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: assistantNodeId,
          threadId,
          runId,
          parentNodeId: rootNodeId,
          rootNodeId,
          kind: "assistant_message",
          status: "completed",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: rootNodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:user-message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: userMessageId,
          threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: "rolled back user",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "agent",
          creationSource: "provider",
          id: assistantMessageId,
          threadId,
          runId,
          nodeId: assistantNodeId,
          role: "assistant",
          text: "rolled back assistant",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:user-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: userTurnItemId,
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 100,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: userMessageId,
          inputIntent: "turn_start",
          text: "rolled back user",
          attachments: [],
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: assistantTurnItemId,
          threadId,
          runId,
          nodeId: assistantNodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 101,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: assistantMessageId,
          text: "rolled back assistant",
          streaming: false,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:background-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: backgroundTurnItemId,
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 300,
          status: "running",
          title: "rolled back background command",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: "sleep 60",
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:run-rolled-back"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:root-rolled-back"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "rolled_back",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["rolled_back"],
      );
      assert.deepEqual(
        projection.nodes.map((node) => [node.id, node.status]),
        [
          [assistantNodeId, "completed"],
          [rootNodeId, "rolled_back"],
        ],
      );
      assert.lengthOf(projection.providerTurns, 1);
      assert.lengthOf(projection.messages, 2);
      assert.lengthOf(projection.turnItems, 3);
      assert.lengthOf(projection.visibleTurnItems, 0);

      const shell = yield* projectionStore.getShellSnapshot();
      const rolledBackShellThread = shell.threads.find((entry) => entry.id === threadId);
      assert.isDefined(rolledBackShellThread);
      assert.isNull(rolledBackShellThread.latestVisibleMessage);
      assert.deepEqual(rolledBackShellThread?.pendingBackgroundTasks ?? [], []);
    }),
  );

  it.effect("keeps undelivered queued input out of forks taken after a later run", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-fork-held-queue");

      for (const heldStatus of ["queued", "cancelled"] as const) {
        const prefix = `projection-fork-held-queue:${heldStatus}`;
        const sourceThreadId = ThreadId.make(`thread:${prefix}:source`);
        const targetThreadId = ThreadId.make(`thread:${prefix}:target`);
        const heldRunId = RunId.make(`run:${prefix}:held`);
        const heldAttemptId = RunAttemptId.make(`attempt:${prefix}:held`);
        const answeredRunId = RunId.make(`run:${prefix}:answered`);

        for (const [threadId, forkedFrom] of [
          [sourceThreadId, null],
          [targetThreadId, { type: "run", threadId: sourceThreadId, runId: answeredRunId }],
        ] as const) {
          yield* projectionStore.apply({
            id: EventId.make(`event:${threadId}:created`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId,
              title: threadId,
              providerInstanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: {
                parentThreadId: forkedFrom === null ? null : sourceThreadId,
                relationshipToParent: forkedFrom === null ? null : "fork",
                rootThreadId: sourceThreadId,
              },
              forkedFrom,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
        }

        const applyRun = (
          runId: RunId,
          ordinal: number,
          status: typeof heldStatus | "completed" | "rolled_back",
        ) =>
          projectionStore.apply({
            id: EventId.make(`event:${runId}:${status}`),
            type: "run.updated",
            threadId: sourceThreadId,
            runId,
            nodeId: NodeId.make(`node:${runId}`),
            driver,
            occurredAt: now,
            payload: {
              id: runId,
              threadId: sourceThreadId,
              ordinal,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`message:${runId}`),
              rootNodeId: NodeId.make(`node:${runId}`),
              activeAttemptId: runId === heldRunId ? heldAttemptId : null,
              status,
              requestedAt: now,
              startedAt: runId === heldRunId ? null : now,
              completedAt: status === "queued" ? null : now,
              checkpointId: null,
              contextHandoffId: null,
            },
          });
        const applyUserItem = (input: {
          readonly threadId: ThreadId;
          readonly runId: RunId | null;
          readonly ordinal: number;
          readonly text: string;
          readonly inputIntent: "turn_start" | "queued_turn";
        }) =>
          projectionStore.apply({
            id: EventId.make(`event:${input.threadId}:item:${input.ordinal}`),
            type: "turn-item.updated",
            threadId: input.threadId,
            ...(input.runId === null ? {} : { runId: input.runId }),
            occurredAt: now,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: TurnItemId.make(`turn-item:${input.threadId}:${input.ordinal}`),
              threadId: input.threadId,
              runId: input.runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: input.ordinal,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "user_message",
              messageId: MessageId.make(`message:${input.threadId}:${input.ordinal}`),
              inputIntent: input.inputIntent,
              text: input.text,
              attachments: [],
            },
          });

        yield* applyRun(heldRunId, 1, heldStatus);
        yield* projectionStore.apply({
          id: EventId.make(`event:${heldAttemptId}:created`),
          type: "run-attempt.created",
          threadId: sourceThreadId,
          runId: heldRunId,
          nodeId: NodeId.make(`node:${heldRunId}`),
          driver,
          occurredAt: now,
          payload: {
            id: heldAttemptId,
            runId: heldRunId,
            attemptOrdinal: 1,
            rootNodeId: NodeId.make(`node:${heldRunId}`),
            providerInstanceId,
            providerThreadId: ProviderThreadId.make(`provider-thread:${prefix}`),
            providerTurnId: null,
            reason: "initial",
            status: heldStatus === "queued" ? "pending" : "cancelled",
            startedAt: null,
            completedAt: heldStatus === "queued" ? null : now,
          },
        });
        yield* applyRun(answeredRunId, 2, "completed");
        yield* applyUserItem({
          threadId: sourceThreadId,
          runId: heldRunId,
          ordinal: 100,
          text: "held",
          inputIntent: "queued_turn",
        });
        yield* applyUserItem({
          threadId: sourceThreadId,
          runId: answeredRunId,
          ordinal: 200,
          text: "answered",
          inputIntent: "turn_start",
        });
        yield* applyUserItem({
          threadId: sourceThreadId,
          runId: answeredRunId,
          ordinal: 201,
          text: "delivered steer",
          inputIntent: "queued_turn",
        });
        // Enough local turns for a turn-limited window to count inherited rows in SQL.
        for (let index = 0; index < THREAD_HISTORY_PAGE_POLICY.maxUserTurns; index += 1) {
          yield* applyUserItem({
            threadId: targetThreadId,
            runId: null,
            ordinal: index,
            text: `local ${index}`,
            inputIntent: "turn_start",
          });
        }

        const assertForkHidesHeldInput = Effect.fn("assertForkHidesHeldInput")(function* () {
          const target = yield* projectionStore.getThreadProjection(targetThreadId);
          assert.deepEqual(
            target.visibleTurnItems
              .slice(0, 3)
              .map((row) => (row.item.type === "user_message" ? row.item.text : row.item.type)),
            ["answered", "delivered steer", "fork"],
          );
          const page = yield* projectionStore.getTimelinePage(targetThreadId, {
            view: "activity",
            limit: target.visibleTurnItems.length + 1,
          });
          assert.deepEqual(page.items, target.visibleTurnItems);
          const bounded = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
            rowLimit: target.visibleTurnItems.length + 1,
          });
          assert.deepEqual(bounded.projection.visibleTurnItems, target.visibleTurnItems);
          const shellSnapshot = yield* projectionStore.getShellSnapshot();
          for (const projection of [
            yield* projectionStore.getThreadProjection(sourceThreadId),
            target,
          ]) {
            for (const shell of [
              yield* projectionStore.getThreadShell(projection.thread.id),
              shellSnapshot.threads.find((thread) => thread.id === projection.thread.id),
            ]) {
              assert.equal(shell?.visibleItemCount, projection.visibleTurnItems.length);
            }
          }
          const filledLocalPage = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
            rowLimit: target.visibleTurnItems.length,
            userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
          });
          assert.deepEqual(
            filledLocalPage.projection.visibleTurnItems.filter((row) => row.visibility === "local"),
            target.visibleTurnItems.filter((row) => row.visibility === "local"),
          );
        });

        yield* assertForkHidesHeldInput();
        // Forks keep rolled-back source history, but still not undelivered input.
        yield* applyRun(answeredRunId, 2, "rolled_back");
        yield* assertForkHidesHeldInput();
        // Rollback also takes cancelled runs, and overwrites the status that hid their input.
        if (heldStatus === "cancelled") {
          yield* applyRun(heldRunId, 1, "rolled_back");
          yield* assertForkHidesHeldInput();
        }
      }
    }),
  );

  it.effect("hides source turns rewound before the fork from a fork's visible items", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const rewoundAt = DateTime.add(now, { minutes: 1 });
      const forkedAt = DateTime.add(now, { minutes: 2 });
      const prefix = "projection-fork-after-rewind";
      const projectId = ProjectId.make(`project:${prefix}`);
      const sourceThreadId = ThreadId.make(`thread:${prefix}:source`);
      const targetThreadId = ThreadId.make(`thread:${prefix}:target`);
      const sourceProviderThreadId = ProviderThreadId.make(`provider-thread:${prefix}:source`);
      const runIds = [1, 2, 3].map((ordinal) => RunId.make(`run:${prefix}:${ordinal}`));
      const nodeIds = [1, 2, 3].map((ordinal) => NodeId.make(`node:${prefix}:${ordinal}`));
      const threadPayload = (input: {
        readonly id: ThreadId;
        readonly forkedFrom: { type: "run"; threadId: ThreadId; runId: RunId } | null;
        readonly createdAt: DateTime.Utc;
      }) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: input.id,
        projectId,
        title: input.id,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: sourceProviderThreadId,
        lineage:
          input.forkedFrom === null
            ? { parentThreadId: null, relationshipToParent: null, rootThreadId: sourceThreadId }
            : {
                parentThreadId: sourceThreadId,
                relationshipToParent: "fork" as const,
                rootThreadId: sourceThreadId,
              },
        forkedFrom: input.forkedFrom,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });
      const runPayload = (index: number, status: "completed" | "rolled_back") => ({
        id: runIds[index]!,
        threadId: sourceThreadId,
        ordinal: index + 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: sourceProviderThreadId,
        userMessageId: MessageId.make(`message:${prefix}:user:${index + 1}`),
        rootNodeId: nodeIds[index]!,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: status === "rolled_back" ? rewoundAt : now,
        checkpointId: null,
        contextHandoffId: null,
      });

      yield* projectionStore.apply({
        id: EventId.make(`event:${prefix}:source-thread`),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: threadPayload({ id: sourceThreadId, forkedFrom: null, createdAt: now }),
      });
      for (const [index, text] of ["one", "two", "three"].entries()) {
        const runId = runIds[index]!;
        const nodeId = nodeIds[index]!;
        const ordinal = index + 1;
        yield* projectionStore.apply({
          id: EventId.make(`event:${prefix}:run-${ordinal}`),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: runPayload(index, "completed"),
        });
        for (const [offset, role] of (["user", "assistant"] as const).entries()) {
          const itemBase = {
            id: TurnItemId.make(`turn-item:${prefix}:${role}:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100 + offset,
            status: "completed" as const,
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            messageId: MessageId.make(`message:${prefix}:${role}:${ordinal}`),
          };
          yield* projectionStore.apply({
            id: EventId.make(`event:${prefix}:${role}-item-${ordinal}`),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId,
            nodeId,
            driver,
            occurredAt: now,
            payload:
              role === "user"
                ? {
                    ...itemBase,
                    createdBy: "user",
                    creationSource: "web",
                    type: "user_message",
                    inputIntent: "turn_start",
                    text: `prompt ${text}`,
                    attachments: [],
                  }
                : {
                    ...itemBase,
                    type: "assistant_message",
                    text: `reply ${text}`,
                    streaming: false,
                  },
          });
        }
        // Edit from here on prompt two rewinds run 2 before prompt three is sent.
        if (ordinal === 2) {
          yield* projectionStore.apply({
            id: EventId.make(`event:${prefix}:run-2-rolled-back`),
            type: "run.updated",
            threadId: sourceThreadId,
            runId,
            nodeId,
            driver,
            occurredAt: rewoundAt,
            payload: runPayload(index, "rolled_back"),
          });
        }
      }

      const forkedFrom = { type: "run" as const, threadId: sourceThreadId, runId: runIds[2]! };
      yield* projectionStore.apply({
        id: EventId.make(`event:${prefix}:target-thread`),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: forkedAt,
        payload: threadPayload({ id: targetThreadId, forkedFrom, createdAt: forkedAt }),
      });

      const visibleTexts = (rows: ReadonlyArray<{ readonly item: OrchestrationV2TurnItem }>) =>
        rows.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        );
      const source = yield* projectionStore.getThreadProjection(sourceThreadId);
      assert.deepEqual(visibleTexts(source.visibleTurnItems), [
        "prompt one",
        "reply one",
        "prompt three",
        "reply three",
      ]);
      const expected = ["prompt one", "reply one", "prompt three", "reply three", "fork"];
      const target = yield* projectionStore.getThreadProjection(targetThreadId);
      assert.deepEqual(visibleTexts(target.visibleTurnItems), expected);
      const page = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 10,
      });
      assert.deepEqual(visibleTexts(page.items), expected);
      const window = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 10,
      });
      assert.deepEqual(visibleTexts(window.projection.visibleTurnItems), expected);
      assert.equal(
        (yield* projectionStore.getThreadShell(targetThreadId))?.visibleItemCount,
        expected.length,
      );
    }),
  );

  it.effect("a pull request watch keeps a finished thread working until it ends", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:watched-pull-request");
      const runId = RunId.make("run:watched-pull-request");
      const at = DateTime.makeUnsafe("2026-10-05T12:00:00.000Z");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:watched-pull-request"),
        title: "Babysit the PR",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* store.apply({
        id: EventId.make("event:watched-pull-request:thread"),
        type: "thread.created",
        threadId,
        occurredAt: at,
        payload: thread,
      });
      yield* store.apply({
        id: EventId.make("event:watched-pull-request:run"),
        type: "run.created",
        threadId,
        runId,
        driver,
        providerInstanceId,
        occurredAt: at,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:watched-pull-request"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: at,
          startedAt: at,
          completedAt: at,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const link = {
        host: "github.com",
        repository: "benank/ankielcode",
        number: 7,
        url: "https://github.com/benank/ankielcode/pull/7",
        source: "agent" as const,
        linkedAt: DateTime.formatIso(at),
        snapshot: null,
        stack: null,
      };
      const syncPullRequests = (id: string, pullRequests: ReadonlyArray<ThreadPullRequestLink>) =>
        store.apply({
          id: EventId.make(`event:watched-pull-request:${id}`),
          type: "thread.pull-request-synced",
          threadId,
          occurredAt: at,
          payload: { ...thread, pullRequests },
        });
      const project = { title: "Project" };
      const environmentId = EnvironmentId.make("environment:watched-pull-request");
      const phase = Effect.gen(function* () {
        const shell = yield* store.getThreadShell(threadId);
        const listed = (yield* store.getShellSnapshot()).threads.find(
          (candidate) => candidate.id === threadId,
        );
        assert.deepEqual(listed?.pendingBackgroundTasks, shell?.pendingBackgroundTasks);
        yield* assertShellIndexCoversShells();
        return shell && projectThreadAwarenessV2({ environmentId, project, thread: shell })?.phase;
      });

      yield* syncPullRequests("watched", [
        {
          ...link,
          watch: {
            startedAt: DateTime.formatIso(at),
            headSha: null,
            failedChecks: [],
            passed: false,
            passedChecks: [],
            remarksThrough: DateTime.formatIso(at),
            remarkIds: [],
            conflicting: false,
            wakes: 0,
          },
        },
      ]);
      assert.deepEqual((yield* store.getThreadShell(threadId))?.pendingBackgroundTasks, [
        {
          taskId: "pull-request-watch:github.com/benank/ankielcode#7",
          description: "Watching pull request #7",
          kind: "monitor",
          awaited: true,
        },
      ]);
      assert.equal(yield* phase, "running");

      yield* syncPullRequests("unwatched", [link]);
      assert.deepEqual((yield* store.getThreadShell(threadId))?.pendingBackgroundTasks, []);
      assert.equal(yield* phase, "completed");
    }),
  );
});
