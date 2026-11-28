import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  EventId,
  NodeId,
  ORCHESTRATION_V2_WS_METHODS,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@ankielcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationThreadSnapshot,
  decodeOrDiscardOrchestrationCache,
} from "../platform/orchestrationCache.ts";
import * as RpcSession from "../rpc/session.ts";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { onThreadRequestsResolved, type ThreadRequestsResolved } from "./threadRequests.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  type EnvironmentThreadState,
  type ThreadSnapshotLoadResult,
} from "./threads.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = v2ThreadId;
const CACHED_SNAPSHOT_SEQUENCE = 7;
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const BASE_PROJECTION: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, title: "Cached thread" },
};

const TEST_DEFECT = { defect: "Malformed snapshot" } as const;

type TestThreadInput = OrchestrationV2ThreadStreamItem | Error | typeof TEST_DEFECT;

function testSession(
  client: WsRpcProtocolClient,
  initialConfig: Effect.Effect<object> = Effect.succeed({}),
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: initialConfig as never,
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationV2ThreadProjection;
  readonly cachedHistory?: {
    readonly historyCursor: string | null;
    readonly hasMoreHistory: boolean;
    readonly latestLocalTurnOrdinal?: number | null;
  };
  readonly httpSnapshot?: ThreadSnapshotLoadResult;
  /** Answers per load call; the last one repeats. Overrides `httpSnapshot`. */
  readonly httpSnapshots?: readonly ThreadSnapshotLoadResult[];
  /** The test sends the completion marker itself instead of the fake server sending it first. */
  readonly completionMarker?: boolean;
  readonly resumeCache?: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]>;
  readonly loadCached?: ReturnType<Persistence.EnvironmentCacheStore["Service"]["loadThread"]>;
  readonly saveThread?: Persistence.EnvironmentCacheStore["Service"]["saveThread"];
  readonly historyPaging?: "enabled" | "no-http" | "no-controller";
  readonly socketSnapshots?: true;
  readonly initialConfig?: Effect.Effect<object>;
  readonly historyHttpClient?: HttpClient.HttpClient;
  readonly getTurnItem?: (input: {
    readonly itemId: TurnItemId;
  }) => Effect.Effect<{ readonly item: OrchestrationV2TurnItem | null }>;
  readonly streamFor?: (
    subscription: number,
  ) => Stream.Stream<OrchestrationV2ThreadStreamItem> | undefined;
}) {
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* SubscriptionRef.make(0);
  const loaderCalls = yield* Ref.make(0);
  const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
  const lastRequestCompletionMarker = yield* Ref.make(false);
  const lastAcceptBoundedSnapshot = yield* Ref.make<true | undefined>(undefined);
  const lastAcceptCompactTurnItems = yield* Ref.make<true | undefined>(undefined);
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadDetailSnapshot>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
    Stream.fromQueue(queue).pipe(
      Stream.mapEffect((input) =>
        input === TEST_DEFECT
          ? Effect.die(input)
          : input instanceof Error
            ? Effect.fail(input)
            : Effect.succeed(input),
      ),
    );
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: {
      readonly afterSequence?: number;
      readonly requestCompletionMarker?: true;
      readonly acceptBoundedSnapshot?: true;
      readonly acceptCompactTurnItems?: true;
    }) =>
      Stream.unwrap(
        Effect.all([
          Ref.set(lastSubscribeAfterSequence, input.afterSequence),
          Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker === true),
          Ref.set(lastAcceptBoundedSnapshot, input.acceptBoundedSnapshot),
          Ref.set(lastAcceptCompactTurnItems, input.acceptCompactTurnItems),
        ]).pipe(
          Effect.andThen(SubscriptionRef.updateAndGet(subscriptionCount, (count) => count + 1)),
          Effect.map(
            (count) =>
              options?.streamFor?.(count) ??
              (options?.completionMarker === true
                ? streamFrom(inputs)
                : Stream.concat(Stream.make(synchronized()), streamFrom(inputs))),
          ),
        ),
      ),
    [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: (input: { readonly itemId: TurnItemId }) =>
      options?.getTurnItem?.(input) ?? Effect.die("Unexpected getTurnItem request"),
  } as unknown as WsRpcProtocolClient;
  const sessionConfig =
    options?.initialConfig ??
    Effect.succeed(options?.socketSnapshots ? { threadSnapshotPagination: true } : {});
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(testSession(client, sessionConfig)),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.ThreadSnapshotLoader.of({
    load: (_prepared, threadId) =>
      Ref.updateAndGet(loaderCalls, (count) => count + 1).pipe(
        Effect.map((count) =>
          threadId === THREAD_ID
            ? (options?.httpSnapshots?.[Math.min(count, options.httpSnapshots.length) - 1] ??
              options?.httpSnapshot ??
              ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult))
            : ({ _tag: "unavailable" } satisfies ThreadSnapshotLoadResult),
        ),
      ),
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      options?.loadCached ??
      Effect.succeed(
        threadId === THREAD_ID && options?.cached !== undefined
          ? Option.some({
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
              projection: options.cached,
              ...(options.cachedHistory === undefined
                ? {}
                : {
                    historyCursor: options.cachedHistory.historyCursor,
                    hasMoreHistory: options.cachedHistory.hasMoreHistory,
                    ...(options.cachedHistory.latestLocalTurnOrdinal === undefined
                      ? {}
                      : {
                          latestLocalTurnOrdinal: options.cachedHistory.latestLocalTurnOrdinal,
                        }),
                  }),
            })
          : Option.none(),
      ),
    saveThread: (environmentId, thread) =>
      Ref.update(savedThreads, (current) => [...current, thread]).pipe(
        Effect.andThen(options?.saveThread?.(environmentId, thread) ?? Effect.void),
      ),
    removeThread: (_environmentId, threadId) =>
      Ref.update(removedThreads, (current) => [...current, threadId]),
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  let makeThreadState = makeEnvironmentThreadState(THREAD_ID, options?.resumeCache).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader.ThreadSnapshotLoader, snapshotLoader),
    Effect.provideService(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
    ),
  );
  if (options?.historyPaging !== "no-http") {
    makeThreadState = makeThreadState.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        options?.historyHttpClient ??
          HttpClient.make(() => Effect.die("Unexpected history HTTP request")),
      ),
    );
  }
  const historyController = yield* ThreadHistoryController.ThreadHistoryController.pipe(
    Effect.provide(ThreadHistoryController.layer),
  );
  if (options?.historyPaging !== "no-controller") {
    makeThreadState = makeThreadState.pipe(
      Effect.provideService(ThreadHistoryController.ThreadHistoryController, historyController),
    );
  }
  const threadState = yield* makeThreadState;
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) =>
      Ref.set(latest, state).pipe(Effect.andThen(Queue.offer(observed, state))),
    ),
    Effect.forkScoped,
  );

  return {
    threadState,
    loadWork: (anchorId: string) =>
      historyController.loadEarlier(TARGET.environmentId, THREAD_ID, undefined, anchorId),
    loadEarlier: (throughEntryId?: string) =>
      historyController.loadEarlier(TARGET.environmentId, THREAD_ID, throughEntryId),
    reconcilePendingWork: historyController.reconcilePendingWork(TARGET.environmentId, THREAD_ID),
    inputs,
    observed,
    latest,
    retryCount,
    subscriptionCount,
    loaderCalls,
    lastSubscribeAfterSequence,
    lastRequestCompletionMarker,
    lastAcceptBoundedSnapshot,
    lastAcceptCompactTurnItems,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    wakeups,
    replaceSession: SubscriptionRef.set(
      supervisorSession,
      Option.some(testSession(client, sessionConfig)),
    ),
  };
});

const snapshot = (
  projection: OrchestrationV2ThreadProjection,
  snapshotSequence = 1,
): Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "snapshot" }> => ({
  kind: "snapshot",
  snapshotSequence,
  projection,
});

const synchronized = (): OrchestrationV2ThreadStreamItem => ({ kind: "synchronized" });

const PENDING_QUESTION = {
  id: RuntimeRequestId.make("question"),
  nodeId: NodeId.make("question-node"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input" as const,
  status: "pending" as const,
  responseCapability: { type: "message" as const },
  createdAt: v2Now,
  resolvedAt: null,
};

const QUESTION_CARD: OrchestrationV2TurnItem = {
  id: TurnItemId.make("question-card"),
  threadId: THREAD_ID,
  runId: null,
  nodeId: PENDING_QUESTION.nodeId,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: v2Now,
  completedAt: null,
  updatedAt: v2Now,
  type: "user_input_request",
  requestId: PENDING_QUESTION.id,
  questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [] }],
};

const PROJECTION_WITH_QUESTION = {
  ...BASE_PROJECTION,
  runtimeRequests: [PENDING_QUESTION],
  turnItems: [QUESTION_CARD],
};

const questionResolved = (sequence: number): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make("event-request"),
    type: "runtime-request.updated",
    threadId: THREAD_ID,
    occurredAt: v2Now,
    payload: { ...PENDING_QUESTION, status: "resolved", resolvedAt: v2Now },
  },
});

const titleUpdated = (title: string, sequence = 2): OrchestrationV2ThreadStreamItem => {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make("event-title"),
      type: "thread.metadata-updated",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...v2Projection.thread, title, updatedAt: occurredAt },
    },
  };
};

const deleted = (sequence = 3): OrchestrationV2ThreadStreamItem => {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T02:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make("event-deleted"),
      type: "thread.deleted",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...v2Projection.thread, updatedAt: occurredAt, deletedAt: occurredAt },
    },
  };
};

describe("EnvironmentThreads", () => {
  it.effect.each([
    ["disk", false],
    ["retained", false],
    ["disk", true],
    ["retained", true],
  ] as const)(
    "recovers a %s cache only when its pending question card is missing: %s",
    ([cacheKind, hasCard]) =>
      Effect.gen(function* () {
        const projection = {
          ...PROJECTION_WITH_QUESTION,
          turnItems: hasCard ? [QUESTION_CARD] : [],
        };
        const schema = Schema.fromJsonString(StoredOrchestrationThreadSnapshot);
        const encoded = yield* Schema.encodeEffect(schema)({
          schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
          environmentId: TARGET.environmentId,
          threadId: THREAD_ID,
          snapshot: { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, projection },
        });
        const stored = yield* Schema.decodeEffect(schema)(encoded);
        const h = yield* makeHarness({
          loadCached: Effect.succeedSome(stored.snapshot),
          ...(cacheKind === "retained"
            ? {
                resumeCache: {
                  owner: undefined,
                  snapshot: {
                    state: {
                      ...EMPTY_ENVIRONMENT_THREAD_STATE,
                      data: Option.some(projection),
                      status: "live",
                    },
                    sequence: CACHED_SNAPSHOT_SEQUENCE,
                    persisted: true,
                  },
                },
              }
            : {}),
          httpSnapshot: {
            _tag: "present",
            snapshot: {
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
              projection: PROJECTION_WITH_QUESTION,
            },
          },
          completionMarker: true,
        });
        yield* Queue.offer(h.inputs, synchronized());
        const state = yield* awaitThreadState(h.observed, (value) => value.status === "live");
        expect(yield* Ref.get(h.loaderCalls)).toBe(hasCard ? 0 : 1);
        expect(Option.getOrThrow(state.data)).toEqual(PROJECTION_WITH_QUESTION);
        expect(yield* Ref.get(h.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      }),
  );

  it.effect("discards an oversized version-4 cache and requests a fresh bounded snapshot", () =>
    Effect.gen(function* () {
      const item: OrchestrationV2TurnItem = {
        id: TurnItemId.make("old-unbounded-cache-item"),
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: BASE_PROJECTION.updatedAt,
        completedAt: BASE_PROJECTION.updatedAt,
        updatedAt: BASE_PROJECTION.updatedAt,
        type: "system_notice",
        message: "x".repeat(1_100_000),
      };
      const schema = Schema.fromJsonString(StoredOrchestrationThreadSnapshot);
      const encoded = yield* Schema.encodeEffect(schema)({
        schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        environmentId: TARGET.environmentId,
        threadId: THREAD_ID,
        snapshot: {
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          projection: { ...BASE_PROJECTION, turnItems: [item] },
        },
      });
      const stale = encoded.replace(
        `"schemaVersion":${ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION}`,
        '"schemaVersion":4',
      );
      let discarded = false;
      const h = yield* makeHarness({
        loadCached: decodeOrDiscardOrchestrationCache(
          Schema.decodeEffect(schema)(stale).pipe(
            Effect.map((stored) => Option.some(stored.snapshot)),
          ),
          Effect.sync(() => {
            discarded = true;
          }),
        ),
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, projection: BASE_PROJECTION },
          history: { historyCursor: "fresh-bounded-cursor", hasMoreHistory: true },
        },
      });
      const state = yield* awaitThreadState(h.observed, (value) => value.status === "live");
      expect(discarded).toBe(true);
      expect(yield* Ref.get(h.loaderCalls)).toBe(1);
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(state.history.historyCursor).toBe("fresh-bounded-cursor");
      expect(state.history.hasMoreHistory).toBe(true);
    }),
  );

  it.effect.each(["read failure", "cache miss"] as const)(
    "loads the server thread after a %s",
    (scenario) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          loadCached:
            scenario === "cache miss"
              ? Effect.succeedNone
              : Effect.fail(
                  new Persistence.ConnectionPersistenceError({
                    operation: "load-thread",
                    message: "The database connection is closing.",
                  }),
                ),
          httpSnapshot: {
            _tag: "present",
            snapshot: { snapshotSequence: 7, projection: BASE_PROJECTION },
          },
        });

        const state = yield* awaitThreadState(h.observed, (value) => value.status === "live");
        expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
        expect(yield* Ref.get(h.loaderCalls)).toBe(1);
        expect(yield* SubscriptionRef.get(h.subscriptionCount)).toBe(1);
      }),
  );

  it.effect("flushes newer data after an older background write completes", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const written = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const saved = yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness({
            cached: BASE_PROJECTION,
            saveThread: (_environmentId, snapshot) =>
              snapshot.snapshotSequence === 8
                ? Deferred.succeed(writing, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(Deferred.succeed(written, undefined)),
                  )
                : Effect.void,
          });
          yield* Queue.offer(h.inputs, titleUpdated("First update", 8));
          yield* awaitThreadState(
            h.observed,
            (value) => Option.getOrNull(value.data)?.thread.title === "First update",
          );
          yield* TestClock.adjust("500 millis");
          yield* Deferred.await(writing);
          yield* Queue.offer(h.inputs, titleUpdated("Newer update", 9));
          yield* awaitThreadState(
            h.observed,
            (value) => Option.getOrNull(value.data)?.thread.title === "Newer update",
          );
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(written);
          return h.savedThreads;
        }),
      );
      expect(
        (yield* Ref.get(saved)).map((snapshot) => [
          snapshot.snapshotSequence,
          snapshot.projection.thread.title,
        ]),
      ).toEqual([
        [8, "First update"],
        [9, "Newer update"],
      ]);
    }),
  );

  it.effect("does not resume past a canceled event whose data was not applied", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const first = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            projection: BASE_PROJECTION,
            snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          },
        },
        resumeCache,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* awaitThreadState(first.observed, (value) => value.status === "live");
      const applying = yield* Deferred.make<void>();
      const update = titleUpdated("Not applied", 8);
      if (update.kind !== "event") return yield* Effect.die("Expected an event");
      let sequenceReads = 0;
      Object.defineProperty(update, "sequence", {
        get: () => {
          if (++sequenceReads === 2) Deferred.doneUnsafe(applying, Exit.void);
          return 8;
        },
      });
      yield* first.threadState.semaphore.take(1);
      yield* Queue.offer(first.inputs, update);
      yield* Deferred.await(applying);
      yield* Scope.close(scope, Exit.void);
      yield* first.threadState.semaphore.release(1);

      const resumed = yield* makeHarness({ resumeCache });
      const state = yield* awaitThreadState(resumed.observed, (value) => value.status === "live");
      expect(Option.getOrThrow(state.data).thread.title).toBe(BASE_PROJECTION.thread.title);
      expect(yield* Ref.get(resumed.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(first.savedThreads)).toEqual([
        {
          projection: BASE_PROJECTION,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          historyCursor: null,
          hasMoreHistory: false,
          latestLocalTurnOrdinal: null,
        },
      ]);
    }),
  );

  it.effect("prevents an old scope from replacing its successor's cached data", () =>
    Effect.gen(function* () {
      const announced: ThreadRequestsResolved[] = [];
      yield* Effect.acquireRelease(
        Effect.sync(() => onThreadRequestsResolved((event) => announced.push(event))),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const oldScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const old = yield* makeHarness({
        cached: PROJECTION_WITH_QUESTION,
        resumeCache,
      }).pipe(Effect.provideService(Scope.Scope, oldScope));
      yield* awaitThreadState(old.observed, (value) => value.status === "live");
      const successor = yield* makeHarness({ resumeCache });
      yield* Queue.offer(successor.inputs, titleUpdated("Successor title", 10));
      yield* awaitThreadState(
        successor.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Successor title",
      );
      announced.length = 0;
      yield* Queue.offerAll(old.inputs, [questionResolved(8), titleUpdated("Old scope title", 9)]);
      yield* awaitThreadState(
        old.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Old scope title",
      );
      yield* Scope.close(oldScope, Exit.void);

      // Draft pruners would delete the answer the successor still waits on.
      expect(announced).toEqual([]);
      expect(resumeCache.snapshot?.sequence).toBe(10);
      expect(Option.getOrThrow(resumeCache.snapshot!.state.data).thread.title).toBe(
        "Successor title",
      );
      expect(yield* Ref.get(old.savedThreads)).toEqual([]);
    }),
  );

  it.effect("does not let a delayed cache read replace an initialized successor", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const loading = yield* Deferred.make<void>();
      const response = yield* Deferred.make<Option.Option<OrchestrationV2ThreadDetailSnapshot>>();
      const oldFiber = yield* makeHarness({
        resumeCache,
        loadCached: Deferred.succeed(loading, undefined).pipe(
          Effect.andThen(Deferred.await(response)),
        ),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(loading);
      const successor = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache });
      yield* awaitThreadState(successor.observed, (value) => value.status === "live");
      yield* Deferred.succeed(
        response,
        Option.some({
          snapshotSequence: 3,
          projection: {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Old disk data" },
          },
        }),
      );
      const old = yield* Fiber.join(oldFiber);
      yield* awaitThreadState(old.observed, (value) => value.status === "live");

      expect(resumeCache.snapshot?.sequence).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(Option.getOrThrow(resumeCache.snapshot!.state.data).thread.title).toBe(
        BASE_PROJECTION.thread.title,
      );
    }),
  );

  it.effect("does not let an old deletion remove its successor's persisted cache", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const old = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache });
      yield* awaitThreadState(old.observed, (value) => value.status === "live");
      const successor = yield* makeHarness({ resumeCache });
      yield* Queue.offer(successor.inputs, titleUpdated("Successor title", 9));
      yield* awaitThreadState(
        successor.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Successor title",
      );
      const update = deleted();
      if (update.kind !== "event") return yield* Effect.die("Expected an event");
      yield* Queue.offer(old.inputs, { ...update, sequence: 8 });
      yield* awaitThreadState(old.observed, (value) => value.status === "deleted");

      expect(resumeCache.snapshot?.sequence).toBe(9);
      expect(yield* Ref.get(old.removedThreads)).toEqual([]);
    }),
  );

  it.effect("retains a deletion instead of restoring the old disk snapshot", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache });
          const update = deleted();
          if (update.kind !== "event") return yield* Effect.die("Expected an event");
          yield* Queue.offer(first.inputs, { ...update, sequence: 8 });
          yield* awaitThreadState(first.observed, (value) => value.status === "deleted");
        }),
      );
      const resumed = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache });
      const state = yield* awaitThreadState(
        resumed.observed,
        (value) => value.status === "deleted",
      );
      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(resumed.loaderCalls)).toBe(0);
    }),
  );

  it.effect("asks the server again after an HTTP miss, since the thread may not exist yet", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeHarness({ httpSnapshot: { _tag: "missing" }, resumeCache });
          yield* awaitThreadState(first.observed, (value) => value.status === "deleted");
        }),
      );
      const resumed = yield* makeHarness({
        resumeCache,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, projection: BASE_PROJECTION },
        },
      });
      const state = yield* awaitThreadState(resumed.observed, (value) => value.status === "live");
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(resumed.loaderCalls)).toBe(1);
    }),
  );

  it.effect("keeps asking a mounted thread over HTTP after a miss until it exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshots: [
          { _tag: "missing" },
          { _tag: "missing" },
          {
            _tag: "present",
            snapshot: { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, projection: BASE_PROJECTION },
          },
        ],
      });
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");
      yield* TestClock.adjust("250 millis");
      yield* TestClock.adjust("500 millis");
      const state = yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(3);
    }),
  );

  it.effect.each([
    // The HTTP retry decides, so a missing thread never flashes an error.
    {
      label: "a socket-only open asks HTTP",
      socketSnapshots: true,
      httpSnapshot: { _tag: "missing" },
      failure: new Error("Thread not found"),
      status: "deleted",
      loads: [0, 1],
    },
    // A defect never retries on its own, so the socket-only open resubscribes once.
    {
      label: "a socket-only open that hits a defect asks HTTP",
      socketSnapshots: true,
      httpSnapshot: { _tag: "missing" },
      failure: TEST_DEFECT,
      status: "deleted",
      loads: [0, 1],
    },
    // Authorization failures are never retried, so the error must show at once.
    {
      label: "a socket-only open shows an authorization error",
      socketSnapshots: true,
      httpSnapshot: { _tag: "missing" },
      failure: new EnvironmentAuthorizationError({
        message: "Not allowed",
        requiredScope: "orchestration:read",
      }),
      status: "empty",
      loads: [0, 0],
    },
    // HTTP already answered this attempt, so the error shows before the usual retry.
    {
      label: "an HTTP open shows the error",
      socketSnapshots: undefined,
      httpSnapshot: { _tag: "unavailable" },
      failure: new Error("Socket closed"),
      status: "empty",
      loads: [1, 2],
    },
  ] as const)(
    "after a cold open fails, $label",
    ({ socketSnapshots, httpSnapshot, failure, status, loads: [before, after] }) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          httpSnapshot,
          ...(socketSnapshots ? { socketSnapshots } : {}),
        });
        yield* SubscriptionRef.changes(harness.subscriptionCount).pipe(
          Stream.filter((count) => count === 1),
          Stream.runHead,
        );
        expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);
        expect(yield* Ref.get(harness.loaderCalls)).toBe(before);

        yield* Queue.offer(harness.inputs, failure);
        yield* TestClock.adjust("250 millis");
        const settled = yield* awaitThreadState(
          harness.observed,
          (value) => value.status === "deleted" || Option.isSome(value.error),
        );
        expect(settled.status).toBe(status);
        expect(yield* Ref.get(harness.loaderCalls)).toBe(after);
      }),
  );

  it.effect("retries a defective socket-only open over HTTP only once", () =>
    Effect.gen(function* () {
      let configReads = 0;
      const harness = yield* makeHarness({
        httpSnapshot: { _tag: "missing" },
        // The retry's config read dies too, so a stale flag would resubscribe without backing off.
        initialConfig: Effect.suspend(() =>
          ++configReads === 1
            ? Effect.succeed({ threadSnapshotPagination: true })
            : Effect.die("Config lost"),
        ),
      });
      yield* SubscriptionRef.changes(harness.subscriptionCount).pipe(
        Stream.filter((count) => count === 1),
        Stream.runHead,
      );

      yield* Queue.offer(harness.inputs, TEST_DEFECT);
      const settled = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );
      expect(settled.status).toBe("empty");
      expect(configReads).toBe(2);
    }),
  );

  it.effect("asks HTTP when a socket-only open loses its session before any data", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: { _tag: "missing" },
        socketSnapshots: true,
      });
      yield* SubscriptionRef.changes(harness.subscriptionCount).pipe(
        Stream.filter((count) => count === 1),
        Stream.runHead,
      );
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);

      // A timed-out session never reaches onExpectedFailure.
      yield* harness.replaceSession;
      const settled = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );
      expect(settled.status).toBe("deleted");
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
    }),
  );

  it.effect("resumes a warm cache via afterSequence without an HTTP fetch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });

      yield* Queue.offer(harness.inputs, titleUpdated("Live title", CACHED_SNAPSHOT_SEQUENCE + 1));
      const live = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      // Readers compare this to a command's commit sequence; it moves with the data it describes.
      expect(live.sequence).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );

  it.effect("preserves data after a domain failure and resumes on a replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));

      const state = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(Option.getOrThrow(state.error)).toBe("stream failed");
      expect(yield* Ref.get(harness.retryCount)).toBe(0);

      yield* harness.replaceSession;
      yield* SubscriptionRef.changes(harness.subscriptionCount).pipe(
        Stream.filter((count) => count >= 2),
        Stream.runHead,
      );
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Recovered thread" },
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Recovered thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* SubscriptionRef.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect(
    "resubscribes after a snapshot decode defect ends the thread subscription (#23041)",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ httpSnapshot: { _tag: "unavailable" } });
        yield* SubscriptionRef.changes(harness.subscriptionCount).pipe(
          Stream.filter((count) => count >= 1),
          Stream.runHead,
        );
        yield* Queue.offer(harness.inputs, TEST_DEFECT);
        const failed = yield* awaitThreadState(harness.observed, (value) =>
          Option.isSome(value.error),
        );
        expect(failed.status).toBe("empty");
        expect(Option.getOrThrow(failed.error)).toBe("Could not synchronize the thread.");

        yield* TestClock.adjust("60 seconds");
        expect(yield* SubscriptionRef.get(harness.subscriptionCount)).toBe(2);

        yield* Queue.offer(
          harness.inputs,
          snapshot({
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Recovered thread" },
          }),
        );
        const recovered = yield* awaitThreadState(
          harness.observed,
          (value) =>
            value.status === "live" &&
            Option.isSome(value.data) &&
            value.data.value.thread.title === "Recovered thread",
        );
        expect(Option.isNone(recovered.error)).toBe(true);
      }),
  );

  it.effect("reloads the full snapshot after a resumed replay hits a defect", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      const awaitSubscriptions = (count: number) =>
        SubscriptionRef.changes(harness.subscriptionCount).pipe(
          Stream.filter((value) => value >= count),
          Stream.runHead,
        );
      yield* awaitSubscriptions(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);

      // The cursor that died would die again, so the retry drops it at once, without an error.
      yield* Queue.offer(harness.inputs, TEST_DEFECT);
      yield* awaitSubscriptions(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBeUndefined();
      expect(Option.isNone((yield* Ref.get(harness.latest)).error)).toBe(true);

      // A failed reload backs off, still from the snapshot.
      yield* Queue.offer(harness.inputs, TEST_DEFECT);
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.error));
      yield* TestClock.adjust("60 seconds");
      yield* awaitSubscriptions(3);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBeUndefined();

      yield* Queue.offerAll(harness.inputs, [
        snapshot(
          { ...BASE_PROJECTION, thread: { ...BASE_PROJECTION.thread, title: "Reloaded thread" } },
          CACHED_SNAPSHOT_SEQUENCE + 5,
        ),
        synchronized(),
      ]);
      const live = yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      expect(Option.isNone(live.error)).toBe(true);
      expect(Option.getOrThrow(live.data).thread.title).toBe("Reloaded thread");

      yield* harness.replaceSession;
      yield* awaitSubscriptions(4);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 5);
    }),
  );
});
