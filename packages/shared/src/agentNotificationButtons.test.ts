import { describe, expect, it } from "@effect/vitest";

import {
  NodeId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  ProviderSessionId,
  RuntimeRequestId,
} from "@ankielcode/contracts";
import * as DateTime from "effect/DateTime";

import { agentNotificationButtons, findRequestCard } from "./agentNotificationButtons.ts";

const request = (
  kind: OrchestrationV2RuntimeRequest["kind"],
  overrides: Partial<OrchestrationV2RuntimeRequest> = {},
): OrchestrationV2RuntimeRequest => ({
  id: RuntimeRequestId.make("r"),
  nodeId: NodeId.make("node-1"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind,
  status: "pending",
  responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session-1") },
  createdAt: DateTime.makeUnsafe(2_000),
  resolvedAt: null,
  ...overrides,
});
// The rule reads only the card's type, request id, questions and options.
const card = (type: string, requestId: string, fields: Record<string, unknown> = {}) =>
  ({ type, requestId: RuntimeRequestId.make(requestId), ...fields }) as OrchestrationV2TurnItem;
const question = (overrides: Record<string, unknown> = {}) => ({
  id: "name",
  header: "Question",
  question: "What should the release be called?",
  options: [],
  ...overrides,
});

describe("agentNotificationButtons", () => {
  it("offers buttons only when they answer the request the way its card would", () => {
    const cases: ReadonlyArray<
      readonly [string, OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem | undefined, unknown]
    > = [
      ["an approval", request("command"), card("approval_request", "r"), "approval"],
      ["a tool call", request("dynamic_tool_call"), card("approval_request", "r"), null],
      ["an auth refresh", request("auth_refresh"), card("approval_request", "r"), null],
      [
        "one free-text question",
        request("user_input"),
        card("user_input_request", "r", { questions: [question()] }),
        "reply",
      ],
      [
        "a multi-select question",
        request("user_input"),
        card("user_input_request", "r", { questions: [question({ multiSelect: true })] }),
        null,
      ],
      ["a question without its card", request("user_input"), undefined, null],
    ];
    for (const [name, pending, item, expected] of cases) {
      expect([name, agentNotificationButtons(pending, item)]).toEqual([name, expected]);
    }
  });

  it("reads the request's latest card", () => {
    const first = card("approval_request", "r", { id: "first" });
    const latest = card("approval_request", "r", { id: "latest" });
    const items = [first, card("user_input_request", "other"), latest, card("message", "r")];
    expect(findRequestCard(items, RuntimeRequestId.make("r"))).toBe(latest);
    expect(findRequestCard(items, RuntimeRequestId.make("missing"))).toBeUndefined();
  });
});
