import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatFileAttachment,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@ankielcode/contracts";
import { resolveSelfInvocation } from "@ankielcode/shared/nodeRuntime";
import {
  compactDynamicToolOutput,
  previewRecordingIdFromToolItem,
  sentMessageFromToolItem,
} from "@ankielcode/shared/toolOutput";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as ProviderHost from "@ankielcode/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@ankielcode/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@ankielcode/provider-testing/TestProviderHost";
import type * as AcpSessionRuntime from "@ankielcode/provider-acp/server/AcpSessionRuntime";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { normalizeAntigravitySessionUpdate } from "../../provider/acp/AntigravityProtocol.ts";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import {
  makeAntigravityAcpAdapterFlavor,
  makeAntigravityAdapterV2,
} from "./AntigravityAdapterV2.ts";

const flavor = makeAntigravityAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("antigravity-test"),
  random: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  host: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not spawned in this test"),
  withProcess: (_stop, task) => task,
  defaultModel: Effect.undefined,
});

function permissionRequest(
  toolCallId: string,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options,
    toolCall: { toolCallId, title: "Which branch?" },
  };
}

describe("AntigravityAdapterV2 flavor", () => {
  it("routes interaction_* permission requests to the question card", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_1", [
        { optionId: "main", name: "main", kind: "allow_once" },
        { optionId: "dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.isDefined(question);
    assert.deepEqual(
      question?.question.options.map((option) => option.label),
      ["main", "dev"],
    );
    assert.deepEqual(question?.respond({ interaction_1: "dev" }), {
      outcome: { outcome: "selected", optionId: "dev" },
    });
    assert.isUndefined(question?.respond({ interaction_1: "nope" }));
    assert.isUndefined(
      flavor.extractPermissionQuestion?.(
        permissionRequest("tool_1", [{ optionId: "allow", name: "Allow", kind: "allow_once" }]),
      ),
    );
  });
});

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

describe("AntigravityAdapterV2 client file system", () => {
  it.effect("serves confined reads and leaves edits to the agent's diff tools", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      // effect-acp keeps the last handler registered per method; so does this.
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      let writeTextFile: Parameters<RuntimeService["handleWriteTextFile"]>[0] | undefined;
      const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ankiel-antigravity-log-" });
      const requestLog = path.join(logs, "requests.ndjson");
      const crypto = yield* SecureRandom.SecureRandom;
      const instanceId = ProviderInstanceId.make("antigravity-containment-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { ANKIEL_ACP_ANTIGRAVITY: "1", ANKIEL_ACP_REQUEST_LOG_PATH: requestLog },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
              handleWriteTextFile: (handler) =>
                Effect.sync(() => {
                  writeTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleWriteTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ankiel-antigravity-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ankiel-antigravity-outside-",
      });
      const outsideFile = path.join(outside, "secret.txt");
      yield* fileSystem.writeFileString(outsideFile, "secret");
      const attachment = path.join(host.paths.attachmentsDir, "pasted.txt");
      yield* fileSystem.writeFileString(attachment, "pasted");

      const threadId = ThreadId.make("thread-antigravity-containment");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-containment"),
        modelSelection,
        runtimePolicy,
      });
      yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
      const requests = (yield* fileSystem.readFileString(requestLog))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              params?: {
                clientCapabilities?: { fs?: unknown };
                clientInfo?: { name?: string };
                additionalDirectories?: unknown;
              };
            },
        );
      const initialize = requests.find((request) => request.method === "initialize");
      // agy runs shell commands from its lexicographically first root, so attachments
      // must reach it through client reads, never as an extra workspace root.
      assert.isUndefined(
        requests.find((request) => request.method === "session/new")?.params?.additionalDirectories,
      );
      assert.deepEqual(initialize?.params?.clientCapabilities?.fs, {
        readTextFile: true,
        writeTextFile: false,
      });
      assert.equal(initialize?.params?.clientInfo?.name, "zed");
      assert.isUndefined(writeTextFile);
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file reads");
      }
      const context = (method: string) => ({ requestId: `test-${method}`, method });

      const insidePath = path.join(workspace, "src", "inside.ts");
      yield* fileSystem.makeDirectory(path.dirname(insidePath), { recursive: true });
      yield* fileSystem.writeFileString(insidePath, "inside");
      const pasted = yield* readTextFile(
        { sessionId: "mock-session-1", path: attachment },
        context("fs/read_text_file"),
      );
      assert.equal(pasted.content, "pasted");
      yield* fileSystem.writeFileString(insidePath, "\uFEFFfirst\né中🙂\nlast");
      const sliced = yield* readTextFile(
        { sessionId: "mock-session-1", path: insidePath, line: 2, limit: 1 },
        context("fs/read_text_file"),
      );
      assert.equal(sliced.content, "é中🙂");
      yield* fileSystem.writeFileString(insidePath, "inside");
      for (const [name, bytes] of [
        ["image.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        ["data.bin", new Uint8Array([0x61, 0, 0x62])],
      ] as const) {
        const binaryPath = path.join(workspace, name);
        yield* fileSystem.writeFile(binaryPath, bytes);
        const binaryRead = yield* readTextFile(
          { sessionId: "mock-session-1", path: binaryPath },
          context("fs/read_text_file"),
        ).pipe(Effect.flip);
        assert.propertyVal(binaryRead, "code", -32602, `${name} is refused as binary`);
      }

      const outsideRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: outsideFile },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(outsideRead));
      const linkPath = path.join(workspace, "linked-secret.txt");
      yield* fileSystem.symlink(outsideFile, linkPath);
      const linkedRead = yield* readTextFile(
        { sessionId: "mock-session-1", path: linkPath },
        context("fs/read_text_file"),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(linkedRead), "a read through an escaping symlink is denied");
      const insideLink = path.join(workspace, "inside-link.ts");
      yield* fileSystem.symlink(insidePath, insideLink);
      const viaInsideLink = yield* readTextFile(
        { sessionId: "mock-session-1", path: insideLink },
        context("fs/read_text_file"),
      );
      assert.equal(viaInsideLink.content, "inside");
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 workspace changes", () => {
  it.effect("confines file requests to the workspace of the turn in progress", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const promptReceived = yield* Deferred.make<Parameters<RuntimeService["prompt"]>[0]>();
      const host = yield* ProviderHost.ProviderHost;
      const document = ChatFileAttachment.make({
        type: "file",
        id: "native-pdf",
        name: "diagram.pdf",
        mimeType: "application/pdf",
        sizeBytes: 9,
      });
      const documentPath = host.resolveAttachmentPath(document)!;
      yield* fileSystem.writeFileString(documentPath, "%PDF-1.7");
      let readTextFile: Parameters<RuntimeService["handleReadTextFile"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-workspace-change-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { ANKIEL_ACP_ANTIGRAVITY: "1", ANKIEL_ACP_HANG_PROMPT_FOREVER: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              prompt: (request) =>
                Deferred.succeed(promptReceived, request).pipe(
                  Effect.andThen(runtime.prompt(request)),
                ),
              start: () =>
                runtime.start().pipe(
                  Effect.map((started) => ({
                    ...started,
                    initializeResult: {
                      ...started.initializeResult,
                      agentCapabilities: {
                        ...started.initializeResult.agentCapabilities,
                        promptCapabilities: { image: true, audio: true, embeddedContext: true },
                      },
                    },
                  })),
                ),
              handleReadTextFile: (handler) =>
                Effect.sync(() => {
                  readTextFile = handler;
                }).pipe(Effect.andThen(runtime.handleReadTextFile(handler))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const workspaceA = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ankiel-ag-a-" });
      const workspaceB = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ankiel-ag-b-" });
      yield* fileSystem.writeFileString(path.join(workspaceA, "a.txt"), "from a");
      yield* fileSystem.writeFileString(path.join(workspaceB, "b.txt"), "from b");
      const policyFor = (cwd: string) =>
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd,
        });
      const threadId = ThreadId.make("thread-antigravity-workspace-change");
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-workspace-change"),
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policyFor(workspaceA),
      });
      const now = yield* DateTime.now;
      yield* session
        .startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-antigravity-workspace-change"),
            title: "Antigravity workspace change",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: workspaceB,
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
          threadId,
          runId: RunId.make("run-antigravity-workspace-change"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-antigravity-workspace-change"),
          rootNodeId: NodeId.make("node-antigravity-workspace-change"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-antigravity-workspace-change"),
            text: "read b.txt",
            attachments: [document],
          },
          modelSelection,
          runtimePolicy: policyFor(workspaceB),
        })
        .pipe(Effect.forkScoped);
      yield* session.events.pipe(
        Stream.filter((event) => event.type === "provider_turn.updated"),
        Stream.runHead,
      );
      const sent = yield* Deferred.await(promptReceived);
      assert.deepEqual(
        sent.prompt.filter((block) => block.type === "resource_link"),
        [
          {
            type: "resource_link",
            uri: (yield* path.toFileUrl(documentPath)).href,
            name: "diagram.pdf",
            mimeType: "application/pdf",
            size: 8,
          },
        ],
      );
      assert.include(JSON.stringify(sent.prompt), JSON.stringify(documentPath).slice(1, -1));
      if (readTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file requests");
      }
      const context = { requestId: "test-read", method: "fs/read_text_file" };
      const fromB = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceB, "b.txt") },
        context,
      );
      assert.equal(fromB.content, "from b");
      const fromA = yield* readTextFile(
        { sessionId: "mock-session-1", path: path.join(workspaceA, "a.txt") },
        context,
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(fromA), "the previous workspace is no longer readable");
    }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 html_render pages", () => {
  it.effect(
    "recovers Ankiel MCP tool results across omitted outputs, replays, errors, and turn boundaries",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        let promptIndex = 0;
        let turn1Epoch = 0;
        const instanceId = ProviderInstanceId.make("antigravity-mcp-result-test");
        const threadId = ThreadId.make("thread-antigravity-mcp-result");
        const statusUpdate = "### Current Status\n\nAll checks are passing.";
        const inProgressText = "Streamed while running.";
        const lateText = "Confirmed on a later completion.";
        const lateErrorText = "Late explicit error.";
        const unfinishedText = "Still running when turn ended.";
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { ANKIEL_ACP_ANTIGRAVITY: "1" },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdate = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: () =>
                  Effect.gen(function* () {
                    promptIndex += 1;
                    const send = (update: EffectAcpSchema.SessionUpdate) =>
                      sessionUpdate === undefined
                        ? Effect.die("the adapter must handle session updates")
                        : sessionUpdate(
                            normalizeAntigravitySessionUpdate({
                              sessionId: "mock-session-1",
                              update,
                            }),
                          );
                    const startTool = (
                      toolCallId: string,
                      toolName: string,
                      rawInput: Record<string, unknown>,
                    ) =>
                      send({
                        sessionUpdate: "tool_call",
                        toolCallId,
                        title: `Run mcp_ankiel-code_${toolName}`,
                        kind: "other",
                        status: "in_progress",
                        rawInput,
                      });
                    const updateTool = (
                      toolCallId: string,
                      status: "in_progress" | "completed" | "failed",
                      rawOutput?: unknown,
                    ) =>
                      send({
                        sessionUpdate: "tool_call_update",
                        toolCallId,
                        status,
                        ...(rawOutput === undefined ? {} : { rawOutput }),
                      });
                    const recordSend = (message: string) =>
                      mcpSessions.recordToolResult(
                        threadId,
                        "send_to_user",
                        { message },
                        { sentMessage: message },
                      );

                    if (promptIndex === 2) {
                      // A Turn 1 handler finishing after Turn 1 closed must be rejected by epoch.
                      yield* mcpSessions.recordToolResult(
                        threadId,
                        "send_to_user",
                        { message: unfinishedText },
                        { sentMessage: unfinishedText },
                        { epoch: turn1Epoch },
                      );
                      yield* startTool("turn2-leaked-check", "send_to_user", {
                        message: unfinishedText,
                      });
                      yield* updateTool("turn2-leaked-check", "completed", "Summary of turn 2");
                      return { stopReason: "end_turn" as const };
                    }

                    turn1Epoch = yield* mcpSessions.toolResultEpoch(threadId);

                    // agy 1.5.x adds toolSummary and omits output on completion, then may replay.
                    yield* startTool("send-empty", "send_to_user", {
                      message: statusUpdate,
                      toolSummary: "Send status update",
                    });
                    yield* recordSend(statusUpdate);
                    yield* updateTool("send-empty", "completed");
                    yield* updateTool("send-empty", "in_progress");
                    yield* updateTool("send-empty", "completed", "Summary replay");

                    // Streaming output during in_progress still drains on completion.
                    yield* startTool("send-streaming", "send_to_user", { message: inProgressText });
                    yield* recordSend(inProgressText);
                    yield* updateTool("send-streaming", "in_progress", {
                      sentMessage: inProgressText,
                    });
                    yield* updateTool("send-streaming", "completed", {
                      sentMessage: inProgressText,
                    });
                    yield* startTool("send-streaming-unpublished", "send_to_user", {
                      message: inProgressText,
                    });
                    yield* updateTool("send-streaming-unpublished", "completed");

                    // Explicit MCP error preserves diagnostic content across summary replays.
                    yield* startTool("send-errored", "send_to_user", { message: "Denied" });
                    yield* updateTool("send-errored", "completed", {
                      result: {
                        isError: true,
                        structuredContent: { sentMessage: "Denied" },
                        content: [{ type: "text", text: "Denied by policy" }],
                      },
                    });
                    yield* updateTool("send-errored", "completed", "Summary of denied");

                    // Initial miss -> late explicit success or error still drains its new record.
                    yield* startTool("send-late", "send_to_user", { message: lateText });
                    yield* updateTool("send-late", "completed");
                    yield* recordSend(lateText);
                    yield* updateTool("send-late", "completed", { sentMessage: lateText });
                    yield* startTool("send-late-unpublished", "send_to_user", {
                      message: lateText,
                    });
                    yield* updateTool("send-late-unpublished", "completed");

                    yield* startTool("send-late-error", "send_to_user", { message: lateErrorText });
                    yield* updateTool("send-late-error", "completed");
                    yield* mcpSessions.recordToolResult(
                      threadId,
                      "send_to_user",
                      { message: lateErrorText },
                      { isError: true },
                    );
                    yield* updateTool("send-late-error", "completed", {
                      result: { isError: true, content: [{ type: "text", text: "Denied late" }] },
                    });
                    yield* startTool("send-late-error-sibling", "send_to_user", {
                      message: lateErrorText,
                    });
                    yield* updateTool("send-late-error-sibling", "completed");

                    // Empty-input completion that misses still recovers once a later completion brings arguments,
                    // and replacing arguments on the same call ID re-matches against the new arguments.
                    yield* startTool("send-late-args", "send_to_user", {});
                    yield* recordSend("First args");
                    yield* updateTool("send-late-args", "completed");
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "send-late-args",
                      status: "completed",
                      rawInput: { message: "First args" },
                    });
                    yield* recordSend("Second args");
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: "send-late-args",
                      status: "completed",
                      rawInput: { message: "Second args" },
                      rawOutput: "Summary of second",
                    });

                    // Bare failure without reported output must not consume a sibling call's cached result.
                    yield* startTool("send-bare-fail", "send_to_user", { message: "Shared ready" });
                    yield* startTool("send-bare-fail-sibling", "send_to_user", {
                      message: "Shared ready",
                    });
                    yield* recordSend("Shared ready");
                    yield* updateTool("send-bare-fail", "failed");
                    yield* updateTool("send-bare-fail-sibling", "completed");

                    // preview_recording_stop recovers its recording id.
                    yield* startTool("recording-stop", "preview_recording_stop", {
                      toolSummary: "Stop preview recording",
                    });
                    yield* mcpSessions.recordToolResult(
                      threadId,
                      "preview_recording_stop",
                      {},
                      { id: `${threadId}-rec-1` },
                    );
                    yield* updateTool("recording-stop", "completed");

                    // Unfinished call projected at turn end must not claim or leak to Turn 2.
                    yield* startTool("send-unfinished", "send_to_user", {
                      message: unfinishedText,
                    });
                    yield* recordSend(unfinishedText);

                    return { stopReason: "end_turn" as const };
                  }),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-mcp-result"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        const runTurn = (ordinal: number) =>
          Effect.gen(function* () {
            yield* session.startTurn(
              makeTurnInput({
                threadId,
                providerThread,
                instanceId,
                runtimePolicy,
                now,
                ordinal,
                modelSelection,
              }),
            );
            return Array.from(
              yield* session.events.pipe(
                Stream.takeUntil((event) => event.type === "turn.terminal"),
                Stream.runCollect,
              ),
            );
          });
        const turn1Events = yield* runTurn(1);
        const turn2Events = yield* runTurn(2);
        const toolIn = (events: ReadonlyArray<(typeof turn1Events)[number]>, nativeId: string) => {
          const event = events.findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === nativeId,
          );
          return event?.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
            ? event.turnItem
            : undefined;
        };
        const tool = (nativeId: string) => toolIn(turn1Events, nativeId);

        const sendEmptyUpdates = turn1Events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "send-empty" &&
          event.turnItem.status === "completed"
            ? [event.turnItem]
            : [],
        );
        assert.deepEqual(
          sendEmptyUpdates.map((update) => sentMessageFromToolItem(update)),
          [statusUpdate, statusUpdate],
        );
        assert.strictEqual(sentMessageFromToolItem(tool("send-streaming")!), inProgressText);
        assert.strictEqual(sentMessageFromToolItem(tool("send-streaming-unpublished")!), undefined);
        const erroredUpdates = turn1Events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "send-errored" &&
          event.turnItem.status === "completed"
            ? [event.turnItem]
            : [],
        );
        assert.strictEqual(erroredUpdates.length, 2);
        for (const update of erroredUpdates) {
          assert.strictEqual(compactDynamicToolOutput(update.output)?.isError, true);
          assert.include(JSON.stringify(update.output), "Denied by policy");
          assert.strictEqual(sentMessageFromToolItem(update), undefined);
        }
        assert.strictEqual(sentMessageFromToolItem(tool("send-late")!), lateText);
        assert.strictEqual(sentMessageFromToolItem(tool("send-late-unpublished")!), undefined);
        const lateErrorSibling = tool("send-late-error-sibling");
        assert.isDefined(lateErrorSibling);
        assert.strictEqual(lateErrorSibling.status, "completed");
        assert.strictEqual(lateErrorSibling.output, undefined);
        assert.strictEqual(sentMessageFromToolItem(tool("send-late-args")!), "Second args");
        assert.strictEqual(
          sentMessageFromToolItem(tool("send-bare-fail-sibling")!),
          "Shared ready",
        );
        assert.strictEqual(sentMessageFromToolItem(tool("send-unfinished")!), undefined);
        assert.strictEqual(
          sentMessageFromToolItem(toolIn(turn2Events, "turn2-leaked-check")!),
          undefined,
        );
        assert.strictEqual(
          previewRecordingIdFromToolItem(tool("recording-stop")!),
          `${threadId}-rec-1`,
        );
      }).pipe(Effect.provide(layerSession)),
  );
});

describe("AntigravityAdapterV2 runtime mode ceiling", () => {
  const modesSetFor = (
    pickedMode: string,
    modes: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "runtimeMode">,
  ) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const modesSet: Array<string> = [];
      const instanceId = ProviderInstanceId.make("antigravity-ceiling-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { ANKIEL_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              setMode: (modeId) =>
                Effect.sync(() => {
                  modesSet.push(modeId);
                }).pipe(Effect.andThen(runtime.setMode(modeId))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-ceiling");
      yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-ceiling"),
        modelSelection: {
          instanceId,
          model: "gemini-test-low",
          options: [{ id: "_ankiel/session-mode", value: pickedMode }],
        },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...modes,
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      });
      return modesSet;
    }).pipe(Effect.provide(layerSession), Effect.scoped);

  it.effect("does not apply a picked session mode above the thread's runtime mode", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* modesSetFor("yolo", { runtimeMode: "approval-required" }), [
        "default",
      ]);
      // A narrower mode is still the user's to pick.
      assert.deepEqual(yield* modesSetFor("default", { runtimeMode: "auto-accept-edits" }), [
        "auto_edit",
        "default",
      ]);
    }),
  );
});
