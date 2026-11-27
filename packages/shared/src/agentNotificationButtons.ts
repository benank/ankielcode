import type { OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem } from "@ankielcode/contracts";

/** An alert's buttons: Approve and Deny, or one Reply. */
export type AgentNotificationButtons = "approval" | "reply";

/**
 * Which buttons an alert for a waiting request can carry, or null when only opening the thread
 * answers it correctly. Approve and Deny send `accept` and `decline`, as the in-app card's "Allow
 * once" and "Decline" do. App access requests stay tap-only: their decline is saved as a lasting
 * denial and a link request turns accept into cancel, which two blind buttons would hide.
 */
export function agentNotificationButtons(
  request: OrchestrationV2RuntimeRequest,
  item: OrchestrationV2TurnItem | undefined,
): AgentNotificationButtons | null {
  if (request.status !== "pending") return null;
  if (request.kind === "user_input") {
    if (request.responseCapability.type === "not_resumable") return null;
    if (item?.type !== "user_input_request" || item.questions.length !== 1) return null;
    const question = item.questions[0]!;
    return question.options.length === 0 &&
      question.allowCustomAnswer !== false &&
      question.multiSelect !== true
      ? "reply"
      : null;
  }
  if (
    request.kind === "auth_refresh" ||
    request.kind === "dynamic_tool_call" ||
    request.kind === "mcp-elicitation" ||
    request.responseCapability.type !== "live" ||
    item?.type !== "approval_request"
  ) {
    return null;
  }
  // Without options the card offers accept, accept for the session, and decline.
  const options = item.options;
  if (options === undefined) return "approval";
  return options.some((option) => option.decision === "accept") &&
    options.some((option) => option.decision === "decline") &&
    // A warning the card shows must not be skipped by a button that never shows it.
    options.every((option) => option.warning === undefined)
    ? "approval"
    : null;
}

/** The request's latest card, which `agentNotificationButtons` reads. */
export function findRequestCard(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  requestId: OrchestrationV2RuntimeRequest["id"],
): OrchestrationV2TurnItem | undefined {
  return turnItems.findLast(
    (entry) =>
      (entry.type === "approval_request" || entry.type === "user_input_request") &&
      entry.requestId === requestId,
  );
}
