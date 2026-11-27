import {
  isListedThreadLineage,
  isProviderNativeSubagentThread,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type PushAlertKind,
  type RuntimeRequestId,
  type ThreadId,
} from "@ankielcode/contracts";
import {
  type AgentAwarenessPhase,
  projectThreadAwarenessV2,
  turnItemCanChangeUserWait,
} from "@ankielcode/shared/agentAwareness";
import {
  agentNotificationButtons,
  findRequestCard,
} from "@ankielcode/shared/agentNotificationButtons";
import { makeDrainableWorker } from "@ankielcode/shared/DrainableWorker";
import {
  backgroundWorkHoldsCompletion,
  turnItemUpdateCanEndBackgroundWork,
} from "@ankielcode/shared/orchestrationV2PendingBackgroundWork";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as PushRegistry from "./PushRegistry.ts";
import type {
  RelayPushAvailability,
  RelayPushDelivery,
  RelayPushResultMessage,
} from "./relayProtocol.ts";
import * as RelayTunnelService from "./RelayTunnelService.ts";

/** The relay takes at most this many deliveries per `push` message. */
const RELAY_PUSH_BATCH_SIZE = 32;
const TITLE_MAX_CODE_POINTS = 80;
const MAX_LINEAGE_DEPTH = 16;
const COLLAPSE_PATTERN = /^[\x21-\x7e]{1,64}$/;
/** APNs refuses a larger payload, and so does the relay. */
const APNS_MAX_PAYLOAD_BYTES = 4096;
/** A run can end moments before a queued follow-up or wake starts, so a completion waits this long. */
const COMPLETION_CONFIRM_DELAY = "5 seconds";

/** Pushes attention transitions (finished, failed, approval, input) to registered phones. */
export class AgentAlertPush extends Context.Service<
  AgentAlertPush,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Waits until every thread queued so far has been checked and its pushes answered. */
    readonly drain: Effect.Effect<void>;
  }
>()("@ankielcode/server/relay/AgentAlertPush") {}

interface Alert {
  /** One transition, so a repeat of the same state never pushes twice. */
  readonly key: string;
  readonly kind: PushAlertKind;
  /** The listed thread a tap opens; a child's wait shows on its top-level thread. */
  readonly target: AgentAwarenessThread;
  /** The waiting request and the thread that holds it, which is the child for a child's wait. */
  readonly request: { readonly id: RuntimeRequestId; readonly threadId: ThreadId } | null;
}

/** The iOS notification categories the app registers; each names the buttons on the alert. */
export type AlertCategory = "ANKIEL_APPROVAL" | "ANKIEL_INPUT_REPLY";

interface AlertAction {
  readonly category: AlertCategory;
  readonly requestId: RuntimeRequestId;
  readonly requestThreadId: ThreadId;
}

/** One timer per thread; a newer completion replaces it. */
interface PendingConfirmation {
  readonly key: string;
  due: boolean;
  timer: Fiber.Fiber<void> | undefined;
}

/**
 * Whether an event can move a thread into an alerting state: "raise" always can, "release" only
 * ends background work that holds a completion. Everything else is skipped unread.
 */
function alertTrigger(event: OrchestrationV2DomainEvent): "raise" | "release" | null {
  switch (event.type) {
    case "run.updated":
      return event.payload.status === "completed" || event.payload.status === "failed"
        ? "raise"
        : null;
    case "runtime-request.updated":
      return event.payload.status === "pending" ? "raise" : null;
    case "turn-item.updated":
      return turnItemCanChangeUserWait(event.payload)
        ? "raise"
        : turnItemUpdateCanEndBackgroundWork(event.payload)
          ? "release"
          : null;
    case "provider-thread.updated":
      return backgroundWorkHoldsCompletion(event.payload.pendingBackgroundTasks ?? [])
        ? null
        : "release";
    case "thread.pull-request-synced":
      return "release";
    default:
      return null;
  }
}

/** Matches the client's roll-up: approvals, and only cards that just the user can answer. */
function requestAwaitingUser(thread: AgentAwarenessThread) {
  const request = thread.pendingRuntimeRequest;
  return request !== null &&
    request.kind !== "auth_refresh" &&
    (request.kind !== "user_input" || request.userOnly === true) &&
    !isProviderNativeSubagentThread(thread) &&
    thread.activityRunStatus != null
    ? request
    : null;
}

const KIND_BY_PHASE: Partial<Record<AgentAwarenessPhase, PushAlertKind>> = {
  completed: "completed",
  failed: "failed",
  waiting_for_approval: "approval",
  waiting_for_input: "input",
};

/** Maps the shared button rule to the iOS category that registers those buttons. */
export function alertCategory(
  request: OrchestrationV2RuntimeRequest,
  item: OrchestrationV2TurnItem | undefined,
): AlertCategory | null {
  const buttons = agentNotificationButtons(request, item);
  return buttons === "approval"
    ? "ANKIEL_APPROVAL"
    : buttons === "reply"
      ? "ANKIEL_INPUT_REPLY"
      : null;
}

const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength;

const toMillis = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

/** A completion that landed during a snooze stays silent when it is read after the wake. */
function silencedBySnooze(thread: AgentAwarenessThread, kind: PushAlertKind, nowMs: number) {
  if (isSnoozed(thread, nowMs)) return true;
  if (kind !== "completed" && kind !== "failed") return false;
  const completedAt = toMillis(thread.latestRunCompletedAt);
  if (completedAt === null) return false;
  const snoozedAt = toMillis(thread.snoozedAt);
  if (snoozedAt !== null && completedAt < snoozedAt) return false;
  return isSnoozed(thread, completedAt);
}

function truncateTitle(title: string): string {
  const codePoints = Array.from(title.trim());
  return codePoints.length <= TITLE_MAX_CODE_POINTS
    ? codePoints.join("")
    : `${codePoints.slice(0, TITLE_MAX_CODE_POINTS - 1).join("")}…`;
}

function apnsPayload(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly kind: PushAlertKind;
  readonly action: AlertAction | null;
}) {
  const { environmentId, threadId, title, kind, action } = input;
  return {
    aps: {
      alert: { title, "loc-key": `ANKIEL_PUSH_${kind.toUpperCase()}` },
      sound: "default",
      "thread-id": `${environmentId}/${threadId}`,
      // The app has no time-sensitive entitlement, so every alert is "active".
      "interruption-level": "active",
      ...(action ? { category: action.category } : {}),
    },
    body: {
      environmentId,
      threadId,
      kind,
      ...(action ? { requestId: action.requestId, requestThreadId: action.requestThreadId } : {}),
    },
  };
}

/**
 * The phone localizes the body; the app must define these APNs `loc-key`s: ANKIEL_PUSH_COMPLETED,
 * ANKIEL_PUSH_FAILED, ANKIEL_PUSH_APPROVAL, ANKIEL_PUSH_INPUT. The tap handler's ids sit under
 * `body` on iOS, the only part of a remote push expo-notifications exposes as `data`.
 */
function buildPushDelivery(input: {
  readonly registration: PushRegistry.PushRegistration;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly kind: PushAlertKind;
  readonly action: AlertAction | null;
}): RelayPushDelivery {
  const { registration, environmentId, threadId, kind } = input;
  const title = truncateTitle(input.title);
  const collapse = COLLAPSE_PATTERN.test(threadId) ? threadId : undefined;
  const urgent = kind === "approval" || kind === "input";
  if (registration.platform === "ios") {
    const actionable = input.action ? apnsPayload({ ...input, title }) : null;
    // Long ids could push the buttons past the size limit; a plain alert still opens the thread.
    const actionablePayload =
      actionable && utf8Length(JSON.stringify(actionable)) <= APNS_MAX_PAYLOAD_BYTES
        ? actionable
        : null;
    return {
      platform: "apns",
      token: registration.token,
      topic: registration.appId,
      environment: registration.apnsEnvironment ?? "production",
      payload: actionablePayload ?? apnsPayload({ ...input, title, action: null }),
      pushType: "alert",
      priority: 10,
      ...(collapse ? { collapseId: collapse } : {}),
    };
  }
  return {
    platform: "fcm",
    token: registration.token,
    data: { kind, title, environmentId, threadId },
    priority: urgent ? "high" : "normal",
    ...(collapse ? { collapseKey: collapse } : {}),
  };
}

function summarizeResult(result: RelayPushResultMessage) {
  const reasons = new Set<string>();
  let delivered = 0;
  for (const entry of result.results) {
    if (entry.ok) delivered++;
    else reasons.add(entry.reason ?? String(entry.status ?? "unknown"));
  }
  return {
    pushId: result.pushId,
    delivered,
    failed: result.results.length - delivered,
    reasons: [...reasons],
    ...(result.error ? { error: result.error } : {}),
  };
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const registry = yield* PushRegistry.PushRegistry;
  const relay = yield* RelayTunnelService.RelayTunnelService;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const scope = yield* Effect.scope;
  const startedAt = yield* Clock.currentTimeMillis;
  const lastAlertKey = new Map<ThreadId, string>();
  // Listed threads whose latest run completed while background work still holds it.
  const heldCompletions = new Set<ThreadId>();
  const confirming = new Map<ThreadId, PendingConfirmation>();
  const queued = new Set<ThreadId>();
  let pushSequence = 0;

  const usablePushState = relay.pushState.pipe(
    Effect.map((state) =>
      state !== null && (state.availability.apns || state.availability.fcm) ? state : null,
    ),
  );

  // Per-event reads below share the evaluation's span instead of opening one each.
  const readThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const snapshot = yield* threads.getAgentAwarenessSnapshot(threadId);
    return snapshot.threads[0] ?? null;
  });

  const findListedAncestor = Effect.fnUntraced(function* (child: AgentAwarenessThread) {
    let current = child;
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
      const parentId = current.lineage.parentThreadId;
      if (parentId === null || parentId === current.id) return null;
      const parent = yield* readThread(parentId);
      if (parent === null) return null;
      if (isListedThreadLineage(parent.lineage)) return parent;
      current = parent;
    }
    return null;
  });

  const resolveAlert = Effect.fnUntraced(function* (thread: AgentAwarenessThread, armedAt: number) {
    if (thread.archivedAt !== null) return null;
    const nowMs = yield* Clock.currentTimeMillis;
    if (!isListedThreadLineage(thread.lineage)) {
      const request = requestAwaitingUser(thread);
      if (request === null) return null;
      if (DateTime.toEpochMillis(request.createdAt) < armedAt) return null;
      const target = yield* findListedAncestor(thread);
      if (target === null || target.archivedAt !== null) return null;
      const kind: PushAlertKind = request.kind === "user_input" ? "input" : "approval";
      // The parent's snooze judges the child's request as if the parent had asked it.
      if (isSnoozed({ ...target, pendingRuntimeRequest: request }, nowMs)) return null;
      return {
        key: `request:${request.id}`,
        kind,
        target,
        request: { id: request.id, threadId: thread.id },
      } satisfies Alert;
    }
    const phase = projectThreadAwarenessV2({
      environmentId,
      project: { title: "" },
      thread,
    })?.phase;
    if (phase === "running" && thread.activityRunStatus == null) heldCompletions.add(thread.id);
    else heldCompletions.delete(thread.id);
    const kind = phase === undefined ? undefined : KIND_BY_PHASE[phase];
    if (kind === undefined) return null;
    const request = kind === "approval" || kind === "input" ? thread.pendingRuntimeRequest : null;
    const at =
      request !== null
        ? DateTime.toEpochMillis(request.createdAt)
        : (toMillis(thread.latestRunCompletedAt) ?? DateTime.toEpochMillis(thread.updatedAt));
    // A transition from before the tunnel last connected was missed, not new.
    if (at < armedAt) return null;
    if (silencedBySnooze(thread, kind, nowMs)) return null;
    const key = request !== null ? `request:${request.id}` : `${kind}:${thread.latestRunId ?? ""}`;
    return {
      key,
      kind,
      target: thread,
      request: request === null ? null : { id: request.id, threadId: thread.id },
    } satisfies Alert;
  });

  // A failed read costs the buttons, never the alert, which is marked sent before dispatch.
  const readAlertAction = Effect.fnUntraced(
    function* (request: NonNullable<Alert["request"]>) {
      const records = yield* threads.getThreadRecords(
        request.threadId,
        ["runtimeRequests", "turnItems"],
        {
          runtimeRequestStatuses: ["pending"],
          turnItemRequestIds: [request.id],
          turnItemTypes: ["approval_request", "user_input_request"],
        },
      );
      const pending = records.runtimeRequests.find((entry) => entry.id === request.id);
      const item = findRequestCard(records.turnItems, request.id);
      const category = pending === undefined ? null : alertCategory(pending, item);
      return category === null
        ? null
        : ({
            category,
            requestId: request.id,
            requestThreadId: request.threadId,
          } satisfies AlertAction);
    },
    Effect.orElseSucceed(() => null),
  );

  const dispatch = Effect.fn("AgentAlertPush.dispatch")(function* (
    alert: Alert,
    availability: RelayPushAvailability,
  ) {
    yield* Effect.annotateCurrentSpan({ kind: alert.kind, threadId: alert.target.id });
    const seenTokens = new Set<string>();
    const recipients: PushRegistry.PushRegistration[] = [];
    for (const registration of yield* registry.listActive) {
      const available = registration.platform === "ios" ? availability.apns : availability.fcm;
      if (!available || !registration.kinds.includes(alert.kind)) continue;
      // A phone paired twice holds one token under two sessions.
      if (seenTokens.has(registration.token)) continue;
      seenTokens.add(registration.token);
      recipients.push(registration);
    }
    // Only iOS shows the buttons.
    const action =
      alert.request !== null && recipients.some((registration) => registration.platform === "ios")
        ? yield* readAlertAction(alert.request)
        : null;
    const deliveries = recipients.map((registration) =>
      buildPushDelivery({
        registration,
        environmentId,
        threadId: alert.target.id,
        title: alert.target.title,
        kind: alert.kind,
        action,
      }),
    );
    for (let offset = 0; offset < deliveries.length; offset += RELAY_PUSH_BATCH_SIZE) {
      const pushId = `alert-${startedAt}-${++pushSequence}`;
      const result = yield* relay.sendPush({
        type: "push",
        pushId,
        deliveries: deliveries.slice(offset, offset + RELAY_PUSH_BATCH_SIZE),
      });
      if (result === null) {
        yield* Effect.logInfo("agent alert push dropped; relay tunnel unavailable", { pushId });
        return;
      }
      const unregistered = result.results.flatMap((entry) =>
        entry.unregistered === true ? [entry.token] : [],
      );
      yield* registry.forgetTokens(unregistered);
      yield* Effect.logInfo("agent alert push answered", {
        kind: alert.kind,
        unregistered: unregistered.length,
        ...summarizeResult(result),
      });
      // Later batches would meet the same refusal.
      if (result.error !== undefined) return;
    }
  });

  // Annotated: the worker below calls back into this, which inference cannot follow.
  const enqueue = (threadId: ThreadId): Effect.Effect<void> =>
    Effect.suspend(() => {
      // Coalesce: one check reads the newest state for every event queued behind it.
      if (queued.has(threadId)) return Effect.void;
      queued.add(threadId);
      return worker.enqueue(threadId);
    });

  const cancelConfirmation = Effect.fnUntraced(function* (threadId: ThreadId) {
    const pending = confirming.get(threadId);
    confirming.delete(threadId);
    if (pending?.timer !== undefined) yield* Fiber.interrupt(pending.timer);
  });

  const confirmLater = Effect.fnUntraced(function* (threadId: ThreadId, key: string) {
    const pending: PendingConfirmation = { key, due: false, timer: undefined };
    confirming.set(threadId, pending);
    pending.timer = yield* Effect.sleep(COMPLETION_CONFIRM_DELAY).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (confirming.get(threadId) !== pending) return Effect.void;
          pending.due = true;
          pending.timer = undefined;
          return enqueue(threadId);
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  // Untraced: runs per candidate event; dispatch opens the span once a push is due.
  const evaluate = Effect.fnUntraced(function* (threadId: ThreadId) {
    const push = yield* usablePushState;
    if (push === null) return;
    const thread = yield* readThread(threadId);
    if (thread === null) {
      lastAlertKey.delete(threadId);
      heldCompletions.delete(threadId);
      yield* cancelConfirmation(threadId);
      return;
    }
    const alert = yield* resolveAlert(thread, Math.max(startedAt, push.readyAt));
    const pending = confirming.get(threadId);
    if (pending !== undefined && pending.key !== alert?.key) yield* cancelConfirmation(threadId);
    if (alert === null || lastAlertKey.get(threadId) === alert.key) return;
    if (alert.kind === "completed" && !(pending?.key === alert.key && pending.due)) {
      if (pending?.key !== alert.key) yield* confirmLater(threadId, alert.key);
      return;
    }
    confirming.delete(threadId);
    lastAlertKey.set(threadId, alert.key);
    yield* dispatch(alert, push.availability);
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(
      Effect.andThen(evaluate(threadId)),
      Effect.catch((error) =>
        Effect.logWarning("agent alert push check failed", { threadId, error: error._tag }),
      ),
    ),
  );

  const handleEvent = (event: OrchestrationV2DomainEvent) => {
    if (event.type === "thread.archived" || event.type === "thread.deleted") {
      lastAlertKey.delete(event.threadId);
      heldCompletions.delete(event.threadId);
      return Effect.void;
    }
    const trigger = alertTrigger(event);
    if (trigger === null || (trigger === "release" && !heldCompletions.has(event.threadId))) {
      return Effect.void;
    }
    return usablePushState.pipe(
      Effect.flatMap((push) => (push === null ? Effect.void : enqueue(event.threadId))),
    );
  };

  const start = Effect.fn("AgentAlertPush.start")(function* () {
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, handleEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("agent alert push event stream failed", { cause }),
        ),
      ),
    );
  });

  return AgentAlertPush.of({ start, drain: worker.drain });
});

export const layer = Layer.effect(
  AgentAlertPush,
  make.pipe(Effect.tap((service) => service.start())),
);
