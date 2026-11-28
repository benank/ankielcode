import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@ankielcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ProjectService from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as AssetSigner from "../assets/AssetSigner.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const invocation = {
  environmentId,
  requestNamespace: "provider-session-mcp-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const layerTest = McpHttpServer.layerPreviewToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-mcp-http-server-test-" }),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

/** Records every span and the order spans start and end in, by span ID. */
const recordSpans = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const order: Array<string> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      order.push(`start ${span.spanId}`);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        order.push(`end ${span.spanId}`);
      };
      return span;
    },
  });
  return { tracer, spans, order };
};

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const layerRecordingTools = (calls: Array<unknown>) => {
  const RecordingToolkit = Toolkit.make(
    OrchestratorToolkit.tools.delegate_task,
    OrchestratorToolkit.tools.ankiel_thread_list,
    OrchestratorToolkit.tools.ankiel_thread_read,
    OrchestratorToolkit.tools.ankiel_thread_wait,
    ProjectToolkit.tools.ankiel_project_list,
    ProjectToolkit.tools.ankiel_project_update,
    ThreadToolkit.tools.ankiel_queue,
    PreviewControlsToolkit.tools.ankiel_preview_list,
    ProjectToolkit.tools.ankiel_thread_launch,
  );
  const record = McpToolAccess.reads((params: unknown) =>
    Effect.sync(() => calls.push(params)).pipe(
      Effect.andThen(
        Effect.fail(new OrchestratorMcpFailure({ code: "thread_not_found", message: "Recorded." })),
      ),
    ),
  );
  return McpHttpServer.toolkitRegistration(
    RecordingToolkit,
    McpToolAccess.toLayer(RecordingToolkit, {
      delegate_task: record,
      ankiel_thread_list: record,
      ankiel_thread_read: record,
      ankiel_thread_wait: record,
      ankiel_project_list: record,
      ankiel_project_update: record,
      ankiel_queue: record,
      ankiel_preview_list: record,
      ankiel_thread_launch: record,
    }),
  ).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(
      Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(PreviewManager.PreviewManager)({}),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: process.cwd(),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        Layer.mock(DocumentText.DocumentText)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-mcp-http-server-test-" }),
        NodeCrypto.layer,
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

it.effect("refuses preview tools to a client outside a thread before they run", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const readOnly = {
      ...invocation,
      thread: undefined,
      requestNamespace: "client:session-1",
      client: { sessionId: "session-1", label: "Claude Code", access: "read-only" as const },
    };
    const click = yield* server
      .callTool({ name: "preview_act", arguments: { action: "click", locator: "text=Send" } })
      .pipe(
        Effect.flip,
        Effect.provideService(McpInvocationContext.McpInvocationContext, readOnly),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(click.message).toContain("Tool 'preview_act' not found");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects arguments a tool does not declare instead of dropping them", () => {
  const calls: Array<unknown> = [];
  return Effect.gen(function* () {
    const launch = yield* Effect.flip(
      callTool("ankiel_thread_launch", { title: "Repro", scratch: true, prompt: "say hi" }),
    );
    const wait = yield* Effect.flip(
      callTool("ankiel_thread_wait", { threadId: "thread-excess-arguments", timeout: 5_000 }),
    );

    expect(calls).toEqual([]);
    expect(launch.message).toContain('Unknown argument "prompt"');
    expect(wait.message).toContain('Unknown argument "timeout"');
  }).pipe(Effect.provide(layerRecordingTools(calls)));
});

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "providerTokenWithoutDots";
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const layerServer = McpHttpServer.layerMcpTransport(Layer.empty).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (presented) =>
              Effect.succeed(
                presented === token
                  ? (scope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(layerServer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      );

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("admits provider and CLI client credentials and names no sign-in in the challenge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const providerToken = "providerTokenWithoutDots";
      const clientToken = "client-payload.client-signature";
      const providerScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "provider-session",
        thread: {
          threadId: ThreadId.make("thread-provider"),
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const clientScope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: "client:session-1",
        thread: undefined,
        client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const seen: Array<McpInvocationContext.McpInvocationScope> = [];
      const ProbeToolkit = Toolkit.make(
        Tool.make("probe", {
          description: "Reports the caller.",
          success: Schema.Struct({ ok: Schema.Boolean }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
          dependencies: [McpInvocationContext.McpInvocationContext],
        }),
      );
      const serverLayer = McpHttpServer.layerMcpTransport(
        McpHttpServer.toolkitRegistration(
          ProbeToolkit,
          McpToolAccess.toLayer(ProbeToolkit, {
            probe: McpToolAccess.reads(() =>
              McpInvocationContext.McpInvocationContext.pipe(
                Effect.tap((scope) => Effect.sync(() => seen.push(scope))),
                Effect.as({ ok: true }),
              ),
            ),
          }),
        ),
      ).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) =>
              Effect.succeed(
                token === providerToken
                  ? (providerScope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(
                request.headers.authorization === `Bearer ${clientToken}` ? clientScope : undefined,
              ),
          }),
        ),
        Layer.provide(ServerHttp.layerBrowserApiCors),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-mcp-origin-test-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      const traced = recordSpans();
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
        Effect.withTracer(traced.tracer),
      );
      const httpClient = yield* HttpClient.HttpClient;
      const call = (token: string | undefined) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          if (initialize.status !== 200) return initialize;
          return yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"probe","arguments":{}}}`,
              "application/json",
            ),
          });
        });

      expect((yield* call(providerToken)).status).toBe(200);
      // The tool gets its own span, without its arguments, which starts once authentication has ended.
      const toolSpan = traced.spans.find((span) => span.name === "mcp.tool.probe");
      expect(Object.fromEntries(toolSpan?.attributes ?? [])).toEqual({
        "rpc.system": "mcp",
        "rpc.method": "tools/call",
        "mcp.tool.name": "probe",
      });
      const authSpan = traced.spans.find(
        (span) =>
          span.name === "McpHttpServer.authenticateRequest" && span.traceId === toolSpan?.traceId,
      );
      expect(authSpan).toBeDefined();
      expect(traced.order.slice(0, traced.order.indexOf(`start ${toolSpan?.spanId}`))).toContain(
        `end ${authSpan?.spanId}`,
      );
      expect((yield* call(clientToken)).status).toBe(200);
      expect(seen.map((scope) => scope.requestNamespace)).toEqual([
        "provider-session",
        "client:session-1",
      ]);

      const missing = yield* call(undefined);
      expect(missing.status).toBe(401);
      expect(missing.headers["www-authenticate"]).toBe("Bearer");

      const expiredClient = yield* call("stale-payload.stale-signature");
      expect(expiredClient.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');

      const spansBeforeRejection = traced.spans.length;
      const deadProvider = yield* call("deadProviderToken");
      expect(deadProvider.status).toBe(401);
      expect(deadProvider.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
      // A rejected credential is recorded on the auth span, and nothing is handled.
      const rejectedSpans = traced.spans.slice(spansBeforeRejection);
      expect(
        rejectedSpans
          .filter((span) => span.name === "McpHttpServer.authenticateRequest")
          .map((span) => span.events.map(([name]) => name)),
      ).toEqual([[expect.stringContaining("unknown_or_expired_token")]]);
      expect(
        rejectedSpans.filter(
          (span) => span.name.startsWith("mcp.tool.") || span.name.startsWith("McpServer."),
        ),
      ).toEqual([]);

      // A present, disallowed Origin is refused with 403 before credentials or CORS answer.
      const foreignOrigin = (method: "POST" | "OPTIONS", token: string | undefined) =>
        httpClient.execute(
          HttpClientRequest.make(method)("/mcp", {
            headers: {
              origin: "https://untrusted.invalid",
              accept: "application/json, text/event-stream",
              "access-control-request-method": "POST",
              ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
            },
            ...(method === "POST"
              ? {
                  body: HttpBody.text(
                    `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
                    "application/json",
                  ),
                }
              : {}),
          }),
        );
      expect((yield* foreignOrigin("POST", providerToken)).status).toBe(403);
      expect((yield* foreignOrigin("POST", undefined)).status).toBe(403);
      expect((yield* foreignOrigin("OPTIONS", undefined)).status).toBe(403);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("accepts case-insensitive MCP bearer schemes and diagnoses rejected credentials", () => {
  const messages: Array<unknown> = [];
  const logger = Logger.make(({ message }) => messages.push(message));
  const layerAuth = Layer.mergeAll(EnvironmentAuth.layer, McpSessionRegistry.layer).pipe(
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-mcp-auth-header-test-" }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const providerToken = issued.config.authorizationHeader.slice("Bearer ".length);
      const cli = yield* auth.issueCliMcpClientSession({ label: "MCP header test" });
      yield* HttpRouter.serve(
        McpHttpServer.layerMcpTransport(Layer.empty).pipe(
          Layer.provide(McpHttpServer.layerCliClientAuthenticator),
          Layer.provide(ServerSettings.layerTest()),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;
      const initialize = (authorization?: string) =>
        httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            ...(authorization === undefined ? {} : { authorization }),
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-header-test","version":"1.0.0"}}}`,
            "application/json",
          ),
        });

      for (const scheme of ["Bearer", "bearer", "bEaReR"]) {
        for (const [kind, token] of [
          ["provider", providerToken],
          ["CLI", cli.token],
        ]) {
          const response = yield* initialize(`${scheme} ${token}`);
          expect.soft(response.status, `${kind} ${scheme}`).toBe(200);
        }
      }
      messages.length = 0;
      for (const [authorization, reason] of [
        [undefined, "missing_authorization_header"],
        [`Basic ${providerToken}`, "unsupported_scheme"],
        ["Bearer", "missing_bearer_token"],
        ["bEaReR ", "missing_bearer_token"],
        [`bearer ${providerToken.toUpperCase()}`, "unknown_or_expired_token"],
        [`bEaReR ${cli.token.toUpperCase()}`, "unknown_or_expired_token"],
      ] as const) {
        const response = yield* initialize(authorization);
        expect(response.status).toBe(401);
        expect
          .soft(messages.at(-1))
          .toEqual(["rejected MCP request with an unusable credential", { reason }]);
        const body = yield* response.text;
        expect(body).not.toContain(providerToken);
        expect(body).not.toContain(cli.token);
        expect(JSON.stringify(response.headers)).not.toContain(providerToken);
        expect(JSON.stringify(response.headers)).not.toContain(cli.token);
      }
      yield* registry.revokeThread(threadId);
      yield* auth.revokeSession(cli.sessionId);
      for (const token of [providerToken, cli.token]) {
        expect((yield* initialize(`bearer ${token}`)).status).toBe(401);
      }
      expect(JSON.stringify(messages)).not.toContain(providerToken);
      expect(JSON.stringify(messages)).not.toContain(cli.token);
      expect(JSON.stringify(messages)).not.toContain(providerToken.toUpperCase());
      expect(JSON.stringify(messages)).not.toContain(cli.token.toUpperCase());
    }),
  ).pipe(
    Effect.provide(
      layerAuth.pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
      ),
    ),
  );
});

it.effect("gives outside clients an upload URL on the origin their request reached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const token = "outsideClientToken";
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        requestNamespace: `client:${token}`,
        thread: undefined,
        client: { sessionId: token, label: "Hosted agent", access: "full-access" },
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      const serverLayer = McpHttpServer.layerMcpTransport(
        McpHttpServer.layerAttachmentToolkit,
      ).pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: () => Effect.undefined,
          }),
        ),
        // Signs in the way an OAuth client such as a hosted ChatGPT app does.
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator)({
            authenticate: (request) =>
              Effect.succeed(
                request.headers.authorization === `Bearer ${token}` ? scope : undefined,
              ),
          }),
        ),
        Layer.provide(
          AssetSigner.layer.pipe(
            Layer.provideMerge(ServerSecretStore.layer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-mcp-upload-" }),
            ),
            Layer.provideMerge(DocumentText.layer),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const prepareUpload = (proxyHeaders: Record<string, string>) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            ...proxyHeaders,
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          const response = yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: {
                  name: "ankiel_attachment_prepare_upload",
                  arguments: {
                    upload: {
                      type: "image",
                      name: "shot.png",
                      mimeType: "image/png",
                      sizeBytes: 6,
                    },
                  },
                },
              }),
              "application/json",
            ),
          });
          const body = (yield* response.json) as {
            result: { structuredContent: { uploadUrl: string } };
          };
          return body.result.structuredContent;
        });

      const direct = yield* prepareUpload({});
      const { address } = yield* HttpServer.HttpServer;
      if (!NetAddress.isInetAddress(address)) throw new Error("Expected a TCP test server");
      expect(new URL(direct.uploadUrl).origin).toBe(`http://127.0.0.1:${address.port}`);

      const proxied = yield* prepareUpload({ "x-forwarded-proto": "https" });
      expect(new URL(proxied.uploadUrl).protocol).toBe("https:");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
