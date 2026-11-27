import {
  CommandId,
  type EnvironmentId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
  type ThreadId,
} from "@ankielcode/contracts";

import { buildPendingUserInputAnswers } from "./pendingUserInput.ts";
import { derivePendingThreadRequests } from "./threadRequests.ts";

/** An answer sent from an agent alert's button, on any client. */
export interface AgentNotificationAction {
  readonly type: "approve" | "deny" | "reply";
  readonly environmentId: EnvironmentId;
  /** The thread holding the request: a child's request is answered on the child. */
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
  /** The reply's text; empty for approve and deny. */
  readonly text: string;
}

/** The in-app card's buttons when the provider names none. */
const DEFAULT_APPROVAL_DECISIONS: ReadonlyArray<ProviderApprovalDecision> = [
  "accept",
  "acceptForSession",
  "decline",
];

type ThreadRequests = Parameters<typeof derivePendingThreadRequests>[0];

export type AgentNotificationActionPlan =
  /** The synced thread does not show the request yet. */
  | { readonly type: "wait" }
  /** Answered elsewhere, or no longer answerable: the open thread already shows that. */
  | { readonly type: "skip" }
  | {
      readonly type: "approval";
      readonly input: {
        readonly threadId: ThreadId;
        readonly requestId: RuntimeRequestId;
        readonly decision: ProviderApprovalDecision;
        readonly commandId: CommandId;
      };
    }
  | {
      readonly type: "user-input";
      readonly input: {
        readonly threadId: ThreadId;
        readonly requestId: RuntimeRequestId;
        readonly answers: Record<string, string | ReadonlyArray<string>>;
        readonly commandId: CommandId;
      };
    };

const WAIT: AgentNotificationActionPlan = { type: "wait" };
const SKIP: AgentNotificationActionPlan = { type: "skip" };

/**
 * What the button sends, decided from the thread's live projection, mirroring the in-app card:
 * Approve and Deny send what "Allow once" and "Decline" send, and Reply answers the only question.
 * A warm resume stays "live" on its old projection, so a request it lacks means wait, not answered.
 * The command id is fixed per request and button, so a repeat replays the server's receipt.
 */
export function planAgentNotificationAction(input: {
  readonly action: AgentNotificationAction;
  /** Null until the thread is live. */
  readonly thread: ThreadRequests | null;
  readonly canOperate: boolean;
}): AgentNotificationActionPlan {
  const { action, thread } = input;
  const request = thread?.runtimeRequests.find((entry) => entry.id === action.requestId);
  if (thread === null || request === undefined) return WAIT;
  if (request.status !== "pending" || !input.canOperate) return SKIP;
  const pending = derivePendingThreadRequests(thread);
  const commandId = CommandId.make(`notification:${action.type}:${action.requestId}`);
  if (action.type === "reply") {
    const request = pending.userInputs.find((entry) => entry.requestId === action.requestId);
    if (request === undefined || request.responseCapability === "not_resumable") return SKIP;
    const [question, ...others] = request.questions;
    if (question === undefined || others.length > 0) return SKIP;
    const answers = buildPendingUserInputAnswers(request.questions, {
      [question.id]: { customAnswer: action.text },
    });
    return answers === null
      ? SKIP
      : {
          type: "user-input",
          input: { threadId: action.threadId, requestId: action.requestId, answers, commandId },
        };
  }
  const approval = pending.approvals.find((entry) => entry.requestId === action.requestId);
  if (approval === undefined || approval.responseCapability !== "live") return SKIP;
  const decision: ProviderApprovalDecision = action.type === "approve" ? "accept" : "decline";
  const offered =
    approval.options?.map((option: ProviderApprovalOption) => option.decision) ??
    DEFAULT_APPROVAL_DECISIONS;
  if (!offered.includes(decision)) return SKIP;
  return {
    type: "approval",
    input: { threadId: action.threadId, requestId: action.requestId, decision, commandId },
  };
}
