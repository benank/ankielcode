import * as AssetSigner from "../../assets/AssetSigner.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  CommandId,
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@ankielcode/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorProviderSelectionBusyError,
} from "../../orchestration-v2/Orchestrator.ts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../McpToolAccess.testkit.ts";
import { dispatchFailure } from "../threadAccess.ts";
import * as EnvironmentHandlers from "./environment/handlers.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const layerThreadToolkit = McpHttpServer.layerThreadToolkit.pipe(
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
);

const threadId = ThreadId.make("mcp-core-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "mcp-core-session",
  thread: {
    threadId,
    providerSessionId: "mcp-core-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-core", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-core", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("an answered question reports already answered instead of not found", () => {
  const shell = McpToolAccessTestkit.liveThreadShell(threadId);
  const requestId = RuntimeRequestId.make("answered-question");
  const projection = McpToolAccessTestkit.idleThreadProjection(shell);
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const respond = (id: string) =>
      server
        .callTool({
          name: "ankiel_pending_request",
          arguments: { action: "respond", requestId: id, answers: { size: "large" } },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    expect(declaredFailure(yield* respond(requestId))).toMatchObject({
      code: "invalid_request",
      message: "The user-input request was already answered.",
    });
    expect(declaredFailure(yield* respond("missing-question"))).toMatchObject({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(shell),
            getProjectThreadRecords: () =>
              Effect.succeed({
                ...projection,
                runtimeRequests: [
                  {
                    id: requestId,
                    nodeId: NodeId.make("root"),
                    providerTurnId: null,
                    nativeRequestRef: null,
                    kind: "user_input",
                    status: "resolved",
                    responseCapability: { type: "message" },
                    createdAt: shell.createdAt,
                    resolvedAt: shell.updatedAt,
                    answers: { size: "large" },
                  },
                ],
                turnItems: [
                  {
                    id: TurnItemId.make("answered-question-item"),
                    threadId,
                    runId: null,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 0,
                    status: "completed",
                    title: null,
                    startedAt: shell.createdAt,
                    completedAt: shell.updatedAt,
                    updatedAt: shell.updatedAt,
                    type: "user_input_request",
                    requestId,
                    questions: [],
                  },
                ],
              }),
            dispatch: () => Effect.die("an answered question must not dispatch again"),
          }),
        ),
      ),
    ),
  );
});

it("bounds public command rejections and redacts internal dispatch causes", () => {
  const command = { commandId: CommandId.make("mcp-core-command"), commandType: "thread.settle" };
  expect(
    dispatchFailure(new OrchestratorDispatchError({ ...command, cause: "🙂".repeat(1001) }))
      .message,
  ).toBe("🙂".repeat(1000));
  expect(
    dispatchFailure(
      new OrchestratorCommandRejectedError({ ...command, cause: "Run is not queued." }),
    ).message,
  ).toBe("Run is not queued.");
  const busy = new OrchestratorProviderSelectionBusyError({
    commandId: command.commandId,
    threadId,
  });
  expect(dispatchFailure(busy)).toMatchObject({ code: "invalid_request", message: busy.message });
  for (const cause of [
    undefined,
    "",
    new Error("private-storage-path"),
    { message: "private-storage-path" },
  ]) {
    expect(dispatchFailure(new OrchestratorDispatchError({ ...command, cause }))).toMatchObject({
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
    expect(
      dispatchFailure(new OrchestratorCommandRejectedError({ ...command, cause })),
    ).toMatchObject({
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
  }
  expect(
    dispatchFailure(new OrchestratorProjectionError({ threadId, cause: "private-storage-path" })),
  ).toMatchObject({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });
});

it.effect("keeps unexpected handler defects private through the production registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "ankiel_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: "Tool execution failed due to an internal server error." },
    ]);
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.die(new Error("private-storage-path")),
          }),
        ),
      ),
    ),
  ),
);

it("keeps MCP preference output allowlisted and Unicode-bounded", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    privateCredential: "must-not-escape",
    sourceControlWritingStyle: {
      ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
      customInstructions: "🙂".repeat(4001),
    },
  };
  const result = EnvironmentHandlers.preferences(settings);
  expect(result).not.toHaveProperty("privateCredential");
  expect(result).not.toHaveProperty("providers");
  expect(result.sourceControlWritingStyle).toMatchObject({
    customInstructions: "🙂".repeat(4000),
    truncated: true,
  });
});

const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access },
  issuedAt: 0,
  capabilities: new Set(["orchestration", "worktree"]),
});

it.effect("a client caller targets any thread within its ceiling and cannot act as a thread", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const untargeted = yield* call(
      "ankiel_thread_organize",
      { action: "pin" },
      clientScope("auto"),
    );
    expect(declaredFailure(untargeted)).toMatchObject({ code: "target_required" });

    const pinned = yield* call(
      "ankiel_thread_organize",
      { action: "pin", threadId: "other-project-thread" },
      clientScope("auto"),
    );
    expect(pinned.isError).toBe(false);
    expect(pinned.structuredContent).toMatchObject({ sequence: 7 });

    const aboveCeiling = yield* call(
      "ankiel_thread_organize",
      { action: "pin", threadId: "other-project-thread" },
      clientScope("approval-required"),
    );
    expect(declaredFailure(aboveCeiling)).toMatchObject({
      code: "runtime_mode_escalation_denied",
    });

    const forked = yield* call(
      "ankiel_thread_transfer",
      { action: "fork", sourcePoint: { type: "latest_stable" } },
      clientScope("auto"),
    );
    expect(declaredFailure(forked)).toMatchObject({ code: "target_required" });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" })),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("other-project-thread"),
                  projectId: "other-project",
                  runtimeMode: "auto",
                  interactionMode: "default",
                  deletedAt: null,
                },
              } as never),
            listActiveShellIndex: () => Effect.succeed([]),
            dispatch: () => Effect.succeed({ sequence: 7, storedEvents: [] }),
          }),
        ),
      ),
    ),
  ),
);

it.effect("a read-only client reads threads and is refused every write before it runs", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            clientScope("read-only"),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const configuration = yield* call("ankiel_thread_configure", {
      threadId: "other-project-thread",
    });
    expect(configuration.isError).toBe(false);
    expect(configuration.structuredContent).toMatchObject({ runtimeMode: "auto" });

    const pinned = yield* call("ankiel_thread_organize", {
      action: "pin",
      threadId: "other-project-thread",
    });
    expect(declaredFailure(pinned)).toMatchObject({ code: "capability_denied" });
    expect(dispatched).toEqual([]);

    const configure = yield* call("ankiel_thread_configure", {
      threadId: "other-project-thread",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
    });
    expect(declaredFailure(configure)).toMatchObject({ code: "capability_denied" });
    expect(dispatched).toEqual([]);
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                id: ThreadId.make("other-project-thread"),
                projectId: "other-project",
                deletedAt: null,
              } as never),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("other-project-thread"),
                  projectId: "other-project",
                  modelSelection: { instanceId: "codex", model: "gpt-5" },
                  runtimeMode: "auto",
                  interactionMode: "default",
                  deletedAt: null,
                },
              } as never),
            dispatch: () =>
              Effect.sync(() => {
                dispatched.push("dispatch");
                return { sequence: 7 } as never;
              }),
          }),
        ),
      ),
    ),
  ),
);
const dispatched: Array<string> = [];

it.effect("hides act-as-caller tools from a client caller", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const error = yield* server
      .callTool({
        name: "delegate_task",
        arguments: { task: "Review", mode: "async" },
      })
      .pipe(
        Effect.flip,
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          clientScope("full-access"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(error.message).toContain("Tool 'delegate_task' not found");
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

it.effect("a caller cannot rewrite a scheduled task that runs above its own modes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const update = yield* call("schedule_task", {
      scheduledTaskId: "task-full-access",
      prompt: "Run something else",
    });
    expect(declaredFailure(update)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const remove = yield* call("delete_scheduled_task", { scheduledTaskId: "task-full-access" });
    expect(declaredFailure(remove)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const allowed = yield* call("schedule_task", {
      scheduledTaskId: "task-auto",
      enabled: false,
    });
    expect(allowed.isError).toBe(false);
    const fresh = yield* call("schedule_task", {
      scheduledTaskId: "task-auto",
      freshSession: true,
    });
    expect(fresh.structuredContent).toMatchObject({ freshSession: true });
    const incomplete = yield* call("schedule_task", { prompt: "Run nightly" });
    expect(declaredFailure(incomplete)).toMatchObject({ code: "invalid_request" });
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () =>
              Effect.succeed({
                tasks: [
                  scheduledTask("task-full-access", "full-access"),
                  scheduledTask("task-auto", "auto"),
                ],
              }),
            upsert: (input) =>
              Effect.succeed({
                task: { ...(scheduledTask(input.id ?? "task-auto", "auto") as object), ...input },
              } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      ),
    ),
  ),
);

function scheduledTask(id: string, runtimeMode: "auto" | "full-access"): never {
  return {
    id,
    title: id,
    prompt: "Check the build",
    enabled: true,
    projectId: "project-a",
    threadId: null,
    schedule: { type: "interval", everyMs: 3_600_000 },
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode,
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    nextRunAt: null,
    lastRunStatus: "never",
    lastRunAt: null,
    lastRunThreadId: null,
    lastRunError: null,
    runCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as never;
}

it.effect.each(["ankiel_thread_interrupt", "ankiel_workflow_stop"])(
  "a caller cannot use %s on a thread that runs above its own modes",
  (toolName) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: toolName,
          arguments: {
            threadId: "full-access-thread",
            ...(toolName === "ankiel_workflow_stop" ? { subagentId: "workflow-coordinator" } : {}),
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(declaredFailure(result)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    }).pipe(
      Effect.provide(
        layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed({
                  projectId: "project-a",
                  deletedAt: null,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                } as never),
              getProjectThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: ThreadId.make("full-access-thread"),
                    projectId: "project-a",
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    deletedAt: null,
                  },
                  runs: [],
                } as never),
              stopWorkflow: () => Effect.die("workflow stop must not dispatch above the ceiling"),
              interruptThread: () => Effect.die("interrupt must not dispatch above the ceiling"),
            }),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
          Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        ),
      ),
    ),
);

it.effect("only the caller that prepared a pending upload can discard it", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const prepared = yield* call(
      "ankiel_attachment_prepare_upload",
      { upload: { name: "shot.png", mimeType: "image/png", sizeBytes: 4 } },
      scope,
    );
    const { attachmentId } = prepared.structuredContent as { readonly attachmentId: string };
    const otherThread = {
      ...scope,
      requestNamespace: "other-session",
      thread: { ...scope.thread!, threadId: ThreadId.make("other-thread") },
    };

    const refused = yield* call("ankiel_attachment_discard", { attachmentId }, otherThread);
    expect(declaredFailure(refused)).toMatchObject({ code: "invalid_request" });

    yield* TestClock.adjust(24 * 60 * 60 * 1000 + 5 * 60_000);
    yield* call(
      "ankiel_attachment_prepare_upload",
      { upload: { name: "later.png", mimeType: "image/png", sizeBytes: 4 } },
      scope,
    );

    const discarded = yield* call(
      "ankiel_attachment_discard",
      { attachmentId },
      { ...scope, requestNamespace: "mcp-core-session-2" },
    );
    expect(discarded.isError).toBe(false);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerAttachmentToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(AssetSigner.layer.pipe(Layer.provideMerge(ServerSecretStore.layer))),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-mcp-attachment-" })),
        Layer.provide(
          DocumentText.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
  ),
);
