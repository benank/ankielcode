import { historyResponseItems } from "@ankielcode/provider-core/server/handoffBudget";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type ServerProviderModel,
} from "@ankielcode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexError from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";
import * as Scope from "effect/Scope";
import * as HostProcess from "@ankielcode/shared/HostProcess";

import packageJson from "../../../package.json" with { type: "json" };
import * as McpProviderSessions from "@ankielcode/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@ankielcode/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@ankielcode/provider-core/server/ProviderContinuationRequests";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";
const isProviderAdapterEventStreamError = Schema.is(
  ProviderAdapter.ProviderAdapterEventStreamError,
);

describe("CodexAdapterV2 assistant message streaming", () => {
  it.effect("flushes buffered text synchronously before item and turn completion", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "item final" });
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
      });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "turn final" });
      yield* coalescer.flushTurn("turn-1");

      assert.equal(completedText, "item final");
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "message-1", text: "item final", completed: true },
        { turnId: "turn-1", itemId: "message-2", text: "turn final", completed: true },
      ]);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
      assert.equal((yield* Ref.get(updates)).length, 2);
    }),
  );
});

describe("CodexAdapterV2 runtime policy", () => {
  it.effect("derives concrete Codex turn policies from every Ankiel runtime mode", () =>
    Effect.gen(function* () {
      const build = (
        runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
      ) =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: `native-${runtimeMode}`,
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: {
            runtimeMode,
            interactionMode: "default",
            cwd: null,
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
        });

      const approvalRequired = yield* build("approval-required");
      const autoAcceptEdits = yield* build("auto-accept-edits");
      const auto = yield* build("auto");
      const fullAccess = yield* build("full-access");

      assert.equal(approvalRequired.approvalPolicy, "untrusted");
      assert.equal(approvalRequired.approvalsReviewer, "user");
      assert.equal(approvalRequired.sandboxPolicy?.type, "readOnly");
      assert.equal(autoAcceptEdits.approvalPolicy, "on-request");
      assert.equal(autoAcceptEdits.approvalsReviewer, "user");
      assert.equal(autoAcceptEdits.sandboxPolicy?.type, "workspaceWrite");
      assert.equal(auto.approvalPolicy, "on-request");
      assert.equal(auto.approvalsReviewer, "auto_review");
      assert.equal(auto.sandboxPolicy?.type, "workspaceWrite");
      assert.deepEqual(fullAccess.approvalPolicy, {
        granular: {
          mcp_elicitations: true,
          request_permissions: false,
          rules: false,
          sandbox_approval: false,
          skill_approval: false,
        },
      });
      assert.equal(fullAccess.approvalsReviewer, "user");
      assert.equal(fullAccess.sandboxPolicy?.type, "dangerFullAccess");
    }),
  );

  it.effect("grants a multi-folder thread's other folders only to a writable sandbox", () =>
    Effect.gen(function* () {
      const workspace = {
        folders: [{ name: "api", path: "/work/api", isGitRepository: true }],
        extraRoots: ["/work/api"],
      };
      const build = (runtimeMode: "approval-required" | "auto-accept-edits" | "full-access") =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: `native-workspace-${runtimeMode}`,
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: { runtimeMode, interactionMode: "default", cwd: "/work/app", workspace },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          hasAnkielMcp: false,
        });

      const autoAcceptEdits = yield* build("auto-accept-edits");
      assert.deepEqual(autoAcceptEdits.sandboxPolicy, {
        type: "workspaceWrite",
        writableRoots: ["/work/api"],
      });
      assert.deepEqual((yield* build("approval-required")).sandboxPolicy, { type: "readOnly" });
      assert.deepEqual((yield* build("full-access")).sandboxPolicy, { type: "dangerFullAccess" });
      // The folder list reaches the model without Ankiel Code's MCP tools.
      assert.deepEqual(Object.keys(autoAcceptEdits.additionalContext ?? {}), [
        "ankiel_code_workspace",
      ]);
      assert.include(
        autoAcceptEdits.additionalContext?.["ankiel_code_workspace"]?.value,
        "- api (Git repository): /work/api",
      );
    }),
  );
});

describe("CodexAdapterV2 native protocol logging", () => {
  it.effect("logs decoded app-server frames once with credentials redacted", () =>
    Effect.gen(function* () {
      const writes: Array<{
        readonly event: unknown;
        readonly threadId: ThreadId | null;
      }> = [];
      const logger: ProviderEventLoggers.EventNdjsonLogger = {
        filePath: "/tmp/events.log",
        write: (event, threadId) =>
          Effect.sync(() => {
            writes.push({ event, threadId });
          }),
        close: () => Effect.void,
      };
      const threadId = ThreadId.make("thread-1");
      const providerSessionId = ProviderSessionId.make("provider-session-1");
      const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: logger,
        providerSessionId,
      });

      assert.notEqual(protocolLogger, undefined);
      if (protocolLogger === undefined) {
        return;
      }

      const startThread = (requestId: number, appThreadId: string, nativeThreadId: string) =>
        Effect.gen(function* () {
          yield* protocolLogger({
            direction: "outgoing",
            stage: "decoded",
            payload: {
              id: requestId,
              method: "thread/start",
              params: { config: { "shell_environment_policy.set.ANKIEL_THREAD_ID": appThreadId } },
            },
          });
          yield* protocolLogger({
            direction: "incoming",
            stage: "decoded",
            payload: { id: requestId, result: { thread: { id: nativeThreadId } } },
          });
        });
      yield* startThread(1, "thread-1", "native-1");
      yield* startThread(2, "thread-2", "native-2");
      yield* protocolLogger({
        direction: "outgoing",
        stage: "decoded",
        payload: { id: 3, method: "turn/start", params: { threadId: "native-2" } },
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: { id: 3, result: { turn: { id: "turn-2" } } },
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: { id: 4, result: { userAgent: "codex/1.0.0" } },
      });
      assert.deepEqual(
        writes.splice(0).map((write) => write.threadId),
        ["thread-1", "thread-1", "thread-2", "thread-2", "thread-2", "thread-2", null],
      );

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "thread/event",
          params: {
            threadId: "native-1",
            id: "evt-1",
            http_headers: { Authorization: "Bearer secret-codex-token" },
            usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          },
        },
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "raw",
        payload:
          '{"method":"thread/event","params":{"http_headers":{"Authorization":"Bearer secret-codex-token"}}}\n',
      });

      assert.equal(writes.length, 1);
      assert.equal(writes[0]?.threadId, threadId);
      assert.deepEqual(writes[0]?.event, {
        provider: "codex",
        protocol: "codex.app-server",
        kind: "protocol",
        providerSessionId,
        event: {
          direction: "incoming",
          stage: "decoded",
          payload: {
            method: "thread/event",
            params: {
              threadId: "native-1",
              id: "evt-1",
              http_headers: { Authorization: "[REDACTED]" },
              usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
            },
          },
        },
      });
    }),
  );
});

describe("CodexAdapterV2 rollback mapping", () => {
  it.effect("derives native rollback count from durable provider turns", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const providerThreadId = ProviderThreadId.make("provider-thread-codex-rollback");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: ProviderSessionId.make("provider-session-codex-rollback"),
        appThreadId: ThreadId.make("thread-codex-rollback"),
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: "native-thread-codex-rollback",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 3,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const providerTurn = (
        id: string,
        ordinal: number,
        status: OrchestrationV2ProviderTurn["status"],
      ): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(id),
        providerThreadId,
        nodeId: NodeId.make(`node-${id}`),
        runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
        nativeTurnRef: {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: `native-${id}`,
          strength: "strong",
        },
        ordinal,
        status,
        startedAt: now,
        completedAt: status === "running" || status === "pending" ? null : now,
      });
      const firstTurn = providerTurn("provider-turn-first", 1, "completed");
      const secondTurn = providerTurn("provider-turn-second", 2, "completed");
      const runningTurn = providerTurn("provider-turn-running", 3, "running");
      const interruptedTurn = providerTurn("provider-turn-interrupted", 4, "interrupted");
      const goalCommandTurn = {
        ...providerTurn("provider-turn-goal-command", 5, "completed"),
        nativeTurnRef: null,
      };

      const numTurns = yield* CodexAdapterV2.resolveCodexRollbackTurnCount({
        providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-first"),
          appRunOrdinal: 1,
          providerTurn: firstTurn,
        },
        providerThreadTurns: [goalCommandTurn, interruptedTurn, runningTurn, secondTurn, firstTurn],
      });

      assert.equal(numTurns, 2);
    }),
  );
});

describe("CodexAdapterV2 fork boundary", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread-codex-fork-boundary");
  const makeProviderThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
    id: providerThreadId,
    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: ProviderSessionId.make("provider-session-codex-fork-boundary"),
    appThreadId: ThreadId.make("thread-codex-fork-boundary"),
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
      nativeId: "native-thread-codex-fork-boundary",
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  });
  const makeProviderTurn = (
    id: string,
    ordinal: number,
    nativeId: string | null,
    now: DateTime.Utc,
  ): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(id),
    providerThreadId,
    nodeId: NodeId.make(`node-${id}`),
    runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
    nativeTurnRef:
      nativeId === null
        ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
        : { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId, strength: "strong" },
    ordinal,
    status: "completed",
    startedAt: now,
    completedAt: now,
  });

  it.effect("resolves the selected provider turn to an inclusive native fork boundary", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, {
        lastTurnId: "native-turn-first",
        rollbackTurnCount: 0,
      });
    }),
  );
});

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const CHATGPT_SHARING_LIMIT_MESSAGE =
  "stream disconnected before completion: The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.";
const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});
const ANKIEL_THREAD_ENV_KEY = "shell_environment_policy.set.ANKIEL_THREAD_ID";
const threadEnvOf = (params: unknown) =>
  Predicate.hasProperty(params, "config") &&
  Predicate.hasProperty(params.config, ANKIEL_THREAD_ENV_KEY)
    ? params.config[ANKIEL_THREAD_ENV_KEY]
    : undefined;

const CODEX_TEST_THREAD_TITLE = "Codex continuation test";

function makeCodexTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: CODEX_TEST_THREAD_TITLE,
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeCodexTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeCodexTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  };
}

function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}

function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  readonly sentPrompt?: string;
  readonly effort?: string;
  readonly turnPolicy?: Pick<
    typeof CodexClient.V2TurnStartParams.Type,
    "approvalPolicy" | "sandboxPolicy"
  >;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "Ankiel Code", title: "Ankiel Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "Ankiel Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            projectId: null,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.sentPrompt ?? input.prompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          ...input.turnPolicy,
          summary: "auto",
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          collaborationMode: {
            mode: "default",
            settings: {
              model: "gpt-5.4",
              ...(input.effort === undefined ? {} : { reasoning_effort: input.effort }),
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

/**
 * Every turn/start follows a config/read, and a thread's first turn on a connection names it
 * unless the transcript names it itself. A thread start, resume or fork follows a config/read
 * unless it retries a failed request or the transcript reads config itself. Inserts those
 * exchanges and shifts later client ids.
 */
function withConfigReadBeforeTurnStart(
  entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
  threadName = CODEX_TEST_THREAD_TITLE,
): Array<CodexReplay.CodexAppServerReplayEntry> {
  const result: Array<CodexReplay.CodexAppServerReplayEntry> = [];
  let offset = 0;
  let clientIds = new Map<number, number>();
  let namedThreads = new Set<unknown>();
  let transcriptReads = 0;
  let previousOutbound: { readonly method: string; readonly id: number } | undefined;
  let failedMethod: string | undefined;
  for (const entry of entries) {
    const frame = entry.type === "runtime_exit" ? undefined : entry.frame;
    if (!Predicate.isObject(frame) || typeof frame.id !== "number") {
      result.push(entry);
      continue;
    }
    if (entry.type === "expect_outbound" && typeof frame.method === "string") {
      const params = Predicate.isObject(frame.params) ? frame.params : {};
      if (frame.method === "initialize") {
        offset = 0;
        clientIds = new Map();
        namedThreads = new Set();
      }
      if (frame.method === "thread/name/set") namedThreads.add(params.threadId);
      const exchanges: Array<readonly [string, unknown, unknown]> = [];
      const isThreadRequest =
        frame.method === "thread/start" ||
        frame.method === "thread/resume" ||
        frame.method === "thread/fork";
      if (frame.method === "config/read") transcriptReads += 1;
      else if (isThreadRequest && transcriptReads > 0) transcriptReads -= 1;
      else if (
        isThreadRequest &&
        failedMethod !== frame.method &&
        previousOutbound?.method !== "thread/unarchive"
      ) {
        exchanges.push([
          "config/read",
          { ...(params.cwd === undefined ? {} : { cwd: params.cwd }), includeLayers: false },
          { config: {}, origins: {} },
        ]);
      }
      if (frame.method === "turn/start") {
        if (!namedThreads.has(params.threadId)) {
          namedThreads.add(params.threadId);
          exchanges.push(["thread/name/set", { threadId: params.threadId, name: threadName }, {}]);
        }
        exchanges.push([
          "config/read",
          { cwd: params.cwd, includeLayers: false },
          { config: {}, origins: {} },
        ]);
      }
      for (const [method, requestParams, response] of exchanges) {
        const id = frame.id + offset;
        result.push(
          {
            type: "expect_outbound",
            label: method,
            frame: { id, method, params: requestParams },
          },
          { type: "emit_inbound", label: method, frame: { id, result: response } },
        );
        offset += 1;
      }
      previousOutbound = { method: frame.method, id: frame.id };
      failedMethod = undefined;
      clientIds.set(frame.id, frame.id + offset);
      result.push(withReplayRequestId(entry, frame.id + offset));
      continue;
    }
    if (entry.type === "emit_inbound" && frame.id === previousOutbound?.id && "error" in frame) {
      failedMethod = previousOutbound.method;
    }
    const mapped = clientIds.get(frame.id);
    result.push(
      entry.type === "emit_inbound" && frame.method === undefined && mapped !== undefined
        ? withReplayRequestId(entry, mapped)
        : entry,
    );
  }
  return result;
}

function withConfigReads(
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  threadName?: string,
): CodexReplay.CodexAppServerReplayTranscript {
  return { ...transcript, entries: withConfigReadBeforeTurnStart(transcript.entries, threadName) };
}

function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
  };
}

function withReplayRequestId(
  entry: CodexReplay.CodexAppServerReplayEntry,
  id: number,
): CodexReplay.CodexAppServerReplayEntry {
  return entry.type !== "runtime_exit" && Predicate.isObject(entry.frame)
    ? { ...entry, frame: { ...entry.frame, id } }
    : entry;
}

describe("CodexAdapterV2 process exit", () => {
  it.effect.each([
    { exit: "numeric", active: false },
    { exit: "SIGKILL", active: false },
    { exit: "numeric", active: true },
    { exit: "SIGKILL", active: true },
  ] as const)("retires the shared session after $exit (active turn: $active)", ({ exit, active }) =>
    Effect.gen(function* () {
      const scenario = `process-exit-${exit}-${active}`;
      const nativeThreadId = `native-${scenario}`;
      const nativeTurnId = `turn-${scenario}`;
      const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const emit = (frame: unknown) =>
        Queue.offer(input, new TextEncoder().encode(JSON.stringify(frame) + "\n"));
      const outputEnded = yield* Deferred.make<void>();
      const turnStarted = yield* Deferred.make<void>();
      const turnCompleted = yield* Deferred.make<void>();
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const preamble = withConfigReadBeforeTurnStart(
        codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" }),
      );
      const terminationError =
        exit === "numeric"
          ? new CodexError.CodexAppServerProcessExitedError({ code: 17, pid: 52 })
          : new CodexError.CodexAppServerTransportError({
              operation: "read-process-exit-status",
              pid: 52,
              cause: PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "exitCode",
                cause: new Error("Process terminated by SIGKILL"),
              }),
            });
      const client = yield* CodexClient.make(
        Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.fromQueue(input),
          stdout: () =>
            Sink.forEach((chunk: string | Uint8Array) =>
              Effect.gen(function* () {
                const frame = JSON.parse(
                  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
                ) as { readonly id?: number; readonly method: string };
                const response = preamble.find(
                  (entry) =>
                    entry.type === "emit_inbound" &&
                    entry.label === frame.method &&
                    Predicate.isObject(entry.frame) &&
                    "id" in entry.frame,
                );
                if (response?.type === "emit_inbound" && Predicate.isObject(response.frame)) {
                  yield* emit({ ...response.frame, id: frame.id });
                }
              }),
            ).pipe(Sink.ensuring(Deferred.succeed(outputEnded, undefined))),
          stderr: () => Sink.drain,
        }),
        {},
        Effect.succeed(terminationError),
      );
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        clientFactory: { open: () => Effect.succeed(client) },
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ProviderReplayHarness.makeReplayServerConfig(scenario).pipe(
          Effect.orDie,
        ),
      });
      const threadId = ThreadId.make(`thread-${scenario}`);
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`session-${scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const eventReader = yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(
              event.type === "provider_turn.updated" && event.providerTurn.status === "running"
                ? Deferred.succeed(turnStarted, undefined)
                : event.type === "turn.terminal"
                  ? Deferred.succeed(turnCompleted, undefined)
                  : Effect.void,
            ),
          ),
        ),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      yield* runtime.startTurn(
        makeCodexTestTurnInput({
          threadId,
          providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`attempt-${scenario}`),
          text: "work",
        }),
      );
      yield* emit({
        method: "turn/started",
        params: {
          threadId: nativeThreadId,
          turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
        },
      });
      yield* Deferred.await(turnStarted);
      if (!active) {
        yield* emit({
          method: "turn/completed",
          params: {
            threadId: nativeThreadId,
            turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
          },
        });
        yield* Deferred.await(turnCompleted);
        assert.isTrue(
          events.some((event) => event.type === "turn.terminal" && event.status === "completed"),
        );
      }

      yield* Queue.end(input);
      // Output closes only after the protocol records the process termination.
      yield* Deferred.await(outputEnded);
      const rpcError = yield* client.request("thread/list", {}).pipe(Effect.flip);
      assert.strictEqual(rpcError, terminationError);
      // Without the fix the stream never ends, so this waits until the project timeout.
      const readerExit = yield* Fiber.await(eventReader);
      // A failure, not a clean end, carries the Codex error into the session's lastError.
      assert.isTrue(
        Exit.isFailure(readerExit) &&
          isProviderAdapterEventStreamError(Cause.squash(readerExit.cause)),
        "the session manager must receive process death so it can retire the shared process",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );
});

describe("CodexAdapterV2 session initialize", () => {
  const openReplaySession = (
    transcript: CodexReplay.CodexAppServerReplayTranscript,
    beforeEmitInbound?: CodexReplay.CodexAppServerReplayDriver["beforeEmitInbound"],
    compatibility?: CodexAdapterV2.CodexAdapterV2Options["compatibility"],
  ) =>
    Effect.gen(function* () {
      const driver = yield* CodexReplay.makeReplayDriver(
        withConfigReads(transcript),
        beforeEmitInbound === undefined ? {} : { beforeEmitInbound },
      );
      let initializeRequests = 0;
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        ...(compatibility === undefined ? {} : { compatibility }),
        clientFactory: {
          open: (openInput) =>
            Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
              Effect.flatMap((context) =>
                Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
              ),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    request: (method, params) =>
                      Effect.sync(() => {
                        if (method === "initialize") initializeRequests++;
                      }).pipe(Effect.andThen(client.request(method, params))),
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                    providerSessionId: openInput.providerSessionId,
                    cause,
                  }),
              ),
            ),
        },
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ProviderReplayHarness.makeReplayServerConfig(transcript.scenario).pipe(
          Effect.orDie,
        ),
      });
      const runtime = yield* adapter.openSession({
        threadId: ThreadId.make(`thread-${transcript.scenario}`),
        providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      return {
        ensureThread: (threadId: string) =>
          runtime.ensureThread({
            threadId: ThreadId.make(threadId),
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          }),
        initializeRequests: () => initializeRequests,
        runtime,
        events: runtime.events,
      };
    });

  const replayPreamble = (nativeThreadId: string) =>
    codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "unused" });

  it.effect("sends one initialize when two threads start on a fresh session at once", () =>
    Effect.gen(function* () {
      const initializeAwaitingResponse = yield* Deferred.make<void>();
      const releaseInitialize = yield* Deferred.make<void>();
      // Codex rejects a second initialize; the replay permits one handshake.
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({
          scenario: "concurrent-initialize",
          entries: [
            ...replayPreamble("concurrent-first").slice(0, 3),
            ...[2, 3].flatMap((id): Array<CodexReplay.CodexAppServerReplayEntry> => [
              {
                type: "expect_outbound",
                label: "config/read",
                frame: { id, method: "config/read", params: { includeLayers: false } },
              },
              {
                type: "emit_inbound",
                label: "config/read",
                frame: { id, result: { config: {}, origins: {} } },
              },
            ]),
            ...replayPreamble("concurrent-first")
              .slice(3, 5)
              .map((entry) => withReplayRequestId(entry, 4)),
            ...replayPreamble("concurrent-second")
              .slice(3, 5)
              .map((entry) => withReplayRequestId(entry, 5)),
          ],
        }),
        (entry) =>
          entry.label === "initialize"
            ? Deferred.succeed(initializeAwaitingResponse, undefined).pipe(
                Effect.andThen(Deferred.await(releaseInitialize)),
              )
            : Effect.void,
      );

      const first = yield* session
        .ensureThread("thread-concurrent-first")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(initializeAwaitingResponse);
      const second = yield* session
        .ensureThread("thread-concurrent-second")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(releaseInitialize, undefined);

      const providerThreads = [yield* Fiber.join(first), yield* Fiber.join(second)];
      assert.equal(session.initializeRequests(), 1);
      assert.sameMembers(
        providerThreads.map((providerThread) => providerThread.nativeThreadRef?.nativeId),
        ["concurrent-first", "concurrent-second"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );
});

describe("CodexAdapterV2 post-settle continuation", () => {
  // The harness notifies after every recorded event or continuation, so a wait
  // re-checks exactly when the state it reads changes. Subscribing before the
  // first check means a change that lands in between is not lost.
  const makeChangeSignal = Effect.gen(function* () {
    const changes = yield* PubSub.unbounded<void>();
    const until = (predicate: () => boolean): Effect.Effect<void> =>
      Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          while (!predicate()) yield* PubSub.take(subscription);
        }),
      );
    return { notify: PubSub.publish(changes, undefined), until };
  });

  const makeCodexReplayHarness = (
    transcript: CodexReplay.CodexAppServerReplayTranscript,
    onEvent: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<unknown> = () =>
      Effect.void,
    onRequest: (method: string, params: unknown) => Effect.Effect<void> = () => Effect.void,
    readChildMetadata?: Parameters<typeof withCodexReplayChildMetadata>[2],
    beforeEmitInbound?: CodexReplay.CodexAppServerReplayDriver["beforeEmitInbound"],
    onUsageLimits?: CodexAdapterV2.CodexAdapterV2Options["onUsageLimits"],
    promptSuggestions: Effect.Effect<boolean> = Effect.succeed(false),
    onNotification: (method: string) => Effect.Effect<void> = () => Effect.void,
    models?: CodexAdapterV2.CodexAdapterV2Options["models"],
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const serverConfig = yield* ProviderReplayHarness.makeReplayServerConfig(
        transcript.scenario,
      ).pipe(Effect.orDie);
      const changes = yield* makeChangeSignal;
      const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
        [];
      const commandStopWatchers: Array<PortScanner.AgentCommandStopWatcher> = [];
      const driver = yield* CodexReplay.makeReplayDriver(
        withConfigReads(transcript),
        beforeEmitInbound === undefined ? {} : { beforeEmitInbound },
      );
      const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
        open: (openInput) =>
          Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                  providerSessionId: openInput.providerSessionId,
                  cause,
                }),
            ),
            Effect.flatMap((context) =>
              Effect.service(CodexClient.CodexAppServerClient).pipe(
                Effect.map((client) =>
                  withCodexReplayChildMetadata(client, transcript, readChildMetadata),
                ),
                Effect.map(
                  (client) =>
                    ({
                      ...client,
                      request: (method, params) =>
                        onRequest(method, params).pipe(
                          Effect.andThen(client.request(method, params)),
                        ),
                      handleServerNotification: (method, handler) =>
                        client.handleServerNotification(method, (payload) =>
                          onNotification(method).pipe(Effect.andThen(handler(payload))),
                        ),
                      raw: {
                        ...client.raw,
                        request: (method, params) =>
                          onRequest(method, params).pipe(
                            Effect.andThen(client.raw.request(method, params)),
                          ),
                      },
                    }) satisfies CodexClient.CodexAppServerClient["Service"],
                ),
                Effect.provide(context),
              ),
            ),
          ),
      };
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        clientFactory,
        ...(onUsageLimits ? { onUsageLimits } : {}),
        ...(models ? { models } : {}),
        digest: yield* Digest.Digest,
        fileSystem,
        idAllocator,
        serverConfig,
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => {
              continuationRequests.push(request);
            }).pipe(Effect.andThen(changes.notify)),
        },
        watchCommandStops: (watcher) =>
          Effect.sync(() => {
            commandStopWatchers.push(watcher);
          }),
      });
      const threadId = ThreadId.make(`thread-${transcript.scenario}`);
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        promptSuggestions,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const firstTerminal = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "turn.terminal"
                ? Deferred.succeed(firstTerminal, undefined)
                : Effect.void,
            ),
            Effect.andThen(changes.notify),
            Effect.andThen(onEvent(event)),
          ),
        ),
        Effect.forkScoped,
      );
      if (runtime.hasPendingBackgroundWork === undefined) {
        return yield* Effect.die("Codex adapter runtime must expose hasPendingBackgroundWork.");
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const terminalEvents = () =>
        events.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        );
      const subagentUpdates = () =>
        events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "subagent.updated" }
          > => event.type === "subagent.updated",
        );
      return {
        runtime,
        providerThread,
        threadId,
        serverConfig,
        events,
        continuationRequests,
        commandStopWatchers,
        terminalEvents,
        subagentUpdates,
        hasPendingBackgroundWork,
        firstTerminal: Deferred.await(firstTerminal),
        until: changes.until,
        awaitTerminal: (count: number) => changes.until(() => terminalEvents().length >= count),
      };
    });

  it.effect.each(["supported", "unsupported", "invalid"] as const)(
    "delivers native history with %s app-server protocol",
    (response) =>
      Effect.gen(function* () {
        const nativeThreadId = `inject-${response}`;
        const prompt = "Only the current request";
        const history: ProviderAdapter.ProviderAdapterV2HistoricalContext = {
          context: "Historical conversation",
          messages: (["user", "assistant"] as const).map((role) => ({
            role,
            text:
              role === "user"
                ? "Original request\n" + "界".repeat(300)
                : "Partial interrupted work",
            threadId: ThreadId.make("source"),
            runId: RunId.make("source-run"),
            itemId: TurnItemId.make(`source-${role}`),
            providerThreadId: null,
            kind: `${role}_message`,
            status: "interrupted",
          })),
        };
        const items = historyResponseItems(history.messages, history.context);
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "current-turn",
          prompt,
        });
        const transcript = makeCodexReplayTranscript({
          scenario: `inject-${response}`,
          entries: [
            ...preamble.slice(0, -3),
            {
              type: "expect_outbound",
              label: "inject",
              frame: {
                id: 3,
                method: "thread/inject_items",
                params: { threadId: nativeThreadId, items },
              },
            },
            {
              type: "emit_inbound",
              label: "inject-result",
              frame:
                response === "supported"
                  ? { id: 3, result: {} }
                  : {
                      id: 3,
                      error: {
                        code: response === "unsupported" ? -32601 : -32602,
                        message: "Injection rejected",
                      },
                    },
            },
            ...(response === "invalid"
              ? []
              : preamble
                  .slice(-3)
                  .map((entry) =>
                    "frame" in entry && Predicate.isObject(entry.frame) && "id" in entry.frame
                      ? { ...entry, frame: { ...entry.frame, id: 4 } }
                      : entry,
                  )),
          ],
        });
        const requests: string[] = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        const injection = yield* harness.runtime.injectHistory!({
          providerThread: harness.providerThread,
          ...history,
        }).pipe(Effect.result);
        if (response === "invalid") {
          assert.equal(injection._tag, "Failure");
          if (injection._tag === "Failure") {
            assert.equal(injection.failure._tag, "ProviderAdapterProtocolError");
            assert.propertyVal(injection.failure.cause, "code", -32602);
            assert.notProperty(injection.failure, "payload");
          }
          assert.notInclude(requests, "turn/start");
          return;
        }
        assert.equal(injection._tag, "Success");
        if (injection._tag === "Success") assert.equal(injection.success, response === "supported");
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("inject-attempt"),
            text: prompt,
          }),
        );
        assert.equal(requests.filter((method) => method === "turn/start").length, 1);
        assert.isBelow(requests.indexOf("thread/inject_items"), requests.indexOf("turn/start"));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );

  const assistantMessages = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    events.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "message.updated" }> =>
        event.type === "message.updated" && event.message.role === "assistant",
    );

  it.effect("preserves Ankiel context on the wire and restores it after compaction", () =>
    Effect.gen(function* () {
      const nativeThreadId = "context-thread";
      const nativeTurnId = "context-turn";
      // An explicit Standard must reach Codex, or Codex falls back to Daybreak.
      const modelSelection = {
        ...CODEX_TEST_MODEL_SELECTION,
        options: [{ id: "cyberAccessProgram", value: "standard" }],
      };
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId,
        codexInput: [{ type: "text", text: "work" }],
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        modelSelection,
        hasAnkielMcp: true,
        cyberAccess: { defaultProgram: "daybreakBlue" },
      });
      assert.include(
        params.additionalContext?.ankiel_code_orchestration_01?.value ?? "",
        "delegate_task",
      );
      const entries = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" });
      const transcript = makeCodexReplayTranscript({
        scenario: "restore-context",
        entries: [
          ...entries.slice(0, 5),
          {
            type: "expect_outbound",
            label: "context turn",
            frame: { id: 3, method: "turn/start", params },
          },
          ...entries.slice(6),
          {
            type: "emit_inbound",
            label: "compacted",
            frame: {
              method: "item/completed",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                item: { type: "contextCompaction", id: "compact-context" },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "done",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
          {
            type: "expect_outbound",
            label: "restore context",
            frame: {
              id: 4,
              method: "thread/inject_items",
              params: {
                threadId: nativeThreadId,
                items: Object.entries(params.additionalContext ?? {}).map(([key, entry]) => ({
                  type: "message",
                  role: "developer",
                  content: [{ type: "input_text", text: `<${key}>${entry.value}</${key}>` }],
                })),
              },
            },
          },
          { type: "emit_inbound", label: "restored", frame: { id: 4, result: {} } },
        ],
      });
      // Codex queues items injected mid-turn as pending input and samples again.
      const wireOrder: Array<string> = [];
      const restoreRequested = yield* Deferred.make<void>();
      const harness = yield* makeCodexReplayHarness(
        transcript,
        undefined,
        (method) =>
          method === "thread/inject_items"
            ? Effect.sync(() => wireOrder.push(method)).pipe(
                Effect.andThen(Deferred.succeed(restoreRequested, undefined)),
              )
            : Effect.void,
        undefined,
        undefined,
        undefined,
        undefined,
        (method) =>
          Effect.sync(() => {
            if (method === "item/completed" || method === "turn/completed") wireOrder.push(method);
          }),
        Effect.succeed<ReadonlyArray<ServerProviderModel>>([
          {
            slug: modelSelection.model,
            name: modelSelection.model,
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "cyberAccessProgram",
                  label: "Cyber Access",
                  type: "select",
                  options: [
                    { id: "standard", label: "Standard" },
                    { id: "daybreakBlue", label: "Daybreak Blue", isDefault: true },
                  ],
                  currentValue: "daybreakBlue",
                },
              ],
            },
          },
        ]),
      );
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("test"),
        threadId: harness.threadId,
        providerSessionId: "context-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer test",
        browserToolsAvailable: true,
      });
      yield* harness.runtime.startTurn({
        ...makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("context-attempt"),
          text: "work",
        }),
        modelSelection,
      });
      yield* harness.firstTerminal;
      yield* Deferred.await(restoreRequested);
      assert.equal(harness.terminalEvents()[0]?.status, "completed");
      assert.deepEqual(
        wireOrder,
        ["item/completed", "turn/completed", "thread/inject_items"],
        "restored Ankiel context while the compacting native turn was still running",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect("resumes a provider thread without requesting or decoding its history", () =>
    Effect.gen(function* () {
      const scenario = "codex-resume-metadata";
      const nativeThreadId = `native-${scenario}-thread`;
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "unused-turn",
        prompt: "unused-prompt",
      }).slice(0, 5);
      const transcript = makeCodexReplayTranscript({
        scenario,
        entries: [
          ...preamble,
          {
            type: "expect_outbound",
            label: "thread/resume",
            frame: {
              id: 3,
              method: "thread/resume",
              params: {
                threadId: nativeThreadId,
                excludeTurns: true,
                config: CodexAdapterV2.CODEX_THREAD_CONFIG,
              },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/resume",
            frame: { id: 3, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
          },
          {
            type: "expect_outbound",
            label: "thread/resume without an app thread",
            frame: {
              id: 4,
              method: "thread/resume",
              params: {
                threadId: nativeThreadId,
                excludeTurns: true,
                config: CodexAdapterV2.CODEX_THREAD_CONFIG,
              },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/resume without an app thread",
            frame: { id: 4, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
          },
          {
            type: "expect_outbound",
            label: "thread/resume with an explicit app thread",
            frame: {
              id: 5,
              method: "thread/resume",
              params: {
                threadId: nativeThreadId,
                excludeTurns: true,
                config: CodexAdapterV2.CODEX_THREAD_CONFIG,
              },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/resume with an explicit app thread",
            frame: { id: 5, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
          },
        ],
      });
      const resumeThreadEnvs: Array<unknown> = [];
      const startupPhases = yield* Queue.unbounded<string | null>();
      const harness = yield* makeCodexReplayHarness(
        transcript,
        (event) =>
          event.type === "provider_session.updated"
            ? Queue.offer(
                startupPhases,
                event.providerSession.startupPhase === undefined
                  ? null
                  : `${event.providerSession.startupPhase} for ${event.providerSession.startupPhaseThreadId}`,
              )
            : Effect.void,
        (method, params) =>
          Effect.sync(() => {
            if (method === "thread/resume") resumeThreadEnvs.push(threadEnvOf(params));
          }),
      );
      const resumed = yield* harness.runtime.resumeThread({
        providerThread: harness.providerThread,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      yield* harness.runtime.resumeThread({
        providerThread: { ...harness.providerThread, appThreadId: null },
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const explicitThreadId = ThreadId.make(`thread-${scenario}-explicit`);
      yield* harness.runtime.resumeThread({
        threadId: explicitThreadId,
        providerThread: harness.providerThread,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });

      assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
      assert.equal(resumed.status, "idle");
      assert.equal(DateTime.toEpochMillis(resumed.updatedAt), 1782622450000);
      assert.deepEqual(resumeThreadEnvs, [harness.threadId, undefined, explicitThreadId]);
      // Each resume is reported for its thread while Codex loads it; one with no app thread is not.
      assert.deepEqual(Array.from(yield* Queue.takeN(startupPhases, 4)), [
        `resume for ${harness.threadId}`,
        null,
        `resume for ${explicitThreadId}`,
        null,
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect.each(["retry", "failure"] as const)(
    "orders a later provider %s after progress from the same turn",
    (tail) =>
      Effect.gen(function* () {
        const scenario = `codex-provider-later-${tail}`;
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const retryNotice = (message: string) => ({
          type: "emit_inbound" as const,
          label: `error/retry/${message}`,
          frame: {
            method: "error",
            params: {
              threadId: nativeThreadId,
              turnId: nativeTurnId,
              willRetry: true,
              error: {
                message,
                additionalDetails: "The response stream disconnected.",
                codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 529 } },
              },
            },
          },
        });
        const commandItem = (status: "inProgress" | "completed") => ({
          type: "commandExecution",
          id: "command-between-retries",
          command: "pwd",
          cwd: "/workspace",
          processId: "42",
          source: "unifiedExecStartup",
          status,
          commandActions: [{ type: "unknown", command: "pwd" }],
          aggregatedOutput: status === "completed" ? "/workspace\n" : null,
          exitCode: status === "completed" ? 0 : null,
          durationMs: status === "completed" ? 10 : null,
        });
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Run pwd." }),
            retryNotice("Reconnecting... 1/5"),
            {
              type: "emit_inbound",
              label: "item/started",
              frame: {
                method: "item/started",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  startedAtMs: 1782622445000,
                  item: commandItem("inProgress"),
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/completed",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622445010,
                  item: commandItem("completed"),
                },
              },
            },
            ...(tail === "retry" ? [retryNotice("Reconnecting... 1/5")] : []),
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({
                    id: nativeTurnId,
                    status: tail === "retry" ? "completed" : "failed",
                  }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`attempt-${scenario}`),
            text: "Run pwd.",
          }),
        );
        yield* harness.awaitTerminal(1);

        const items = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" ? [event.turnItem] : [],
        );
        const command = items.find((item) => item.type === "command_execution");
        assert.isDefined(command);
        const terminal = harness.terminalEvents()[0];
        const firstRetry = items.find((item) => item.type === "error");
        const latest =
          tail === "retry"
            ? items.findLast((item) => item.type === "error")
            : terminal?.status === "failed"
              ? { id: terminal.failureItemId, ordinal: terminal.failureItemOrdinal }
              : undefined;
        assert.isAbove(latest?.ordinal ?? 0, command?.ordinal ?? Infinity);
        // Stored positions are per row, so the later notice needs its own row to sort after.
        assert.isDefined(latest?.id);
        assert.notStrictEqual(latest?.id, firstRetry?.id);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );

  const finalAnswerTranscript = (
    scenario: string,
    answers: ReadonlyArray<{
      readonly id: string;
      readonly text: string;
      readonly phase?: "commentary" | "partial_answer" | "final_answer" | null;
      readonly omitPhase?: boolean;
      readonly streamed?: boolean;
      readonly completionDelayMs?: number;
    }>,
  ) => {
    const nativeThreadId = `native-${scenario}-thread`;
    const nativeTurnId = `native-${scenario}-turn`;
    const prompt = "Reply with the requested recovery marker.";
    return makeCodexReplayTranscript({
      scenario,
      entries: [
        ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
        ...answers.flatMap(
          (answer, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => {
            const phase = answer.omitPhase
              ? {}
              : { phase: answer.phase === undefined ? ("final_answer" as const) : answer.phase };
            const completed: CodexReplay.CodexAppServerReplayEntry = {
              type: "emit_inbound",
              label: `item/completed/${answer.id}`,
              ...(answer.completionDelayMs === undefined
                ? {}
                : { afterMs: answer.completionDelayMs }),
              frame: {
                method: "item/completed",
                params: {
                  item: {
                    type: "agentMessage",
                    id: answer.id,
                    text: answer.text,
                    ...phase,
                    memoryCitation: null,
                  },
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441000 + index,
                },
              },
            };
            if (!answer.streamed) {
              return [completed];
            }
            return [
              {
                type: "emit_inbound",
                label: `item/started/${answer.id}`,
                frame: {
                  method: "item/started",
                  params: {
                    item: {
                      type: "agentMessage",
                      id: answer.id,
                      text: "",
                      ...phase,
                      memoryCitation: null,
                    },
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    startedAtMs: 1782622440500 + index,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: `item/agentMessage/delta/${answer.id}`,
                frame: {
                  method: "item/agentMessage/delta",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    itemId: answer.id,
                    delta: answer.text,
                  },
                },
              },
              completed,
            ];
          },
        ),
        {
          type: "emit_inbound",
          label: "turn/completed",
          frame: {
            method: "turn/completed",
            params: {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
            },
          },
        },
      ],
    });
  };

  it.effect.each([false, true])(
    "preserves a final answer that repeats a preceding partial answer (streamed: %s)",
    (streamed) =>
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-partial-then-final", [
          {
            id: "status",
            text: "Checking the files",
            phase: "commentary",
            streamed,
          },
          {
            id: "partial",
            text: "CODEX_RECOVERY_OK",
            phase: "partial_answer",
            streamed,
          },
          {
            id: "final",
            text: "CODEX_RECOVERY_OK",
            phase: "final_answer",
            streamed,
          },
        ]);
        const gates = yield* Effect.forEach(["status", "partial", "final"], (id) =>
          Effect.gen(function* () {
            return {
              id,
              ready: yield* Deferred.make<void>(),
              release: yield* Deferred.make<void>(),
            };
          }),
        );
        const harness = yield* makeCodexReplayHarness(
          transcript,
          undefined,
          undefined,
          undefined,
          (entry) => {
            const gate = streamed
              ? gates.find((gate) => entry.label === `item/completed/${gate.id}`)
              : undefined;
            return gate === undefined
              ? Effect.void
              : Deferred.succeed(gate.ready, undefined).pipe(
                  Effect.andThen(Deferred.await(gate.release)),
                );
          },
        );
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-partial-then-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        if (streamed) {
          for (const gate of gates) {
            yield* Deferred.await(gate.ready);
            yield* TestClock.adjust("50 millis");
            yield* harness.until(() =>
              harness.events.some(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "assistant_message" &&
                  event.turnItem.nativeItemRef?.nativeId === gate.id &&
                  event.turnItem.streaming,
              ),
            );
            yield* Deferred.succeed(gate.release, undefined);
          }
        }
        yield* harness.awaitTerminal(1);
        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["Checking the files", "CODEX_RECOVERY_OK", "CODEX_RECOVERY_OK"],
        );
        const updates = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? [event.turnItem]
            : [],
        );
        for (const [text, phase] of [
          ["Checking the files", "commentary"],
          ["CODEX_RECOVERY_OK", "partial_answer"],
          ["CODEX_RECOVERY_OK", "final_answer"],
        ]) {
          const matching = updates.filter((item) => item.text === text && item.phase === phase);
          assert.isTrue(matching.some((item) => !item.streaming));
          if (streamed) assert.isTrue(matching.some((item) => item.streaming));
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );

  it.effect("suppresses a trailing empty final answer after a non-empty final answer", () =>
    Effect.gen(function* () {
      const transcript = finalAnswerTranscript("codex-redundant-empty-final", [
        { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
        { id: "answer-empty", text: "" },
      ]);
      const harness = yield* makeCodexReplayHarness(transcript);
      const now = yield* DateTime.now;

      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-codex-redundant-empty-final"),
          text: "Reply with the requested recovery marker.",
        }),
      );
      yield* harness.awaitTerminal(1);

      assert.deepEqual(
        assistantMessages(harness.events).map((event) => event.message.text),
        ["CODEX_RECOVERY_OK"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect.each([
    // regression: #27773 a first-request 429 only notifies the reset-less premium limit
    {
      name: "first-request-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "newer-reset-during-read",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "replacement",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "provider_error",
    },
    {
      name: "late-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "matching-details",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "usage_limit",
    },
    {
      name: "deferred-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    { name: "retry", code: "usageLimitExceeded", notification: true, expectedClass: "usage_limit" },
    // A proxy such as CLIProxyAPI strips the snapshot, so only the error text carries the reset.
    {
      name: "message-reset",
      code: "usageLimitExceeded",
      message:
        "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Nov 11th, 2033 3:37 PM.",
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "exhausted-429",
      code: "responseTooManyFailedAttempts",
      errorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "exhausted-500",
      code: "responseTooManyFailedAttempts",
      errorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 500 } },
      notification: false,
      expectedClass: "provider_error",
    },
    ...([false, true] as const).map(
      (notification) =>
        ({
          name: `disconnected-${notification ? "notification" : "completion"}`,
          code: "responseStreamDisconnected",
          errorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
          notification,
          expectedClass: "transport_error",
        }) as const,
    ),
    {
      name: "connection-failed",
      code: "responseStreamConnectionFailed",
      errorInfo: { responseStreamConnectionFailed: { httpStatusCode: null } },
      notification: false,
      expectedClass: "transport_error",
    },
    {
      name: "http-connection-failed",
      code: "httpConnectionFailed",
      errorInfo: { httpConnectionFailed: { httpStatusCode: null } },
      notification: false,
      expectedClass: "transport_error",
    },
    {
      name: "http-provider-failure",
      code: "httpConnectionFailed",
      errorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
      notification: false,
      expectedClass: "provider_error",
    },
    {
      name: "chatgpt-workspace-limit",
      code: "other",
      details: "subscription_sharing_workplace_individual_usage_limit_exceeded",
      notification: true,
      usedBefore: 100,
      expectedClass: "usage_limit",
      expectedCode: "subscription_sharing_workplace_individual_usage_limit_exceeded",
      expectedMessage: "workspace admin",
    },
    // regression: #25333 ChatGPT sharing limit prose classifies as a usage limit
    {
      name: "chatgpt-sharing-prose-retry",
      code: "responseStreamDisconnected",
      errorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      message: CHATGPT_SHARING_LIMIT_MESSAGE,
      notification: true,
      willRetry: true,
      usedBefore: 100,
      expectedClass: "usage_limit",
      expectedCode: "subscription_sharing_usage_limit_exceeded",
      expectedMessage: "Usage settings",
    },
    {
      name: "chatgpt-sharing-prose",
      code: "responseStreamDisconnected",
      errorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      message: CHATGPT_SHARING_LIMIT_MESSAGE,
      notification: false,
      resetAfter: true,
      expectedClass: "usage_limit",
      expectedCode: "subscription_sharing_usage_limit_exceeded",
      expectedMessage: "Usage settings",
    },
    {
      name: "invalid-encrypted-history",
      code: "other",
      message: JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "invalid_encrypted_content",
          message: "Encrypted content could not be decrypted or parsed.",
        },
        headers: { "x-codex-turn-state": "dummy-sensitive" },
        status: 400,
      }),
      notification: true,
      expectedClass: "provider_error",
      expectedCode: "invalid_encrypted_content",
      expectedMessage: "encrypted conversation history",
    },
    {
      name: "terminal-disconnection",
      code: "responseStreamDisconnected",
      notification: false,
      terminalMessage: "Connection lost.",
      terminalErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      expectedClass: "transport_error",
    },
    {
      name: "sharing-code-mention-retry",
      code: "responseStreamDisconnected",
      errorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      message: "Transport unavailable; this is not subscription_sharing_usage_limit_exceeded.",
      notification: true,
      willRetry: true,
      expectedClass: "transport_error",
    },
    ...(
      [
        {
          name: "generic-disconnection",
          status: null,
          terminalMessage: "Connection lost.",
          expectedClass: "transport_error",
        },
        {
          name: "generic-replacement",
          status: null,
          terminalMessage: "A different failure.",
          expectedClass: "provider_error",
        },
        {
          name: "generic-http-status",
          status: 503,
          terminalMessage: "Connection lost.",
          expectedClass: "provider_error",
        },
        {
          name: "generic-truncated-replacement",
          status: null,
          details: `${"Connection lost. ".repeat(300)}Network cause.`,
          terminalMessage: `${"Connection lost. ".repeat(300)}Different cause.`,
          expectedClass: "provider_error",
        },
        {
          name: "generic-terminal-status",
          status: null,
          terminalMessage: "Connection lost.",
          terminalErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
          expectedClass: "provider_error",
        },
        {
          name: "generic-exhaustion",
          status: null,
          terminalMessage: "Connection lost.",
          terminalErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: null } },
          completionErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: null } },
          expectedClass: "transport_error",
        },
        {
          name: "generic-blank-details",
          status: null,
          details: " ",
          terminalMessage: "Provider stopped this request.",
          expectedClass: "transport_error",
        },
        {
          name: "generic-exhaustion-status",
          status: null,
          terminalMessage: "Connection lost.",
          terminalErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } },
          completionErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: null } },
          expectedClass: "provider_error",
        },
      ] as const
    ).map((scenario) => ({
      ...scenario,
      code: "responseStreamDisconnected" as const,
      errorInfo: { responseStreamDisconnected: { httpStatusCode: scenario.status } },
      notification: true,
      details: "details" in scenario ? scenario.details : "Connection lost.",
    })),
  ] as const)("classifies Codex terminal failures from $name evidence", (scenario) =>
    Effect.gen(function* () {
      const nativeThreadId = `native-limit-${scenario.name}`;
      const nativeTurnId = `turn-limit-${scenario.name}`;
      const message = "message" in scenario ? scenario.message : "Provider stopped this request.";
      const errorInfo = "errorInfo" in scenario ? scenario.errorInfo : scenario.code;
      const resetAt = "2033-05-19T07:20:00.000Z";
      const snapshot = {
        type: "emit_inbound" as const,
        label: "account/rateLimits/updated",
        frame: {
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent: 100, resetsAt: 2000100000, windowDurationMins: 300 },
            },
          },
        },
      };
      const readsReset =
        scenario.name === "first-request-reset" || scenario.name === "newer-reset-during-read";
      // Usage limits with no known reset read the account before publishing their terminal.
      const readsAccount =
        scenario.expectedClass === "usage_limit" &&
        !("expectedCode" in scenario) &&
        scenario.name !== "deferred-reset";
      const premium = {
        ...snapshot,
        frame: {
          method: "account/rateLimits/updated",
          params: { rateLimits: { limitId: "premium", primary: null, secondary: null } },
        },
      };
      const newerSnapshot = {
        ...snapshot,
        frame: {
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent: 100, resetsAt: 2000200000, windowDurationMins: 300 },
            },
          },
        },
      };
      const readRequest = {
        type: "expect_outbound" as const,
        label: "account/rateLimits/read",
        frame: { id: 4, method: "account/rateLimits/read", params: null },
      };
      const transcript = makeCodexReplayTranscript({
        scenario: `codex-limit-${scenario.name}`,
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Continue." }),
          ...("usedBefore" in scenario
            ? [
                {
                  ...snapshot,
                  frame: {
                    method: "account/rateLimits/updated",
                    params: {
                      rateLimits: {
                        limitId: "codex",
                        primary: {
                          usedPercent: scenario.usedBefore,
                          resetsAt: 2000100000,
                          windowDurationMins: 300,
                        },
                      },
                    },
                  },
                },
              ]
            : []),
          ...(readsReset ? [premium] : []),
          ...(scenario.name === "deferred-reset" ? [snapshot] : []),
          ...(scenario.name === "deferred-reset"
            ? [
                {
                  type: "emit_inbound" as const,
                  label: "item/completed/subAgentActivity-started",
                  frame: {
                    method: "item/completed",
                    params: {
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      item: {
                        type: "subAgentActivity",
                        id: "limit-child-spawn",
                        kind: "started",
                        agentThreadId: "native-limit-child",
                        agentPath: "/root/limit_child",
                      },
                    },
                  },
                },
                {
                  type: "emit_inbound" as const,
                  label: "turn/started/child",
                  frame: {
                    method: "turn/started",
                    params: {
                      threadId: "native-limit-child",
                      turn: makeCodexReplayTurn({
                        id: "limit-child-turn",
                        status: "inProgress",
                      }),
                    },
                  },
                },
              ]
            : []),
          ...(scenario.notification
            ? [
                {
                  type: "emit_inbound" as const,
                  label: "error",
                  frame: {
                    method: "error",
                    params: {
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      willRetry:
                        scenario.name === "retry" ||
                        "willRetry" in scenario ||
                        "terminalMessage" in scenario,
                      error: {
                        message,
                        codexErrorInfo: errorInfo,
                        additionalDetails:
                          "details" in scenario
                            ? scenario.details
                            : scenario.name === "matching-details"
                              ? "Detailed provider allowance explanation."
                              : null,
                      },
                    },
                  },
                },
              ]
            : []),
          ...("terminalMessage" in scenario
            ? [
                {
                  type: "emit_inbound" as const,
                  label: "error/terminal",
                  frame: {
                    method: "error",
                    params: {
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      willRetry: false,
                      error: {
                        message: scenario.terminalMessage,
                        codexErrorInfo:
                          "terminalErrorInfo" in scenario ? scenario.terminalErrorInfo : "other",
                      },
                    },
                  },
                },
              ]
            : []),
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                  error: {
                    message:
                      "terminalMessage" in scenario
                        ? scenario.terminalMessage
                        : scenario.name === "replacement"
                          ? "A different failure."
                          : message,
                    ...("terminalMessage" in scenario
                      ? {
                          codexErrorInfo:
                            "completionErrorInfo" in scenario
                              ? scenario.completionErrorInfo
                              : "other",
                        }
                      : scenario.notification &&
                          scenario.name !== "matching-details" &&
                          !("details" in scenario)
                        ? {}
                        : { codexErrorInfo: errorInfo }),
                  },
                },
              },
            },
          },
          ...(readsAccount ? [readRequest] : []),
          ...(scenario.name === "newer-reset-during-read" ? [newerSnapshot] : []),
          ...(readsReset
            ? [
                {
                  type: "emit_inbound" as const,
                  label: "account/rateLimits/read",
                  frame: {
                    id: 4,
                    result: {
                      ...premium.frame.params,
                      rateLimitsByLimitId: { codex: snapshot.frame.params.rateLimits },
                    },
                  },
                },
              ]
            : []),
          ...(readsAccount && !readsReset
            ? [
                {
                  type: "emit_inbound" as const,
                  label: "account/rateLimits/read",
                  frame: { id: 4, error: { code: -32600, message: "Not signed in." } },
                },
              ]
            : []),
          ...(scenario.name === "late-reset"
            ? [{ ...snapshot, label: "account/rateLimits/updated/late" }]
            : []),
          ...("resetAfter" in scenario ? [snapshot] : []),
          ...(scenario.name === "deferred-reset"
            ? [
                {
                  ...snapshot,
                  frame: {
                    method: "account/rateLimits/updated",
                    params: {
                      rateLimits: {
                        limitId: "codex",
                        primary: {
                          usedPercent: 100,
                          resetsAt: 2000200000,
                          windowDurationMins: 300,
                        },
                      },
                    },
                  },
                },
                {
                  type: "emit_inbound" as const,
                  label: "turn/completed/child",
                  frame: {
                    method: "turn/completed",
                    params: {
                      threadId: "native-limit-child",
                      turn: makeCodexReplayTurn({
                        id: "limit-child-turn",
                        status: "completed",
                      }),
                    },
                  },
                },
              ]
            : []),
        ],
      });
      const resetReceipt = yield* Deferred.make<void>();
      const snapshotReceipt = yield* Deferred.make<void>();
      const terminalReceipt = yield* Deferred.make<void>();
      const harness = yield* makeCodexReplayHarness(
        transcript,
        (event) =>
          event.type === "turn.terminal"
            ? Deferred.succeed(terminalReceipt, undefined)
            : event.type === "turn_item.updated" &&
                event.turnItem.type === "error" &&
                event.turnItem.failure.resetAt === resetAt
              ? Deferred.succeed(resetReceipt, undefined)
              : Effect.void,
        undefined,
        undefined,
        // The late reset must land after the terminal its failed read released.
        (entry) =>
          entry.label === "account/rateLimits/updated/late"
            ? Deferred.await(terminalReceipt)
            : Effect.void,
        () => Deferred.succeed(snapshotReceipt, undefined),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          text: "Continue.",
          attemptId: RunAttemptId.make(`attempt-limit-${scenario.name}`),
        }),
      );
      yield* harness.firstTerminal;
      const terminal = harness.terminalEvents()[0];
      assert.equal(terminal?.status, "failed");
      if (terminal?.status !== "failed") return;
      assert.equal(terminal.failure.class, scenario.expectedClass);
      assert.notInclude(terminal.failure.message, "dummy-sensitive");
      assert.equal(terminal.threadDisposition, "reusable");
      if (scenario.name === "message-reset")
        assert.equal(
          terminal.failure.resetAt,
          DateTime.formatIso(
            DateTime.makeZonedUnsafe(
              { year: 2033, month: 11, day: 11, hour: 15, minute: 38 },
              { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
            ),
          ),
        );
      if (scenario.name === "deferred-reset" || scenario.name === "first-request-reset")
        assert.equal(terminal.failure.resetAt, resetAt);
      if (scenario.name === "newer-reset-during-read")
        assert.equal(terminal.failure.resetAt, "2033-05-20T11:06:40.000Z");
      if (scenario.name === "matching-details")
        assert.equal(terminal.failure.message, "Detailed provider allowance explanation.");
      if ("resetAfter" in scenario) {
        yield* Deferred.await(snapshotReceipt);
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "error" &&
              event.turnItem.failure.resetAt != null,
          ),
        );
      }
      if (scenario.name === "late-reset") {
        yield* Deferred.await(resetReceipt);
        const item = harness.events.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.failure.resetAt === resetAt,
        );
        assert.isDefined(item);
      }
      if (scenario.name === "retry" || "willRetry" in scenario)
        assert.equal(terminal.retry?.attempt, 1);
      if ("expectedCode" in scenario && "expectedMessage" in scenario) {
        assert.equal(terminal.failure.code, scenario.expectedCode);
        assert.include(terminal.failure.message, scenario.expectedMessage);
        assert.equal(terminal.failure.resetAt, null);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  const RESUME_SCENARIO = "codex-resume-subagent";
  const RESUME_NATIVE_THREAD = "native-codex-resume-thread";
  const RESUME_NATIVE_TURN = "native-codex-resume-root-turn";
  const RESUME_CHILD_THREAD = "native-codex-resume-child-thread";
  const RESUME_CHILD_TURN_1 = "native-codex-resume-child-turn-1";
  const RESUME_CHILD_TURN_2 = "native-codex-resume-child-turn-2";
  const RESUME_PROMPT = "Spawn a sub-agent, nudge it, and reply NUDGED.";

  const childAgentMessage = (input: {
    readonly id: string;
    readonly text: string;
    readonly turnId: string;
    readonly completedAtMs: number;
    readonly afterMs?: number;
    readonly omitPhase?: boolean;
  }): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `item/completed/${input.id}`,
    ...(input.afterMs === undefined ? {} : { afterMs: input.afterMs }),
    frame: {
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          id: input.id,
          text: input.text,
          ...(input.omitPhase ? {} : { phase: "final_answer" as const }),
          memoryCitation: null,
        },
        threadId: RESUME_CHILD_THREAD,
        turnId: input.turnId,
        completedAtMs: input.completedAtMs,
      },
    },
  });

  const childTurnStarted = (
    turnId: string,
    afterMs?: number,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/started/${turnId}`,
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: {
      method: "turn/started",
      params: {
        threadId: RESUME_CHILD_THREAD,
        turn: {
          ...makeCodexReplayTurn({ id: turnId, status: "inProgress" }),
          startedAt: turnId === RESUME_CHILD_TURN_2 ? 1782622470 : 1782622440,
        },
      },
    },
  });

  const childTurnCompleted = (
    turnId: string,
    afterMs?: number,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/completed/${turnId}`,
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: {
      method: "turn/completed",
      params: {
        threadId: RESUME_CHILD_THREAD,
        turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
      },
    },
  });

  const resumeSubagentTranscript = makeCodexReplayTranscript({
    scenario: RESUME_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: RESUME_NATIVE_THREAD,
        nativeTurnId: RESUME_NATIVE_TURN,
        prompt: RESUME_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/completed/subAgentActivity-started",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "subAgentActivity",
              id: "call-codex-resume-spawn",
              kind: "started",
              agentThreadId: RESUME_CHILD_THREAD,
              agentPath: "/root/resume_agent",
            },
            threadId: RESUME_NATIVE_THREAD,
            turnId: RESUME_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      childTurnStarted(RESUME_CHILD_TURN_1),
      childAgentMessage({
        id: "child-first-answer",
        text: "CODEX_FIRST_DONE",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442000,
      }),
      childAgentMessage({
        id: "child-first-answer-empty",
        text: "",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442001,
        omitPhase: true,
      }),
      childAgentMessage({
        id: "child-first-answer-duplicate",
        text: "CODEX_FIRST_DONE",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442002,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_1, 100),
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-resume",
              text: "NUDGED",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: RESUME_NATIVE_THREAD,
            turnId: RESUME_NATIVE_TURN,
            completedAtMs: 1782622443000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/root",
        frame: {
          method: "turn/completed",
          params: {
            threadId: RESUME_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      childTurnStarted(RESUME_CHILD_TURN_2, 30_000),
      childAgentMessage({
        id: "child-resume-answer",
        text: "CODEX_RESUME_DONE",
        turnId: RESUME_CHILD_TURN_2,
        completedAtMs: 1782622480000,
        afterMs: 30_000,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_2),
    ],
  });

  it.effect("preserves a subagent result across a trailing empty final and resume", () =>
    Effect.gen(function* () {
      const harness = yield* makeCodexReplayHarness(resumeSubagentTranscript);
      const now = yield* DateTime.now;

      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-codex-resume"),
          text: RESUME_PROMPT,
        }),
      );
      yield* harness.until(() =>
        harness.subagentUpdates().some((event) => event.subagent.result === "CODEX_FIRST_DONE"),
      );
      assert.lengthOf(
        harness.subagentUpdates().filter((event) => event.subagent.result === "CODEX_FIRST_DONE"),
        1,
      );
      yield* TestClock.adjust("100 millis");
      yield* harness.awaitTerminal(1);
      assert.equal(harness.terminalEvents()[0]?.status, "completed");
      const settledUpdates = harness.subagentUpdates();
      const firstCompletion = settledUpdates[settledUpdates.length - 1];
      assert.equal(firstCompletion?.subagent.status, "completed");
      assert.equal(firstCompletion?.subagent.result, "CODEX_FIRST_DONE");
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
      const settledUpdateCount = settledUpdates.length;

      yield* TestClock.adjust("30 seconds");
      yield* harness.until(() => harness.subagentUpdates().length > settledUpdateCount);
      const reopened = harness.subagentUpdates()[settledUpdateCount];
      assert.equal(reopened?.subagent.status, "running");
      assert.equal(DateTime.toEpochMillis(reopened!.subagent.startedAt!), 1782622470000);
      assert.isNull(reopened!.subagent.completedAt);
      assert.isTrue(yield* harness.hasPendingBackgroundWork);

      yield* TestClock.adjust("30 seconds");
      yield* harness.until(() => {
        const updates = harness.subagentUpdates();
        const latest = updates[updates.length - 1];
        return (
          latest !== undefined &&
          latest.subagent.status === "completed" &&
          latest.subagent.result === "CODEX_RESUME_DONE"
        );
      });
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
      assert.lengthOf(harness.terminalEvents(), 1);
      // The first child turn finished inside the root turn; only the resume wakes it.
      assert.lengthOf(harness.continuationRequests, 1);
      assert.include(harness.continuationRequests[0]?.detail, "CODEX_RESUME_DONE");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  const codexReplayThreadResult = (input: {
    readonly nativeThreadId: string;
    readonly forkedFromId: string | null;
  }) => ({
    thread: {
      id: input.nativeThreadId,
      sessionId: input.nativeThreadId,
      forkedFromId: input.forkedFromId,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1782622440,
      updatedAt: 1782622440,
      status: { type: "idle" },
      path: `/tmp/${input.nativeThreadId}.jsonl`,
      cwd: "/workspace",
      cliVersion: "0.144.0",
      source: "vscode",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/workspace",
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
    reasoningEffort: "medium",
  });

  const errorCauseChainText = (error: unknown): string =>
    error instanceof Error ? `${error.message} ${errorCauseChainText(error.cause)}` : String(error);

  const codexReplaySourceTurn = (input: {
    readonly id: string;
    readonly ordinal: number;
    readonly nativeId: string | null;
    readonly providerThreadId: ProviderThreadId;
    readonly now: DateTime.Utc;
  }): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(input.id),
    providerThreadId: input.providerThreadId,
    nodeId: NodeId.make(`node-${input.id}`),
    runAttemptId: RunAttemptId.make(`run-attempt-${input.id}`),
    nativeTurnRef:
      input.nativeId === null
        ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
        : {
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeId: input.nativeId,
            strength: "strong",
          },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: input.now,
    completedAt: input.now,
  });

  it.effect("fails honestly when rolling back a legacy Codex thread", () =>
    Effect.gen(function* () {
      const nativeThreadId = "legacy-rollback-thread";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "legacy-rollback-turn",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-legacy-rollback",
        entries: [
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/read",
            frame: {
              id: 3,
              method: "thread/read",
              params: { threadId: nativeThreadId, includeTurns: false },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/read",
            frame: {
              id: 3,
              result: { thread: { id: nativeThreadId, historyMode: "legacy" } },
            },
          },
        ],
      });
      const outbound: Array<string> = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            outbound.push(method);
          }),
      );
      const now = yield* DateTime.now;
      const firstTurn = codexReplaySourceTurn({
        id: "provider-turn-first",
        ordinal: 1,
        nativeId: "native-turn-first",
        providerThreadId: harness.providerThread.id,
        now,
      });
      const secondTurn = codexReplaySourceTurn({
        id: "provider-turn-second",
        ordinal: 2,
        nativeId: "native-turn-second",
        providerThreadId: harness.providerThread.id,
        now,
      });

      const error = yield* Effect.flip(
        harness.runtime.rollbackThread({
          providerThread: harness.providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-legacy-rollback"),
            appRunOrdinal: 1,
            providerTurn: firstTurn,
          },
          providerThreadTurns: [firstTurn, secondTurn],
        }),
      );

      assert.instanceOf(error, ProviderAdapter.ProviderAdapterRollbackThreadError);
      assert.include(
        errorCauseChainText(error),
        "legacy",
        "legacy rollback must surface an honest unsupported-history failure",
      );
      assert.notInclude(
        outbound,
        "thread/rollback",
        "thread/rollback must not be sent to a legacy Codex thread",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect(
    "falls back to fork-local thread/revert on paginated history when the source turn lacks a native reference",
    () =>
      Effect.gen(function* () {
        const nativeThreadId = "fallback-source-thread";
        const forkThreadId = "fallback-fork-thread";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "fallback-source-turn",
          prompt: "unused",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-fork-paginated-fallback",
          entries: [
            ...preamble.slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 3,
                method: "thread/fork",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: {
                id: 3,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: nativeThreadId,
                }),
              },
            },
            {
              type: "expect_outbound",
              label: "thread/read",
              frame: {
                id: 4,
                method: "thread/read",
                params: { threadId: forkThreadId, includeTurns: false },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/read",
              frame: {
                id: 4,
                result: { thread: { id: forkThreadId, historyMode: "paginated" } },
              },
            },
            {
              type: "expect_outbound",
              label: "thread/turns/list",
              frame: {
                id: 5,
                method: "thread/turns/list",
                params: {
                  threadId: forkThreadId,
                  cursor: null,
                  limit: 1,
                  sortDirection: "desc",
                  itemsView: "summary",
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/turns/list",
              frame: {
                id: 5,
                result: {
                  data: [{ id: "native-turn-second", items: [], status: "completed", error: null }],
                  nextCursor: null,
                },
              },
            },
            {
              type: "expect_outbound",
              label: "thread/revert",
              frame: {
                id: 6,
                method: "thread/revert",
                params: { threadId: forkThreadId, beforeTurnId: "native-turn-second" },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/revert",
              frame: {
                id: 6,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: null,
                }),
              },
            },
          ],
        });
        const outbound: Array<string> = [];
        const forkThreadEnvs: Array<unknown> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method, params) =>
            Effect.sync(() => {
              outbound.push(method);
              if (method === "thread/fork") forkThreadEnvs.push(threadEnvOf(params));
            }),
        );
        const now = yield* DateTime.now;
        const firstTurn = codexReplaySourceTurn({
          id: "provider-turn-first",
          ordinal: 1,
          nativeId: null,
          providerThreadId: harness.providerThread.id,
          now,
        });
        const secondTurn = codexReplaySourceTurn({
          id: "provider-turn-second",
          ordinal: 2,
          nativeId: "native-turn-second",
          providerThreadId: harness.providerThread.id,
          now,
        });

        const forkedProviderThread = yield* harness.runtime.forkThread({
          sourceProviderThread: harness.providerThread,
          sourceProviderTurns: [firstTurn, secondTurn],
          providerTurnId: firstTurn.id,
          targetThreadId: ThreadId.make("thread-fork-paginated-fallback-target"),
        });

        assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, forkThreadId);
        assert.notEqual(forkedProviderThread.id, harness.providerThread.id);
        assert.equal(forkedProviderThread.forkedFrom?.providerTurnId, firstTurn.id);
        assert.deepEqual(outbound.slice(-2), ["thread/turns/list", "thread/revert"]);
        assert.deepEqual(forkThreadEnvs, ["thread-fork-paginated-fallback-target"]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );

  describe("Codex file-change approval paths", () => {
    const nativeThreadId = "file-approval-thread";
    const nativeTurnId = "file-approval-turn";
    const prompt = "Edit the files.";
    type FileUpdateChange = CodexSchema.V2ItemStartedNotification__FileUpdateChange;
    const addA: FileUpdateChange = { path: "/w/a.ts", kind: { type: "add" }, diff: "export {};" };
    const renameC: FileUpdateChange = {
      path: "/w/c.ts",
      kind: { type: "update", move_path: "/w/d.ts" },
      diff: "@@",
    };

    const deleteE: FileUpdateChange = { path: "/w/e.ts", kind: { type: "delete" }, diff: "gone" };

    const fileChange = (
      phase: "started" | "completed",
      turnId: string,
      itemId: string,
      changes: ReadonlyArray<FileUpdateChange>,
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: `${phase} ${itemId}`,
      frame: {
        method: `item/${phase}`,
        params: {
          threadId: nativeThreadId,
          turnId,
          ...(phase === "started" ? { startedAtMs: 1 } : { completedAtMs: 3 }),
          item: {
            type: "fileChange",
            id: itemId,
            status: phase === "started" ? "inProgress" : "completed",
            changes,
          },
        },
      },
    });

    const turnCompleted = (turnId: string): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: `complete ${turnId}`,
      frame: {
        method: "turn/completed",
        params: {
          threadId: nativeThreadId,
          turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
        },
      },
    });

    const startApprovalTurn = (
      scenario: string,
      entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
    ) =>
      Effect.gen(function* () {
        const pending = yield* Queue.unbounded<OrchestrationV2RuntimeRequest>();
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario,
            entries: [...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }), ...entries],
          }),
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
              ? Queue.offer(pending, event.runtimeRequest)
              : Effect.void,
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`${scenario}-attempt`),
            text: prompt,
          }),
        );
        return {
          harness,
          answerNext: Queue.take(pending).pipe(
            Effect.tap((request) =>
              harness.runtime.respondToRuntimeRequest({
                requestId: request.id,
                decision: "accept",
              }),
            ),
          ),
        };
      });

    it.effect("keeps every path of a completed multi-file patch", () =>
      Effect.gen(function* () {
        const { harness } = yield* startApprovalTurn("file-change-multi-path", [
          fileChange("started", nativeTurnId, "patch-a", [renameC, deleteE, addA]),
          fileChange("completed", nativeTurnId, "patch-a", [renameC, deleteE, addA]),
          turnCompleted(nativeTurnId),
        ]);
        yield* harness.firstTerminal;

        const fileChanges = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "file_change"
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(fileChanges, 1);
        assert.equal(fileChanges[0]?.fileName, "/w/c.ts");
        assert.deepEqual(fileChanges[0]?.changes, [
          { operation: "update", path: "/w/d.ts", oldPath: "/w/c.ts" },
          { operation: "delete", path: "/w/e.ts" },
          { operation: "add", path: "/w/a.ts" },
        ]);
        assert.equal(
          fileChanges[0]?.diffStr,
          [
            'diff --git "a//w/c.ts" "b//w/d.ts"',
            '--- "a//w/c.ts"',
            '+++ "b//w/d.ts"',
            "@@",
            'diff --git "a//w/e.ts" "b//w/e.ts"',
            '--- "a//w/e.ts"',
            "+++ /dev/null",
            "@@ -1,1 +0,0 @@",
            "-gone",
            "\\ No newline at end of file",
            'diff --git "a//w/a.ts" "b//w/a.ts"',
            "--- /dev/null",
            '+++ "b//w/a.ts"',
            "@@ -0,0 +1,1 @@",
            "+export {};",
            "\\ No newline at end of file",
            "",
          ].join("\n"),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );
  });
});

describe("CodexAdapterV2 app-server process", () => {
  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "stops an app-server that ignores SIGTERM within its kill deadline",
    () =>
      Effect.gen(function* () {
        const command = yield* CodexAdapterV2.makeCodexAppServerSpawnCommand({
          command: "/bin/sh",
          args: ["-c", "trap '' TERM; echo ready; while :; do sleep 1; done"],
        });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const scope = yield* Scope.make();
        const child = yield* spawner.spawn(command).pipe(Scope.provide(scope));
        const pid = Number(child.pid);
        const killGroup = () => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        };
        yield* Effect.addFinalizer(() => Effect.sync(killGroup));
        // Stop it only once its SIGTERM trap is set; an early exit would pass without testing it.
        const firstLine = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
        );
        assert.deepStrictEqual(firstLine, Option.some("ready"));
        // Scope.close cannot be interrupted, so a regression is ended by this rescue instead of
        // hanging the test; the deadline under test must make it unnecessary.
        let rescued = false;
        // oxlint-disable-next-line ankielcode/no-real-time-wait-in-tests -- a watchdog for a hung child, not a wait for a milestone; it must never fire.
        const rescue = yield* Effect.sleep("10 seconds").pipe(
          Effect.andThen(
            Effect.sync(() => {
              rescued = true;
              killGroup();
            }),
          ),
          Effect.forkChild,
        );
        yield* Scope.close(scope, Exit.void);
        yield* Fiber.interrupt(rescue);
        assert.isFalse(rescued, "the app-server was stopped by its own kill deadline");
        assert.isFalse(yield* child.isRunning.pipe(Effect.orElseSucceed(() => true)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
