import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  MessageId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderOptionSelection,
} from "@ankielcode/contracts";
import { OpenCodeSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderHost from "@ankielcode/provider-core/server/ProviderHost";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@ankielcode/provider-core/server/McpProviderSessions";

import {
  openCodeBoundaryAfterProviderTurn,
  openCodeChildPermissionRules,
  openCodePermissionRules,
  makeOpenCodeAdapterV2,
  OPENCODE_PROVIDER,
} from "./adapter.ts";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";
const OPEN_CODE_TEST_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  serverUrl: "http://test.invalid",
});

function promiseGate<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function asyncEventStream() {
  const values: Array<{ value: unknown; handled: ReturnType<typeof promiseGate<void>> }> = [];
  const waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  let previousHandled: ReturnType<typeof promiseGate<void>> | undefined;
  let closed = false;
  return {
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    },
    push(value: unknown) {
      const handled = promiseGate<void>();
      const waiter = waiters.shift();
      if (waiter) {
        previousHandled = handled;
        waiter({ done: false, value });
      } else values.push({ value, handled });
      return handled.promise;
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            previousHandled?.resolve();
            if (closed) return Promise.resolve({ done: true as const, value: undefined });
            const entry = values.shift();
            if (entry !== undefined) {
              previousHandled = entry.handled;
              return Promise.resolve({ done: false as const, value: entry.value });
            }
            return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

function runtimePolicy(
  runtimeMode: ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"],
  override: Partial<ProviderAdapter.ProviderAdapterV2RuntimePolicy> = {},
): ProviderAdapter.ProviderAdapterV2RuntimePolicy {
  return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
    ...override,
  });
}

function permissionAction(rules: ReturnType<typeof openCodePermissionRules>, permission: string) {
  return rules.findLast((rule) => rule.permission === "*" || rule.permission === permission)
    ?.action;
}

function providerTurn(input: {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId: string | null;
}): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make(input.id),
    providerThreadId: ProviderThreadId.make("provider-thread:opencode-test"),
    nodeId: NodeId.make(`node:${input.id}`),
    runAttemptId: null,
    nativeTurnRef:
      input.nativeId === null
        ? null
        : { driver: OPENCODE_PROVIDER, nativeId: input.nativeId, strength: "weak" },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: null,
    completedAt: null,
  };
}

// Turns reach orchestration only as `provider_turn.updated` events, so tests read them there.
function trackProviderTurns(
  runtime: Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "events">,
) {
  const turns = new Map<string, OrchestrationV2ProviderTurn>();
  const events = runtime.events.pipe(
    Stream.tap((event) =>
      Effect.sync(() => {
        if (event.type === "provider_turn.updated") {
          turns.set(event.providerTurn.id, event.providerTurn);
        }
      }),
    ),
  );
  const awaitTurns = Effect.fnUntraced(function* (
    predicate: (turns: ReadonlyArray<OrchestrationV2ProviderTurn>) => boolean,
  ) {
    const seen = () => [...turns.values()];
    if (!predicate(seen())) {
      yield* events.pipe(
        Stream.takeUntil(() => predicate(seen())),
        Stream.runDrain,
      );
    }
    return seen();
  });
  const awaitLatestTurn = (
    predicate: (turn: OrchestrationV2ProviderTurn) => boolean = () => true,
  ) =>
    awaitTurns((seen) => seen.length > 0 && predicate(seen.at(-1)!)).pipe(
      Effect.map((seen) => seen.at(-1)!),
    );
  return { events, awaitTurns, awaitLatestTurn };
}

const makeOpenCodeRuntimeHarness = Effect.fn("makeOpenCodeRuntimeHarness")(function* (
  suffix: string,
  nativeSessionId: string,
  client: object,
  host: Partial<ProviderHost.ProviderHost["Service"]> = {},
  turnSettings: {
    readonly model?: string;
    readonly exitCode?: Effect.Effect<number>;
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
    readonly interactionMode?: ProviderAdapter.ProviderAdapterV2RuntimePolicy["interactionMode"];
    readonly attachments?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
  } = {},
) {
  const instanceId = ProviderInstanceId.make(`opencode-${suffix}`);
  const threadId = ThreadId.make(`thread-opencode-${suffix}`);
  const modelSelection = {
    instanceId,
    model: turnSettings.model ?? "anthropic/claude-sonnet",
    options: turnSettings.options ?? [],
  };
  const policy = runtimePolicy("full-access", {
    cwd: "/workspace",
    interactionMode: turnSettings.interactionMode ?? "default",
  });
  const adapter = yield* makeOpenCodeAdapterV2({
    instanceId,
    settings: OPEN_CODE_TEST_SETTINGS,
    environment: {},
  }).pipe(
    Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
      connectToOpenCodeServer: () =>
        Effect.succeed({
          url: "http://test.invalid",
          version: "1.14.19",
          external: turnSettings.exitCode === undefined,
          exitCode: turnSettings.exitCode ?? null,
        }),
      createOpenCodeSdkClient: () => client,
    } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
    Effect.provideService(ProviderHost.ProviderHost, {
      paths: { cwd: "/workspace" },
      resolveAttachmentPath: () => null,
      compatibility: () => Effect.undefined,
      ...host,
    } as unknown as ProviderHost.ProviderHost["Service"]),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`session-opencode-${suffix}`),
    modelSelection,
    runtimePolicy: policy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy: policy,
  });
  const now = yield* DateTime.now;
  const startTurn = (
    text = "hello",
    startProviderThread: OrchestrationV2ProviderThread = providerThread,
    turnPolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy = policy,
    resume = false,
    turnKey = suffix,
    continuation?: { model?: string },
  ) =>
    runtime.startTurn({
      appThread: {
        id: threadId,
        projectId: ProjectId.make(`project-opencode-${suffix}`),
        title: suffix,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: policy.interactionMode,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-opencode-${turnKey}`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt-opencode-${turnKey}`),
      rootNodeId: NodeId.make(`node-opencode-${turnKey}`),
      providerThread: startProviderThread,
      ...(resume ? { resume: true as const } : {}),
      message: {
        createdBy: continuation === undefined ? "user" : "agent",
        creationSource: continuation === undefined ? "web" : "provider",
        messageId: MessageId.make(`message-opencode-${turnKey}`),
        text,
        attachments: turnSettings.attachments ?? [],
      },
      modelSelection: { ...modelSelection, model: continuation?.model ?? modelSelection.model },
      runtimePolicy: turnPolicy,
    });
  return {
    ...trackProviderTurns(runtime),
    nativeSessionId,
    now,
    policy,
    providerThread,
    runId: RunId.make(`run-opencode-${suffix}`),
    runtime,
    startTurn,
    threadId,
  };
});

describe("OpenCodeAdapterV2", () => {
  it.effect("cleans abandoned native descendants before registering their root thread", () =>
    Effect.gen(function* () {
      const aborted: string[] = [];
      const harness = yield* makeOpenCodeRuntimeHarness("abandoned-root", "ses_other", {
        event: { subscribe: async () => ({ stream: asyncEventStream().stream }) },
        session: {
          create: async () => ({ data: { id: "ses_other", time: { created: 1, updated: 1 } } }),
          children: async (input: { sessionID: string }) => ({
            data: input.sessionID === "ses_abandoned" ? [{ id: "ses_abandoned_child" }] : [],
          }),
          abort: async (input: { sessionID: string }) => {
            aborted.push(input.sessionID);
            return { data: true };
          },
        },
      });
      yield* harness.runtime.interruptTurn({
        providerThread: {
          ...harness.providerThread,
          nativeThreadRef: {
            driver: OPENCODE_PROVIDER,
            nativeId: "ses_abandoned",
            strength: "strong",
          },
        },
        providerTurnId: ProviderTurnId.make("provider-turn:abandoned"),
        requestRuntimeRestart: true,
      });
      assert.deepEqual(aborted, ["ses_abandoned_child"]);
      // The same runtime session remains usable for another registered thread.
      assert.isTrue(
        Exit.isSuccess(
          yield* harness.runtime
            .interruptTurn({
              providerThread: harness.providerThread,
              providerTurnId: ProviderTurnId.make("provider-turn:none"),
              requestRuntimeRestart: true,
            })
            .pipe(Effect.exit),
        ),
      );
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer))),
  );

  it.effect.each([
    ["empty", "prompt"],
    ["unsupported", "command"],
    ["supported", "command"],
    ["unknown", "prompt"],
    ["failure", "prompt"],
    ["unset", "prompt"],
    ["unset", "resume"],
  ] as const)("normalizes reasoning variants for %s inventory at %s dispatch", ([kind, request]) =>
    Effect.gen(function* () {
      const suffix = `variant-${kind}-${request}`;
      const nativeEvents = asyncEventStream();
      const inputs: Array<Record<string, unknown>> = [];
      let inventoryCalls = 0;
      const receive = async (input: Record<string, unknown>) => {
        inputs.push(input);
        return { data: true };
      };
      const harness = yield* makeOpenCodeRuntimeHarness(
        suffix,
        suffix,
        {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
              return { stream: nativeEvents.stream };
            },
          },
          provider: {
            list: async () => {
              inventoryCalls++;
              if (kind === "failure") throw new Error("inventory unavailable");
              return {
                data: {
                  all: [
                    {
                      id: "opencode",
                      models:
                        kind === "unknown"
                          ? {}
                          : {
                              "big-pickle": {
                                id: "big-pickle",
                                variants:
                                  kind === "supported"
                                    ? { medium: {} }
                                    : kind === "unsupported"
                                      ? { high: {} }
                                      : {},
                              },
                            },
                    },
                  ],
                },
              };
            },
          },
          command: { list: async () => ({ data: [{ name: "review" }] }) },
          session: {
            create: async () => ({ data: { id: suffix, time: { created: 1, updated: 1 } } }),
            promptAsync: receive,
            command: receive,
          },
        },
        {},
        {
          model: "opencode/big-pickle",
          options: [
            ...(kind === "unset" ? [] : [{ id: "variant", value: "medium" }]),
            { id: "agent", value: "plan" },
          ],
        },
      );
      yield* harness.startTurn(
        request === "command" ? "/review staged changes" : request === "resume" ? "" : "hello",
        harness.providerThread,
        harness.policy,
        request === "resume",
      );
      assert.equal(inputs.length, 1);
      const payload = inputs[0]!;
      assert.equal(payload.agent, "plan");
      if (request === "resume") assert.deepEqual(payload.parts, []);
      if (kind === "supported" || kind === "unknown" || kind === "failure") {
        assert.equal(payload.variant, "medium");
      } else {
        assert.equal(Object.hasOwn(payload, "variant"), false);
      }
      if (kind === "unset") assert.equal(inventoryCalls, 0);
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer))),
  );

  it.effect("reuses successful model variants for the session and retries failed inventories", () =>
    Effect.gen(function* () {
      const sessionId = "variant-cache";
      const nativeEvents = asyncEventStream();
      const inputs: Array<Record<string, unknown>> = [];
      let inventoryCalls = 0;
      let variants: Record<string, object> = {};
      const harness = yield* makeOpenCodeRuntimeHarness(
        sessionId,
        sessionId,
        {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
              return { stream: nativeEvents.stream };
            },
          },
          provider: {
            list: async () => {
              inventoryCalls++;
              if (inventoryCalls === 1) throw new Error("inventory unavailable");
              return {
                data: {
                  all: [{ id: "opencode", models: { "big-pickle": { variants } } }],
                },
              };
            },
          },
          session: {
            create: async () => ({ data: { id: sessionId, time: { created: 1, updated: 1 } } }),
            promptAsync: async (input: Record<string, unknown>) => {
              inputs.push(input);
              return { data: true };
            },
          },
        },
        {},
        { model: "opencode/big-pickle", options: [{ id: "variant", value: "medium" }] },
      );
      const submit = Effect.fnUntraced(function* () {
        yield* harness.startTurn();
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.updated",
            properties: {
              sessionID: sessionId,
              info: {
                id: inputs.at(-1)!.messageID,
                sessionID: sessionId,
                role: "user",
                time: { created: 1 },
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          nativeEvents.push({ type: "session.idle", properties: { sessionID: sessionId } }),
        );
        yield* harness.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.take(1),
          Stream.runDrain,
        );
        return inputs.at(-1)!;
      });

      assert.equal((yield* submit()).variant, "medium");
      assert.equal(inventoryCalls, 1);
      assert.isFalse(Object.hasOwn(yield* submit(), "variant"));
      assert.equal(inventoryCalls, 2);
      variants = { medium: {} };
      assert.isFalse(Object.hasOwn(yield* submit(), "variant"));
      assert.equal(inventoryCalls, 2);
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer))),
  );

  it.effect("keeps queued steers behind a cold catalog lookup and cancels them on stop", () =>
    Effect.gen(function* () {
      const sessionId = "catalog-admission";
      const nativeEvents = asyncEventStream();
      const catalogStarted = promiseGate<void>();
      const calls: string[] = [];
      const harness = yield* makeOpenCodeRuntimeHarness(
        sessionId,
        sessionId,
        {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
              return { stream: nativeEvents.stream };
            },
          },
          provider: {
            list: async (_input: unknown, { signal }: { signal: AbortSignal }) => {
              calls.push("catalog");
              catalogStarted.resolve();
              await new Promise<void>((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    calls.push("catalog-aborted");
                    reject(signal.reason);
                  },
                  { once: true },
                );
              });
              return { data: { all: [] } };
            },
          },
          session: {
            create: async () => ({ data: { id: sessionId, time: { created: 1, updated: 1 } } }),
            get: async () => ({ data: { id: sessionId, time: { created: 1, updated: 1 } } }),
            messages: async () => ({ data: [] }),
            children: async () => ({ data: [] }),
            promptAsync: async (_input: unknown, { signal }: { signal: AbortSignal }) => {
              signal.throwIfAborted();
              calls.push("prompt");
              return { data: true };
            },
            abort: async () => {
              calls.push("abort");
              return { data: true };
            },
          },
        },
        {},
        { model: "opencode/big-pickle", options: [{ id: "variant", value: "medium" }] },
      );
      const start = yield* harness.startTurn().pipe(Effect.forkScoped);
      yield* Effect.promise(() => catalogStarted.promise);
      const activeTurn = yield* harness.awaitLatestTurn();
      const steer = (message: string) =>
        harness.runtime
          .steerTurn({
            threadId: harness.threadId,
            runId: harness.runId,
            providerThread: harness.providerThread,
            providerTurnId: activeTurn.id,
            message: {
              messageId: MessageId.make(message),
              text: message,
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
          })
          .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }));
      const firstSteer = yield* steer("first follow-up");
      const secondSteer = yield* steer("second follow-up");
      yield* TestClock.adjust("5 seconds");
      assert.deepEqual(calls, ["catalog"]);

      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: activeTurn.id,
      });
      yield* Fiber.join(start);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(firstSteer)));
      assert.isTrue(Exit.isFailure(yield* Fiber.join(secondSteer)));
      assert.deepEqual(calls, ["catalog", "catalog-aborted", "abort"]);
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer))),
  );

  it.effect.each([
    {
      message: "<none>",
      statusCode: 503,
      responseBody: "<title> Service\n unavailable </title>",
      expected: "Service unavailable (HTTP 503).",
    },
    {
      message: " <NoNe> ",
      statusCode: 502,
      responseBody: "bad gateway",
      expected: "The model provider failed the request (HTTP 502).",
    },
    {
      message: "<none>",
      expected: "The model provider failed the request and did not include an error message.",
    },
    {
      message: "provider says no",
      statusCode: 503,
      responseBody: "<title>Unavailable</title>",
      expected: "provider says no",
    },
    {
      message: "<none>",
      statusCode: 503,
      responseBody: "<title>https://user:secret@example.com/error?token=secret</title>",
      expected: "https://example.com/error (HTTP 503).",
    },
  ])("reports readable and sanitized session and turn failures: $expected", (sample) =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const harness = yield* makeOpenCodeRuntimeHarness("provider-error", "root", {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          promptAsync: async () => ({ data: true }),
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.error",
          properties: { sessionID: "root", error: { name: "APIError", data: sample } },
        }),
      );
      const events = yield* Fiber.join(received);
      const session = events.findLast((event) => event.type === "provider_session.updated");
      const terminal = events.findLast((event) => event.type === "turn.terminal");
      assert.strictEqual(session?.providerSession.lastError, sample.expected);
      assert.strictEqual(terminal?.failure?.message, sample.expected);
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer))),
  );

  it.effect("classifies APIError 429 as a usage limit", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const harness = yield* makeOpenCodeRuntimeHarness("usage-limit", "root", {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          promptAsync: async () => ({ data: true }),
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.error",
          properties: {
            sessionID: "root",
            error: {
              name: "APIError",
              data: {
                message: "Provider rejected request",
                statusCode: 429,
                isRetryable: true,
              },
            },
          },
        }),
      );
      const terminal = (yield* Fiber.join(received)).find(
        (event) => event.type === "turn.terminal",
      );
      assert.equal(terminal?.status, "failed");
      assert.equal(terminal?.failure?.class, "usage_limit");
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer))),
  );

  it.effect("projects OpenCode read output and search titles from native tool calls", () =>
    Effect.gen(function* () {
      const directoryOutput =
        "<path>/workspace/src</path>\n<type>directory</type>\n<entries>\nenv.ts\nlib/\n\n(2 entries)\n</entries>";
      const fileOutput =
        "<path>/workspace/src/env.ts</path>\n<type>file</type>\n<content>\n1: hello\n2: </content> literal\n3: world\n</content>";
      const fileWithInstructions =
        "<path>/workspace/src/env.ts</path>\n<type>file</type>\n<content>1: hello\n\n(End of file - total 1 lines)\n</content>\n\n<system-reminder>\nProject instructions\n</system-reminder>";
      const missingPath = directoryOutput.slice(directoryOutput.indexOf("<type>"));
      const missingClose = fileOutput.slice(0, fileOutput.lastIndexOf("\n</content>"));
      const nativeEvents = asyncEventStream();
      const nativeSessionId = "native-opencode-search";
      const harness = yield* makeOpenCodeRuntimeHarness("search-projection", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        mcp: { status: async () => ({ data: {} }) },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          promptAsync: async () => ({ data: true }),
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.events.pipe(
        Stream.takeUntil(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const toolCalls = [
        ["read", { filePath: "src/env.ts" }, "---\nfile body"],
        ["read", { filePath: "/workspace/src" }, directoryOutput],
        ["read", { filePath: "/workspace/src/env.ts" }, fileOutput],
        ["read", { filePath: "/workspace/src/env.ts" }, fileWithInstructions],
        ["read", { filePath: "/workspace/src" }, missingPath],
        ["read", { filePath: "/workspace/src/env.ts" }, missingClose],
        ["custom_read", { filePath: "/workspace/src" }, directoryOutput],
        ["grep", { pattern: "TODO", path: "apps/web" }, "---\nfile body"],
        ["websearch", { query: "OpenCode documentation" }, "---\nfile body"],
        ["glob", { pattern: "missing", path: "apps/web" }, ""],
        ["codesearch", {}, " \n\t"],
      ] as const;
      for (const [index, [tool, input, output]] of toolCalls.entries()) {
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: `part-${index}`,
                sessionID: nativeSessionId,
                messageID: "assistant-search",
                type: "tool",
                callID: `call-${index}`,
                tool,
                state: {
                  status: "completed",
                  input,
                  output,
                  title: tool,
                  metadata: {},
                  time: { start: 1, end: 2 },
                },
              },
            },
          }),
        );
      }
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.compacted",
          properties: { sessionID: nativeSessionId },
        }),
      );
      const items = (yield* Fiber.join(received)).flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      const reads = items.filter((item) => item.type === "dynamic_tool");
      assert.equal(reads[0]?.title, "Read src/env.ts");
      assert.deepEqual(
        reads.map((item) => ({ toolName: item.toolName, output: item.output })),
        [
          { toolName: "read", output: "---\nfile body" },
          { toolName: "read", output: "env.ts\nlib/\n\n(2 entries)" },
          { toolName: "read", output: "1: hello\n2: </content> literal\n3: world" },
          {
            toolName: "read",
            output:
              "1: hello\n\n(End of file - total 1 lines)\n\n<system-reminder>\nProject instructions\n</system-reminder>",
          },
          { toolName: "read", output: missingPath },
          { toolName: "read", output: missingClose },
          { toolName: "custom_read", output: directoryOutput },
        ],
      );
      const grep = items.find((item) => item.type === "file_search");
      assert.equal(grep?.title, "Searched TODO in web");
      assert.equal(grep?.type === "file_search" ? grep.pattern : null, "TODO");
      assert.deepEqual(grep?.type === "file_search" ? grep.results : null, [
        { fileName: "apps/web", preview: "---\nfile body" },
      ]);
      const webSearch = items.find((item) => item.type === "web_search");
      assert.deepEqual(webSearch?.type === "web_search" ? webSearch.patterns : null, [
        "OpenCode documentation",
      ]);
      assert.deepEqual(webSearch?.type === "web_search" ? webSearch.results : null, [
        { snippet: "---\nfile body" },
      ]);
      const emptyFileSearch = items.find(
        (item) => item.type === "file_search" && item.pattern === "missing",
      );
      assert.ok(emptyFileSearch?.type === "file_search");
      assert.equal(emptyFileSearch.results, undefined);
      const emptyWebSearch = items.find(
        (item) => item.type === "web_search" && item.patterns === undefined,
      );
      assert.ok(emptyWebSearch?.type === "web_search");
      assert.equal(emptyWebSearch.results, undefined);
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer))),
  );

  it.effect("drops cancelled OpenCode todos so a finished list completes", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const nativeSessionId = "native-opencode-todos";
      const harness = yield* makeOpenCodeRuntimeHarness("todos", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        mcp: { status: async () => ({ data: {} }) },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          promptAsync: async () => ({ data: true }),
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.events.pipe(
        Stream.takeUntil((event) => event.type === "plan.updated"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "todo.updated",
          properties: {
            sessionID: nativeSessionId,
            todos: [
              { content: "Write the fix", status: "completed", priority: "high" },
              { content: "Try another approach", status: "cancelled", priority: "low" },
              { content: "Add a test", status: "completed", priority: "medium" },
            ],
          },
        }),
      );
      const plan = (yield* Fiber.join(received)).flatMap((event) =>
        event.type === "plan.updated" ? [event.plan] : [],
      )[0];
      assert.ok(plan?.kind === "todo_list");
      assert.deepEqual(
        plan.steps.map((step) => ({ text: step.text, status: step.status })),
        [
          { text: "Write the fix", status: "completed" },
          { text: "Add a test", status: "completed" },
        ],
      );
      assert.equal(plan.status, "completed");
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer))),
  );

  it("maps runtime modes to safe OpenCode permission rules", () => {
    const approvalRequired = openCodePermissionRules(runtimePolicy("approval-required"));
    assert.equal(permissionAction(approvalRequired, "read"), "allow");
    assert.equal(permissionAction(approvalRequired, "edit"), "ask");
    assert.equal(permissionAction(approvalRequired, "bash"), "ask");
    assert.equal(permissionAction(approvalRequired, "doom_loop"), "ask");
    assert.equal(permissionAction(approvalRequired, "unknown_plugin_tool"), "ask");
    assert.equal(permissionAction(approvalRequired, "question"), "allow");

    const autoAcceptEdits = openCodePermissionRules(runtimePolicy("auto-accept-edits"));
    assert.equal(permissionAction(autoAcceptEdits, "edit"), "allow");
    assert.equal(permissionAction(autoAcceptEdits, "bash"), "ask");

    const fullAccess = openCodePermissionRules(runtimePolicy("full-access"));
    assert.equal(permissionAction(fullAccess, "bash"), "allow");
    assert.equal(permissionAction(fullAccess, "edit"), "allow");
    const fullAccessRulesCopiedToTaskChildren = fullAccess.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    );
    assert.equal(
      permissionAction(fullAccessRulesCopiedToTaskChildren, "external_directory"),
      "allow",
    );

    const granularApproval = openCodePermissionRules(
      runtimePolicy("full-access", {
        approvalPolicy: { granular: { request_permissions: true } },
      }),
    );
    assert.equal(permissionAction(granularApproval, "bash"), "ask");
    assert.equal(permissionAction(granularApproval, "read"), "allow");

    const approvalRequiredWorkspaceWrite = openCodePermissionRules(
      runtimePolicy("approval-required", {
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/opencode-workspace"],
          networkAccess: false,
        },
      }),
    );
    assert.equal(permissionAction(approvalRequiredWorkspaceWrite, "edit"), "ask");

    // A multi-folder thread reaches its other folders, and edits there still ask.
    const multiFolder = openCodePermissionRules(
      runtimePolicy("approval-required", {
        workspace: { folders: [], extraRoots: ["/repos/api/", "/repos/api?", "/repos/a*"] },
      }),
    );
    // A root with a glob character would also match its siblings, so it keeps asking.
    assert.deepEqual(
      multiFolder
        .filter((rule) => rule.permission === "external_directory" && rule.action === "allow")
        .map((rule) => rule.pattern),
      ["/repos/api/*"],
    );
    assert.deepInclude(multiFolder, {
      permission: "external_directory",
      pattern: "/repos/api/*",
      action: "allow",
    });
    assert.equal(permissionAction(multiFolder, "edit"), "ask");
    assert.notDeepInclude(approvalRequired, {
      permission: "external_directory",
      pattern: "/repos/api/*",
      action: "allow",
    });
  });

  it("enforces non-interactive sandbox policy through OpenCode permissions", () => {
    const readOnly = openCodePermissionRules(
      runtimePolicy("full-access", {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );
    assert.equal(permissionAction(readOnly, "read"), "allow");
    assert.equal(permissionAction(readOnly, "edit"), "deny");
    assert.equal(permissionAction(readOnly, "bash"), "deny");
    assert.equal(permissionAction(readOnly, "webfetch"), "deny");
    assert.equal(permissionAction(readOnly, "doom_loop"), "deny");
    assert.equal(permissionAction(readOnly, "unknown_plugin_tool"), "deny");
    assert.equal(permissionAction(readOnly, "external_directory"), "allow");

    const workspaceWrite = openCodePermissionRules(
      runtimePolicy("auto-accept-edits", {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/opencode-workspace"],
          networkAccess: true,
        },
      }),
    );
    assert.equal(permissionAction(workspaceWrite, "edit"), "allow");
    assert.equal(permissionAction(workspaceWrite, "bash"), "deny");
    assert.equal(permissionAction(workspaceWrite, "webfetch"), "allow");
    assert.deepInclude(workspaceWrite, {
      permission: "external_directory",
      pattern: "/tmp/opencode-workspace/*",
      action: "allow",
    });
  });

  it("preserves OpenCode's recursion guard on task-created child sessions", () => {
    const childRules = openCodeChildPermissionRules(runtimePolicy("full-access"), [
      { permission: "task", pattern: "*", action: "deny" },
    ]);

    assert.equal(permissionAction(childRules, "read"), "allow");
    assert.equal(permissionAction(childRules, "bash"), "allow");
    assert.equal(permissionAction(childRules, "task"), "deny");

    const approvalRequiredPolicy = runtimePolicy("approval-required");
    const initialChildRules = openCodePermissionRules(approvalRequiredPolicy).filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    );
    assert.equal(permissionAction(initialChildRules, "bash"), "deny");
    assert.equal(permissionAction(initialChildRules, "edit"), "deny");
    assert.equal(permissionAction(initialChildRules, "unknown_plugin_tool"), "deny");

    const childApprovalRules = openCodeChildPermissionRules(approvalRequiredPolicy, [
      ...initialChildRules,
      { permission: "task", pattern: "*", action: "deny" },
    ]);
    assert.equal(permissionAction(childApprovalRules, "bash"), "ask");
    assert.equal(permissionAction(childApprovalRules, "task"), "deny");

    const fullAccessChildRules = openCodeChildPermissionRules(runtimePolicy("full-access"), [
      { permission: "task", pattern: "*", action: "deny" },
    ]);
    const reappliedRules = openCodeChildPermissionRules(
      approvalRequiredPolicy,
      fullAccessChildRules,
      openCodePermissionRules(runtimePolicy("full-access")),
    );
    assert.equal(permissionAction(reappliedRules, "bash"), "ask");
    assert.equal(permissionAction(reappliedRules, "task"), "deny");
  });

  it("uses the next native user message as the exclusive fork and revert boundary", () => {
    const first = providerTurn({ id: "turn:first", ordinal: 1, nativeId: "msg-user-1" });
    const synthetic = providerTurn({ id: "turn:synthetic", ordinal: 2, nativeId: null });
    const third = providerTurn({ id: "turn:third", ordinal: 3, nativeId: "msg-user-3" });

    assert.equal(
      openCodeBoundaryAfterProviderTurn([third, first, synthetic], first.id),
      "msg-user-3",
    );
    assert.isUndefined(openCodeBoundaryAfterProviderTurn([first, synthetic, third], third.id));
  });
});
