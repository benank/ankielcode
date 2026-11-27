import {
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
  extractDevinSubagentUpdate,
} from "@ankielcode/provider-acp-registry/testing";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DocumentText from "../../provider/DocumentText.ts";
import { assert, beforeAll, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2UserInputQuestion,
  type ProviderUserInputAnswers,
} from "@ankielcode/contracts";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import { resolveSelfInvocation } from "@ankielcode/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ChildProcess from "effect/process/ChildProcess";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as TestProviderHost from "@ankielcode/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@ankielcode/provider-core/server/McpProviderSessions";
import * as AcpSessionRuntime from "@ankielcode/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import {
  AcpProviderCapabilitiesV2,
  acpScopedNativeId,
  acpToolCallDiffPatch,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@ankielcode/provider-acp/server/adapter";

const layerHost = TestProviderHost.layer().pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
);
// Node spends ~0.5s loading the agent scripts' TypeScript module graph on every spawn;
// a bundle built once per file starts in ~0.15s. Tests still talk to a real subprocess.
const bundledAgents = Deferred.makeUnsafe<{
  readonly mock: string;
  readonly replay: string;
  readonly compileCache: string;
}>();
const bundledMockAgentPath = Deferred.await(bundledAgents).pipe(
  Effect.map((agents) => agents.mock),
);
const bundleAgents = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ankiel-acp-agents-" });
  const input = {
    mock: yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url)),
    replay: yield* path.fromFileUrl(
      new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
    ),
  };
  const { build } = yield* Effect.promise(() => import("vite-plus"));
  yield* Effect.promise(() =>
    build({
      configFile: false,
      logLevel: "silent",
      root: path.dirname(input.mock),
      ssr: { noExternal: true },
      build: {
        ssr: true,
        outDir,
        rollupOptions: { input, output: { format: "es", entryFileNames: "[name].mjs" } },
      },
    }),
  );
  yield* Deferred.succeed(bundledAgents, {
    mock: path.join(outDir, "mock.mjs"),
    replay: path.join(outDir, "replay.mjs"),
    compileCache: path.join(outDir, "compile-cache"),
  });
}).pipe(Effect.provide(NodeServices.layer));

const ACP_TEST_DRIVER = ProviderDriverKind.make("acp-test");
const decodeUnknownJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

describe("acpToolCallDiffPatch", () => {
  it("builds per-file patches from ACP hunks and recorded old/new text", () => {
    for (const operation of ["add", "delete"]) {
      const text = operation === "add" ? "@@ -0,0 +1 @@\n+content\n" : "@@ -1 +0,0 @@\n-content\n";
      assert.equal(
        acpToolCallDiffPatch([
          {
            type: "diff",
            changes: [{ operation, path: "/repo/a.ts" }],
            patch: { format: "git_patch", text },
          },
        ]),
        [
          'diff --git "a//repo/a.ts" "b//repo/a.ts"',
          operation === "add" ? "--- /dev/null" : '--- "a//repo/a.ts"',
          operation === "delete" ? "+++ /dev/null" : '+++ "b//repo/a.ts"',
          text,
        ].join("\n"),
      );
    }
    assert.equal(
      acpToolCallDiffPatch([
        { type: "diff", path: "/repo/new.txt", oldText: null, newText: "hello\n" },
        { type: "diff", path: "/repo/a.ts", oldText: "a\nb\nc\n", newText: "a\nB\nc\n" },
        { type: "diff", path: "/repo/same.ts", oldText: "x\n", newText: "x\n" },
      ]),
      [
        "--- /dev/null",
        "+++ /repo/new.txt",
        "@@ -0,0 +1,1 @@",
        "+hello",
        "",
        "--- /repo/a.ts",
        "+++ /repo/a.ts",
        "@@ -1,3 +1,3 @@",
        " a",
        "-b",
        "+B",
        " c",
        "",
      ].join("\n"),
    );
    assert.equal(
      acpToolCallDiffPatch([
        {
          type: "diff",
          changes: [{ operation: "modify", path: "/repo/a.ts" }],
          patch: {
            format: "git_patch",
            text: "diff --git a/repo/a.ts b/repo/a.ts\n@@ -1 +1 @@\n-a\n+A\n",
          },
        },
        {
          type: "diff",
          changes: [{ operation: "modify", path: "/repo/b.ts" }],
          patch: {
            format: "git_patch",
            text: "diff --git a/repo/b.ts b/repo/b.ts\n@@ -1 +1 @@\n-b\n+B\n",
          },
        },
        { type: "diff", path: "/repo/c.ts", oldText: "c\n", newText: "C\n" },
      ]),
      [
        "diff --git a/repo/a.ts b/repo/a.ts",
        "@@ -1 +1 @@",
        "-a",
        "+A",
        "",
        "diff --git a/repo/b.ts b/repo/b.ts",
        "@@ -1 +1 @@",
        "-b",
        "+B",
        "",
        'diff --git "a//repo/c.ts" "b//repo/c.ts"',
        "--- /repo/c.ts",
        "+++ /repo/c.ts",
        "@@ -1,1 +1,1 @@",
        "-c",
        "+C",
        "",
      ].join("\n"),
    );
    assert.equal(
      acpToolCallDiffPatch([
        { type: "diff", path: "/repo/new.txt", oldText: null, newText: "hello\n" },
        {
          type: "diff",
          changes: [{ operation: "modify", path: "/repo/a.ts" }],
          patch: { format: "git_patch", text: "@@ -1 +1 @@\n-a\n+A\n" },
        },
      ]),
      [
        'diff --git "a//repo/new.txt" "b//repo/new.txt"',
        "--- /dev/null",
        "+++ /repo/new.txt",
        "@@ -0,0 +1,1 @@",
        "+hello",
        "",
        'diff --git "a//repo/a.ts" "b//repo/a.ts"',
        '--- "a//repo/a.ts"',
        '+++ "b//repo/a.ts"',
        "@@ -1 +1 @@",
        "-a",
        "+A",
        "",
      ].join("\n"),
    );
  });
});

function makeMockRuntime(input: {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly mockAgentPath: string;
  readonly environment?:
    | Readonly<Record<string, string>>
    | ((runtimeOrdinal: number) => Readonly<Record<string, string>>);
  readonly protocolEvents?: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>;
  readonly cancelBehavior?: AcpSessionRuntime.AcpSessionRuntimeOptions["cancelBehavior"];
  // Also opts into replay-idle readiness, which runtimes leave off by default.
  readonly sessionLoadReplayIdleGap?: Duration.Input;
  readonly ownDescendantProcessGroups?: boolean;
  readonly ownDetachedProcessGroup?: boolean;
  readonly processGroupPlatform?: NodeJS.Platform;
  readonly processGroupTerminationGrace?: Duration.Input;
  readonly linuxCgroupController?: AcpSessionRuntime.AcpSessionRuntimeOptions["linuxCgroupController"];
  readonly posixProcessTreeController?: AcpSessionRuntime.AcpSessionRuntimeOptions["posixProcessTreeController"];
  readonly windowsProcessTreeTerminator?: AcpSessionRuntime.AcpSessionRuntimeOptions["windowsProcessTreeTerminator"];
  readonly wrapCancel?: (
    cancel: AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"]["cancel"];
  readonly wrapOutgoingResponse?: (
    onOutgoingResponse: NonNullable<AcpAdapterV2RuntimeInput["onOutgoingResponse"]>,
  ) => NonNullable<AcpAdapterV2RuntimeInput["onOutgoingResponse"]>;
  readonly wrapRuntime?: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    runtimeOrdinal: number,
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"];
}): AcpAdapterV2Flavor["makeRuntime"] {
  let runtimeOrdinal = 0;
  return (runtimeInput) =>
    Effect.gen(function* () {
      runtimeOrdinal += 1;
      const protocolEvents = input.protocolEvents;
      const protocolLogging =
        protocolEvents === undefined
          ? runtimeInput.protocolLogging
          : {
              ...runtimeInput.protocolLogging,
              logIncoming: true,
              logOutgoing: true,
              logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
                Queue.offer(protocolEvents, event).pipe(
                  Effect.andThen(runtimeInput.protocolLogging.logger?.(event) ?? Effect.void),
                  Effect.asVoid,
                ),
            };
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          ...(input.cancelBehavior === undefined ? {} : { cancelBehavior: input.cancelBehavior }),
          ...(input.sessionLoadReplayIdleGap === undefined
            ? {}
            : {
                sessionLoadReplayIdleGap: input.sessionLoadReplayIdleGap,
                sessionLoadReplayIdleReadiness: true,
              }),
          ...(input.ownDetachedProcessGroup === undefined
            ? {}
            : { ownDetachedProcessGroup: input.ownDetachedProcessGroup }),
          ...(input.ownDescendantProcessGroups === undefined
            ? {}
            : { ownDescendantProcessGroups: input.ownDescendantProcessGroups }),
          ...(input.ownDetachedProcessGroup === true
            ? { processGroupPlatform: input.processGroupPlatform ?? "linux" }
            : {}),
          ...(input.processGroupTerminationGrace === undefined
            ? {}
            : { processGroupTerminationGrace: input.processGroupTerminationGrace }),
          ...(input.linuxCgroupController === undefined
            ? {}
            : { linuxCgroupController: input.linuxCgroupController }),
          ...(input.posixProcessTreeController === undefined
            ? {}
            : { posixProcessTreeController: input.posixProcessTreeController }),
          ...(input.windowsProcessTreeTerminator === undefined
            ? {}
            : { windowsProcessTreeTerminator: input.windowsProcessTreeTerminator }),
          protocolLogging,
          spawn: {
            command: process.execPath,
            args: [input.mockAgentPath],
            cwd: runtimeInput.cwd,
            env: {
              ANKIEL_ACP_SESSION_LIFECYCLE: "1",
              NODE_COMPILE_CACHE: (yield* Deferred.await(bundledAgents)).compileCache,
              ...(typeof input.environment === "function"
                ? input.environment(runtimeOrdinal)
                : input.environment),
            },
          },
          authMethodId: "test",
          ...(input.wrapOutgoingResponse === undefined ||
          runtimeInput.onOutgoingResponse === undefined
            ? {}
            : {
                onOutgoingResponse: input.wrapOutgoingResponse(runtimeInput.onOutgoingResponse),
              }),
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      const wrapped = {
        ...runtime,
        ...(input.wrapCancel === undefined ? {} : { cancel: input.wrapCancel(runtime.cancel) }),
      };
      return input.wrapRuntime?.(wrapped, runtimeOrdinal) ?? wrapped;
    });
}

it.effect("detaches owned ACP processes on POSIX hosts but not on Windows", () =>
  Effect.gen(function* () {
    for (const [platform, expected] of [
      ["win32", false],
      ["linux", true],
    ] as const) {
      let detached: boolean | undefined;
      yield* AcpSessionRuntime.make({
        spawn: { command: "acp-agent", args: [] },
        cwd: process.cwd(),
        clientInfo: { name: "test", version: "1" },
        ownDetachedProcessGroup: true,
        processGroupPlatform: platform,
      }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            if (ChildProcess.isStandardCommand(command)) detached = command.options.detached;
            return Effect.die("spawn stopped by test");
          }),
        ),
        Effect.scoped,
        Effect.exit,
      );
      assert.equal(detached, expected, platform);
    }
  }).pipe(Effect.provide(layerTest)),
);

const isProviderAdapterProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);

const makePromptInactivityHarness = Effect.fnUntraced(function* (input: {
  readonly environment: (runtimeOrdinal: number) => Readonly<Record<string, string>>;
  readonly runtimeMode?: "full-access" | "approval-required";
  readonly watchPromptOutcome?: AcpAdapterV2Flavor["watchPromptOutcome"];
  readonly wrapPrompt?: (
    prompt: AcpSessionRuntime.AcpSessionRuntime["Service"]["prompt"],
  ) => AcpSessionRuntime.AcpSessionRuntime["Service"]["prompt"];
  readonly cancelled?: Deferred.Deferred<void>;
  readonly followAgentWorkState?: boolean;
  readonly sessionScope?: Scope.Scope;
}) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const natives: Array<AcpSessionRuntime.AcpSessionRuntime["Service"]> = [];
  const instanceId = ProviderInstanceId.make("acp-prompt-inactivity");
  const adapter = yield* makeAcpAdapterV2({
    instanceId,
    flavor: {
      driver: ACP_TEST_DRIVER,
      capabilities: AcpProviderCapabilitiesV2,
      promptInactivityTimeout: "15 minutes",
      ...(input.watchPromptOutcome === undefined
        ? {}
        : { watchPromptOutcome: input.watchPromptOutcome }),
      ...(input.followAgentWorkState === true ? { followAgentWorkState: true } : {}),
      makeRuntime: makeMockRuntime({
        childProcessSpawner,
        mockAgentPath: yield* bundledMockAgentPath,
        environment: input.environment,
        wrapRuntime: (runtime) => {
          natives.push(runtime);
          return {
            ...runtime,
            prompt: input.wrapPrompt?.(runtime.prompt) ?? runtime.prompt,
            cancel:
              input.cancelled === undefined
                ? runtime.cancel
                : Deferred.succeed(input.cancelled, undefined).pipe(Effect.andThen(runtime.cancel)),
          };
        },
      }),
    },
    selfInvocation: yield* resolveSelfInvocation(),
    ...(input.followAgentWorkState === true
      ? { continuationRequests: { offer: () => Effect.void } }
      : {}),
  });
  const threadId = ThreadId.make("thread-acp-prompt-inactivity");
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    cwd: process.cwd(),
  });
  const modelSelection = { instanceId, model: "default" } as const;
  const opened = adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-acp-prompt-inactivity"),
    modelSelection,
    runtimePolicy,
  });
  const runtime = yield* input.sessionScope === undefined
    ? opened
    : opened.pipe(Effect.provideService(Scope.Scope, input.sessionScope));
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const startTurn = (ordinal: number) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        runtime.startTurn(
          makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal }),
        ),
      ),
    );
  return {
    runtime,
    natives,
    providerThread,
    startTurn,
    /** A turn still running makes the next start fail, without waiting on time. */
    nextTurnRejected: (ordinal: number) =>
      startTurn(ordinal).pipe(
        Effect.flip,
        Effect.map(
          (error) =>
            isProviderAdapterProtocolError(error.cause) &&
            error.cause.reason === "previous_turn_active",
        ),
        Effect.catchCause(() => Effect.succeed(false)),
      ),
    emitUpdate: (notification: EffectAcpSchema.SessionNotification) =>
      natives.at(-1)!.request("_test/emit-update", notification),
    terminals: (count: number) =>
      runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.take(count),
        Stream.runCollect,
        Effect.map((events) =>
          Array.from(events, (event) => {
            if (event.type !== "turn.terminal") throw new Error("Expected a turn terminal");
            return event;
          }),
        ),
      ),
  };
});

function rawProtocolMethod(event: EffectAcpProtocol.AcpProtocolLogEvent): string | undefined {
  if (event.stage !== "raw" || typeof event.payload !== "string") return undefined;
  for (const line of event.payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const decoded = Option.getOrUndefined(decodeUnknownJson(trimmed));
    if (typeof decoded === "object" && decoded !== null && "method" in decoded) {
      const method = (decoded as { readonly method?: unknown }).method;
      if (typeof method === "string") return method;
    }
  }
  return undefined;
}

function rawProtocolRequest(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): { readonly method?: unknown; readonly params?: unknown } | undefined {
  if (event.stage !== "raw" || typeof event.payload !== "string") return undefined;
  for (const line of event.payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const decoded = Option.getOrUndefined(decodeUnknownJson(trimmed));
    if (typeof decoded === "object" && decoded !== null && "method" in decoded) {
      return decoded;
    }
  }
  return undefined;
}

function rawProtocolRequestParam(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
  key: string,
): unknown {
  const params = rawProtocolRequest(event)?.params;
  return typeof params === "object" && params !== null ? Reflect.get(params, key) : undefined;
}

function rawProtocolPromptTextBlocks(
  event: EffectAcpProtocol.AcpProtocolLogEvent,
): Array<{ type: "text"; text: string }> {
  const prompt = rawProtocolRequestParam(event, "prompt");
  if (!Array.isArray(prompt)) return [];
  return prompt.flatMap((block) =>
    typeof block === "object" &&
    block !== null &&
    Reflect.get(block, "type") === "text" &&
    typeof Reflect.get(block, "text") === "string"
      ? [{ type: "text" as const, text: Reflect.get(block, "text") as string }]
      : [],
  );
}

const pollProtocolMethods = (events: Queue.Queue<EffectAcpProtocol.AcpProtocolLogEvent>) =>
  Effect.gen(function* () {
    const methods: string[] = [];
    let polled = 0;
    let event = yield* Queue.poll(events);
    while (Option.isSome(event) && polled < 256) {
      polled += 1;
      const method = rawProtocolMethod(event.value);
      if (method !== undefined) methods.push(method);
      event = yield* Queue.poll(events);
    }
    return methods;
  });

const runFormElicitation = (input: {
  readonly name: string;
  readonly requestedSchema: unknown;
  readonly answer: (
    questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  ) => ProviderUserInputAnswers | undefined;
}) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mockAgentPath = yield* bundledMockAgentPath;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "ankiel-acp-form-elicitation-",
    });
    const responseLog = path.join(directory, "responses.jsonl");
    const instanceId = ProviderInstanceId.make(`acp-test-form-${input.name}`);
    const adapter = yield* makeAcpAdapterV2({
      instanceId,
      flavor: {
        driver: ACP_TEST_DRIVER,
        capabilities: AcpProviderCapabilitiesV2,
        makeRuntime: makeMockRuntime({
          childProcessSpawner,
          mockAgentPath,
          environment: {
            ANKIEL_ACP_EMIT_ELICITATION: "1",
            ANKIEL_ACP_ELICITATION_SCHEMA: JSON.stringify(input.requestedSchema),
            ANKIEL_ACP_ELICITATION_RESPONSE_LOG_PATH: responseLog,
          },
        }),
      },
      selfInvocation: yield* resolveSelfInvocation(),
    });
    const threadId = ThreadId.make(`thread-acp-form-${input.name}`);
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "approval-required",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-acp-form-${input.name}`),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    yield* runtime.startTurn(
      makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy,
        now: yield* DateTime.now,
      }),
    );
    const first = Option.getOrThrow(
      yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "turn.terminal" ||
            (event.type === "turn_item.updated" && event.turnItem.type === "user_input_request"),
        ),
        Stream.runHead,
      ),
    );
    let questions: ReadonlyArray<OrchestrationV2UserInputQuestion> | undefined;
    if (first.type === "turn_item.updated" && first.turnItem.type === "user_input_request") {
      questions = first.turnItem.questions;
      const answers = input.answer(questions);
      yield* runtime.respondToRuntimeRequest({
        requestId: first.turnItem.requestId,
        ...(answers === undefined ? {} : { answers }),
      });
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
    }
    const responses = (yield* fileSystem.readFileString(responseLog))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => Option.getOrThrow(decodeUnknownJson(line)));
    assert.lengthOf(responses, 1);
    return { questions, response: responses[0] };
  });

describe("AcpAdapterV2", () => {
  beforeAll(() => bundleAgents);

  it.live("drops a late prompt response that lands after the turn finalized", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("acp-test-prompt-usage-late");
      const threadId = ThreadId.make("thread-acp-prompt-usage-late");
      const dispatched = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const wireSettled = yield* Deferred.make<void>();
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        testHooks: {
          afterPromptWireSettled: () =>
            Deferred.succeed(wireSettled, undefined).pipe(Effect.asVoid),
        },
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          reportsPerTurnPromptUsage: true,
          terminateRuntimeProcessGroupOnInterrupt: true,
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* bundledMockAgentPath,
            ownDetachedProcessGroup: true,
            processGroupTerminationGrace: 0,
            wrapRuntime: (runtime) => ({
              ...runtime,
              // The response only leaves the agent after the turn has been
              // force stopped and finalized: teardown does not interrupt this fiber.
              prompt: () =>
                Deferred.succeed(dispatched, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(
                    Effect.succeed({
                      stopReason: "cancelled" as const,
                      usage: { inputTokens: 60, outputTokens: 15, totalTokens: 75 },
                    }),
                  ),
                ),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-prompt-usage-late"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      let stopCollector = false;
      const events: Array<Record<string, unknown>> = [];
      const usageRecorded = yield* Deferred.make<void>();
      const collector = yield* Stream.runForEach(
        runtime.events.pipe(Stream.takeUntil(() => stopCollector)),
        (event) =>
          Effect.suspend(() => {
            const record = event as Record<string, unknown>;
            events.push(record);
            return record.type === "provider_turn.updated" &&
              (record.providerTurn as Record<string, unknown>).turnTokenUsage !== undefined
              ? Deferred.succeed(usageRecorded, undefined)
              : Effect.void;
          }),
      ).pipe(Effect.forkScoped);
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          messageText: "Say hi.",
        }),
      );
      yield* Deferred.await(dispatched);
      const providerTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, "mock-session-1:turn:1"),
      });
      // Force stop finalizes the turn without waiting for the gated prompt response.
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId,
        requestRuntimeRestart: true,
      });
      yield* Deferred.await(usageRecorded);
      const usageAt = () => {
        const turns = events.filter(
          (event) =>
            event.type === "provider_turn.updated" &&
            (event.providerTurn as Record<string, unknown>).turnTokenUsage !== undefined,
        );
        const last = turns[turns.length - 1] as
          | { providerTurn: Record<string, unknown> }
          | undefined;
        return last?.providerTurn.turnTokenUsage as Record<string, unknown>;
      };
      assert.deepEqual(usageAt(), {
        usageScope: "main_agent",
        usageStatus: "unavailable",
        hasSubagents: false,
      });
      // The response lands now; the finalized turn must not adopt its counters.
      yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(wireSettled);
      assert.deepEqual(usageAt(), {
        usageScope: "main_agent",
        usageStatus: "unavailable",
        hasSubagents: false,
      });
      stopCollector = true;
      yield* Fiber.interrupt(collector);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("replays history in order, with stable earlier snapshots", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("acp-test-v2-replay-order");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
            }),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-v2-replay-order");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-v2-replay-order"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      assert.isDefined(sessionUpdateHandler);
      const replay = (
        sessionUpdate: "user_message_chunk" | "agent_message_chunk",
        messageId: string,
        text: string,
      ) =>
        sessionUpdateHandler!({
          sessionId: "mock-session-1",
          update: { sessionUpdate, messageId, content: { type: "text", text } },
        });

      yield* replay("user_message_chunk", "u1", "<monitor-event> is ");
      yield* replay("user_message_chunk", "u1", "XML");
      yield* replay("agent_message_chunk", "a1", "hi");
      yield* replay("user_message_chunk", "u2", "next");
      yield* replay("agent_message_chunk", "a1", " ");
      yield* replay("agent_message_chunk", "a1", "there");
      yield* replay("agent_message_chunk", "a3", "\t");
      yield* replay("agent_message_chunk", "a3", "code with <monitor-event>");
      yield* replay("agent_message_chunk", "a4", "\n\n");
      yield* replay("user_message_chunk", "u3", "Why did Monitor 0123abcd ended appear?");
      // Grok's injected monitor wakes replay as user chunks and stay out of history.
      yield* replay(
        "user_message_chunk",
        "u4",
        '\n<monitor-event task_id="019f44a5-87d1-7640-8e35-6a4667ffc873">\nline\n</monitor-event>',
      );
      yield* replay(
        "user_message_chunk",
        "u5",
        'Monitor "019f44a5-87d1-7640-8e35-6a4667ffc873" ended: exit 0',
      );
      const first = yield* runtime.readThreadSnapshot({ providerThread });
      yield* replay("agent_message_chunk", "a2", "done");
      yield* replay("user_message_chunk", "u2", "\n");
      yield* replay("user_message_chunk", "u2", "\tone");
      yield* sessionUpdateHandler({
        sessionId: "mock-child-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Child private work" },
        },
      });
      const second = yield* runtime.readThreadSnapshot({ providerThread });

      const texts = (snapshot: typeof first) =>
        snapshot.messages.map((message) => `${message.role}:${message.text}`);
      assert.deepEqual(texts(first), [
        "user:<monitor-event> is XML",
        "assistant:hi there",
        "user:next",
        "assistant:\tcode with <monitor-event>",
        "user:Why did Monitor 0123abcd ended appear?",
      ]);
      assert.deepEqual(texts(second), [
        "user:<monitor-event> is XML",
        "assistant:hi there",
        "user:next\n\tone",
        "assistant:\tcode with <monitor-event>",
        "user:Why did Monitor 0123abcd ended appear?",
        "assistant:done",
      ]);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("persists a bounded subset of streamed root and child tool updates", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const mockAgentPath = yield* bundledMockAgentPath;
      type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let handler: Parameters<Runtime["handleSessionUpdate"]>[0] | undefined;
      // Devin resends the growing file without status on each update.
      const file = `${"x = 1\n".repeat(800)}END_OF_FILE\n`;
      const chunks = 200;
      const streamedWrite = (
        toolCallId: string,
        parentAgentId?: string,
      ): Array<EffectAcpSchema.SessionUpdate> => {
        const meta =
          parentAgentId === undefined ? {} : { "cognition.ai/subagent_context": { parentAgentId } };
        const write = (text: string, status?: "completed") => ({
          sessionUpdate: "tool_call_update" as const,
          toolCallId,
          title: "Writing ./audit.py",
          ...(status === undefined ? {} : { status }),
          content: [
            { type: "diff" as const, path: "/repo/audit.py", oldText: null, newText: text },
          ],
          rawInput: { file_path: "/repo/audit.py", content: text },
          _meta: meta,
        });
        return [
          {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Writing …",
            kind: "edit",
            status: "pending",
            _meta: meta,
          },
          ...Array.from({ length: chunks }, (_, index) =>
            write(file.slice(0, Math.ceil((file.length * (index + 1)) / chunks))),
          ),
          write(file, "completed"),
        ];
      };
      const instanceId = ProviderInstanceId.make("devin-streamed-write");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          normalizeSessionUpdate: normalizeDevinSessionUpdate,
          normalizeToolCall: normalizeDevinToolCall,
          extractSubagentUpdate: extractDevinSubagentUpdate,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (next) =>
                Effect.sync(() => {
                  handler = next;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(next))),
              prompt: () =>
                Effect.gen(function* () {
                  const updates = [
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-a",
                      status: "in_progress",
                      _meta: {
                        "cognition.ai/subagent_started": {
                          agentId: "child-a",
                          title: "Write audit script",
                          task: "Write audit.py.",
                        },
                      },
                    },
                    ...streamedWrite("root-write"),
                    ...streamedWrite("child-write", "child-a"),
                    ...Array.from({ length: 5 }, (_, index) => ({
                      sessionUpdate: "tool_call_update" as const,
                      toolCallId: "ticker",
                      title: "Watch ticks",
                      kind: "execute" as const,
                      status: "in_progress" as const,
                      rawOutput: `tick ${index + 1}`,
                    })),
                    ...Array.from({ length: 5 }, (_, index) => ({
                      sessionUpdate: "tool_call_update" as const,
                      toolCallId: "text-ticker",
                      title: "Watch ticks",
                      kind: "execute" as const,
                      status: "in_progress" as const,
                      rawOutput: { type: "Text", text: `tock ${index + 1}` },
                    })),
                    {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "child-a",
                      status: "completed",
                      _meta: {
                        "cognition.ai/subagent_completed": {
                          agentId: "child-a",
                          success: true,
                          summary: "Wrote audit.py",
                        },
                      },
                    },
                  ] satisfies Array<EffectAcpSchema.SessionUpdate>;
                  for (const update of updates)
                    yield* handler!({ sessionId: "mock-session-1", update });
                  return { stopReason: "end_turn" as const };
                }),
            }),
          }),
        },
      });
      const threadId = ThreadId.make("devin-streamed-write");
      const modelSelection = { instanceId, model: "default" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("devin-streamed-write-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const items = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      ).flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));
      for (const toolCallId of ["root-write", "child-write"]) {
        const writes = items.filter((item) => item.nativeItemRef?.nativeId?.endsWith(toolCallId));
        assert.isAtLeast(writes.length, chunks / 10, toolCallId);
        assert.isAtMost(writes.length, chunks / 5, toolCallId);
        assert.equal(writes.at(-1)?.status, "completed", toolCallId);
        assert.include(JSON.stringify(writes.at(-1)), "END_OF_FILE", toolCallId);
      }
      for (const [toolCallId, word] of [
        ["ticker", "tick"],
        ["text-ticker", "tock"],
      ] as const) {
        const ticks = items.filter((item) => item.nativeItemRef?.nativeId?.endsWith(toolCallId));
        for (let tick = 1; tick <= 5; tick++) {
          assert.isTrue(
            ticks.some((item) => JSON.stringify(item).includes(`${word} ${tick}`)),
            `${word} ${tick} must persist`,
          );
        }
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps protocol diagnostics off unless a protocol logger is supplied", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      const runTurn = Effect.fn("AcpAdapterV2.testProtocolLoggingTurn")(function* (
        name: string,
        nativeLogging?: NonNullable<Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"]>,
      ) {
        const events: Array<EffectAcpProtocol.AcpProtocolLogEvent> = [];
        const instanceId = ProviderInstanceId.make(`acp-test-${name}`);
        const threadId = ThreadId.make(`thread-acp-${name}`);
        const makeRuntime = makeMockRuntime({ childProcessSpawner, mockAgentPath });
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            makeRuntime: (runtimeInput) =>
              makeRuntime({
                ...runtimeInput,
                protocolLogging: {
                  ...runtimeInput.protocolLogging,
                  logger: (event) =>
                    Effect.sync(() => void events.push(event)).pipe(
                      Effect.andThen(runtimeInput.protocolLogging.logger?.(event) ?? Effect.void),
                    ),
                },
              }),
          },
          selfInvocation,
          ...(nativeLogging === undefined ? {} : { nativeLogging }),
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`provider-session-acp-${name}`),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
            ordinal: 1,
          }),
        );
        const terminal = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        assert.equal(Option.getOrThrow(terminal).status, "completed");
        return events;
      });

      assert.deepEqual(yield* runTurn("protocol-logging-default"), []);

      const explicit: Array<EffectAcpProtocol.AcpProtocolLogEvent> = [];
      yield* runTurn("protocol-logging-explicit", () => ({
        protocolLogging: {
          logIncoming: true,
          logOutgoing: true,
          logger: (event) => Effect.sync(() => void explicit.push(event)),
        },
      }));
      assert.isTrue(explicit.some((e) => e.direction === "incoming" && e.stage === "raw"));
      assert.isTrue(explicit.some((e) => e.direction === "outgoing"));
    }).pipe(Effect.provide(layerTest)),
  );

  it.live(
    "loads the persisted ACP session during startup without creating a throwaway session",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* bundledMockAgentPath;
        const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
        const instanceId = ProviderInstanceId.make("acp-test-eager-resume");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              protocolEvents,
            }),
          },
          selfInvocation,
        });
        const threadId = ThreadId.make("thread-acp-eager-resume");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-eager-resume"),
          modelSelection,
          runtimePolicy,
          initialNativeThreadId: "persisted-session",
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });

        assert.equal(providerThread.nativeThreadRef?.nativeId, "persisted-session");
        assert.isNull(providerThread.nativeMetadata);
        const startupMethods = yield* pollProtocolMethods(protocolEvents);
        assert.include(startupMethods, "session/resume");
        assert.notInclude(startupMethods, "session/new");
        const loaded = yield* runtime.readThreadSnapshot({ providerThread });
        assert.deepEqual(
          loaded.messages.map((message) => `${message.role}:${message.text}`),
          ["user:replay"],
        );

        yield* runtime.resumeThread({ providerThread, modelSelection, runtimePolicy });
        assert.notInclude(yield* pollProtocolMethods(protocolEvents), "session/resume");
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now,
            ordinal: 1,
          }),
        );
        const terminal = Array.from(
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        ).find((event) => event.type === "turn.terminal");
        assert.equal(
          terminal?.providerTurnId,
          idAllocator.derive.providerTurn({
            driver: ACP_TEST_DRIVER,
            nativeTurnId: "persisted-session:turn:1",
          }),
        );
      }).pipe(Effect.provide(layerTest)),
  );

  it.live("replaces an unexpectedly terminated ACP runtime before the next turn", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      const runtimeInputs: AcpAdapterV2RuntimeInput[] = [];
      let runtimeOrdinalSeen = 0;
      const baseMakeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        environment: (runtimeOrdinal) => {
          runtimeOrdinalSeen = runtimeOrdinal;
          return {};
        },
      });
      const instanceId = ProviderInstanceId.make("acp-test-unexpected-termination");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: (runtimeInput) =>
            Effect.sync(() => {
              runtimeInputs.push(runtimeInput);
            }).pipe(Effect.andThen(baseMakeRuntime(runtimeInput))),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-unexpected-termination");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-unexpected-termination"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      assert.equal(runtimeOrdinalSeen, 1);
      yield* runtimeInputs[0]!.onTermination!(
        new EffectAcpErrors.AcpTransportError({
          detail: "Injected unexpected writer termination",
          cause: "test",
        }),
      );

      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const startup = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.filter(
          (event) =>
            event.type === "provider_session.updated" ||
            (event.type === "provider_turn.updated" && event.providerTurn.status === "running"),
        ),
        Stream.runCollect,
      );
      assert.equal(runtimeOrdinalSeen, 2);
      assert.lengthOf(runtimeInputs, 2);
      // Loading the thread into the replacement agent is reported, and cleared before the turn runs.
      assert.deepEqual(
        Array.from(startup, (event) =>
          event.type === "provider_session.updated"
            ? (event.providerSession.startupPhase ?? null)
            : "turn running",
        ).slice(0, 3),
        ["resume", null, "turn running"],
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("fails a running prompt once when its agent process exits", () =>
    Effect.gen(function* () {
      const harness = yield* makePromptInactivityHarness({
        environment: (runtimeOrdinal) =>
          runtimeOrdinal === 1
            ? { ANKIEL_ACP_EMIT_TOOL_CALLS: "1" }
            : runtimeOrdinal === 2
              ? { ANKIEL_ACP_HANG_PROMPT_FOREVER: "1" }
              : {},
        runtimeMode: "approval-required",
      });
      yield* harness.startTurn(1);
      // The dying agent leaves an approval unanswered.
      yield* harness.runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        ),
        Stream.runHead,
      );
      yield* harness.natives[0]!.notify("_test/exit", {});
      const [exited] = yield* harness.terminals(1);
      assert.equal(exited?.status, "failed");

      // The replacement's silent prompt still times out.
      yield* harness.startTurn(2);
      yield* TestClock.adjust("15 minutes");
      yield* harness.startTurn(3);
      const [silent, next] = yield* harness.terminals(2);
      assert.equal(silent?.status, "failed");
      assert.notEqual(silent?.providerTurnId, exited?.providerTurnId);
      assert.equal(next?.status, "completed");
      assert.lengthOf(harness.natives, 3);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "answers fs requests method-not-found when the flavor does not opt into client fs",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const selfInvocation = yield* resolveSelfInvocation();
        const mockAgentPath = yield* bundledMockAgentPath;
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "ankiel-acp-no-client-fs-",
        });
        const probePath = path.join(workspace, "planted.txt");
        const probeLogPath = path.join(workspace, "fs-probe.jsonl");
        const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
        const instanceId = ProviderInstanceId.make("acp-test-no-client-fs");
        const adapter = yield* makeAcpAdapterV2({
          instanceId,
          flavor: {
            driver: ACP_TEST_DRIVER,
            capabilities: AcpProviderCapabilitiesV2,
            makeRuntime: makeMockRuntime({
              childProcessSpawner,
              mockAgentPath,
              protocolEvents,
              environment: {
                ANKIEL_ACP_CLIENT_FS_PROBE_PATH: probePath,
                ANKIEL_ACP_CLIENT_FS_PROBE_LOG_PATH: probeLogPath,
              },
            }),
          },
          selfInvocation,
        });
        const threadId = ThreadId.make("thread-acp-no-client-fs");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-no-client-fs"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        );
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );

        const initialize = Option.getOrThrow(
          yield* Stream.fromQueue(protocolEvents).pipe(
            Stream.filter(
              (event) =>
                event.direction === "outgoing" && rawProtocolMethod(event) === "initialize",
            ),
            Stream.runHead,
          ),
        );
        assert.deepInclude(
          (rawProtocolRequest(initialize)?.params as { clientCapabilities?: unknown })
            ?.clientCapabilities,
          { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        );
        const outcomes = (yield* fileSystem.readFileString(probeLogPath))
          .trim()
          .split("\n")
          .map((line) => Option.getOrThrow(decodeUnknownJson(line)));
        assert.deepEqual(outcomes, [
          { method: "fs/write_text_file", errorCode: -32601 },
          { method: "fs/read_text_file", errorCode: -32601 },
        ]);
        assert.isFalse(yield* fileSystem.exists(probePath));
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("does not turn an unknown permission approval into an execute grant", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let requestPermission: Parameters<RuntimeService["handleRequestPermission"]>[0] | undefined;
      let createTerminal: Parameters<RuntimeService["handleCreateTerminal"]>[0] | undefined;
      let runtimeInput: AcpAdapterV2RuntimeInput | undefined;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        environment: { ANKIEL_ACP_HANG_PROMPT_FOREVER: "1" },
        wrapRuntime: (runtime) => ({
          ...runtime,
          handleRequestPermission: (handler) =>
            Effect.sync(() => {
              requestPermission = handler;
            }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
          handleCreateTerminal: (handler) =>
            Effect.sync(() => {
              createTerminal = handler;
            }).pipe(Effect.andThen(runtime.handleCreateTerminal(handler))),
        }),
      });
      const instanceId = ProviderInstanceId.make("acp-test-unknown-permission-grant");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          interruptPromptOnCancel: true,
          makeRuntime: (input) =>
            Effect.sync(() => {
              runtimeInput = input;
            }).pipe(Effect.andThen(makeRuntime(input))),
        },
        selfInvocation,
        clientTerminals: {},
      });
      const threadId = ThreadId.make("thread-acp-unknown-permission-grant");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-unknown-permission-grant"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const turnFiber = yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        )
        .pipe(Effect.forkScoped);
      if (requestPermission === undefined || createTerminal === undefined) {
        return yield* Effect.die("ACP runtime must register permission and terminal handlers");
      }

      const permissionFiber = yield* requestPermission(
        {
          sessionId: "mock-session-1",
          toolCall: {
            toolCallId: "unknown-permission-tool",
            title: "Unknown permission kind",
          },
          options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
        },
        { requestId: "unknown-permission-request", method: "session/request_permission" },
      ).pipe(Effect.forkScoped);
      const pending = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (
        pending.type !== "runtime_request.updated" ||
        pending.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected an unknown ACP permission request");
      }
      const responseFiber = yield* runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.forkScoped);
      assert.equal((yield* Fiber.join(permissionFiber)).outcome.outcome, "selected");
      if (runtimeInput?.onOutgoingResponse === undefined) {
        return yield* Effect.die("ACP runtime must expose native response acknowledgements");
      }
      yield* runtimeInput.onOutgoingResponse("unknown-permission-request");
      yield* Fiber.join(responseFiber);

      const terminalExit = yield* createTerminal(
        {
          sessionId: "mock-session-1",
          command: process.execPath,
          args: ["-e", "process.stdout.write('unexpected')"],
        },
        { requestId: "unknown-permission-terminal", method: "terminal/create" },
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(terminalExit));

      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: pending.runtimeRequest.providerTurnId,
      });
      yield* Fiber.join(turnFiber);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("replaces the ACP session and clears conversation state on rollback", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      const instanceId = ProviderInstanceId.make("acp-test-rollback-session");
      const rollbackThreadId = ThreadId.make("thread-acp-rollback-session-target");
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-rollback-session-target"),
        threadId: rollbackThreadId,
        providerSessionId: "mcp-session-acp-rollback-session-target",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:43124/mcp",
        authorizationHeader: "Bearer rollback-target-token",
        browserToolsAvailable: false,
      });
      const runtimeInputs: Array<AcpAdapterV2RuntimeInput> = [];
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const nativeRuntimes: Array<AcpSessionRuntime.AcpSessionRuntime["Service"]> = [];
      let sessionEventCount = 0;
      const makeRuntime = makeMockRuntime({
        childProcessSpawner,
        mockAgentPath,
        protocolEvents,
        environment: { ANKIEL_ACP_PROMPT_DELAY_MS: "100" },
        wrapRuntime: (nativeRuntime) => {
          nativeRuntimes.push(nativeRuntime);
          return nativeRuntime;
        },
      });
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: (runtimeInput) =>
            Effect.sync(() => runtimeInputs.push(runtimeInput)).pipe(
              Effect.andThen(makeRuntime(runtimeInput)),
            ),
          onSessionEvent: () =>
            Effect.sync(() => {
              sessionEventCount += 1;
            }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-rollback-session");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-rollback-session"),
        modelSelection,
        runtimePolicy,
      });
      assert.isTrue(runtime.providerSession.capabilities.threads.canRollbackThread);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const firstSessionId = providerThread.nativeThreadRef?.nativeId;
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const activeRollback = yield* runtime
        .rollbackThread({
          providerThread,
          providerThreadTurns: [],
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint-acp-active-rollback"),
            appRunOrdinal: 0,
          },
        })
        .pipe(Effect.result);
      assert.equal(activeRollback._tag, "Failure");
      if (activeRollback._tag === "Failure") {
        assert.include(String(activeRollback.failure.cause), "while turn");
      }
      const firstProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(instanceId, `${firstSessionId}:turn:1`),
      });
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === firstProviderTurnId) break;
      }
      const rolledBack = yield* runtime.rollbackThread({
        providerThread: { ...providerThread, appThreadId: rollbackThreadId },
        providerThreadTurns: [],
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-acp-rollback-session"),
          appRunOrdinal: 0,
        },
      });
      assert.isString(rolledBack.providerThread.nativeThreadRef?.nativeId);
      assert.equal(
        runtimeInputs[1]?.processEnvironment?.ANKIEL_ACP_MCP_AUTHORIZATION,
        "Bearer rollback-target-token",
      );
      assert.equal(
        runtimeInputs[1]?.processEnvironment?.ANKIEL_THREAD_ID,
        "thread-acp-rollback-session-target",
      );
      const replacementMcpServer = runtimeInputs[1]?.mcpServers[0];
      const replacementMcpEnvironment =
        replacementMcpServer !== undefined &&
        "env" in replacementMcpServer &&
        Array.isArray(replacementMcpServer.env)
          ? replacementMcpServer.env
          : undefined;
      assert.equal(
        replacementMcpEnvironment?.find(
          (variable) => variable.name === "ANKIEL_ACP_MCP_AUTHORIZATION",
        )?.value,
        "Bearer rollback-target-token",
      );
      const snapshotAfterRollback = yield* runtime.readThreadSnapshot({
        providerThread: rolledBack.providerThread,
      });
      assert.deepEqual(snapshotAfterRollback.messages, []);
      const sessionEventsBeforeSecondTurn = sessionEventCount;

      yield* runtime.startTurn(
        makeTurnInput({
          threadId: rollbackThreadId,
          providerThread: rolledBack.providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
          ordinal: 2,
        }),
      );
      const secondProviderTurnId = idAllocator.derive.providerTurn({
        driver: ACP_TEST_DRIVER,
        nativeTurnId: acpScopedNativeId(
          instanceId,
          `${rolledBack.providerThread.nativeThreadRef?.nativeId}:turn:2`,
        ),
      });
      let secondStatus: string | null = null;
      while (secondStatus === null) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal" && event.providerTurnId === secondProviderTurnId) {
          secondStatus = event.status;
        }
      }
      assert.equal(secondStatus, "completed");
      yield* nativeRuntimes[1]!.drainEvents;
      assert.isAbove(sessionEventCount, sessionEventsBeforeSecondTurn);
      const prompts = Array.from(yield* Queue.takeAll(protocolEvents))
        .filter(
          (event) =>
            event.direction === "outgoing" && rawProtocolMethod(event) === "session/prompt",
        )
        .map(rawProtocolPromptTextBlocks);
      assert.lengthOf(prompts, 2);
      // The mock agent reuses its session id, so only the rollback reset resends these notes.
      assert.include(prompts[1]?.at(-1)?.text ?? "", "<runtime_info>");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("drains native ACP cancellation before admitting the next prompt", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const selfInvocation = yield* resolveSelfInvocation();
      const protocolEvents = yield* Queue.unbounded<EffectAcpProtocol.AcpProtocolLogEvent>();
      const native: { current?: AcpSessionRuntime.AcpSessionRuntime["Service"] } = {};
      const instanceId = ProviderInstanceId.make("acp-native-cancel");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          extractSubagentUpdate: (tool) =>
            tool.toolCallId === "native-failed-tool"
              ? {
                  nativeTaskId: tool.toolCallId,
                  childSessionId: null,
                  prompt: "Run a command",
                  title: null,
                  model: null,
                  status: tool.status === "failed" ? "failed" : "running",
                  result: tool.status === "failed" ? "Permission denied" : null,
                  suppressNormalTool: tool.status !== "failed",
                }
              : undefined,
          isCancelledToolCall: Schema.is(
            Schema.Struct({
              update: Schema.Struct({
                toolCallId: Schema.Literals(["native-cancel-tool", "native-unseen-cancel-tool"]),
              }),
            }),
          ),
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath: yield* bundledMockAgentPath,
            environment: { ANKIEL_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL: "1" },
            protocolEvents,
            cancelBehavior: "wait-for-prompt",
            wrapRuntime: (runtime) => {
              native.current = runtime;
              return runtime;
            },
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-native-cancel");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-acp-native-cancel"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
      );
      const started = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === "native-cancel-tool",
          ),
          Stream.runHead,
        ),
      );
      if (
        started.type !== "turn_item.updated" ||
        started.turnItem.providerTurnId === null ||
        native.current === undefined
      ) {
        return yield* Effect.die("Expected the native cancellable command");
      }
      const providerTurnId = started.turnItem.providerTurnId;
      const interrupt = yield* runtime
        .interruptTurn({ providerThread, providerTurnId })
        .pipe(Effect.forkScoped);
      yield* Stream.fromQueue(protocolEvents).pipe(
        Stream.filter(
          (event) =>
            event.direction === "incoming" &&
            typeof event.payload === "string" &&
            event.payload.includes("native-cancel-received"),
        ),
        Stream.runHead,
      );
      yield* native.current.request("_test/finish-cancel", {});
      yield* Fiber.join(interrupt);
      const untilTerminal = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil(
            (event) => event.type === "turn.terminal" && event.providerTurnId === providerTurnId,
          ),
          Stream.runCollect,
        ),
      );
      const terminal = untilTerminal.at(-1);
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "interrupted");
      // The agent fails the command Stop cut off, then updates its output.
      const command = untilTerminal
        .flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "native-cancel-tool"
            ? [event.turnItem]
            : [],
        )
        .at(-1);
      const unseenCommand = untilTerminal
        .flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "native-unseen-cancel-tool"
            ? [event.turnItem]
            : [],
        )
        .at(-1);
      assert.equal(unseenCommand?.status, "interrupted");
      assert.equal(command?.status, "interrupted");
      assert.include(command?.type === "command_execution" ? command.output : "", "exit 130");
      const failure = untilTerminal
        .flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.nativeItemRef?.nativeId === "native-failed-tool"
            ? [event.turnItem]
            : [],
        )
        .at(-1);
      assert.equal(failure?.status, "failed");
      const subagent = untilTerminal
        .flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "subagent"
            ? [event.turnItem]
            : [],
        )
        .at(-1);
      assert.equal(subagent?.status, "failed");
      assert.include(
        failure?.type === "command_execution" ? failure.output : "",
        "Permission denied",
      );
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal: 2 }),
      );
      const nextTerminal = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) => event.type === "turn.terminal" && event.providerTurnId !== providerTurnId,
          ),
          Stream.runHead,
        ),
      );
      assert.equal(nextTerminal.type === "turn.terminal" && nextTerminal.status, "completed");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("cancels pending permission requests while interrupting an ACP turn", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      const releaseCancel = yield* Deferred.make<void>();
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { ANKIEL_ACP_EMIT_TOOL_CALLS: "1" },
            wrapCancel: (cancel) => Deferred.await(releaseCancel).pipe(Effect.andThen(cancel)),
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-cancel-permission");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-cancel-permission"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn(
        makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
      );

      const pendingRequest = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (
        pendingRequest.type !== "runtime_request.updated" ||
        pendingRequest.runtimeRequest.providerTurnId === null
      ) {
        return yield* Effect.die("Expected a pending ACP permission request with a provider turn");
      }

      const interruptFiber = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: pendingRequest.runtimeRequest.providerTurnId,
        })
        .pipe(Effect.forkScoped);

      const cancelledRequest = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.id === pendingRequest.runtimeRequest.id &&
              event.runtimeRequest.status === "cancelled",
          ),
          Stream.runHead,
        ),
      );
      assert.equal(cancelledRequest.type, "runtime_request.updated");
      yield* Deferred.succeed(releaseCancel, undefined);
      yield* Fiber.join(interruptFiber);
      const terminal = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        ),
      );
      assert.equal(terminal.type, "turn.terminal");
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("answers a field named __proto__ like any other field", () =>
    Effect.gen(function* () {
      const { questions, response } = yield* runFormElicitation({
        name: "proto-field",
        requestedSchema: {
          type: "object",
          properties: {
            ["__proto__"]: { type: "string", enum: ["a", "b"] },
            name: { type: "string" },
          },
          required: ["__proto__", "name"],
        },
        answer: () => ({ ["__proto__"]: "b", name: "hi" }),
      });
      assert.deepStrictEqual(
        questions?.map((question) => question.id),
        ["__proto__", "name"],
      );
      assert.deepStrictEqual(response, {
        action: "accept",
        content: { ["__proto__"]: "b", name: "hi" },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("auto-approves tagged MCP elicitations under full-access policy", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* bundledMockAgentPath;
      const instanceId = ProviderInstanceId.make("acp-test-mcp-approval-elicitation");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            environment: { ANKIEL_ACP_EMIT_MCP_TOOL_APPROVAL_ELICITATION: "1" },
          }),
        },
        selfInvocation,
      });
      const threadId = ThreadId.make("thread-acp-mcp-approval-elicitation");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-mcp-approval-elicitation"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const events = Array.from(
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );

      assert.isFalse(events.some((event) => event.type === "runtime_request.updated"));
      assert.isTrue(events.some((event) => event.type === "turn.terminal"));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("persists context usage the agent reports after its prompt settles", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdateHandler: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const promptStarted = yield* Deferred.make<void>();
      const promptGate = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
      const instanceId = ProviderInstanceId.make("acp-test");
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation,
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: makeMockRuntime({
            childProcessSpawner,
            mockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              prompt: () =>
                Deferred.succeed(promptStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(promptGate)),
                ),
            }),
          }),
        },
      });
      const threadId = ThreadId.make("thread-acp-late-usage");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-late-usage"),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(promptStarted);
      const update = (update: EffectAcpSchema.SessionUpdate) =>
        sessionUpdateHandler!({ sessionId: "mock-session-1", update });
      yield* update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "OK" },
      });
      yield* Deferred.succeed(promptGate, { stopReason: "end_turn" });
      while ((yield* Queue.take(events)).type !== "turn.terminal");

      // Kimi Code 2.6.2 sends its usage_update just after answering session/prompt.
      yield* update({ sessionUpdate: "usage_update", used: 13101, size: 1048576 });
      let late: ProviderAdapter.ProviderAdapterV2Event;
      do late = yield* Queue.take(events);
      while (late.type !== "provider_thread.updated");
      assert.deepInclude(late.providerThread.contextUsage, { usedTokens: 13101 });
      // With no run left to receive it, only a session-scoped update reaches the projection.
      assert.isTrue(late.sessionScoped);
      // It is written straight to the projection, so it must not revive the settled turn.
      assert.equal(late.providerThread.status, "idle");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
