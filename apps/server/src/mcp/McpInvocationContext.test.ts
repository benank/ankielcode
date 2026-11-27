import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@ankielcode/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports other missing capabilities with the neutral error", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "provider-session-1",
    thread: {
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["preview"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireThreadMcpCapability("device").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({
      capability: "device",
      threadId: invocation.thread?.threadId,
    });

    const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
    expect(scope).toBe(invocation);
  });
});

it.effect("refuses thread-owned capabilities to a caller signed in from outside a thread", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "client:session-1",
    thread: undefined,
    client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
    capabilities: new Set(["preview", "orchestration"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({ capability: "preview", environmentId: "environment-1" });
    expect(error.threadId).toBeUndefined();
  });
});

it.effect("lists browser and device tools only to threads granted that access", () => {
  const thread = {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  };
  const scope = (
    capabilities: McpInvocationContext.McpInvocationScope["capabilities"],
  ): McpInvocationContext.McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "provider-session-1",
    thread,
    client: undefined,
    capabilities,
    issuedAt: 1,
  });
  const visible = (invocation: McpInvocationContext.McpInvocationScope) =>
    Effect.sync(() => ({
      preview: McpInvocationContext.hiddenWithoutPreview(),
      device: McpInvocationContext.hiddenWithoutDevice(),
    })).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation));

  return Effect.gen(function* () {
    expect(yield* visible(scope(new Set(["orchestration"])))).toEqual({
      preview: false,
      device: false,
    });
    expect(yield* visible(scope(new Set(["preview"])))).toEqual({ preview: true, device: false });
    expect(yield* visible(scope(new Set(["device"])))).toEqual({ preview: false, device: true });
    expect(
      yield* visible({
        ...scope(new Set(["preview", "device"])),
        thread: undefined,
        requestNamespace: "client:session-1",
        client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
      }),
    ).toEqual({ preview: false, device: false });
  });
});
