import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2RuntimeRequest,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@ankielcode/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  thread: null as unknown as Atom.Writable<unknown>,
  send: vi.fn(),
}));
vi.mock(import("../state/threads"), () => ({
  environmentThreads: { stateAtom: () => fixture.thread } as never,
  threadEnvironment: { respondToApproval: "approval", respondToUserInput: "input" } as never,
}));
vi.mock(import("../state/session"), () => ({ readEnvironmentScope: () => true }));
vi.mock(import("@ankielcode/client-runtime/state/runtime"), () => ({
  runAtomCommand: fixture.send as never,
}));

import { answerFromNotification, resolveNotificationButtons } from "./notificationActionRunner";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const requestId = RuntimeRequestId.make("request-1");

const request = (status: OrchestrationV2RuntimeRequest["status"] = "pending") => ({
  id: requestId,
  nodeId: NodeId.make("node-1"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command",
  status,
  responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session-1") },
  createdAt: DateTime.makeUnsafe(1_000),
  resolvedAt: null,
});
// The rules read only the request and its card's type, request id and options.
const live = (requests: ReadonlyArray<ReturnType<typeof request>>) =>
  AsyncResult.success({
    status: "live",
    data: Option.some({
      runtimeRequests: requests,
      turnItems: [{ type: "approval_request", requestId, requestKind: "command" }],
    }),
  });
const loading = AsyncResult.success({ status: "loading", data: Option.none() });

let registry: AtomRegistry.AtomRegistry;
beforeEach(() => {
  vi.useFakeTimers();
  fixture.send.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  fixture.thread = Atom.make<unknown>(loading).pipe(Atom.keepAlive);
  registry = AtomRegistry.make();
});
afterEach(() => {
  registry.dispose();
  vi.useRealTimers();
});

const action = { type: "approve", environmentId, threadId, requestId, text: "" } as const;

it("reads the buttons once the thread syncs, and gives up on a thread that never does", async () => {
  const buttons = resolveNotificationButtons(registry, { environmentId, threadId, requestId });
  registry.set(fixture.thread, live([]));
  registry.set(fixture.thread, live([request()]));
  await expect(buttons).resolves.toBe("approval");

  registry.set(fixture.thread, loading);
  const never = resolveNotificationButtons(registry, { environmentId, threadId, requestId });
  vi.advanceTimersByTime(3_000);
  await expect(never).resolves.toBeNull();
});

it("sends the card's answer once the thread shows the request", async () => {
  const outcome = answerFromNotification(registry, action);
  registry.set(fixture.thread, live([request()]));
  await expect(outcome).resolves.toBe("sent");
  expect(fixture.send).toHaveBeenCalledWith(
    registry,
    "approval",
    {
      environmentId,
      input: {
        threadId,
        requestId,
        decision: "accept",
        commandId: "notification:approve:request-1",
      },
    },
    expect.objectContaining({ reportFailure: false }),
  );
});

it("stays quiet about a request answered elsewhere and reports one it could not send", async () => {
  registry.set(fixture.thread, live([request("resolved")]));
  await expect(answerFromNotification(registry, action)).resolves.toBe("skipped");
  expect(fixture.send).not.toHaveBeenCalled();

  registry.set(fixture.thread, live([request()]));
  fixture.send.mockResolvedValueOnce(AsyncResult.failure(Cause.fail("offline")));
  await expect(answerFromNotification(registry, action)).resolves.toBe("unsent");

  registry.set(fixture.thread, loading);
  const never = answerFromNotification(registry, action);
  vi.advanceTimersByTime(20_000);
  await expect(never).resolves.toBe("unsent");
});
