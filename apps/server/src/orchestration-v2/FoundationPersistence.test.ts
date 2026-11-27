import type * as NodeWorkerThreads from "node:worker_threads";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@ankielcode/contracts";
import * as Queue from "effect/Queue";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import { vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import { LIVE_STREAM_MAX_ITEMS } from "./LiveStreamBudget.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadViewers from "./ThreadViewers.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const workerStatements = vi.hoisted(
  (): Array<{ readonly readOnly: boolean; readonly sql: string }> => [],
);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    readonly #readOnly: boolean;
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      this.#readOnly = args[1]?.workerData?.readOnly === true;
    }
    override postMessage(...args: Parameters<NodeWorkerThreads.Worker["postMessage"]>) {
      const [message] = args;
      if (typeof message === "object" && message !== null && typeof message.sql === "string") {
        workerStatements.push({ readOnly: this.#readOnly, sql: message.sql });
      }
      return super.postMessage(...args);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const layerDatabase = SqlitePersistence.layerMemory;
const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);
const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
const layerEffectOutboxProvided = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
const layerCommandReceiptStoreProvided = CommandReceiptStore.layer.pipe(
  Layer.provide(layerDatabase),
);
const layerIsolatedOutbox = Layer.fresh(EffectOutbox.layer.pipe(Layer.provideMerge(layerDatabase)));
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerDatabase),
);
const layerProjectionReplayProvided = ProjectionReplay.layer.pipe(
  Layer.provide(layerStoresProvided),
);
const layerTest = Layer.mergeAll(
  layerStoresProvided,
  layerEventSinkProvided,
  layerEffectOutboxProvided,
  layerCommandReceiptStoreProvided,
  IdAllocator.layer,
  layerProjectionMaintenanceProvided,
  layerProjectionReplayProvided,
);

const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
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
  };
}

function threadCreatedEvent(input: {
  readonly id: string;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(input.id),
    type: "thread.created",
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: input.thread,
  };
}

it.effect(
  "commits an ordered provider batch atomically and publishes only after the outer commit",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const store = yield* EventStore.EventStoreV2;
      const now = yield* DateTime.now;
      const thread = makeThread(ThreadId.make("thread:single-stream-batch"), now);
      yield* sink.write({ events: [threadCreatedEvent({ id: "batch-created", thread, now })] });
      const message = (id: string): OrchestrationV2DomainEvent => ({
        id: EventId.make(id),
        type: "message.updated",
        threadId: thread.id,
        occurredAt: now,
        payload: {
          id: MessageId.make("batch-message"),
          threadId: thread.id,
          runId: null,
          nodeId: null,
          createdBy: "agent",
          creationSource: "provider",
          role: "assistant",
          text: id,
          streaming: true,
          attachments: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const highWater = yield* sink.latestSequence();
      const callerError = { _tag: "CallerError" } as const;
      assert.strictEqual(
        yield* sink.withProviderBatch(Effect.fail(callerError)).pipe(Effect.flip),
        callerError,
      );
      const failed = yield* sink
        .withProviderBatch(
          Effect.gen(function* () {
            yield* sink.write({ events: [message("batch-duplicate")] });
            yield* sink.write({ events: [message("batch-duplicate")] });
          }),
        )
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failed));
      assert.equal(yield* sink.latestSequence(), highWater);
      assert.isEmpty((yield* projections.getThreadRecords(thread.id, ["messages"])).messages);

      const firstPublished = yield* Deferred.make<void>();
      const writesApplied = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const live = yield* sink.stream({ afterSequence: highWater }).pipe(
        Stream.tap(() => Deferred.succeed(firstPublished, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      const batch = yield* sink
        .withProviderBatch(
          Effect.gen(function* () {
            yield* sink.write({ events: [message("batch-first")] });
            yield* sink.write({ events: [message("batch-second")] });
            assert.equal(
              (yield* projections.getThreadRecords(thread.id, ["messages"])).messages[0]?.text,
              "batch-second",
            );
            yield* Deferred.succeed(writesApplied, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(writesApplied);
      yield* TestClock.adjust(0);
      assert.isFalse(yield* Deferred.isDone(firstPublished));
      assert.isUndefined(yield* Effect.sync(() => batch.pollUnsafe()));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(batch);
      const published = yield* Fiber.join(live);
      assert.deepEqual(
        published.map((stored) => stored.event.id),
        ["batch-first", "batch-second"],
      );
      assert.deepEqual(
        yield* store.read({ afterSequence: highWater }).pipe(Stream.runCollect),
        published,
      );
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

function nodeComparisonEvent(thread: OrchestrationV2AppThread, now: DateTime.Utc) {
  const nodeId = NodeId.make(`node:${thread.id}`);
  return {
    id: EventId.make(`node-cache:${thread.id}`),
    type: "node.updated",
    threadId: thread.id,
    occurredAt: now,
    payload: {
      id: nodeId,
      threadId: thread.id,
      runId: null,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "assistant_message",
      status: "running",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    },
  } satisfies OrchestrationV2DomainEvent;
}

it.effect("commits other threads' writes ahead of a thread's queued provider snapshots", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const [busy, independent] = ["busy", "independent"].map((id) =>
      makeThread(ThreadId.make(id), now),
    );
    yield* sink.write({
      events: [busy!, independent!].map((thread) =>
        threadCreatedEvent({ id: `created:${thread.id}`, thread, now }),
      ),
    });
    const highWater = yield* sink.latestSequence();
    const busyNode = nodeComparisonEvent(busy!, now);
    const snapshot = {
      type: "node.updated" as const,
      driver: providerDriver,
      node: busyNode.payload,
    };
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const pulled = yield* Deferred.make<void>();
    let writes = 0;
    let pulls = 0;
    const input = yield* Queue.unbounded<typeof snapshot>();
    const provider = yield* sink
      .consumeProviderEvents(
        Stream.fromQueue(input).pipe(
          Stream.take(3),
          Stream.tap(() => (++pulls === 3 ? Deferred.succeed(pulled, undefined) : Effect.void)),
        ),
        () =>
          Effect.gen(function* () {
            const id = EventId.make(`busy-provider-${++writes}`);
            yield* sink.write({ events: [{ ...busyNode, id }] });
            if (writes > 1) return;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }),
        Effect.succeed(false),
        Effect.succeed(true),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Queue.offer(input, snapshot);
    yield* Deferred.await(started);
    yield* Queue.offerAll(
      input,
      [2, 3].map((n) => ({
        ...snapshot,
        node: { ...busyNode.payload, id: NodeId.make(`node:busy:${n}`) },
      })),
    );
    yield* Deferred.await(pulled);
    yield* TestClock.adjust(0);
    const writeTo = (event: OrchestrationV2DomainEvent, id: string) =>
      sink
        .write({ events: [{ ...event, id: EventId.make(id) }] })
        .pipe(Effect.forkScoped({ startImmediately: true }));
    const sameThread = yield* writeTo(busyNode, "busy-command");
    const otherThread = yield* writeTo(nodeComparisonEvent(independent!, now), "independent");
    const childOfBusy = yield* writeTo(
      {
        id: EventId.make("unused"),
        type: "provider-thread.updated",
        threadId: independent!.id,
        driver: providerDriver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make("provider-thread:busy-child"),
          driver: providerDriver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: busy!.id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      "busy-child",
    );
    yield* TestClock.adjust(0);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(provider);
    yield* Fiber.join(sameThread);
    yield* Fiber.join(otherThread);
    yield* Fiber.join(childOfBusy);
    const store = yield* EventStore.EventStoreV2;
    const events = yield* store.read({ afterSequence: highWater }).pipe(Stream.runCollect);
    assert.deepEqual(
      events.map((stored) => stored.event.id),
      [
        "busy-provider-1",
        "independent",
        "busy-provider-2",
        "busy-provider-3",
        "busy-command",
        "busy-child",
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.fresh(layerTest))),
);

it.effect.each([false, true])("groups shutdown commits with rollback=%s", (fail) => {
  let commits = 0;
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        end(time, exit);
        if (span.name === "COMMIT") commits++;
      };
      return span;
    },
  });
  return Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const now = yield* DateTime.now;
    const threads = Array.from({ length: 65 }, (_, i) =>
      ThreadId.make(`shutdown-group:${String(i).padStart(2, "0")}`),
    );
    const sharedSession = {
      id: ProviderSessionId.make("shutdown-shared"),
      driver: providerDriver,
      providerInstanceId,
      status: "ready" as const,
      cwd: process.cwd(),
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    yield* sink.write({
      events: threads.flatMap((threadId, i): OrchestrationV2DomainEvent[] => [
        threadCreatedEvent({ id: `shutdown-create:${i}`, thread: makeThread(threadId, now), now }),
        ...(i < 2
          ? [
              {
                id: EventId.make(`shutdown-session:${i}`),
                type: "provider-session.attached" as const,
                threadId,
                occurredAt: now,
                payload: sharedSession,
              },
            ]
          : []),
        {
          id: EventId.make(`shutdown-provider:${i}`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: ProviderThreadId.make(`shutdown-provider:${i}`),
            driver: providerDriver,
            providerInstanceId,
            providerSessionId: i < 2 ? sharedSession.id : null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: i === 1 || i === 32 ? "idle" : "active",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      ]),
    });
    yield* outbox.enqueue(
      threads.map((threadId, i) => ({
        id: `shutdown-effect:${i}`,
        commandId: CommandId.make(`shutdown-command:${i}`),
        threadId,
        request: { type: "provider-turn.start" as const, runId: RunId.make(`shutdown-run:${i}`) },
      })),
    );
    let eventlessNotifications = 0;
    let armed = fail;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(ServerSettings.layerTest()),
      Effect.provideService(EffectOutbox.EffectOutboxV2, {
        ...outbox,
        signalCancellations: (ids) =>
          Effect.gen(function* () {
            assert.isTrue(Option.isNone(yield* Effect.serviceOption(sql.transactionService)));
            eventlessNotifications += ids.length;
            yield* outbox.signalCancellations(ids);
          }),
      }),
      Effect.provideService(
        EffectWorker.OrchestrationEffectWorkerV2,
        EffectWorker.OrchestrationEffectWorkerV2.of({
          awaitWork: Effect.void,
          runRecoveryOnce: Effect.succeed(false),
          runOnce: () => Effect.succeed(false),
          nextClaimableAt: () => Effect.succeedNone,
          drain: () => Effect.succeed(0),
        }),
      ),
      Effect.provideService(EventSink.EventSinkV2, {
        ...sink,
        commitCommand: (input) =>
          armed && input.threadId === threads[33]
            ? Effect.die("injected shutdown failure")
            : sink.commitCommand(input),
      }),
    );
    commits = 0;
    const result = yield* recovery.reconcile("shutdown").pipe(Effect.exit);
    assert.equal(Exit.isFailure(result), fail);
    assert.equal(commits, fail ? 1 : 3);
    const receipts =
      yield* sql`SELECT aggregate_id FROM orchestration_command_receipts WHERE command_type = 'provider-runtime.reconcile' ORDER BY aggregate_id`;
    assert.deepEqual(
      receipts.map((r) => r.aggregate_id),
      threads.slice(0, fail ? 32 : 65).filter((_, i) => i !== 1 && i !== 32),
    );
    assert.deepEqual(
      yield* projections.getRecoveryThreadIds("runtime"),
      fail ? threads.slice(32) : [],
    );
    assert.equal(eventlessNotifications, fail ? 1 : 2);
    for (const [i] of threads.entries()) {
      const effect = Option.getOrThrow(yield* outbox.get(`shutdown-effect:${i}`));
      assert.equal(effect.status, !fail || i < 32 ? "cancelled" : "pending");
    }
    assert.equal(
      (yield* events.read({ afterSequence: 0 }).pipe(Stream.runCollect)).filter(
        (e) =>
          e.event.type === "provider-session.updated" && e.event.payload.id === sharedSession.id,
      ).length,
      1,
    );
    armed = false;
    yield* recovery.reconcile("shutdown");
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    const highWater = yield* sink.latestSequence();
    yield* recovery.reconcile("shutdown");
    assert.equal(yield* sink.latestSequence(), highWater);
  }).pipe(
    Effect.provide(Layer.fresh(layerTest)),
    Effect.withTracer(tracer),
    Effect.withTracerEnabled(true),
    Effect.provideService(Statement.SpanPropagationEnabled, true),
  );
});

it.layer(layerTest)("orchestration V2 foundation persistence", (it) => {
  it.effect("filters worker replay and live queues without losing matching events", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const thread = makeThread(ThreadId.make("thread:filtered-worker"), now);
      const other = makeThread(ThreadId.make("thread:filtered-worker-other"), now);
      const run: OrchestrationV2Run = {
        id: RunId.make("run:filtered-worker"),
        threadId: thread.id,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:filtered-worker"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        queuePosition: null,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      };
      const runEvent = (id: string, payload: OrchestrationV2Run): OrchestrationV2DomainEvent => ({
        id: EventId.make(id),
        type: "run.updated",
        threadId: payload.threadId,
        runId: payload.id,
        occurredAt: now,
        payload,
      });
      const history = yield* sink.write({
        events: [
          threadCreatedEvent({ id: "event:filtered-worker:created", thread, now }),
          threadCreatedEvent({ id: "event:filtered-worker:other", thread: other, now }),
          runEvent("event:filtered-worker:history", run),
          runEvent("event:filtered-worker:other-history", {
            ...run,
            id: RunId.make("run:filtered-worker-other"),
            threadId: other.id,
          }),
        ],
      });
      const original = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_events
          WHERE sequence = ${history[0]!.sequence}
        `;
      yield* Effect.acquireRelease(
        sql`
            UPDATE orchestration_events SET payload_json = 'unreadable unrelated payload'
            WHERE sequence = ${history[0]!.sequence}
          `,
        () =>
          sql`
              UPDATE orchestration_events SET payload_json = ${original[0]!.payload_json}
              WHERE sequence = ${history[0]!.sequence}
            `.pipe(Effect.orDie),
      );
      const pull = yield* Stream.toPull(
        sink.stream({ threadId: thread.id, eventType: "run.updated" }),
      );
      assert.deepEqual(
        (yield* pull).map((stored) => stored.sequence),
        [history[2]!.sequence],
      );
      yield* sink.write({
        events: Array.from({ length: LIVE_STREAM_MAX_ITEMS + 1 }, (_, index) => ({
          id: EventId.make(`event:filtered-worker:output:${index}`),
          type: "thread.metadata-updated" as const,
          threadId: thread.id,
          occurredAt: now,
          payload: { ...thread, title: `Output ${index}` },
        })),
      });
      const live = yield* sink.write({
        events: [
          runEvent("event:filtered-worker:live:1", { ...run, status: "interrupted" }),
          runEvent("event:filtered-worker:live:2", { ...run, status: "failed" }),
        ],
      });
      assert.deepEqual(
        (yield* pull).map((stored) => stored.sequence),
        live.map((stored) => stored.sequence),
      );
    }),
  );

  it.effect("paginates catch-up beyond the event-store read limit", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-large-catch-up");
      const thread = makeThread(threadId, now);
      const eventCount = 1_005;
      const events: Array<OrchestrationV2DomainEvent> = [
        threadCreatedEvent({ id: "event:foundation-catch-up:0", thread, now }),
        ...Array.from({ length: eventCount - 1 }, (_, index) => ({
          id: EventId.make(`event:foundation-catch-up:${index + 1}`),
          type: "thread.metadata-updated" as const,
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: {
            ...thread,
            title: `Catch-up update ${index + 1}`,
          },
        })),
      ];

      yield* eventSink.write({ events });
      const replayed = yield* eventSink.stream({ afterSequence: 0 }).pipe(
        Stream.take(eventCount),
        Stream.runCollect,
        Effect.map((events) => Array.from(events)),
      );

      assert.lengthOf(replayed, eventCount);
      assert.deepEqual(
        replayed.map((stored) => stored.sequence),
        Array.from({ length: eventCount }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("does not lose or duplicate events while transitioning from catch-up to live", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-stream-race");
      const thread = makeThread(threadId, now);
      const created = yield* eventSink.write({
        events: [threadCreatedEvent({ id: "event:foundation-stream-race:0", thread, now })],
      });

      let afterSequence = created[0]!.sequence;
      // oxlint-disable-next-line ankielcode/no-polling-loop-in-tests -- Fixed-count writes exercise the catch-up/live handoff; each iteration awaits its event rather than polling.
      for (let index = 1; index <= 32; index += 1) {
        const nextEvent = {
          id: EventId.make(`event:foundation-stream-race:${index}`),
          type: "thread.metadata-updated" as const,
          threadId,
          providerInstanceId,
          occurredAt: now,
          payload: { ...thread, title: `Race update ${index}` },
        } satisfies OrchestrationV2DomainEvent;
        const reader = yield* eventSink
          .stream({ threadId, afterSequence })
          .pipe(Stream.runHead, Effect.forkChild);
        yield* Effect.yieldNow;
        const written = yield* eventSink.write({ events: [nextEvent] });
        const received = yield* Fiber.join(reader);
        if (Option.isNone(received)) {
          return yield* Effect.die("The event stream ended before delivering the live event.");
        }
        assert.equal(received.value.sequence, written[0]?.sequence);
        assert.equal(received.value.event.id, nextEvent.id);
        afterSequence = received.value.sequence;
      }
    }),
  );

  it.effect("prunes covered history, imported v1 events, and legacy receipts", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:foundation-compact");
      const thread = makeThread(threadId, now);
      const messageId = MessageId.make("message:foundation-compact");
      const threadStateEvent = (
        suffix: string,
        type: "thread.visited" | "thread.metadata-updated" | "thread.tags-updated",
      ): OrchestrationV2DomainEvent => ({
        id: EventId.make(`event:foundation-compact:${suffix}`),
        type,
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: { ...thread, lastVisitedAt: now },
      });
      const messageEvent = (suffix: string, text: string): OrchestrationV2DomainEvent => ({
        id: EventId.make(`event:foundation-compact:${suffix}`),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      const nodeId = NodeId.make("node:foundation-compact");
      const nodeEvent = (
        suffix: string,
        status: "running" | "completed",
      ): OrchestrationV2DomainEvent => ({
        id: EventId.make(`event:foundation-compact:${suffix}`),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "assistant_message",
          status,
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
        },
      });
      const itemEvent = (suffix: string, text: string): OrchestrationV2DomainEvent => ({
        id: EventId.make(`event:foundation-compact:${suffix}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("turn-item:foundation-compact"),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId,
          text,
          streaming: false,
        },
      });

      yield* eventSink.write({
        events: [
          threadCreatedEvent({ id: "event:foundation-compact:create", thread, now }),
          threadStateEvent("meta", "thread.metadata-updated"),
          threadStateEvent("visit-1", "thread.visited"),
          messageEvent("message-1", "streaming"),
          nodeEvent("node-1", "running"),
          itemEvent("item-1", "streaming"),
          itemEvent("item-middle", "still streaming"),
          ...Array.from({ length: 501 }, (_, index) =>
            threadStateEvent(`history-${index}`, "thread.visited"),
          ),
          threadStateEvent("tags-1", "thread.tags-updated"),
          threadStateEvent("visit-2", "thread.visited"),
          messageEvent("message-2", "final"),
          nodeEvent("node-2", "completed"),
          itemEvent("item-2", "final"),
          // Older clients skip tag events, so these must not remove the rename above.
          threadStateEvent("tags-2", "thread.tags-updated"),
        ],
      });
      const beforeCompaction = yield* projections.getThreadProjection(threadId);

      const importedV1ThreadId = "thread:foundation-compact-v1-imported";
      const pendingV1ThreadId = "thread:foundation-compact-v1-pending";
      const insertV1Event = (threadIdValue: string, version: number) => sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        )
        VALUES (
          ${`event:v1:${threadIdValue}:${version}`}, 'thread', ${threadIdValue}, ${version},
          'thread.message-appended', ${nowIso}, 'user', '{}', '{}', 1
        )
      `;
      yield* insertV1Event(importedV1ThreadId, 1);
      yield* insertV1Event(importedV1ThreadId, 2);
      yield* insertV1Event(pendingV1ThreadId, 1);
      yield* sql`
        INSERT INTO orchestration_v2_legacy_imports (
          thread_id, source_updated_at, shell_imported_at, transcript_imported_at,
          imported_message_count, last_error
        )
        VALUES
          (${importedV1ThreadId}, ${nowIso}, ${nowIso}, ${nowIso}, 2, NULL),
          (${pendingV1ThreadId}, ${nowIso}, ${nowIso}, NULL, 0, NULL)
        ON CONFLICT(thread_id) DO NOTHING
      `;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
        )
        VALUES
          ('command:foundation-compact:legacy', 'thread', ${importedV1ThreadId}, ${nowIso}, 1, 'accepted', 'legacy'),
          ('command:foundation-compact:pending', 'thread', ${pendingV1ThreadId}, ${nowIso}, 1, 'accepted', 'legacy')
        ON CONFLICT(command_id) DO NOTHING
      `;

      // The first pass only marks the head and drops imported legacy rows.
      const marked = yield* maintenance.pruneEventStore();
      yield* TestClock.adjust("1 day");
      const summary = yield* maintenance.pruneEventStore();
      assert.isAtLeast(summary.deletedEventCount, 504);
      assert.equal(marked.deletedReceiptCount + summary.deletedReceiptCount, 1);

      const remaining = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
        ORDER BY sequence ASC
      `;
      assert.deepEqual(
        remaining.map((row) => row.event_id),
        ["event:foundation-compact:create", "event:foundation-compact:tags-2"],
      );

      const remainingV1 = yield* sql<{ readonly stream_id: string }>`
        SELECT stream_id
        FROM orchestration_events
        WHERE application_event_version = 1
          AND stream_id IN (${importedV1ThreadId}, ${pendingV1ThreadId})
      `;
      assert.deepEqual(
        remainingV1.map((row) => row.stream_id),
        [pendingV1ThreadId],
      );

      const remainingReceipts = yield* sql<{ readonly command_id: string }>`
        SELECT command_id
        FROM orchestration_command_receipts
        WHERE command_id IN ('command:foundation-compact:legacy', 'command:foundation-compact:pending')
      `;
      assert.deepEqual(
        remainingReceipts.map((row) => row.command_id),
        ["command:foundation-compact:pending"],
      );

      assert.deepEqual(yield* projections.getThreadProjection(threadId), beforeCompaction);
    }),
  );

  it.effect("verifies and rebuilds projections with cross-thread subagent relations", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const parentThreadId = ThreadId.make("thread:foundation-cross-thread:parent");
      const childThreadId = ThreadId.make("thread:foundation-cross-thread:child");
      const childProviderThreadId = ProviderThreadId.make(
        "provider-thread:foundation-cross-thread:child",
      );
      const subagentId = NodeId.make("subagent:foundation-cross-thread");
      const spawnTransferId = ContextTransferId.make("transfer:foundation-cross-thread:spawn");
      const resultTransferId = ContextTransferId.make("transfer:foundation-cross-thread:result");
      const parentThread = makeThread(parentThreadId, now);
      const childThread = {
        ...makeThread(childThreadId, now),
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        lineage: {
          parentThreadId,
          relationshipToParent: "subagent" as const,
          rootThreadId: parentThreadId,
        },
      };

      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-cross-thread:parent",
            thread: parentThread,
            now,
          }),
          threadCreatedEvent({
            id: "event:foundation-cross-thread:child",
            thread: childThread,
            now,
          }),
          {
            id: EventId.make("event:foundation-cross-thread:subagent"),
            type: "subagent.updated",
            threadId: parentThreadId,
            nodeId: subagentId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: subagentId,
              threadId: parentThreadId,
              runId: null,
              parentNodeId: NodeId.make("node:foundation-cross-thread:parent"),
              origin: "app_owned",
              createdBy: "agent",
              driver: providerDriver,
              providerInstanceId,
              providerThreadId: childProviderThreadId,
              childThreadId,
              nativeTaskRef: null,
              prompt: "Inspect the child flow",
              title: "Cross-thread child",
              model: modelSelection.model,
              status: "completed",
              result: "done",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("event:foundation-cross-thread:spawn-transfer"),
            type: "context-transfer.created",
            threadId: childThreadId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: spawnTransferId,
              type: "subagent_spawn",
              sourceThreadId: parentThreadId,
              targetThreadId: childThreadId,
              sourcePoint: { threadId: parentThreadId },
              basePoint: null,
              sourceProviderInstanceId: providerInstanceId,
              targetProviderInstanceId: providerInstanceId,
              targetRunId: null,
              status: "consumed",
              resolution: null,
              createdBy: "agent",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: now,
            },
          },
          {
            id: EventId.make("event:foundation-cross-thread:provider-thread"),
            type: "provider-thread.updated",
            threadId: parentThreadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: childProviderThreadId,
              driver: providerDriver,
              providerInstanceId,
              providerSessionId: null,
              appThreadId: childThreadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
          {
            id: EventId.make("event:foundation-cross-thread:result-transfer"),
            type: "context-transfer.created",
            threadId: parentThreadId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: resultTransferId,
              type: "subagent_result",
              sourceThreadId: childThreadId,
              targetThreadId: parentThreadId,
              sourcePoint: { threadId: childThreadId },
              basePoint: null,
              sourceProviderInstanceId: providerInstanceId,
              targetProviderInstanceId: providerInstanceId,
              targetRunId: null,
              status: "consumed",
              resolution: null,
              createdBy: "system",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: now,
            },
          },
        ],
      });

      const assertCrossThreadProjection = Effect.gen(function* () {
        const parent = yield* projectionStore.getThreadProjection(parentThreadId);
        const child = yield* projectionStore.getThreadProjection(childThreadId);
        const expectedTransferIds = [spawnTransferId, resultTransferId].toSorted();
        assert.deepEqual(
          parent.contextTransfers.map((transfer) => transfer.id).toSorted(),
          expectedTransferIds,
        );
        assert.deepEqual(
          child.contextTransfers.map((transfer) => transfer.id).toSorted(),
          expectedTransferIds,
        );
        assert.deepEqual(
          parent.providerThreads.map((providerThread) => providerThread.id),
          [childProviderThreadId],
        );
        assert.equal(child.thread.activeProviderThreadId, childProviderThreadId);
      });

      yield* assertCrossThreadProjection;
      assert.isTrue((yield* maintenance.verify).valid);
      yield* sql`
        UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{}'
        WHERE provider_thread_id = ${childProviderThreadId}
      `;
      assert.deepEqual(
        new Set((yield* maintenance.verify).unreadableThreadIds),
        new Set([parentThreadId, childThreadId]),
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* assertCrossThreadProjection;
    }),
  );

  it.effect(
    "rolls back events, projections, receipts, and effects after a projection failure",
    () =>
      Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const eventStore = yield* EventStore.EventStoreV2;
        const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const commandId = CommandId.make("command:foundation-atomic-failure");
        const threadId = ThreadId.make("thread:foundation-atomic-failure");
        const scopeId = CheckpointScopeId.make("scope:foundation-atomic-failure");
        const checkpoint = (index: number) => ({
          id: CheckpointId.make(`checkpoint:foundation-atomic-failure:${index}`),
          threadId,
          scopeId,
          runId: null,
          nodeId: NodeId.make("node:foundation-atomic-failure"),
          parentCheckpointId: null,
          ordinalWithinScope: 1,
          appRunOrdinal: null,
          ref: CheckpointRef.make(`checkpoint-ref:foundation-atomic-failure:${index}`),
          status: "ready" as const,
          files: [],
          capturedAt: now,
        });
        const events = [1, 2].map(
          (index) =>
            ({
              id: EventId.make(`event:foundation-atomic-failure:${index}`),
              type: "checkpoint.captured",
              threadId,
              occurredAt: now,
              payload: checkpoint(index),
            }) satisfies OrchestrationV2DomainEvent,
        );

        const exit = yield* Effect.exit(
          eventSink.commitCommand({
            commandId,
            threadId,
            commandType: "checkpoint.atomicity-test",
            acceptedAt: now,
            events,
            effects: [
              {
                id: "effect:foundation-atomic-failure",
                commandId,
                threadId,
                request: {
                  type: "provider-turn.start",
                  runId: RunId.make("run:foundation-atomic-failure"),
                },
              },
            ],
          }),
        );
        assert.equal(exit._tag, "Failure");
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(commandId)));
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
        assert.deepEqual(
          yield* eventStore.readByCommandId({ commandId }).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
          [],
        );
        const checkpointRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_v2_projection_checkpoints
        WHERE thread_id = ${threadId}
      `;
        assert.equal(checkpointRows[0]?.count, 0);
      }),
  );

  it.effect("replays every command event across bounded persistence pages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventStore = yield* EventStore.EventStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const occurredAt = DateTime.formatIso(now);
      const commandId = CommandId.make("command:paged-command-replay");
      const exactPageCommandId = CommandId.make("command:paged-command-replay:exact");
      const emptyCommandId = CommandId.make("command:paged-command-replay:empty");
      const threadId = "thread:paged-command-replay";

      const eventRow = (
        ordinal: number,
        input: {
          readonly commandId?: string | null;
          readonly aggregateKind?: "project" | "thread";
          readonly streamId?: string;
          readonly version?: number;
        } = {},
      ) => ({
        event_id: `event:paged-command-replay:${ordinal}`,
        aggregate_kind: input.aggregateKind ?? "thread",
        stream_id: input.streamId ?? threadId,
        stream_version: ordinal,
        event_type: "provider-session.detached",
        occurred_at: occurredAt,
        command_id: input.commandId ?? null,
        causation_event_id: null,
        correlation_id: null,
        actor_kind: "server",
        payload_json: JSON.stringify({
          providerSessionId: `session:paged-command-replay:${ordinal}`,
          detachedAt: occurredAt,
        }),
        metadata_json: "{}",
        application_event_version: input.version ?? 2,
      });

      const matchingCount = 1_001;
      const rows: Array<ReturnType<typeof eventRow>> = [];
      let ordinal = 0;
      for (let index = 0; index < matchingCount; index += 1) {
        rows.push(eventRow(++ordinal, { commandId }));
        if (index % 2 === 0) {
          rows.push(eventRow(++ordinal, { commandId: "command:unrelated" }));
        }
        if (index % 5 === 0) {
          rows.push(eventRow(++ordinal));
          rows.push(eventRow(++ordinal, { commandId, version: 1 }));
          rows.push(
            eventRow(++ordinal, {
              commandId,
              aggregateKind: "project",
              streamId: `project:paged-command-replay:${index}`,
            }),
          );
        }
      }
      for (let index = 0; index < 500; index += 1) {
        rows.push(eventRow(++ordinal, { commandId: exactPageCommandId }));
      }
      const inserted = yield* Effect.forEach(
        Arr.chunksOf(rows, 400),
        (chunk) =>
          sql<{
            readonly sequence: number;
            readonly command_id: string | null;
            readonly aggregate_kind: string;
            readonly application_event_version: number;
          }>`
            INSERT INTO orchestration_events ${sql.insert(chunk)}
            RETURNING sequence, command_id, aggregate_kind, application_event_version
          `,
        { concurrency: 1 },
      ).pipe(Effect.map((chunks) => chunks.flat()));
      const expectedSequences = inserted
        .filter(
          (row) =>
            row.command_id === commandId &&
            row.aggregate_kind === "thread" &&
            row.application_event_version === 2,
        )
        .map((row) => row.sequence);
      assert.lengthOf(expectedSequences, matchingCount);

      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
        )
        VALUES (
          ${commandId}, 'thread', ${threadId}, ${occurredAt},
          ${expectedSequences.at(-1)!}, 'accepted', 'thread.create'
        )
      `;

      const pageLimits: Array<number> = [];
      const recordReads: Statement.Transformer = (statement) => {
        const [query, params] = statement.compile();
        if (query.includes("FROM orchestration_events") && query.includes("command_id")) {
          const limit = params.at(-1);
          if (typeof limit === "number") {
            pageLimits.push(limit);
          }
        }
        return Effect.succeed(statement);
      };
      const collectByCommandId = (id: CommandId) =>
        eventStore.readByCommandId({ commandId: id }).pipe(
          Stream.provideService(Statement.CurrentTransformer, recordReads),
          Stream.runCollect,
          Effect.map((events) => Array.from(events)),
        );

      const replayed = yield* collectByCommandId(commandId);
      assert.deepEqual(
        replayed.map((stored) => stored.sequence),
        expectedSequences,
      );
      assert.deepEqual(pageLimits, [500, 500, 500]);

      pageLimits.length = 0;
      const exactPage = yield* collectByCommandId(exactPageCommandId);
      assert.lengthOf(exactPage, 500);
      assert.deepEqual(pageLimits, [500, 500]);

      pageLimits.length = 0;
      const empty = yield* collectByCommandId(emptyCommandId);
      assert.lengthOf(empty, 0);
      assert.deepEqual(pageLimits, [500]);

      pageLimits.length = 0;
      const retried = yield* eventSink
        .commitCommand({
          commandId,
          threadId: ThreadId.make(threadId),
          commandType: "thread.create",
          acceptedAt: now,
          events: [
            threadCreatedEvent({
              id: "event:paged-command-replay:retry",
              thread: makeThread(ThreadId.make(threadId), now),
              now,
            }),
          ],
          effects: [],
        })
        .pipe(Effect.provideService(Statement.CurrentTransformer, recordReads));
      assert.isFalse(retried.committed);
      assert.equal(retried.receipt.resultSequence, expectedSequences.at(-1));
      assert.deepEqual(
        retried.storedEvents.map((stored) => stored.sequence),
        expectedSequences,
      );
      assert.deepEqual(pageLimits, [500, 500, 500]);
    }),
  );

  it.effect("keeps one durable effect across command retries and executes it after recovery", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const now = yield* DateTime.now;
      const commandId = CommandId.make("command:foundation-effect-recovery");
      const threadId = ThreadId.make("thread:foundation-effect-recovery");
      const thread = makeThread(threadId, now);
      const event = threadCreatedEvent({
        id: "event:foundation-effect-recovery",
        thread,
        now,
      });
      const effect = {
        id: "effect:foundation-effect-recovery",
        commandId,
        threadId,
        request: {
          type: "provider-turn.start" as const,
          runId: RunId.make("run:foundation-effect-recovery"),
        },
      };

      const first = yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "foundation.effect-recovery",
        acceptedAt: now,
        events: [event],
        effects: [effect],
      });
      const retry = yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "foundation.effect-recovery",
        acceptedAt: now,
        events: [event],
        effects: [effect],
      });

      assert.isTrue(first.committed);
      assert.isFalse(retry.committed);
      assert.equal(retry.receipt.resultSequence, first.receipt.resultSequence);
      assert.lengthOf(retry.storedEvents, 1);
      assert.lengthOf(yield* outbox.listByCommandId(commandId), 1);

      const executionCount = yield* Ref.make(0);
      const layerExecutor = Layer.succeed(
        EffectWorker.OrchestrationEffectExecutorV2,
        EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: () => Ref.update(executionCount, (count) => count + 1),
        }),
      );
      const layerWorker = EffectWorker.layerWithOptions({ workerId: "recovery-worker" }).pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(EffectOutbox.EffectOutboxV2, outbox), layerExecutor),
        ),
      );
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        assert.isTrue(yield* worker.runOnce());
        assert.isFalse(yield* worker.runOnce());
      }).pipe(Effect.provide(layerWorker));

      assert.equal(yield* Ref.get(executionCount), 1);
      const storedEffect = yield* outbox.get(effect.id);
      assert.isTrue(Option.isSome(storedEffect));
      if (Option.isSome(storedEffect)) {
        assert.equal(storedEffect.value.status, "succeeded");
      }
    }),
  );

  it.effect("does not publish a stale provider start after an interrupt wins", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-stale-provider-start");
      const runId = RunId.make("run:foundation-stale-provider-start");
      const attemptId = RunAttemptId.make("run-attempt:foundation-stale-provider-start");
      const thread = makeThread(threadId, now);
      const startingRun: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:foundation-stale-provider-start"),
        rootNodeId: null,
        activeAttemptId: attemptId,
        status: "starting",
        queuePosition: null,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-stale-provider-start:thread",
            thread,
            now,
          }),
          {
            id: EventId.make("event:foundation-stale-provider-start:run"),
            type: "run.created",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: startingRun,
          },
        ],
      });

      const captureEffect = {
        id: "effect:foundation-current-capture",
        commandId: CommandId.make("command:foundation-current-capture"),
        threadId,
        request: {
          type: "checkpoint.capture" as const,
          runId,
          scopeId: CheckpointScopeId.make("scope:foundation-current-capture"),
        },
      };
      assert.isTrue(
        (yield* eventSink.writeIfRunCurrent({
          threadId,
          runId,
          activeAttemptId: attemptId,
          expectedStatus: "starting",
          events: [],
          effects: [captureEffect],
        })).committed,
      );
      assert.isTrue(Option.isSome(yield* outbox.get(captureEffect.id)));
      yield* outbox.awaitAvailable;
      const staleCaptureEffect = { ...captureEffect, id: "effect:foundation-stale-capture" };

      const reachedPrecommitGap = yield* Deferred.make<void>();
      const releaseStaleStart = yield* Deferred.make<void>();
      const providerStartCount = yield* Ref.make(0);
      const staleStartFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(reachedPrecommitGap, undefined);
        yield* Deferred.await(releaseStaleStart);
        const result = yield* eventSink.writeIfRunCurrent({
          threadId,
          runId,
          activeAttemptId: attemptId,
          expectedStatus: "starting",
          effects: [staleCaptureEffect],
          events: [
            {
              id: EventId.make("event:foundation-stale-provider-start:running"),
              type: "run.updated",
              threadId,
              runId,
              providerInstanceId,
              occurredAt: now,
              payload: { ...startingRun, status: "running", startedAt: now },
            },
          ],
        });
        if (result.committed) {
          yield* Ref.update(providerStartCount, (count) => count + 1);
        }
        return result;
      }).pipe(Effect.forkChild);

      yield* Deferred.await(reachedPrecommitGap);
      const interruptedAt = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-stale-provider-start:cancelled"),
            type: "run.updated",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: interruptedAt,
            payload: {
              ...startingRun,
              status: "cancelled",
              completedAt: interruptedAt,
            },
          },
        ],
      });
      yield* Deferred.succeed(releaseStaleStart, undefined);

      const staleResult = yield* Fiber.join(staleStartFiber);
      assert.isFalse(staleResult.committed);
      assert.isTrue(Option.isNone(yield* outbox.get(staleCaptureEffect.id)));
      assert.deepEqual(staleResult.storedEvents, []);
      assert.equal(yield* Ref.get(providerStartCount), 0);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "cancelled");
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("refuses a run-current write once an unpaired interrupt request is stored", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-interrupt-guard");
      const runId = RunId.make("run:foundation-interrupt-guard");
      const attemptId = RunAttemptId.make("run-attempt:foundation-interrupt-guard");
      const requestId = TurnItemId.make("turn-item:foundation-interrupt-guard:request");
      const resultId = TurnItemId.make("turn-item:foundation-interrupt-guard:result");
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:foundation-interrupt-guard"),
        rootNodeId: null,
        activeAttemptId: attemptId,
        status: "running",
        queuePosition: null,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-interrupt-guard:thread",
            thread: makeThread(threadId, now),
            now,
          }),
          {
            id: EventId.make("event:foundation-interrupt-guard:run"),
            type: "run.created",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: run,
          },
        ],
      });
      const signalItem = (id: TurnItemId, type: "run_interrupt_request" | "run_interrupt_result") =>
        ({
          id: EventId.make(`event:${id}`),
          type: "turn-item.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id,
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: "Interrupt",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type,
            message: "Stopped",
          },
        }) as OrchestrationV2DomainEvent;
      const completeRun = (suffix: string) =>
        eventSink.writeIfRunCurrent({
          threadId,
          runId,
          activeAttemptId: attemptId,
          expectedStatus: "running",
          unlessInterruptRequested: { requestId, resultId },
          events: [
            {
              id: EventId.make(`event:foundation-interrupt-guard:waiting:${suffix}`),
              type: "run.updated",
              threadId,
              runId,
              providerInstanceId,
              occurredAt: now,
              payload: { ...run, status: "waiting" },
            },
          ],
        });

      yield* eventSink.write({ events: [signalItem(requestId, "run_interrupt_request")] });
      const refused = yield* completeRun("refused");
      assert.isFalse(refused.committed);
      assert.deepEqual(refused.storedEvents, []);

      yield* eventSink.write({ events: [signalItem(resultId, "run_interrupt_result")] });
      assert.isTrue((yield* completeRun("paired")).committed);
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );

  it.effect("guards post-terminal provider-thread writes by attempt and run ordinal", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-provider-thread-owner");
      const runId = RunId.make("run:foundation-provider-thread-owner");
      const attemptId = RunAttemptId.make("attempt:foundation-provider-thread-owner");
      const replacementAttemptId = RunAttemptId.make(
        "attempt:foundation-provider-thread-owner:replacement",
      );
      const rootNodeId = NodeId.make("node:foundation-provider-thread-owner");
      const providerThreadId = ProviderThreadId.make(
        "provider-thread:foundation-provider-thread-owner",
      );
      const thread = makeThread(threadId, now);
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:foundation-provider-thread-owner"),
        rootNodeId,
        activeAttemptId: attemptId,
        status: "completed",
        queuePosition: null,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      };
      const baseProviderThread = {
        id: providerThreadId,
        driver: providerDriver,
        providerInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [] as const,
        forkedFrom: null,
        pendingBackgroundTasks: [
          { taskId: "bg-owner", description: "sleep 20", kind: "command" as const },
        ],
        createdAt: now,
        updatedAt: now,
      };

      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-provider-thread-owner:thread",
            thread,
            now,
          }),
          {
            id: EventId.make("event:foundation-provider-thread-owner:run"),
            type: "run.created",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: now,
            payload: run,
          },
          {
            id: EventId.make("event:foundation-provider-thread-owner:provider-thread"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: baseProviderThread,
          },
        ],
      });

      const ownedClear = yield* eventSink.writeIfProviderThreadOwner({
        providerThreadId,
        runId,
        activeAttemptId: attemptId,
        expectedLastRunOrdinal: 1,
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:clear"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: now,
            payload: {
              ...baseProviderThread,
              pendingBackgroundTasks: [],
              updatedAt: now,
            },
          },
        ],
      });
      assert.isTrue(ownedClear.committed);
      assert.equal(ownedClear.storedEvents.length, 1);

      const afterReplacement = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:replacement-attempt"),
            type: "run.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: {
              ...run,
              activeAttemptId: replacementAttemptId,
              status: "running",
            },
          },
        ],
      });

      const supersededAttemptWrite = yield* eventSink.writeIfProviderThreadOwner({
        providerThreadId,
        runId,
        activeAttemptId: attemptId,
        expectedLastRunOrdinal: 1,
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:superseded-attempt"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: {
              ...baseProviderThread,
              status: "active",
              pendingBackgroundTasks: [
                {
                  taskId: "bg-superseded",
                  description: "should not land",
                  kind: "command" as const,
                },
              ],
              updatedAt: afterReplacement,
            },
          },
        ],
      });
      assert.isFalse(supersededAttemptWrite.committed);
      assert.deepEqual(supersededAttemptWrite.storedEvents, []);

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:replacement-completed"),
            type: "run.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: {
              ...run,
              activeAttemptId: replacementAttemptId,
            },
          },
          {
            id: EventId.make("event:foundation-provider-thread-owner:newer-run"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: {
              ...baseProviderThread,
              lastRunOrdinal: 2,
              status: "active",
              pendingBackgroundTasks: [],
              updatedAt: afterReplacement,
            },
          },
        ],
      });

      const staleOrdinalWrite = yield* eventSink.writeIfProviderThreadOwner({
        providerThreadId,
        runId,
        activeAttemptId: replacementAttemptId,
        expectedLastRunOrdinal: 1,
        events: [
          {
            id: EventId.make("event:foundation-provider-thread-owner:stale-ordinal"),
            type: "provider-thread.updated",
            threadId,
            driver: providerDriver,
            providerInstanceId,
            occurredAt: afterReplacement,
            payload: baseProviderThread,
          },
        ],
      });
      assert.isFalse(staleOrdinalWrite.committed);
      assert.deepEqual(staleOrdinalWrite.storedEvents, []);

      const projection = yield* projectionStore.getThreadProjection(threadId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === providerThreadId,
      );
      assert.isDefined(providerThread);
      assert.equal(providerThread?.lastRunOrdinal, 2);
      assert.equal(providerThread?.status, "active");
      assert.deepEqual(providerThread?.pendingBackgroundTasks ?? [], []);
    }),
  );

  it.effect("interrupts a running process-bound effect when it is cancelled", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-cancel-running-effect");
      const threadId = ThreadId.make("thread:foundation-cancel-running-effect");
      const effectId = "effect:foundation-cancel-running-effect";
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      yield* outbox.enqueue([
        {
          id: effectId,
          commandId,
          threadId,
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-cancel-running-effect"),
          },
        },
      ]);

      const layerExecutor = Layer.succeed(
        EffectWorker.OrchestrationEffectExecutorV2,
        EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(interrupted, undefined).pipe(Effect.ignore),
              ),
            ),
        }),
      );
      const layerWorker = EffectWorker.layerWithOptions({
        workerId: "cancellation-worker",
      }).pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(EffectOutbox.EffectOutboxV2, outbox), layerExecutor),
        ),
      );

      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const workerFiber = yield* worker.runOnce().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const cancelledEffectIds = yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["provider-turn.start"],
          reason: "The owning run was interrupted.",
        });
        assert.deepEqual(cancelledEffectIds, [effectId]);
        yield* outbox.signalCancellations(cancelledEffectIds);
        assert.isTrue(yield* Fiber.join(workerFiber));
        yield* Deferred.await(interrupted);
      }).pipe(Effect.provide(layerWorker));

      const cancelled = yield* outbox.get(effectId);
      assert.isTrue(Option.isSome(cancelled));
      if (Option.isSome(cancelled)) assert.equal(cancelled.value.status, "cancelled");
    }),
  );

  it.effect("does not start an effect that was cancelled during claim registration", () =>
    Effect.gen(function* () {
      const effectId = "effect:foundation-cancelled-during-claim";
      const threadId = ThreadId.make("thread:foundation-cancelled-during-claim");
      const commandId = CommandId.make("command:foundation-cancelled-during-claim");
      const now = DateTime.formatIso(yield* DateTime.now);
      const claimedEffect = {
        id: effectId,
        commandId,
        threadId,
        request: { type: "terminal.cleanup" as const },
        status: "running" as const,
        attemptCount: 1,
        availableAt: now,
        leaseOwner: "claim-cancellation-worker",
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        lastError: null,
      };
      const executionCount = yield* Ref.make(0);
      const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
        claimNext: () => Effect.succeedSome(claimedEffect),
        get: () =>
          Effect.succeedSome({
            ...claimedEffect,
            status: "cancelled" as const,
            leaseOwner: null,
            completedAt: now,
          }),
        clearCancellation: () => Effect.void,
        awaitCancellation: () => Effect.never,
      });
      const layerExecutor = Layer.succeed(
        EffectWorker.OrchestrationEffectExecutorV2,
        EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: () => Ref.update(executionCount, (count) => count + 1),
        }),
      );
      const layerWorker = EffectWorker.layerWithOptions({
        workerId: "claim-cancellation-worker",
      }).pipe(Layer.provide(Layer.merge(layerOutbox, layerExecutor)));

      assert.isTrue(
        yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
          Effect.flatMap((worker) => worker.runOnce()),
          Effect.provide(layerWorker),
        ),
      );
      assert.equal(yield* Ref.get(executionCount), 0);
    }),
  );

  it.effect("allows only one worker to claim an available effect", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-exclusive-claim");
      yield* outbox.enqueue([
        {
          id: "effect:foundation-exclusive-claim",
          commandId,
          threadId: ThreadId.make("thread:foundation-exclusive-claim"),
          request: {
            type: "provider-turn.start",
            runId: RunId.make("run:foundation-exclusive-claim"),
          },
        },
      ]);

      const claims = yield* Effect.all(
        [outbox.claimNext({ workerId: "worker-a" }), outbox.claimNext({ workerId: "worker-b" })],
        { concurrency: "unbounded" },
      );
      assert.equal(claims.filter(Option.isSome).length, 1);
      assert.equal(claims.filter(Option.isNone).length, 1);
      const claimedByA = claims[0];
      const claimedByB = claims[1];
      if (Option.isSome(claimedByA)) {
        yield* outbox.succeed({ effectId: claimedByA.value.id, workerId: "worker-a" });
      }
      if (Option.isSome(claimedByB)) {
        yield* outbox.succeed({ effectId: claimedByB.value.id, workerId: "worker-b" });
      }
    }),
  );

  it.effect("fails an effect this build cannot decode and claims the thread's next effect", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const workerId = "undecodable-worker";
      const commandId = CommandId.make("command:foundation-undecodable");
      const threadId = ThreadId.make("thread:foundation-undecodable");
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          available_at, created_at, updated_at
        )
        VALUES (
          'effect:foundation-undecodable:a', ${commandId}, ${threadId}, 'future-effect.kind',
          '{"type":"future-effect.kind"}', 'pending', ${nowIso}, ${nowIso}, ${nowIso}
        )
      `;
      yield* outbox.enqueue([
        {
          id: "effect:foundation-undecodable:b",
          commandId,
          threadId,
          request: { type: "provider-turn.start", runId: RunId.make("run:foundation-undecodable") },
        },
      ]);

      const claimed = yield* Effect.exit(outbox.claimNext({ workerId }));

      const rows = yield* sql<{
        readonly effect_id: string;
        readonly status: string;
        readonly lease_owner: string | null;
        readonly last_error: string | null;
      }>`
        SELECT effect_id, status, lease_owner, last_error
        FROM orchestration_v2_effect_outbox
        ORDER BY effect_id
      `;
      assert.deepEqual(rows, [
        {
          effect_id: "effect:foundation-undecodable:a",
          status: "failed",
          lease_owner: null,
          last_error: "This server build cannot decode the future-effect.kind effect.",
        },
        {
          effect_id: "effect:foundation-undecodable:b",
          status: "running",
          lease_owner: workerId,
          last_error: null,
        },
      ]);
      assert.equal(
        Exit.isSuccess(claimed) ? Option.getOrUndefined(claimed.value)?.id : undefined,
        "effect:foundation-undecodable:b",
      );
    }).pipe(Effect.provide(layerIsolatedOutbox)),
  );

  it.effect("runs distinct threads concurrently while serializing effects within a thread", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const commandId = CommandId.make("command:foundation-concurrent-effects");
      const threadA = ThreadId.make("thread:foundation-concurrent-effects:a");
      const threadB = ThreadId.make("thread:foundation-concurrent-effects:b");
      const effectA1 = "effect:foundation-concurrent-effects:a1";
      const effectA2 = "effect:foundation-concurrent-effects:a2";
      const effectB1 = "effect:foundation-concurrent-effects:b1";
      const startedA1 = yield* Deferred.make<void>();
      const startedA2 = yield* Deferred.make<void>();
      const startedB1 = yield* Deferred.make<void>();
      const releaseA1 = yield* Deferred.make<void>();
      const releaseA2 = yield* Deferred.make<void>();
      const releaseB1 = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const completed = yield* Ref.make(0);
      const gates = new Map([
        [effectA1, { started: startedA1, release: releaseA1 }],
        [effectA2, { started: startedA2, release: releaseA2 }],
        [effectB1, { started: startedB1, release: releaseB1 }],
      ]);
      const layerExecutor = Layer.succeed(
        EffectWorker.OrchestrationEffectExecutorV2,
        EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: (effect) => {
            const gate = gates.get(effect.id);
            if (gate === undefined) return Effect.die(`Missing gate for ${effect.id}`);
            return Deferred.succeed(gate.started, undefined).pipe(
              Effect.andThen(Deferred.await(gate.release)),
            );
          },
        }),
      );
      const layerWorker = EffectWorker.layerWithOptions({
        workerId: "concurrency-worker",
      }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(EffectOutbox.EffectOutboxV2, {
              ...outbox,
              succeed: (input) =>
                outbox
                  .succeed(input)
                  .pipe(
                    Effect.tap(() =>
                      Ref.updateAndGet(completed, (count) => count + 1).pipe(
                        Effect.flatMap((count) =>
                          count === 3 ? Deferred.succeed(settled, undefined) : Effect.void,
                        ),
                      ),
                    ),
                  ),
            }),
            layerExecutor,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* outbox.enqueue([
          {
            id: effectA1,
            commandId,
            threadId: threadA,
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-concurrent-effects:a1"),
            },
          },
          {
            id: effectA2,
            commandId,
            threadId: threadA,
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-concurrent-effects:a2"),
            },
          },
          {
            id: effectB1,
            commandId,
            threadId: threadB,
            request: {
              type: "provider-turn.start",
              runId: RunId.make("run:foundation-concurrent-effects:b1"),
            },
          },
        ]);
        yield* outbox.notifyAvailable(3);

        yield* Effect.all([Deferred.await(startedA1), Deferred.await(startedB1)]);
        assert.isFalse(yield* Deferred.isDone(startedA2));

        yield* Deferred.succeed(releaseA1, undefined);
        yield* Deferred.succeed(releaseB1, undefined);
        yield* Deferred.await(startedA2);
        yield* Deferred.succeed(releaseA2, undefined);
        yield* Deferred.await(settled);
        assert.isTrue(
          (yield* outbox.listByCommandId(commandId)).every(
            (effect) => effect.status === "succeeded",
          ),
        );
      }).pipe(Effect.provide(layerWorker), Effect.scoped);
    }),
  );

  it.effect("does not reclaim a running effect after its process-local lease expires", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const commandId = CommandId.make("command:foundation-no-live-reclaim");
      const threadId = ThreadId.make("thread:foundation-no-live-reclaim");
      const firstEffectId = "effect:foundation-no-live-reclaim:first";
      const secondEffectId = "effect:foundation-no-live-reclaim:second";
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const executions = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* outbox.enqueue([
        {
          id: firstEffectId,
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
        {
          id: secondEffectId,
          commandId,
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);

      const layerExecutor = Layer.succeed(
        EffectWorker.OrchestrationEffectExecutorV2,
        EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: (effect) =>
            Ref.update(executions, (current) => [...current, effect.id]).pipe(
              Effect.andThen(
                effect.id === firstEffectId
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFirst)),
                    )
                  : Effect.void,
              ),
            ),
        }),
      );
      const layerWorker = EffectWorker.layerWithOptions({
        workerId: "no-live-reclaim-worker",
      }).pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(EffectOutbox.EffectOutboxV2, outbox), layerExecutor),
        ),
      );

      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const firstFiber = yield* worker.runOnce().pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        yield* sql`
          UPDATE orchestration_v2_effect_outbox
          SET lease_expires_at = '1970-01-01T00:00:00.000Z'
          WHERE effect_id = ${firstEffectId}
        `;

        assert.isFalse(yield* worker.runOnce());
        assert.deepEqual(yield* Ref.get(executions), [firstEffectId]);

        yield* Deferred.succeed(releaseFirst, undefined);
        assert.isTrue(yield* Fiber.join(firstFiber));
        assert.isTrue(yield* worker.runOnce());
        assert.deepEqual(yield* Ref.get(executions), [firstEffectId, secondEffectId]);
      }).pipe(Effect.provide(layerWorker));
    }),
  );

  it.effect.each([
    { type: "terminal.cleanup" },
    { type: "provider-runtime.continue", sourceRunId: RunId.make("run:restart-replay") },
  ] as const)(
    "retires live provider effects and requeues $type after process loss",
    (replayRequest) =>
      Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const commandId = CommandId.make(
          `command:foundation-reclaim-running:${replayRequest.type}`,
        );
        yield* outbox.enqueue([
          {
            id: `effect:a-foundation-cancel-provider-turn:${replayRequest.type}`,
            commandId,
            threadId: ThreadId.make(`thread:foundation-reclaim-running:${replayRequest.type}`),
            request: {
              type: "provider-turn.start",
              runId: RunId.make(`run:foundation-reclaim-running:${replayRequest.type}`),
            },
          },
          {
            id: `effect:b-foundation-requeue-cleanup:${replayRequest.type}`,
            commandId,
            threadId: ThreadId.make(`thread:foundation-reclaim-cleanup:${replayRequest.type}`),
            request: replayRequest,
          },
        ]);
        assert.isTrue(Option.isSome(yield* outbox.claimNext({ workerId: "crashed-worker" })));
        assert.isTrue(Option.isSome(yield* outbox.claimNext({ workerId: "crashed-worker" })));
        assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, {
          cancelled: 1,
          requeued: 1,
        });
        const cancelled = yield* outbox.get(
          `effect:a-foundation-cancel-provider-turn:${replayRequest.type}`,
        );
        assert.isTrue(Option.isSome(cancelled));
        if (Option.isSome(cancelled)) assert.equal(cancelled.value.status, "cancelled");

        const reclaimed = yield* outbox.claimNext({
          workerId: "recovery-worker",
        });
        assert.isTrue(Option.isSome(reclaimed));
        if (Option.isSome(reclaimed)) {
          assert.equal(reclaimed.value.request.type, replayRequest.type);
          assert.equal(reclaimed.value.attemptCount, 2);
          yield* outbox.succeed({ effectId: reclaimed.value.id, workerId: "recovery-worker" });
        }
      }),
  );

  it.effect("atomically cancels stale runs and their process-bound effects", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-process-loss");
      const runId = RunId.make("run:foundation-process-loss");
      const commandId = CommandId.make("command:foundation-process-loss");
      const thread = makeThread(threadId, now);
      yield* eventSink.commitCommand({
        commandId,
        threadId,
        commandType: "foundation.process-loss",
        acceptedAt: now,
        events: [
          threadCreatedEvent({ id: "event:foundation-process-loss:thread", thread, now }),
          {
            id: EventId.make("event:foundation-process-loss:run"),
            type: "run.created",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("message:foundation-process-loss"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "starting",
              queuePosition: null,
              requestedAt: now,
              startedAt: null,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
        effects: [
          {
            id: "effect:foundation-process-loss",
            commandId,
            threadId,
            request: { type: "provider-turn.start", runId },
          },
        ],
      });
      assert.isTrue(Option.isSome(yield* outbox.claimNext({ workerId: "crashed-worker" })));

      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(ServerSettings.layerTest()),
        Effect.provideService(
          EffectWorker.OrchestrationEffectWorkerV2,
          EffectWorker.OrchestrationEffectWorkerV2.of({
            awaitWork: Effect.void,
            runRecoveryOnce: Effect.succeed(false),
            runOnce: () => Effect.succeed(false),
            nextClaimableAt: () => Effect.succeedNone,
            drain: () => Effect.succeed(0),
          }),
        ),
      );
      const first = yield* recovery.recover;
      assert.equal(first.terminalizedRuns, 1);
      assert.equal(first.retiredEffects, 1);
      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(projection.runs[0]?.status, "cancelled");
      const effect = yield* outbox.get("effect:foundation-process-loss");
      assert.isTrue(Option.isSome(effect));
      if (Option.isSome(effect)) assert.equal(effect.value.status, "cancelled");

      const second = yield* recovery.recover;
      assert.equal(second.terminalizedRuns, 0);
      assert.equal(second.retiredEffects, 0);
    }),
  );

  it.effect("allocates collision-free positions beyond 100 items and rebuilds equivalently", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionReplay.ProjectionReplay;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-many-items");
      const runId = RunId.make("run:foundation-many-items");
      const providerThreadId = ProviderThreadId.make("provider-thread:foundation-many-items");
      const thread = makeThread(threadId, now);
      const providerThreadEvent = {
        id: EventId.make("event:foundation-many-items:provider-thread"),
        type: "provider-thread.updated" as const,
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver: providerDriver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      } satisfies OrchestrationV2DomainEvent;
      const runEvent = {
        id: EventId.make("event:foundation-many-items:run"),
        type: "run.created" as const,
        threadId,
        runId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:foundation-many-items"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed" as const,
          queuePosition: null,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      } satisfies OrchestrationV2DomainEvent;
      const items = Array.from({ length: 151 }, (_, index) => ({
        id: TurnItemId.make(`turn-item:foundation-many-items:${index}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index % 3,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool" as const,
        toolName: `tool-${index}`,
        input: { index },
        output: { completed: true },
      }));
      const itemEvents = items.map(
        (item, index) =>
          ({
            id: EventId.make(`event:foundation-many-items:item:${index}`),
            type: "turn-item.updated",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: item,
          }) satisfies OrchestrationV2DomainEvent,
      );

      yield* eventSink.write({
        events: [
          threadCreatedEvent({ id: "event:foundation-many-items:thread", thread, now }),
          providerThreadEvent,
          runEvent,
          ...itemEvents,
        ],
      });
      const beforeUpdate = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(beforeUpdate.thread.activeProviderThreadId, providerThreadId);
      const ordinals = beforeUpdate.turnItems.map((item) => item.ordinal);
      assert.lengthOf(ordinals, 151);
      assert.equal(new Set(ordinals).size, 151);
      assert.isTrue(ordinals.every((ordinal) => ordinal > 1_000_000));
      assert.isTrue(
        ordinals.every((ordinal, index) => index === 0 || ordinal > ordinals[index - 1]!),
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:foundation-many-items:update"),
            type: "turn-item.updated",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: { ...items[0]!, ordinal: 99_999_999, title: "Updated" },
          },
        ],
      });
      const afterUpdate = yield* projectionStore.getThreadProjection(threadId);
      assert.equal(afterUpdate.turnItems[0]?.ordinal, ordinals[0]);
      assert.equal((yield* projectionStore.getThreadShell(threadId))?.itemCount, 151);
      assert.equal((yield* maintenance.verify).valid, true);

      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET payload_json = '{}'
        WHERE turn_item_id = ${items[75]!.id}
      `;
      const broken = yield* maintenance.verify;
      assert.isFalse(broken.valid);
      assert.deepEqual(broken.unreadableThreadIds, [threadId]);

      const rebuilt = yield* maintenance.rebuild;
      assert.isTrue(rebuilt.valid);
      assert.lengthOf((yield* projectionStore.getThreadProjection(threadId)).turnItems, 151);
      assert.equal((yield* projectionStore.getThreadShell(threadId))?.itemCount, 151);
    }),
  );
});

it.effect.each(["direct", "provider-batch", "cancel-provider-batch"] as const)(
  "publishes live events in commit order across concurrent writers with %s",
  (mode) =>
    Effect.gen(function* () {
      const firstCommitted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const layerPausingOutbox = Layer.effect(
        EffectOutbox.EffectOutboxV2,
        Effect.gen(function* () {
          const delegate = yield* EffectOutbox.EffectOutboxV2;
          return EffectOutbox.EffectOutboxV2.of({
            ...delegate,
            notifyAvailable: (count) =>
              Deferred.succeed(firstCommitted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst)),
                Effect.andThen(delegate.notifyAvailable(count)),
              ),
          });
        }),
      ).pipe(Layer.provide(layerEffectOutboxProvided));
      const layerEventSink = EventSink.layerFromStores.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerStoresProvided,
            layerPausingOutbox,
            layerCommandReceiptStoreProvided,
            ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
            TurnItemPositionStore.layer.pipe(Layer.provide(layerDatabase)),
            ThreadViewers.layer,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const first = makeThread(ThreadId.make("thread:foundation-publish-order:first"), now);
        const second = makeThread(ThreadId.make("thread:foundation-publish-order:second"), now);
        const published = yield* eventSink
          .stream({ afterSequence: yield* eventSink.latestSequence() })
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }));

        const firstWrite = yield* eventSink
          .writeWithEffects({
            events: [
              threadCreatedEvent({
                id: "event:foundation-publish-order:first",
                thread: first,
                now,
              }),
            ],
            effects: [
              {
                id: "effect:foundation-publish-order:first",
                commandId: CommandId.make("command:foundation-publish-order:first"),
                threadId: first.id,
                request: { type: "terminal.cleanup" },
              },
            ],
          })
          .pipe(
            (write) => (mode === "direct" ? write : eventSink.withProviderBatch(write)),
            Effect.forkScoped,
          );
        yield* Deferred.await(firstCommitted);
        const secondWrite = yield* eventSink
          .write({
            events: [
              threadCreatedEvent({
                id: "event:foundation-publish-order:second",
                thread: second,
                now,
              }),
            ],
          })
          .pipe(
            Effect.provideService(Scheduler.MaxOpsBeforeYield, Number.POSITIVE_INFINITY),
            Effect.forkScoped,
          );
        yield* Effect.yieldNow;
        const interrupted =
          mode === "cancel-provider-batch"
            ? yield* Fiber.interrupt(firstWrite).pipe(Effect.forkScoped({ startImmediately: true }))
            : undefined;
        yield* Deferred.succeed(releaseFirst, undefined);
        if (interrupted !== undefined) yield* Fiber.join(interrupted);
        else yield* Fiber.join(firstWrite);
        yield* Fiber.join(secondWrite);

        const sequences = Array.from(yield* Fiber.join(published), (stored) => stored.sequence);
        assert.deepEqual(
          sequences,
          [...sequences].sort((left, right) => left - right),
        );
      }).pipe(Effect.provide(layerEventSink));
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each(["cancel transaction", "fail transaction", "cancel publication"] as const)(
  "preserves event consistency and allows later writes after %s",
  (scenario) =>
    Effect.gen(function* () {
      const paused = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const committed = scenario === "cancel publication";
      const pause = Deferred.succeed(paused, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const layerPausingOutbox = Layer.effect(
        EffectOutbox.EffectOutboxV2,
        Effect.gen(function* () {
          const delegate = yield* EffectOutbox.EffectOutboxV2;
          return EffectOutbox.EffectOutboxV2.of({
            ...delegate,
            enqueue: (effects) =>
              delegate
                .enqueue(effects)
                .pipe(
                  Effect.andThen(!committed && effects.length > 0 ? pause : Effect.void),
                  Effect.andThen(
                    scenario === "fail transaction" && effects.length > 0
                      ? Effect.die("Injected transaction failure")
                      : Effect.void,
                  ),
                ),
            notifyAvailable: (count) =>
              (committed ? pause : Effect.void).pipe(
                Effect.andThen(delegate.notifyAvailable(count)),
              ),
          });
        }),
      ).pipe(Layer.provide(layerEffectOutboxProvided));
      const layerEventSink = EventSink.layerFromStores.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerStoresProvided,
            layerPausingOutbox,
            layerCommandReceiptStoreProvided,
            ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
            TurnItemPositionStore.layer.pipe(Layer.provide(layerDatabase)),
            ThreadViewers.layer,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const now = yield* DateTime.now;
        const first = makeThread(ThreadId.make("thread:interrupted-publish:first"), now);
        const marker = makeThread(ThreadId.make("thread:interrupted-publish:marker"), now);
        const published = yield* eventSink
          .stream({ afterSequence: yield* eventSink.latestSequence() })
          .pipe(
            Stream.takeUntil((stored) => stored.event.threadId === marker.id),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          );
        const writer = yield* eventSink
          .writeWithEffects({
            events: [
              threadCreatedEvent({ id: "event:interrupted-publish:first", thread: first, now }),
            ],
            effects: [
              {
                id: "effect:interrupted-publish:first",
                commandId: CommandId.make("command:interrupted-publish:first"),
                threadId: first.id,
                request: { type: "terminal.cleanup" },
              },
            ],
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(paused);
        if (scenario !== "fail transaction") writer.interruptUnsafe();
        if (scenario !== "cancel transaction") yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.await(writer))._tag, "Failure");
        assert.equal(
          (yield* projections.getThreadShell(first.id))?.id ?? null,
          committed ? first.id : null,
        );
        assert.equal(
          Option.isSome(yield* outbox.get("effect:interrupted-publish:first")),
          committed,
        );
        yield* eventSink.write({
          events: [
            threadCreatedEvent({ id: "event:interrupted-publish:marker", thread: marker, now }),
          ],
        });
        assert.deepEqual(
          Array.from(yield* Fiber.join(published), (stored) => stored.event.threadId),
          committed ? [first.id, marker.id] : [marker.id],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(layerEventSink, layerStoresProvided, layerEffectOutboxProvided),
        ),
      );
    }).pipe(Effect.provide(layerDatabase)),
);
