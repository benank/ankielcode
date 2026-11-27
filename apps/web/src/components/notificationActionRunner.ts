import {
  type AgentNotificationAction,
  planAgentNotificationAction,
} from "@ankielcode/client-runtime/state/notification-actions";
import { runAtomCommand } from "@ankielcode/client-runtime/state/runtime";
import type { EnvironmentThreadState } from "@ankielcode/client-runtime/state/threads";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type RuntimeRequestId,
  type ThreadId,
} from "@ankielcode/contracts";
import {
  type AgentNotificationButtons,
  agentNotificationButtons,
  findRequestCard,
} from "@ankielcode/shared/agentNotificationButtons";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { readEnvironmentScope } from "../state/session";
import { environmentThreads, threadEnvironment } from "../state/threads";

/** A warm thread answers at once; a cold one gets this long before its alert goes out without buttons. */
const BUTTONS_TIMEOUT_MS = 3_000;
/** How long a button waits for the thread to sync and show its request, then for the send. */
const SYNC_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 20_000;

const KEEP_WAITING = Symbol("keep-waiting");

/**
 * Mounts the thread until its live projection gives `decide` an answer, so a thread the user
 * never opened still syncs. Null when it never does in time, or the thread is deleted.
 */
function decideOnLiveThread<A>(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  timeoutMs: number,
  decide: (thread: OrchestrationV2ThreadProjection | null) => A | typeof KEEP_WAITING,
): Promise<A | null> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const settle = (value: A | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    unsubscribe = registry.subscribe(
      environmentThreads.stateAtom(environmentId, threadId),
      (result: AsyncResult.AsyncResult<EnvironmentThreadState, unknown>) => {
        const state = AsyncResult.isSuccess(result) ? result.value : null;
        if (state?.status === "deleted") return settle(null);
        if (state?.status !== "live") return;
        const decided = decide(Option.getOrNull(state.data));
        if (decided !== KEEP_WAITING) settle(decided);
      },
      { immediate: true },
    );
    if (settled) unsubscribe();
  });
}

/** Which buttons the alert for this request can carry, by the same rule as iOS. */
export function resolveNotificationButtons(
  registry: AtomRegistry.AtomRegistry,
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
  },
): Promise<AgentNotificationButtons | null> {
  return decideOnLiveThread(
    registry,
    input.environmentId,
    input.threadId,
    BUTTONS_TIMEOUT_MS,
    (thread) => {
      const request = thread?.runtimeRequests.find((entry) => entry.id === input.requestId);
      if (thread === null || request === undefined) return KEEP_WAITING;
      return agentNotificationButtons(request, findRequestCard(thread.turnItems, request.id));
    },
  );
}

/**
 * Sends a button's answer through the in-app card's commands once the thread shows its request.
 * "skipped" means another device answered or the request can no longer be answered.
 */
export async function answerFromNotification(
  registry: AtomRegistry.AtomRegistry,
  action: AgentNotificationAction,
): Promise<"sent" | "skipped" | "unsent"> {
  const atom = environmentThreads.stateAtom(action.environmentId, action.threadId);
  // Held through the send, so the failure check below reads the live thread.
  const release = registry.mount(atom);
  try {
    const plan = await decideOnLiveThread(
      registry,
      action.environmentId,
      action.threadId,
      SYNC_TIMEOUT_MS,
      (thread) => {
        const next = planAgentNotificationAction({
          action,
          thread,
          canOperate: readEnvironmentScope(action.environmentId, AuthOrchestrationOperateScope),
        });
        return next.type === "wait" ? KEEP_WAITING : next;
      },
    );
    if (plan === null) return "unsent";
    if (plan.type === "skip") return "skipped";
    const abort = new AbortController();
    const sendTimer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
    const options = { reportFailure: false, signal: abort.signal };
    const result =
      plan.type === "approval"
        ? await runAtomCommand(
            registry,
            threadEnvironment.respondToApproval,
            { environmentId: action.environmentId, input: plan.input },
            options,
          )
        : await runAtomCommand(
            registry,
            threadEnvironment.respondToUserInput,
            { environmentId: action.environmentId, input: plan.input },
            options,
          );
    clearTimeout(sendTimer);
    if (result._tag === "Success") return "sent";
    // Another device may have answered while this one sent; that is not a failure to report.
    const current = registry.get(atom);
    const request = AsyncResult.isSuccess(current)
      ? Option.getOrNull(current.value.data)?.runtimeRequests.find(
          (entry) => entry.id === action.requestId,
        )
      : undefined;
    return request !== undefined && request.status !== "pending" ? "skipped" : "unsent";
  } finally {
    release();
  }
}
