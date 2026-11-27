import type { AgentNotificationAction } from "@ankielcode/client-runtime/state/notification-actions";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@ankielcode/contracts";

export {
  type AgentNotificationAction,
  type AgentNotificationActionPlan,
  planAgentNotificationAction,
} from "@ankielcode/client-runtime/state/notification-actions";

/** The categories the server puts on an alert's `aps.category`; see AgentAlertPush. */
export const APPROVAL_CATEGORY = "ANKIEL_APPROVAL";
export const INPUT_REPLY_CATEGORY = "ANKIEL_INPUT_REPLY";

export const APPROVE_ACTION = "ANKIEL_APPROVE";
export const DENY_ACTION = "ANKIEL_DENY";
export const REPLY_ACTION = "ANKIEL_REPLY";

const ACTION_TYPES: Record<string, AgentNotificationAction["type"]> = {
  [APPROVE_ACTION]: "approve",
  [DENY_ACTION]: "deny",
  [REPLY_ACTION]: "reply",
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** The answer a notification button carries, or null when the response is a plain tap. */
export function extractAgentNotificationAction(response: unknown): AgentNotificationAction | null {
  if (typeof response !== "object" || response === null) return null;
  const { actionIdentifier, userText, notification } = response as {
    readonly actionIdentifier?: unknown;
    readonly userText?: unknown;
    readonly notification?: { readonly request?: { readonly content?: { data?: unknown } } };
  };
  const type = typeof actionIdentifier === "string" ? ACTION_TYPES[actionIdentifier] : undefined;
  if (type === undefined) return null;
  const data = notification?.request?.content?.data;
  if (typeof data !== "object" || data === null) return null;
  const { environmentId, threadId, requestThreadId, requestId } = data as Record<string, unknown>;
  const holder = nonEmptyString(requestThreadId) ? requestThreadId : threadId;
  if (!nonEmptyString(environmentId) || !nonEmptyString(holder) || !nonEmptyString(requestId)) {
    return null;
  }
  const text = type === "reply" && typeof userText === "string" ? userText.trim() : "";
  // iOS leaves out an empty reply; that response only opens the thread.
  if (type === "reply" && text.length === 0) return null;
  return {
    type,
    environmentId: EnvironmentId.make(environmentId),
    threadId: ThreadId.make(holder),
    requestId: RuntimeRequestId.make(requestId),
    text,
  };
}
