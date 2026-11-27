// @effect-diagnostics nodeBuiltinImport:off -- workflow fixtures use files and the fake Claude CLI uses Node streams
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";

import type {
  Query as ClaudeQuery,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  type ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  CheckpointId,
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@ankielcode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PortScanner from "../../preview/PortScanner.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import * as McpProviderSession from "@ankielcode/provider-core/server/mcpSession";
import * as McpProviderSessions from "@ankielcode/provider-core/server/McpProviderSessions";
import { type ClaudeModelCatalog } from "../../provider/ClaudeModelCatalog.ts";
import * as ProviderEventLoggers from "@ankielcode/provider-core/server/ProviderEventLoggers";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@ankielcode/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@ankielcode/provider-core/server/failure";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const CLAUDE_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;
const CLAUDE_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeClaudeTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly title?: string;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: input.title ?? "Claude attachment test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
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

function makeClaudeTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
  readonly attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"];
  readonly providerTurnOrdinal?: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly title?: string;
  readonly messageCreatedBy?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["createdBy"];
  readonly messageCreationSource?: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["creationSource"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeClaudeTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal ?? 1,
    ...(input.nativeThreadHasTurns === undefined
      ? {}
      : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: input.messageCreatedBy ?? "user",
      creationSource: input.messageCreationSource ?? "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: input.attachments,
    },
    modelSelection: input.modelSelection ?? CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: input.runtimePolicy ?? CLAUDE_TEST_RUNTIME_POLICY,
  };
}

describe("ClaudeAdapterV2 runtime query policy", () => {
  it("maps canonical read-only never policy to Claude dontAsk with read-only tools", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      tools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      allowedTools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
  });

  it("does not auto-allow reads for canonical restricted read-only never policy", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: {
            type: "restricted",
            includePlatformDefaults: false,
            readableRoots: [],
          },
          networkAccess: false,
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      tools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
  });
});

describe("ClaudeAdapterV2 MCP query overrides", () => {
  const ANKIEL_MCP_SERVERS = {
    "ankiel-code": {
      type: "http",
      url: "http://127.0.0.1:43123/mcp",
      headers: {
        Authorization: "Bearer secret-claude-token",
      },
      timeout: ClaudeAdapterV2.CLAUDE_ANKIEL_MCP_TOOL_TIMEOUT_MS,
    },
  } as const;

  const mcpSessionFor = (
    threadId: ThreadId,
    authorizationHeader = "Bearer secret-claude-token",
  ): McpProviderSession.McpProviderSessionConfig => ({
    environmentId: EnvironmentId.make(`environment-${threadId}`),
    threadId,
    providerSessionId: `mcp-session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader,
    browserToolsAvailable: true,
  });

  it("pre-approves only read-only ankiel-code tools in a read-only sandbox", () => {
    const threadId = ThreadId.make("thread-claude-mcp-read-only");
    const mcpSession = mcpSessionFor(threadId);
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: true,
      allowedTools: [...ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS],
    });

    assert.deepEqual(overrides, {
      allowedTools: [
        ...ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
        ...ClaudeAdapterV2.CLAUDE_READ_ONLY_ANKIEL_MCP_ALLOWED_TOOLS,
      ],
      mcpServers: ANKIEL_MCP_SERVERS,
    });
    assert.isFalse(
      overrides.allowedTools?.includes(ClaudeAdapterV2.CLAUDE_ANKIEL_MCP_TOOL_WILDCARD),
    );
  });
});

describe("ClaudeAdapterV2 native protocol logging", () => {
  it("injects thread-scoped MCP configuration without logging the credential", () => {
    const threadId = ThreadId.make("thread-claude-mcp");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-claude-mcp"),
      threadId,
      providerSessionId: "mcp-session-claude",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-claude-token",
      browserToolsAvailable: true,
    };

    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: false,
      allowedTools: ["Read"],
    });
    assert.deepEqual(overrides, {
      allowedTools: ["Read", "mcp__ankiel-code__*"],
      mcpServers: {
        "ankiel-code": {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: {
            Authorization: "Bearer secret-claude-token",
          },
          timeout: ClaudeAdapterV2.CLAUDE_ANKIEL_MCP_TOOL_TIMEOUT_MS,
        },
      },
    });

    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      nativeThreadId: "native-thread-claude-mcp",
      resume: false,
      cwd: "/workspace",
      allowedTools: overrides.allowedTools ?? [],
      mcpServers: overrides.mcpServers ?? {},
      environment: {},
    });
    assert.isObject(options.systemPrompt);
    const systemPrompt = options.systemPrompt as {
      readonly type: string;
      readonly preset: string;
      readonly append?: string;
    };
    assert.equal(systemPrompt.type, "preset");
    assert.equal(systemPrompt.preset, "claude_code");
    assert.include(systemPrompt.append ?? "", "Use `delegate_task`");
    assert.include(systemPrompt.append ?? "", "call `ankiel_background_wait`");
    assert.notInclude(systemPrompt.append ?? "", "## Ankiel Code devices");
    const logged = ClaudeAdapterV2.loggedClaudeQueryOptions(options);
    assert.equal(logged.hasMcpServers, true);
    assert.notInclude(JSON.stringify(logged), "secret-claude-token");
  });

  it("logs --settings key names without their values", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "native-thread-claude-settings-log",
      resume: false,
      cwd: "/workspace",
      sdkSettings: { env: { ANTHROPIC_API_KEY: "secret-settings-key" } },
    });
    const logged = ClaudeAdapterV2.loggedClaudeQueryOptions(options);
    assert.deepEqual(logged.settingKeys, ["env", "showThinkingSummaries"]);
    assert.notInclude(JSON.stringify(logged), "secret-settings-key");
  });
});

describe("ClaudeAdapterV2 session permissions", () => {
  // regression: #15892 an explicit user refusal must stay user_reject, not a tool failure
  it("keeps explicit user refusals classified as user_reject", () => {
    const result = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "Bash",
      decision: "decline",
      toolInput: { command: "make" },
      toolUseID: "denied-build",
    });
    assert.equal(result.behavior, "deny");
    if (result.behavior !== "deny") return;
    assert.equal(result.decisionClassification, "user_reject");
    assert.equal(result.message, "User declined tool execution.");
    assert.equal(result.interrupt, undefined);

    // regression: #27854 bare feedback read to Claude as a tool error, not the user's words
    const withFeedback = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "Bash",
      decision: "decline",
      toolInput: { command: "make" },
      toolUseID: "denied-build",
      feedback: "  Use the dry-run flag first. ",
    });
    assert.equal(withFeedback.behavior, "deny");
    if (withFeedback.behavior !== "deny") return;
    assert.equal(withFeedback.decisionClassification, "user_reject");
    assert.equal(
      withFeedback.message,
      "The user declined this tool call and said:\nUse the dry-run flag first.",
    );
  });
});

describe("ClaudeAdapterV2 attachments", () => {
  it.effect.each([
    ...[
      "retained-images",
      "retained-text",
      "same-message-images",
      "retained-documents",
      "later-images",
      "partial-images",
      "cancelled-send",
      "cancelled-steer",
    ].map((budget) => ({
      name: budget,
      prompt: "Read this PDF.",
      expectedText: "Read this PDF.",
      command: undefined,
      ultrathink: false,
      resumed: false,
      budget,
    })),
    {
      name: "ordinary text",
      prompt: "What’s in this image?",
      expectedText: "Ultrathink:\nWhat’s in this image?",
      command: undefined,
      ultrathink: true,
      resumed: false,
      budget: "none",
    },
    {
      name: "mid-sentence skill",
      prompt: "please $implement fixes\n\nThen report the result",
      expectedText: "Ultrathink:\nplease /implement fixes\n\nThen report the result",
      command: "/implement fixes\n\nThen report the result",
      ultrathink: true,
      resumed: false,
      budget: "none",
    },
    {
      name: "prompt-leading skill",
      prompt: "$implement fixes",
      expectedText: "/implement fixes",
      command: undefined,
      ultrathink: false,
      resumed: false,
      budget: "none",
    },
    {
      name: "resumed history without persisted counters",
      prompt: "Inspect this file",
      expectedText: "Ultrathink:\nInspect this file",
      command: undefined,
      ultrathink: true,
      resumed: true,
      budget: "none",
    },
  ])(
    "preserves $name with native PDFs, images, and paths on sends and steering",
    ({ prompt, expectedText, command, ultrathink, resumed, budget }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const claudeHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "ankiel-claude-v2-skills-home-",
        });
        yield* fileSystem.makeDirectory(path.join(claudeHome, "skills", "implement"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(claudeHome, "skills", "implement", "SKILL.md"),
          "---\ndescription: Implement the requested change\n---\nImplement it.\n",
        );
        const modelSelection = {
          ...CLAUDE_TEST_MODEL_SELECTION,
          options: ultrathink ? CLAUDE_TEST_MODEL_SELECTION.options : [],
        };
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "ankiel-claude-v2-attachments-",
        });
        const offeredMessages: Array<SDKUserMessage> = [];
        let failOpen = false;
        let failOffer = false;
        let cancelAfterQueue = false;
        const queued = yield* Deferred.make<void>();
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: claudeHome },
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-attachments"),
            open: () =>
              Effect.gen(function* () {
                if (failOpen) {
                  failOpen = false;
                  return yield* new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                    method: "open",
                    cause: "rejected open",
                  });
                }
                const messages = yield* Queue.unbounded<SDKMessage>();
                return {
                  messages: Stream.fromQueue(messages),
                  offer: (message, onQueued) =>
                    Effect.suspend(() => {
                      if (failOffer) {
                        failOffer = false;
                        return Effect.fail(
                          new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                            method: "offer",
                            cause: "rejected offer",
                          }),
                        );
                      }
                      return Effect.sync(() => {
                        offeredMessages.push(message);
                        onQueued?.();
                      }).pipe(
                        Effect.andThen(() =>
                          cancelAfterQueue
                            ? Deferred.succeed(queued, undefined).pipe(Effect.andThen(Effect.never))
                            : Effect.void,
                        ),
                      );
                    }),
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  renameSession: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  mcpServerStatus: Effect.succeed([]),
                  readMcpResource: () => Effect.die("unexpected MCP resource read"),
                  callMcpTool: () => Effect.die("unexpected MCP tool call"),
                  mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
                  mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
                  reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
                  listPermissionRules: Effect.die("unexpected permission rules read"),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Queue.shutdown(messages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            subagentModel: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-attachments");
        const providerSessionId = ProviderSessionId.make("provider-session-claude-attachments");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId,
          modelSelection,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const attachment = ChatImageAttachment.make({
          type: "image",
          id: ChatAttachmentId.make(
            "thread-claude-attachments-12345678-1234-1234-1234-123456789abc",
          ),
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 4,
        });
        const document = ChatFileAttachment.make({
          type: "file",
          id: ChatAttachmentId.make(
            "thread-claude-attachments-abcdefab-1234-1234-1234-123456789abc",
          ),
          name: "requirements.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
        });
        yield* fileSystem.writeFile(
          path.join(attachmentsDir, attachmentRelativePath(attachment)!),
          Uint8Array.from([1, 2, 3, 4]),
        );
        const pdfBytes = Buffer.from(
          "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF",
        );
        yield* fileSystem.writeFile(
          path.join(attachmentsDir, attachmentRelativePath(document)!),
          pdfBytes,
        );
        const attemptId = RunAttemptId.make("attempt-claude-attachments");
        const now = yield* DateTime.now;

        const turnInput = {
          ...makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId,
            modelSelection,
            text: prompt,
            attachments: resumed ? [attachment] : [attachment, document],
          }),
          nativeThreadHasTurns: resumed,
        };
        if (budget === "cancelled-send" || budget === "cancelled-steer") {
          const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
          const pages = Buffer.from(
            `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 60 >> endobj\n${Array.from({ length: 60 }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n`,
          );
          yield* fileSystem.writeFile(
            documentPath,
            Buffer.concat([
              pages,
              Buffer.alloc(19 * 1024 * 1024 - pages.length - 5, 32),
              Buffer.from("%%EOF"),
            ]),
          );
          const message = { ...turnInput.message, attachments: [document] };
          if (budget === "cancelled-steer") {
            yield* runtime.startTurn({ ...turnInput, message: { ...message, attachments: [] } });
          }
          const deliver =
            budget === "cancelled-send"
              ? runtime.startTurn({ ...turnInput, message })
              : runtime.steerTurn({
                  threadId,
                  runId: turnInput.runId,
                  providerThread,
                  providerTurnId: idAllocator.derive.providerTurn({
                    driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                    nativeTurnId: `turn:${attemptId}`,
                  }),
                  message,
                });
          cancelAfterQueue = true;
          const delivering = yield* deliver.pipe(Effect.forkChild);
          yield* Deferred.await(queued);
          yield* Fiber.interrupt(delivering);
          const delivered = offeredMessages.at(-1)!.message.content;
          assert.include(JSON.stringify(delivered), '"type":"document"');
          cancelAfterQueue = false;
          if (budget === "cancelled-send") {
            yield* runtime.interruptTurn({
              providerThread,
              providerTurnId: idAllocator.derive.providerTurn({
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeTurnId: `turn:${attemptId}`,
              }),
            });
          }
          yield* deliver;
          const retried = offeredMessages.at(-1)!.message.content;
          assert.notInclude(JSON.stringify(retried), '"type":"document"');
          assert.include(JSON.stringify(retried), JSON.stringify(documentPath).slice(1, -1));
          assert.isBelow(Buffer.byteLength(JSON.stringify(offeredMessages)), 32_000_000);
          return;
        }
        if (budget !== "none") {
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${attemptId}`,
          });
          const imagePath = path.join(attachmentsDir, attachmentRelativePath(attachment)!);
          // The on-disk length deliberately disagrees with sizeBytes.
          yield* fileSystem.writeFile(imagePath, Buffer.alloc(4 * 1024 * 1024));
          if (["later-images", "partial-images"].includes(budget)) {
            const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
            yield* fileSystem.writeFile(
              documentPath,
              Buffer.concat([
                pdfBytes.subarray(0, -5),
                Buffer.alloc(
                  (budget === "later-images" ? 19 : 16) * 1024 * 1024 - pdfBytes.length,
                  32,
                ),
                Buffer.from("%%EOF"),
              ]),
            );
            yield* runtime.startTurn({
              ...turnInput,
              message: { ...turnInput.message, attachments: [document] },
            });
            assert.include(
              JSON.stringify(offeredMessages[0]!.message.content),
              '"type":"document"',
            );
            const message = { ...turnInput.message, attachments: [attachment, attachment] };
            yield* runtime.interruptTurn({ providerThread, providerTurnId });
            const laterAttemptId = RunAttemptId.make("attempt-claude-attachments-later");
            yield* runtime.startTurn({
              ...turnInput,
              attemptId: laterAttemptId,
              providerTurnOrdinal: 2,
              nativeThreadHasTurns: true,
              message,
            });
            const sent = offeredMessages.at(-1)!.message.content;
            assert.isArray(sent);
            assert.lengthOf(
              typeof sent === "string" ? [] : sent.filter((block) => block.type === "image"),
              budget === "partial-images" ? 1 : 0,
            );
            assert.include(JSON.stringify(sent), JSON.stringify(imagePath).slice(1, -1));
            yield* runtime.steerTurn({
              threadId,
              runId: RunId.make("run-claude-attachments"),
              providerThread,
              providerTurnId: idAllocator.derive.providerTurn({
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeTurnId: `turn:${laterAttemptId}`,
              }),
              message,
            });
            const steered = offeredMessages.at(-1)!.message.content;
            assert.isArray(steered);
            assert.lengthOf(
              typeof steered === "string" ? [] : steered.filter((block) => block.type === "image"),
              0,
            );
            assert.include(JSON.stringify(steered), JSON.stringify(imagePath).slice(1, -1));
            assert.isBelow(
              Buffer.byteLength(JSON.stringify(offeredMessages.map((message) => message.message))),
              32_000_000,
            );
            return;
          }
          if (budget === "retained-documents") {
            yield* fileSystem.writeFile(
              path.join(attachmentsDir, attachmentRelativePath(document)!),
              Buffer.concat([
                pdfBytes.subarray(0, pdfBytes.length - 5),
                Buffer.alloc(10 * 1024 * 1024, 32),
                Buffer.from("%%EOF"),
              ]),
            );
          }
          yield* runtime.startTurn({
            ...turnInput,
            message: {
              ...turnInput.message,
              text: budget === "retained-text" ? "x".repeat(10 * 1024 * 1024) : prompt,
              attachments:
                budget === "retained-text"
                  ? []
                  : budget === "retained-documents"
                    ? [document]
                    : [attachment, attachment],
            },
          });
          const largePdf = Buffer.concat([
            pdfBytes.subarray(0, pdfBytes.length - 5),
            Buffer.alloc(
              (budget === "retained-documents" ? 20 : 19) * 1024 * 1024 - pdfBytes.length,
              32,
            ),
            Buffer.from("%%EOF"),
          ]);
          const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
          yield* fileSystem.writeFile(documentPath, largePdf);
          yield* runtime.steerTurn({
            threadId,
            runId: RunId.make("run-claude-attachments"),
            providerThread,
            providerTurnId,
            message: {
              ...turnInput.message,
              attachments:
                budget === "same-message-images" ? [document, attachment, attachment] : [document],
            },
          });
          const sent = offeredMessages.at(-1)!.message.content;
          assert.isArray(sent);
          assert.lengthOf(
            typeof sent === "string" ? [] : sent.filter((block) => block.type === "document"),
            0,
            budget,
          );
          assert.include(JSON.stringify(sent), JSON.stringify(documentPath).slice(1, -1));
          return;
        }
        if (!resumed) {
          const undelivered = Buffer.from(
            `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 60 >> endobj\n${Array.from({ length: 60 }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n%%EOF`,
          );
          yield* fileSystem.writeFile(
            path.join(attachmentsDir, attachmentRelativePath(document)!),
            undelivered,
          );
          failOpen = true;
          assert.isTrue(Exit.isFailure(yield* runtime.startTurn(turnInput).pipe(Effect.exit)));
          assert.lengthOf(offeredMessages, 0);
          yield* fileSystem.writeFile(
            path.join(attachmentsDir, attachmentRelativePath(document)!),
            pdfBytes,
          );
        }
        yield* runtime.startTurn(turnInput);

        const expectedImageBlock = {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        } as const;
        const expectedDocumentBlock = {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: Buffer.from(pdfBytes).toString("base64"),
          },
        } as const;
        const expectedAttachmentPath = path.join(
          attachmentsDir,
          attachmentRelativePath(attachment)!,
        );
        const expectedDocumentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
        const attachmentNotes = `\n\n[Attached image "diagram.png" is saved at: ${expectedAttachmentPath}]${resumed ? "" : `\n\n[Attached file "requirements.pdf" is saved at: ${expectedDocumentPath}]`}`;
        const requestBlock = { type: "text" as const, text: expectedText + attachmentNotes };
        const expectedContent = command
          ? [
              requestBlock,
              expectedImageBlock,
              ...(!resumed ? [expectedDocumentBlock] : []),
              { type: "text" as const, text: command + attachmentNotes },
            ]
          : [expectedImageBlock, ...(!resumed ? [expectedDocumentBlock] : []), requestBlock];
        assert.deepEqual(offeredMessages[0]?.message.content, expectedContent);

        const providerTurnId = idAllocator.derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${attemptId}`,
        });
        yield* runtime.steerTurn({
          threadId,
          runId: RunId.make("run-claude-attachments"),
          providerThread,
          providerTurnId,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-claude-attachments-steer"),
            text: prompt,
            attachments: resumed ? [attachment] : [attachment, document],
          },
        });

        assert.equal(offeredMessages[1]?.priority, "next");
        assert.deepEqual(offeredMessages[1]?.message.content, expectedContent);
        const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
        for (const scenario of [
          "pages",
          "bytes",
          "invalid",
          "invalid-page-tree",
          "object-stream",
          "encrypted",
          "cyclic-tree",
          "unterminated-string",
          "missing-eof",
          "escaped-name",
          "incremental",
          "indirect-count",
          "indirect-type",
          "indirect-kids",
          "indirect-101-pages",
          "aggregate-pages",
          "retained-pages",
          "delivery-failure",
          "pasted-text",
          "text-only",
        ]) {
          let attachments: ReadonlyArray<ChatAttachment> = [document];
          if (
            ["pages", "aggregate-pages", "retained-pages", "delivery-failure"].includes(scenario)
          ) {
            const pages = scenario === "pages" ? 101 : scenario === "delivery-failure" ? 30 : 60;
            const large = Buffer.from(
              `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count ${pages} >> endobj\n${Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n%%EOF`,
            );
            yield* fileSystem.writeFile(documentPath, large);
            if (scenario === "aggregate-pages") {
              const second = {
                ...document,
                id: ChatAttachmentId.make("second-pdf"),
                name: "second.pdf",
              };
              yield* fileSystem.copyFile(
                documentPath,
                path.join(attachmentsDir, attachmentRelativePath(second)!),
              );
              attachments = [document, second];
            }
          } else if (scenario.startsWith("indirect-")) {
            const raw =
              scenario === "indirect-count" || scenario === "indirect-101-pages"
                ? `%PDF-1.7\n1 0 obj ${scenario === "indirect-count" ? 1 : 101} endobj\n2 0 obj << /Type /Catalog /Pages 3 0 R >> endobj\n3 0 obj << /Type /Pages /Count 1 0 R /Kids [${Array.from({ length: scenario === "indirect-count" ? 1 : 101 }, (_, i) => `${i + 4} 0 R`).join(" ")}] >> endobj\n4 0 obj << /Type /Page /Parent 3 0 R >> endobj\n${scenario === "indirect-count" ? "" : Array.from({ length: 100 }, (_, i) => `${i + 5} 0 obj << /Type 105 0 R /Parent 3 0 R >> endobj`).join("\n")}\n105 0 obj /Page endobj\n%%EOF`
                : scenario === "indirect-type"
                  ? pdfBytes
                      .toString()
                      .replace(
                        "%%EOF",
                        "4 0 obj << /Type 5 0 R >> endobj\n5 0 obj /Annot endobj\n%%EOF",
                      )
                  : pdfBytes
                      .toString()
                      .replace("/Kids [3 0 R]", "/Kids 4 0 R")
                      .replace("%%EOF", "4 0 obj [3 0 R] endobj\n%%EOF");
            yield* fileSystem.writeFileString(documentPath, raw);
          } else if (scenario === "bytes") {
            yield* fileSystem.truncate(documentPath, 20 * 1024 * 1024 + 1);
          } else if (scenario === "invalid") {
            yield* fileSystem.writeFileString(documentPath, "This is not a PDF");
          } else if (scenario === "invalid-page-tree") {
            const malformedBytes = Buffer.from(
              "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 42 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF",
            );
            yield* fileSystem.writeFile(documentPath, malformedBytes);
          } else if (["object-stream", "encrypted", "cyclic-tree"].includes(scenario)) {
            const suffix =
              scenario === "encrypted"
                ? "/Encrypt 9 0 R"
                : scenario === "cyclic-tree"
                  ? "/Count 0 /Kids [2 0 R]"
                  : "/Type /ObjStm /Filter /FlateDecode /Length 1000000000";
            yield* fileSystem.writeFile(
              documentPath,
              Buffer.concat([
                pdfBytes.subarray(0, pdfBytes.length - 5),
                Buffer.from(`\n4 0 obj << ${suffix} >> stream\nx\nendstream endobj\n%%EOF`),
              ]),
            );
          } else if (
            ["unterminated-string", "missing-eof", "escaped-name", "incremental"].includes(scenario)
          ) {
            const raw = pdfBytes.toString();
            yield* fileSystem.writeFileString(
              documentPath,
              scenario === "missing-eof"
                ? raw.slice(0, -5)
                : scenario === "escaped-name"
                  ? raw.replace("/Type /Page ", "/Type /Pa#67e ")
                  : raw.replace(
                      "%%EOF",
                      scenario === "incremental" ? "/Prev 42\n%%EOF" : "(unfinished\n%%EOF",
                    ),
            );
          } else if (scenario === "pasted-text") {
            yield* fileSystem.writeFile(documentPath, pdfBytes);
            attachments = [{ ...document, source: { _tag: "pasted-text" } }];
          } else {
            attachments = [];
            yield* fileSystem.remove(documentPath);
          }
          const steering = {
            threadId,
            runId: RunId.make("run-claude-attachments"),
            providerThread,
            providerTurnId,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make(`message-${scenario}`),
              text: "Continue.",
              attachments,
            },
          } satisfies ProviderAdapter.ProviderAdapterV2SteerInput;
          if (scenario === "delivery-failure") {
            failOffer = true;
            assert.isTrue(Exit.isFailure(yield* runtime.steerTurn(steering).pipe(Effect.exit)));
          }
          yield* runtime.steerTurn(steering);

          const sent = offeredMessages.at(-1)!.message.content;
          const documents =
            typeof sent === "string" ? [] : sent.filter((block) => block.type === "document");
          assert.lengthOf(
            documents,
            ["aggregate-pages", "delivery-failure"].includes(scenario) ? 1 : 0,
            scenario,
          );
          if (scenario === "text-only")
            assert.equal(sent, ultrathink ? "Ultrathink:\nContinue." : "Continue.");
          else assert.include(JSON.stringify(sent), JSON.stringify(documentPath).slice(1, -1));
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
});

function makeFakeClaudeCli(answerSetServers = true) {
  const spawns: Array<SpawnOptions> = [];
  const controlRequests: Array<object> = [];
  const stdins: Array<NodeStream.PassThrough> = [];
  const spawn = (options: SpawnOptions): SpawnedProcess => {
    spawns.push(options);
    const stdin = new NodeStream.PassThrough();
    const stdout = new NodeStream.PassThrough();
    stdins.push(stdin);
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      killed: false,
      exitCode: null as number | null,
      kill: () => {
        stdout.end();
        child.emit("exit", null, "SIGTERM");
        return true;
      },
    });
    let pending = "";
    stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (frame.type !== "control_request") continue;
        controlRequests.push(frame.request);
        const setServers = frame.request.subtype === "mcp_set_servers";
        if (setServers && !answerSetServers) continue;
        const response = {
          subtype: "success",
          request_id: frame.request_id,
          response: setServers ? { added: [], removed: [], errors: {} } : {},
        };
        stdout.write(`${JSON.stringify({ type: "control_response", response })}\n`);
      }
    });
    stdin.on("end", () => {
      stdout.end();
      child.emit("exit", 0, null);
    });
    return child;
  };
  const closed = () => stdins.length > 0 && stdins.every((stdin) => stdin.writableEnded);
  return { spawn, spawns, controlRequests, closed };
}

describe("ClaudeAdapterV2 MCP credential channel", () => {
  const ankielMcpServer = {
    type: "http" as const,
    url: "http://127.0.0.1:43123/mcp",
    headers: { Authorization: "Bearer dummy-mcp-credential" },
  };
  const openWith = (
    cli: ReturnType<typeof makeFakeClaudeCli>,
    native?: ProviderEventLoggers.EventNdjsonLogger,
  ) =>
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      return yield* runner.open({
        threadId: ThreadId.make("thread-claude-mcp-channel"),
        providerSessionId: ProviderSessionId.make("provider-session-claude-mcp-channel"),
        options: {
          ...ClaudeAdapterV2.makeClaudeQueryOptions({
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            nativeThreadId: "native-thread-claude-mcp-channel",
            title: "Existing Ankiel title",
            resume: false,
            cwd: null,
            environment: { PATH: "/usr/bin" },
            mcpServers: { "ankiel-code": ankielMcpServer },
          }),
          pathToClaudeCodeExecutable: "/opt/claude/cli.js",
          spawnClaudeCodeProcess: cli.spawn,
        },
      });
    }).pipe(
      Effect.provide(ClaudeAdapterV2.layerQueryRunner.pipe(Layer.provide(PortScanner.layerTest))),
      Effect.provideService(ProviderEventLoggers.ProviderEventLoggers, {
        ...ProviderEventLoggers.NoOpProviderEventLoggers,
        native,
      }),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );

  it.effect("sends MCP servers over stdin, not argv or the environment", () =>
    Effect.gen(function* () {
      const cli = makeFakeClaudeCli();
      const session = yield* openWith(cli);
      yield* session.close;

      assert.deepInclude(cli.controlRequests, {
        subtype: "mcp_set_servers",
        servers: { "ankiel-code": ankielMcpServer },
      });
      assert.deepInclude(
        cli.controlRequests.find((request) => Reflect.get(request, "subtype") === "initialize"),
        { title: "Existing Ankiel title" },
      );
      const spawned = JSON.stringify(cli.spawns);
      assert.notInclude(spawned, "--title");
      assert.notInclude(spawned, "--mcp-config");
      assert.notInclude(spawned, "dummy-mcp-credential");
    }),
  );
});

describe("ClaudeAdapterV2 native session identity", () => {
  const openTurnWithOrdinal = (
    providerTurnOrdinal: number,
    nativeThreadHasTurns?: boolean,
    importedNativeThreadId?: string,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "ankiel-claude-v2-session-identity-",
        });
        if (importedNativeThreadId !== undefined) {
          // An unreadable copy in another project must not hide the readable one.
          yield* fileSystem.makeDirectory(
            path.join(attachmentsDir, "projects", "-other", `${importedNativeThreadId}.jsonl`),
            { recursive: true },
          );
          const projectDir = path.join(attachmentsDir, "projects", "-workspace");
          yield* fileSystem.makeDirectory(projectDir, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(projectDir, `${importedNativeThreadId}.jsonl`),
            `{"type":"user","message":{"role":"user","content":"hello"},"sessionId":"${importedNativeThreadId}"}\n`,
          );
        }
        const openedQueries: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: { CLAUDE_CONFIG_DIR: attachmentsDir },
          attachmentsDir,
          fileSystem,
          path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-session-identity"),
            open: (input) =>
              Effect.sync(() => {
                openedQueries.push(input);
                return {
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  renameSession: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  mcpServerStatus: Effect.succeed([]),
                  readMcpResource: () => Effect.die("unexpected MCP resource read"),
                  callMcpTool: () => Effect.die("unexpected MCP tool call"),
                  mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
                  mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
                  reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
                  listPermissionRules: Effect.die("unexpected permission rules read"),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            subagentModel: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-session-identity");
        const providerSessionId = ProviderSessionId.make("provider-session-claude-identity");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const now = yield* DateTime.now;
        // Mirrors the provider thread a session import records: a strong native
        // ref with no conversation head and no provider turns.
        const providerThread =
          importedNativeThreadId === undefined
            ? yield* runtime.ensureThread({
                threadId,
                modelSelection: CLAUDE_TEST_MODEL_SELECTION,
                runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
              })
            : yield* runtime.resumeThread({
                threadId,
                modelSelection: CLAUDE_TEST_MODEL_SELECTION,
                runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
                providerThread: {
                  id: idAllocator.derive.providerThread({
                    driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                    providerInstanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
                    nativeThreadId: importedNativeThreadId,
                  }),
                  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                  providerInstanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
                  providerSessionId: null,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                    nativeId: importedNativeThreadId,
                    strength: "strong",
                  },
                  nativeConversationHeadRef: null,
                  status: "not_loaded",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  contextUsage: null,
                  nativeMetadata: null,
                  goal: null,
                  createdAt: now,
                  updatedAt: now,
                },
              });
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("run-attempt-claude-session-identity"),
            text: "Respond with identity ok",
            attachments: [],
            providerTurnOrdinal,
            ...(nativeThreadHasTurns === undefined ? {} : { nativeThreadHasTurns }),
          }),
        );
        return openedQueries;
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

  it.effect(
    "resumes the native session on a fresh session instance when prior provider turns exist",
    () =>
      Effect.gen(function* () {
        const openedQueries = yield* openTurnWithOrdinal(2);
        assert.equal(openedQueries.length, 1);
        assert.equal(openedQueries[0]?.options.resume, "native-session-identity");
        assert.equal(openedQueries[0]?.options.sessionId, undefined);
        assert.equal(openedQueries[0]?.options.title, "Claude attachment test");
      }),
  );
});

describe("ClaudeAdapterV2 background wake turns", () => {
  const WAKE_NATIVE_SESSION = "native-thread-claude-wake";
  const WAKE_TASK_ID = "bdqirlcyw";
  const WAKE_TOOL_USE_ID = "toolu_01Rs6JNNf5SqHRxpq5DeJHrW";
  const WAKE_TASK_DESCRIPTION = "Background sleep test";
  const WAKE_SUMMARY = 'Background command "Background sleep test" completed (exit code 0)';
  const WAKE_ASSISTANT_TEXT = "WAKE_DONE";
  const WAKE_RESULT_TEXT = "WAKE_DONE";

  function claudeSdkFrame(frame: unknown): SDKMessage {
    if (
      typeof frame !== "object" ||
      frame === null ||
      typeof Reflect.get(frame, "type") !== "string"
    ) {
      throw new Error("Frame is not a Claude Agent SDK message.");
    }
    return frame as SDKMessage;
  }

  const wakeTaskStarted = claudeSdkFrame({
    type: "system",
    subtype: "task_started",
    task_id: WAKE_TASK_ID,
    tool_use_id: WAKE_TOOL_USE_ID,
    description: WAKE_TASK_DESCRIPTION,
    is_backgrounded: true,
    task_type: "local_bash",
    uuid: "00000000-0000-4000-8000-000000000101",
    session_id: WAKE_NATIVE_SESSION,
  });
  const makeAssistantTextFrame = (input: {
    readonly uuid: string;
    readonly text: string;
    readonly model?: string;
  }) =>
    claudeSdkFrame({
      type: "assistant",
      message: {
        model: input.model ?? "claude-sonnet-4-6",
        id: `msg_${input.uuid}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: input.text }],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const makeResultFrame = (input: {
    readonly uuid: string;
    readonly result: string;
    readonly numTurns?: number;
    readonly origin?: { readonly kind: "task-notification" };
    readonly subtype?: string;
    readonly isError?: boolean;
    readonly errors?: ReadonlyArray<string>;
    readonly apiErrorStatus?: number;
    // null omits the field, as the CLI does on a zero-turn result.
    readonly terminalReason?: SDKResultMessage["terminal_reason"] | null;
    readonly usage?: {
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly cache_creation_input_tokens: number;
      readonly cache_read_input_tokens: number;
    };
    readonly modelUsage?: SDKResultMessage["modelUsage"];
  }) =>
    claudeSdkFrame({
      type: "result",
      subtype: input.subtype ?? "success",
      duration_ms: 10,
      duration_api_ms: 10,
      is_error: input.isError ?? false,
      num_turns: input.numTurns ?? 1,
      result: input.result,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: input.usage ?? {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: input.modelUsage ?? {},
      permission_denials: [],
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.errors === undefined ? {} : { errors: input.errors }),
      ...(input.apiErrorStatus === undefined ? {} : { api_error_status: input.apiErrorStatus }),
      ...(input.terminalReason === null
        ? {}
        : { terminal_reason: input.terminalReason ?? "completed" }),
    });
  const turnOneResult = makeResultFrame({
    uuid: "00000000-0000-4000-8000-000000000102",
    result: "Kicked off the build in the background.",
  });
  const wakeNotification = claudeSdkFrame({
    type: "system",
    subtype: "task_notification",
    task_id: WAKE_TASK_ID,
    tool_use_id: WAKE_TOOL_USE_ID,
    status: "completed",
    output_file: `/tmp/claude-replay/tasks/${WAKE_TASK_ID}.output`,
    summary: WAKE_SUMMARY,
    uuid: "00000000-0000-4000-8000-000000000103",
    session_id: WAKE_NATIVE_SESSION,
  });
  const wakeAssistant = makeAssistantTextFrame({
    uuid: "00000000-0000-4000-8000-000000000107",
    text: WAKE_ASSISTANT_TEXT,
  });
  const wakeResult = makeResultFrame({
    uuid: "00000000-0000-4000-8000-000000000104",
    result: WAKE_RESULT_TEXT,
    origin: { kind: "task-notification" },
  });

  // Harnesses notify after every recorded event, continuation, or prompt, so a
  // wait re-checks exactly when the state it reads changes. Subscribing before
  // the first check means a change that lands in between is not lost.
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

  // Fixed quiet windows for asserting that nothing happens after input the
  // harness cannot observe being handled (a shut-down query, a replaced process).
  const yieldTicks = (ticks: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let tick = 0; tick < ticks; tick++) yield* Effect.yieldNow;
    });

  const makeWakeHarnessWithOptions = (options?: {
    readonly close?: (sdkMessages: Queue.Queue<SDKMessage>) => Effect.Effect<void>;
    readonly interrupt?: Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
    readonly setPermissionMode?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["setPermissionMode"];
    readonly setModel?: (
      model: string,
      offerAndWait: (message: SDKMessage) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly renameSession?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["renameSession"];
    readonly applyFlagSettings?: ClaudeAdapterV2.ClaudeAgentSdkQuerySession["applyFlagSettings"];
    readonly stopTask?: (
      taskId: string,
    ) => Effect.Effect<void, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
    readonly backgroundTasks?: (
      toolUseId: string,
    ) => Effect.Effect<boolean, ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError>;
    readonly mcp?: Pick<
      ClaudeAdapterV2.ClaudeAgentSdkQuerySession,
      "mcpServerStatus" | "readMcpResource" | "callMcpTool"
    > &
      Partial<Pick<ClaudeAdapterV2.ClaudeAgentSdkQuerySession, "listPermissionRules">>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly onSessionInit?: (cwd: string) => Effect.Effect<void>;
    readonly subagentLaunchToolUseId?: string;
    readonly subagentModel?: string;
    readonly nativeSessionId?: string;
    readonly settings?: ClaudeSettings;
    readonly modelCatalog?: Effect.Effect<ClaudeModelCatalog>;
    readonly freshQueueOnReopen?: boolean;
    readonly forkSession?: ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerShape["forkSession"];
    readonly allocateSessionId?: Effect.Effect<string>;
    readonly offer?: (message: SDKUserMessage) => Effect.Effect<void>;
    readonly promptSuggestions?: boolean;
    readonly routeModelCatalog?: ClaudeAdapterV2.ClaudeAdapterV2Options["routeModelCatalog"];
  }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ankiel-claude-v2-wake-",
      });
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const processQueues: Array<Queue.Queue<SDKMessage>> = [];
      const processedMessages = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
      const offerAndWait = Effect.fnUntraced(function* (
        message: SDKMessage,
        offered?: Deferred.Deferred<void>,
      ) {
        const processed = yield* Deferred.make<void>();
        processedMessages.set(message, processed);
        yield* Queue.offer(processQueues.at(-1) ?? sdkMessages, message);
        if (offered !== undefined) yield* Deferred.succeed(offered, undefined);
        yield* Deferred.await(processed);
      });
      const changes = yield* makeChangeSignal;
      const offeredMessages: Array<SDKUserMessage> = [];
      const permissionModeChanges: Array<string> = [];
      const renameCalls: Array<string> = [];
      const liveSelectionChanges: Array<unknown> = [];
      const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
        [];
      const continuationReceipts =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const terminalReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>
        >();
      const subagentReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "subagent.updated" }>
        >();
      const systemNoticeReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>
        >();
      const runtimeRequestReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
        >();
      const planReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "plan.updated" }>
        >();
      const providerThreadReceipts =
        yield* Queue.unbounded<
          Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "provider_thread.updated" }>
        >();
      let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
        settings: options?.settings ?? DEFAULT_CLAUDE_SETTINGS,
        ...(options?.modelCatalog === undefined ? {} : { modelCatalog: options.modelCatalog }),
        environment: options?.environment ?? {},
        attachmentsDir,
        fileSystem,
        path: yield* Path.Path,
        random: yield* SecureRandom.SecureRandom,
        idAllocator,
        ...(options?.onSessionInit ? { onSessionInit: options.onSessionInit } : {}),
        ...(options?.routeModelCatalog ? { routeModelCatalog: options.routeModelCatalog } : {}),
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => {
              continuationRequests.push(request);
            }).pipe(
              Effect.andThen(Queue.offer(continuationReceipts, request)),
              Effect.andThen(changes.notify),
            ),
        },
        queryRunner: {
          allocateSessionId:
            options?.allocateSessionId ??
            Effect.succeed(options?.nativeSessionId ?? WAKE_NATIVE_SESSION),
          open: (input) =>
            Effect.gen(function* () {
              openedOptions = input.options;
              const processMessages =
                options?.freshQueueOnReopen === true && processQueues.length > 0
                  ? yield* Queue.unbounded<SDKMessage>()
                  : sdkMessages;
              const messages = Stream.fromQueue(processMessages).pipe(
                Stream.flatMap((message) =>
                  Stream.make(message).pipe(
                    Stream.concat(
                      Stream.fromEffect(
                        Effect.suspend(() => {
                          const processed = processedMessages.get(message);
                          return processed === undefined
                            ? Effect.void
                            : Deferred.succeed(processed, undefined);
                        }),
                      ).pipe(Stream.drain),
                    ),
                  ),
                ),
              );
              if (options?.freshQueueOnReopen === true && processQueues.length > 0) {
                processQueues.push(processMessages);
                return {
                  messages,
                  offer: (message: SDKUserMessage) =>
                    Effect.sync(() => {
                      offeredMessages.push(message);
                    }).pipe(Effect.andThen(changes.notify)),
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: (mode) =>
                    Effect.sync(() => {
                      permissionModeChanges.push(mode);
                    }).pipe(
                      Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void),
                    ),
                  renameSession: (title) =>
                    Effect.sync(() => {
                      renameCalls.push(title);
                    }).pipe(Effect.andThen(() => options?.renameSession?.(title) ?? Effect.void)),
                  backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
                  mcpServerStatus: Effect.succeed([]),
                  readMcpResource: () => Effect.die("unexpected MCP resource read"),
                  callMcpTool: () => Effect.die("unexpected MCP tool call"),
                  mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
                  mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
                  reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
                  listPermissionRules: Effect.die("unexpected permission rules read"),
                  stopTask: options?.stopTask ?? (() => Effect.void),
                  interrupt: Effect.void,
                  close: Queue.shutdown(processMessages),
                };
              }
              processQueues.push(sdkMessages);
              return {
                messages,
                offer: (message) =>
                  Effect.sync(() => {
                    offeredMessages.push(message);
                  }).pipe(
                    Effect.andThen(changes.notify),
                    Effect.andThen(options?.offer?.(message) ?? Effect.void),
                  ),
                setModel: (model) =>
                  Effect.sync(() => {
                    liveSelectionChanges.push({ model });
                  }).pipe(
                    Effect.andThen(() => options?.setModel?.(model, offerAndWait) ?? Effect.void),
                  ),
                applyFlagSettings: (settings) =>
                  Effect.sync(() => {
                    liveSelectionChanges.push(settings);
                  }).pipe(
                    Effect.andThen(() => options?.applyFlagSettings?.(settings) ?? Effect.void),
                  ),
                setPermissionMode: (mode) =>
                  Effect.sync(() => {
                    permissionModeChanges.push(mode);
                  }).pipe(Effect.andThen(() => options?.setPermissionMode?.(mode) ?? Effect.void)),
                renameSession: (title) =>
                  Effect.sync(() => {
                    renameCalls.push(title);
                  }).pipe(Effect.andThen(() => options?.renameSession?.(title) ?? Effect.void)),
                backgroundTasks: options?.backgroundTasks ?? (() => Effect.succeed(false)),
                mcpServerStatus: options?.mcp?.mcpServerStatus ?? Effect.succeed([]),
                readMcpResource:
                  options?.mcp?.readMcpResource ??
                  (() => Effect.die("unexpected MCP resource read")),
                callMcpTool:
                  options?.mcp?.callMcpTool ?? (() => Effect.die("unexpected MCP tool call")),
                mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
                mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
                reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
                listPermissionRules: options?.mcp?.listPermissionRules ?? Effect.succeed([]),
                stopTask: options?.stopTask ?? (() => Effect.void),
                interrupt: options?.interrupt ?? Effect.void,
                close: options?.close?.(sdkMessages) ?? Effect.void,
              };
            }),
          forkSession: options?.forkSession ?? (() => Effect.die("unused forkSession")),
          subagentLaunchToolUseId: () => Effect.succeed(options?.subagentLaunchToolUseId ?? null),
          subagentModel: () => Effect.succeed(options?.subagentModel ?? null),
          assertComplete: Effect.void,
        },
      });
      const threadId = ThreadId.make("thread-claude-wake");
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-claude-wake"),
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        promptSuggestions: Effect.succeed(options?.promptSuggestions === true),
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
      });
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            events.push(event);
            if (event.type === "subagent.updated") {
              yield* Queue.offer(subagentReceipts, event);
            }
            if (event.type === "turn.terminal") {
              yield* Queue.offer(terminalReceipts, event);
            }
            if (event.type === "runtime_request.updated") {
              yield* Queue.offer(runtimeRequestReceipts, event);
            }
            if (event.type === "plan.updated") {
              yield* Queue.offer(planReceipts, event);
            }
            if (event.type === "provider_thread.updated") {
              yield* Queue.offer(providerThreadReceipts, event);
            }
            if (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") {
              yield* Queue.offer(systemNoticeReceipts, event);
            }
            yield* changes.notify;
          }),
        ),
        Effect.forkScoped,
      );
      if (runtime.hasPendingBackgroundWork === undefined) {
        throw new Error("Claude adapter runtime must expose hasPendingBackgroundWork.");
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const terminalEvents = () =>
        events.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        );
      return {
        adapter,
        attachmentsDir,
        runtime,
        providerThread,
        threadId,
        sdkMessages,
        processQueues,
        offerAndWait,
        offeredMessages,
        promptUuid: (index: number) => {
          const uuid = offeredMessages[index]?.uuid;
          if (uuid === undefined) throw new Error(`No prompt offered at index ${index}.`);
          return uuid;
        },
        permissionModeChanges,
        renameCalls,
        liveSelectionChanges,
        continuationRequests,
        continuationReceipts,
        events,
        terminalReceipts,
        subagentReceipts,
        systemNoticeReceipts,
        runtimeRequestReceipts,
        planReceipts,
        providerThreadReceipts,
        getOpenedOptions: () => openedOptions,
        terminalEvents,
        hasPendingBackgroundWork,
        until: changes.until,
        awaitTerminal: (count: number) => changes.until(() => terminalEvents().length >= count),
        awaitContinuation: (count: number) =>
          changes.until(() => continuationRequests.length >= count),
      };
    });
  const makeWakeHarness = makeWakeHarnessWithOptions();

  it.effect("resumes the session a /clear selected after the Claude process is replaced", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions({
        freshQueueOnReopen: true,
        close: (queue) => Queue.shutdown(queue),
      });
      const turn = (ordinal: number, providerThread: OrchestrationV2ProviderThread) =>
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread,
          now: DateTime.makeUnsafe(0),
          attemptId: RunAttemptId.make(`clear-session-${ordinal}`),
          text: ordinal === 1 ? "/clear" : "Continue the cleared conversation",
          attachments: [],
          providerTurnOrdinal: ordinal,
        });
      yield* harness.runtime.startTurn(turn(1, harness.providerThread));
      // Claude Code reports the session /clear started in its next init frame.
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "system",
          subtype: "init",
          session_id: "cleared-native-session",
          uuid: "00000000-0000-4000-8000-000000000501",
        }),
      );
      yield* harness.offerAndWait(turnOneResult);
      yield* Queue.take(harness.terminalReceipts);
      const latest = (): OrchestrationV2ProviderThread => {
        const event = harness.events.findLast(
          (candidate) => candidate.type === "provider_thread.updated",
        );
        return event?.type === "provider_thread.updated"
          ? event.providerThread
          : harness.providerThread;
      };
      assert.equal(latest().nativeThreadRef?.nativeId, "cleared-native-session");
      yield* harness.runtime.interruptTurn({
        providerThread: latest(),
        providerTurnId: lastProviderTurn(harness.events).id,
        requestRuntimeRestart: true,
      });
      yield* harness.runtime.startTurn(turn(2, latest()));
      assert.equal(harness.processQueues.length, 2);
      assert.equal(harness.getOpenedOptions()?.resume, "cleared-native-session");
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

  // regression: #23948 Claude holds a steer behind a running foreground tool
  // call and goes silent, so each steer stays pending until Claude starts it.
  it.effect("keeps a steer pending until Claude starts it", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const attemptId = RunAttemptId.make("attempt-steer-waiting");
      const input = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId,
        text: "Run the slow build.",
        attachments: [],
      });
      yield* harness.runtime.startTurn(input);
      const steer = (id: string) =>
        harness.runtime.steerTurn({
          threadId: harness.threadId,
          runId: input.runId,
          providerThread: harness.providerThread,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${attemptId}`,
          }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make(id),
            text: `Steer ${id}`,
            attachments: [],
          },
        });
      yield* steer("message-steer-read");
      yield* steer("message-steer-unread");
      const steerStatuses = () => {
        const latest = new Map<string, string>();
        for (const event of harness.events) {
          if (event.type === "steer.updated") latest.set(event.messageId, event.status);
        }
        return Object.fromEntries(latest);
      };
      const expectSteers = (expected: Record<string, string>) =>
        harness
          .until(() => JSON.stringify(steerStatuses()) === JSON.stringify(expected))
          .pipe(Effect.andThen(Effect.sync(() => assert.deepEqual(steerStatuses(), expected))));

      // Claude keeps streaming the foreground tool's turn; once its text is
      // recorded, anything the steers emitted before it is recorded too.
      yield* harness.offerAndWait(
        makeAssistantTextFrame({
          uuid: "00000000-0000-4000-8000-000000002392",
          text: "Still building.",
        }),
      );
      yield* harness.until(() =>
        harness.events.some(
          (event) => event.type === "message.updated" && event.message.text === "Still building.",
        ),
      );
      assert.deepEqual(steerStatuses(), {
        "message-steer-read": "pending",
        "message-steer-unread": "pending",
      });

      const lifecycle = (index: number, state: string, uuid: string) =>
        harness.offerAndWait(
          claudeSdkFrame({
            type: "command_lifecycle",
            command_uuid: harness.promptUuid(index),
            state,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
      // Claude completes prompts it never started, so completed alone is not
      // proof it read one.
      yield* lifecycle(2, "completed", "00000000-0000-4000-8000-000000002393");
      yield* lifecycle(1, "started", "00000000-0000-4000-8000-000000002394");
      yield* expectSteers({
        "message-steer-read": "completed",
        "message-steer-unread": "pending",
      });

      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002395", result: "Built." }),
          user_message_uuid: harness.promptUuid(0),
        }),
      );
      // Claude answers the unread steer as its next native turn, which belongs to this turn.
      assert.equal(harness.terminalEvents().length, 0);
      yield* expectSteers({
        "message-steer-read": "completed",
        "message-steer-unread": "pending",
      });
      const decision = yield* Effect.promise(() =>
        harness.getOpenedOptions()!.canUseTool!(
          "Read",
          { file_path: "README.md" },
          {
            signal: new AbortController().signal,
            toolUseID: "steer-read",
            requestId: "request-steer-read",
          },
        ),
      ).pipe(Effect.forkScoped);
      const first = yield* Effect.raceFirst(
        Queue.take(harness.runtimeRequestReceipts).pipe(Effect.as("request")),
        Fiber.join(decision).pipe(Effect.map((result) => result?.behavior)),
      );
      assert.notEqual(first, "deny");
      yield* harness.offerAndWait(
        makeAssistantTextFrame({
          uuid: "00000000-0000-4000-8000-000000002397",
          text: "Steer reply.",
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002398", result: "Done." }),
          user_message_uuid: harness.promptUuid(2),
        }),
      );
      yield* harness.awaitTerminal(1);
      assert.equal(harness.terminalEvents()[0]?.status, "completed");
      assert.ok(
        harness.events.some(
          (event) => event.type === "message.updated" && event.message.text === "Steer reply.",
        ),
      );
      yield* expectSteers({
        "message-steer-read": "completed",
        "message-steer-unread": "completed",
      });
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

  it.effect("keeps both result-only replies of a steered turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const attemptId = RunAttemptId.make("attempt-steer-result-only");
      const input = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId,
        text: "Run the build.",
        attachments: [],
      });
      yield* harness.runtime.startTurn(input);
      yield* harness.runtime.steerTurn({
        threadId: harness.threadId,
        runId: input.runId,
        providerThread: harness.providerThread,
        providerTurnId: idAllocator.derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${attemptId}`,
        }),
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-steer-result-only"),
          text: "Steer",
          attachments: [],
        },
      });
      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002510", result: "Built." }),
          user_message_uuid: harness.promptUuid(0),
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          type: "command_lifecycle",
          command_uuid: harness.promptUuid(1),
          state: "started",
          uuid: "00000000-0000-4000-8000-000000002511",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* harness.offerAndWait(
        claudeSdkFrame({
          ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000002512", result: "Done." }),
          user_message_uuid: harness.promptUuid(1),
        }),
      );
      yield* harness.awaitTerminal(1);
      const replies = harness.events.flatMap((event) =>
        event.type === "message.updated" && event.message.role === "assistant"
          ? [event.message.text]
          : [],
      );
      assert.equal(replies.at(-1), "Built.\n\nDone.");
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

  // regression: #17270 root text_delta frames stream the reply before the block's snapshot
  it.effect("streams Claude assistant text deltas before the completed snapshot", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("text-stream-attempt"),
          text: "Write two paragraphs",
          attachments: [],
        }),
      );
      const stream = (event: unknown) =>
        claudeSdkFrame({
          type: "stream_event",
          event,
          parent_tool_use_id: null,
          session_id: WAKE_NATIVE_SESSION,
          uuid: "stream-frame",
        });
      yield* harness.offerAndWait(
        stream({ type: "message_start", message: { id: "text-message" } }),
      );
      yield* harness.offerAndWait(
        stream({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
      yield* harness.offerAndWait(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "First paragraph.\n\n" },
        }),
      );
      yield* harness.offerAndWait(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Second paragraph." },
        }),
      );
      yield* harness.offerAndWait(stream({ type: "content_block_stop", index: 0 }));
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "assistant",
          uuid: "text-snapshot",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            id: "text-message",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "First paragraph.\n\nSecond paragraph." }],
          },
        }),
      );
      yield* Queue.offer(harness.sdkMessages, makeResultFrame({ uuid: "text-result", result: "" }));
      yield* Queue.take(harness.terminalReceipts);
      const replies = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
          ? [event.turnItem]
          : [],
      );
      // The stream's own item carries the reply; the block's snapshot does not repeat it.
      assert.deepEqual(
        [...new Set(replies.map((item) => item.nativeItemRef?.nativeId))],
        ["text-message:text:0"],
      );
      assert.equal(replies.at(-1)?.text, "First paragraph.\n\nSecond paragraph.");
      assert.equal(replies.at(-1)?.status, "completed");
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

  const lastProviderTurn = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
    const event = events.findLast((candidate) => candidate.type === "provider_turn.updated");
    if (event?.type !== "provider_turn.updated") {
      throw new Error("Expected a provider turn update.");
    }
    return event.providerTurn;
  };

  it.effect.each([
    { kind: "fork with inherited head", fork: true, headMessageId: "remapped-inherited-head" },
    { kind: "fork without recorded head", fork: true, headMessageId: undefined },
    { kind: "ordinary thread", fork: false, headMessageId: undefined },
  ])("rolls back the first run of a $kind", ({ fork, headMessageId }) =>
    Effect.gen(function* () {
      let allocations = 0;
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) => Queue.shutdown(sdkMessages),
        freshQueueOnReopen: true,
        allocateSessionId: Effect.sync(() =>
          allocations++ === 0 ? WAKE_NATIVE_SESSION : "fresh-native-session",
        ),
        forkSession: () =>
          Effect.succeed({
            sessionId: WAKE_NATIVE_SESSION,
            ...(headMessageId === undefined ? {} : { headMessageId }),
          }),
      });
      const providerThread = fork
        ? yield* harness.runtime.forkThread({
            sourceProviderThread: {
              ...harness.providerThread,
              nativeThreadRef: {
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeId: "source-native-session",
                strength: "strong",
              },
            },
            targetThreadId: harness.threadId,
          })
        : harness.providerThread;
      const turnInput = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("first-run"),
        text: "This run will be rolled back.",
        attachments: [],
        nativeThreadHasTurns: false,
      });
      yield* harness.runtime.startTurn(turnInput);
      yield* harness.offerAndWait(
        makeAssistantTextFrame({ uuid: "own-run-message", text: "Discard this answer." }),
      );
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: "own-run-result", result: "Discard this answer." }),
      );
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
      const completed = harness.events.findLast(
        (event) => event.type === "provider_thread.updated",
      );
      assert.equal(completed?.type, "provider_thread.updated");
      if (completed?.type !== "provider_thread.updated") return;
      assert.equal(completed.providerThread.firstRunOrdinal, 1);

      const rolledBack = yield* harness.runtime.rollbackThread({
        providerThread: completed.providerThread,
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-before-first-run"),
          appRunOrdinal: 0,
        },
        providerThreadTurns: [lastProviderTurn(harness.events)],
      });
      assert.equal(
        rolledBack.providerThread.forkedFrom?.providerThreadId,
        providerThread.forkedFrom?.providerThreadId,
      );
      yield* harness.runtime.startTurn({
        ...turnInput,
        attemptId: RunAttemptId.make("after-rollback"),
        providerThread: rolledBack.providerThread,
        providerTurnOrdinal: 2,
        nativeThreadHasTurns: false,
      });
      const options = harness.getOpenedOptions();
      assert.equal(harness.processQueues.length, 2);
      if (headMessageId !== undefined) {
        assert.equal(rolledBack.providerThread.nativeThreadRef?.nativeId, WAKE_NATIVE_SESSION);
        assert.equal(rolledBack.providerThread.nativeConversationHeadRef?.nativeId, headMessageId);
        assert.equal(options?.resume, WAKE_NATIVE_SESSION);
        assert.equal(options?.resumeSessionAt, headMessageId);
        assert.isUndefined(options?.sessionId);
      } else {
        assert.equal(rolledBack.providerThread.nativeThreadRef?.nativeId, "fresh-native-session");
        assert.isNull(rolledBack.providerThread.nativeConversationHeadRef);
        assert.equal(options?.sessionId, "fresh-native-session");
        assert.isUndefined(options?.resume);
        assert.isUndefined(options?.resumeSessionAt);
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

  it.effect("an interrupted turn after a rollback stops resuming at the rolled-back head", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) => Queue.shutdown(sdkMessages),
        freshQueueOnReopen: true,
      });
      const now = yield* DateTime.now;
      const pinnedHead = "00000000-0000-4000-8000-000000025510";
      const pinnedThread = {
        ...harness.providerThread,
        nativeConversationHeadRef: {
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeId: pinnedHead,
          strength: "weak" as const,
        },
      };
      const interruptedInput = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: pinnedThread,
        now,
        attemptId: RunAttemptId.make("attempt-claude-interrupt-after-rollback"),
        text: "The secret word is apricot-25510. Then run sleep 60.",
        attachments: [],
        providerTurnOrdinal: 2,
        nativeThreadHasTurns: true,
      });
      yield* harness.runtime.startTurn(interruptedInput);
      assert.equal(harness.getOpenedOptions()?.resumeSessionAt, pinnedHead);
      yield* harness.offerAndWait(
        makeAssistantTextFrame({
          uuid: "00000000-0000-4000-8000-000000025511",
          text: "Noted apricot-25510. Running sleep.",
        }),
      );
      yield* harness.runtime.interruptTurn({
        providerThread: pinnedThread,
        providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${interruptedInput.attemptId}`,
        }),
      });
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");
      const afterInterrupt = harness.events.findLast(
        (event) => event.type === "provider_thread.updated",
      )?.providerThread;
      assert.isDefined(afterInterrupt);
      assert.isNull(afterInterrupt.nativeConversationHeadRef);

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: afterInterrupt,
          now,
          attemptId: RunAttemptId.make("attempt-claude-after-interrupt"),
          text: "What is the secret word?",
          attachments: [],
          providerTurnOrdinal: 3,
          nativeThreadHasTurns: true,
        }),
      );
      assert.equal(harness.processQueues.length, 2);
      assert.isUndefined(harness.getOpenedOptions()?.resumeSessionAt);
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

  const openAdapterWhoseFirstQueryEndsBeforeItsFirstFrame = Effect.fnUntraced(function* (
    name: string,
    firstQueryExit: Stream.Stream<
      SDKMessage,
      ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError
    > = Stream.empty,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: `ankiel-claude-v2-${name}-`,
    });
    const deadStreamEnded = yield* Deferred.make<void>();
    let opened = 0;
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
      // startTurn reads the auto-compact window from settings between opening the query and
      // attaching the turn; holding that read until the CLI's stream has ended pins the race.
      fileSystem: {
        ...fileSystem,
        readFileString: (filePath, encoding) =>
          opened === 1 && filePath.endsWith("settings.json")
            ? Deferred.await(deadStreamEnded).pipe(
                Effect.andThen(fileSystem.readFileString(filePath, encoding)),
              )
            : fileSystem.readFileString(filePath, encoding),
      },
      path: yield* Path.Path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator,
      continuationRequests: { offer: () => Effect.void },
      queryRunner: {
        allocateSessionId: Effect.succeed(`native-${name}`),
        open: () =>
          Effect.gen(function* () {
            opened += 1;
            const sdkMessages = yield* Queue.unbounded<SDKMessage>();
            return {
              // The first CLI exits without writing a frame.
              messages:
                opened === 1
                  ? firstQueryExit.pipe(
                      Stream.ensuring(Deferred.succeed(deadStreamEnded, undefined)),
                    )
                  : Stream.fromQueue(sdkMessages),
              offer: () => Effect.void,
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              renameSession: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              mcpServerStatus: Effect.succeed([]),
              readMcpResource: () => Effect.die("unexpected MCP resource read"),
              callMcpTool: () => Effect.die("unexpected MCP tool call"),
              mcpAuthenticate: () => Effect.die("unexpected MCP sign-in"),
              mcpSubmitOAuthCallbackUrl: () => Effect.die("unexpected MCP sign-in"),
              reconnectMcpServer: () => Effect.die("unexpected MCP reconnect"),
              listPermissionRules: Effect.die("unexpected permission rules read"),
              stopTask: () => Effect.void,
              interrupt: Effect.void,
              close: Queue.shutdown(sdkMessages),
            };
          }),
        forkSession: () => Effect.die("unused forkSession"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        subagentModel: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make(`thread-${name}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${name}`),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
    });
    const now = yield* DateTime.now;
    const turnInput = (attempt: string, providerTurnOrdinal: number) =>
      makeClaudeTestTurnInput({
        threadId,
        providerThread,
        now,
        attemptId: RunAttemptId.make(`attempt-${name}-${attempt}`),
        text: "Continue with the plan.",
        attachments: [],
        providerTurnOrdinal,
      });
    return { runtime, turnInput };
  });

  it.effect("resumes in a fresh session after Claude Code reports its conversation gone", () =>
    Effect.gen(function* () {
      const harness = yield* openAdapterWhoseFirstQueryEndsBeforeItsFirstFrame(
        "claude-query-conversation-missing",
        Stream.fail(
          new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
            method: "fromAsyncIterable",
            cause: new ClaudeAdapterV2.ClaudeConversationNotFoundError({
              cause: new Error("Claude Code process exited with code 1"),
            }),
          }),
        ),
      );
      const turnInput = harness.turnInput("a", 1);
      const started = yield* harness.runtime.startTurn(turnInput).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(started));
      if (Exit.isFailure(started)) {
        assert.include(
          makeProviderFailure({ cause: started.cause, class: "transport_error" }).message,
          "could not find this conversation",
        );
      }
      // A failed resume is what sends the next turn to a fresh native session.
      const resumed = yield* harness.runtime
        .resumeThread({
          providerThread: turnInput.providerThread,
          threadId: turnInput.threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(resumed));
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

  it.effect("fails a turn whose Claude query ends before its first frame", () =>
    Effect.gen(function* () {
      const harness = yield* openAdapterWhoseFirstQueryEndsBeforeItsFirstFrame(
        "claude-query-dies-before-frame",
      );
      const started = yield* harness.runtime.startTurn(harness.turnInput("a", 1)).pipe(Effect.exit);
      assert.isTrue(
        Exit.isFailure(started),
        "a turn whose Claude query ended before its first frame started running on the dead query",
      );
      if (Exit.isFailure(started)) {
        assert.include(
          Cause.pretty(started.cause),
          "Claude provider query ended before the turn could start.",
        );
      }
      const followUp = yield* harness.runtime
        .startTurn(harness.turnInput("b", 2))
        .pipe(Effect.exit);
      assert.isTrue(
        Exit.isSuccess(followUp),
        `the turn whose query ended before its first frame is still active: ${
          Exit.isFailure(followUp) ? Cause.pretty(followUp.cause) : ""
        }`,
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

  // regression: #37708 a gateway that holds the request open leaves Claude silent after "requesting"
  it.effect.each([
    { case: "after the prompt starts", requesting: false, backgroundProgress: false },
    { case: "after a request goes out", requesting: true, backgroundProgress: false },
    { case: "while a skill it forked runs", requesting: false, forkedTask: true },
    {
      case: "while an earlier background agent starts a nested task",
      requesting: false,
      nestedTaskStarted: true,
    },
    {
      case: "while an earlier background task reports progress",
      requesting: false,
      backgroundProgress: true,
    },
  ])(
    "does not keep a turn silently running when Claude goes quiet $case",
    ({ requesting, backgroundProgress = false, forkedTask = false, nestedTaskStarted = false }) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-silent-after-started"),
            text: "start again",
            attachments: [],
          }),
        );
        // Captured from Claude Code 2.1.325 against a gateway that never answers /v1/messages.
        for (const [index, state] of (["queued", "started"] as const).entries()) {
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "command_lifecycle",
              command_uuid: harness.promptUuid(0),
              state,
              uuid: `00000000-0000-4000-8000-00000000079${index}`,
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        if (requesting) {
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "status",
              status: "requesting",
              uuid: "00000000-0000-4000-8000-000000000792",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        if (backgroundProgress) {
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "task_progress",
              task_id: "earlier-background-task",
              description: "Earlier background task",
              usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 },
              uuid: "00000000-0000-4000-8000-000000000793",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        if (nestedTaskStarted) {
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "earlier-nested-task",
              description: "Nested task of an earlier background agent",
              spawn_depth: 2,
              uuid: "00000000-0000-4000-8000-000000000795",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        if (forkedTask) {
          yield* harness.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "forked-skill-task",
              description: "Forked skill",
              uuid: "00000000-0000-4000-8000-000000000794",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        assert.lengthOf(harness.terminalEvents(), 0);

        yield* TestClock.adjust("1 hour");
        yield* yieldTicks(50);
        const surfaced =
          harness.terminalEvents().length > 0 ||
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              (event.turnItem.type === "system_notice" || event.turnItem.type === "error"),
          );
        if (forkedTask) {
          assert.lengthOf(harness.terminalEvents(), 0, "a long forked skill was failed as silence");
        } else {
          assert.isTrue(surfaced, "an hour of silence after the prompt started surfaced nothing");
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

  it.effect("buffers wake output and requests a single continuation run", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-wake-1"),
          text: "Run the build in the background.",
          attachments: [],
        }),
      );
      yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
      yield* Queue.offer(harness.sdkMessages, turnOneResult);
      yield* harness.awaitTerminal(1);
      assert.equal(harness.terminalEvents()[0]?.status, "completed");
      assert.isTrue(yield* harness.hasPendingBackgroundWork);
      assert.lengthOf(harness.continuationRequests, 0);

      yield* harness.offerAndWait(wakeNotification);
      assert.lengthOf(harness.continuationRequests, 0);
      assert.isFalse(yield* harness.hasPendingBackgroundWork);

      yield* Queue.offer(harness.sdkMessages, wakeAssistant);
      yield* harness.awaitContinuation(1);
      assert.equal(harness.continuationRequests[0]?.threadId, harness.threadId);
      assert.equal(harness.continuationRequests[0]?.providerThreadId, harness.providerThread.id);
      assert.equal(harness.continuationRequests[0]?.driver, ClaudeAdapterV2.CLAUDE_PROVIDER);
      assert.equal(harness.continuationRequests[0]?.detail, WAKE_SUMMARY);

      yield* harness.offerAndWait(wakeResult);
      assert.lengthOf(harness.continuationRequests, 1);
      assert.lengthOf(harness.terminalEvents(), 1);
      assert.isTrue(yield* harness.hasPendingBackgroundWork);
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

  const makeSubagentAssistantFrames = (input: {
    readonly parentToolUseId: string;
    readonly uuid: string;
    readonly messageId?: string;
    readonly text?: string;
    readonly bashToolUseId?: string;
  }): ReadonlyArray<SDKMessage> =>
    [
      ...(input.text === undefined ? [] : [{ type: "text", text: input.text }]),
      ...(input.bashToolUseId === undefined
        ? []
        : [
            {
              type: "tool_use",
              id: input.bashToolUseId,
              name: "Bash",
              input: { command: "git log -5" },
            },
          ]),
    ].map((block, index) =>
      claudeSdkFrame({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          id: input.messageId ?? `msg_${input.uuid}`,
          type: "message",
          role: "assistant",
          content: [block],
        },
        parent_tool_use_id: input.parentToolUseId,
        uuid: index === 0 ? input.uuid : `${input.uuid}:${index}`,
        session_id: WAKE_NATIVE_SESSION,
      }),
    );
  const makeSubagentToolResultFrame = (input: {
    readonly parentToolUseId: string;
    readonly uuid: string;
    readonly toolUseId: string;
  }) =>
    claudeSdkFrame({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: input.toolUseId, content: "ok" }],
      },
      parent_tool_use_id: input.parentToolUseId,
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const makeSubagentTaskStartedFrame = (input: {
    readonly taskId: string;
    readonly toolUseId: string;
    readonly uuid: string;
  }) =>
    claudeSdkFrame({
      type: "system",
      subtype: "task_started",
      task_id: input.taskId,
      tool_use_id: input.toolUseId,
      description: "Audit recent commits",
      subagent_type: "general-purpose",
      is_backgrounded: true,
      task_type: "local_agent",
      prompt: "Audit the last five commits.",
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const makeSubagentNotificationFrame = (input: {
    readonly taskId: string;
    readonly toolUseId: string;
    readonly summary: string;
    readonly uuid: string;
  }) =>
    claudeSdkFrame({
      type: "system",
      subtype: "task_notification",
      task_id: input.taskId,
      tool_use_id: input.toolUseId,
      status: "completed",
      output_file: `/tmp/${input.taskId}.output`,
      summary: input.summary,
      uuid: input.uuid,
      session_id: WAKE_NATIVE_SESSION,
    });
  const subagentRouting = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    nativeToolIds: ReadonlyArray<string>,
  ) => {
    const childThreadId =
      events.find((event) => event.type === "subagent.updated")?.subagent.childThreadId ??
      undefined;
    const toolThreadIds = new Map<string, Set<string>>();
    for (const event of events) {
      const nativeId =
        event.type === "turn_item.updated" ? event.turnItem.nativeItemRef?.nativeId : undefined;
      if (event.type === "turn_item.updated" && nativeId && nativeToolIds.includes(nativeId)) {
        toolThreadIds.set(
          nativeId,
          (toolThreadIds.get(nativeId) ?? new Set()).add(event.turnItem.threadId),
        );
      }
    }
    const assistantTexts = (threadId: string | undefined) =>
      events.flatMap((event) =>
        event.type === "message.updated" &&
        event.message.role === "assistant" &&
        event.message.threadId === threadId
          ? [event.message.text]
          : [],
      );
    return { childThreadId, toolThreadIds, assistantTexts };
  };

  it.effect("streams a background subagent's work while the root turn is idle", () =>
    Effect.gen(function* () {
      const TASK_ID = "task-live-idle";
      const TOOL_USE_ID = "toolu-live-idle";
      const STRADDLING_BASH = "toolu-live-straddling-bash";
      const IDLE_BASH = "toolu-live-idle-bash";
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      const latestToolItem = (nativeId: string) =>
        harness.events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-live-idle-1"),
          text: "Audit in the background.",
          attachments: [],
        }),
      );
      for (const frame of [
        makeSubagentTaskStartedFrame({
          taskId: TASK_ID,
          toolUseId: TOOL_USE_ID,
          uuid: "00000000-0000-4000-8000-000000000951",
        }),
        ...makeSubagentAssistantFrames({
          parentToolUseId: TOOL_USE_ID,
          uuid: "00000000-0000-4000-8000-000000000952",
          bashToolUseId: STRADDLING_BASH,
        }),
        claudeSdkFrame({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: TASK_ID, task_type: "local_agent", description: "Audit" }],
          uuid: "00000000-0000-4000-8000-000000000961",
          session_id: WAKE_NATIVE_SESSION,
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000953",
          result: "Auditing in the background.",
        }),
      ]) {
        yield* Queue.offer(harness.sdkMessages, frame);
      }
      yield* harness.awaitTerminal(1);

      for (const frame of [
        makeSubagentToolResultFrame({
          parentToolUseId: TOOL_USE_ID,
          uuid: "00000000-0000-4000-8000-000000000954",
          toolUseId: STRADDLING_BASH,
        }),
        ...makeSubagentAssistantFrames({
          parentToolUseId: TOOL_USE_ID,
          uuid: "00000000-0000-4000-8000-000000000955",
          text: "Still auditing.",
          bashToolUseId: IDLE_BASH,
        }),
        claudeSdkFrame({
          type: "system",
          subtype: "task_progress",
          task_id: TASK_ID,
          description: "Reading the last commits",
          uuid: "00000000-0000-4000-8000-000000000956",
          session_id: WAKE_NATIVE_SESSION,
        }),
      ]) {
        yield* Queue.offer(harness.sdkMessages, frame);
      }
      yield* harness.until(() => {
        const event = latestToolItem(IDLE_BASH);
        return event?.type === "turn_item.updated" && event.turnItem.status === "running";
      });
      yield* harness.until(() =>
        harness.events.some(
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.progress === "Reading the last commits",
        ),
      );
      // The subagent backgrounds that shell; Claude names it by its command alone.
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: "idle-shell",
          tool_use_id: IDLE_BASH,
          description: "git log -5",
          is_backgrounded: true,
          parent_task_id: TASK_ID,
          task_type: "local_bash",
          uuid: "00000000-0000-4000-8000-000000000960",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      yield* harness.until(() =>
        harness.events.some(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread.pendingBackgroundTasks?.some(
              (task) => task.taskId === "idle-shell",
            ) === true,
        ),
      );
      const idleShell = latestToolItem(IDLE_BASH);
      assert.deepInclude(
        harness.events
          .findLast((event) => event.type === "provider_thread.updated")
          ?.providerThread.pendingBackgroundTasks?.find((task) => task.taskId === "idle-shell"),
        {
          command: "git log -5",
          itemId: idleShell?.type === "turn_item.updated" ? idleShell.turnItem.id : undefined,
        },
      );
      const routing = subagentRouting(harness.events, [STRADDLING_BASH, IDLE_BASH]);
      assert.deepEqual(routing.assistantTexts(routing.childThreadId), ["Still auditing."]);
      const straddling = latestToolItem(STRADDLING_BASH);
      const straddlingItem =
        straddling?.type === "turn_item.updated" ? straddling.turnItem : undefined;
      assert.equal(straddlingItem?.status, "completed");
      assert.equal(
        straddlingItem?.type === "command_execution" ? straddlingItem.input : undefined,
        "git log -5",
      );
      assert.equal(harness.continuationRequests.length, 0);

      for (const frame of [
        makeSubagentToolResultFrame({
          parentToolUseId: TOOL_USE_ID,
          uuid: "00000000-0000-4000-8000-000000000957",
          toolUseId: IDLE_BASH,
        }),
        makeSubagentNotificationFrame({
          taskId: TASK_ID,
          toolUseId: TOOL_USE_ID,
          summary: "Still auditing.",
          uuid: "00000000-0000-4000-8000-000000000958",
        }),
      ]) {
        yield* Queue.offer(harness.sdkMessages, frame);
      }
      yield* harness.awaitContinuation(1);
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000959",
          result: "The auditor finished.",
        }),
      );
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-live-idle-2"),
          text: "Background task completed.",
          attachments: [],
          providerTurnOrdinal: 2,
          messageCreatedBy: "agent",
          messageCreationSource: "provider",
        }),
      );
      yield* harness.awaitTerminal(2);

      const finalRouting = subagentRouting(harness.events, [STRADDLING_BASH, IDLE_BASH]);
      assert.deepEqual(finalRouting.assistantTexts(finalRouting.childThreadId), [
        "Still auditing.",
      ]);
      for (const nativeId of [STRADDLING_BASH, IDLE_BASH]) {
        assert.deepEqual(
          [...(finalRouting.toolThreadIds.get(nativeId) ?? [])],
          [finalRouting.childThreadId],
        );
        const statuses = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === nativeId
            ? [`${event.turnItem.type}:${event.turnItem.status}`]
            : [],
        );
        assert.deepEqual(statuses, ["command_execution:running", "command_execution:completed"]);
      }
      const finalSubagent = harness.events.findLast((event) => event.type === "subagent.updated");
      assert.equal(
        finalSubagent?.type === "subagent.updated" && finalSubagent.subagent.status,
        "completed",
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
});

describe("ClaudeAdapterV2 query message stream", () => {
  it.effect("closes the query when the message stream is interrupted mid-read", () =>
    Effect.gen(function* () {
      let closed = false;
      let releaseRead = () => {};
      const readStarted = Promise.withResolvers<void>();
      // Keep the read pending until close() releases it.
      // oxlint-disable-next-line require-yield
      async function* sdkMessages(): AsyncGenerator<SDKMessage, void> {
        for (;;) {
          if (closed) return;
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
            readStarted.resolve();
          });
        }
      }
      const generator = sdkMessages();
      const close = () => {
        closed = true;
        releaseRead();
      };
      const query = {
        next: () => generator.next(),
        return: async (value?: void) => {
          close();
          return generator.return(value);
        },
        throw: (error?: unknown) => generator.throw(error),
        [Symbol.asyncIterator]: () => generator,
        close,
      } as unknown as ClaudeQuery;

      const scope = yield* Scope.make();
      yield* Stream.fromAsyncIterable(
        ClaudeAdapterV2.claudeQueryMessages(query),
        (cause) => cause,
      ).pipe(
        Stream.runForEach(() => Effect.void),
        Effect.forkIn(scope),
      );
      yield* Effect.promise(() => readStarted.promise);

      // The raw async generator's return() queues behind its pending read and deadlocks scope close.
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(closed);
    }),
  );
});
