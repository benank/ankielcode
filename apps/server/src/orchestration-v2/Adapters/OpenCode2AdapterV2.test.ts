import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  type RuntimeRequestId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderReplayEntry,
} from "@ankielcode/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import type * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@ankielcode/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import { OPENCODE_PROVIDER } from "@ankielcode/provider-opencode/testing";
import { openCode2ReplayRuntime } from "./OpenCode2AdapterV2.testkit.ts";
import {
  makeProviderReplayGate,
  type ProviderReplayGate,
} from "@ankielcode/provider-testing/replayGate";

const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";
const WORK = "/work/opencode2";
const instanceId = ProviderInstanceId.make("opencode");
const threadId = ThreadId.make("thread:opencode2-adapter");

const out = (type: string, input?: unknown): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: input === undefined ? { type } : { type, input },
});
const reply = (operation: string, data: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { type: "sdk.response", operation, data },
});
const replyData = (operation: string, data: unknown) => reply(operation, { data });
const event = (
  type: string,
  data: Record<string, unknown>,
  label?: string,
  version = 1,
): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: {
    type: "sdk.event",
    event: {
      id: `evt_${type.replaceAll(".", "")}0000`,
      created: 1,
      type,
      ...(type.startsWith("rpc.") ? { location: { directory: WORK } } : {}),
      data,
      durable: { ...durable.durable, version },
    },
  },
  ...(label === undefined ? {} : { label }),
});
const durable = { durable: { aggregateID: SESSION, seq: 1, version: 1 } };

const mcpRules = [
  { action: "ankiel-code-*", resource: "*", effect: "deny" },
  { action: "ankiel-code-thread_opencode2-adapter_*", resource: "*", effect: "allow" },
];
const ankielRules = [{ action: "*", resource: "*", effect: "allow" }, ...mcpRules];
const TITLE = "Prime check";
const sessionInfo = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION,
  title: TITLE,
  permissions: ankielRules,
  projectID: "global",
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1790656601394, updated: 1790656601394 },
  location: { directory: WORK },
  ...overrides,
});
const modelCatalog = {
  location: { directory: WORK },
  data: [
    {
      id: "big-pickle",
      modelID: "big-pickle",
      providerID: "opencode",
      family: "big-pickle",
      name: "Big Pickle",
      compatibility: { reasoningField: "reasoning_content" },
      package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "public", baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      time: { released: 1760659200000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: "active",
      enabled: true,
      limit: { context: 200000, input: 160000, output: 32000 },
    },
  ],
};

const PROMPT_ID = "msg_0eb735d41001NJee1EvVePJAK5";
const promptAccepted = replyData("session.prompt", {
  id: PROMPT_ID,
  sessionID: SESSION,
  time: { created: 1790656601410 },
  type: "user",
  payload: { text: "hi" },
  delivery: "steer",
});

const emptyShellInventory: ReadonlyArray<ProviderReplayEntry> = [
  out("shell.list", "<any>"),
  reply("shell.list", { location: { directory: WORK }, data: [] }),
];

const noOpenRequests: ReadonlyArray<ProviderReplayEntry> = [
  out("permission.list", { sessionID: SESSION }),
  replyData("permission.list", []),
  out("session.form.list", { sessionID: SESSION }),
  replyData("session.form.list", []),
];

const withInstructions = (
  entries: ReadonlyArray<ProviderReplayEntry>,
): ReadonlyArray<ProviderReplayEntry> => {
  const first = entries.findIndex(
    (entry) =>
      entry.type === "expect_outbound" &&
      typeof entry.frame === "object" &&
      entry.frame !== null &&
      "type" in entry.frame &&
      [
        "session.prompt",
        "session.command",
        "session.compact",
        "command.list",
        "skill.list",
        "rpc.call",
      ].includes(String(entry.frame.type)),
  );
  const after = entries.findIndex(
    (entry, index) =>
      index < first &&
      entry.type === "emit_inbound" &&
      typeof entry.frame === "object" &&
      entry.frame !== null &&
      "operation" in entry.frame &&
      entry.frame.operation === "mcp.add",
  );
  const at = after < 0 ? first : after + 1;
  return first < 0
    ? entries
    : [
        ...entries.slice(0, at),
        out("session.instructions.entry.put", {
          sessionID: SESSION,
          key: "ankiel-code",
          value: "<any>",
        }),
        reply("session.instructions.entry.put", null),
        ...entries.slice(at),
      ];
};

const openCode2ReplayRuntimeWithInstructions = (
  entries: ReadonlyArray<ProviderReplayEntry>,
  options?: { readonly external?: boolean },
) => openCode2ReplayRuntime(withInstructions(entries), options);

const opening: ReadonlyArray<ProviderReplayEntry> = [
  out("event.subscribe"),
  out("model.list", "<any>"),
  reply("model.list", modelCatalog),
];

const bigPickle: ModelSelection = { instanceId, model: "opencode/big-pickle" };
const policy = (runtimeMode: "full-access" | "approval-required" = "full-access") => ({
  runtimeMode,
  interactionMode: "default" as const,
  cwd: WORK,
});

const providerThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make("provider-thread:opencode2-adapter"),
  driver: OPENCODE_PROVIDER,
  providerInstanceId: instanceId,
  providerSessionId: ProviderSessionId.make("provider-session:opencode2-adapter"),
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: SESSION, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});

const turnInput = (
  thread: OrchestrationV2ProviderThread,
  modelSelection: ModelSelection = bigPickle,
  runtimeMode: "full-access" | "approval-required" = "full-access",
) => ({
  appThread: { title: TITLE } as OrchestrationV2AppThread,
  threadId,
  runId: RunId.make("run:opencode2-adapter"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make("attempt:opencode2-adapter"),
  rootNodeId: NodeId.make("node:opencode2-adapter"),
  providerThread: thread,
  message: {
    messageId: MessageId.make("message:opencode2-adapter"),
    text: "hi",
    attachments: [],
    createdBy: "user" as const,
    creationSource: "web" as const,
    scheduledTaskId: undefined,
    senderThreadId: undefined,
  },
  modelSelection,
  runtimePolicy: policy(runtimeMode),
});

const buildPaths = [
  {
    action: "external_directory",
    resource: "/home/.local/share/opencode/tool-output/*",
    effect: "allow",
  },
];
const agentList = {
  location: { directory: WORK },
  data: [
    {
      id: "build",
      name: "Build",
      request: { settings: {}, headers: {}, body: {} },
      description: "The default agent.",
      mode: "primary",
      hidden: false,
      permissions: [{ action: "*", resource: "*", effect: "allow" }, ...buildPaths],
    },
  ],
};
const supervisedRules = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "ask" },
  ...buildPaths,
  ...mcpRules,
];

const shellAsk = {
  data: {
    id: "per_0eb7c4d7e001Pyt8o50Vi4KrOO",
    sessionID: SESSION,
    action: "shell",
    resources: ["echo FIRST"],
    save: ["echo *"],
    source: { type: "tool", messageID: "msg_0eb7c4330001dYFQKuTpfD780v", id: "call_1" },
  },
};
const shellAskEvent = event("permission.asked", shellAsk.data);
const colorForm = {
  id: "frm_0eb79ab35001fkvFECSh3wYNVD",
  sessionID: SESSION,
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    {
      key: "q0",
      title: "Color preference",
      description: "Which color do you prefer?",
      type: "string",
      options: [{ value: "Red", label: "Red" }],
      custom: true,
    },
  ],
};

const resumed = (
  entries: ReadonlyArray<ProviderReplayEntry>,
  options?: {
    readonly version?: "2.2.1" | "2.2.5" | "2.2.6";
    readonly shellRecovery?: ReadonlyArray<ProviderReplayEntry>;
    readonly lastRunOrdinal?: number;
    readonly pendingBackgroundTasks?: OrchestrationV2ProviderThread["pendingBackgroundTasks"];
    readonly goal?: OrchestrationV2ProviderThread["goal"];
    readonly contextUsage?: OrchestrationV2ProviderThread["contextUsage"];
    readonly external?: boolean;
    readonly supervised?: boolean;
    readonly processExit?: Effect.Effect<void>;
    readonly beforeResponse?: (path: string) => Effect.Effect<void>;
    readonly borrowers?: { current: number };
    readonly replayGate?: ProviderReplayGate;
    readonly attachmentsDir?: string;
    readonly resolveExtractedTextPath?: (path: string) => Effect.Effect<string | undefined>;
    readonly fileSystem?: FileSystem.FileSystem;
    readonly onPrompt?: (input: unknown) => void;
  },
) =>
  Effect.gen(function* () {
    const runtime = yield* openCode2ReplayRuntime(
      [
        ...opening,
        out("session.get", { sessionID: SESSION }),
        replyData("session.get", sessionInfo()),
        ...noOpenRequests,
        ...(options?.version === "2.2.5" || options?.version === "2.2.6"
          ? [out("rpc.call", "<any>"), reply("rpc.call", { output: null })]
          : []),
        ...(options?.shellRecovery ??
          (options?.version === undefined
            ? []
            : [
                ...(options.version === "2.2.6"
                  ? [out("job.list", { kind: "shell" }), reply("job.list", { data: [] })]
                  : emptyShellInventory),
              ])),
        ...withInstructions([
          ...(options?.supervised === true
            ? [
                out("agent.list", "<any>"),
                reply("agent.list", agentList),
                out("session.update", { sessionID: SESSION, permissions: supervisedRules }),
                reply("session.update", null),
              ]
            : []),
          ...entries,
        ]),
      ],
      {
        ...(options?.version === undefined ? {} : { version: options.version }),
        ...(options?.borrowers === undefined ? {} : { borrowers: options.borrowers }),
        ...(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
        ...(options?.onPrompt === undefined ? {} : { onPrompt: options.onPrompt }),
        ...(options?.external === undefined ? {} : { external: options.external }),
        ...(options?.processExit === undefined ? {} : { processExit: options.processExit }),
        ...(options?.beforeResponse === undefined
          ? {}
          : { beforeResponse: options.beforeResponse }),
        ...(options?.replayGate === undefined ? {} : { replayGate: options.replayGate }),
        ...(options?.attachmentsDir === undefined
          ? {}
          : { attachmentsDir: options.attachmentsDir }),
        ...(options?.resolveExtractedTextPath === undefined
          ? {}
          : { resolveExtractedTextPath: options.resolveExtractedTextPath }),
      },
    );
    const thread = yield* runtime.resumeThread({
      providerThread: {
        ...providerThread(yield* DateTime.now),
        ...(options?.lastRunOrdinal === undefined
          ? {}
          : { lastRunOrdinal: options.lastRunOrdinal }),
        ...(options?.goal === undefined ? {} : { goal: options.goal }),
        ...(options?.contextUsage === undefined ? {} : { contextUsage: options.contextUsage }),
        ...(options?.pendingBackgroundTasks === undefined
          ? {}
          : { pendingBackgroundTasks: options.pendingBackgroundTasks }),
      },
      threadId,
      modelSelection: bigPickle,
      runtimePolicy: policy(options?.supervised === true ? "approval-required" : "full-access"),
    });
    return { runtime, thread };
  });

const requestOf = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.events.pipe(
    Stream.filter(
      (
        event,
      ): event is Extract<
        ProviderAdapter.ProviderAdapterV2Event,
        { type: "runtime_request.updated" }
      > => event.type === "runtime_request.updated",
    ),
    Stream.map((event) => event.runtimeRequest),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

const terminalOf = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.events.pipe(
    Stream.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
        event.type === "turn.terminal",
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

const history = {
  data: [
    {
      id: "msg_0eb732081001RntUJfRtTXOAjd",
      time: { created: 1790656585885 },
      text: "Think carefully step by step about whether 391 is prime, showing your reasoning, then answer in one short sentence.",
      type: "user",
    },
    {
      id: "msg_0eb7320a9001vve3OV5uNi2HRT",
      time: { created: 1790656585925, streamed: 1790656590719, completed: 1790656590736 },
      type: "assistant",
      agent: "build",
      model: { id: "space-bunny-free", providerID: "opencode", variant: "high" },
      content: [
        { type: "reasoning", text: "Check divisibility up to sqrt(391)." },
        { type: "text", text: "391 is not prime: it's the product 17 × 23." },
      ],
      finish: "stop",
      cost: 0,
      tokens: { input: 8701, output: 113, reasoning: 147, cache: { read: 489, write: 0 } },
    },
    {
      id: "msg_0eb733399001NhwTrB32UU6d6H",
      time: { created: 1790656590745 },
      type: "idle",
      outcome: "succeeded",
    },
  ],
  cursor: {},
};

const nativeGoal = (status: "active" | "paused" | "complete") => ({
  id: "goal-1",
  objective: "Write proof.txt",
  status,
  rounds: 2,
  maxRounds: 100,
  boot: "boot-1",
  updatedAt: 1,
  reason: "Checked proof.txt",
});

it.layer(McpProviderSessions.layer)("OpenCode2 adapter", (it) => {
  it.effect("switches the session's model and variant before a turn that changed them", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.switchModel", {
          sessionID: SESSION,
          model: { providerID: "openrouter", id: "deepseek/deepseek-v4-flash", variant: "high" },
        }),
        reply("session.switchModel", null),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      assert.deepEqual(thread.nativeMetadata?.modelSelection, {
        ...bigPickle,
        options: [{ id: "variant", value: "default" }],
      });
      assert.equal(bigPickle.options, undefined);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(
        turnInput(thread, {
          instanceId,
          model: "openrouter/deepseek/deepseek-v4-flash",
          options: [{ id: "variant", value: "high" }],
        }),
      );
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  it.effect("ends the turn when its terminal event is one this build cannot decode", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.interrupted", { sessionID: SESSION, reason: "budget" }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread));
      assert.equal((yield* Fiber.join(terminal))?.status, "interrupted");
    }),
  );

  it.effect("keeps a turn running through a start event this build cannot decode", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        {
          type: "emit_inbound",
          frame: {
            type: "sdk.event",
            event: {
              id: "evt_executionstartedx",
              created: 1,
              type: "session.execution.started",
              data: { sessionID: SESSION },
              durable: "not-an-envelope",
            },
          },
        },
        event("session.text.started", {
          sessionID: SESSION,
          assistantMessageID: "msg_0eb735d5b001oAFVeY5jz3WD4Z",
          ordinal: 0,
        }),
        event("session.text.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_0eb735d5b001oAFVeY5jz3WD4Z",
          ordinal: 0,
          text: "DONE",
        }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const collected = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const seen = yield* Fiber.join(collected);
      const terminals = seen.filter((event) => event.type === "turn.terminal");
      assert.deepEqual(
        terminals.map((event) => event.type === "turn.terminal" && event.status),
        ["completed"],
      );
      assert.isTrue(
        seen.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.text === "DONE",
        ),
      );
    }),
  );
  const secondTurn = (thread: OrchestrationV2ProviderThread) => ({
    ...turnInput(thread),
    runId: RunId.make("run:opencode2-adapter:2"),
    runOrdinal: 2,
    providerTurnOrdinal: 2,
    attemptId: RunAttemptId.make("attempt:opencode2-adapter:2"),
  });
  const terminals = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime, count: number) =>
    runtime.events.pipe(
      Stream.filter(
        (
          event,
        ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      ),
      Stream.take(count),
      Stream.runCollect,
      Effect.forkScoped,
    );

  it.effect("breaks the thread and forgets it when the session was deleted outside Ankiel", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        reply("session.prompt", {
          status: 404,
          body: {
            _tag: "SessionNotFoundError",
            sessionID: SESSION,
            message: `Session not found: ${SESSION}`,
          },
        }),
      ]);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread)).pipe(Effect.ignore);
      const ended = yield* Fiber.join(terminal);
      assert.equal(ended?.status, "failed");
      assert.equal(ended?.threadDisposition, "broken");
      const again = yield* runtime.startTurn(turnInput(thread)).pipe(Effect.flip);
      assert.equal(again._tag, "ProviderAdapterProtocolError");
      assert.include(again.message, "not registered");
    }),
  );

  it.effect("keeps 'allow this session' in the session's rules, not OpenCode's saved grants", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed(
        [
          out("session.prompt", { sessionID: SESSION, text: "<any>" }),
          promptAccepted,
          shellAskEvent,
          out("session.update", {
            sessionID: SESSION,
            permissions: [
              ...supervisedRules.slice(0, 3),
              { action: "shell", resource: "echo *", effect: "allow" },
              ...supervisedRules.slice(3),
            ],
          }),
          reply("session.update", null),
          out("permission.reply", {
            sessionID: SESSION,
            requestID: shellAsk.data.id,
            decision: "once",
          }),
          reply("permission.reply", null),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ],
        { supervised: true },
      );
      const requested = yield* requestOf(runtime).pipe(Effect.forkScoped);
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
      const request = yield* Fiber.join(requested);
      yield* runtime.respondToRuntimeRequest({
        requestId: request!.id,
        decision: "acceptForSession",
      });
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );
  it.effect("allows a thread's other folders, except ones whose path would match siblings", () =>
    Effect.gen(function* () {
      const permissions = [
        ...supervisedRules.slice(0, 3),
        { action: "external_directory", resource: "/repos/api/*", effect: "allow" },
        ...supervisedRules.slice(3),
      ];
      const runtime = yield* openCode2ReplayRuntime([
        ...opening,
        out("agent.list", "<any>"),
        reply("agent.list", agentList),
        out("session.create", {
          location: { directory: WORK },
          model: { providerID: "opencode", id: "big-pickle" },
          permissions,
        }),
        replyData("session.create", sessionInfo({ permissions })),
      ]);
      const created = yield* runtime.ensureThread({
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: {
          ...policy("approval-required"),
          workspace: { folders: [], extraRoots: ["/repos/api/", "/repos/api?", "/repos/a*"] },
        },
      });
      assert.equal(created.nativeThreadRef?.nativeId, SESSION);
    }),
  );
  const reconnected = (
    active: Record<string, unknown>,
    ended?: "succeeded",
    assistant: Record<string, unknown> = {},
    deliveredSteer?: string,
  ) => [
    { type: "runtime_exit", status: "success" } as const,
    out("event.subscribe"),
    out("session.active"),
    replyData("session.active", active),
    out("message.list", { sessionID: SESSION, order: "desc", limit: "50" }),
    reply("message.list", {
      data: [
        ...(ended === undefined
          ? []
          : [{ id: "msg_idle_gap", time: { created: 3 }, type: "idle", outcome: ended }]),
        {
          id: "msg_assistant_gap",
          time: { created: 2 },
          type: "assistant",
          agent: "build",
          model: { id: "big-pickle", providerID: "opencode", variant: "default" },
          content: [
            { type: "text", text: "Sent while the stream was down." },
            {
              type: "tool",
              id: "call_gap",
              name: "shell",
              executed: true,
              state: {
                status: "completed",
                input: { command: "echo GAP" },
                content: [{ type: "text", text: "GAP" }],
                metadata: {},
              },
              time: { created: 2, ran: 2, completed: 2 },
            },
          ],
          finish: "stop",
          ...assistant,
        },
        ...(deliveredSteer === undefined
          ? []
          : [{ id: deliveredSteer, time: { created: 2 }, text: "steered", type: "user" }]),
        {
          id: "msg_0eb735d41001NJee1EvVePJAK5",
          time: { created: 1 },
          text: "hi",
          type: "user",
        },
      ],
      cursor: {},
    }),
  ];
  const openRequests = (
    permissions: ReadonlyArray<unknown>,
    forms: ReadonlyArray<unknown> = [],
  ): ReadonlyArray<ProviderReplayEntry> => [
    out("permission.list", { sessionID: SESSION }),
    replyData("permission.list", permissions),
    out("session.form.list", { sessionID: SESSION }),
    replyData("session.form.list", forms),
  ];

  const turnItems = (collected: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    collected.flatMap((event) =>
      event.type === "turn_item.updated" ? [`${event.turnItem.type}:${event.turnItem.status}`] : [],
    );

  it.effect.each(["delivered", "pending"] as const)(
    "reconciles a %s steer after reconnect without losing its execution",
    (delivery) =>
      Effect.gen(function* () {
        const steerId = `msg_ankiel_steer_${SESSION}:message:opencode2-adapter:steer`;
        const reconnect = reconnected(
          {},
          "succeeded",
          {},
          delivery === "delivered" ? steerId : undefined,
        );
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
            promptAccepted,
            ...(delivery === "pending"
              ? [
                  event("rpc.opencode.goal.changed", {
                    sessionID: SESSION,
                    goal: nativeGoal("active"),
                  }),
                ]
              : []),
            out("session.prompt", "<any>"),
            replyData("session.prompt", {
              id: steerId,
              sessionID: SESSION,
              time: { created: 2 },
              type: "user",
              payload: { text: "steered" },
              delivery: "steer",
            }),
            ...reconnect.slice(0, 2),
            ...(delivery === "pending"
              ? [out("rpc.call", "<any>"), reply("rpc.call", { output: { unreadable: true } })]
              : []),
            ...(delivery === "pending" ? emptyShellInventory : []),
            ...reconnect.slice(2),
            ...(delivery === "pending"
              ? [
                  event("session.execution.started", { sessionID: SESSION }),
                  event("session.inbox.delivered", { sessionID: SESSION, inboxID: steerId }),
                  event("session.text.ended", {
                    sessionID: SESSION,
                    assistantMessageID: "msg_delayed_steer",
                    ordinal: 0,
                    text: "Steer processed",
                  }),
                  event("session.execution.succeeded", { sessionID: SESSION }),
                ]
              : [event("session.execution.interrupted", { sessionID: SESSION, reason: "user" })]),
          ],
          delivery === "pending" ? { version: "2.2.5" } : undefined,
        );
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turnInput(thread));
        yield* runtime.steerTurn({
          providerThread: thread,
          providerTurnId: yield* providerTurnId,
          threadId,
          runId: turnInput(thread).runId,
          message: {
            ...turnInput(thread).message,
            messageId: MessageId.make("message:opencode2-adapter:steer"),
            text: "steered",
          },
        });
        const collected = yield* Fiber.join(events);
        assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
        if (delivery === "pending")
          assert.isTrue(
            collected.some(
              (e) =>
                e.type === "turn_item.updated" &&
                e.turnItem.type === "assistant_message" &&
                e.turnItem.text === "Steer processed",
            ),
          );
      }),
  );

  it.effect("ends a turn that finished while the stream was down with the server's outcome", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
        promptAccepted,
        event("session.step.started", {
          sessionID: SESSION,
          assistantMessageID: "msg_before_gap",
          agent: "build",
          model: { id: "big-pickle", providerID: "opencode", variant: "default" },
          started: 1,
        }),
        event("session.step.ended", {
          sessionID: SESSION,
          assistantMessageID: "msg_before_gap",
          finish: "tool-calls",
          cost: 0,
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        ...reconnected({}, "succeeded"),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      assert.includeMembers(turnItems(collected), [
        "assistant_message:completed",
        "command_execution:completed",
      ]);
      assert.deepInclude(collected.at(-1), { type: "turn.terminal", status: "completed" });
      // Steps that ended during the gap sent no tokens or models, so both stay incomplete.
      const settled = collected.findLast(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.completedAt !== null,
      );
      const usage =
        settled?.type === "provider_turn.updated" ? settled.providerTurn.turnTokenUsage : undefined;
      assert.deepInclude(usage, { usageStatus: "partial", inputTokens: 100, outputTokens: 10 });
      assert.notProperty(usage, "models");
    }),
  );

  it.effect.each(["lists", "stream"] as const)(
    "restores approvals and questions from %s after slow recovery",
    (source) =>
      Effect.gen(function* () {
        const gate = makeProviderReplayGate(["late-permission"]);
        let holdReads = false;
        const reading = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const requests = yield* Queue.unbounded<RuntimeRequestId>();
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
            promptAccepted,
            ...reconnected({ [SESSION]: { type: "running" } }),
            ...openRequests(
              source === "lists" ? [shellAsk.data] : [],
              source === "lists" ? [colorForm] : [],
            ),
            ...(source === "stream"
              ? [
                  event("permission.asked", shellAsk.data, "late-permission"),
                  event("form.created", { form: colorForm }),
                ]
              : []),
            out("permission.reply", {
              sessionID: SESSION,
              requestID: shellAsk.data.id,
              decision: "once",
            }),
            reply("permission.reply", null),
            out("session.form.reply", {
              sessionID: SESSION,
              formID: colorForm.id,
              answer: { q0: "Red" },
            }),
            reply("session.form.reply", null),
            event("session.execution.succeeded", { sessionID: SESSION }),
          ],
          {
            supervised: true,
            replayGate: gate,
            beforeResponse: (path) =>
              holdReads && path.endsWith(source === "stream" ? "/form" : "/message")
                ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
          },
        );
        const ended = yield* Deferred.make<string>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "pending"
              ) {
                yield* Queue.offer(requests, event.runtimeRequest.id);
              }
              if (event.type === "turn.terminal") {
                yield* Deferred.succeed(ended, event.status);
              }
            }),
          ),
          Effect.forkScoped,
        );
        holdReads = true;
        yield* runtime.startTurn(turnInput(thread, bigPickle, "approval-required"));
        yield* Deferred.await(reading);
        if (source === "stream") {
          yield* Effect.promise(() => gate.waitForReached("late-permission"));
          gate.release("late-permission");
        }
        yield* TestClock.adjust("2 minutes");
        assert.equal(yield* Queue.size(requests), 0);
        yield* Deferred.succeed(resume, undefined);
        yield* runtime.respondToRuntimeRequest({
          requestId: yield* Queue.take(requests),
          decision: "accept",
        });
        yield* runtime.respondToRuntimeRequest({
          requestId: yield* Queue.take(requests),
          answers: { q0: "Red" },
        });
        assert.equal(yield* Deferred.await(ended), "completed");
      }),
  );

  it.effect("continues a reply still streaming at reconnect from the text already shown", () =>
    Effect.gen(function* () {
      const delta = (text: string) =>
        event("session.text.delta", {
          sessionID: SESSION,
          assistantMessageID: "msg_assistant_gap",
          ordinal: 0,
          delta: text,
        });
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, id: PROMPT_ID, text: "<any>" }),
        promptAccepted,
        delta("Sent before the stream dropped"),
        // OpenCode saves a block's text only when the block ends.
        ...reconnected({ [SESSION]: { type: "running" } }, undefined, {
          content: [{ type: "text", text: "" }],
          finish: undefined,
        }),
        ...openRequests([]),
        delta(" and after it came back."),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const texts = collected.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
          ? [event.turnItem.text]
          : [],
      );
      assert.deepEqual(texts, [
        "Sent before the stream dropped",
        "Sent before the stream dropped",
        "Sent before the stream dropped and after it came back.",
        "Sent before the stream dropped and after it came back.",
      ]);
    }),
  );

  it.effect("stores a shell command that exits non-zero as failed", () =>
    Effect.gen(function* () {
      const tool = { sessionID: SESSION, assistantMessageID: "msg_assistant", id: "call-exit" };
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.tool.input.started", { ...tool, name: "shell" }),
        event("session.tool.called", { ...tool, input: { command: "vp test" }, executed: false }),
        {
          type: "emit_inbound",
          frame: {
            type: "sdk.event",
            event: {
              id: "evt_toolsuccess_call-exit",
              created: 1,
              type: "session.tool.success",
              data: {
                ...tool,
                content: [{ type: "text", text: "1 failed\n" }],
                metadata: { status: "completed", truncated: false, exit: 1 },
                executed: false,
              },
              durable: { aggregateID: SESSION, seq: 1, version: 2 },
            },
          },
        },
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      const collected = yield* Fiber.join(events);
      const item = collected
        .flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []))
        .findLast((item) => item.nativeItemRef?.nativeId?.endsWith(tool.id));
      assert.equal(item?.type, "command_execution");
      assert.equal(item?.status, "failed");
      assert.equal(item?.type === "command_execution" ? item.exitCode : null, 1);
      assert.equal(
        collected
          .flatMap((event) => (event.type === "node.updated" ? [event.node] : []))
          .findLast((node) => node.id === item?.nodeId)?.status,
        "failed",
      );
    }),
  );

  it.effect("reads user and assistant text from the session's message list", () =>
    Effect.gen(function* () {
      const runtime = yield* openCode2ReplayRuntimeWithInstructions([
        ...opening,
        out("message.list", { sessionID: SESSION, order: "asc", limit: "100" }),
        reply("message.list", history),
      ]);
      const snapshot = yield* runtime.readThreadSnapshot({
        providerThread: providerThread(yield* DateTime.now),
      });
      assert.deepEqual(
        snapshot.messages.map((message) => [message.role, message.text]),
        [
          ["user", history.data[0]!.text],
          ["assistant", "391 is not prime: it's the product 17 × 23."],
        ],
      );
      assert.equal(
        snapshot.providerThread.nativeConversationHeadRef?.nativeId,
        history.data[0]!.id,
      );
    }),
  );

  it.effect("rejects unreadable rollback history before cutting the native session", () =>
    Effect.gen(function* () {
      const { runtime, thread } = yield* resumed([
        out("message.list", { sessionID: SESSION, limit: "100", type: undefined }),
        reply("message.list", {
          data: [
            { id: "msg_kept", time: { created: 1 }, text: "first", type: "user" },
            {
              id: "msg_compaction",
              time: { created: 2 },
              type: "compaction",
              status: "completed",
              reason: "auto",
              summary: "First turn summary",
              recent: 42,
            },
            { id: "msg_dropped", time: { created: 3 }, text: "second", type: "user" },
          ],
          cursor: {},
        }),
      ]);
      const now = yield* DateTime.now;
      const turns = ["msg_kept", "msg_dropped"].map((nativeId, index) => ({
        id: ProviderTurnId.make(`provider-turn:rollback-history:${index}`),
        providerThreadId: thread.id,
        nodeId: NodeId.make(`node:rollback-history:${index}`),
        runAttemptId: RunAttemptId.make(`attempt:rollback-history:${index}`),
        nativeTurnRef: { driver: OPENCODE_PROVIDER, nativeId, strength: "weak" as const },
        ordinal: index + 1,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      }));
      const failure = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint:rollback-history"),
            appRunOrdinal: 1,
            providerTurn: turns[0]!,
          },
          providerThreadTurns: turns,
        })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterRollbackThreadError");
      assert.include(Cause.pretty(Cause.fail(failure)), '["recent"]');
    }),
  );

  it.effect("prompts under ids no other session on the server can hold", () =>
    Effect.gen(function* () {
      // Separate databases can repeat prompt ids on one server; OpenCode rejects cross-session duplicates with 409.
      const OTHER = "ses_f148ca2deffeOtherSession000";
      const steerInto = (session: string, recorded: string): ReadonlyArray<ProviderReplayEntry> => [
        out("session.prompt", {
          sessionID: session,
          id: recorded,
          text: "<any>",
          delivery: "steer",
        }),
        replyData("session.prompt", {
          id: recorded,
          sessionID: session,
          time: { created: 1790656601500 },
          type: "user",
          payload: { text: "Also say STEERED." },
          delivery: "steer",
        }),
        event("session.inbox.delivered", { sessionID: session, inboxID: recorded }),
        event("session.execution.succeeded", { sessionID: session }),
      ];
      const promptInto = (
        session: string,
        recorded: string,
      ): ReadonlyArray<ProviderReplayEntry> => [
        out("session.prompt", { sessionID: session, id: recorded, text: "<any>" }),
        replyData("session.prompt", {
          id: recorded,
          sessionID: session,
          time: { created: 1790656601410 },
          type: "user",
          payload: { text: "hi" },
          delivery: "steer",
        }),
        event("session.execution.started", { sessionID: session }),
      ];
      const { runtime, thread } = yield* resumed([
        out("session.get", { sessionID: OTHER }),
        replyData("session.get", sessionInfo({ id: OTHER })),
        out("permission.list", { sessionID: OTHER }),
        replyData("permission.list", []),
        out("session.form.list", { sessionID: OTHER }),
        replyData("session.form.list", []),
        ...promptInto(SESSION, "msg_recorded_turn_a"),
        ...steerInto(SESSION, "msg_recorded_steer_a"),
        out("session.instructions.entry.put", {
          sessionID: OTHER,
          key: "ankiel-code",
          value: "<any>",
        }),
        reply("session.instructions.entry.put", null),
        ...promptInto(OTHER, "msg_recorded_turn_b"),
        ...steerInto(OTHER, "msg_recorded_steer_b"),
      ]);
      const other = {
        ...thread,
        id: ProviderThreadId.make("provider-thread:opencode2-adapter:other"),
        nativeThreadRef: {
          driver: OPENCODE_PROVIDER,
          nativeId: OTHER,
          strength: "strong" as const,
        },
      };
      yield* runtime.resumeThread({
        providerThread: other,
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      const ids = yield* IdAllocator.IdAllocatorV2;
      const ended = yield* terminals(runtime, 2);
      for (const [session, providerThread] of [
        [SESSION, thread],
        [OTHER, other],
      ] as const) {
        yield* runtime.startTurn(turnInput(providerThread));
        yield* runtime.steerTurn({
          threadId,
          runId: RunId.make("run:opencode2-adapter"),
          providerThread,
          providerTurnId: ids.derive.providerTurn({
            driver: OPENCODE_PROVIDER,
            nativeTurnId: `${session}:attempt:attempt:opencode2-adapter`,
          }),
          message: {
            ...turnInput(providerThread).message,
            messageId: MessageId.make("message:opencode2-adapter:steer"),
            text: "Also say STEERED.",
          },
        });
      }
      const statuses = [...(yield* Fiber.join(ended))].map((terminal) => terminal.status);
      assert.deepEqual(statuses, ["completed", "completed"]);
    }).pipe(Effect.scoped, Effect.provide(IdAllocator.layer)),
  );

  it.effect("reverts OpenCode at the prompt of the first turn a rollback cuts", () =>
    Effect.gen(function* () {
      const kept = `msg_ankiel_turn_${SESSION}:attempt:opencode2-adapter`;
      const dropped = `msg_ankiel_turn_${SESSION}:attempt:opencode2-adapter:2`;
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("message.list", "<any>"),
        reply("message.list", {
          data: [
            { id: dropped, time: { created: 2 }, text: "second", type: "user" },
            { id: kept, time: { created: 1 }, text: "first", type: "user" },
          ],
          cursor: {},
        }),
        out("session.revert.stage", { sessionID: SESSION, messageID: dropped, files: false }),
        replyData("session.revert.stage", { messageID: dropped, files: [] }),
        out("session.revert.commit", { sessionID: SESSION }),
        reply("session.revert.commit", null),
        out("message.list", "<any>"),
        reply("message.list", {
          data: [{ id: kept, time: { created: 1 }, text: "first", type: "user" }],
          cursor: {},
        }),
      ]);
      const turns: Array<OrchestrationV2ProviderTurn> = [];
      const firstEnded = yield* Deferred.make<void>();
      const bothEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            if (event.type === "provider_turn.updated" && event.providerTurn.status !== "running") {
              turns.push(event.providerTurn);
              if (turns.length === 1) yield* Deferred.succeed(firstEnded, undefined);
              if (turns.length === 2) yield* Deferred.succeed(bothEnded, undefined);
            }
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* runtime.startTurn(turnInput(thread));
      yield* Deferred.await(firstEnded);
      yield* runtime.startTurn(secondTurn(thread));
      yield* Deferred.await(bothEnded);
      const [first, second] = turns;
      yield* runtime.rollbackThread({
        providerThread: thread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint:first"),
          appRunOrdinal: 1,
          providerTurn: first!,
        },
        providerThreadTurns: [first!, second!],
      });
    }),
  );

  it.effect("starts a turn sent during a rollback only once the cut is made", () =>
    Effect.gen(function* () {
      const prompted = `msg_ankiel_turn_${SESSION}:attempt:earlier`;
      const { runtime, thread } = yield* resumed([
        out("message.list", "<any>"),
        reply("message.list", {
          data: [{ id: prompted, time: { created: 1 }, text: "earlier", type: "user" }],
          cursor: {},
        }),
        out("session.revert.stage", { sessionID: SESSION, messageID: prompted, files: false }),
        replyData("session.revert.stage", { messageID: prompted, files: [] }),
        out("session.revert.commit", { sessionID: SESSION }),
        reply("session.revert.commit", null),
        out("message.list", "<any>"),
        reply("message.list", { data: [], cursor: {} }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.succeeded", { sessionID: SESSION }),
      ]);
      const now = yield* DateTime.now;
      const earlier = {
        id: ProviderTurnId.make("provider-turn:earlier"),
        providerThreadId: thread.id,
        nodeId: NodeId.make("node:earlier"),
        runAttemptId: RunAttemptId.make("attempt:earlier"),
        nativeTurnRef: { driver: OPENCODE_PROVIDER, nativeId: prompted, strength: "weak" as const },
        ordinal: 1,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
      };
      const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
      const rollback = yield* runtime
        .rollbackThread({
          providerThread: thread,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint:start"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [earlier],
        })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* runtime.startTurn({ ...turnInput(thread), providerTurnOrdinal: 1 });
      yield* Fiber.join(rollback);
      assert.equal((yield* Fiber.join(terminal))?.status, "completed");
    }),
  );

  // regression: #24549 a Stop whose interrupted event never arrives blocked the next fork
  it.effect("forks a stopped session whose interrupted event never arrived", () =>
    Effect.gen(function* () {
      const FORK = "ses_f1484db83ffeLGtrRCFimo1H0e";
      const { runtime, thread } = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.started", { sessionID: SESSION }),
        out("session.interrupt", { sessionID: SESSION }),
        reply("session.interrupt", { interrupted: true }),
        out("session.active"),
        reply("session.active", { data: {} }),
        out("session.fork", { sessionID: SESSION }),
        replyData("session.fork", sessionInfo({ id: FORK })),
        out("session.update", { sessionID: FORK, permissions: "<any>" }),
        reply("session.update", null),
        out("session.active"),
        reply("session.active", { data: {} }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.interrupted", { sessionID: SESSION }),
        event("session.execution.started", { sessionID: SESSION }),
        event("session.execution.failed", {
          sessionID: SESSION,
          error: { type: "provider", message: "second turn failed" },
        }),
      ]);
      const ended = yield* terminals(runtime, 2);
      yield* runtime.startTurn(turnInput(thread));
      yield* runtime.interruptTurn({
        providerThread: thread,
        providerTurnId: yield* providerTurnId,
      });
      const forked = yield* runtime.forkThread({
        sourceProviderThread: thread,
        targetThreadId: ThreadId.make("thread:opencode2-adapter:fork"),
      });
      assert.equal(forked.nativeThreadRef?.nativeId, FORK);
      // The lost end arriving late must not finish the source's next turn.
      yield* runtime.startTurn(secondTurn(thread));
      const [first, second] = yield* Fiber.join(ended);
      assert.equal(first?.status, "interrupted");
      assert.equal(second?.failure?.message, "second turn failed");
    }),
  );
});

const providerTurnId = Effect.gen(function* () {
  const ids = yield* IdAllocator.IdAllocatorV2;
  return ids.derive.providerTurn({
    driver: OPENCODE_PROVIDER,
    nativeTurnId: `${SESSION}:attempt:attempt:opencode2-adapter`,
  });
}).pipe(Effect.provide(IdAllocator.layer));
