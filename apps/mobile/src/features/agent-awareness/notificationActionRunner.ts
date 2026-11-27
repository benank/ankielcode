import { runAtomCommand } from "@ankielcode/client-runtime/state/runtime";
import {
  derivePendingThreadRequests,
  type PendingThreadRequests,
} from "@ankielcode/client-runtime/state/thread-requests";
import type { EnvironmentThreadState } from "@ankielcode/client-runtime/state/threads";
import { AuthOrchestrationOperateScope } from "@ankielcode/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Notifications from "expo-notifications";
import { msg } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { m, subscribeActiveLocale } from "../../i18n/messages";
import { createDebugLogger } from "../../lib/debugLog";
import { appAtomRegistry } from "../../state/atom-registry";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreads, threadEnvironment } from "../../state/threads";
import {
  type AgentNotificationAction,
  APPROVAL_CATEGORY,
  APPROVE_ACTION,
  DENY_ACTION,
  INPUT_REPLY_CATEGORY,
  planAgentNotificationAction,
  REPLY_ACTION,
} from "./notificationActions";
import { pushSupportedOnPlatform } from "./pushRegistration";

const actionDebug = createDebugLogger("notification-actions");
/** How long a button waits for its computer to connect and sync the thread, then for the send. */
const SYNC_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 20_000;

// Foreground: expo-notifications ends iOS's background time as it hands JS the response
// (NotificationCenterManager.didReceive), and a cold launch holds it until JS loads, long before a
// socket connects. So every button opens the thread and answers there. Unlocking is required, so
// a locked phone can never approve.
const BUTTON_OPTIONS = { opensAppToForeground: true, isAuthenticationRequired: true };

function registerCategories(): Promise<unknown> {
  return Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY, [
    {
      identifier: APPROVE_ACTION,
      buttonTitle: m(msg("Approve", { $context: "verb, notification button" })),
      options: BUTTON_OPTIONS,
    },
    {
      identifier: DENY_ACTION,
      buttonTitle: m(msg("Deny", { $context: "verb, notification button" })),
      options: { ...BUTTON_OPTIONS, isDestructive: true },
    },
  ]).then(() =>
    Notifications.setNotificationCategoryAsync(INPUT_REPLY_CATEGORY, [
      {
        identifier: REPLY_ACTION,
        buttonTitle: m(msg("Reply", { $context: "verb, notification button" })),
        textInput: {
          placeholder: m(msg("Type your answer")),
          submitButtonTitle: m(msg("Send", { $context: "verb, sends a reply" })),
        },
        options: BUTTON_OPTIONS,
      },
    ]),
  );
}

/** Registers the alert buttons in the UI language, again after each language switch. */
export function installAgentNotificationCategories(): () => void {
  if (!pushSupportedOnPlatform) return () => undefined;
  // One chain: the native module reads and rewrites the whole category set per call.
  let chain: Promise<unknown> = Promise.resolve();
  const register = () => {
    chain = chain
      .then(registerCategories)
      .catch((error: unknown) =>
        actionDebug.log("notification categories failed", { error: String(error) }),
      );
  };
  register();
  return subscribeActiveLocale(register);
}

/** Resolves with the thread once it is live, or null when it is gone or the wait runs out. */
function waitForLiveThread(action: AgentNotificationAction): {
  readonly ready: Promise<EnvironmentThreadState | null>;
  readonly read: () => EnvironmentThreadState | null;
  readonly release: () => void;
} {
  const atom = environmentThreads.stateAtom(action.environmentId, action.threadId);
  const read = () => {
    const result = appAtomRegistry.get(atom);
    return AsyncResult.isSuccess(result) ? (result.value as EnvironmentThreadState) : null;
  };
  let settle: (state: EnvironmentThreadState | null) => void = () => undefined;
  const ready = new Promise<EnvironmentThreadState | null>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => settle(null), SYNC_TIMEOUT_MS);
  const check = () => {
    const state = read();
    // A cached projection can predate the request, so only a live one decides.
    if (state?.status === "live") settle(state);
    else if (state?.status === "deleted") settle(null);
  };
  const unsubscribe = appAtomRegistry.subscribe(atom, check, { immediate: true });
  return {
    ready: ready.finally(() => clearTimeout(timer)),
    read,
    release: () => {
      clearTimeout(timer);
      unsubscribe();
    },
  };
}

const pendingRequestsOf = (state: EnvironmentThreadState | null): PendingThreadRequests | null =>
  state === null
    ? null
    : Option.match(state.data, {
        onNone: () => null,
        onSome: derivePendingThreadRequests,
      });

const stillPending = (action: AgentNotificationAction, state: EnvironmentThreadState | null) => {
  const pending = pendingRequestsOf(state);
  return (
    pending === null ||
    [...pending.approvals, ...pending.userInputs].some(
      (request) => request.requestId === action.requestId,
    )
  );
};

function reportUnsent(): void {
  Dialog.alert(m(msg("Couldn't send your answer")), m(msg("Try again from the thread.")));
}

const inFlight = new Set<string>();

/** Sends a button's answer once the thread it opened is live; a stale request stays quiet. */
export async function performAgentNotificationAction(
  action: AgentNotificationAction,
): Promise<void> {
  const key = `${action.environmentId}\n${action.requestId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const thread = waitForLiveThread(action);
  try {
    const state = await thread.ready;
    if (state === null) {
      // A deleted thread has nothing to answer; a timeout means the answer never left.
      if (thread.read()?.status !== "deleted") reportUnsent();
      return;
    }
    const plan = planAgentNotificationAction({
      action,
      pending: pendingRequestsOf(state),
      canOperate: readEnvironmentScope(action.environmentId, AuthOrchestrationOperateScope),
    });
    if (plan.type === "skip") return;
    const abort = new AbortController();
    const sendTimer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
    const options = { reportFailure: false, signal: abort.signal };
    const result =
      plan.type === "approval"
        ? await runAtomCommand(
            appAtomRegistry,
            threadEnvironment.respondToApproval,
            { environmentId: action.environmentId, input: plan.input },
            options,
          )
        : await runAtomCommand(
            appAtomRegistry,
            threadEnvironment.respondToUserInput,
            { environmentId: action.environmentId, input: plan.input },
            options,
          );
    clearTimeout(sendTimer);
    // Another device may have answered while this one sent; that is not a failure to report.
    if (result._tag === "Failure" && stillPending(action, thread.read())) {
      actionDebug.log("notification action failed", { type: action.type });
      reportUnsent();
    }
  } finally {
    thread.release();
    inFlight.delete(key);
  }
}
