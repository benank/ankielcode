import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  RunAttemptId,
  RunId,
  type ModelSelection,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@ankielcode/contracts";
import { pendingBackgroundTurnItems } from "@ankielcode/shared/orchestrationV2PendingBackgroundWork";
import { resolveSelfInvocation, selfInvocationArgs } from "@ankielcode/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import { makeProviderFailure } from "@ankielcode/provider-core/server/failure";
import * as McpProviderSessions from "@ankielcode/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@ankielcode/provider-testing/TestProviderHost";
import { type ProviderReplayGate } from "@ankielcode/provider-testing/replayGate";
import type { ProviderContinuationRequest } from "@ankielcode/provider-core/server/ProviderContinuationRequests";
import * as ServerSettings from "../../serverSettings.ts";
import type { AcpRegistryLiveConfiguration } from "@ankielcode/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@ankielcode/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@ankielcode/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import { ACP_SESSION_MODE_OPTION_ID } from "@ankielcode/provider-acp/server/sessionConfig";
import * as AcpSessionRuntime from "@ankielcode/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
  makeTurnInput,
} from "./AcpAdapterV2.testkit.ts";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";
import { AcpRegistryAdapterV2Driver } from "@ankielcode/provider-acp-registry/server";
import {
  ACP_REGISTRY_PROVIDER,
  makeAcpRegistryAdapterV2,
  acpRegistryPromptFailure,
} from "@ankielcode/provider-acp-registry/testing";

const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);

const layerHost = TestProviderHost.layer().pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerRegistry = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "fixture-agent",
              name: "Fixture Agent",
              version: "1.0.0",
              description: "ACP V2 adapter fixture",
              distribution: {
                binary: {
                  "darwin-aarch64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                  "linux-x86_64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                },
              },
            },
          ],
        }),
      ),
    ),
  ),
);

const layerInjectedRuntimeCatalog = Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
  resolve: () => Effect.die("the runtime is injected"),
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
  layerRegistry,
  ServerSettings.layerTest(),
);

const CLAUDE_ROOT_SESSION = "claude-session";

/** Replay frames of Claude Agent (claude-agent-acp 0.90.0) on ACP v2. */
const claudeFrames = {
  open: [
    { type: "expect_outbound", frame: { kind: "request", method: "initialize", params: "<any>" } },
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "initialize",
        result: {
          protocolVersion: 2,
          info: { name: "@agentclientprotocol/claude-agent-acp", version: "0.90.0" },
          capabilities: { session: {} },
          authMethods: [],
        },
      },
    },
    { type: "expect_outbound", frame: { kind: "request", method: "session/new", params: "<any>" } },
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "session/new",
        result: { sessionId: CLAUDE_ROOT_SESSION },
      },
    },
  ],
  update: (sessionId: string, sessionUpdate: Record<string, unknown>) => ({
    type: "emit_inbound",
    frame: {
      kind: "notification",
      method: "session/update",
      params: { sessionId, update: sessionUpdate },
    },
  }),
  childState: (parent: string, child: string, state: string) =>
    claudeFrames.update(parent, {
      sessionUpdate: "subagent_update",
      sessionId: child,
      state: { state },
    }),
  /** A prompt Claude takes in and works on. */
  prompt: (ordinal: number) => [
    {
      type: "expect_outbound",
      frame: { kind: "request", method: "session/prompt", params: "<any>" },
    },
    claudeFrames.update(CLAUDE_ROOT_SESSION, {
      sessionUpdate: "user_message",
      messageId: `user-${ordinal}`,
      content: [{ type: "text", text: "test prompt" }],
    }),
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "session/prompt",
        result: { messageId: `user-${ordinal}` },
      },
    },
    claudeFrames.update(CLAUDE_ROOT_SESSION, { sessionUpdate: "state_update", state: "running" }),
  ],
  idle: (stopReason: string) =>
    claudeFrames.update(CLAUDE_ROOT_SESSION, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason,
    }),
  closeRequest: {
    type: "expect_outbound",
    frame: {
      kind: "request",
      method: "session/close",
      params: { sessionId: CLAUDE_ROOT_SESSION },
    },
  },
  closed: {
    type: "emit_inbound",
    frame: { kind: "response", method: "session/close", result: {} },
  },
};

const openClaudeReplaySession = Effect.fn("openClaudeReplaySession")(function* (
  entries: ReadonlyArray<unknown>,
  replayGate?: ProviderReplayGate,
  continuationEnabled = true,
  agentId: string | Record<string, unknown> = "claude-acp",
  replacementEntries?: ReadonlyArray<unknown>,
  runtimeMode: "approval-required" | "full-access" = "approval-required",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "ankiel-claude-lifecycle-",
  });
  const scriptPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
  );
  const makeReplay = Effect.fn("openClaudeReplaySession.makeReplay")(function* (
    entries: ReadonlyArray<unknown>,
    name: string,
  ) {
    const transcript = yield* decodeAcpReplayTranscript(
      {
        provider: ACP_REGISTRY_PROVIDER,
        protocol: "acp.ndjson-jsonrpc",
        version: "1",
        scenario: name,
        entries: entries as never,
      },
      ACP_REGISTRY_PROVIDER,
    );
    return makeAcpReplayRuntime({
      transcript,
      statusPath: path.join(replayDir, `${name}.json`),
      scriptPath,
      childProcessSpawner,
      fileSystem,
      ...(replayGate === undefined ? {} : { replayGate }),
    });
  });
  const offers: Array<ProviderContinuationRequest> = [];
  const offered = yield* Queue.unbounded<void>();
  const continuationRequests = {
    offer: (request: ProviderContinuationRequest) =>
      Effect.sync(() => {
        offers.push(request);
      }).pipe(Effect.andThen(Queue.offer(offered, undefined)), Effect.asVoid),
  };
  const instanceId = ProviderInstanceId.make("claude-lifecycle");
  const outgoing = yield* Queue.unbounded<unknown>();
  let onTermination: NonNullable<
    AcpSessionRuntime.AcpSessionRuntimeOptions["onTermination"]
  > = () => Effect.die("Runtime has not started");
  const replayRuntime = yield* makeReplay(entries, "claude-lifecycle");
  const replacementRuntime =
    replacementEntries === undefined
      ? replayRuntime
      : yield* makeReplay(replacementEntries, "replacement");
  let started = false;
  const adapterOptions = {
    selfInvocation: yield* resolveSelfInvocation(),
    instanceId,
    settings: yield* decodeAcpRegistryAdapterSettings(
      typeof agentId === "string" ? { agentId } : agentId,
    ),
    environment: {},
    ...(continuationEnabled ? { continuationRequests } : {}),
    makeRuntime: (runtimeInput: Parameters<typeof replayRuntime>[0]) => {
      onTermination = runtimeInput.onTermination;
      const replay = started ? replacementRuntime : replayRuntime;
      started = true;
      return replay({
        ...runtimeInput,
        protocolLogging: {
          logIncoming: false,
          logOutgoing: true,
          logger: (event) =>
            event.stage === "raw" && typeof event.payload === "string"
              ? Queue.offer(outgoing, JSON.parse(event.payload)).pipe(Effect.asVoid)
              : Effect.void,
        },
      });
    },
  };
  const adapter = yield* makeAcpRegistryAdapterV2(adapterOptions).pipe(
    Effect.provide(layerInjectedRuntimeCatalog),
  );
  const threadId = ThreadId.make("thread-claude-lifecycle");
  const modelSelection = { instanceId, model: "default" } as const;
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: replayDir,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session-claude-lifecycle"),
    modelSelection,
    runtimePolicy,
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => replayGate?.releaseAll()));
  if (continuationEnabled && agentId === "claude-acp") {
    assert.isDefined(
      runtime.hasPendingBackgroundWork,
      "Claude ACP v2 must report background work after foreground idle",
    );
  }
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const turnInput = (
    ordinal: number,
    options: { readonly continuation?: boolean } = {},
  ): ProviderAdapter.ProviderAdapterV2TurnInput => ({
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project-claude-lifecycle`),
      title: "Claude Agent",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode,
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
    threadId,
    runId: RunId.make(`run-claude-lifecycle-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt-claude-lifecycle-${ordinal}`),
    rootNodeId: NodeId.make(`node-claude-lifecycle-${ordinal}`),
    providerThread,
    message: {
      ...(options.continuation === true
        ? { createdBy: "agent" as const, creationSource: "provider" as const }
        : { createdBy: "user" as const, creationSource: "web" as const }),
      messageId: MessageId.make(`message-claude-lifecycle-${ordinal}`),
      text: "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  });
  const until = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (predicate(event)) return seen;
      }
    });
  const throughMarker = (title: string) =>
    until(
      (event) =>
        event.type === "provider_thread.updated" &&
        event.providerThread.nativeMetadata?.title === title,
    );
  const terminal = until((event) => event.type === "turn.terminal").pipe(
    Effect.map((seen) => {
      const event = seen.at(-1)!;
      if (event.type !== "turn.terminal") throw new Error("Missing terminal");
      return event;
    }),
  );
  return {
    runtime,
    providerThread,
    turnInput,
    until,
    throughMarker,
    terminal,
    offers,
    offered,
    outgoing,
    terminate: () =>
      onTermination(
        new EffectAcpErrors.AcpTransportError({
          detail: "Injected fixture process exit",
          cause: "test",
        }),
      ),
  };
});

const claudeMarker = (title: string) =>
  claudeFrames.update(CLAUDE_ROOT_SESSION, {
    sessionUpdate: "session_info_update",
    title,
  });
const claudeChild = [
  claudeFrames.update(CLAUDE_ROOT_SESSION, {
    sessionUpdate: "tool_call_update",
    toolCallId: "agent-1",
    name: "Agent",
    title: "Review",
    kind: "think",
    status: "in_progress",
    rawInput: { prompt: "Review the code", description: "Review", run_in_background: true },
  }),
  claudeFrames.childState(CLAUDE_ROOT_SESSION, "child-1", "running"),
  claudeFrames.update("child-1", {
    sessionUpdate: "session_message",
    messageId: "agent-1",
    senderSessionId: CLAUDE_ROOT_SESSION,
    recipientSessionId: "child-1",
    content: [{ type: "text", text: "Review the code" }],
  }),
  claudeFrames.update(CLAUDE_ROOT_SESSION, {
    sessionUpdate: "tool_call_update",
    toolCallId: "agent-1",
    status: "completed",
    _meta: { claudeCode: { toolResponse: { isAsync: true } } },
  }),
];

describe("AcpRegistryAdapterV2", () => {
  it("preserves and sanitizes structured ACP errors without exposing arbitrary defects", () => {
    const limit = new EffectAcpErrors.AcpRequestError({
      code: -31001,
      errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
    });
    assert.deepEqual(acpRegistryPromptFailure("mistral-vibe", limit), {
      class: "usage_limit",
      message: limit.errorMessage,
      code: "-31001",
      retryable: null,
    });
    assert.equal(acpRegistryPromptFailure("other-agent", limit).class, "provider_error");
    assert.equal(
      acpRegistryPromptFailure("mistral-vibe", new Error("private defect")).message,
      "Provider turn failed.",
    );
    const rejected = acpRegistryPromptFailure(
      "any-agent",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Request rejected. api_key=private-key https://example.test/?token=secret",
      }),
    );
    assert.include(rejected.message, "Request rejected.");
    assert.notInclude(rejected.message, "private-key");
    assert.notInclude(rejected.message, "token=secret");
  });

  describe("the agent's own pickers", () => {
    type Frame = Record<string, unknown>;
    const outbound = (method: string, params: unknown = "<any>"): Frame => ({
      type: "expect_outbound",
      frame: { kind: "request", method, params },
    });
    const answer = (method: string, result: unknown): Frame => ({
      type: "emit_inbound",
      frame: { kind: "response", method, result },
    });
    const permissionModeOption = (currentValue: string) => ({
      id: "permission-mode",
      name: "Permission mode",
      category: "mode",
      type: "select",
      currentValue,
      options: ["ask", "auto"].map((value) => ({ value, name: value })),
    });

    const openWithStoredPicks = Effect.fn("openWithStoredPicks")(function* (input: {
      readonly setup: unknown;
      readonly pickFrames: ReadonlyArray<Frame>;
      readonly agentId?: string;
      readonly customModels?: ReadonlyArray<string>;
      readonly storedModel?: string;
      readonly storedModePick?: string;
      readonly turnModels?: ReadonlyArray<string>;
      readonly rejectedModel?: string;
      readonly storedOptions?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
      readonly failsConfiguration?: boolean;
      readonly liveConfiguration?: AcpRegistryLiveConfiguration;
    }) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Scope release gives the replay agent at most a second to exit, so the status
      // read below waits for the agent itself instead of racing its last write.
      const agentExits: Array<Effect.Effect<void>> = [];
      const childProcessSpawner = ChildProcessSpawner.make((command) =>
        spawner
          .spawn(command)
          .pipe(
            Effect.tap((handle) =>
              Effect.sync(() => agentExits.push(Effect.ignore(handle.exitCode))),
            ),
          ),
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ankiel-acp-registry-stored-picks-",
      });
      const statusPath = path.join(replayDir, "status.json");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "stored-picks",
          entries: [
            outbound("initialize"),
            answer("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [{ id: "test", name: "Test" }],
            }),
            outbound("session/new"),
            answer("session/new", { sessionId: "agent-session", ...(input.setup as object) }),
            ...input.pickFrames,
          ] as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make("acp-registry-stored-picks");
      let published: AcpRegistryLiveConfiguration | undefined;
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: input.agentId ?? "fixture-agent",
          authMethodId: "test",
          customModels: input.customModels ?? [],
        }),
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          customModels: input.customModels,
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerInjectedRuntimeCatalog,
            Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
              withForegroundStartup: (_startupKey, effect) => effect,
              getLiveConfiguration: () =>
                Effect.sync(() => Option.fromUndefinedOr(published ?? input.liveConfiguration)),
              publishLiveConfiguration: (_instanceId, configuration) =>
                Effect.sync(() => {
                  published = configuration;
                }),
            }),
          ),
        ),
      );
      const threadId = ThreadId.make("thread-acp-registry-stored-picks");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: replayDir,
      });
      const stored: ModelSelection = {
        instanceId,
        model: input.storedModel ?? "default",
        ...(input.storedModePick === undefined
          ? {}
          : { options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: input.storedModePick }] }),
        ...(input.storedOptions === undefined ? {} : { options: input.storedOptions }),
      };
      const configurations: Array<AcpRegistryLiveConfiguration | undefined> = [];
      yield* Effect.gen(function* () {
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-stored-picks"),
          modelSelection: stored,
          runtimePolicy,
        });
        configurations.push(published);
        if (input.turnModels === undefined) return;
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: stored,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        let current = stored;
        for (const [index, model] of input.turnModels.entries()) {
          const target: ModelSelection = { instanceId, model };
          const plan = yield* adapter.planSelectionTransition({
            current,
            target,
            sessionCapabilities: runtime.providerSession.capabilities,
          });
          assert.equal(plan.type, "apply_on_next_turn");
          yield* runtime.startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              now,
              ordinal: index + 1,
              modelSelection: target,
            }),
          );
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "turn.terminal") {
                  assert.equal(event.status, "completed", event.failure?.message);
                }
              }),
            ),
          );
          configurations.push(published);
          current = target;
        }
      }).pipe(
        Effect.match({
          onFailure: (error) => {
            if (input.failsConfiguration === true) return;
            assert.isDefined(input.rejectedModel);
            assert.equal(
              makeProviderFailure({ cause: error }).message,
              `The agent did not accept the model "${input.rejectedModel}". Choose another model for this provider, then retry.`,
            );
          },
          onSuccess: () => {
            assert.isUndefined(input.rejectedModel);
            assert.notEqual(input.failsConfiguration, true, "configuration should have failed");
          },
        }),
        Effect.scoped,
      );
      yield* Effect.all(agentExits, { discard: true });
      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
      return { configurations };
    });

    const modelOption = (id: string, currentValue: string, grouped = false) => ({
      id,
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: grouped
        ? [{ group: "models", name: "Models", options: [{ value: "default", name: "Default" }] }]
        : [{ value: "auto", name: "Auto" }],
    });
    const configOptionUpdate = (configOptions: ReadonlyArray<unknown>): Frame => ({
      type: "emit_inbound",
      frame: {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: "agent-session",
          update: { sessionUpdate: "config_option_update", configOptions },
        },
      },
    });
    const prompt = (...updates: ReadonlyArray<Frame>): ReadonlyArray<Frame> => [
      outbound("session/prompt"),
      ...updates,
      answer("session/prompt", { stopReason: "end_turn" }),
    ];

    it.effect.each([
      "config",
      "legacy",
      "updated-config",
      "removed-config",
      "configuration-update",
      "unavailable-before-configuration",
    ] as const)(
      "rejects an unavailable explicit model in a %s catalog before inference",
      (catalog) => {
        const duringTurn = catalog === "updated-config" || catalog === "removed-config";
        const duringConfiguration = catalog === "configuration-update";
        const changesOptions =
          duringConfiguration || catalog === "unavailable-before-configuration";
        const model = duringTurn || duringConfiguration ? "hermes" : "missing";
        const restrictedOption = {
          ...modelOption("model", "other"),
          options: [{ value: "other", name: "Other" }],
        };
        return openWithStoredPicks({
          setup: {
            ...(catalog === "legacy" || catalog === "removed-config"
              ? {
                  models: {
                    currentModelId: "other",
                    availableModels: [{ modelId: "other", name: "Other" }],
                  },
                }
              : {}),
            configOptions:
              catalog === "legacy"
                ? []
                : [
                    {
                      ...modelOption("model", "hermes"),
                      options: [{ value: "hermes", name: "Hermes" }],
                    },
                    ...(changesOptions ? [permissionModeOption("ask")] : []),
                  ],
          },
          storedModel: model,
          ...(duringTurn ? { turnModels: [model, model] } : {}),
          ...(changesOptions ? { storedModePick: "auto" } : {}),
          rejectedModel: model,
          pickFrames: duringTurn
            ? prompt(configOptionUpdate(catalog === "removed-config" ? [] : [restrictedOption]))
            : duringConfiguration
              ? [
                  outbound("session/set_config_option", {
                    sessionId: "agent-session",
                    configId: "permission-mode",
                    value: "auto",
                  }),
                  answer("session/set_config_option", {
                    configOptions: [restrictedOption, permissionModeOption("auto")],
                  }),
                ]
              : [],
        }).pipe(Effect.provide(layerTest));
      },
    );
  });

  it.effect("gives HTTP-capable agents Ankiel's MCP server over HTTP", () =>
    Effect.gen(function* () {
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* (yield* Path.Path).fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const endpoint = "http://127.0.0.1:43123/mcp";
      const sessionMcpServers = Effect.fn("sessionMcpServers")(function* (
        config: Record<string, unknown>,
        agentEnvironment: Record<string, string> = {},
      ) {
        const requests: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
        const instanceId = ProviderInstanceId.make("acp-registry-mcp-transport");
        const threadId = ThreadId.make("thread-acp-registry-mcp-transport");
        const mcpSession = {
          environmentId: EnvironmentId.make("environment-acp-registry-mcp-transport"),
          threadId,
          providerSessionId: "mcp-session-acp-registry-mcp-transport",
          providerInstanceId: instanceId,
          endpoint,
          browserToolsAvailable: false,
        };
        yield* mcpSessions.set({ ...mcpSession, authorizationHeader: "Bearer opened-token" });
        const adapter = yield* makeAcpRegistryAdapterV2({
          selfInvocation,
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings(config),
          environment: {},
          nativeLogging: () => ({
            requestLogger: (event) =>
              Effect.sync(() => {
                if (event.status === "started") requests.push(event);
              }),
          }),
        }).pipe(
          Effect.provide(
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
              resolve: () =>
                Effect.succeed({
                  distribution: "local" as const,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    env: { ANKIEL_ACP_SESSION_LIFECYCLE: "1", ...agentEnvironment },
                  },
                }),
            }),
          ),
        );
        const modelSelection = { instanceId, model: "default" } as const;
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-registry-mcp-transport"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* mcpSessions.set({ ...mcpSession, authorizationHeader: "Bearer rotated-token" });
        yield* runtime.resumeThread({
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver: ACP_REGISTRY_PROVIDER,
              nativeId: "mock-session-2",
              strength: "strong",
            },
          },
        });
        const sent = (method: string) => {
          const payload = requests.find((event) => event.method === method)?.payload;
          return typeof payload === "object" && payload !== null
            ? Reflect.get(payload, "mcpServers")
            : undefined;
        };
        return { new: sent("session/new"), load: sent("session/load") };
      });
      const plainHttp = (authorization: string) => [
        {
          type: "http",
          name: "ankiel-code",
          url: endpoint,
          headers: [{ name: "Authorization", value: authorization }],
        },
      ];
      const http = (authorization: string) => [
        {
          type: "http",
          name: "ankiel-code",
          url: endpoint,
          headers: [
            { name: "Authorization", value: authorization },
            { name: "ankiel-tool-exposure", value: "deferred" },
          ],
        },
      ];
      const stdio = (authorization: string) => [
        {
          name: "ankiel-code",
          command: selfInvocation.command,
          args: [...selfInvocationArgs(selfInvocation, ["acp-mcp-bridge"])],
          env: [
            { name: "ELECTRON_RUN_AS_NODE", value: "1" },
            { name: "ANKIEL_ACP_MCP_ENDPOINT", value: endpoint },
            { name: "ANKIEL_ACP_MCP_AUTHORIZATION", value: authorization },
          ],
        },
      ];

      assert.deepEqual(
        yield* sessionMcpServers({ agentId: "github-copilot-cli" }, { ANKIEL_ACP_MCP_HTTP: "1" }),
        { new: http("Bearer opened-token"), load: http("Bearer rotated-token") },
      );
      const acp = [{ type: "acp", name: "ankiel-code", serverId: "ankiel-code" }];
      assert.deepEqual(
        yield* sessionMcpServers(
          { agentId: "github-copilot-cli" },
          { ANKIEL_ACP_MCP_HTTP: "1", ANKIEL_ACP_MCP_ACP: "1" },
        ),
        { new: acp, load: acp },
      );
      assert.deepEqual(yield* sessionMcpServers({ agentId: "github-copilot-cli" }), {
        new: stdio("Bearer opened-token"),
        load: stdio("Bearer rotated-token"),
      });
      assert.deepEqual(
        yield* sessionMcpServers({ agentId: "gemini" }, { ANKIEL_ACP_MCP_HTTP: "1" }),
        {
          new: stdio("Bearer opened-token"),
          load: stdio("Bearer rotated-token"),
        },
      );
      // Command Code cannot start the stdio bridge on Windows: it spawns MCP commands through
      // cmd.exe, which splits the unquoted Ankiel executable path at the space.
      const commandCode = {
        source: "local",
        commandPath: "C:\\tools\\cmdc.exe",
        commandArgs: ["acp"],
      };
      // Command Code is not Copilot: no deferred tool-exposure header.
      assert.deepEqual(yield* sessionMcpServers(commandCode, { ANKIEL_ACP_MCP_HTTP: "1" }), {
        new: plainHttp("Bearer opened-token"),
        load: plainHttp("Bearer rotated-token"),
      });
      assert.deepEqual(yield* sessionMcpServers(commandCode), {
        new: stdio("Bearer opened-token"),
        load: stdio("Bearer rotated-token"),
      });
      // Any other local agent keeps the stdio bridge.
      assert.deepEqual(
        yield* sessionMcpServers(
          { source: "local", commandPath: "C:\\tools\\node.exe", commandArgs: ["agent.mjs"] },
          { ANKIEL_ACP_MCP_HTTP: "1" },
        ),
        { new: stdio("Bearer opened-token"), load: stdio("Bearer rotated-token") },
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("the agent process env names the thread it serves", () =>
    Effect.gen(function* () {
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* (yield* Path.Path).fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const endpoint = "http://127.0.0.1:43123/mcp";
      const instanceId = ProviderInstanceId.make("acp-registry-thread-env");
      const threadId = ThreadId.make("thread-acp-registry-thread-env");
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-registry-thread-env"),
        threadId,
        providerSessionId: "mcp-session-acp-registry-thread-env",
        providerInstanceId: instanceId,
        endpoint,
        authorizationHeader: "Bearer thread-env-token",
        browserToolsAvailable: false,
      });
      // Several agents can run from one directory at once; the spawn env is how
      // a process the agent starts (an MCP server, a shell tool) finds its own
      // Ankiel thread, the same way Claude and Codex sessions do.
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnEnvironments: Array<Record<string, unknown> | undefined> = [];
      const capturingSpawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (command._tag === "StandardCommand") spawnEnvironments.push(command.options.env);
        }).pipe(Effect.andThen(spawner.spawn(command))),
      );
      const withCapturedSpawns = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, capturingSpawner),
        );
      const adapter = yield* withCapturedSpawns(
        makeAcpRegistryAdapterV2({
          selfInvocation,
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings({ agentId: "claude-acp" }),
          environment: {},
        }).pipe(
          Effect.provide(
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
              resolve: () =>
                Effect.succeed({
                  distribution: "local" as const,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    env: { ANKIEL_ACP_SESSION_LIFECYCLE: "1" },
                  },
                }),
            }),
          ),
        ),
      );
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* withCapturedSpawns(
        adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-registry-thread-env"),
          modelSelection,
          runtimePolicy,
        }),
      );
      yield* withCapturedSpawns(runtime.ensureThread({ threadId, modelSelection, runtimePolicy }));
      const agentEnvironment = spawnEnvironments.find(
        (environment) => environment?.ANKIEL_ACP_SESSION_LIFECYCLE === "1",
      );
      assert.isDefined(agentEnvironment, "the agent itself must have been spawned");
      assert.equal(agentEnvironment?.ANKIEL_THREAD_ID, "thread-acp-registry-thread-env");
      assert.equal(agentEnvironment?.ANKIEL_ACP_MCP_ENDPOINT, endpoint);
      assert.equal(agentEnvironment?.ANKIEL_ACP_MCP_AUTHORIZATION, "Bearer thread-env-token");
    }).pipe(Effect.provide(layerTest)),
  );

  // Copilot wakes its root agent when a background subagent finishes, after the run settled.
  it.effect("does not drop Copilot's root reply when a finished background agent wakes it", () =>
    Effect.gen(function* () {
      const sessionId = "copilot-session";
      const sessionEvent = (type: string) => ({
        type: "emit_inbound",
        frame: {
          kind: "notification",
          method: "github.com/copilot/sessionEvent",
          params: { sessionId, type, data: {} },
        },
      });
      const update = (sessionUpdate: Record<string, unknown>) =>
        claudeFrames.update(sessionId, sessionUpdate);
      const session = yield* openClaudeReplaySession(
        [
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "initialize", params: "<any>" },
          },
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "initialize",
              result: {
                protocolVersion: 1,
                agentInfo: { name: "Copilot", version: "1.0.112" },
                agentCapabilities: { loadSession: true },
                authMethods: [],
              },
            },
          },
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "session/new", params: "<any>" },
          },
          {
            type: "emit_inbound",
            frame: { kind: "response", method: "session/new", result: { sessionId } },
          },
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "session/prompt", params: "<any>" },
          },
          sessionEvent("assistant.turn_start"),
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Agents are still working." },
          }),
          sessionEvent("assistant.idle"),
          update({ sessionUpdate: "session_info_update", title: "after foreground idle" }),
          // The background agent finishes; Copilot reads it and starts a new root turn.
          sessionEvent("assistant.turn_start"),
          update({
            sessionUpdate: "tool_call",
            toolCallId: "read-agent-1",
            title: "read_agent",
            kind: "other",
            status: "completed",
            rawInput: { agent_id: "agent-1" },
          }),
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Agent 1 finished" },
          }),
          sessionEvent("assistant.idle"),
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "session/prompt",
              result: { stopReason: "end_turn" },
            },
          },
          update({ sessionUpdate: "session_info_update", title: "after wake idle" }),
        ],
        undefined,
        true,
        "github-copilot-cli",
      );
      yield* session.runtime.startTurn(session.turnInput(1));
      const foreground = yield* session.throughMarker("after foreground idle");
      assert.isDefined(foreground.find((event) => event.type === "turn.terminal"));
      const wake = yield* session.throughMarker("after wake idle");
      assert.isTrue(
        session.offers.length > 0 || JSON.stringify(wake).includes("Agent 1 finished"),
        "the woken root reply is shown or opens a continuation run",
      );
      yield* session.runtime.startTurn(session.turnInput(2, { continuation: true }));
      const continuation = yield* session.until((event) => event.type === "turn.terminal");
      assert.include(JSON.stringify(continuation), "Agent 1 finished");
      assert.include(JSON.stringify(continuation.at(-1)), '"status":"completed"');
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("fails active Claude work and releases its children when the process exits", () =>
    Effect.gen(function* () {
      const session = yield* openClaudeReplaySession([
        ...claudeFrames.open,
        ...claudeFrames.prompt(1),
        ...claudeChild,
        claudeMarker("child ready"),
      ]);
      yield* session.runtime.startTurn(session.turnInput(1));
      yield* session.throughMarker("child ready");
      yield* session.terminate();
      const terminal = yield* session.terminal;
      assert.equal(terminal.status, "failed");
      assert.equal(terminal.failure?.class, "transport_error");
      assert.isFalse(yield* session.runtime.hasPendingBackgroundWork!);
      const settled = yield* openClaudeReplaySession([
        ...claudeFrames.open,
        ...claudeFrames.prompt(1),
        ...claudeChild,
        claudeFrames.childState("child-1", "grandchild", "running"),
        claudeFrames.update("grandchild", {
          sessionUpdate: "tool_call_update",
          toolCallId: "nested-tool",
          name: "Bash",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "cat package.json" },
        }),
        claudeFrames.childState(CLAUDE_ROOT_SESSION, "child-1", "idle"),
        claudeFrames.idle("end_turn"),
      ]);
      yield* settled.runtime.startTurn(settled.turnInput(1));
      const foreground = yield* settled.until((event) => event.type === "turn.terminal");
      const completed = foreground.at(-1)!;
      if (completed.type !== "turn.terminal") throw new Error("Missing settled root terminal");
      assert.equal(completed.status, "completed");
      assert.isTrue(yield* settled.runtime.hasPendingBackgroundWork!);
      yield* settled.terminate();
      assert.isFalse(
        yield* settled.runtime.hasPendingBackgroundWork!,
        "exit releases visible owners held open by nested work",
      );
      const exited = yield* settled.until(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "subagent" &&
          event.turnItem.status === "failed",
      );
      assert.isTrue(
        exited.some(
          (event) => event.type === "subagent.updated" && event.subagent.status === "failed",
        ),
      );
      const items = new Map(
        [...foreground, ...exited].flatMap((event) =>
          event.type === "turn_item.updated" ? [[event.turnItem.id, event.turnItem] as const] : [],
        ),
      );
      assert.deepEqual(pendingBackgroundTurnItems({ turnItems: [...items.values()] }), []);
      assert.isTrue(
        exited.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.status === "interrupted",
        ),
      );
    }).pipe(Effect.provide(layerTest)),
  );
});
