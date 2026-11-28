// @effect-diagnostics nodeBuiltinImport:off -- A loopback fake of Cursor's backend drives the real SDK.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { InteractionUpdate } from "@cursor/sdk";

import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@ankielcode/contracts";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Stream from "effect/Stream";

import * as TestProviderHost from "@ankielcode/provider-testing/TestProviderHost";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@ankielcode/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";

import { cursorMcpServers, makeCursorAgentOptions, makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

describe("CursorAdapterV2", () => {
  it.effect.each([
    { status: "finished", model: undefined, lateModel: undefined },
    { status: "cancelled", model: "claude-opus-4-6", lateModel: undefined },
    { status: "error", model: "custom-fable", lateModel: undefined },
    { status: "finished", model: undefined, lateModel: "gpt-6-sol" },
    { status: "finished", model: "gpt-6-sol", lateModel: null },
  ] as const)(
    "projects Cursor tasks and unfinished tools: $status, late model $lateModel",
    ({ status, model, lateModel }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cursor-v2-lifecycle-",
        });
        const instanceId = ProviderInstanceId.make("cursor");
        const threadId = ThreadId.make("cursor-lifecycle-thread");
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        yield* mcpSessions.set({
          environmentId: EnvironmentId.make("cursor-lifecycle-environment"),
          threadId,
          providerSessionId: "cursor-lifecycle-session",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer synthetic-cursor-token",
          browserToolsAvailable: true,
        });
        let sentWithMcpOverride = true;
        const modelSelection = { instanceId, model: "composer-2.5" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const adapter = yield* makeCursorAdapterV2({
          instanceId,
          environment: { HOME: workspace },
        }).pipe(
          Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
            assertComplete: Effect.void,
            open: () =>
              Effect.succeed({
                agentId: "native-cursor-lifecycle",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (input) =>
                  Effect.gen(function* () {
                    sentWithMcpOverride = Object.hasOwn(input.options ?? {}, "mcpServers");
                    // Recorded tasks stream partial args before start, then end without completion; live runs cannot force this.
                    const taskToolCall = {
                      type: "task" as const,
                      args: {
                        description: "Review",
                        prompt: "Review the code.",
                        subagentType: { kind: "unspecified" },
                        ...(model === undefined ? {} : { model }),
                        agentId: "cursor-task-agent",
                        mode: "unspecified" as const,
                      },
                    };
                    const updates =
                      lateModel !== undefined
                        ? (["tool-call-started", "tool-call-completed"] as const)
                        : (["partial-tool-call", "tool-call-started"] as const);
                    for (const type of updates) {
                      yield* input.onDelta!({
                        type,
                        modelCallId: "model-call",
                        callId: "task-call",
                        toolCall: {
                          ...taskToolCall,
                          args: {
                            ...taskToolCall.args,
                            ...(type === "tool-call-completed"
                              ? { model: lateModel ?? undefined }
                              : {}),
                          },
                        },
                      });
                    }
                    const readUpdates: ReadonlyArray<InteractionUpdate> = [
                      {
                        type: "tool-call-started",
                        modelCallId: "native-model-call",
                        callId: "read-secret",
                        toolCall: { type: "read", args: { path: "secret.txt" } },
                      },
                      ...(["tool-call-started", "tool-call-completed"] as const).map((type) => ({
                        type,
                        modelCallId: "native-model-call",
                        callId: "read-open",
                        toolCall: {
                          type: "read" as const,
                          args: { path: "open.txt" },
                          ...(type === "tool-call-completed"
                            ? {
                                result: {
                                  status: "success" as const,
                                  value: { fileSize: 3, content: "ok\n", totalLines: 1 },
                                },
                              }
                            : {}),
                        },
                      })),
                      {
                        type: "tool-call-completed",
                        modelCallId: "native-model-call",
                        callId: "shell-exit-1",
                        toolCall: {
                          type: "shell",
                          args: { command: "vp test" },
                          result: {
                            status: "success",
                            value: {
                              exitCode: 1,
                              signal: "",
                              stdout: "",
                              stderr: "1 failed",
                              executionTime: 1,
                            },
                          },
                        },
                      },
                    ];
                    for (const update of readUpdates) {
                      yield* input.onDelta!(update);
                    }
                    return {
                      agentId: "native-cursor-lifecycle",
                      runId: "native-cursor-run",
                      wait: Effect.succeed({
                        id: "native-cursor-run",
                        requestId: "native-request",
                        status,
                        model: { id: "composer-2.5" },
                        durationMs: 1,
                      }),
                      cancel: Effect.void,
                    };
                  }).pipe(Effect.orDie),
              }),
          }),
          Effect.provide(TestProviderHost.layer({ cwd: workspace })),
        );
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-lifecycle-session"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        assert.equal(providerThread.nativeMetadata?.cursorStoreCwd, workspace);
        const now = yield* DateTime.now;
        yield* runtime.startTurn({
          threadId,
          providerThread,
          modelSelection,
          runtimePolicy,
          runId: RunId.make("cursor-lifecycle-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("cursor-lifecycle-attempt"),
          rootNodeId: NodeId.make("cursor-lifecycle-root"),
          appThread: {
            id: threadId,
            projectId: ProjectId.make("cursor-lifecycle-project"),
            createdBy: "user",
            creationSource: "web",
            title: "Cursor lifecycle",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          message: {
            messageId: MessageId.make("cursor-lifecycle-message"),
            createdBy: "user",
            creationSource: "web",
            text: "Review the code.",
            attachments: [],
          },
        });
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        assert.isTrue(sentWithMcpOverride);
        const rows = events.filter((event) => event.type === "subagent.updated");
        assert.equal(rows[0]?.subagent.status, "running");
        assert.equal(rows[0]?.subagent.model, model ?? null);
        assert.equal(rows.at(-1)?.subagent.model, lateModel ?? model ?? null);
        assert.equal(
          rows.at(-1)?.subagent.status,
          lateModel !== undefined
            ? "completed"
            : status === "finished"
              ? "idle"
              : status === "cancelled"
                ? "cancelled"
                : "failed",
        );
        assert.isNotNull(rows.at(-1)?.subagent.completedAt);
        const unfinished =
          status === "finished" ? "interrupted" : status === "error" ? "failed" : "cancelled";
        const finalReads = new Map<string, { status: string; output: unknown; done: boolean }>();
        for (const event of events) {
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.toolName === "Read"
          ) {
            finalReads.set(String(event.turnItem.title), {
              status: event.turnItem.status,
              output: event.turnItem.output,
              done: event.turnItem.completedAt !== null,
            });
          }
        }
        const finalNodes = new Map<string, string>();
        for (const event of events) {
          if (event.type === "node.updated" && event.node.kind === "tool_call") {
            finalNodes.set(String(event.node.nativeItemRef?.nativeId), event.node.status);
          }
        }
        assert.deepEqual(Object.fromEntries(finalReads), {
          "Read secret.txt": { status: unfinished, output: undefined, done: true },
          "Read open.txt": {
            status: "completed",
            output: { fileSize: 3, content: "ok\n", totalLines: 1 },
            done: true,
          },
        });
        assert.deepEqual(Object.fromEntries(finalNodes), {
          "read-secret": unfinished,
          "read-open": "completed",
          "shell-exit-1": "failed",
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
  );

  it.effect.each([
    {
      reason: "the SDK's detailed plan usage limit code",
      wait: Effect.succeed({
        id: "native-cursor-run",
        status: "error" as const,
        error: { message: "You've hit your usage limit", code: "PRO_USER_USAGE_LIMIT" },
      }),
      failure: { class: "usage_limit", message: "You've hit your usage limit" },
    },
    {
      reason: "the error Cursor's run ended with",
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "error" as const,
        error: {
          message: "Model Blocked Please ask your admin to enable access to Claude Fable 5.",
        },
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: {
        class: "provider_error",
        message: "Model Blocked Please ask your admin to enable access to Claude Fable 5.",
      },
    },
    {
      reason: "the SDK rate limit that broke the run",
      wait: Effect.fail(
        new CursorAgentSdk.CursorAgentSdkRunnerError({
          method: "run.wait",
          cause: Object.assign(new Error("Too many requests"), {
            code: "resource_exhausted",
            status: 429,
          }),
        }),
      ),
      failure: {
        class: "usage_limit",
        message:
          "Cursor Agent SDK run.wait failed: Too many requests (resource_exhausted, HTTP 429)",
      },
    },
    {
      reason: "a transport dump sent after earlier commentary",
      updates: [
        { type: "text-delta", text: "Checking the build first." },
        { type: "step-completed", stepId: 1, stepDurationMs: 1 },
        { type: "text-delta", text: "Error: RetriableError: WritableIterable is closed" },
      ] satisfies ReadonlyArray<InteractionUpdate>,
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "finished" as const,
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: {
        class: "transport_error",
        message: "Error: RetriableError: WritableIterable is closed",
      },
    },
    {
      reason: "no failure when Cursor's resume after the turn ended made no progress",
      // Cursor's SDK resumed from an older checkpoint after the answer was
      // delivered, regenerated the closing, then gave up on the run.
      updates: [
        { type: "text-delta", text: "The answer." },
        { type: "turn-ended" },
        { type: "text-delta", text: "A regenerated closing." },
        { type: "turn-ended" },
      ] satisfies ReadonlyArray<InteractionUpdate>,
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "error" as const,
        error: { message: "Agent turn stopped after repeated resume attempts made no progress" },
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: null,
    },
    {
      reason: "the error a continuation after the turn ended stopped with",
      updates: [
        { type: "text-delta", text: "The answer." },
        { type: "turn-ended" },
        { type: "text-delta", text: "Following up on the stop hook." },
      ] satisfies ReadonlyArray<InteractionUpdate>,
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "error" as const,
        error: { message: "Agent turn stopped after repeated resume attempts made no progress" },
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: {
        class: "provider_error",
        message: "Agent turn stopped after repeated resume attempts made no progress",
      },
    },
    {
      reason: "no answer from a resume after the turn ended that made no progress",
      updates: [{ type: "turn-ended" }] satisfies ReadonlyArray<InteractionUpdate>,
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "error" as const,
        error: { message: "Agent turn stopped after repeated resume attempts made no progress" },
        result: "A regenerated closing.",
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: null,
      answers: [],
    },
    {
      reason: "no failure when the connection fails after the turn ended",
      updates: [
        { type: "text-delta", text: "Done." },
        { type: "turn-ended" },
      ] satisfies ReadonlyArray<InteractionUpdate>,
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "error" as const,
        error: { message: "Connection failed repeatedly" },
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: null,
    },
    {
      reason: "a connection failure before the turn ends",
      updates: [
        { type: "text-delta", text: "Working." },
      ] satisfies ReadonlyArray<InteractionUpdate>,
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "error" as const,
        error: { message: "Connection failed repeatedly" },
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: { class: "provider_error", message: "Connection failed repeatedly" },
    },
    {
      reason: "a connection failure during a continuation after the turn ended",
      updates: [
        { type: "text-delta", text: "Done." },
        { type: "turn-ended" },
        { type: "step-started", stepId: 2 },
      ] satisfies ReadonlyArray<InteractionUpdate>,
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "error" as const,
        error: { message: "Connection failed repeatedly" },
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: { class: "provider_error", message: "Connection failed repeatedly" },
    },
    {
      reason: "the token usage Cursor reported",
      // Cursor's inputTokens already include cache reads and writes.
      updates: [
        { type: "text-delta", text: "Done." },
        {
          type: "turn-ended",
          usage: {
            inputTokens: 31_961,
            outputTokens: 181,
            cacheReadTokens: 0,
            cacheWriteTokens: 31_955,
          },
        },
      ] satisfies ReadonlyArray<InteractionUpdate>,
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "finished" as const,
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: null,
      usage: {
        inputTokens: 31_961,
        cachedInputTokens: 0,
        cacheCreationTokens: 31_955,
        outputTokens: 181,
      },
      // The checkpoint holds the context fill; billed input counts every step.
      contextFill: { usedTokens: 8_304, maxTokens: 200_000 },
    },
  ])("ends the turn with $reason", ({ updates = [], wait, failure, answers, usage, contextFill }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cursor-v2-failure-",
      });
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-failure-thread");
      const modelSelection = { instanceId, model: "claude-fable-5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-failure",
              listMessages: Effect.succeed([]),
              readContextUsage: Effect.succeed(contextFill),
              close: Effect.void,
              send: (input) =>
                Effect.gen(function* () {
                  for (const update of updates) {
                    yield* input.onDelta!(update).pipe(Effect.orDie);
                  }
                  return {
                    agentId: "native-cursor-failure",
                    runId: "native-cursor-run",
                    wait,
                    cancel: Effect.void,
                  };
                }),
            }),
        }),
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-failure-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-failure-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-failure-attempt"),
        rootNodeId: NodeId.make("cursor-failure-root"),
        appThread: {
          id: threadId,
          projectId: ProjectId.make("cursor-failure-project"),
          createdBy: "user",
          creationSource: "web",
          title: "Cursor failure",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        message: {
          messageId: MessageId.make("cursor-failure-message"),
          createdBy: "user",
          creationSource: "web",
          text: "hi",
          attachments: [],
        },
      });
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const terminal = events.find((event) => event.type === "turn.terminal");
      assert.equal(terminal?.status, failure === null ? "completed" : "failed");
      assert.equal(terminal?.failure?.class, failure?.class);
      assert.equal(terminal?.failure?.message, failure?.message);
      if (answers !== undefined) {
        assert.deepEqual(
          events.flatMap((event) =>
            event.type === "message.updated" && event.message.role === "assistant"
              ? [event.message.text]
              : [],
          ),
          answers,
        );
      }
      if (usage !== undefined) {
        const completedTurn = events.findLast(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.completedAt !== null,
        );
        assert(completedTurn?.type === "provider_turn.updated");
        assert.deepInclude(completedTurn.providerTurn.turnTokenUsage, usage);
        assert.deepInclude(completedTurn.providerTurn.tokenUsage, contextFill);
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect("fails standalone SDK transport diagnostics and compacts with SDK summarize", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-errors-" });
      const summarizeRequests: Array<boolean> = [];
      let sendCalls = 0;
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-transport-error-thread");
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-error",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.sync(() => {
                  sendCalls += 1;
                  summarizeRequests.push(input.summarize === true);
                  const runId = `native-cursor-run-${sendCalls}`;
                  return {
                    agentId: "native-cursor-error",
                    runId,
                    wait: Effect.succeed({
                      id: runId,
                      requestId: `native-request-${sendCalls}`,
                      status: "finished" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                      result:
                        sendCalls === 1
                          ? "Error: RetriableError: WritableIterable is closed"
                          : "Summary of the conversation so far",
                    }),
                    cancel: Effect.void,
                  };
                }),
            }),
        }),
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-error-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const appThread = {
        id: threadId,
        projectId: ProjectId.make("cursor-error-project"),
        createdBy: "user" as const,
        creationSource: "web" as const,
        title: "Cursor transport failure",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* runtime.startTurn({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-error-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-error-attempt"),
        rootNodeId: NodeId.make("cursor-error-root"),
        appThread,
        message: {
          messageId: MessageId.make("cursor-error-message"),
          createdBy: "user",
          creationSource: "web",
          text: "continue",
          attachments: [],
        },
      });
      const first = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.isTrue(Option.isSome(first));
      if (Option.isSome(first)) {
        assert.equal(first.value.status, "failed");
        assert.equal(first.value.failure?.class, "transport_error");
      }

      assert.isDefined(runtime.compactThread);
      yield* runtime.compactThread!({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-compact-run"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("cursor-compact-attempt"),
        rootNodeId: NodeId.make("cursor-compact-root"),
        appThread,
        message: {
          messageId: MessageId.make("cursor-compact-message"),
          createdBy: "user",
          creationSource: "web",
          text: "ignored by compactThread",
          attachments: [],
        },
      });
      const compactionEvents = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      assert.deepEqual(summarizeRequests, [false, true]);
      assert.notInclude(JSON.stringify(compactionEvents), "Summary of the conversation so far");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it("injects thread-scoped MCP credentials without logging them", () => {
    const threadId = ThreadId.make("thread-cursor-mcp");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-cursor-mcp"),
      threadId,
      providerSessionId: "mcp-session-cursor",
      providerInstanceId: ProviderInstanceId.make("cursor"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-cursor-mcp-token",
      browserToolsAvailable: true,
    };

    assert.deepEqual(cursorMcpServers(mcpSession), {
      "ankiel-code": {
        type: "http",
        url: "http://127.0.0.1:43123/mcp",
        headers: {
          Authorization: "Bearer secret-cursor-mcp-token",
        },
      },
    });

    const options = makeCursorAgentOptions({
      apiKey: "secret-cursor-api-key",
      modelSelection: {
        instanceId: ProviderInstanceId.make("cursor"),
        model: "composer-2.5",
      },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      },
      threadId,
      mcpSession,
      platform: "linux",
    });
    assert.deepEqual(options.mcpServers, cursorMcpServers(mcpSession));

    const logged = JSON.stringify(CursorAgentSdk.loggedCursorAgentOptions(options));
    assert.notInclude(logged, "secret-cursor-api-key");
    assert.notInclude(logged, "secret-cursor-mcp-token");
  });
});
