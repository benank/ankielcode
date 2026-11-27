import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderSessionId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@ankielcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentAlertPush from "./AgentAlertPush.ts";
import * as PushRegistry from "./PushRegistry.ts";
import type { RelayPushMessage, RelayPushResultMessage } from "./relayProtocol.ts";
import type { RelayPushState } from "./RelayTunnelClient.ts";
import * as RelayTunnelService from "./RelayTunnelService.ts";

const environmentId = EnvironmentId.make("environment-1");
const at = (ms: number) => DateTime.makeUnsafe(ms);
const request = (id: string, kind: "command" | "user_input", createdAtMs = 2_000) => ({
  id: RuntimeRequestId.make(id),
  kind,
  createdAt: at(createdAtMs),
});

function thread(id: string, overrides: Partial<AgentAwarenessThread> = {}): AgentAwarenessThread {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    creationSource: "web",
    archivedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    activeRunId: null,
    latestRunId: RunId.make(`${id}:run-1`),
    hasActionableProposedPlan: false,
    title: "Fix the login flow",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    settledOverride: null,
    updatedAt: at(1_000),
    status: "running",
    activityRunStatus: "running",
    latestRunCompletedAt: null,
    latestRunStopRequested: false,
    latestRunBackgroundWake: false,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    ...overrides,
  };
}

const completed = (id: string, run: string, completedAtMs = 1_000) =>
  thread(id, {
    status: "completed",
    activityRunStatus: null,
    latestRunId: RunId.make(run),
    latestRunCompletedAt: at(completedAtMs),
  });

const child = (id: string, parent: string, overrides: Partial<AgentAwarenessThread> = {}) =>
  thread(id, {
    creationSource: "mcp",
    lineage: {
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
      rootThreadId: ThreadId.make(parent),
    },
    ...overrides,
  });

// The detector reads only an event's type, its thread and a few payload fields.
const event = (type: string, id: string, payload: Record<string, unknown> = {}) =>
  ({ type, threadId: ThreadId.make(id), payload }) as unknown as OrchestrationV2DomainEvent;
const runEnded = (id: string, status: "completed" | "failed" = "completed") =>
  event("run.updated", id, { status });
const requestOpened = (id: string) => event("runtime-request.updated", id, { status: "pending" });

type RuntimeRequest = OrchestrationV2RuntimeRequest;
const liveCapability = {
  type: "live",
  providerSessionId: ProviderSessionId.make("session-1"),
} as const;
const runtimeRequest = (
  id: string,
  kind: RuntimeRequest["kind"],
  overrides: Partial<RuntimeRequest> = {},
): RuntimeRequest => ({
  id: RuntimeRequestId.make(id),
  nodeId: NodeId.make("node-1"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status: "pending",
  responseCapability: liveCapability,
  createdAt: at(2_000),
  resolvedAt: null,
  ...overrides,
});
// The category reads only the card's type, request id, questions and options.
const approvalCard = (requestId: string, options?: ReadonlyArray<Record<string, unknown>>) =>
  ({
    type: "approval_request",
    requestId: RuntimeRequestId.make(requestId),
    requestKind: "command",
    ...(options === undefined ? {} : { options }),
  }) as unknown as OrchestrationV2TurnItem;
const question = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  header: "Question",
  question: "What should the release be called?",
  options: [],
  ...overrides,
});
const questionCard = (requestId: string, questions: ReadonlyArray<Record<string, unknown>>) =>
  ({
    type: "user_input_request",
    requestId: RuntimeRequestId.make(requestId),
    questions,
  }) as unknown as OrchestrationV2TurnItem;

const iosPhone = (token: string, kinds: PushRegistry.PushRegistration["kinds"]) => ({
  platform: "ios" as const,
  token,
  appId: "com.example.ankiel",
  apnsEnvironment: "sandbox" as const,
  kinds,
});
const androidPhone = (token: string, kinds: PushRegistry.PushRegistration["kinds"]) => ({
  platform: "android" as const,
  token,
  appId: "com.example.ankiel",
  apnsEnvironment: null,
  kinds,
});
const ALL_KINDS = ["completed", "failed", "approval", "input"] as const;

const okResult = (message: RelayPushMessage): RelayPushResultMessage => ({
  type: "push_result",
  pushId: message.pushId,
  results: message.deliveries.map((delivery) => ({
    token: delivery.token,
    platform: delivery.platform,
    ok: true,
    status: 200,
  })),
});

const makeHarness = Effect.gen(function* () {
  const threads = new Map<string, AgentAwarenessThread>();
  // Pending requests and their cards, by the thread that holds them.
  const records = new Map<
    string,
    { runtimeRequests: Array<RuntimeRequest>; turnItems: Array<OrchestrationV2TurnItem> }
  >();
  const recordReads = { fail: false };
  const registrations: Array<PushRegistry.PushRegistration> = [];
  const forgotten: Array<ReadonlyArray<string>> = [];
  const sent: Array<RelayPushMessage> = [];
  const relay: {
    push: RelayPushState | null;
    reply: (message: RelayPushMessage) => RelayPushResultMessage | null;
  } = { push: { availability: { apns: true, fcm: true }, readyAt: 0 }, reply: okResult };
  let reads = 0;
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  // The detector pulls its next event only after handling the last one.
  const pulls = yield* Queue.unbounded<void>();

  const context = yield* Layer.build(
    AgentAlertPush.layer.pipe(
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          streamDomainEvents: Stream.fromEffectRepeat(
            Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
          ),
          getAgentAwarenessSnapshot: (threadId) =>
            Effect.sync(() => {
              reads++;
              const found = threadId === undefined ? undefined : threads.get(threadId);
              return { snapshotSequence: 0, threads: found ? [found] : [] };
            }),
          getThreadRecords: (threadId, _fields, filter) =>
            recordReads.fail
              ? Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId }))
              : Effect.sync(() => {
                  const found = records.get(threadId);
                  const requestIds = new Set<string>(filter?.turnItemRequestIds ?? []);
                  return {
                    runtimeRequests: found?.runtimeRequests ?? [],
                    turnItems: (found?.turnItems ?? []).filter(
                      (item) => "requestId" in item && requestIds.has(item.requestId),
                    ),
                  } as never;
                }),
        }),
      ),
      Layer.provide(
        Layer.mock(PushRegistry.PushRegistry)({
          listActive: Effect.succeed(registrations),
          forgetTokens: (tokens) => Effect.sync(() => void forgotten.push(tokens)),
        }),
      ),
      Layer.provide(
        Layer.mock(RelayTunnelService.RelayTunnelService)({
          pushState: Effect.sync(() => relay.push),
          sendPush: (message) =>
            Effect.sync(() => {
              sent.push(message);
              return relay.reply(message);
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
    ),
  );
  const service = Context.get(context, AgentAlertPush.AgentAlertPush);
  yield* Queue.take(pulls);

  const set = (...states: ReadonlyArray<AgentAwarenessThread>) => {
    for (const state of states) threads.set(state.id, state);
  };
  const emit = (next: OrchestrationV2DomainEvent) =>
    Queue.offer(events, next).pipe(
      Effect.andThen(Queue.take(pulls)),
      Effect.andThen(service.drain),
    );
  // Completions wait out their confirmation window before they push.
  const confirm = TestClock.adjust("5 seconds").pipe(Effect.andThen(service.drain));
  const pushedThread = (message: RelayPushMessage | undefined) => {
    const delivery = message?.deliveries[0];
    return delivery?.platform === "apns" ? delivery.payload.body : delivery?.data;
  };
  const kindsSent = () =>
    sent.flatMap((message) =>
      message.deliveries.map((delivery) =>
        delivery.platform === "apns"
          ? (delivery.payload.body as { readonly kind: string }).kind
          : delivery.data.kind,
      ),
    );
  return {
    set,
    emit,
    confirm,
    relay,
    registrations,
    forgotten,
    sent,
    kindsSent,
    pushedThread,
    reads: () => reads,
    records,
    recordReads,
  };
});

describe("alertCategory", () => {
  it("offers buttons only when they answer the request the way its card would", () => {
    const decline = { decision: "decline", label: "Deny" };
    const accept = { decision: "accept", label: "Allow once" };
    const notResumable = { type: "not_resumable", reason: "Provider exited." } as const;
    const cases: ReadonlyArray<
      readonly [
        string,
        RuntimeRequest,
        OrchestrationV2TurnItem | undefined,
        AgentAlertPush.AlertCategory | null,
      ]
    > = [
      ["default options", runtimeRequest("r", "command"), approvalCard("r"), "ANKIEL_APPROVAL"],
      [
        "provider options with accept and decline",
        runtimeRequest("r", "file-change"),
        approvalCard("r", [accept, { decision: "acceptForSession", label: "Allow" }, decline]),
        "ANKIEL_APPROVAL",
      ],
      [
        "no decline to send",
        runtimeRequest("r", "command"),
        approvalCard("r", [accept, { decision: "cancel", label: "Cancel" }]),
        null,
      ],
      [
        "a warning the card shows",
        runtimeRequest("r", "command"),
        approvalCard("r", [accept, { ...decline, warning: "Runs outside the sandbox." }]),
        null,
      ],
      ["app access", runtimeRequest("r", "mcp-elicitation"), approvalCard("r"), null],
      [
        "approval the provider can no longer take",
        runtimeRequest("r", "command", { responseCapability: notResumable }),
        approvalCard("r"),
        null,
      ],
      ["approval without its card", runtimeRequest("r", "command"), undefined, null],
      [
        "answered already",
        runtimeRequest("r", "command", { status: "resolved" }),
        approvalCard("r"),
        null,
      ],
      [
        "one free-text question",
        runtimeRequest("r", "user_input"),
        questionCard("r", [question("name")]),
        "ANKIEL_INPUT_REPLY",
      ],
      [
        "a question answered by message",
        runtimeRequest("r", "user_input", { responseCapability: { type: "message" } }),
        questionCard("r", [question("name")]),
        "ANKIEL_INPUT_REPLY",
      ],
      [
        "a question with choices",
        runtimeRequest("r", "user_input"),
        questionCard("r", [
          question("name", { options: [{ label: "Alpha", description: "First" }] }),
        ]),
        null,
      ],
      [
        "several questions",
        runtimeRequest("r", "user_input"),
        questionCard("r", [question("name"), question("date")]),
        null,
      ],
      [
        "a question without free text",
        runtimeRequest("r", "user_input"),
        questionCard("r", [question("name", { allowCustomAnswer: false })]),
        null,
      ],
      [
        "a question the provider can no longer take",
        runtimeRequest("r", "user_input", { responseCapability: notResumable }),
        questionCard("r", [question("name")]),
        null,
      ],
    ];
    for (const [name, pending, card, expected] of cases) {
      expect([name, AgentAlertPush.alertCategory(pending, card)]).toEqual([name, expected]);
    }
  });
});

describe("AgentAlertPush", () => {
  it.effect("pushes each transition once, to the phones that asked for that kind", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.registrations.push(
        iosPhone("a".repeat(64), [...ALL_KINDS]),
        androidPhone("fcm-token", ["approval", "input"]),
      );

      harness.set(completed("thread-1", "run-1"));
      yield* harness.emit(runEnded("thread-1"));
      // A queued follow-up starts inside the window, so "finished" waits for the last run.
      harness.set(thread("thread-1", { latestRunId: RunId.make("run-2") }));
      yield* harness.confirm;
      expect(harness.sent).toEqual([]);

      harness.set(completed("thread-1", "run-2"));
      yield* harness.emit(runEnded("thread-1"));
      yield* harness.confirm;
      yield* harness.emit(runEnded("thread-1"));
      yield* harness.confirm;
      expect(harness.sent).toHaveLength(1);
      expect(harness.sent[0]?.deliveries).toEqual([
        {
          platform: "apns",
          token: "a".repeat(64),
          topic: "com.example.ankiel",
          environment: "sandbox",
          payload: {
            aps: {
              alert: { title: "Fix the login flow", "loc-key": "ANKIEL_PUSH_COMPLETED" },
              sound: "default",
              "thread-id": `${environmentId}/thread-1`,
              "interruption-level": "active",
            },
            body: { environmentId, threadId: "thread-1", kind: "completed" },
          },
          pushType: "alert",
          priority: 10,
          collapseId: "thread-1",
        },
      ]);

      harness.set(thread("thread-1", { pendingRuntimeRequest: request("approval-1", "command") }));
      yield* harness.emit(requestOpened("thread-1"));
      expect(harness.sent[1]?.deliveries[1]).toEqual({
        platform: "fcm",
        token: "fcm-token",
        data: {
          kind: "approval",
          title: "Fix the login flow",
          environmentId,
          threadId: "thread-1",
        },
        priority: "high",
        collapseKey: "thread-1",
      });

      harness.set(
        thread("thread-1", { pendingRuntimeRequest: request("question-1", "user_input") }),
      );
      yield* harness.emit(requestOpened("thread-1"));
      harness.set({ ...completed("thread-1", "run-3", 3_000), status: "failed" });
      yield* harness.emit(runEnded("thread-1", "failed"));

      // A child's approval alerts on its top-level thread, which is what a tap opens.
      harness.set(
        thread("thread-2", { title: "Parent" }),
        child("child-1", "thread-2", { pendingRuntimeRequest: request("approval-2", "command") }),
      );
      yield* harness.emit(requestOpened("child-1"));
      yield* harness.emit(requestOpened("child-1"));

      expect(harness.kindsSent()).toEqual([
        "completed",
        "approval",
        "approval",
        "input",
        "input",
        "failed",
        "approval",
        "approval",
      ]);
      expect(harness.pushedThread(harness.sent.at(-1))).toMatchObject({ threadId: "thread-2" });
    }),
  );

  it.effect("stays quiet for snoozed, archived, stopped and non-waiting child threads", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.registrations.push(iosPhone("b".repeat(64), [...ALL_KINDS]));
      yield* TestClock.adjust(5_000);

      harness.set({
        ...completed("snoozed", "run-1", 2_000),
        snoozedAt: at(1_500),
        snoozedUntil: at(60_000),
      });
      yield* harness.emit(runEnded("snoozed"));
      // The snooze has ended, but the completion landed during it.
      yield* TestClock.adjust(60_000);
      yield* harness.emit(event("provider-thread.updated", "snoozed", {}));

      harness.set({ ...completed("archived", "run-1", 2_000), archivedAt: at(3_000) });
      yield* harness.emit(runEnded("archived"));
      harness.set({ ...completed("stopped", "run-1", 2_000), latestRunStopRequested: true });
      yield* harness.emit(runEnded("stopped"));

      harness.set(
        thread("parent"),
        // The coordinating agent answers its child's questions.
        child("asks-agent", "parent", { pendingRuntimeRequest: request("q-1", "user_input") }),
        // Provider-native children ask on their parent instead.
        child("native", "parent", {
          creationSource: "provider",
          pendingRuntimeRequest: request("q-2", "command"),
        }),
        // A request left after the child's run ended no longer blocks anyone.
        child("ended", "parent", {
          activityRunStatus: null,
          pendingRuntimeRequest: request("q-3", "command"),
        }),
      );
      for (const id of ["asks-agent", "native", "ended"]) yield* harness.emit(requestOpened(id));

      expect(harness.sent).toEqual([]);
    }),
  );

  it.effect("sends nothing while the relay is down or cannot reach the phone's platform", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.registrations.push(iosPhone("c".repeat(64), [...ALL_KINDS]));
      harness.set(completed("thread-1", "run-1", 2_000));

      harness.relay.push = null;
      yield* harness.emit(runEnded("thread-1"));
      expect(harness.reads()).toBe(0);

      // Reconnecting does not surface the completion it missed.
      harness.relay.push = { availability: { apns: true, fcm: true }, readyAt: 3_000 };
      yield* harness.emit(event("provider-thread.updated", "thread-1", {}));

      harness.relay.push = { availability: { apns: false, fcm: true }, readyAt: 0 };
      harness.set(completed("thread-1", "run-2", 4_000));
      yield* harness.emit(runEnded("thread-1"));

      expect(harness.sent).toEqual([]);
    }),
  );

  it.effect("batches deliveries 32 to a message and forgets tokens the relay calls dead", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      for (let index = 0; index < 70; index++) {
        harness.registrations.push(iosPhone(index.toString(16).padStart(64, "0"), ["completed"]));
      }
      const dead = harness.registrations.at(40)?.token;
      harness.relay.reply = (message) => ({
        ...okResult(message),
        results: okResult(message).results.map((result) =>
          result.token === dead
            ? { ...result, ok: false, status: 410, unregistered: true }
            : result,
        ),
      });

      harness.set(completed("thread-1", "run-1"));
      yield* harness.emit(runEnded("thread-1"));
      yield* harness.confirm;

      expect(harness.sent.map((message) => message.deliveries.length)).toEqual([32, 32, 6]);
      expect(new Set(harness.sent.map((message) => message.pushId)).size).toBe(3);
      expect(harness.forgotten.flat()).toEqual([dead]);

      // A refused batch ends the push: the rest would meet the same limit.
      harness.relay.reply = (message) => ({
        ...okResult(message),
        results: [],
        error: "rate_limited",
      });
      harness.set(completed("thread-1", "run-2"));
      yield* harness.emit(runEnded("thread-1"));
      yield* harness.confirm;
      expect(harness.sent).toHaveLength(4);
    }),
  );

  it.effect("pushes a held completion when its background work ends, reading nothing before", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.registrations.push(iosPhone("d".repeat(64), ["completed"]));

      // Provider thread updates on a thread that holds no completion are never read.
      harness.set(completed("idle", "run-1"));
      yield* harness.emit(event("provider-thread.updated", "idle", {}));
      expect(harness.reads()).toBe(0);

      harness.set({
        ...completed("thread-1", "run-1"),
        pendingBackgroundTasks: [{ taskId: "task-1", kind: "subagent" }],
      });
      yield* harness.emit(runEnded("thread-1"));
      yield* harness.confirm;
      expect(harness.sent).toEqual([]);

      harness.set(completed("thread-1", "run-1"));
      yield* harness.emit(event("provider-thread.updated", "thread-1", {}));
      yield* harness.confirm;
      expect(harness.kindsSent()).toEqual(["completed"]);
    }),
  );
  it.effect("puts the buttons and the request on iOS alerts that can be answered from them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.registrations.push(
        iosPhone("e".repeat(64), [...ALL_KINDS]),
        androidPhone("fcm-token", [...ALL_KINDS]),
      );
      const apns = (index: number) => {
        const delivery = harness.sent[index]?.deliveries[0];
        return delivery?.platform === "apns" ? delivery.payload : undefined;
      };
      const opened = (threadId: string, requestId: string, kind: "command" | "user_input") => {
        harness.set(thread(threadId, { pendingRuntimeRequest: request(requestId, kind) }));
        return harness.emit(requestOpened(threadId));
      };

      harness.records.set("thread-1", {
        runtimeRequests: [runtimeRequest("approval-1", "command")],
        turnItems: [approvalCard("approval-1")],
      });
      yield* opened("thread-1", "approval-1", "command");
      expect(apns(0)).toMatchObject({
        aps: { category: "ANKIEL_APPROVAL" },
        body: {
          environmentId,
          threadId: "thread-1",
          kind: "approval",
          requestId: "approval-1",
          requestThreadId: "thread-1",
        },
      });
      // Android has no buttons, so its data stays as it was.
      expect(harness.sent[0]?.deliveries[1]).toMatchObject({
        data: { kind: "approval", environmentId, threadId: "thread-1" },
      });
      expect(harness.sent[0]?.deliveries[1]).not.toHaveProperty("data.requestId");

      // A child's request is answered on the child, from an alert that opens its parent.
      harness.set(
        thread("parent", { title: "Parent" }),
        child("child-1", "parent", { pendingRuntimeRequest: request("approval-2", "command") }),
      );
      harness.records.set("child-1", {
        runtimeRequests: [runtimeRequest("approval-2", "command")],
        turnItems: [approvalCard("approval-2")],
      });
      yield* harness.emit(requestOpened("child-1"));
      expect(apns(1)?.body).toEqual({
        environmentId,
        threadId: "parent",
        kind: "approval",
        requestId: "approval-2",
        requestThreadId: "child-1",
      });

      harness.records.set("thread-3", {
        runtimeRequests: [runtimeRequest("question-1", "user_input")],
        turnItems: [questionCard("question-1", [question("name")])],
      });
      yield* opened("thread-3", "question-1", "user_input");
      expect(apns(2)?.aps).toMatchObject({ category: "ANKIEL_INPUT_REPLY" });

      // A failed read or an id too long for APNs costs the buttons, never the alert.
      harness.recordReads.fail = true;
      harness.records.set("thread-4", {
        runtimeRequests: [runtimeRequest("approval-4", "command")],
        turnItems: [approvalCard("approval-4")],
      });
      yield* opened("thread-4", "approval-4", "command");
      harness.recordReads.fail = false;
      const longId = "r".repeat(4_000);
      harness.records.set("thread-5", {
        runtimeRequests: [runtimeRequest(longId, "command")],
        turnItems: [approvalCard(longId)],
      });
      yield* opened("thread-5", longId, "command");
      for (const index of [3, 4]) {
        expect(apns(index)?.aps).not.toHaveProperty("category");
        expect(apns(index)?.body).not.toHaveProperty("requestId");
      }
      expect(harness.kindsSent()).toHaveLength(10);
    }),
  );
});
