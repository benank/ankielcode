import { vi } from "vite-plus/test";
import { historyResponseItems } from "@ankielcode/provider-core/server/handoffBudget";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  type ChatAttachment,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  ProviderDriverKind,
} from "@ankielcode/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import {
  ClaudeBackgroundWorkBlocksQueryReplacementError,
  ClaudeProviderCapabilitiesV2,
} from "../Adapters/ClaudeAdapterV2.ts";
import {
  CodexProviderCapabilitiesV2,
  canReuseCodexContextUsage,
} from "../Adapters/CodexAdapterV2.ts";
import { AcpProviderCapabilitiesV2 } from "@ankielcode/provider-acp/server/adapter";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import { makeProviderFailure } from "@ankielcode/provider-core/server/failure";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
  GROK_MODEL_SELECTION,
} from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@ankielcode/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const threadId = ThreadId.make("thread:provider-switch");
const projectId = ProjectId.make("project:provider-switch");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const GROK_DRIVER = ProviderDriverKind.make("acp");

interface CapturedTurn {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly nativeThreadId?: string | null;
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
}

function unimplemented(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
}

function makeTestAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly modelSelection: ModelSelection;
  readonly responseByRunOrdinal: Readonly<Record<number, string>>;
  readonly responseByThreadId?: Readonly<Record<string, Readonly<Record<number, string>>>>;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly injectedHistory?: Ref.Ref<ReadonlyArray<unknown>>;
  readonly failStartOnce?: Ref.Ref<boolean>;
  readonly refuseStarts?: Ref.Ref<number>;
  readonly refusalCause?: unknown;
  readonly failInjectionOnce?: Ref.Ref<boolean>;
  readonly nativeThreadGeneration?: Ref.Ref<number>;
  readonly failResume?: boolean;
  readonly failResumeOnce?: Ref.Ref<boolean>;
  readonly initialContextUsage?: OrchestrationV2ProviderThread["contextUsage"];
  readonly getModelContextWindow?: (selection: ModelSelection) => number | undefined;
  readonly canReuseContextUsage?: ProviderAdapter.ProviderAdapterV2SessionRuntime["canReuseContextUsage"];
  readonly tokenUsageByRunOrdinal?: Readonly<
    Record<number, Omit<OrchestrationV2ProviderTurnTokenUsage, "updatedAt">>
  >;
  readonly failure?: ReturnType<typeof makeProviderFailure>;
  readonly rejectedNativeThreads?: Ref.Ref<ReadonlySet<string>>;
  readonly failedRunOrdinals?: ReadonlySet<number>;
  readonly promptDroppedRunOrdinals?: ReadonlySet<number>;
  readonly brokenRunOrdinals?: ReadonlySet<number>;
  readonly interruptedRunOrdinals?: ReadonlySet<number>;
  readonly cancelledRunOrdinals?: ReadonlySet<number>;
  readonly holdRunOrdinal?: number;
  readonly pendingBackgroundWork?: Ref.Ref<boolean>;
  readonly subagentOnlyBackgroundWork?: boolean;
  readonly holdFirstTurn?: Deferred.Deferred<void>;
  readonly releaseFirstTurn?: Deferred.Deferred<void>;
  readonly holdOpenSession?: Deferred.Deferred<void>;
  /** A tool call the held turn reports running before it holds. */
  readonly heldRunningToolCall?: {
    readonly id: TurnItemId;
    readonly toolName: string;
  };
  readonly backgroundTasksEndWithProcess?: true;
  readonly backgroundWork?: Ref.Ref<boolean>;
  readonly closedSessions?: Ref.Ref<ReadonlyArray<string>>;
  /** Like ACP: opening resumes the initial native id, and forcing a new thread restarts the runtime. */
  readonly runtimeStarts?: Ref.Ref<ReadonlyArray<string>>;
  // ACP cannot truncate, so its rollback answers with a fresh, empty native session.
  readonly rollback?: "truncates" | "replaces_native_thread";
  readonly beforeForcedNativeThread?: Effect.Effect<void>;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        if (input.holdOpenSession !== undefined) yield* Deferred.await(input.holdOpenSession);
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        if (input.runtimeStarts !== undefined) {
          yield* Ref.update(input.runtimeStarts, (starts) => [
            ...starts,
            sessionInput.initialNativeThreadId ?? "new",
          ]);
        }
        if (input.closedSessions !== undefined) {
          const closedSessions = input.closedSessions;
          yield* Effect.addFinalizer(() =>
            Ref.update(closedSessions, (ids) => [...ids, sessionInput.providerSessionId]),
          );
        }
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ...(input.backgroundTasksEndWithProcess === undefined
            ? {}
            : { backgroundTasksEndWithProcess: input.backgroundTasksEndWithProcess }),
          ...(input.pendingBackgroundWork === undefined
            ? {}
            : {
                hasPendingBackgroundWorkForThread: (_thread, options) =>
                  input.subagentOnlyBackgroundWork && options?.includeSubagents !== true
                    ? Effect.succeed(false)
                    : Ref.get(input.pendingBackgroundWork!),
              }),
          ...(input.getModelContextWindow === undefined
            ? {}
            : { getModelContextWindow: input.getModelContextWindow }),
          ...(input.canReuseContextUsage === undefined
            ? {}
            : { canReuseContextUsage: input.canReuseContextUsage }),
          ...(input.backgroundWork === undefined
            ? {}
            : {
                // Like Claude: native subagents are visible only to the session-wide
                // probe, never to the per-thread roster probe.
                hasPendingBackgroundWork: Ref.get(input.backgroundWork),
                hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
              }),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              if (threadInput.forceNewNativeThread && input.runtimeStarts !== undefined) {
                yield* Ref.update(input.runtimeStarts, (starts) => [...starts, "replacement"]);
              }
              if (threadInput.forceNewNativeThread && input.beforeForcedNativeThread !== undefined)
                yield* input.beforeForcedNativeThread;
              const createdAt = yield* DateTime.now;
              const generation =
                input.nativeThreadGeneration === undefined
                  ? ""
                  : `:${yield* Ref.getAndUpdate(input.nativeThreadGeneration, (value) => value + 1)}`;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}${generation}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                contextUsage: input.initialContextUsage ?? null,
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) =>
            Effect.gen(function* () {
              if (
                (input.brokenRunOrdinals !== undefined && providerThread.status === "error") ||
                input.failResume ||
                (input.failResumeOnce !== undefined &&
                  (yield* Ref.getAndSet(input.failResumeOnce, false)))
              )
                return yield* unimplemented(input.driver, "simulated native resume failure");
              return providerThread;
            }),
          ...(input.injectedHistory === undefined
            ? {}
            : {
                injectHistory: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                  Ref.update(input.injectedHistory!, (current) => [
                    ...current,
                    ...historyResponseItems(history.messages, history.context),
                  ]).pipe(
                    Effect.andThen(
                      Effect.gen(function* () {
                        if (
                          input.failInjectionOnce !== undefined &&
                          (yield* Ref.getAndSet(input.failInjectionOnce, false))
                        )
                          return yield* unimplemented(
                            input.driver,
                            "lost injection acknowledgement",
                          );
                        return true;
                      }),
                    ),
                  ),
              }),
          compactThread: (turnInput) => runtime.startTurn(turnInput),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              if (
                input.failStartOnce !== undefined &&
                (yield* Ref.getAndSet(input.failStartOnce, false))
              )
                return yield* unimplemented(input.driver, "turn start failed after injection");
              if (
                input.refuseStarts !== undefined &&
                (yield* Ref.getAndUpdate(input.refuseStarts, (left) => Math.max(0, left - 1))) > 0
              )
                return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: input.driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause:
                    input.refusalCause ?? new ClaudeBackgroundWorkBlocksQueryReplacementError(),
                });
              yield* Effect.yieldNow;
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  driver: input.driver,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  text: turnInput.message.text,
                  modelSelection: turnInput.modelSelection,
                  attachments: turnInput.message.attachments,
                  nativeThreadId: turnInput.providerThread.nativeThreadRef?.nativeId ?? null,
                  providerTurnOrdinal: turnInput.providerTurnOrdinal,
                  ...(turnInput.nativeThreadHasTurns === undefined
                    ? {}
                    : { nativeThreadHasTurns: turnInput.nativeThreadHasTurns }),
                },
              ]);
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              if (
                turnInput.runOrdinal === (input.holdRunOrdinal ?? 1) &&
                input.holdFirstTurn !== undefined
              ) {
                if (input.heldRunningToolCall !== undefined) {
                  const startedAt = yield* DateTime.now;
                  yield* PubSub.publish(events, {
                    type: "provider_turn.updated",
                    driver: input.driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: turnInput.providerThread.id,
                      nodeId: turnInput.rootNodeId,
                      runAttemptId: turnInput.attemptId,
                      nativeTurnRef: null,
                      ordinal: turnInput.runOrdinal,
                      status: "running",
                      startedAt,
                      completedAt: null,
                    },
                  });
                  yield* PubSub.publish(events, {
                    type: "turn_item.updated",
                    driver: input.driver,
                    turnItem: {
                      id: input.heldRunningToolCall.id,
                      threadId: turnInput.threadId,
                      runId: turnInput.runId,
                      nodeId: turnInput.rootNodeId,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: turnInput.runOrdinal * 100 + 1,
                      status: "running",
                      title: null,
                      startedAt,
                      completedAt: null,
                      updatedAt: startedAt,
                      type: "dynamic_tool",
                      toolName: input.heldRunningToolCall.toolName,
                      input: {},
                    },
                  });
                }
                yield* Deferred.succeed(input.holdFirstTurn, undefined);
                if (input.releaseFirstTurn === undefined) return;
                yield* Deferred.await(input.releaseFirstTurn);
              }
              const eventTime = yield* DateTime.now;
              const nativeThreadId = turnInput.providerThread.nativeThreadRef?.nativeId ?? "";
              if (
                input.rejectedNativeThreads &&
                input.failedRunOrdinals?.has(turnInput.runOrdinal)
              ) {
                yield* Ref.update(
                  input.rejectedNativeThreads,
                  (ids) => new Set([...ids, nativeThreadId]),
                );
              }
              const rejectedHistory =
                input.rejectedNativeThreads !== undefined &&
                (yield* Ref.get(input.rejectedNativeThreads)).has(nativeThreadId);
              const terminalStatus =
                input.failedRunOrdinals?.has(turnInput.runOrdinal) || rejectedHistory
                  ? "failed"
                  : input.interruptedRunOrdinals?.has(turnInput.runOrdinal)
                    ? "interrupted"
                    : input.cancelledRunOrdinals?.has(turnInput.runOrdinal)
                      ? "cancelled"
                      : "completed";
              const response =
                input.responseByThreadId?.[turnInput.threadId]?.[turnInput.runOrdinal] ??
                input.responseByRunOrdinal[turnInput.runOrdinal] ??
                `${input.driver} response for run ${turnInput.runOrdinal}`;
              const providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: terminalStatus,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    ...(input.promptDroppedRunOrdinals?.has(turnInput.runOrdinal)
                      ? { promptDropped: true as const }
                      : {}),
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: terminalStatus,
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.driver}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: rejectedHistory ? "" : response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  ...(terminalStatus === "failed"
                    ? {
                        status: terminalStatus,
                        failureItemOrdinal: turnInput.runOrdinal * 100 + 2,
                        failure:
                          input.failure ??
                          makeProviderFailure({
                            message: "Simulated provider failure.",
                            code: "simulated_failure",
                            class: "provider_error",
                          }),
                      }
                    : { status: terminalStatus, failure: null }),
                  threadDisposition: input.brokenRunOrdinals?.has(turnInput.runOrdinal)
                    ? "broken"
                    : "reusable",
                  ...(input.promptDroppedRunOrdinals?.has(turnInput.runOrdinal)
                    ? { promptDropped: true as const }
                    : {}),
                },
              ];
              const reportedUsage = input.tokenUsageByRunOrdinal?.[turnInput.runOrdinal];
              const turnEvent = providerEvents[0];
              if (reportedUsage && turnEvent?.type === "provider_turn.updated") {
                yield* PubSub.publish(events, {
                  ...turnEvent,
                  providerTurn: {
                    ...turnEvent.providerTurn,
                    status: "running",
                    completedAt: null,
                    tokenUsage: { ...reportedUsage, updatedAt: DateTime.formatIso(eventTime) },
                  },
                });
              }
              if (input.brokenRunOrdinals?.has(turnInput.runOrdinal)) {
                yield* PubSub.publish(events, {
                  type: "provider_thread.updated",
                  driver: input.driver,
                  providerThread: {
                    ...turnInput.providerThread,
                    status: "error",
                    updatedAt: eventTime,
                  },
                });
              }
              for (const event of providerEvents) {
                yield* PubSub.publish(events, event);
              }
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            unimplemented(input.driver, "readThreadSnapshot unused in provider switch test"),
          rollbackThread: ({ providerThread }) =>
            input.rollback === undefined
              ? unimplemented(input.driver, "rollbackThread unused in provider switch test")
              : Effect.succeed({
                  providerThread:
                    input.rollback === "truncates" || providerThread.nativeThreadRef === null
                      ? providerThread
                      : {
                          ...providerThread,
                          nativeThreadRef: {
                            ...providerThread.nativeThreadRef,
                            nativeId: `${providerThread.nativeThreadRef.nativeId}:after-rollback`,
                          },
                          nativeConversationHeadRef: null,
                        },
                  providerTurns: [],
                  messages: [],
                  runtimeRequests: [],
                }),
          forkThread: () =>
            unimplemented(input.driver, "forkThread unused in provider switch test"),
        };
        return runtime;
      }),
  };
}

const waitForIdle = Effect.fn("ProviderSwitchTest.waitForIdle")(function* (
  targetThreadId: ThreadId,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const isIdle = (projection: OrchestrationV2ThreadProjection) =>
    projection.runs.every(
      (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
    );
  const afterSequence = yield* eventSink.latestSequence();
  const current = yield* orchestrator.getThreadProjection(targetThreadId);
  if (isIdle(current)) {
    return current;
  }
  // Projections commit with their events, so each later event is the only time to re-read.
  const [idle] = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(targetThreadId)),
    Stream.filter(isIdle),
    Stream.take(1),
    Stream.runCollect,
  );
  if (idle === undefined) {
    return yield* Effect.die(
      new Error("Provider switch test event stream ended before the thread went idle"),
    );
  }
  return idle;
});

describe("orchestration v2 provider switching", () => {
  it.live.each([
    "compact-native",
    "compact-legacy",
    "large-current-input",
    "screenshot-fallback",
    "screenshot-reported-capacity-native",
    "screenshot-option-change-retry-native",
    "screenshot-exhausted-target-native",
    "screenshot-exhausted-target-fallback",
    "screenshot-exhausted-target-estimate-native",
    "screenshot-exhausted-target-oversized-native",
    "screenshot-exhausted-target-tight-native",
    "screenshot-exhausted-target-background-native",
    "screenshot-exhausted-target-subagent-native",
    "prior-images-reasoning-change-replacement-small-native",
    "imported-prior-images-fallback",
    "prior-images-telemetry-native",
    "prior-images-unsent-native",
    "prior-images-legacy-replacement-native",
    "delivery-write-failure",
  ] as const)("preserves handoffs through %s", (scenario) =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`handoff-${scenario}`);
      const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const reasoningScenario = scenario.includes("reasoning-change");
      const turnUsageScenario = reasoningScenario || scenario.includes("turn-usage");
      const modelScenario =
        scenario.includes("model") || scenario.includes("option-change") || reasoningScenario;
      const failStartOnce = yield* Ref.make(false);
      const failResumeOnce = yield* Ref.make(false);
      const generation = yield* Ref.make(0);
      const pendingBackgroundWork = yield* Ref.make(false);
      const priorImages = scenario.includes("prior-images");
      const exhaustedTarget = scenario.includes("exhausted-target");
      const replaceNative = scenario.includes("replacement");
      const capacityScenario = modelScenario || scenario.includes("reported-capacity");
      const returning =
        scenario === "large-current-input" ||
        scenario.includes("-change-") ||
        priorImages ||
        exhaustedTarget;
      const targetSelection: ModelSelection = !modelScenario
        ? CLAUDE_MODEL_SELECTION
        : {
            ...CLAUDE_MODEL_SELECTION,
            ...(reasoningScenario
              ? { options: [{ id: "reasoningEffort", value: "low" }] }
              : scenario.includes("option-change")
                ? { options: [{ id: "contextWindow", value: "1m" }] }
                : { model: `${CLAUDE_MODEL_SELECTION.model}-large` }),
          };
      const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
        makeTestAdapter({
          instanceId: CODEX_MODEL_SELECTION.instanceId,
          driver: CODEX_DRIVER,
          capabilities: CodexProviderCapabilitiesV2,
          modelSelection: CODEX_MODEL_SELECTION,
          responseByRunOrdinal: { 1: "Original partial work" },
          capturedTurns,
        }),
        makeTestAdapter({
          instanceId: CLAUDE_MODEL_SELECTION.instanceId,
          driver: CLAUDE_DRIVER,
          capabilities: ClaudeProviderCapabilitiesV2,
          modelSelection: CLAUDE_MODEL_SELECTION,
          responseByRunOrdinal: scenario.includes("target-estimate")
            ? { 2: "x".repeat(64_000) }
            : {},
          capturedTurns,
          ...(scenario.includes("retry") || scenario.includes("unsent") ? { failStartOnce } : {}),
          ...(replaceNative ? { failResumeOnce, nativeThreadGeneration: generation } : {}),
          ...(exhaustedTarget ? { nativeThreadGeneration: generation } : {}),
          ...(scenario.includes("target-background") || scenario.includes("target-subagent")
            ? {
                pendingBackgroundWork,
                subagentOnlyBackgroundWork: scenario.includes("target-subagent"),
              }
            : {}),
          ...(scenario.includes("reported-capacity")
            ? { initialContextUsage: { usedTokens: 999_999, maxTokens: 1_000_000 } }
            : {}),
          ...(turnUsageScenario
            ? {
                canReuseContextUsage: canReuseCodexContextUsage,
                tokenUsageByRunOrdinal: {
                  2: {
                    usedTokens: replaceNative ? 30_000 : 37_321,
                    maxTokens: replaceNative
                      ? scenario.includes("small")
                        ? 32_000
                        : 64_000
                      : 258_400,
                  },
                },
              }
            : modelScenario
              ? {
                  getModelContextWindow: (selection: ModelSelection) =>
                    selection.model.endsWith("-large") ||
                    selection.options?.some(
                      (option) => option.id === "contextWindow" && option.value === "1m",
                    )
                      ? 1_000_000
                      : 32_000,
                }
              : scenario === "large-current-input" || priorImages || exhaustedTarget
                ? {
                    getModelContextWindow: () =>
                      scenario.includes("target-tight") ? 18_241 : 32_000,
                  }
                : {}),
          ...(scenario.endsWith("-native") || scenario === "large-current-input"
            ? { injectedHistory }
            : {}),
        }),
      ]);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const screenshot: ChatAttachment = {
          type: "image",
          id: "screenshot",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 100_000,
        };
        const screenshots = Array.from(
          {
            length:
              scenario.includes("eight") || capacityScenario
                ? 8
                : scenario.includes("pair")
                  ? 2
                  : 1,
          },
          (_, index) => ({ ...screenshot, id: `screenshot-${index}` }),
        );
        const targetOrdinal = returning ? 4 : 2;
        const dispatch = (ordinal: number, text: string, selection: ModelSelection) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`regression:${ordinal}`),
            threadId,
            messageId: MessageId.make(`regression:${ordinal}`),
            createdBy: "user",
            creationSource: "web",
            text,
            attachments:
              turnUsageScenario && ordinal === 2
                ? Array.from({ length: 8 }, (_, index) => ({
                    ...screenshot,
                    id: `prior-${index}`,
                  }))
                : turnUsageScenario && ordinal >= targetOrdinal
                  ? [screenshot, { ...screenshot, id: "current-2" }]
                  : scenario.startsWith("screenshot") &&
                      ordinal >= targetOrdinal &&
                      (!exhaustedTarget || ordinal === targetOrdinal)
                    ? screenshots
                    : priorImages && ordinal === (scenario.startsWith("imported") ? 1 : 2)
                      ? [screenshot]
                      : [],
            modelSelection: selection,
            dispatchMode: { type: "start_immediately" },
          });
        const wait = (ordinal: number) =>
          orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.payload.ordinal === ordinal &&
                (event.payload.status === "completed" || event.payload.status === "failed"),
            ),
            Stream.runHead,
            Effect.andThen(worker.drain()),
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("regression:create"),
          threadId,
          projectId,
          createdBy: "user",
          creationSource: "web",
          title: "Handoff regression",
          modelSelection: CODEX_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* dispatch(1, "Original request with constraints", CODEX_MODEL_SELECTION);
        yield* wait(1);
        const write = eventSink.write;
        const spy =
          scenario === "delivery-write-failure"
            ? vi.spyOn(eventSink, "write").mockImplementation((input) =>
                input.events.some(
                  (event) =>
                    event.type === "context-handoff.updated" &&
                    event.payload.delivery?.status === "inline",
                )
                  ? Effect.fail(
                      new EventSink.EventSinkWriteError({
                        eventCount: input.events.length,
                        cause: "bookkeeping unavailable",
                      }),
                    )
                  : write(input),
              )
            : undefined;
        yield* Effect.addFinalizer(() => Effect.sync(() => spy?.mockRestore()));
        const current = scenario.startsWith("compact")
          ? "/compact"
          : scenario.includes("target-oversized")
            ? "x".repeat(40_000)
            : capacityScenario && !turnUsageScenario
              ? "x".repeat(70_000)
              : scenario === "large-current-input"
                ? "x".repeat(9_000)
                : "Continue work";
        if (returning) {
          if (scenario.includes("unsent")) yield* Ref.set(failStartOnce, true);
          yield* dispatch(
            2,
            turnUsageScenario
              ? "x".repeat(27_460)
              : scenario.includes("target-estimate")
                ? "x".repeat(12_000)
                : "Establish target",
            CLAUDE_MODEL_SELECTION,
          );
          yield* wait(2);
          if (exhaustedTarget) {
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
              "completed",
            );
          }
          if (exhaustedTarget && !scenario.includes("target-estimate")) {
            const target = (yield* orchestrator.getThreadProjection(threadId)).providerThreads.find(
              (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            )!;
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("exhausted-target-usage"),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: { ...target, contextUsage: { usedTokens: 30_000, maxTokens: 32_000 } },
                },
              ],
            });
          }
          if (modelScenario && !turnUsageScenario) {
            const target = (yield* orchestrator.getThreadProjection(threadId)).providerThreads.find(
              (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            )!;
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("old-model-usage"),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: {
                    ...target,
                    contextUsage: {
                      usedTokens: 30_000,
                      maxTokens: 32_000,
                      autoCompactThreshold: 31_000,
                    },
                  },
                },
              ],
            });
          }
          if (scenario.includes("legacy-replacement")) {
            const existing = yield* orchestrator.getThreadProjection(threadId);
            yield* eventSink.write({
              events: existing.attempts.map(
                ({ nativeThreadId: _nativeThreadId, ...legacy }, index) => ({
                  id: EventId.make(`legacy-attempt:${index}`),
                  type: "run-attempt.updated" as const,
                  threadId,
                  occurredAt: existing.thread.createdAt,
                  payload: legacy,
                }),
              ),
            });
          }
          if (scenario.includes("telemetry")) {
            const target = (yield* orchestrator.getThreadProjection(threadId)).providerThreads.find(
              (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            )!;
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("compacted-context-usage"),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: { ...target, contextUsage: { usedTokens: 100, maxTokens: 32_000 } },
                },
              ],
            });
          }
          yield* dispatch(
            3,
            priorImages && !replaceNative
              ? "New source constraint " + "q".repeat(9_000)
              : "New source constraint",
            CODEX_MODEL_SELECTION,
          );
          yield* wait(3);
        }
        if (replaceNative) {
          // Switching back to Codex already released Claude's session.
          yield* Ref.set(failResumeOnce, true);
        }
        if (scenario.includes("retry")) yield* Ref.set(failStartOnce, true);
        if (scenario.includes("target-background") || scenario.includes("target-subagent"))
          yield* Ref.set(pendingBackgroundWork, true);
        yield* dispatch(targetOrdinal, current, targetSelection);
        yield* wait(targetOrdinal);
        if (scenario.includes("retry")) {
          const failed = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(failed.runs.at(-1)?.status, "failed");
          const failedUsage = failed.providerThreads.find(
            (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
          )!.contextUsage;
          if (reasoningScenario || scenario.includes("turn-usage")) {
            assert.deepEqual(failedUsage, { usedTokens: 37_321, maxTokens: 258_400 });
          } else {
            assert.deepEqual(failedUsage, { usedTokens: 30_000, maxTokens: 1_000_000 });
          }
          if (reasoningScenario) {
            const target = failed.providerThreads.find(
              (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            )!;
            yield* orchestrator.dispatch({
              type: "provider-session.detach",
              commandId: CommandId.make("detach-before-reasoning-retry"),
              threadId,
              providerSessionId: target.providerSessionId!,
            });
            yield* worker.drain();
          }
          yield* dispatch(targetOrdinal + 1, current, targetSelection);
          yield* wait(targetOrdinal + 1);
        }
        if (reasoningScenario && replaceNative) {
          const replaced = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            replaced.runs.at(-1)?.status,
            scenario.includes("small") ? "failed" : "completed",
          );
          const target = replaced.providerThreads.find(
            (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
          )!;
          assert.isNull(target.contextUsage);
          assert.equal(yield* Ref.get(generation), 2);
          assert.equal(
            (yield* Ref.get(capturedTurns)).at(-1)!.driver,
            scenario.includes("small") ? CODEX_DRIVER : CLAUDE_DRIVER,
          );
          return;
        }
        if (replaceNative) {
          if (scenario.includes("legacy-replacement")) {
            const recovered = yield* orchestrator.getThreadProjection(threadId);
            const handoff = recovered.contextHandoffs.at(-1)!;
            const { history: _history, ...legacyHandoff } = handoff;
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("legacy-replacement-handoff"),
                  type: "context-handoff.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: {
                    ...legacyHandoff,
                    delivery: {
                      nativeThreadId: handoff.delivery!.nativeThreadId,
                      status: handoff.delivery!.status,
                      itemIds: [],
                    },
                  },
                },
              ],
            });
          }
          yield* dispatch(
            targetOrdinal + 1,
            "Continue after native replacement",
            CLAUDE_MODEL_SELECTION,
          );
          yield* wait(targetOrdinal + 1);
          yield* dispatch(
            targetOrdinal + 2,
            "Another source constraint " + "q".repeat(9_000),
            CODEX_MODEL_SELECTION,
          );
          yield* wait(targetOrdinal + 2);
          yield* dispatch(targetOrdinal + 3, current, CLAUDE_MODEL_SELECTION);
          yield* wait(targetOrdinal + 3);
        }
        const projection = yield* orchestrator.getThreadProjection(threadId);
        if (
          scenario.includes("target-oversized") ||
          scenario.includes("target-tight") ||
          scenario.includes("target-background") ||
          scenario.includes("target-subagent")
        ) {
          assert.equal(projection.runs.at(-1)?.status, "failed");
          assert.equal(yield* Ref.get(generation), 1);
          assert.equal(projection.messages.at(-1)!.text, current);
          assert.deepEqual(projection.messages.at(-1)!.attachments, screenshots);
          if (scenario.includes("target-background") || scenario.includes("target-subagent")) {
            assert.isTrue(yield* Ref.get(pendingBackgroundWork));
            const failure = projection.turnItems.findLast((item) => item.type === "error");
            assert.equal(
              failure?.type === "error" ? failure.failure.message : null,
              "The target provider still has background work running. Wait for it to finish or stop it before retrying the handoff.",
            );
          }
          return;
        }
        assert.equal(projection.runs.at(-1)?.status, "completed");
        if (exhaustedTarget) {
          assert.equal(yield* Ref.get(generation), 2);
          const turns = (yield* Ref.get(capturedTurns)).filter(
            (turn) => turn.driver === CLAUDE_DRIVER,
          );
          assert.notEqual(turns[0]!.nativeThreadId, turns[1]!.nativeThreadId);
          const latestRun = projection.runs.at(-1)!;
          assert.equal(
            projection.attempts.find((attempt) => attempt.id === latestRun.activeAttemptId)!
              .nativeThreadId,
            turns[1]!.nativeThreadId,
          );
          const context = scenario.endsWith("-native")
            ? yield* encodeJson(yield* Ref.get(injectedHistory))
            : turns[1]!.text;
          assert.include(context, "Original request with constraints");
          assert.include(context, "Original partial work");
          assert.include(context, "New source constraint");
          assert.include(turns[1]!.text, current);
          assert.deepEqual(turns[1]!.attachments, screenshots);
          const historyBeforeFollowup = yield* Ref.get(injectedHistory);
          yield* dispatch(5, "Continue after automatic recovery", CLAUDE_MODEL_SELECTION);
          yield* wait(5);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
            "completed",
          );
          assert.equal(yield* Ref.get(generation), 2);
          assert.equal(
            (yield* Ref.get(capturedTurns)).at(-1)!.text,
            "Continue after automatic recovery",
          );
          assert.deepEqual(yield* Ref.get(injectedHistory), historyBeforeFollowup);
          if (scenario.includes("target-estimate")) {
            yield* dispatch(6, "Another source turn", CODEX_MODEL_SELECTION);
            yield* wait(6);
            yield* dispatch(7, "Return after recovery", CLAUDE_MODEL_SELECTION);
            yield* wait(7);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
              "completed",
            );
            assert.equal(yield* Ref.get(generation), 2);
          }
          return;
        }
        if (priorImages) {
          const handoff = projection.contextHandoffs.at(-1)!;
          const context = scenario.endsWith("-native")
            ? yield* encodeJson(yield* Ref.get(injectedHistory))
            : (yield* Ref.get(capturedTurns)).at(-1)!.text;
          const shouldFit =
            turnUsageScenario ||
            scenario.startsWith("imported") ||
            scenario.includes("telemetry") ||
            scenario.includes("unsent") ||
            replaceNative;
          const sourceText =
            `${replaceNative ? "Another" : "New"} source constraint ` + "q".repeat(9_000);
          const sourceItem = projection.turnItems.find(
            (item) => item.type === "user_message" && item.text === sourceText,
          )!;
          assert.isDefined(sourceItem);
          if (shouldFit) {
            assert.include(context, sourceText);
            assert.include(
              projection.contextHandoffs
                .filter(
                  (record) =>
                    record.targetRunId ===
                    (scenario.includes("retry")
                      ? projection.runs.find((run) => run.ordinal === targetOrdinal)!.id
                      : projection.runs.at(-1)!.id),
                )
                .flatMap((record) => record.delivery?.itemIds ?? []),
              sourceItem.id,
            );
          } else {
            assert.notInclude(context, "q".repeat(9_000));
            assert.isAbove(handoff.delivery!.omittedItemIds!.length, 0);
          }
          const latestRun = projection.runs.at(-1)!;
          const latestAttempt = projection.attempts.find(
            (attempt) => attempt.id === latestRun.activeAttemptId,
          )!;
          const target = projection.providerThreads.find(
            (thread) => thread.id === latestAttempt.providerThreadId,
          )!;
          assert.equal(latestAttempt.nativeThreadId, target.nativeThreadRef!.nativeId);
          if (turnUsageScenario) {
            if (replaceNative) assert.isNull(target.contextUsage);
            else assert.deepEqual(target.contextUsage, { usedTokens: 37_321, maxTokens: 258_400 });
            assert.lengthOf((yield* Ref.get(capturedTurns)).at(-1)!.attachments, 2);
          }
          if (replaceNative) assert.equal(yield* Ref.get(generation), 2);
          return;
        }
        const handoff = projection.contextHandoffs.at(-1)!;
        if (scenario.startsWith("screenshot")) {
          assert.deepEqual((yield* Ref.get(capturedTurns)).at(-1)!.attachments, screenshots);
        }
        if (scenario === "compact-legacy") {
          const { history: _history, ...legacyHandoff } = handoff;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("legacy-handoff-shape"),
                type: "context-handoff.updated",
                threadId,
                runId: handoff.targetRunId,
                occurredAt: yield* DateTime.now,
                payload: legacyHandoff,
              },
            ],
          });
          assert.isUndefined(handoff.delivery);
          yield* dispatch(3, "Continue after compact", CLAUDE_MODEL_SELECTION);
          yield* wait(3);
          assert.include(
            (yield* Ref.get(capturedTurns)).at(-1)!.text,
            "Original request with constraints",
          );
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).contextHandoffs.at(-1)?.delivery
              ?.status,
            "inline",
          );
        } else if (
          scenario === "delivery-write-failure" ||
          (scenario.startsWith("screenshot") && scenario.endsWith("fallback"))
        ) {
          assert.equal(
            handoff.delivery?.status,
            scenario.startsWith("screenshot") ? "inline" : "pending",
          );
          assert.include(
            (yield* Ref.get(capturedTurns)).at(-1)!.text,
            "Original request with constraints",
          );
        } else {
          assert.equal(handoff.delivery?.status, "injected");
          assert.equal((yield* Ref.get(capturedTurns)).at(-1)!.text, current);
          assert.include(
            yield* encodeJson(yield* Ref.get(injectedHistory)),
            "Original request with constraints",
          );
        }
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name: `handoff-${scenario}`,
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: { type: "readOnly" },
              },
            },
            layerRegistry,
          ),
        ),
      );
    }),
  );
  it.live.each([
    "turn-start",
    "injection",
    "large-missed-request",
    "exhausted-target-retry",
  ] as const)(
    "recovers %s failure without duplicating history in the same native thread",
    (failure) =>
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`handoff-retry-${failure}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const failOnce = yield* Ref.make(true);
        const generation = yield* Ref.make(0);
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 1: "Original partial work" },
            capturedTurns,
          }),
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            injectedHistory,
            nativeThreadGeneration: generation,
            getModelContextWindow: () => 32_000,
            ...(failure !== "injection"
              ? { failStartOnce: failOnce }
              : { failInjectionOnce: failOnce }),
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const dispatch = (ordinal: number, text: string, selection: ModelSelection) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`retry:${ordinal}`),
              threadId,
              messageId: MessageId.make(`retry:${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text,
              attachments: [],
              modelSelection: selection,
              dispatchMode: { type: "start_immediately" },
            });
          const wait = (ordinal: number, status: "failed" | "completed") =>
            orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.payload.ordinal === ordinal &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
              Effect.andThen(worker.drain()),
              Effect.andThen(
                Effect.gen(function* () {
                  assert.equal(
                    (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
                    status,
                  );
                }),
              ),
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("retry:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Handoff retry",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          yield* dispatch(1, "Original request with constraints", CODEX_MODEL_SELECTION);
          yield* wait(1, "completed");
          yield* dispatch(
            2,
            failure === "large-missed-request" ? "x".repeat(7_000) : "First target request",
            CLAUDE_MODEL_SELECTION,
          );
          yield* wait(2, "failed");
          const failed = yield* orchestrator.getThreadProjection(threadId);
          const failedHandoff = failed.contextHandoffs.at(-1)!;
          assert.equal(
            failedHandoff.delivery?.status,
            failure !== "injection" ? "injected" : "pending",
          );
          const historyBeforeRetry = (yield* Ref.get(injectedHistory)).length;
          if (failure === "exhausted-target-retry") {
            const target = failed.providerThreads.find(
              (thread) => thread.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
            )!;
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("exhausted-retry-usage"),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: { ...target, contextUsage: { usedTokens: 30_000, maxTokens: 32_000 } },
                },
              ],
            });
          }
          const retryText =
            failure === "large-missed-request" ? "y".repeat(10_000) : "Retry target request";
          yield* dispatch(3, retryText, CLAUDE_MODEL_SELECTION);
          yield* wait(3, "completed");
          const retried = yield* orchestrator.getThreadProjection(threadId);
          const lastTurn = (yield* Ref.get(capturedTurns)).at(-1)!;
          assert.equal(lastTurn.text, retryText);
          if (failure !== "injection" && failure !== "exhausted-target-retry") {
            const delta = yield* encodeJson(
              (yield* Ref.get(injectedHistory)).slice(historyBeforeRetry),
            );
            if (failure === "large-missed-request") {
              assert.include(delta, "omitted 1 items");
              const missedRequest = retried.turnItems.find(
                (item) => item.type === "user_message" && item.text === "x".repeat(7_000),
              )!;
              const delivery = retried.contextHandoffs.at(-1)!.delivery!;
              assert.include(delivery.omittedItemIds ?? [], missedRequest.id);
              assert.notInclude(delivery.itemIds, missedRequest.id);
            } else assert.include(delta, "First target request");
            assert.notInclude(delta, "Original request with constraints");
            assert.notInclude(delta, "Original partial work");
            assert.equal(yield* Ref.get(generation), 1);
          } else {
            assert.equal(yield* Ref.get(generation), 2);
            assert.notEqual(
              retried.contextHandoffs.at(-1)?.delivery?.nativeThreadId,
              failedHandoff.delivery?.nativeThreadId,
            );
            const newHistory = yield* encodeJson(
              (yield* Ref.get(injectedHistory)).slice(historyBeforeRetry),
            );
            assert.include(newHistory, "Original request with constraints");
            assert.include(newHistory, "Original partial work");
            assert.notInclude(newHistory, "Retry target request");
          }
          const beforeFollowup = yield* Ref.get(injectedHistory);
          const followup = "z".repeat(6_000);
          yield* dispatch(4, followup, CLAUDE_MODEL_SELECTION);
          yield* wait(4, "completed");
          assert.equal((yield* Ref.get(capturedTurns)).at(-1)!.text, followup);
          assert.deepEqual(yield* Ref.get(injectedHistory), beforeFollowup);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).contextHandoffs.length,
            retried.contextHandoffs.length,
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: `handoff-retry-${failure}`,
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              layerRegistry,
            ),
          ),
        );
      }),
  );

  const importedNativeSessionScenario = (
    scenario: "first-send" | "after-failed-switch" | "resume-fails",
  ) =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`imported-native-session-${scenario}`);
      const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const claudeOrdinal = scenario === "after-failed-switch" ? 2 : 1;
      const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
        makeTestAdapter({
          instanceId: CLAUDE_MODEL_SELECTION.instanceId,
          driver: CLAUDE_DRIVER,
          capabilities: ClaudeProviderCapabilitiesV2,
          modelSelection: CLAUDE_MODEL_SELECTION,
          responseByRunOrdinal: { [claudeOrdinal]: "PELICAN" },
          capturedTurns,
          failResume: scenario === "resume-fails",
        }),
        makeTestAdapter({
          instanceId: CODEX_MODEL_SELECTION.instanceId,
          driver: CODEX_DRIVER,
          capabilities: CodexProviderCapabilitiesV2,
          modelSelection: CODEX_MODEL_SELECTION,
          responseByRunOrdinal: {},
          capturedTurns,
          failedRunOrdinals: new Set([1]),
        }),
      ]);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("imported-native:create"),
          threadId,
          projectId,
          createdBy: "system",
          creationSource: "server",
          title: "Imported Claude Code session",
          modelSelection: CLAUDE_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        // The rows AgentSessionImporter writes: imported messages without a run,
        // bound to the strong native session they came from.
        const created = yield* orchestrator.getThreadProjection(threadId);
        const at = created.thread.createdAt;
        const providerThread: OrchestrationV2ProviderThread = {
          id: ProviderThreadId.make("provider-thread:imported-native"),
          driver: CLAUDE_DRIVER,
          providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: CLAUDE_DRIVER,
            nativeId: "native-session",
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: at,
          updatedAt: at,
        };
        const common = {
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          status: "completed" as const,
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
        };
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("imported-native:thread"),
              type: "thread.metadata-updated",
              threadId,
              providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
              occurredAt: at,
              payload: {
                ...created.thread,
                historyOrigin: "v1_import",
                activeProviderThreadId: providerThread.id,
              },
            },
            {
              id: EventId.make("imported-native:user"),
              type: "turn-item.updated",
              threadId,
              occurredAt: at,
              payload: {
                ...common,
                id: TurnItemId.make("imported-native:user"),
                ordinal: 1,
                createdBy: "user",
                creationSource: "server",
                type: "user_message",
                messageId: MessageId.make("imported-native:user"),
                inputIntent: "turn_start",
                text: "Remember the code word PELICAN.",
                attachments: [],
              },
            },
            {
              id: EventId.make("imported-native:assistant"),
              type: "turn-item.updated",
              threadId,
              occurredAt: at,
              payload: {
                ...common,
                id: TurnItemId.make("imported-native:assistant"),
                ordinal: 2,
                type: "assistant_message",
                messageId: MessageId.make("imported-native:assistant"),
                text: "OK",
                streaming: false,
              },
            },
            {
              id: EventId.make("imported-native:provider-thread"),
              type: "provider-thread.updated",
              threadId,
              driver: CLAUDE_DRIVER,
              providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
              occurredAt: at,
              payload: providerThread,
            },
          ],
        });
        const send = (ordinal: number, modelSelection: ModelSelection) =>
          Effect.gen(function* () {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`imported-native:${ordinal}`),
              threadId,
              messageId: MessageId.make(`imported-native:${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text: "What was the code word?",
              attachments: [],
              modelSelection,
              dispatchMode: { type: "start_immediately" },
            });
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.payload.ordinal === ordinal &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
          });
        if (scenario === "after-failed-switch") yield* send(1, CODEX_MODEL_SELECTION);
        yield* send(claudeOrdinal, CLAUDE_MODEL_SELECTION);

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runs.at(-1)?.status, "completed");
        const claudeTurn = (yield* Ref.get(capturedTurns)).findLast(
          (turn) => turn.driver === CLAUDE_DRIVER,
        );
        const importHandoffTargets = projection.contextHandoffs
          .filter((handoff) => handoff.strategy === "manual_context")
          .map((handoff) => handoff.toProviderThreadId);
        if (scenario === "resume-fails") {
          // The replacement session is empty, so the recovery summary carries the import.
          assert.notEqual(claudeTurn?.nativeThreadId, "native-session");
          assert.deepEqual(
            projection.contextHandoffs.map((handoff) => handoff.strategy),
            ["full_thread_summary"],
          );
          assert.include(claudeTurn?.text ?? "", "Remember the code word PELICAN.");
          return;
        }
        assert.equal(claudeTurn?.nativeThreadId, "native-session");
        assert.notInclude(importHandoffTargets, providerThread.id);
        assert.lengthOf(importHandoffTargets, scenario === "after-failed-switch" ? 1 : 0);
        if (scenario === "first-send") assert.deepEqual(projection.contextHandoffs, []);
        assert.notInclude(claudeTurn?.text ?? "", "Remember the code word PELICAN.");
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name: `imported-native-session-${scenario}`,
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: { type: "readOnly" },
              },
            },
            layerRegistry,
          ),
        ),
      );
    });
  it.live("resumes an imported native session without resending its history", () =>
    importedNativeSessionScenario("first-send"),
  );

  it.live.each([
    "live",
    "legacy",
    "raw-error",
    "other-error",
    "repaired-native",
    "background",
  ] as const)("recovers invalid encrypted Codex history on the next prompt: %s", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("codex-rejected-history");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const generation = yield* Ref.make(0);
        const rejectedNativeThreads = yield* Ref.make<ReadonlySet<string>>(new Set());
        const pendingBackgroundWork = yield* Ref.make(false);
        const code =
          scenario === "raw-error"
            ? "other"
            : scenario === "other-error"
              ? "serverOverloaded"
              : "invalid_encrypted_content";
        const registry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            capturedTurns,
            injectedHistory,
            nativeThreadGeneration: generation,
            rejectedNativeThreads,
            pendingBackgroundWork,
            subagentOnlyBackgroundWork: true,
            failedRunOrdinals: new Set([2]),
            failure: makeProviderFailure({
              code,
              message:
                scenario === "raw-error"
                  ? JSON.stringify({
                      error: {
                        code: "invalid_encrypted_content",
                        message: "Encrypted content could not be verified",
                      },
                    })
                  : "Encrypted content could not be verified",
              class: "provider_error",
            }),
            responseByRunOrdinal: { 1: "BASELINE_OK", 3: "RECOVERY_OK", 4: "FOLLOWUP_OK" },
          }),
        ]);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const dispatch = Effect.fn("rejectedHistory.dispatch")(function* (
            ordinal: number,
            text: string,
          ) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`rejected:${ordinal}`),
              threadId,
              messageId: MessageId.make(`rejected:${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text,
              attachments: [],
              modelSelection: CODEX_MODEL_SELECTION,
              dispatchMode: { type: "start_immediately" },
            });
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.payload.ordinal === ordinal &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
            return yield* orchestrator.getThreadProjection(threadId);
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("rejected:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Rejected Codex history",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          assert.equal(
            (yield* dispatch(1, "Reply BASELINE_OK; remember the constraint")).runs.at(-1)?.status,
            "completed",
          );
          const failed = yield* dispatch(2, "Continue using encrypted history");
          assert.equal(failed.runs.at(-1)?.status, "failed");
          assert.isTrue(
            failed.turnItems.some((item) => item.type === "error" && item.failure.code === code),
          );
          if (scenario === "legacy") {
            yield* orchestrator.dispatch({
              type: "provider-session.detach",
              commandId: CommandId.make("rejected:detach"),
              threadId,
              providerSessionId: failed.providerThreads[0]!.providerSessionId!,
            });
            yield* worker.drain();
          }
          if (scenario === "legacy") {
            yield* (yield* EventSink.EventSinkV2).write({
              events: failed.attempts.map(
                ({ nativeThreadId: _nativeThreadId, ...attempt }, index) => ({
                  id: EventId.make(`rejected:legacy:${index}`),
                  type: "run-attempt.updated" as const,
                  threadId,
                  occurredAt: failed.thread.createdAt,
                  payload: attempt,
                }),
              ),
            });
          }
          if (scenario === "repaired-native") {
            const providerThread = failed.providerThreads[0]!;
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("rejected:repaired-native"),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: failed.thread.createdAt,
                  payload: {
                    ...providerThread,
                    nativeThreadRef: {
                      ...providerThread.nativeThreadRef!,
                      nativeId: "already-repaired",
                    },
                  },
                },
              ],
            });
          }
          if (scenario === "background") yield* Ref.set(pendingBackgroundWork, true);
          const recovered = yield* dispatch(3, "huh");
          if (scenario === "repaired-native") {
            assert.equal(recovered.runs.at(-1)?.status, "completed");
            assert.equal(yield* Ref.get(generation), 1);
            assert.lengthOf(recovered.contextHandoffs, 0);
            return;
          }
          if (scenario === "other-error" || scenario === "background") {
            assert.equal(recovered.runs.at(-1)?.status, "failed");
            assert.equal(yield* Ref.get(generation), 1);
            assert.lengthOf(yield* Ref.get(capturedTurns), scenario === "background" ? 2 : 3);
            if (scenario === "background") {
              yield* Ref.set(pendingBackgroundWork, false);
              assert.equal(
                (yield* dispatch(4, "Continue after the worker finished")).runs.at(-1)?.status,
                "completed",
              );
              assert.equal(yield* Ref.get(generation), 2);
            }
            return;
          }
          assert.equal(recovered.runs.at(-1)?.status, "completed");
          assert.equal(yield* Ref.get(generation), 2);
          const turns = yield* Ref.get(capturedTurns);
          assert.lengthOf(turns, 3);
          assert.equal(turns[2]!.text, "huh");
          assert.notEqual(turns[2]!.nativeThreadId, turns[1]!.nativeThreadId);
          assert.equal(turns[2]!.providerThreadId, turns[1]!.providerThreadId);
          const history = yield* encodeJson(yield* Ref.get(injectedHistory));
          assert.include(history, "remember the constraint");
          assert.include(history, "BASELINE_OK");
          assert.notInclude(history, '"encrypted_content"');
          assert.notInclude(history, "huh");
          assert.isTrue(
            recovered.turnItems.some(
              (item) => item.type === "assistant_message" && item.text === "RECOVERY_OK",
            ),
          );
          const next = yield* dispatch(4, "ok");
          assert.equal(next.runs.at(-1)?.status, "completed");
          assert.equal(yield* Ref.get(generation), 2);
          assert.equal(
            (yield* Ref.get(capturedTurns))[3]!.nativeThreadId,
            turns[2]!.nativeThreadId,
          );
          assert.equal(yield* encodeJson(yield* Ref.get(injectedHistory)), history);
          assert.equal(next.contextHandoffs.length, recovered.contextHandoffs.length);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "codex-rejected-history",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              registry,
            ),
          ),
        );
      }),
    ),
  );

  const unverifiedReplacementHarness = <A, E, R>(
    name: string,
    adapters: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]>,
    body: (helpers: {
      readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
      readonly worker: EffectWorker.OrchestrationEffectWorkerV2["Service"];
      readonly dispatchRequest: (
        ordinal: number,
        selection: ModelSelection,
      ) => ReturnType<Orchestrator.OrchestratorV2["Service"]["dispatch"]>;
      readonly awaitSettled: (
        ordinal: number,
      ) => Effect.Effect<
        number,
        Orchestrator.OrchestratorV2Error | EffectWorker.OrchestrationEffectWorkerError
      >;
    }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(name);
        return yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("unverified-replacement:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "Unverified replacement",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          return yield* body({
            orchestrator,
            worker,
            dispatchRequest: (ordinal, selection) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`unverified-replacement:${ordinal}`),
                threadId,
                messageId: MessageId.make(`unverified-replacement:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text: `Request ${ordinal}`,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "start_immediately" },
              }),
            awaitSettled: (ordinal) =>
              orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" ||
                      event.payload.status === "failed" ||
                      event.payload.status === "interrupted"),
                ),
                Stream.runHead,
                Effect.andThen(worker.drain()),
              ),
          });
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name,
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              ProviderAdapterRegistry.layerFromAdapters(adapters),
            ),
          ),
        );
      }),
    );
  // Replacement bookkeeping is a full-thread summary handoff plus a resume-fallback transfer.
  const replacementRecordsFor = (projection: OrchestrationV2ThreadProjection, runId: string) => [
    ...projection.contextHandoffs.filter(
      (handoff) => handoff.targetRunId === runId && handoff.strategy === "full_thread_summary",
    ),
    ...projection.contextTransfers.filter(
      (transfer) =>
        transfer.targetRunId === runId && transfer.id.includes("provider_resume_fallback"),
    ),
  ];

  it.live("fails honestly when the provider reuses its session for a context handoff", () =>
    Effect.gen(function* () {
      const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      yield* unverifiedReplacementHarness(
        "unverified-replacement-reused",
        [
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: { 2: `Source work ${"s".repeat(12_000)}` },
            capturedTurns,
          }),
          // Without a generation every ensureThread returns the same native id, like Muse.
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            getModelContextWindow: () => 32_000,
          }),
        ],
        ({ orchestrator, dispatchRequest, awaitSettled }) =>
          Effect.gen(function* () {
            yield* dispatchRequest(1, CLAUDE_MODEL_SELECTION);
            yield* awaitSettled(1);
            const target = (yield* orchestrator.getThreadProjection(threadId)).providerThreads[0]!;
            // The native session has no room left for the returning handoff.
            yield* (yield* EventSink.EventSinkV2).write({
              events: [
                {
                  id: EventId.make("unverified-replacement-usage"),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: { ...target, contextUsage: { usedTokens: 31_000, maxTokens: 32_000 } },
                },
              ],
            });
            yield* dispatchRequest(2, CODEX_MODEL_SELECTION);
            yield* awaitSettled(2);
            yield* dispatchRequest(3, CLAUDE_MODEL_SELECTION);
            yield* awaitSettled(3);

            const projection = yield* orchestrator.getThreadProjection(threadId);
            const run3 = projection.runs.at(-1)!;
            assert.equal(run3.status, "failed");
            assert.deepEqual(replacementRecordsFor(projection, run3.id), []);
            const failure = projection.turnItems.findLast((item) => item.type === "error");
            assert.equal(
              failure?.type === "error" ? failure.failure.message : null,
              "claudeAgent provider protocol error: the provider returned its existing session when asked for a fresh one, so the conversation context could not be moved to a new session.",
            );
            assert.deepEqual(
              (yield* Ref.get(capturedTurns)).map((turn) => turn.driver),
              [CLAUDE_DRIVER, CODEX_DRIVER],
            );
          }),
      );
    }),
  );

  it.live.each([
    {
      name: "an ACP rollback that starts a fresh agent session",
      instanceId: GROK_MODEL_SELECTION.instanceId,
      driver: GROK_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      modelSelection: GROK_MODEL_SELECTION,
      rollback: "replaces_native_thread",
      failResumeAfterRollback: false,
      history: "plain",
      delivers: ["favourite colour is teal"],
      withholds: ["favourite animal is an otter"],
    },
    {
      name: "a native rollback whose next resume fails",
      instanceId: CLAUDE_MODEL_SELECTION.instanceId,
      driver: CLAUDE_DRIVER,
      capabilities: ClaudeProviderCapabilitiesV2,
      modelSelection: CLAUDE_MODEL_SELECTION,
      rollback: "truncates",
      failResumeAfterRollback: true,
      history: "plain",
      delivers: ["favourite colour is teal"],
      withholds: ["favourite animal is an otter"],
    },
    {
      // Pi forks into a new native thread that still holds the kept turns.
      name: "a native rollback that forks a new native thread",
      instanceId: CLAUDE_MODEL_SELECTION.instanceId,
      driver: CLAUDE_DRIVER,
      capabilities: ClaudeProviderCapabilitiesV2,
      modelSelection: CLAUDE_MODEL_SELECTION,
      rollback: "replaces_native_thread",
      failResumeAfterRollback: false,
      history: "plain",
      delivers: [],
      withholds: ["favourite colour is teal", "favourite animal is an otter"],
    },
    {
      name: "an ACP rollback where no attempt recorded its native session",
      instanceId: GROK_MODEL_SELECTION.instanceId,
      driver: GROK_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      modelSelection: GROK_MODEL_SELECTION,
      rollback: "replaces_native_thread",
      failResumeAfterRollback: false,
      history: "legacy_all_turns",
      delivers: ["favourite colour is teal"],
      withholds: ["favourite animal is an otter"],
    },
    {
      name: "an ACP rollback of a forked thread to its baseline",
      instanceId: GROK_MODEL_SELECTION.instanceId,
      driver: GROK_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      modelSelection: GROK_MODEL_SELECTION,
      rollback: "replaces_native_thread",
      failResumeAfterRollback: false,
      history: "forked_to_baseline",
      delivers: ["home town is Oslo"],
      withholds: ["favourite colour is teal", "favourite animal is an otter"],
    },
    {
      name: "an ACP rollback in a thread restarted with fresh context",
      instanceId: GROK_MODEL_SELECTION.instanceId,
      driver: GROK_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      modelSelection: GROK_MODEL_SELECTION,
      rollback: "replaces_native_thread",
      failResumeAfterRollback: false,
      history: "after_fresh_context",
      delivers: ["favourite colour is teal"],
      withholds: ["home town is Oslo", "favourite animal is an otter"],
    },
  ] as const)(
    "gives the agent the kept conversation and not the rewound turn after $name",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const name = `rollback-kept-context-${scenario.driver}-${scenario.history}`;
          const cwd = yield* checkpointWorkspace(name);
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
          const failResumeOnce = yield* Ref.make(false);
          const nativeThreadGeneration = yield* Ref.make(0);
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            makeTestAdapter({
              instanceId: scenario.instanceId,
              driver: scenario.driver,
              capabilities: scenario.capabilities,
              modelSelection: scenario.modelSelection,
              responseByRunOrdinal: { 1: "noted", 2: "noted", 3: "noted" },
              capturedTurns,
              injectedHistory,
              failResumeOnce,
              nativeThreadGeneration,
              rollback: scenario.rollback,
            }),
          ]);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const runToCompletion = Effect.fn("runToCompletion")(function* (
              ordinal: number,
              text: string,
              thread: ThreadId = threadId,
              freshContext = false,
            ) {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`${thread}:${ordinal}`),
                threadId: thread,
                messageId: MessageId.make(`${thread}:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text,
                attachments: [],
                modelSelection: scenario.modelSelection,
                ...(freshContext ? { freshContext: true } : {}),
                dispatchMode: { type: "start_immediately" },
              });
              yield* orchestrator.streamStoredEvents.pipe(
                Stream.filter(
                  ({ event }) =>
                    event.type === "run.updated" &&
                    event.threadId === thread &&
                    event.payload.ordinal === ordinal &&
                    (event.payload.status === "completed" || event.payload.status === "failed"),
                ),
                Stream.runHead,
              );
              yield* worker.drain();
            });
            const createThread = (thread: ThreadId) =>
              orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`${thread}:create`),
                threadId: thread,
                projectId,
                createdBy: "user",
                creationSource: "web",
                title: "Edit from here",
                modelSelection: scenario.modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
              });
            if (scenario.history === "forked_to_baseline") {
              const sourceThreadId = ThreadId.make(`${name}:source`);
              yield* createThread(sourceThreadId);
              yield* runToCompletion(
                1,
                "My home town is Oslo. Reply with only the word: noted",
                sourceThreadId,
              );
              yield* orchestrator.dispatch({
                type: "thread.fork",
                commandId: CommandId.make(`${name}:fork`),
                sourceThreadId,
                targetThreadId: threadId,
                sourcePoint: {
                  type: "run",
                  runId: (yield* orchestrator.getThreadProjection(sourceThreadId)).runs[0]!.id,
                },
                createdBy: "user",
                creationSource: "web",
              });
            } else {
              yield* createThread(threadId);
            }
            // Runs before a fresh-context run never reach a provider again.
            const first = scenario.history === "after_fresh_context" ? 2 : 1;
            if (first === 2) {
              yield* runToCompletion(1, "My home town is Oslo. Reply with only the word: noted");
            }
            yield* runToCompletion(
              first,
              "My favourite colour is teal. Reply with only the word: noted",
              threadId,
              first === 2,
            );
            yield* runToCompletion(
              first + 1,
              "My favourite animal is an otter. Reply with only the word: noted",
            );
            const beforeRollback = yield* orchestrator.getThreadProjection(threadId);
            if (scenario.history === "legacy_all_turns") {
              yield* (yield* EventSink.EventSinkV2).write({
                events: beforeRollback.attempts.map(
                  ({ nativeThreadId: _nativeThreadId, ...legacy }, index) => ({
                    id: EventId.make(`${name}:legacy-attempt:${index}`),
                    type: "run-attempt.updated" as const,
                    threadId,
                    occurredAt: beforeRollback.thread.createdAt,
                    payload: legacy,
                  }),
                ),
              });
            }
            const keptOrdinal = scenario.history === "forked_to_baseline" ? 0 : first;
            const keptCheckpoint = beforeRollback.checkpoints.find(
              (checkpoint) =>
                (checkpoint.appRunOrdinal ?? 0) === keptOrdinal && checkpoint.status === "ready",
            );
            if (keptCheckpoint === undefined) {
              return yield* Effect.die("Expected a checkpoint after the first turn.");
            }
            yield* orchestrator.dispatch({
              type: "checkpoint.rollback",
              commandId: CommandId.make(`${name}:rollback`),
              threadId,
              scopeId: keptCheckpoint.scopeId,
              checkpointId: keptCheckpoint.id,
              restoreFiles: false,
            });
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  (event.type === "run.updated" &&
                    event.payload.ordinal === first + 1 &&
                    event.payload.status === "rolled_back") ||
                  (event.type === "thread.metadata-updated" &&
                    event.payload.rollbackFailure != null),
              ),
              Stream.runHead,
            );
            yield* worker.drain();
            assert.deepEqual(
              (yield* orchestrator.getThreadProjection(threadId)).runs.map((run) => run.status),
              scenario.history === "forked_to_baseline"
                ? ["rolled_back", "rolled_back"]
                : [...(first === 2 ? ["completed"] : []), "completed", "rolled_back"],
            );
            if (scenario.failResumeAfterRollback) {
              const providerSessionId = (yield* orchestrator.getThreadProjection(threadId))
                .providerThreads[0]?.providerSessionId;
              if (providerSessionId == null) {
                return yield* Effect.die("Expected a provider session after the rollback.");
              }
              yield* orchestrator.dispatch({
                type: "provider-session.detach",
                commandId: CommandId.make(`${name}:detach`),
                threadId,
                providerSessionId,
              });
              yield* worker.drain();
              yield* Ref.set(failResumeOnce, true);
            }
            const historyBeforeRun3 = (yield* Ref.get(injectedHistory)).length;
            yield* runToCompletion(first + 2, "What did I say first?");

            const run3 = (yield* Ref.get(capturedTurns)).at(-1);
            const delivered =
              (run3?.text ?? "") +
              (yield* encodeJson((yield* Ref.get(injectedHistory)).slice(historyBeforeRun3)));
            for (const kept of scenario.delivers) {
              assert.include(delivered, kept, "the agent's session lacks this kept turn");
            }
            for (const withheld of scenario.withholds) {
              assert.notInclude(delivered, withheld, "the session holds it or it was rewound");
            }
            if (scenario.name === "an ACP rollback that starts a fresh agent session") {
              const recoveries = (projection: OrchestrationV2ThreadProjection) =>
                projection.contextHandoffs.filter(
                  (handoff) => handoff.strategy === "full_thread_summary",
                ).length;
              const recoveriesBeforeRun4 = recoveries(
                yield* orchestrator.getThreadProjection(threadId),
              );
              const sessionsBeforeRun4 = yield* Ref.get(nativeThreadGeneration);
              yield* runToCompletion(4, "And what did I say second?");
              assert.strictEqual(
                recoveries(yield* orchestrator.getThreadProjection(threadId)),
                recoveriesBeforeRun4,
                "the recovered session holds the kept turns, so the next turn replays nothing",
              );
              assert.strictEqual(yield* Ref.get(nativeThreadGeneration), sessionsBeforeRun4);
            }
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                {
                  name,
                  runtimePolicyOverride: {
                    cwd,
                    approvalPolicy: "never",
                    sandboxPolicy: { type: "readOnly" },
                  },
                },
                layerRegistry,
              ),
            ),
          );
        }),
      ),
  );

  it.live.each([
    "immediately",
    "behind a running turn",
    "and recovers it after it breaks",
    "and recovers it after it breaks and the server restarts",
  ] as const)(
    "starts a fresh provider session %s and never hands earlier runs to a later provider",
    (variant) =>
      Effect.gen(function* () {
        const queued = variant === "behind a running turn";
        const restarted = variant === "and recovers it after it breaks and the server restarts";
        const broken = restarted || variant === "and recovers it after it breaks";
        const key = queued ? "queued" : restarted ? "restarted" : broken ? "broken" : "immediate";
        const cwd = yield* checkpointWorkspace(`fresh-context-${key}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const closedSessions = yield* Ref.make<ReadonlyArray<string>>([]);
        const runtimeStarts = yield* Ref.make<ReadonlyArray<string>>([]);
        // A queued start has nobody to refuse, so a busy session must stay up.
        const backgroundWork = yield* Ref.make(queued);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeTestAdapter({
            instanceId: CLAUDE_MODEL_SELECTION.instanceId,
            driver: CLAUDE_DRIVER,
            capabilities: ClaudeProviderCapabilitiesV2,
            modelSelection: CLAUDE_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            closedSessions,
            runtimeStarts,
            backgroundWork,
            nativeThreadGeneration: yield* Ref.make(0),
            ...(queued
              ? { holdFirstTurn: started, releaseFirstTurn: release, holdRunOrdinal: 2 }
              : {}),
            ...(broken
              ? {
                  failedRunOrdinals: new Set([3]),
                  brokenRunOrdinals: new Set([3]),
                }
              : {}),
          }),
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
          }),
        ]);
        const freshThreadId = ThreadId.make(`thread:fresh-context:${key}`);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const send = (
            name: string,
            modelSelection: ModelSelection,
            options: { readonly freshContext?: boolean } = {},
          ) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:fresh-context:${key}:${name}`),
              threadId: freshThreadId,
              messageId: MessageId.make(`message:fresh-context:${key}:${name}`),
              text: `Prompt ${name}`,
              attachments: [],
              modelSelection,
              ...options,
              // A fresh send must never steer the running turn.
              deliveryIntent: "auto",
              dispatchMode: { type: "start_immediately" },
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:fresh-context:${key}:create`),
            threadId: freshThreadId,
            projectId: ProjectId.make(`project:fresh-context:${key}`),
            title: "Fresh context",
            modelSelection: CLAUDE_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          // Codex keeps a native thread from before the fresh run that must not resume.
          yield* send("zero", CODEX_MODEL_SELECTION);
          yield* worker.drain();
          yield* waitForIdle(freshThreadId);
          yield* send("alpha", CLAUDE_MODEL_SELECTION);
          if (queued) {
            yield* Deferred.await(started);
            yield* worker.drain();
          } else {
            yield* worker.drain();
            yield* waitForIdle(freshThreadId);
          }
          const firstSession = (yield* orchestrator.getThreadProjection(
            freshThreadId,
          )).providerSessions.find(
            (session) => session.providerInstanceId === CLAUDE_MODEL_SELECTION.instanceId,
          )!;
          yield* send("beta", CLAUDE_MODEL_SELECTION, { freshContext: true });
          if (queued) {
            // Queued before the fresh run started, so it is bound to the old conversation.
            yield* send("gamma", CLAUDE_MODEL_SELECTION);
            const waiting = yield* orchestrator.getThreadProjection(freshThreadId);
            assert.deepEqual(
              waiting.runs.map((run) => run.status),
              ["completed", "running", "queued", "queued"],
            );
            // Steering would send it into the conversation it is meant to leave.
            const promoted = yield* orchestrator
              .dispatch({
                type: "queued-message.promote-to-steer",
                commandId: CommandId.make(`command:fresh-context:${key}:promote`),
                threadId: freshThreadId,
                queuedRunId: waiting.runs.find((run) => run.freshContext === true)!.id,
                targetRunId: waiting.runs.find((run) => run.status === "running")!.id,
              })
              .pipe(Effect.flip);
            assert.instanceOf(promoted, Orchestrator.OrchestratorDispatchError);
            assert.include(String(promoted.cause), "fresh session");
            yield* Deferred.succeed(release, undefined);
          }
          yield* worker.drain();
          yield* waitForIdle(freshThreadId);
          // Claude hosts one native thread per session, so an idle old one is closed.
          assert.deepEqual(yield* Ref.get(closedSessions), queued ? [] : [firstSession.id]);
          yield* Ref.set(backgroundWork, false);
          let startsBeforeRecovery = 0;
          if (broken) {
            if (restarted) {
              const brokenProjection = yield* orchestrator.getThreadProjection(freshThreadId);
              const brokenThread = brokenProjection.providerThreads.find(
                (thread) => thread.id === brokenProjection.thread.activeProviderThreadId,
              )!;
              assert.equal(brokenThread.status, "error");
              const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
              yield* sessions.close(brokenThread.providerSessionId!);
            }
            startsBeforeRecovery = (yield* Ref.get(runtimeStarts)).length;
            yield* send("epsilon", CLAUDE_MODEL_SELECTION);
            yield* worker.drain();
            yield* waitForIdle(freshThreadId);
          }
          yield* send("delta", CODEX_MODEL_SELECTION);
          yield* worker.drain();
          yield* waitForIdle(freshThreadId);
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(freshThreadId);
          const turns = yield* Ref.get(capturedTurns);
          const turnFor = (name: string) =>
            turns.find((turn) => turn.text.endsWith(`Prompt ${name}`))!;

          const freshRun = projection.runs.find(
            (run) => run.userMessageId === `message:fresh-context:${key}:beta`,
          )!;
          assert.isTrue(freshRun.freshContext);
          assert.equal(freshRun.contextHandoffId, null);
          assert.isTrue(
            projection.turnItems.some(
              (item) =>
                item.type === "user_message" &&
                item.messageId === freshRun.userMessageId &&
                item.freshContext === true,
            ),
          );
          assert.notEqual(turnFor("beta").providerThreadId, turnFor("alpha").providerThreadId);
          assert.notEqual(turnFor("beta").nativeThreadId, turnFor("alpha").nativeThreadId);
          assert.equal(turnFor("beta").text, "Prompt beta");
          if (queued) {
            assert.equal(turnFor("gamma").providerThreadId, turnFor("beta").providerThreadId);
          }
          if (broken) {
            const recovered = turnFor("epsilon");
            assert.equal(recovered.providerThreadId, turnFor("beta").providerThreadId);
            assert.notEqual(recovered.nativeThreadId, turnFor("beta").nativeThreadId);
            assert.include(recovered.text, "Prompt beta");
            assert.notInclude(recovered.text, "Prompt alpha");
            assert.notInclude(recovered.text, "Prompt zero");
            // The broken native id is never reopened; a reopened session starts fresh only once.
            assert.deepEqual(
              (yield* Ref.get(runtimeStarts)).slice(startsBeforeRecovery),
              restarted ? ["new"] : ["replacement"],
            );
            const recoveredRun = projection.runs.find(
              (run) => run.userMessageId === `message:fresh-context:${key}:epsilon`,
            )!;
            assert.equal(
              projection.contextHandoffs.find((handoff) => handoff.targetRunId === recoveredRun.id)!
                .coveredRunOrdinals.from,
              3,
            );
          }
          const codexTurn = turnFor("delta");
          assert.notEqual(codexTurn.providerThreadId, turnFor("zero").providerThreadId);
          assert.include(codexTurn.text, "Prompt beta");
          assert.notInclude(codexTurn.text, "Prompt alpha");
          assert.notInclude(codexTurn.text, "Prompt zero");
          assert.equal(projection.contextHandoffs.at(-1)!.coveredRunOrdinals.from, 3);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: `fresh-context-${key}`,
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              layerRegistry,
            ),
          ),
        );
      }),
  );

  it.live("keeps the user's conversation after a scheduled fresh run in the same thread", () =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("scheduled-fresh-user-chat");
      const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
        makeTestAdapter({
          instanceId: CLAUDE_MODEL_SELECTION.instanceId,
          driver: CLAUDE_DRIVER,
          capabilities: ClaudeProviderCapabilitiesV2,
          modelSelection: CLAUDE_MODEL_SELECTION,
          responseByRunOrdinal: {},
          capturedTurns,
          nativeThreadGeneration: yield* Ref.make(0),
          failedRunOrdinals: new Set([5]),
          brokenRunOrdinals: new Set([5]),
        }),
      ]);
      const threadId = ThreadId.make("thread:scheduled-fresh-user-chat");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const send = (name: string, scheduled: boolean) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:scheduled-fresh-user-chat:${name}`),
            threadId,
            messageId: MessageId.make(`message:scheduled-fresh-user-chat:${name}`),
            text: name,
            attachments: [],
            modelSelection: CLAUDE_MODEL_SELECTION,
            dispatchMode: { type: "queue_after_active" },
            ...(scheduled
              ? {
                  scheduledTaskId: ScheduledTaskId.make("scheduled-fresh-user-chat"),
                  freshContext: true,
                }
              : {}),
          });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:scheduled-fresh-user-chat:create"),
          threadId,
          projectId: ProjectId.make("project:scheduled-fresh-user-chat"),
          title: "User chat with a fresh-session schedule",
          modelSelection: CLAUDE_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        const eventSink = yield* EventSink.EventSinkV2;
        for (const [name, scheduled] of [
          ["user-first", false],
          ["scheduled", true],
          ["user-second", false],
          ["compaction", false],
          ["scheduled-after-compaction", true],
          ["user-third", false],
          ["user-fourth", false],
        ] as const) {
          if (name === "compaction") {
            // The user's run compacts, so later dispatches no longer read the first scheduled run's message.
            const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
            const compactedAt = yield* DateTime.now;
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("event:scheduled-fresh-user-chat:compaction"),
                  type: "turn-item.updated",
                  threadId,
                  runId: run.id,
                  nodeId: run.rootNodeId!,
                  occurredAt: compactedAt,
                  payload: {
                    id: TurnItemId.make("item:scheduled-fresh-user-chat:compaction"),
                    threadId,
                    runId: run.id,
                    nodeId: run.rootNodeId,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1_000,
                    status: "completed",
                    title: null,
                    startedAt: compactedAt,
                    completedAt: compactedAt,
                    updatedAt: compactedAt,
                    type: "compaction",
                    driver: CLAUDE_DRIVER,
                  },
                },
              ],
            });
            continue;
          }
          yield* send(name, scheduled);
          yield* worker.drain();
          yield* waitForIdle(threadId);
        }
        const turns = yield* Ref.get(capturedTurns);
        const turnFor = (name: string) => turns.find((turn) => turn.text.endsWith(name));
        assert.notEqual(
          turnFor("scheduled")!.nativeThreadId,
          turnFor("user-first")!.nativeThreadId,
        );
        // The scheduled run's fresh session must not replace the user's conversation.
        assert.equal(turnFor("user-second")!.nativeThreadId, turnFor("user-first")!.nativeThreadId);
        assert.equal(turnFor("user-third")!.nativeThreadId, turnFor("user-first")!.nativeThreadId);
        // The user's session broke; recovery reads the whole thread, so scheduled runs do not cut it.
        const recovered = turnFor("user-fourth")!;
        assert.equal(recovered.providerThreadId, turnFor("user-first")!.providerThreadId);
        assert.notEqual(recovered.nativeThreadId, turnFor("user-first")!.nativeThreadId);
        assert.include(recovered.text, "user-first");
        assert.include(recovered.text, "user-third");
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const recoveredRun = projection.runs.find(
          (run) => run.userMessageId === "message:scheduled-fresh-user-chat:user-fourth",
        )!;
        assert.equal(
          projection.contextHandoffs.find((handoff) => handoff.targetRunId === recoveredRun.id)!
            .coveredRunOrdinals.from,
          1,
        );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name: "scheduled-fresh-user-chat",
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: {
                  type: "readOnly",
                  access: { type: "fullAccess" },
                  networkAccess: false,
                },
              },
            },
            layerRegistry,
          ),
        ),
      );
    }),
  );

  // regression: #21314 a queued PR update must follow the provider that took over the thread
  it.live.each([
    ["automatic", "Claude"],
    ["queue.resume", "compatible Codex"],
    ["queue.resume", "broken compatible Codex"],
  ] as const)(
    "delivers a queued PR update on the current provider through %s (%s)",
    ([delivery, target]) =>
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`pr-wake-${delivery}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const compatible = target !== "Claude";
        const broken = target === "broken compatible Codex";
        const generation = yield* Ref.make(0);
        const selection = {
          ...(compatible
            ? { ...CODEX_MODEL_SELECTION, instanceId: ProviderInstanceId.make("codex-alternate") }
            : CLAUDE_MODEL_SELECTION),
          options: [{ id: "reasoningEffort", value: "low" }],
        };
        const targetCapabilities = compatible
          ? {
              ...CodexProviderCapabilitiesV2,
              context: {
                ...CodexProviderCapabilitiesV2.context,
                canConsumeHandoffSummaries: broken,
              },
            }
          : ClaudeProviderCapabilitiesV2;
        const adapters = [
          makeTestAdapter({
            instanceId: CODEX_MODEL_SELECTION.instanceId,
            driver: CODEX_DRIVER,
            capabilities: CodexProviderCapabilitiesV2,
            modelSelection: CODEX_MODEL_SELECTION,
            responseByRunOrdinal: {},
            capturedTurns,
            holdFirstTurn: started,
            releaseFirstTurn: release,
            failedRunOrdinals: new Set([1]),
            ...(broken
              ? { brokenRunOrdinals: new Set([1]), nativeThreadGeneration: generation }
              : {}),
            failure: makeProviderFailure({
              message: "Usage limit reached",
              class: "usage_limit",
              code: "usage_limit",
            }),
          }),
          makeTestAdapter({
            instanceId: selection.instanceId,
            driver: compatible ? CODEX_DRIVER : CLAUDE_DRIVER,
            capabilities: targetCapabilities,
            modelSelection: selection,
            responseByRunOrdinal: {},
            capturedTurns,
            ...(broken
              ? { brokenRunOrdinals: new Set<number>(), nativeThreadGeneration: generation }
              : {}),
          }),
        ];
        const layerRegistry = compatible
          ? Layer.succeed(
              ProviderAdapterRegistry.ProviderAdapterRegistryV2,
              ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
                get: (instanceId) => {
                  const adapter = adapters.find((candidate) => candidate.instanceId === instanceId);
                  return adapter === undefined
                    ? Effect.fail(
                        new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({
                          instanceId,
                        }),
                      )
                    : Effect.succeed(adapter);
                },
                list: () => Effect.succeed(adapters.map((adapter) => adapter.instanceId)),
                getMetadata: (instanceId) =>
                  Effect.succeed({
                    driver: CODEX_DRIVER,
                    continuationKey: "codex:shared-native-account-history",
                    enabled: true,
                    capabilities:
                      instanceId === selection.instanceId
                        ? targetCapabilities
                        : CodexProviderCapabilitiesV2,
                  }),
              }),
            )
          : ProviderAdapterRegistry.layerFromAdapters(adapters);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const dispatch = (text: string, modelSelection: ModelSelection) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(text),
              messageId: MessageId.make(text),
              threadId,
              text,
              modelSelection,
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "start_immediately" },
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "PR wake",
            modelSelection: CODEX_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* dispatch("Original work", CODEX_MODEL_SELECTION);
          yield* Deferred.await(started);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("wake"),
            messageId: MessageId.make("wake"),
            threadId,
            text: "Review the new PR comments",
            attachments: [],
            createdBy: "agent",
            creationSource: "server",
            dispatchMode: { type: "queue_after_active" },
            notification: {
              source: { kind: "monitor" },
              outcome: "updated",
              summary: "New PR comments",
            },
          });
          const [active, wake] = (yield* orchestrator.getThreadProjection(threadId)).runs;
          assert.isDefined(active);
          assert.isDefined(wake);
          assert.equal(wake.status, "queued");
          yield* Deferred.succeed(release, undefined);
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.runId === active.id &&
                event.payload.status === "failed",
            ),
            Stream.runHead,
          );
          yield* worker.drain();

          if (delivery === "automatic") {
            yield* dispatch("Take over the work", selection);
          } else {
            yield* orchestrator.dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make("select"),
              threadId,
              modelSelection: selection,
            });
            yield* orchestrator.dispatch({
              type: "queue.resume",
              commandId: CommandId.make("resume"),
              threadId,
            });
          }
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.runId === wake.id &&
                (event.payload.status === "completed" || event.payload.status === "failed"),
            ),
            Stream.runHead,
          );
          yield* worker.drain();
          const after = yield* orchestrator.getThreadProjection(threadId);
          const turns = yield* Ref.get(capturedTurns);
          assert.lengthOf(turns, delivery === "automatic" ? 3 : 2);
          const executed = turns.at(-1)!;
          assert.equal(executed.driver, compatible ? CODEX_DRIVER : CLAUDE_DRIVER);
          assert.include(executed.text, "Review the new PR comments");
          assert.deepEqual(executed.modelSelection, selection);
          assert.deepEqual(after.thread.modelSelection, selection);
          const delivered = after.runs.find((run) => run.id === wake.id)!;
          assert.equal(delivered.status, "completed");
          assert.deepEqual(delivered.modelSelection, selection);
          assert.equal(delivered.providerInstanceId, selection.instanceId);
          assert.equal(delivered.providerThreadId, executed.providerThreadId);
          assert.equal(after.thread.activeProviderThreadId, delivered.providerThreadId);
          if (delivery === "automatic") {
            assert.equal(executed.providerThreadId, turns[1]!.providerThreadId);
            assert.equal(executed.nativeThreadId, turns[1]!.nativeThreadId);
          }
          if (broken) {
            assert.notEqual(executed.nativeThreadId, turns[0]!.nativeThreadId);
            assert.isFalse(executed.nativeThreadHasTurns);
            assert.include(executed.text, "Original work");
          }
          if (compatible && !broken) {
            assert.equal(executed.nativeThreadId, turns[0]!.nativeThreadId);
            assert.isEmpty(after.contextHandoffs);
          }
          assert.equal(
            after.providerThreads.find((entry) => entry.id === delivered.providerThreadId)
              ?.providerInstanceId,
            selection.instanceId,
          );
          assert.equal(
            after.turnItems.find(
              (entry) => entry.type === "notification" && entry.runId === wake.id,
            )?.providerThreadId,
            delivered.providerThreadId,
          );
          const attempt = after.attempts.find((entry) => entry.id === delivered.activeAttemptId);
          const root = after.nodes.find((entry) => entry.id === delivered.rootNodeId);
          assert.equal(attempt?.providerInstanceId, selection.instanceId);
          assert.equal(attempt?.providerThreadId, delivered.providerThreadId);
          assert.equal(root?.providerThreadId, delivered.providerThreadId);
          assert.equal(
            after.checkpointScopes.find((entry) => entry.id === root?.checkpointScopeId)
              ?.providerThreadId,
            delivered.providerThreadId,
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: `pr-wake-${delivery}`, runtimePolicyOverride: { cwd } },
              layerRegistry,
            ),
          ),
        );
      }),
  );

  it.live("fails an unsupported queued handoff and advances to the next queued provider", () =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("queued-handoff-rejection");
      const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const started = yield* Deferred.make<void>();
      const rejectedThreadId = ThreadId.make("thread:queued-handoff-rejection");
      const rejectedMessageId = MessageId.make("message:queued-handoff-rejection:claude");
      const unsupportedClaudeCapabilities = {
        ...ClaudeProviderCapabilitiesV2,
        context: {
          ...ClaudeProviderCapabilitiesV2.context,
          canConsumeHandoffSummaries: false,
        },
      };
      const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
        makeTestAdapter({
          instanceId: CODEX_MODEL_SELECTION.instanceId,
          driver: CODEX_DRIVER,
          capabilities: CodexProviderCapabilitiesV2,
          modelSelection: CODEX_MODEL_SELECTION,
          responseByRunOrdinal: { 3: "Later Codex queued turn complete" },
          capturedTurns,
          holdFirstTurn: started,
        }),
        makeTestAdapter({
          instanceId: CLAUDE_MODEL_SELECTION.instanceId,
          driver: CLAUDE_DRIVER,
          capabilities: unsupportedClaudeCapabilities,
          modelSelection: CLAUDE_MODEL_SELECTION,
          responseByRunOrdinal: {},
          capturedTurns,
        }),
      ]);
      const projection = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:queued-handoff-rejection:create"),
          threadId: rejectedThreadId,
          projectId: ProjectId.make("project:queued-handoff-rejection"),
          title: "Queued handoff rejection",
          modelSelection: CODEX_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:queued-handoff-rejection:first"),
          threadId: rejectedThreadId,
          messageId: MessageId.make("message:queued-handoff-rejection:first"),
          text: "First Codex turn",
          attachments: [],
          modelSelection: CODEX_MODEL_SELECTION,
          dispatchMode: { type: "start_immediately" },
        });
        yield* Deferred.await(started);
        const active = yield* orchestrator.getThreadProjection(rejectedThreadId);
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:queued-handoff-rejection:existing-item"),
              type: "turn-item.updated",
              threadId: rejectedThreadId,
              runId: active.runs[0]!.id,
              nodeId: active.runs[0]!.rootNodeId!,
              providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("turn-item:queued-handoff-rejection:existing-item"),
                threadId: rejectedThreadId,
                runId: active.runs[0]!.id,
                nodeId: active.runs[0]!.rootNodeId!,
                providerThreadId: active.runs[0]!.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 150,
                status: "completed",
                title: null,
                inputIntent: "turn_start",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                messageId: rejectedMessageId,
                text: "Unsupported Claude turn",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:queued-handoff-rejection:claude"),
          threadId: rejectedThreadId,
          messageId: rejectedMessageId,
          text: "Unsupported Claude turn",
          attachments: [],
          modelSelection: CLAUDE_MODEL_SELECTION,
          dispatchMode: { type: "queue_after_active" },
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:queued-handoff-rejection:later"),
          threadId: rejectedThreadId,
          messageId: MessageId.make("message:queued-handoff-rejection:later"),
          text: "Later Codex turn",
          attachments: [],
          modelSelection: CODEX_MODEL_SELECTION,
          dispatchMode: { type: "queue_after_active" },
        });
        const queued = yield* orchestrator.getThreadProjection(rejectedThreadId);
        assert.deepEqual(
          queued.runs.map((run) => run.status),
          ["running", "queued", "queued"],
        );
        const queuedItem = queued.turnItems.find(
          (item) => item.type === "user_message" && item.messageId === rejectedMessageId,
        );
        assert.equal(queuedItem?.runId, queued.runs[1]?.id);
        assert.equal(queuedItem?.providerThreadId, queued.runs[1]?.providerThreadId);
        assert.equal(queuedItem?.status, "pending");
        assert.isNull(queuedItem?.startedAt);
        assert.isNull(queuedItem?.completedAt);
        assert.isFalse(queued.visibleTurnItems.some((row) => row.item.id === queuedItem?.id));
        const queuedSequence = yield* eventSink.latestSequence({ threadId: rejectedThreadId });
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:queued-handoff-rejection:first-complete"),
              type: "run.updated",
              threadId: rejectedThreadId,
              runId: queued.runs[0]!.id,
              providerInstanceId: CODEX_MODEL_SELECTION.instanceId,
              occurredAt: now,
              payload: { ...queued.runs[0]!, status: "completed", completedAt: now },
            },
          ],
        });
        yield* orchestrator.resumeQueuedRuns;
        yield* orchestrator.streamStoredEvents.pipe(
          Stream.filter(
            (event) =>
              event.event.type === "run.updated" &&
              event.event.runId === queued.runs[2]?.id &&
              event.event.payload.status === "completed",
          ),
          Stream.runHead,
        );
        yield* worker.drain();
        // Clients whose bounded snapshot omitted the hidden queued item must
        // receive it while the run is still queued, before it fails.
        const throughSequence = yield* eventSink.latestSequence({ threadId: rejectedThreadId });
        const failureEvents = yield* eventSink
          .stream({ threadId: rejectedThreadId, afterSequence: queuedSequence })
          .pipe(
            Stream.takeUntil((stored) => stored.sequence === throughSequence),
            Stream.map(({ event }) => event),
            Stream.filter((event) => event.runId === queued.runs[1]!.id),
            Stream.runCollect,
          );
        const republished = failureEvents.findIndex(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === rejectedMessageId,
        );
        assert.isAtLeast(republished, 0);
        const restored = failureEvents[republished];
        assert.equal(restored?.type, "turn-item.updated");
        if (restored?.type === "turn-item.updated") {
          assert.deepEqual(restored.payload, {
            ...queuedItem,
            // Its run is now the second one, so it moves into that run's positions.
            ordinal: 2_000_001,
            status: "failed",
            completedAt: restored.occurredAt,
            updatedAt: restored.occurredAt,
          });
        }
        assert.isBelow(
          republished,
          failureEvents.findIndex(
            (event) => event.type === "run.updated" && event.payload.status === "failed",
          ),
        );
        return yield* orchestrator.getThreadProjection(rejectedThreadId);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name: "queued-handoff-rejection",
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: {
                  type: "readOnly",
                  access: { type: "fullAccess" },
                  networkAccess: false,
                },
              },
            },
            layerRegistry,
          ),
        ),
      );
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "failed", "completed"],
      );
      assert.equal(projection.runs[1]?.queuePosition, null);
      assert.equal(
        projection.attempts.find((attempt) => attempt.runId === projection.runs[1]?.id)?.status,
        "failed",
      );
      assert.equal(
        projection.nodes.find((node) => node.runId === projection.runs[1]?.id)?.status,
        "failed",
      );
      assert.equal(projection.thread.providerInstanceId, CODEX_MODEL_SELECTION.instanceId);
      assert.lengthOf(projection.contextHandoffs, 1);
      assert.include((yield* Ref.get(capturedTurns)).at(-1)!.text, "Unsupported Claude turn");
      const failureItem = projection.turnItems.find(
        (item) => item.type === "error" && item.runId === projection.runs[1]?.id,
      );
      assert.equal(
        failureItem?.type === "error" ? failureItem.failure.code : null,
        "context_handoff_unsupported",
      );
      assert.isBelow(
        projection.turnItems.find(
          (item) => item.type === "user_message" && item.messageId === rejectedMessageId,
        )!.ordinal,
        failureItem!.ordinal,
      );
      assert.isTrue(
        projection.visibleTurnItems.some(
          ({ item }) => item.type === "user_message" && item.messageId === rejectedMessageId,
        ),
      );
      assert.deepEqual(
        (yield* Ref.get(capturedTurns)).map((turn) => turn.driver),
        [CODEX_DRIVER, CODEX_DRIVER],
      );
    }),
  );
});
