import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@ankielcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { checkpointWorkspace } from "@ankielcode/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect.each(
  (
    [
      [false, "during delivery"],
      [false, "before dispatch"],
      [true, "after delivery"],
      [true, "without native steering"],
      [true, "with interrupting native steering"],
      [true, "settled only"],
      [false, "during continuation"],
      ["question", "during delivery"],
    ] as const
  ).map(([kind, timing]) => ({
    mailbox: kind === true,
    question: kind === "question",
    timing,
    label:
      kind === "question" ? "delegated task question" : kind ? "mailbox notification" : "steering",
  })),
)("delivers $label when completion wins $timing", ({ mailbox, question, timing }) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(`steering-completion-${timing.replaceAll(" ", "-")}`);
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
    const steerEntered = yield* Deferred.make<void>();
    const rejectSteer = yield* Deferred.make<void>();
    let steerCalls = 0;
    const capabilities = {
      ...CodexProviderCapabilitiesV2,
      turns: {
        ...CodexProviderCapabilitiesV2.turns,
        supportsActiveSteering: timing !== "without native steering",
        activeSteeringInterruptsTools: timing === "with interrupting native steering",
      },
    };
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(capabilities),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd,
              model: modelSelection.model,
              capabilities,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: ({ threadId }) =>
              Effect.succeed({
                id: ProviderThreadId.make(`provider-thread:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) =>
              Effect.gen(function* () {
                started.push(turn);
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${turn.attemptId}`,
                      strength: "strong",
                    },
                    ordinal: turn.providerTurnOrdinal,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  },
                });
              }),
            steerTurn: (turn) =>
              Effect.gen(function* () {
                steerCalls += 1;
                if (timing === "after delivery" || timing === "during continuation") return;
                yield* Deferred.succeed(steerEntered, undefined);
                yield* Deferred.await(rejectSteer);
                return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                  cause: "turn already completed",
                });
              }),
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:steering-completion");
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:steering-completion"),
        title: "Steering race",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("first"),
        threadId,
        messageId: MessageId.make("message:first"),
        text: "first",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const running = yield* watch(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* worker.drain();
      yield* Fiber.join(running);
      const first = started[0]!;
      const messageId = MessageId.make("message:steering");
      const taskId = NodeId.make("task:mailbox");
      if (mailbox) {
        const sink = yield* EventSink.EventSinkV2;
        const current = yield* orchestrator.getThreadProjection(threadId);
        const parentRun = current.runs.find((run) => run.id === first.runId)!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("mailbox:cohort"),
              type: "run.updated",
              threadId,
              runId: first.runId,
              occurredAt: now,
              payload: {
                ...parentRun,
                delegatedCompletion: {
                  disposition: "open",
                  nextGeneration: 2,
                  delivery: { generation: 1, messageId, taskIds: [taskId] },
                },
              },
            },
            {
              id: EventId.make("mailbox:task"),
              type: "subagent.updated",
              threadId,
              runId: first.runId,
              nodeId: taskId,
              occurredAt: now,
              payload: {
                id: taskId,
                threadId,
                runId: first.runId,
                parentNodeId: first.rootNodeId,
                origin: "app_owned",
                createdBy: "agent",
                driver,
                providerInstanceId: instanceId,
                providerThreadId: null,
                childThreadId: null,
                nativeTaskRef: null,
                prompt: "Do background work",
                title: "Background test",
                model: null,
                completionWake: timing === "settled only" ? "settled_only" : "always",
                completionDelivery: { state: "claimed", observedByRunId: null },
                status: "completed",
                result: "done",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
              },
            },
          ],
        });
      }
      if (question) {
        const { thread } = yield* orchestrator.getThreadProjection(threadId);
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("event:composer-selection"),
              type: "thread.model-selection-updated",
              threadId,
              providerInstanceId: instanceId,
              occurredAt: yield* DateTime.now,
              payload: { ...thread, modelSelection: composerSelection },
            },
          ],
        });
      }
      const dispatchSteer = orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("steer"),
        threadId,
        messageId,
        text: "fix the popover",
        attachments: [
          {
            type: "image",
            id: "steering-screenshot",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ],
        dispatchMode:
          mailbox || question
            ? { type: "queue_after_active" }
            : { type: "steer_active", targetRunId: first.runId },
        createdBy: mailbox || question ? "agent" : "user",
        creationSource: mailbox || question ? "server" : "web",
        ...(question
          ? {
              notification: {
                source: { kind: "delegated_task", taskIds: [taskId] },
                outcome: "updated",
                summary: "Delegated task has a question",
              },
            }
          : {}),
        ...(mailbox
          ? {
              delegatedCompletion: {
                parentRunId: first.runId,
                generation: 1,
                taskIds: [taskId],
              },
            }
          : {}),
      });
      if (timing !== "before dispatch") yield* dispatchSteer;
      if (timing === "during continuation") {
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const turn = projection.providerTurns[0]!;
        const failed = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "failed",
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "failed", completedAt: yield* DateTime.now },
        });
        yield* Fiber.join(failed);
        yield* worker.drain();
        assert.equal(steerCalls, 1);
        assert.lengthOf(started, 1);
        const continued = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(continued.runs[0]?.status, "running");
        assert.equal(
          continued.messages.find((message) => message.id === messageId)?.runId,
          first.runId,
        );
        return;
      }
      if (timing === "after delivery") yield* worker.drain();
      const delivery =
        timing === "during delivery" ? yield* worker.runOnce().pipe(Effect.forkScoped) : null;
      if (delivery !== null) yield* Deferred.await(steerEntered);
      const completed = yield* watch(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === first.runId &&
          event.payload.status === "completed",
      );
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const turn = projection.providerTurns[0]!;
      yield* Queue.offer(events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
      });
      yield* Queue.offer(events, {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.id,
        runOrdinal: first.runOrdinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Fiber.join(completed);
      if (delivery !== null) {
        yield* Deferred.succeed(rejectSteer, undefined);
        yield* Fiber.join(delivery);
      }
      if (delivery !== null && !question) {
        const requeued = yield* orchestrator.getThreadProjection(threadId);
        assert.isTrue(requeued.runs.some((run) => run.status === "queued"));
        assert.isFalse(
          requeued.visibleTurnItems.some(
            ({ item }) => item.type === "user_message" && item.messageId === messageId,
          ),
          "a steer that fell back to the queue must not appear delivered",
        );
        const item = requeued.turnItems.find(
          (item) => item.type === "user_message" && item.messageId === messageId,
        );
        assert.equal(item?.status, "pending");
        assert.isNull(item?.startedAt);
        assert.isNull(item?.completedAt);
      }
      if (timing === "before dispatch") yield* dispatchSteer;
      yield* worker.drain();
      yield* orchestrator.resumeQueuedRuns;
      yield* worker.drain();
      if (timing === "after delivery") {
        assert.equal(steerCalls, 1);
        assert.equal(started.length, 1);
        if (mailbox) {
          const delivered = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(delivered.subagents[0]?.completionDelivery?.state, "delivered");
          assert.equal(delivered.subagents[0]?.completionDelivery?.observedByRunId, null);
          assert.equal(delivered.runs[0]?.delegatedCompletion?.delivery, null);
          assert.equal(
            delivered.turnItems.filter((item) => item.type === "notification").length,
            1,
          );
          yield* orchestrator.dispatch({
            type: "notification.delivery.accept",
            commandId: CommandId.make("duplicate-acceptance"),
            threadId,
            messageId,
          });
          yield* worker.drain();
          assert.equal(steerCalls, 1);
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make("read-result"),
            parentThreadId: threadId,
            taskId,
            observedByRunId: first.runId,
          });
          const acknowledged = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(acknowledged.subagents[0]?.completionDelivery?.state, "acknowledged");
        }
        return;
      }
      assert.equal(started.length, 2);
      assert.equal(started[1]?.message.messageId, messageId);
      if (mailbox) assert.include(started[1]?.message.text ?? "", String(taskId));
      else assert.equal(started[1]?.message.text, "fix the popover");
      assert.deepEqual(started[1]?.message.attachments, [
        {
          type: "image",
          id: "steering-screenshot",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 10,
        },
      ]);
      assert.equal(steerCalls, timing === "during delivery" ? 1 : 0);
      const final = yield* orchestrator.getThreadProjection(threadId);
      if (question) {
        assert.deepEqual(final.thread.modelSelection, composerSelection);
        assert.deepEqual(started[1]?.modelSelection, composerSelection);
      }
      if (!mailbox && !question) {
        assert.equal(
          final.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === messageId,
          )?.status,
          "completed",
        );
      }
      assert.equal(final.messages.filter((message) => message.id === messageId).length, 1);
      assert.equal(
        final.messages.find((message) => message.id === messageId)?.runId,
        started[1]?.runId,
      );
      assert.equal(
        final.turnItems.filter((item) =>
          mailbox || question
            ? item.type === "notification"
            : item.type === "user_message" && item.messageId === messageId,
        ).length,
        1,
      );
      if (!mailbox && !question) {
        assert.equal(
          final.visibleTurnItems.filter(
            ({ item }) => item.type === "user_message" && item.messageId === messageId,
          ).length,
          1,
        );
      }
      yield* worker.drain();
      assert.equal(started.length, 2);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: `steering-completion-${timing}` },
          ProviderAdapterRegistry.layerSingle(adapter),
          { runEffectWorker: false },
        ),
      ),
    );
  }),
);

const runSelection = {
  instanceId,
  model: "test-model",
  options: [{ id: "effort", value: "xhigh" }],
};
const composerSelection = {
  ...runSelection,
  options: [...runSelection.options, { id: "fastMode", value: false }],
};

const supervised = { runtimeMode: "approval-required", interactionMode: "default" } as const;

const nextTurnSelectionHarness = Effect.fn("nextTurnSelectionHarness")(function* (
  name: string,
  canRestart = false,
  canSteer = true,
  interruptTurn: Effect.Effect<void> = Effect.void,
  steeringAcceptsAttachments = true,
  nativeGoals?: boolean,
  onSteer: (
    turn: ProviderAdapter.ProviderAdapterV2SteerInput,
  ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error> = () => Effect.void,
  extraAdapters: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]> = [],
) {
  const driver = ProviderDriverKind.make(nativeGoals === undefined ? "codex" : "opencode");
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const steeredSelections: Array<ModelSelection | undefined> = [];
  const interrupted: ProviderTurnId[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: canSteer,
      supportsSteeringByInterruptRestart: canRestart,
      activeSteeringAcceptsAttachments: steeringAcceptsAttachments,
      ...(nativeGoals === undefined ? {} : { supportsNativeGoals: nativeGoals }),
    },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const turnUpdated = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          status: "running" | "interrupted",
        ) =>
          Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
              providerThreadId: turn.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: turn.attemptId,
              nativeTurnRef: {
                driver,
                nativeId: `native:${turn.attemptId}`,
                strength: "strong",
              },
              ordinal: turn.providerTurnOrdinal,
              status,
              startedAt: now,
              completedAt: status === "running" ? null : now,
            },
          });
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            started.push(turn);
            yield* turnUpdated(turn, "running");
          });
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: runSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn,
          compactThread: startTurn,
          steerTurn: (turn) =>
            Effect.sync(() => {
              steered.push(turn.message.text);
              steeredSelections.push(turn.modelSelection);
            }).pipe(Effect.andThen(onSteer(turn))),
          interruptTurn: ({ providerTurnId }) =>
            Effect.sync(() => {
              interrupted.push(providerTurnId);
            }).pipe(
              Effect.andThen(interruptTurn),
              Effect.andThen(
                Effect.forEach(
                  started.filter(
                    (turn) =>
                      ProviderTurnId.make(`provider-turn:${turn.attemptId}`) === providerTurnId,
                  ),
                  (turn) =>
                    turnUpdated(turn, "interrupted").pipe(
                      Effect.andThen(
                        Queue.offer(events, {
                          type: "turn.terminal",
                          driver,
                          providerThreadId: turn.providerThread.id,
                          providerTurnId,
                          runOrdinal: turn.runOrdinal,
                          status: "interrupted",
                          failure: null,
                          threadDisposition: "reusable",
                        }),
                      ),
                    ),
                  { discard: true },
                ),
              ),
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerFromAdapters([adapter, ...extraAdapters]),
    { runEffectWorker: false },
  );
  const startFirstTurn = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Steer with changed options",
      modelSelection: runSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    // Ingestion checks turn ownership under this lock after committing the running turn.
    yield* (yield* ThreadCommandExecutor.ThreadCommandExecutor).withLock(threadId, Effect.void);
    return threadId;
  });
  return { cwd, events, started, steered, steeredSelections, interrupted, layer, startFirstTurn };
});

it.effect("sends a selected held message once and preserves the remaining queue order", () =>
  Effect.gen(function* () {
    const { started, steered, layer, startFirstTurn } =
      yield* nextTurnSelectionHarness("send-held-message");
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = yield* startFirstTurn;
      yield* Effect.forEach(["queued-first", "selected", "queued-last"], (text) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(text),
          threadId,
          messageId: MessageId.make(`message:${text}`),
          text,
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        }),
      );
      const before = yield* orchestrator.getThreadProjection(threadId);
      const selected = before.runs.find(
        (run) => run.userMessageId === MessageId.make("message:selected"),
      )!;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      // Restart recovery cancels the active run and holds every queued message.
      yield* sink.write({
        events: [
          ...before.runs.map((run) => ({
            id: EventId.make(`restart:${run.id}`),
            type: "run.updated" as const,
            threadId,
            runId: run.id,
            occurredAt: now,
            payload:
              run.status === "queued"
                ? { ...run, queueHeld: true }
                : { ...run, status: "cancelled" as const, completedAt: now },
          })),
          ...before.providerTurns.map((turn) => ({
            id: EventId.make(`restart:${turn.id}`),
            type: "provider-turn.updated" as const,
            threadId,
            occurredAt: now,
            payload: { ...turn, status: "cancelled" as const, completedAt: now },
          })),
        ],
      });
      const command = {
        type: "queued-run.start" as const,
        commandId: CommandId.make("send-selected"),
        threadId,
        runId: selected.id,
      };
      yield* orchestrator.dispatch(command);
      yield* worker.drain();
      yield* orchestrator.dispatch(command);
      yield* worker.drain();
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === selected.id)?.status, "running");
      assert.deepEqual(
        started.map((input) => input.message.text),
        ["first", "selected"],
      );
      assert.equal(started[1]?.runId, selected.id);
      assert.equal(started[1]?.message.messageId, selected.userMessageId);
      assert.deepEqual(started[1]?.modelSelection, runSelection);
      assert.deepEqual(steered, []);
      assert.lengthOf(
        after.messages.filter((message) => message.id === selected.userMessageId),
        1,
      );
      assert.deepEqual(
        after.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
        [MessageId.make("message:queued-first"), MessageId.make("message:queued-last")],
      );
      assert.isFalse(after.runs.some((run) => run.status === "queued" && run.queueHeld));
      const duplicate = yield* orchestrator
        .dispatch({
          ...command,
          commandId: CommandId.make("send-selected-again"),
        })
        .pipe(Effect.flip);
      assert.equal(duplicate._tag, "OrchestratorDispatchError");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("keeps a message queued when send now races with a running turn", () =>
  Effect.gen(function* () {
    const { started, layer, startFirstTurn } = yield* nextTurnSelectionHarness("send-queued-race");
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = yield* startFirstTurn;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("queue"),
        threadId,
        messageId: MessageId.make("message:queued"),
        text: "queued",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const queued = before.runs.find((run) => run.status === "queued")!;
      const error = yield* orchestrator
        .dispatch({
          type: "queued-run.start",
          commandId: CommandId.make("send-now"),
          threadId,
          runId: queued.id,
        })
        .pipe(Effect.flip);
      yield* worker.drain();
      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.equal(started.length, 1);
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(after.runs, before.runs);
    }).pipe(Effect.provide(layer));
  }),
);

const declinedSteerTimings = [
  "complete",
  "stop-before-decline",
  "stop-after-decline",
  "queued-model",
  "two-steers",
] as const;

it.effect.each(declinedSteerTimings)(
  "persists a declined steer without blocking the worker: %s",
  (timing) =>
    Effect.gen(function* () {
      let beforeDecline: Effect.Effect<void> = Effect.void;
      const { events, started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        `steering-declined-${timing}`,
        false,
        true,
        Effect.void,
        true,
        undefined,
        (turn) =>
          Effect.suspend(() => beforeDecline).pipe(
            Effect.andThen(
              Effect.fail(
                new ProviderAdapter.ProviderAdapterSteerDeclinedError({
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                }),
              ),
            ),
          ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const stop = orchestrator
          .dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: first.runId,
            holdQueue: true,
          })
          .pipe(Effect.asVoid, Effect.orDie);
        if (timing === "stop-before-decline") beforeDecline = stop;
        const steerSelection = { ...runSelection, model: "steer-model" };
        if (timing === "queued-model") {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queued-model"),
            threadId,
            messageId: MessageId.make("message:queued-model"),
            text: "already queued",
            attachments: [],
            modelSelection: composerSelection,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          beforeDecline = Effect.forEach(["queued-later", "steer-later", "queued-last"], (id) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(id),
              threadId,
              messageId: MessageId.make(`message:${id}`),
              text: id,
              attachments: [],
              dispatchMode:
                id === "steer-later"
                  ? { type: "steer_active", targetRunId: first.runId }
                  : { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            }),
          ).pipe(Effect.asVoid, Effect.orDie);
        }
        if (timing === "two-steers") {
          // The second steer arrives before the first is declined.
          beforeDecline = orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("steer-second"),
              threadId,
              messageId: MessageId.make("message:steer-second"),
              text: "second",
              attachments: [],
              dispatchMode: { type: "steer_active", targetRunId: first.runId },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(
              Effect.andThen(Effect.sync(() => (beforeDecline = Effect.void))),
              Effect.asVoid,
              Effect.orDie,
            );
        }
        const messageId = MessageId.make("message:declined");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId,
          text: "follow up",
          attachments: [],
          ...(timing === "queued-model" ? { modelSelection: steerSelection } : {}),
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const pending = yield* orchestrator.getThreadProjection(threadId);
        const queued = pending.runs.find(
          (run) => run.userMessageId === messageId && run.id !== first.runId,
        );
        const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
          CommandId.make("steer"),
        );
        assert.deepEqual(
          effects.map((effect) => [effect.request.type, effect.status]),
          [["provider-turn.steer", "succeeded"]],
        );
        assert.equal(started.length, 1);
        if (timing === "stop-before-decline") {
          assert.isUndefined(queued);
          return;
        }
        assert.equal(queued?.status, "queued");
        assert.equal(queued?.userMessageId, messageId);
        if (timing === "queued-model") {
          assert.deepEqual(queued?.modelSelection, steerSelection);
          assert.deepEqual(
            pending.runs
              .filter((run) => run.status === "queued")
              .toSorted(
                (left, right) =>
                  (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
              )
              .map((run) => run.userMessageId),
            [
              MessageId.make("message:queued-model"),
              messageId,
              MessageId.make("message:queued-later"),
              MessageId.make("message:steer-later"),
              MessageId.make("message:queued-last"),
            ],
          );
          return;
        }
        if (timing === "two-steers") {
          assert.deepEqual(
            pending.runs
              .filter((run) => run.status === "queued")
              .toSorted(
                (left, right) =>
                  (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
              )
              .map((run) => run.userMessageId),
            [messageId, MessageId.make("message:steer-second")],
          );
          return;
        }
        if (timing === "stop-after-decline") {
          yield* stop;
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          const held = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(held.runs.find((run) => run.id === queued?.id)?.queueHeld, true);
          assert.equal(started.length, 1);
          return;
        }
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = pending.providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, messageId);
        assert.equal(started[1]?.runId, queued?.id);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "refuses a limited caller's steer into a turn started before its thread was lowered",
  () =>
    Effect.gen(function* () {
      const { steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steer-above-limit");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        // Codex keeps its session, and its running turn the full-access policy it started with.
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("lower"),
          threadId,
          runtimeMode: "approval-required",
        });
        const steer = {
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "follow up",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "steer",
          createdBy: "agent",
          creationSource: "mcp",
        } as const;
        const refused = yield* orchestrator
          .dispatch(steer)
          .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
        assert.ok(refused._tag === "OrchestratorThreadAboveModeLimitError");
        assert.equal(refused.runtimeMode, "full-access");
        yield* worker.drain();
        assert.deepEqual(steered, []);

        // The refusal records nothing, and a caller without the limit still reaches the turn.
        yield* orchestrator.dispatch(steer);
        yield* worker.drain();
        assert.lengthOf(steered, 1);

        // The turn's own record decides: one that started within the limit takes the steer.
        const attempt = (yield* orchestrator.getThreadProjection(threadId)).attempts[0]!;
        assert.deepEqual(attempt.startedModes, {
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("started-supervised"),
              type: "run-attempt.updated",
              threadId,
              occurredAt: yield* DateTime.now,
              payload: { ...attempt, startedModes: supervised },
            },
          ],
        });
        yield* orchestrator
          .dispatch({
            ...steer,
            commandId: CommandId.make("steer-within"),
            messageId: MessageId.make("message:steer-within"),
          })
          .pipe(Effect.provideService(DispatchModeLimit, supervised));
        yield* worker.drain();
        assert.lengthOf(steered, 2);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("refuses a limited caller's answer to a turn started above its limit", () =>
  Effect.gen(function* () {
    const { started, layer, startFirstTurn } = yield* nextTurnSelectionHarness("answer-above");
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* startFirstTurn;
      const now = yield* DateTime.now;
      const requestId = RuntimeRequestId.make("request:question");
      const session = (yield* orchestrator.getThreadProjection(threadId)).providerSessions[0]!;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("question"),
            type: "runtime-request.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId: started[0]!.rootNodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "command",
              status: "pending",
              responseCapability: { type: "live", providerSessionId: session.id },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower"),
        threadId,
        runtimeMode: "approval-required",
      });
      const respond = {
        type: "runtime-request.respond",
        commandId: CommandId.make("respond"),
        threadId,
        requestId,
        decision: "accept",
      } as const;
      const refused = yield* orchestrator
        .dispatch(respond)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.ok(refused._tag === "OrchestratorThreadAboveModeLimitError");
      assert.equal(refused.runtimeMode, "full-access");

      yield* orchestrator.dispatch(respond);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests[0]?.status,
        "resolved",
      );
    }).pipe(Effect.provide(layer));
  }),
);

// regression: #32891 a restart that Stop already reached is lost
it.effect.each([false, true])(
  "refuses a steer after Stop (provider turn ready: %s)",
  (providerTurnReady) =>
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("restart-after-stop");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        // The worker has not delivered the interrupt yet, so the run still reads as running.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: first.runId,
        });
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        if (!providerTurnReady) {
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("turn-not-ready"),
                type: "provider-turn.updated",
                threadId,
                occurredAt: yield* DateTime.now,
                payload: { ...turn, status: "pending" },
              },
            ],
          });
        }
        const steerError = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("steer"),
            threadId,
            messageId: MessageId.make("message:steer"),
            text: "steer",
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "steer_active", targetRunId: first.runId },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);
        assert.equal(steerError._tag, "OrchestratorDispatchError");
        assert.include(String(steerError.cause), "is stopping and cannot be steered");
        if (!providerTurnReady) {
          yield* (yield* EventSink.EventSinkV2).write({
            events: [
              {
                id: EventId.make("restore-ready-turn"),
                type: "provider-turn.updated",
                threadId,
                occurredAt: yield* DateTime.now,
                payload: turn,
              },
            ],
          });
        }
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart"),
          threadId,
          messageId: MessageId.make("message:restart"),
          text: "restart",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "restart_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(
          started.map((turn) => turn.message.text),
          ["first", "restart"],
        );
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "ends the run as interrupted when the provider finishes before an accepted Stop reaches it",
  () =>
    Effect.gen(function* () {
      const interruptReached = yield* Deferred.make<void>();
      const releaseInterrupt = yield* Deferred.make<void>();
      const { events, started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "stop-loses-to-completion",
        false,
        true,
        Deferred.succeed(interruptReached, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInterrupt)),
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: first.runId,
        });
        const draining = yield* worker.drain().pipe(Effect.forkScoped);
        yield* Deferred.await(interruptReached);
        const completed = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(completed);
        yield* Deferred.succeed(releaseInterrupt, undefined);
        yield* Fiber.join(draining);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        const run = projection.runs.find((candidate) => candidate.id === first.runId);
        assert.equal(run?.status, "interrupted");
        assert.isNotNull(run?.checkpointId);
        assert.deepEqual(
          projection.turnItems.flatMap((item) =>
            item.type === "run_interrupt_result" ? [item.message] : [],
          ),
          ["Stopped by user"],
        );
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("replays an accepted steer after its target turn completes", () =>
  Effect.gen(function* () {
    const name = "steer-retry-after-completion";
    const { events, started, steered, layer, startFirstTurn } =
      yield* nextTurnSelectionHarness(name);
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const threadId = yield* startFirstTurn;
      const input = {
        projectId: ProjectId.make(`project:${name}`),
        commandId: CommandId.make("steer"),
        threadId,
        messageId: MessageId.make("message:steer"),
        text: "Please report the test result",
        attachments: [],
        mode: "steer",
        createdBy: "agent",
        creationSource: "mcp",
      } as const;
      const accepted = yield* threadManagement.sendToThread(input);
      assert.equal(accepted.delivery, "steered");
      yield* worker.drain();

      const waiting = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === accepted.run.id &&
            event.payload.status === "completed",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      );
      const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
      yield* Queue.offer(events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
      });
      yield* Queue.offer(events, {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.id,
        runOrdinal: accepted.run.ordinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Fiber.join(waiting);
      yield* worker.drain();

      const replayed = yield* threadManagement.sendToThread(input);
      assert.equal(replayed.dispatch.replayed, true);
      assert.equal(replayed.delivery, accepted.delivery);
      assert.equal(replayed.message.id, accepted.message.id);
      assert.equal(replayed.run.id, accepted.run.id);
      assert.equal(replayed.run.status, "completed");

      const fresh = yield* threadManagement
        .sendToThread({
          ...input,
          commandId: CommandId.make("fresh-steer"),
          messageId: MessageId.make("message:fresh-steer"),
        })
        .pipe(Effect.flip);
      assert.equal(fresh._tag, "ThreadManagementNoSteerableRunError");
      yield* worker.drain();
      assert.deepEqual(steered, [
        `[Ankiel Code: this message came through Ankiel Code's tools, not from the user typing in this chat.]\n\n${input.text}`,
      ]);
      assert.lengthOf(started, 1);
    }).pipe(
      Effect.provide(
        ThreadManagementService.layer.pipe(
          Layer.provideMerge(layer),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        ),
      ),
    );
  }),
);
