import { runAtomCommand } from "@ankielcode/client-runtime/state/runtime";
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
  type AgentNotificationActionPlan,
  APPROVAL_CATEGORY,
  APPROVE_ACTION,
  DENY_ACTION,
  INPUT_REPLY_CATEGORY,
  planAgentNotificationAction,
  REPLY_ACTION,
} from "./notificationActions";
import { pushSupportedOnPlatform } from "./pushRegistration";

const actionDebug = createDebugLogger("notification-actions");
/** How long a button waits for the thread to sync and show its request, then for the send. */
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

function reportUnsent(): void {
  Dialog.alert(m(msg("Couldn't send your answer")), m(msg("Try again from the thread.")));
}

const projectionOf = (result: AsyncResult.AsyncResult<EnvironmentThreadState, unknown>) =>
  AsyncResult.isSuccess(result) ? Option.getOrNull(result.value.data) : null;

const inFlight = new Set<string>();

/** Sends a button's answer once the opened thread shows its request; a stale one stays quiet. */
export async function performAgentNotificationAction(
  action: AgentNotificationAction,
): Promise<void> {
  const key = `${action.environmentId}\n${action.requestId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  // Mounting the thread keeps it syncing while the screen it opened mounts.
  const atom = environmentThreads.stateAtom(action.environmentId, action.threadId);
  let settle: (plan: AgentNotificationActionPlan | null) => void = () => undefined;
  const decided = new Promise<AgentNotificationActionPlan | null>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => settle(null), SYNC_TIMEOUT_MS);
  const unsubscribe = appAtomRegistry.subscribe(
    atom,
    (result) => {
      const state = AsyncResult.isSuccess(result) ? result.value : null;
      if (state?.status === "deleted") return settle({ type: "skip" });
      if (state?.status !== "live") return;
      const plan = planAgentNotificationAction({
        action,
        thread: Option.getOrNull(state.data),
        canOperate: readEnvironmentScope(action.environmentId, AuthOrchestrationOperateScope),
      });
      if (plan.type !== "wait") settle(plan);
    },
    { immediate: true },
  );
  try {
    const plan = await decided;
    clearTimeout(timer);
    // Never synced, or never showed the request: the answer did not leave the phone.
    if (plan === null) return reportUnsent();
    if (plan.type === "skip" || plan.type === "wait") return;
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
    if (result._tag === "Success") return;
    // Another device may have answered while this one sent; that is not a failure to report.
    const request = projectionOf(appAtomRegistry.get(atom))?.runtimeRequests.find(
      (entry) => entry.id === action.requestId,
    );
    if (request !== undefined && request.status !== "pending") return;
    actionDebug.log("notification action failed", { type: action.type });
    reportUnsent();
  } finally {
    clearTimeout(timer);
    unsubscribe();
    inFlight.delete(key);
  }
}
