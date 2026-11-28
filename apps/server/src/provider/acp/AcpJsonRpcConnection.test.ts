// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "@ankielcode/provider-acp/server/AcpSessionRuntime";
import { AgentScope } from "@ankielcode/shared/AgentScope";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpProtocol from "effect-acp/protocol";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;
const mockAgentArgs = [mockAgentPath];
const mockRuntimeOptions = {
  spawn: { command: mockAgentCommand, args: mockAgentArgs },
  cwd: process.cwd(),
  clientInfo: { name: "ankiel-test", version: "0.0.0" },
  authMethodId: "test",
} satisfies AcpSessionRuntime.AcpSessionRuntimeOptions;

// The spawner extends the real process environment, so the test must set it there.
const setProcessEnv = (name: string, value: string) => {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
};

const isPromptStarted = (event: AcpSessionRuntime.AcpSessionRequestLogEvent) =>
  event.method === "session/prompt" && event.status === "started";

const isOutgoing = (tag: string) => (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
  event.direction === "outgoing" &&
  event.stage === "decoded" &&
  typeof event.payload === "object" &&
  event.payload !== null &&
  Reflect.get(event.payload, "tag") === tag;

// The methods the mock agent read, in order, keeping only the given ones.
const readReceived = (requestLogPath: string, methods: ReadonlyArray<string>) =>
  NodeFS.readFileSync(requestLogPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { readonly method?: string }).method)
    .filter((method) => method !== undefined && methods.includes(method));

// Prompts, then cancels while the prompt is held on its way out: in its started request record,
// in its outgoing protocol log record, or by its fiber yielding every few operations. The cancel
// comes on dispatch or from inside the held record. Returns the prompt's exit
// and the order in which the agent read the prompt, the cancel and the request that ends it.
const promptThenCancel = (input: {
  readonly cancelBehavior: "interrupt" | "wait-for-prompt";
  readonly holdPrompt: {
    readonly in: "request-log" | "protocol-log" | "scheduler";
    readonly cancelOn: "dispatch" | "log";
  };
}) =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-runtime-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
    const { holdPrompt } = input;
    const promptHeld = yield* Deferred.make<void>();
    const promptReleased = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(promptReleased, undefined));
    const testScope = yield* Scope.Scope;
    const runtimeMade = yield* Deferred.make<AcpSessionRuntime.AcpSessionRuntime["Service"]>();
    const cancelledFromLog = yield* Deferred.make<Fiber.Fiber<void, EffectAcpErrors.AcpError>>();
    const hold = (
      holdPrompt.cancelOn === "log"
        ? Deferred.await(runtimeMade).pipe(
            Effect.flatMap((made) =>
              made.cancel.pipe(Effect.forkIn(testScope, { startImmediately: true })),
            ),
            Effect.flatMap((fiber) => Deferred.succeed(cancelledFromLog, fiber)),
          )
        : Effect.void
    ).pipe(
      Effect.andThen(Deferred.succeed(promptHeld, undefined)),
      Effect.andThen(Deferred.await(promptReleased)),
    );
    const runtime = yield* AcpSessionRuntime.make({
      ...mockRuntimeOptions,
      spawn: {
        ...mockRuntimeOptions.spawn,
        env: {
          ANKIEL_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL: "1",
          ANKIEL_ACP_REQUEST_LOG_PATH: requestLogPath,
        },
      },
      cancelBehavior: input.cancelBehavior,
      interruptPromptOnCancel: false,
      protocolLogging: {
        logOutgoing: holdPrompt.in === "protocol-log",
        logger: (event) => (isOutgoing("session/prompt")(event) ? hold : Effect.void),
      },
      requestLogger: (event) =>
        holdPrompt.in === "request-log" && isPromptStarted(event) ? hold : Effect.void,
    });
    yield* Deferred.succeed(runtimeMade, runtime);
    const cancelReceived = yield* Deferred.make<void>();
    yield* runtime.getEvents().pipe(
      Stream.runForEach((event) => {
        if (event._tag === "EventStreamBarrier") {
          return Deferred.succeed(event.acknowledge, undefined);
        }
        if (event._tag === "ThoughtDelta" && event.text === "native-cancel-received") {
          return Deferred.succeed(cancelReceived, undefined);
        }
        return Effect.void;
      }),
      Effect.forkChild,
    );
    yield* runtime.start();
    const dispatched = yield* Deferred.make<void>();
    const prompt = yield* runtime
      .prompt({ prompt: [{ type: "text", text: "first" }] }, { dispatched })
      .pipe(
        holdPrompt.in === "scheduler"
          ? Effect.provideService(Scheduler.MaxOpsBeforeYield, 3)
          : (effect) => effect,
        Effect.forkChild,
      );
    // A round trip: whatever was queued before it reaches the agent first.
    const roundTrip = runtime.request("_test/environment", {});
    let cancel: Fiber.Fiber<void, EffectAcpErrors.AcpError>;
    if (holdPrompt.in === "scheduler") {
      yield* Deferred.await(dispatched);
      cancel = yield* runtime.cancel.pipe(Effect.forkChild({ startImmediately: true }));
    } else {
      yield* Deferred.await(promptHeld);
      if (holdPrompt.cancelOn === "dispatch") {
        cancel = yield* Deferred.await(dispatched).pipe(
          Effect.andThen(runtime.cancel),
          Effect.forkChild({ startImmediately: true }),
        );
      } else {
        cancel = yield* Deferred.await(cancelledFromLog);
      }
      yield* roundTrip;
      yield* Deferred.succeed(promptReleased, undefined);
    }
    yield* Deferred.await(cancelReceived);
    yield* runtime.request("_test/finish-cancel", {});
    // The agent answers it only after reading every earlier line.
    yield* roundTrip;
    const received = readReceived(requestLogPath, [
      "session/prompt",
      "session/cancel",
      "_test/finish-cancel",
    ]);
    const promptExit = yield* Fiber.await(prompt);
    yield* Fiber.join(cancel);
    return { received, promptExit };
  }).pipe(Effect.scoped);

describe("AcpSessionRuntime", () => {
  it.effect("waits for native cancellation and drains final updates before another prompt", () =>
    Effect.gen(function* () {
      const toolStarted = yield* Deferred.make<void>();
      const cancelReceived = yield* Deferred.make<void>();
      const events: Array<AcpSessionRuntime.AcpSessionRuntimeEvent> = [];
      let promptRequests = 0;
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        spawn: {
          ...mockRuntimeOptions.spawn,
          env: { ANKIEL_ACP_COMPLETE_FIRST_PROMPT_ON_CANCEL: "1" },
        },
        cancelBehavior: "wait-for-prompt",
        requestLogger: (event) =>
          Effect.sync(() => {
            if (event.method === "session/prompt" && event.status === "started")
              promptRequests += 1;
          }),
      });
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) => {
          if (event._tag === "EventStreamBarrier") {
            return Deferred.succeed(event.acknowledge, undefined);
          }
          events.push(event);
          if (event._tag === "ToolCallUpdated" && event.toolCall.status === "inProgress") {
            return Deferred.succeed(toolStarted, undefined);
          }
          if (event._tag === "ThoughtDelta" && event.text === "native-cancel-received") {
            return Deferred.succeed(cancelReceived, undefined);
          }
          return Effect.void;
        }),
        Effect.forkChild,
      );
      yield* runtime.start();
      const prompt = yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(toolStarted);
      const cancellation = yield* runtime.cancel.pipe(Effect.forkChild);
      yield* Deferred.await(cancelReceived);
      const replacement = yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "second" }],
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      expect(prompt.pollUnsafe()).toBeUndefined();
      expect(cancellation.pollUnsafe()).toBeUndefined();
      expect(promptRequests).toBe(1);
      yield* runtime.request("_test/finish-cancel", {});
      yield* Fiber.join(cancellation);

      expect(yield* Fiber.join(prompt)).toEqual({
        stopReason: "cancelled",
        _meta: { nativeCancel: true },
      });
      expect(
        events.some(
          (event) =>
            event._tag === "ToolCallUpdated" &&
            event.toolCall.status === "failed" &&
            event.toolCall.detail === "Cancelled.",
        ),
      ).toBe(true);
      const cancelledDelta = events.find(
        (event) => event._tag === "ContentDelta" && event.text === "Request cancelled.",
      );
      expect(cancelledDelta?._tag).toBe("ContentDelta");
      if (cancelledDelta?._tag === "ContentDelta") {
        expect(
          events.filter(
            (event) =>
              event._tag === "AssistantItemCompleted" && event.itemId === cancelledDelta.itemId,
          ),
        ).toHaveLength(1);
      }
      expect(yield* Fiber.join(replacement)).toMatchObject({ stopReason: "end_turn" });
      expect(promptRequests).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reports an idle child exit and rejects later prompts", () =>
    Effect.gen(function* () {
      const stopped = yield* Deferred.make<string>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* AcpSessionRuntime.make(mockRuntimeOptions).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            spawner.spawn(command).pipe(
              Effect.map((child) =>
                ChildProcessSpawner.makeHandle({
                  ...child,
                  // Model an inherited pipe held open until detached work is stopped.
                  stdout: Stream.concat(
                    child.stdout,
                    Stream.fromEffect(Deferred.await(stopped)).pipe(Stream.drain),
                  ),
                }),
              ),
            ),
          ),
        ),
        Effect.provideService(AgentScope, {
          ...AgentScope.defaultValue(),
          wrap: ({ command, args }) =>
            Effect.succeed({ command, args, unit: "ankielcode-acp-test.scope" }),
          stop: (unit) => Deferred.succeed(stopped, unit).pipe(Effect.asVoid),
        }),
      );
      yield* runtime.start();
      expect(yield* Deferred.isDone(stopped)).toBe(false);
      yield* runtime.notify("_test/exit", {});
      const events = yield* runtime.getEvents().pipe(Stream.take(1), Stream.runCollect);
      expect(yield* Deferred.await(stopped)).toBe("ankielcode-acp-test.scope");
      const event = events[0];
      expect(event).toMatchObject({ _tag: "ConnectionTerminated", error: { code: 19 } });
      if (event?._tag !== "ConnectionTerminated") return;
      expect(
        yield* runtime
          .prompt({
            prompt: [{ type: "text", text: "must not run" }],
          })
          .pipe(Effect.flip),
      ).toBe(event.error);
      expect(yield* runtime.start().pipe(Effect.flip)).toBe(event.error);
      expect(yield* runtime.initialize().pipe(Effect.flip)).toBe(event.error);
      expect(
        yield* runtime.request("_test/environment", {}).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined,
          }),
        ),
      ).toBe(event.error);
      expect(yield* runtime.notify("_test/exit", {}).pipe(Effect.flip)).toBe(event.error);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each([
    { name: "exit code", terminate: "process.exit(1)", code: 1, signal: undefined },
    ...(HostProcess.Platform.defaultValue() === "win32"
      ? []
      : [
          {
            name: "signal",
            terminate: "process.kill(process.pid, 'SIGTERM')",
            code: undefined,
            signal: "SIGTERM",
          },
        ]),
  ])("retains the $name and sanitized stderr when ACP exits before initialize", (testCase) =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        spawn: {
          command: process.execPath,
          args: [
            "-e",
            `process.stderr.write("Invalid project config: Unrecognized key in cli.json\\nAuthorization: Bearer secret-token-value\\n", () => { ${testCase.terminate}; });`,
          ],
        },
      });
      const error = yield* runtime.start().pipe(Effect.flip);
      assert.instanceOf(error, EffectAcpErrors.AcpProcessExitedError);
      expect(error.code).toBe(testCase.code);
      expect(error.signal).toBe(testCase.signal);
      expect(error).toMatchObject({
        pid: expect.any(Number),
        stderr:
          "Invalid project config: Unrecognized key in cli.json\nAuthorization: Bearer [redacted]",
      });
      expect(error.message).toBe(
        `${testCase.signal ? "ACP process exited after signal SIGTERM" : "ACP process exited with code 1"}\nInvalid project config: Unrecognized key in cli.json\nAuthorization: Bearer [redacted]`,
      );
      if (testCase.signal) {
        expect(error.cause).toMatchObject({
          reason: {
            module: "ChildProcess",
            method: "exitCode",
            cause: new Error("Process interrupted due to receipt of signal: 'SIGTERM'"),
          },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // A provided env is the complete child environment, as in OpenCodeRuntime; the AppImage
  // scrub deletes mount-only variables, which inheritance would put back.
  it.effect.each([
    { label: "with extendEnv false", extendEnv: false as const },
    { label: "when extendEnv is unset", extendEnv: undefined },
  ])(
    "does not restore ambient variables to a sanitized child environment $label",
    ({ extendEnv }) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => setProcessEnv("ANKIEL_ACP_RUNTIME_AMBIENT", "sentinel")),
          (restore) => Effect.sync(restore),
        );
        const runtime = yield* AcpSessionRuntime.make({
          ...mockRuntimeOptions,
          spawn: {
            command: process.execPath,
            args: mockAgentArgs,
            ...(extendEnv === undefined ? {} : { extendEnv }),
            env: { ANKIEL_ACP_RUNTIME_EXPLICIT: "kept" },
          },
        });
        yield* runtime.initialize();
        expect(yield* runtime.request("_test/environment", {})).toEqual({
          inherited: false,
          explicit: true,
        });
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("supports v2 session deletion and secret-safe provider management", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.deleteSession("native-session-1");
      expect((yield* runtime.listProviders).providers[0]).toMatchObject({
        providerId: "mock-provider",
        current: null,
      });
      yield* runtime.setProvider({
        providerId: "mock-provider",
        apiType: "openai",
        baseUrl: "https://api.example.test/v1",
        headers: { Authorization: "Bearer top-secret" },
      });
      expect((yield* runtime.listProviders).providers[0]?.current).toEqual({
        apiType: "openai",
        baseUrl: "https://api.example.test/v1",
      });
      yield* runtime.disableProvider("mock-provider");
      expect((yield* runtime.listProviders).providers[0]?.current).toBeNull();

      const setRequest = requestEvents.find(
        (event) => event.method === "providers/set" && event.status === "started",
      );
      expect(setRequest?.payload).toMatchObject({
        headers: { Authorization: "[redacted]" },
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { ANKIEL_ACP_V2_MANAGEMENT: "1" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "ankiel-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
  });

  it.effect("starts a session, prompts, and emits normalized events against the mock agent", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.initializeResult).toMatchObject({ protocolVersion: 2 });
      expect(started.sessionId).toBe("mock-session-1");

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes).toHaveLength(4);
      expect(notes.map((note) => note._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      const planUpdate = notes.find((note) => note._tag === "PlanUpdated");
      expect(planUpdate?._tag).toBe("PlanUpdated");
      if (planUpdate?._tag === "PlanUpdated") {
        expect(planUpdate.payload).toMatchObject({
          nativePlanId: "mock-plan",
          kind: "items",
        });
        if (planUpdate.payload.kind === "items") {
          expect(planUpdate.payload.plan).toHaveLength(2);
        }
      }
      const assistantStart = notes[1];
      const assistantDelta = notes[2];
      if (
        assistantStart?._tag === "AssistantItemStarted" &&
        assistantDelta?._tag === "ContentDelta"
      ) {
        expect(assistantDelta.itemId).toBe(assistantStart.itemId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
          },
          cwd: process.cwd(),
          clientInfo: { name: "ankiel-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );

  it.effect("drops session updates emitted for a child ACP session", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes.map((note) => note._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      expect(
        notes
          .filter((note) => note._tag === "ContentDelta")
          .map((note) => note.text)
          .join(""),
      ).toBe("root before child root after child");
      expect(notes.some((note) => note._tag === "ToolCallUpdated")).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              ANKIEL_ACP_EMIT_FOREIGN_SESSION_UPDATES: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "ankiel-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );

  it.effect("rejects unauthenticated ACP session lifecycle requests", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const listError = yield* runtime.listSessions().pipe(Effect.flip);
      expect(listError._tag).toBe("AcpRequestError");
      if (listError._tag === "AcpRequestError") {
        expect(listError.code).toBe(-32000);
      }

      const forkError = yield* runtime.forkSession("mock-session-1").pipe(Effect.flip);
      expect(forkError._tag).toBe("AcpRequestError");
      if (forkError._tag === "AcpRequestError") {
        expect(forkError.code).toBe(-32000);
      }

      const resumeError = yield* runtime.resumeSession("mock-session-1").pipe(Effect.flip);
      expect(resumeError._tag).toBe("AcpRequestError");
      if (resumeError._tag === "AcpRequestError") {
        expect(resumeError.code).toBe(-32000);
      }

      const closeError = yield* runtime.closeSession().pipe(Effect.flip);
      expect(closeError._tag).toBe("AcpRequestError");
      if (closeError._tag === "AcpRequestError") {
        expect(closeError.code).toBe(-32000);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              ANKIEL_ACP_REQUIRE_AUTH: "1",
              ANKIEL_ACP_SESSION_LIFECYCLE: "1",
            },
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          clientInfo: { name: "ankiel-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );

  it.live("drops a late session/load response when a selection was sent before it", () =>
    Effect.gen(function* () {
      const lateLoadLogged = yield* Deferred.make<void>();
      const runtime = yield* AcpSessionRuntime.make({
        ...mockRuntimeOptions,
        spawn: {
          ...mockRuntimeOptions.spawn,
          env: {
            ANKIEL_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY: "1",
            ANKIEL_ACP_LOAD_SESSION_DELAY_MS: "500",
            ANKIEL_ACP_HOLD_SET_CONFIG_OPTION_UNTIL_LOAD_REPLY: "1",
          },
        },
        resumeSessionId: "mock-session-1",
        sessionLoadReplayIdleGap: "100 millis",
        sessionLoadReplayIdleReadiness: true,
        requestLogger: (event) =>
          event.method === "session/load" &&
          event.status === "succeeded" &&
          (event.result as { readonly configOptions?: unknown } | undefined)?.configOptions !==
            undefined
            ? Deferred.succeed(lateLoadLogged, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      const started = yield* runtime.start();
      // The agent answers the load before this request, so no config change
      // is visible when the late response arrives.
      yield* runtime.setConfigOption("model", "gpt-5.4");
      yield* Deferred.await(lateLoadLogged).pipe(Effect.timeout("5 seconds"));

      expect((yield* runtime.start()).sessionSetupResult).toBe(started.sessionSetupResult);
      const model = (yield* runtime.getConfigOptions).find((option) => option.id === "model");
      expect(model?.currentValue).toBe("gpt-5.4");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("ignores session/update replay notifications during session/load", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes.map((note) => note._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      expect(notes.some((note) => note._tag === "ToolCallUpdated")).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              ANKIEL_ACP_EMIT_LOAD_REPLAY: "1",
            },
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          clientInfo: { name: "ankiel-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );

  it.effect.each(
    (["interrupt", "wait-for-prompt"] as const).flatMap((cancelBehavior) =>
      (
        [
          { in: "request-log", cancelOn: "dispatch" },
          { in: "protocol-log", cancelOn: "log" },
          { in: "scheduler", cancelOn: "dispatch" },
        ] as const
      ).map((holdPrompt) => ({ cancelBehavior, holdPrompt })),
    ),
  )(
    "sends session/prompt before a cancel issued while the prompt is held in the $holdPrompt.in ($cancelBehavior, cancel on $holdPrompt.cancelOn)",
    ({ cancelBehavior, holdPrompt }) =>
      Effect.gen(function* () {
        const run = yield* promptThenCancel({ cancelBehavior, holdPrompt });
        expect(run.received).toEqual(["session/prompt", "session/cancel", "_test/finish-cancel"]);
        expect(run.promptExit).toEqual(
          Exit.succeed({ stopReason: "cancelled", _meta: { nativeCancel: true } }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "sends a cancel before the next prompt when the prompt it waited for never went out",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-runtime-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        let promptsStarted = 0;
        const runtime = yield* AcpSessionRuntime.make({
          ...mockRuntimeOptions,
          spawn: {
            ...mockRuntimeOptions.spawn,
            env: { ANKIEL_ACP_REQUEST_LOG_PATH: requestLogPath },
          },
          interruptPromptOnCancel: false,
          // The cancel spends a test-clock second in its outgoing record, the window in which the
          // next prompt could overtake it.
          protocolLogging: {
            logOutgoing: true,
            logger: (event) =>
              isOutgoing("session/cancel")(event) ? Effect.sleep("1 second") : Effect.void,
          },
          requestLogger: (event) =>
            isPromptStarted(event) && promptsStarted++ === 0 ? Effect.never : Effect.void,
        });
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) =>
            event._tag === "EventStreamBarrier"
              ? Deferred.succeed(event.acknowledge, undefined)
              : Effect.void,
          ),
          Effect.forkChild,
        );
        yield* runtime.start();
        const dispatched = yield* Deferred.make<void>();
        const first = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "first" }] }, { dispatched })
          .pipe(Effect.forkChild);
        yield* Deferred.await(dispatched);
        const cancel = yield* runtime.cancel.pipe(Effect.forkChild({ startImmediately: true }));
        const next = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "next" }] })
          .pipe(Effect.forkChild);
        // The first prompt ends before it is queued, which releases the cancel's wait.
        yield* Effect.sleep("1 second").pipe(
          Effect.andThen(Fiber.interrupt(first)),
          Effect.forkChild,
        );
        yield* TestClock.adjust("1 second");
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(cancel);
        yield* Fiber.join(next);
        expect(readReceived(requestLogPath, ["session/prompt", "session/cancel"])).toEqual([
          "session/cancel",
          "session/prompt",
        ]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
