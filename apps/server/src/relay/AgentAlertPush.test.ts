import {
  EnvironmentId,
  type OrchestrationV2DomainEvent,
  ProjectId,
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
  };
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
});
