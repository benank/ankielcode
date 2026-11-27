import type { NotificationResponse } from "expo-notifications";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { PendingThreadRequests } from "@ankielcode/client-runtime/state/thread-requests";
import { RuntimeRequestId } from "@ankielcode/contracts";

import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import {
  type AgentNotificationAction,
  extractAgentNotificationAction,
  planAgentNotificationAction,
} from "./notificationActions";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

import {
  extractAgentNotificationDeepLink,
  routeAgentNotificationResponseOnce,
} from "./notificationPayload";

function responseWithData(
  data: Record<string, unknown>,
  identifier = "notification-1",
  action: { readonly actionIdentifier?: string; readonly userText?: string } = {},
) {
  return {
    ...action,
    notification: {
      request: {
        identifier,
        content: {
          data,
        },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consumeLastAgentNotificationResponse", () => {
  it("reports routing failures before clearing the response", async () => {
    const cause = new Error("notification routing unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({}, "notification-route") as NotificationResponse;
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: () => {
        throw cause;
      },
    });

    expect(clearLastResponse).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NotificationNavigationError",
        operation: "route",
        notificationId: "notification-route",
      }),
    );
  });
});

describe("extractAgentNotificationDeepLink", () => {
  it("uses explicit deep links from APNs payload data", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/threads/env/thread",
          environmentId: "ignored",
          threadId: "ignored",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("falls back to the thread route from environment and thread ids", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          environmentId: "env 1",
          threadId: "thread/2",
        }),
      ),
    ).toBe("/threads/env%201/thread%2F2");
    // A relay push's APNs `body`, which expo-notifications exposes as `content.data`.
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({ environmentId: "env", threadId: "thread", kind: "approval" }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("falls back to ids when explicit deep link is not an agent thread route", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/",
          environmentId: "env",
          threadId: "thread",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("ignores malformed or external links", () => {
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "https://example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/settings" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "//example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/threads/env/thread?x=1" })),
    ).toBeNull();
    expect(extractAgentNotificationDeepLink({})).toBeNull();
  });
});

describe("foregroundNotificationBehavior", () => {
  it("keeps agent alerts quiet while the app is open and shows other notifications", () => {
    const notification = (data: Record<string, unknown>) =>
      responseWithData(data).notification as unknown as Parameters<
        typeof foregroundNotificationBehavior
      >[0];
    expect(
      foregroundNotificationBehavior(
        notification({ environmentId: "env", threadId: "thread", kind: "completed" }),
      ).shouldShowBanner,
    ).toBe(false);
    expect(foregroundNotificationBehavior(notification({})).shouldShowBanner).toBe(true);
  });
});

describe("routeAgentNotificationResponseOnce", () => {
  it("retries a failed initial response and deduplicates it after navigation succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({ deepLink: "/threads/env/thread" }) as NotificationResponse;
    const handledResponseIds = new Set<string>();
    const navigate = vi.fn().mockImplementationOnce(() => {
      throw new Error("navigation not ready");
    });
    const clearLastResponse = vi.fn(() => Promise.resolve());
    const consume = () =>
      consumeLastAgentNotificationResponse({
        getLastResponse: () => Promise.resolve(response),
        clearLastResponse,
        handleResponse: (response) =>
          routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate }),
      });

    await consume();
    expect(handledResponseIds.size).toBe(0);
    expect(clearLastResponse).not.toHaveBeenCalled();

    await consume();
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenLastCalledWith("/threads/env/thread");
    expect(clearLastResponse).toHaveBeenCalledOnce();

    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate });
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("discards malformed destination ids without leaving the response pending", async () => {
    const response = responseWithData({
      environmentId: "env",
      threadId: "\ud800",
    }) as NotificationResponse;
    const handledResponseIds = new Set<string>();
    const navigate = vi.fn();
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: (response) =>
        routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate }),
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(clearLastResponse).toHaveBeenCalledOnce();
    expect(handledResponseIds.has("notification-1")).toBe(true);
  });

  it("does not navigate twice when the initial and listener responses refer to one notification", () => {
    const handledResponseIds = new Set<string>();
    const navigations: Array<string> = [];
    const response = responseWithData({
      environmentId: "env",
      threadId: "thread",
    });

    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });
    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });

    expect(navigations).toEqual(["/threads/env/thread"]);
  });
});

// A relay alert with buttons: its APNs `body` as `content.data`, and the button pressed.
const actionResponse = (actionIdentifier: string, extra: Record<string, unknown> = {}) =>
  responseWithData(
    {
      environmentId: "env",
      threadId: "parent",
      kind: "approval",
      requestId: "request-1",
      requestThreadId: "child",
      ...extra,
    },
    `notification-${actionIdentifier}`,
    {
      actionIdentifier,
      ...(typeof extra.userText === "string" ? { userText: extra.userText } : {}),
    },
  );

describe("extractAgentNotificationAction", () => {
  it("reads the button, the request and the thread that holds it", () => {
    expect(extractAgentNotificationAction(actionResponse("ANKIEL_APPROVE"))).toEqual({
      type: "approve",
      environmentId: "env",
      threadId: "child",
      requestId: "request-1",
      text: "",
    });
    expect(
      extractAgentNotificationAction(
        actionResponse("ANKIEL_REPLY", { requestThreadId: undefined, userText: "  Ship it \n" }),
      ),
    ).toMatchObject({ type: "reply", threadId: "parent", text: "Ship it" });
  });

  it("leaves taps, empty replies and alerts without a request to plain navigation", () => {
    expect(
      extractAgentNotificationAction(actionResponse("expo.modules.notifications.actions.DEFAULT")),
    ).toBeNull();
    expect(extractAgentNotificationAction(actionResponse("ANKIEL_REPLY"))).toBeNull();
    expect(
      extractAgentNotificationAction(actionResponse("ANKIEL_DENY", { requestId: undefined })),
    ).toBeNull();
    expect(extractAgentNotificationAction({ actionIdentifier: "ANKIEL_DENY" })).toBeNull();
  });
});

describe("planAgentNotificationAction", () => {
  const requestId = RuntimeRequestId.make("request-1");
  const action = (type: AgentNotificationAction["type"], text = ""): AgentNotificationAction => ({
    ...extractAgentNotificationAction(actionResponse("ANKIEL_APPROVE"))!,
    type,
    text,
  });
  const approval = (
    overrides: Partial<PendingThreadRequests["approvals"][number]> = {},
  ): PendingThreadRequests => ({
    approvals: [
      {
        requestId,
        requestKind: "command",
        createdAt: "2026-11-26T00:00:00.000Z",
        responseCapability: "live",
        ...overrides,
      },
    ],
    userInputs: [],
  });
  const question = (id: string) => ({
    id,
    header: "Name",
    question: "What should the release be called?",
    options: [],
    multiSelect: false,
  });
  const userInput = (questions: ReadonlyArray<ReturnType<typeof question>>) =>
    ({
      approvals: [],
      userInputs: [
        {
          requestId,
          createdAt: "2026-11-26T00:00:00.000Z",
          questions,
          responseCapability: "live",
          dismissible: false,
        },
      ],
    }) satisfies PendingThreadRequests;
  const plan = (
    next: AgentNotificationAction,
    pending: PendingThreadRequests | null,
    canOperate = true,
  ) => planAgentNotificationAction({ action: next, pending, canOperate });

  it("sends what the card's Allow once, Decline and single answer send, once per button", () => {
    expect(plan(action("approve"), approval())).toEqual({
      type: "approval",
      input: {
        threadId: "child",
        requestId,
        decision: "accept",
        commandId: "notification:approve:request-1",
      },
    });
    expect(plan(action("deny"), approval())).toMatchObject({
      type: "approval",
      input: { decision: "decline", commandId: "notification:deny:request-1" },
    });
    expect(plan(action("reply", "Atlas"), userInput([question("name")]))).toEqual({
      type: "user-input",
      input: {
        threadId: "child",
        requestId,
        answers: { name: "Atlas" },
        commandId: "notification:reply:request-1",
      },
    });
  });

  it("skips requests answered elsewhere or that the button cannot answer", () => {
    const answeredElsewhere: PendingThreadRequests = { approvals: [], userInputs: [] };
    expect(plan(action("approve"), answeredElsewhere).type).toBe("skip");
    expect(plan(action("reply", "Atlas"), answeredElsewhere).type).toBe("skip");
    expect(plan(action("approve"), null).type).toBe("skip");
    expect(plan(action("approve"), approval(), false).type).toBe("skip");
    expect(plan(action("approve"), approval({ responseCapability: "not_resumable" })).type).toBe(
      "skip",
    );
    expect(
      plan(action("deny"), approval({ options: [{ decision: "accept", label: "Allow once" }] }))
        .type,
    ).toBe("skip");
    // The phone's view may be newer than the alert: a second question needs the thread.
    expect(
      plan(action("reply", "Atlas"), userInput([question("name"), question("date")])).type,
    ).toBe("skip");
  });
});

describe("routeAgentNotificationResponseOnce with buttons", () => {
  it("answers once, after the thread opens, however often the response arrives", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = actionResponse("ANKIEL_APPROVE") as unknown as NotificationResponse;
    const handledResponseIds = new Set<string>();
    const navigate = vi.fn().mockImplementationOnce(() => {
      throw new Error("navigation not ready");
    });
    const perform = vi.fn();
    const consume = () =>
      consumeLastAgentNotificationResponse({
        getLastResponse: () => Promise.resolve(response),
        clearLastResponse: () => Promise.resolve(),
        handleResponse: (next) =>
          routeAgentNotificationResponseOnce({
            handledResponseIds,
            response: next,
            navigate,
            perform,
          }),
      });

    await consume();
    expect(perform).not.toHaveBeenCalled();
    await consume();
    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate, perform });

    expect(navigate).toHaveBeenLastCalledWith("/threads/env/parent");
    expect(perform).toHaveBeenCalledOnce();
    expect(perform).toHaveBeenCalledWith(expect.objectContaining({ type: "approve" }));
  });
});
