import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@ankielcode/contracts";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const mockEventSink = (implementation: Partial<EventSink.EventSinkV2["Service"]>) =>
  Layer.mock(EventSink.EventSinkV2)({
    consumeProviderEvents: (source, process, after) =>
      source.pipe(
        Stream.mapEffect((event) => process(event).pipe(Effect.andThen(after))),
        Stream.takeUntil(Boolean),
        Stream.runDrain,
      ),
    ...implementation,
  });

const driver = ProviderDriverKind.make("codex");
const rootAppThread = (id: ThreadId) =>
  ({
    id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  }) as OrchestrationV2AppThread;

const layerTurnItemPositionsTest = Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
  allocate: () => Effect.succeed(1),
});

const layerRunExecutionTest = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layerEmpty,
      PreviewAgentActivity.layer,
      Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
      layerTurnItemPositionsTest,
      mockEventSink({}),
      IdAllocator.layer,
      ThreadCommandExecutor.layer,
      Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
        ingestNormalized: () => Effect.succeed([]),
      }),
      ServerSettings.layerTest(),
    ),
  ),
);

it.effect("routes shared-runtime events only to their owning root run", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const first: RunExecutionService.ProviderEventRouteIdentity = {
      threadId: ThreadId.make("thread:shared-runtime:first"),
      runId: RunId.make("run:shared-runtime:first"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:first"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:first"),
    };
    const second: RunExecutionService.ProviderEventRouteIdentity = {
      threadId: ThreadId.make("thread:shared-runtime:second"),
      runId: RunId.make("run:shared-runtime:second"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:second"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:second"),
    };
    const firstTurnId = ProviderTurnId.make("provider-turn:shared-runtime:first");
    const turnEvent: ProviderAdapter.ProviderAdapterV2Event = {
      type: "provider_turn.updated",
      driver,
      threadId: first.threadId,
      providerTurn: {
        id: firstTurnId,
        providerThreadId: first.providerThreadId,
        nodeId: NodeId.make("node:shared-runtime:first"),
        runAttemptId: first.attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    };
    const messageEvent: ProviderAdapter.ProviderAdapterV2Event = {
      type: "message.updated",
      driver,
      message: {
        createdBy: "agent",
        creationSource: "provider",
        id: MessageId.make("message:shared-runtime:first"),
        threadId: first.threadId,
        runId: first.runId,
        nodeId: NodeId.make("node:shared-runtime:first"),
        role: "assistant",
        text: "first only",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    };
    const terminalEvent: ProviderAdapter.ProviderAdapterV2Event = {
      type: "turn.terminal",
      driver,
      providerThreadId: first.providerThreadId,
      providerTurnId: firstTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    };

    const firstInitial = RunExecutionService.makeProviderEventRoutingState({
      identity: first,
      providerTurnId: null,
    });
    const secondInitial = RunExecutionService.makeProviderEventRoutingState({
      identity: second,
      providerTurnId: null,
    });
    const [firstTurnAccepted, firstAfterTurn] = RunExecutionService.routeProviderEvent(
      turnEvent,
      first,
      firstInitial,
    );
    const [secondTurnAccepted, secondAfterTurn] = RunExecutionService.routeProviderEvent(
      turnEvent,
      second,
      secondInitial,
    );

    assert.isTrue(firstTurnAccepted);
    assert.isFalse(secondTurnAccepted);
    assert.isTrue(RunExecutionService.routeProviderEvent(messageEvent, first, firstAfterTurn)[0]);
    assert.isFalse(
      RunExecutionService.routeProviderEvent(messageEvent, second, secondAfterTurn)[0],
    );
    assert.isTrue(RunExecutionService.routeProviderEvent(terminalEvent, first, firstAfterTurn)[0]);
    assert.isFalse(
      RunExecutionService.routeProviderEvent(terminalEvent, second, secondAfterTurn)[0],
    );
  }),
);

it("does not route a superseded attempt through a reused provider thread", () => {
  const threadId = ThreadId.make("thread:shared-runtime:restart");
  const providerThreadId = ProviderThreadId.make("provider-thread:shared-runtime:restart");
  const oldAttempt: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:shared-runtime:restart"),
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:old"),
    providerThreadId,
  };
  const newAttempt: RunExecutionService.ProviderEventRouteIdentity = {
    ...oldAttempt,
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:new"),
  };
  const oldTurnEvent: ProviderAdapter.ProviderAdapterV2Event = {
    type: "provider_turn.updated",
    driver,
    threadId,
    providerTurn: {
      id: ProviderTurnId.make("provider-turn:shared-runtime:restart:old"),
      providerThreadId,
      nodeId: NodeId.make("node:shared-runtime:restart:old"),
      runAttemptId: oldAttempt.attemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status: "interrupted",
      startedAt: null,
      completedAt: null,
    },
  };

  const newState = RunExecutionService.makeProviderEventRoutingState({
    identity: newAttempt,
    providerTurnId: null,
  });
  assert.isFalse(RunExecutionService.routeProviderEvent(oldTurnEvent, newAttempt, newState)[0]);
});

it.effect("rechecks run ownership immediately before calling the provider", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const guardCalls = yield* Ref.make(0);
    const providerStarts = yield* Ref.make(0);
    const threadId = ThreadId.make("thread:run-execution-start-guard");
    const runId = RunId.make("run:run-execution-start-guard");
    const attemptId = RunAttemptId.make("attempt:run-execution-start-guard");
    const providerThreadId = ProviderThreadId.make("provider-thread:run-execution-start-guard");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-start-guard");
    const rootNodeId = NodeId.make("node:run-execution-start-guard");
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
    } as OrchestrationV2Run;
    const rootNode = { id: rootNodeId } as OrchestrationV2ExecutionNode;
    const providerThread = {
      id: providerThreadId,
      driver,
    } as OrchestrationV2ProviderThread;
    const attempt = {
      id: attemptId,
      providerTurnId: null,
    } as OrchestrationV2RunAttempt;
    const session = {
      events: Stream.never,
      startTurn: () => Ref.update(providerStarts, (count) => count + 1),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;

    yield* runExecution.startRootRun({
      commandId: CommandId.make("command:run-execution-start-guard"),
      appThread: rootAppThread(threadId),
      providerSessionId,
      session,
      run,
      rootNode,
      checkpointScope: {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-start-guard"),
      } as OrchestrationV2CheckpointScope,
      providerThread,
      attempt,
      attemptId,
      providerTurnOrdinal: 1,
      shouldStartProviderTurn: () =>
        Ref.modify(guardCalls, (calls) => [calls === 0, calls + 1] as const),
      message: {
        messageId: MessageId.make("message:run-execution-start-guard"),
        text: "Do not start after ownership changes.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      },
    });

    assert.equal(yield* Ref.get(guardCalls), 2);
    assert.equal(yield* Ref.get(providerStarts), 0);
  }).pipe(Effect.provide(layerRunExecutionTest)),
);

it.effect("fails the run when its ownership check cannot be read before calling the provider", () =>
  Effect.gen(function* () {
    const guardCalls = yield* Ref.make(0);
    const providerStarts = yield* Ref.make(0);
    const writes = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const threadId = ThreadId.make("thread:run-execution-start-guard-read");
    const runId = RunId.make("run:run-execution-start-guard-read");
    const attemptId = RunAttemptId.make("attempt:run-execution-start-guard-read");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          mockEventSink({
            writeIfRunCurrent: (input) =>
              Ref.update(writes, (current) => [...current, ...input.events]).pipe(
                Effect.as({ committed: true, storedEvents: [] }),
              ),
          }),
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-start-guard-read"),
        appThread: rootAppThread(threadId),
        providerSessionId: ProviderSessionId.make("session:run-execution-start-guard-read"),
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(providerStarts, (count) => count + 1),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: { id: runId, threadId, ordinal: 1, providerInstanceId } as OrchestrationV2Run,
        rootNode: {
          id: NodeId.make("node:run-execution-start-guard-read"),
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-start-guard-read"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ProviderThreadId.make("provider-thread:run-execution-start-guard-read"),
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        shouldStartProviderTurn: () =>
          Ref.getAndUpdate(guardCalls, (calls) => calls + 1).pipe(
            Effect.flatMap((calls) =>
              calls === 0
                ? Effect.succeed(true)
                : Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId,
                      cause: "database unavailable",
                    }),
                  ),
            ),
          ),
        shouldFinalizeRun: () =>
          Effect.fail(
            new ProjectionStore.ProjectionStoreReadError({
              threadId,
              cause: "database unavailable",
            }),
          ),
        message: {
          messageId: MessageId.make("message:run-execution-start-guard-read"),
          text: "Start while the store is down.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(layerTest));

    assert.equal(yield* Ref.get(guardCalls), 2);
    assert.equal(yield* Ref.get(providerStarts), 0);
    const runUpdate = (yield* Ref.get(writes)).find((event) => event.type === "run.updated");
    assert.equal(
      runUpdate?.type === "run.updated" ? runUpdate.payload.status : undefined,
      "failed",
    );
  }),
);

it.effect("starts the provider when checkpoint baseline capture fails", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-baseline-failure");
    const runId = RunId.make("run:run-execution-baseline-failure");
    const attemptId = RunAttemptId.make("attempt:run-execution-baseline-failure");
    const providerThreadId = ProviderThreadId.make(
      "provider-thread:run-execution-baseline-failure",
    );
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-baseline-failure");
    const rootNodeId = NodeId.make("node:run-execution-baseline-failure");
    const checkpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:run-execution-baseline-failure"),
    } as OrchestrationV2CheckpointScope;
    const providerStarts = yield* Ref.make(0);
    const writes = yield* Ref.make<
      ReadonlyArray<{
        events: ReadonlyArray<OrchestrationV2DomainEvent>;
        effects: ReadonlyArray<PendingOrchestrationEffectV2>;
      }>
    >([]);
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            captureBaseline: () =>
              Effect.fail(
                new CheckpointService.CheckpointBaselineCaptureError({
                  scopeId: checkpointScope.id,
                  ordinalWithinScope: 0,
                  cause: new Error("VCS process timed out"),
                }),
              ),
          }),
          layerTurnItemPositionsTest,
          mockEventSink({
            writeWithEffects: (input) =>
              Ref.update(writes, (current) => [
                ...current,
                { events: input.events, effects: input.effects },
              ]).pipe(Effect.as([])),
          }),
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-baseline-failure"),
        appThread: rootAppThread(threadId),
        providerSessionId,
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(providerStarts, (count) => count + 1),
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope,
        providerThread: {
          id: providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: attemptId,
          providerTurnId: null,
        } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-baseline-failure"),
          text: "Start the provider without a baseline.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(layerTest));

    assert.equal(yield* Ref.get(providerStarts), 1);

    const events = (yield* Ref.get(writes)).flatMap((write) => [...write.events]);
    const failedEvent = events.find(
      (event) =>
        (event.type === "run.updated" ||
          event.type === "run-attempt.updated" ||
          event.type === "node.updated") &&
        event.payload.status === "failed",
    );
    assert.isUndefined(failedEvent);
    const errorItem = events.find(
      (event) => event.type === "turn-item.updated" && event.payload.type === "error",
    );
    assert.isUndefined(errorItem);
  }),
);

it.effect("prompts the provider only after a forked baseline capture finishes", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-forked-baseline");
    const runId = RunId.make("run:run-execution-forked-baseline");
    const attemptId = RunAttemptId.make("attempt:run-execution-forked-baseline");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const checkpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:run-execution-forked-baseline"),
    } as OrchestrationV2CheckpointScope;
    const run = { id: runId, threadId, ordinal: 1, providerInstanceId } as OrchestrationV2Run;
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          McpAppModelContext.layerEmpty,
          PreviewAgentActivity.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            captureBaseline: () =>
              Effect.sleep("1 second").pipe(
                Effect.andThen(Ref.update(order, (current) => [...current, "baseline"])),
              ),
          }),
          layerTurnItemPositionsTest,
          mockEventSink({}),
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      const baseline = yield* runExecution.forkBaseline({
        appThread: rootAppThread(threadId),
        run,
        checkpointScope,
      });
      const started = yield* runExecution
        .startRootRun({
          commandId: CommandId.make("command:run-execution-forked-baseline"),
          appThread: rootAppThread(threadId),
          providerSessionId: ProviderSessionId.make("session:run-execution-forked-baseline"),
          session: {
            events: Stream.never,
            startTurn: () => Ref.update(order, (current) => [...current, "prompt"]),
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run,
          rootNode: {
            id: NodeId.make("node:run-execution-forked-baseline"),
          } as OrchestrationV2ExecutionNode,
          checkpointScope,
          providerThread: {
            id: ProviderThreadId.make("provider-thread:run-execution-forked-baseline"),
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
          attemptId,
          baseline,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make("message:run-execution-forked-baseline"),
            text: "Wait for the baseline.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(started);
    }).pipe(Effect.provide(layerTest));

    assert.deepEqual(yield* Ref.get(order), ["baseline", "prompt"]);
  }),
);

it.effect(
  "cascade-terminalizes run-owned subagent rows on interrupt before root finalization",
  () =>
    Effect.gen(function* () {
      const ids = backgroundScenarioIds("subagent-interrupt-cascade");
      const childThreadId = ids.childThreadId;
      const unrelatedChildThreadId = ThreadId.make(
        "thread:subagent-interrupt-cascade:unrelated-child",
      );
      const providerInstanceId = ProviderInstanceId.make("codex");
      const written = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const ingested = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const layerTest = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            McpAppModelContext.layerEmpty,
            PreviewAgentActivity.layer,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            layerTurnItemPositionsTest,
            mockEventSink({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(written, (current) => [...current, ...input.events]);
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            ThreadCommandExecutor.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Ref.update(ingested, (current) => [...current, input.event]).pipe(Effect.as([])),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const runningSubagent = makeRunOwnedSubagentFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningTurnItem = makeRunOwnedSubagentTurnItemFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningNode = makeRunOwnedSubagentNodeFixture({
        ids,
        status: "running",
      });
      const runningChildNode = makeRunOwnedSubagentChildNodeFixture({
        ids,
        status: "running",
      });
      const memberThreadId = ThreadId.make("thread:subagent-interrupt-cascade:member");
      const runningMember = {
        ...runningSubagent,
        id: NodeId.make("node:subagent-interrupt-cascade:member"),
        threadId: childThreadId,
        runId: null,
        parentNodeId: runningChildNode.id,
        childThreadId: memberThreadId,
      };
      const foreignSubagent = {
        ...runningMember,
        id: NodeId.make("node:subagent-interrupt-cascade:foreign-subagent"),
        runId: RunId.make("run:subagent-interrupt-cascade:foreign"),
        childThreadId: unrelatedChildThreadId,
      };
      const runningMemberRoot = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-interrupt-cascade:member-root"),
        threadId: memberThreadId,
        rootNodeId: NodeId.make("node:subagent-interrupt-cascade:member-root"),
      };
      const foreignChildNode = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-interrupt-cascade:foreign-child"),
        runId: foreignSubagent.runId,
      };
      const runningChildTurnItem = makeLinkedChildTurnItemFixture({
        ids,
        driver,
        type: "command_execution",
      });
      const foreignChildTurnItem = {
        ...runningChildTurnItem,
        id: TurnItemId.make("turn-item:subagent-interrupt-cascade:foreign-child"),
        runId: foreignSubagent.runId,
      };
      const suppressedChildAssistantTurnItem = makeLinkedChildTurnItemFixture({
        ids: {
          ...ids,
          childItemId: TurnItemId.make("turn-item:subagent-interrupt-cascade:suppressed-assistant"),
        },
        driver,
        type: "assistant_message",
      });
      const unrelatedChildNode = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-interrupt-cascade:unrelated-child"),
        threadId: unrelatedChildThreadId,
        runId: ids.runId,
        rootNodeId: NodeId.make("node:subagent-interrupt-cascade:unrelated-child"),
      };
      const unrelatedChildTurnItem = {
        ...runningChildTurnItem,
        id: TurnItemId.make("turn-item:subagent-interrupt-cascade:unrelated-child"),
        threadId: unrelatedChildThreadId,
        nodeId: unrelatedChildNode.id,
      };

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:subagent-interrupt-cascade"),
          appThread: rootAppThread(ids.threadId),
          providerSessionId: ProviderSessionId.make("session:subagent-interrupt-cascade"),
          session: {
            events: Stream.empty,
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                childThreadCreatedEvent(ids),
                {
                  type: "subagent.updated",
                  driver,
                  subagent: runningSubagent,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningChildNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: unrelatedChildNode,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningChildTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: suppressedChildAssistantTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: unrelatedChildTurnItem,
                },
                { type: "subagent.updated", driver, subagent: runningMember },
                { type: "subagent.updated", driver, subagent: foreignSubagent },
                { type: "node.updated", driver, node: runningMemberRoot },
                { type: "node.updated", driver, node: foreignChildNode },
                { type: "turn_item.updated", driver, turnItem: foreignChildTurnItem },
                rootTerminalEvent(ids, "interrupted"),
                {
                  type: "subagent.updated",
                  driver,
                  subagent: {
                    ...runningSubagent,
                    status: "completed" as const,
                    result: "should-not-apply",
                    completedAt: runningSubagent.updatedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningTurnItem,
                    status: "completed" as const,
                    result: "should-not-apply",
                    completedAt: runningTurnItem.updatedAt,
                    updatedAt: runningTurnItem.updatedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningChildTurnItem,
                    status: "completed" as const,
                    completedAt: runningChildTurnItem.updatedAt,
                    updatedAt: runningChildTurnItem.updatedAt,
                  },
                },
                {
                  type: "node.updated",
                  driver,
                  node: {
                    ...runningChildNode,
                    status: "completed" as const,
                    completedAt: runningChildNode.startedAt,
                  },
                },
              ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make("checkpoint-scope:subagent-interrupt-cascade"),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ids.providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          relatedThreadIds: [unrelatedChildThreadId, memberThreadId],
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make("message:subagent-interrupt-cascade:user"),
            text: "Spawn a subagent then stop.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(layerTest));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");

      const events = yield* Ref.get(written);
      const subagentEvents = events.flatMap((event) =>
        event.type === "subagent.updated" ? [event] : [],
      );
      const turnItemEvents = events.flatMap((event) => {
        if (event.type !== "turn-item.updated" || event.payload.type !== "subagent") {
          return [];
        }
        return [
          {
            ...event,
            payload: event.payload,
          },
        ];
      });
      const nodeEvents = events.flatMap((event) =>
        event.type === "node.updated" &&
        event.payload.status === "interrupted" &&
        (event.payload.id === runningNode.id || event.payload.id === runningChildNode.id)
          ? [event]
          : [],
      );
      const runUpdatedIndex = events.findIndex((event) => event.type === "run.updated");
      assert.isAtLeast(runUpdatedIndex, 0, "root run.updated must be written");

      assert.lengthOf(subagentEvents, 2);
      const terminalSubagent = subagentEvents.find(
        (event) => event.payload.id === runningSubagent.id,
      );
      const terminalMember = subagentEvents.find((event) => event.payload.id === runningMember.id);
      assert.isDefined(terminalMember);
      assert.equal(terminalMember.payload.status, "interrupted");
      assert.equal(terminalMember.payload.runId, null);
      assert.equal(terminalMember.payload.childThreadId, memberThreadId);
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "node.updated" &&
            event.payload.id === runningMemberRoot.id &&
            event.payload.status === "interrupted",
        ),
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "subagent.updated" && event.payload.id === foreignSubagent.id,
        ),
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "node.updated" && event.payload.id === foreignChildNode.id,
        ),
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" && event.payload.id === foreignChildTurnItem.id,
        ),
      );
      assert.isDefined(terminalSubagent);
      assert.equal(terminalSubagent.payload.status, "interrupted");
      assert.equal(terminalSubagent.payload.childThreadId, childThreadId);
      assert.equal(terminalSubagent.payload.result, null);
      assert.isNotNull(terminalSubagent.payload.completedAt);

      assert.lengthOf(turnItemEvents, 1);
      const terminalTurnItem = turnItemEvents[0];
      assert.isDefined(terminalTurnItem);
      assert.equal(terminalTurnItem.payload.status, "interrupted");
      assert.equal(terminalTurnItem.payload.childThreadId, childThreadId);
      assert.equal(terminalTurnItem.payload.result, null);

      const terminalChildTurnItems = events.flatMap((event) =>
        event.type === "turn-item.updated" &&
        event.payload.id === runningChildTurnItem.id &&
        event.payload.status === "interrupted"
          ? [event]
          : [],
      );
      assert.lengthOf(terminalChildTurnItems, 1);
      const terminalChildTurnItem = terminalChildTurnItems[0];
      assert.isDefined(terminalChildTurnItem);
      assert.equal(terminalChildTurnItem.threadId, childThreadId);
      assert.equal(terminalChildTurnItem.payload.threadId, childThreadId);
      assert.equal(terminalChildTurnItem.payload.runId, null);
      assert.equal(terminalChildTurnItem.payload.type, "command_execution");
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === unrelatedChildTurnItem.id &&
            event.payload.status === "interrupted",
        ),
        "related but unlinked child turn items must not cascade",
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === suppressedChildAssistantTurnItem.id,
        ),
        "suppressed streaming child items must not be created by the cascade",
      );

      assert.lengthOf(nodeEvents, 2);
      assert.isTrue(
        nodeEvents.some(
          (event) => event.payload.id === runningNode.id && event.payload.kind === "subagent",
        ),
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "node.updated" &&
            event.payload.id === unrelatedChildNode.id &&
            event.payload.status === "interrupted",
        ),
        "owned child threads without a live run-owned subagent link must not cascade",
      );
      assert.isTrue(
        nodeEvents.some(
          (event) =>
            event.payload.id === runningChildNode.id &&
            event.runId === (runningChildNode.runId ?? ids.runId) &&
            event.payload.threadId === childThreadId &&
            event.payload.kind === "root_turn",
        ),
      );

      const cascadeIndexes = events.flatMap((event, index) => {
        if (event.type === "subagent.updated" && event.payload.status === "interrupted") {
          return [index];
        }
        if (
          event.type === "turn-item.updated" &&
          event.payload.status === "interrupted" &&
          (event.payload.type === "subagent" || event.payload.id === runningChildTurnItem.id)
        ) {
          return [index];
        }
        if (event.type === "node.updated" && event.payload.status === "interrupted") {
          return event.payload.id === runningNode.id || event.payload.id === runningChildNode.id
            ? [index]
            : [];
        }
        return [];
      });
      assert.isTrue(
        cascadeIndexes.every((index) => index < runUpdatedIndex),
        "subagent cascade must precede run.updated",
      );
      assert.isFalse(
        events.some((event) => {
          if (event.type === "subagent.updated") {
            return event.payload.status === "completed";
          }
          if (event.type === "turn-item.updated" && event.payload.type === "subagent") {
            return event.payload.status === "completed";
          }
          return false;
        }),
        "late provider completion must not reopen cascaded subagent rows",
      );
      assert.isFalse(
        (yield* Ref.get(ingested)).some(
          (event) =>
            (event.type === "subagent.updated" && event.subagent.status === "completed") ||
            (event.type === "turn_item.updated" && event.turnItem.status === "completed") ||
            (event.type === "node.updated" && event.node.status === "completed"),
        ),
        "late provider completion must not be ingested after interrupt",
      );
    }),
);

it.effect("does not overwrite Stop when ownership changes after the finalization read", () =>
  Effect.gen(function* () {
    const { written, observed, submittedEffects, committedEffects } =
      yield* captureRootRunTermination({
        key: "stop-wins-finalization-gap",
        shouldFinalizeRun: () => Effect.succeed(true),
        rejectTerminalWrite: true,
      });
    assert.deepEqual(written, []);
    assert.deepEqual(observed, []);
    assert.deepEqual(
      submittedEffects.map((effect) => effect.request.type),
      ["checkpoint.capture"],
    );
    assert.deepEqual(committedEffects, []);
  }),
);

it.effect("records a finished run as failed when its ownership check cannot be read", () =>
  Effect.gen(function* () {
    const { observed } = yield* captureRootRunTermination({
      key: "finalize-guard-read-failure",
      shouldFinalizeRun: () =>
        Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({
            threadId: ThreadId.make("thread:finalize-guard-read-failure"),
            cause: "database unavailable",
          }),
        ),
      events: (ids) => Stream.make(rootTerminalEvent(ids, "completed")),
    });
    assert.include(observed, "run:failed");
  }),
);

it.effect("fails the run when its provider stream exits with an error", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:stream-error",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver,
            providerSessionId: ProviderSessionId.make("session:exited"),
            cause: "provider process exited",
          }),
        ),
    });
    assert.deepEqual(observed, ["run:failed"]);
    assert.deepEqual(
      written.map((item) => item.type),
      ["error"],
    );
    const error = written.find((item) => item.type === "error");
    assert.include(error?.failure.message ?? "", "provider event stream closed unexpectedly");
  }),
);

it.effect("does not interrupt an ended provider when its terminal write fails", () =>
  Effect.gen(function* () {
    const interrupts = yield* Ref.make(0);
    const writes = yield* Ref.make(0);
    const { observed } = yield* captureRootRunTermination({
      key: "terminal-write-failure",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) => Stream.make(rootTerminalEvent(ids, "completed")),
      interruptTurn: () => Ref.update(interrupts, (count) => count + 1),
      beforeTerminalWrite: () =>
        Effect.gen(function* () {
          if ((yield* Ref.updateAndGet(writes, (count) => count + 1)) === 1) {
            return yield* new EventSink.EventSinkWriteError({ eventCount: 1 });
          }
          return true;
        }),
    });
    assert.equal(yield* Ref.get(interrupts), 0);
    assert.deepEqual(observed, ["run:failed"]);
  }),
);

it.effect("restores dropped inline handoffs when ingestion fails before the terminal", () =>
  Effect.gen(function* () {
    const key = "dropped-turn-ingest-error";
    const ids = backgroundScenarioIds(key);
    const handoff = { id: `handoff:${key}` } as unknown as OrchestrationV2ContextHandoff;
    const { finalEvents } = yield* captureRootRunTermination({
      key,
      shouldFinalizeRun: () => Effect.succeed(true),
      loadDroppedInlineHandoffs: () => Effect.succeed([handoff]),
      events: () =>
        Stream.make({
          type: "provider_turn.updated" as const,
          driver,
          threadId: ids.threadId,
          providerTurn: {
            id: ids.rootProviderTurnId,
            providerThreadId: ids.providerThreadId,
            runAttemptId: ids.attemptId,
            ordinal: 1,
            status: "failed",
            promptDropped: true,
          } as OrchestrationV2ProviderTurn,
        }),
      ingestNormalized: ({ event }) =>
        event.type === "provider_turn.updated"
          ? Effect.fail(
              new ProviderEventIngestor.ProviderEventPublishError({
                providerSessionId: ProviderSessionId.make(`session:${key}`),
                eventCount: 1,
                cause: new Error("SQLITE_FULL: database or disk is full"),
              }),
            )
          : Effect.succeed([]),
    });
    assert.deepEqual(
      finalEvents.flatMap((event) =>
        event.type === "context-handoff.updated" ? [event.payload.id] : [],
      ),
      [handoff.id],
    );
  }),
);

it.effect("fails the run when its event stream ends without a root terminal", () =>
  Effect.gen(function* () {
    const { observed, finalEvents } = yield* captureRootRunTermination({
      key: "stream-end-without-terminal",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () => Stream.empty,
    });
    assert.deepEqual(observed, ["run:failed"]);
    assert.equal(
      finalEvents.find((event) => event.type === "provider-thread.updated")?.payload.status,
      "idle",
    );
  }),
);

it.effect("leaves the run to restart recovery when shutdown interrupts its event stream", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "stream-end:shutdown",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () => Stream.failCause(Cause.interrupt()),
    });
    assert.deepEqual(written, []);
    assert.deepEqual(observed, []);
  }),
);

it.effect("does not start a turn whose run settled during the app context read", () =>
  Effect.gen(function* () {
    const contextReadStarted = yield* Deferred.make<void>();
    const runFailed = yield* Deferred.make<void>();
    const current = yield* Ref.make(true);
    const providerCalls = yield* Ref.make(0);
    const { observed } = yield* captureRootRunTermination({
      key: "stream-end:context-read",
      shouldStartProviderTurn: () => Ref.get(current),
      shouldFinalizeRun: () => Ref.get(current),
      events: () => Stream.unwrap(Deferred.await(contextReadStarted).pipe(Effect.as(Stream.empty))),
      appContext: Deferred.succeed(contextReadStarted, undefined).pipe(
        Effect.andThen(Deferred.await(runFailed)),
        Effect.as([]),
      ),
      onRunUpdated: Ref.set(current, false).pipe(
        Effect.andThen(Deferred.succeed(runFailed, undefined)),
      ),
      startTurn: () => Ref.update(providerCalls, (count) => count + 1),
    });
    assert.deepEqual(observed, ["run:failed"]);
    assert.equal(yield* Ref.get(providerCalls), 0);
  }),
);

function captureRootRunTermination(input: {
  readonly key: string;
  readonly shouldFinalizeRun: () => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>;
  readonly rejectTerminalWrite?: boolean;
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
  readonly hasWorkspaceMoved?: () => Effect.Effect<boolean, never>;
  readonly loadRunInterruptReason?: () => Effect.Effect<string | undefined, never>;
  readonly loadDroppedInlineHandoffs?: RunExecutionService.RunExecutionServiceV2StartRootRunInput["loadDroppedInlineHandoffs"];
  readonly hasPendingBackgroundWorkForThread?: ProviderAdapter.ProviderAdapterV2SessionRuntime["hasPendingBackgroundWorkForThread"];
  readonly seedOpenSubagent?: boolean;
  readonly events?: (
    ids: BackgroundScenarioIds,
  ) => Stream.Stream<
    ProviderAdapter.ProviderAdapterV2Event,
    ProviderAdapter.ProviderAdapterV2Error
  >;
  readonly startTurn?: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"];
  readonly interruptTurn?: ProviderAdapter.ProviderAdapterV2SessionRuntime["interruptTurn"];
  readonly messageText?: string;
  readonly initialProviderTurnId?: ProviderTurnId | null;
  readonly onStartFailure?: (
    error: RunExecutionService.RunExecutionServiceV2Error,
  ) => Effect.Effect<void>;
  readonly onSubscriptionClose?: Effect.Effect<void>;
  readonly shouldStartProviderTurn?: RunExecutionService.RunExecutionServiceV2StartRootRunInput["shouldStartProviderTurn"];
  readonly appContext?: ReturnType<McpAppModelContext.McpAppModelContext["Service"]["forThread"]>;
  readonly ingestNormalized?: ProviderEventIngestor.ProviderEventIngestorV2["Service"]["ingestNormalized"];
  readonly onRunUpdated?: Effect.Effect<void>;
  readonly beforeTerminalWrite?: (
    request: Parameters<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>[0],
  ) => Effect.Effect<boolean, EventSink.EventSinkV2Error>;
  readonly afterStart?: (
    closed: Deferred.Deferred<void>,
  ) => Effect.Effect<void, never, PreviewAgentActivity.PreviewAgentActivity>;
  /** Changes the stored rows after the provider reported them, as a concurrent Stop does. */
  readonly settleStored?: (
    work: RunExecutionService.UnsettledWork,
  ) => RunExecutionService.UnsettledWork;
}) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(input.key);
    // The rows the provider's events stored, which the run reads back when its runtime is lost.
    const stored = {
      subagents: new Map<string, OrchestrationV2Subagent>(),
      nodes: new Map<string, OrchestrationV2ExecutionNode>(),
      turnItems: new Map<string, OrchestrationV2TurnItem>(),
    };
    const store = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Effect.sync(() => {
        if (event.type === "subagent.updated")
          stored.subagents.set(event.subagent.id, event.subagent);
        if (event.type === "node.updated") stored.nodes.set(event.node.id, event.node);
        if (event.type === "turn_item.updated")
          stored.turnItems.set(event.turnItem.id, event.turnItem);
      });
    const loadUnsettledWork = (threadId: ThreadId) =>
      Effect.sync(() => {
        const work = {
          subagents: [...stored.subagents.values()].filter((row) => row.threadId === threadId),
          nodes: [...stored.nodes.values()].filter((row) => row.threadId === threadId),
          turnItems: [...stored.turnItems.values()].filter((row) => row.threadId === threadId),
        };
        return input.settleStored?.(work) ?? work;
      });
    const providerInstanceId = ProviderInstanceId.make("codex");
    const runningSubagent = makeRunOwnedSubagentFixture({
      ids,
      providerInstanceId,
      childThreadId: ids.childThreadId,
      driver,
      status: "running",
    });
    const writtenItems = yield* Ref.make<ReadonlyArray<OrchestrationV2TurnItem>>([]);
    const finalEvents = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const submittedEffects = yield* Ref.make<ReadonlyArray<PendingOrchestrationEffectV2>>([]);
    const committedEffects = yield* Ref.make<ReadonlyArray<PendingOrchestrationEffectV2>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const captureTurnItem = (payload: OrchestrationV2TurnItem) =>
      Ref.update(writtenItems, (current) => [...current, payload]);
    const captureFinalEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        yield* Ref.update(finalEvents, (current) => [...current, ...events]);
        for (const event of events) {
          if (event.type === "turn-item.updated") {
            yield* captureTurnItem(event.payload);
          }
          if (event.type === "run.updated") {
            yield* Ref.update(observed, (current) => [...current, `run:${event.payload.status}`]);
            yield* input.onRunUpdated ?? Effect.void;
          }
        }
      });
    const layerTest = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(McpAppModelContext.McpAppModelContext)({
            forThread: () => input.appContext ?? Effect.succeed([]),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          layerTurnItemPositionsTest,
          mockEventSink({
            write: (payload) =>
              Effect.gen(function* () {
                for (const event of payload.events) {
                  if (event.type === "turn-item.updated") {
                    yield* captureTurnItem(event.payload);
                  }
                }
                return [];
              }),
            writeWithEffects: (payload) =>
              Effect.gen(function* () {
                yield* Ref.update(submittedEffects, (current) => [...current, ...payload.effects]);
                yield* Ref.update(committedEffects, (current) => [...current, ...payload.effects]);
                yield* captureFinalEvents(payload.events);
                return [];
              }),
            writeIfRunCurrent: (payload) =>
              Effect.gen(function* () {
                const effects = payload.effects ?? [];
                yield* Ref.update(submittedEffects, (current) => [...current, ...effects]);
                if (
                  input.rejectTerminalWrite === true ||
                  (input.beforeTerminalWrite !== undefined &&
                    !(yield* input.beforeTerminalWrite(payload)))
                ) {
                  return { committed: false, storedEvents: [] };
                }
                yield* Ref.update(committedEffects, (current) => [...current, ...effects]);
                yield* captureFinalEvents(payload.events);
                return { committed: true, storedEvents: [] };
              }),
            // Committed only against the row that was read, as the real conditional writes are.
            writeIfSubagentUnchanged: (payload) =>
              stored.subagents.get(payload.expected.id) === payload.expected
                ? captureFinalEvents(payload.events).pipe(
                    Effect.as({ committed: true, storedEvents: [] }),
                  )
                : Effect.succeed({ committed: false, storedEvents: [] }),
            writeIfTurnItemUnchanged: (payload) =>
              stored.turnItems.get(payload.expected.id) === payload.expected
                ? captureFinalEvents(payload.events).pipe(
                    Effect.as({ committed: true, storedEvents: [] }),
                  )
                : Effect.succeed({ committed: false, storedEvents: [] }),
          }),
          IdAllocator.layer,
          ThreadCommandExecutor.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (request) =>
              store(request.event).pipe(
                Effect.andThen(input.ingestNormalized?.(request) ?? Effect.succeed([])),
              ),
          }),
          ServerSettings.layerTest(),
          Layer.succeed(RunFinalizationService.RunFinalizationObserver, {
            refresh: () => Effect.void,
            refreshRepositories: () => Effect.void,
          }),
        ),
      ),
      Layer.provideMerge(PreviewAgentActivity.layer),
    );

    const previewActivityEnded = yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      const start = runExecution.startRootRun({
        commandId: CommandId.make(`command:${input.key}`),
        appThread: rootAppThread(ids.threadId),
        providerSessionId: ProviderSessionId.make(`session:${input.key}`),
        session: {
          driver,
          events: Stream.empty,
          subscribeEvents: Effect.succeed({
            events:
              input.events?.(ids) ??
              Stream.fromIterable([
                ...(input.seedOpenSubagent
                  ? [
                      { type: "subagent.updated", driver, subagent: runningSubagent } as const,
                      {
                        type: "node.updated",
                        driver,
                        node: makeRunOwnedSubagentNodeFixture({ ids, status: "running" }),
                      } as const,
                      {
                        type: "turn_item.updated",
                        driver,
                        turnItem: makeRunOwnedSubagentTurnItemFixture({
                          ids,
                          providerInstanceId,
                          childThreadId: ids.childThreadId,
                          driver,
                          status: "running",
                        }),
                      } as const,
                    ]
                  : []),
                rootTerminalEvent(ids, "interrupted"),
              ] satisfies ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>),
            close: Deferred.succeed(ingestionDone, undefined).pipe(
              Effect.andThen(input.onSubscriptionClose ?? Effect.void),
            ),
          }),
          startTurn: input.startTurn ?? (() => Effect.void),
          interruptTurn: input.interruptTurn ?? (() => Effect.void),
          hasPendingBackgroundWorkForThread: input.hasPendingBackgroundWorkForThread,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: {
          id: ids.rootNodeId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${input.key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ids.providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: ids.attemptId,
          providerTurnId:
            input.initialProviderTurnId === undefined
              ? ids.rootProviderTurnId
              : input.initialProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        providerTurnOrdinal: 1,
        shouldFinalizeRun: input.shouldFinalizeRun,
        loadUnsettledWork,
        ...(input.loadRunInterruptReason === undefined
          ? {}
          : { loadRunInterruptReason: input.loadRunInterruptReason }),
        ...(input.shouldStartProviderTurn === undefined
          ? {}
          : { shouldStartProviderTurn: input.shouldStartProviderTurn }),
        ...(input.hasUnpairedRunInterruptRequest === undefined
          ? {}
          : {
              hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
            }),
        ...(input.hasWorkspaceMoved === undefined
          ? {}
          : { hasWorkspaceMoved: input.hasWorkspaceMoved }),
        ...(input.loadDroppedInlineHandoffs === undefined
          ? {}
          : { loadDroppedInlineHandoffs: input.loadDroppedInlineHandoffs }),
        message: {
          messageId: MessageId.make(`message:${input.key}`),
          text: input.messageText ?? "interrupt projection",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
      yield* start.pipe(
        Effect.catch((error) => input.onStartFailure?.(error) ?? Effect.fail(error)),
      );
      yield* input.afterStart?.(ingestionDone) ?? Effect.void;
      yield* Deferred.await(ingestionDone);
      const activity = yield* PreviewAgentActivity.PreviewAgentActivity;
      return !(yield* activity.active(ids.threadId));
    }).pipe(Effect.provide(layerTest));

    return {
      previewActivityEnded,
      written: yield* Ref.get(writtenItems),
      finalEvents: yield* Ref.get(finalEvents),
      observed: yield* Ref.get(observed),
      submittedEffects: yield* Ref.get(submittedEffects),
      committedEffects: yield* Ref.get(committedEffects),
    };
  });
}

interface BackgroundScenarioIds {
  readonly threadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
  readonly rootProviderTurnId: ProviderTurnId;
  readonly rootNodeId: NodeId;
  readonly itemId: TurnItemId;
  readonly childItemId: TurnItemId;
  readonly subagentNodeId: NodeId;
}

function backgroundScenarioIds(key: string): BackgroundScenarioIds {
  return {
    threadId: ThreadId.make(`thread:${key}`),
    childThreadId: ThreadId.make(`thread:${key}:child`),
    runId: RunId.make(`run:${key}`),
    attemptId: RunAttemptId.make(`attempt:${key}`),
    providerThreadId: ProviderThreadId.make(`provider-thread:${key}`),
    rootProviderTurnId: ProviderTurnId.make(`provider-turn:${key}`),
    rootNodeId: NodeId.make(`node:${key}`),
    itemId: TurnItemId.make(`turn-item:${key}`),
    childItemId: TurnItemId.make(`turn-item:${key}:child`),
    subagentNodeId: NodeId.make(`node:${key}:subagent`),
  };
}

function childThreadCreatedEvent(
  ids: BackgroundScenarioIds,
): ProviderAdapter.ProviderAdapterV2Event {
  return {
    type: "app_thread.created",
    driver,
    appThread: {
      id: ids.childThreadId,
      lineage: {
        parentThreadId: ids.threadId,
        relationshipToParent: "subagent",
        rootThreadId: ids.threadId,
      },
    },
  } as ProviderAdapter.ProviderAdapterV2Event;
}

function makeRunOwnedSubagentFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly providerInstanceId: ProviderInstanceId;
  readonly childThreadId: ThreadId;
  readonly driver: typeof driver;
  readonly status: "running" | "interrupted";
}): OrchestrationV2Subagent {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.subagentNodeId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    parentNodeId: input.ids.rootNodeId,
    origin: "provider_native",
    createdBy: "agent",
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    providerThreadId: null,
    childThreadId: input.childThreadId,
    nativeTaskRef: {
      driver: input.driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    prompt: "hold",
    title: "Live-test subagent hold",
    model: null,
    status: input.status,
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
}

function makeRunOwnedSubagentTurnItemFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly providerInstanceId: ProviderInstanceId;
  readonly childThreadId: ThreadId;
  readonly driver: typeof driver;
  readonly status: "running" | "interrupted";
}): Extract<OrchestrationV2TurnItem, { type: "subagent" }> {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.itemId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    nodeId: input.ids.subagentNodeId,
    providerThreadId: input.ids.providerThreadId,
    providerTurnId: input.ids.rootProviderTurnId,
    nativeItemRef: {
      driver: input.driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    parentItemId: null,
    ordinal: 3,
    status: input.status,
    title: "Live-test subagent hold",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "subagent",
    subagentId: input.ids.subagentNodeId,
    origin: "provider_native",
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    childThreadId: input.childThreadId,
    prompt: "hold",
    result: null,
  };
}

function makeLinkedChildTurnItemFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly driver: typeof driver;
  readonly type: "assistant_message" | "command_execution" | "reasoning";
}): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  const base = {
    id: input.ids.childItemId,
    threadId: input.ids.childThreadId,
    runId: null,
    nodeId: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running" as const,
    title: "Working",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  if (input.type === "assistant_message") {
    return {
      ...base,
      type: "assistant_message",
      messageId: MessageId.make(`${input.ids.childItemId}:message`),
      text: "partial response",
      streaming: true,
    };
  }
  if (input.type === "reasoning") {
    return {
      ...base,
      type: "reasoning",
      text: "partial progress",
      streaming: true,
    };
  }
  return {
    ...base,
    type: "command_execution",
    input: "sleep 300",
  };
}

function makeRunOwnedSubagentNodeFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly status: "running" | "interrupted";
}): OrchestrationV2ExecutionNode {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.subagentNodeId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    parentNodeId: input.ids.rootNodeId,
    rootNodeId: input.ids.rootNodeId,
    kind: "subagent",
    status: input.status,
    countsForRun: false,
    providerThreadId: input.ids.providerThreadId,
    providerTurnId: input.ids.rootProviderTurnId,
    nativeItemRef: {
      driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}

function makeRunOwnedSubagentChildNodeFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly status: "running" | "interrupted";
}): OrchestrationV2ExecutionNode {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    threadId: input.ids.childThreadId,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    kind: "root_turn",
    status: input.status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}

function rootTerminalEvent(
  ids: BackgroundScenarioIds,
  status: "completed" | "interrupted" | "cancelled" | "failed",
): ProviderAdapter.ProviderAdapterV2Event {
  const common = {
    type: "turn.terminal" as const,
    driver,
    providerThreadId: ids.providerThreadId,
    providerTurnId: ids.rootProviderTurnId,
    runOrdinal: 1,
    threadDisposition: "reusable" as const,
  };
  return status === "failed"
    ? {
        ...common,
        status,
        failureItemOrdinal: 101,
        failure: {
          class: "provider_error",
          message: "Provider failed",
          code: null,
          retryable: null,
        },
      }
    : { ...common, status, failure: null };
}
