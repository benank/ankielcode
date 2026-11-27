import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@ankielcode/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as TestProviderHost from "@ankielcode/provider-testing/TestProviderHost";
import * as ProviderContinuationRequests from "@ankielcode/provider-core/server/ProviderContinuationRequests";
import * as McpProviderSessions from "@ankielcode/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@ankielcode/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@ankielcode/provider-core/server/ProviderAdapter";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import { makePiAdapterV2, PiAdapterV2Driver, type PiAdapterV2Options } from "./adapter.ts";
import { type PiRpcRecord } from "./rpc.ts";
import { PI_ANKIEL_SERVICE_TIER_COMMAND } from "./mcpExtensionSource.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PI_INSTANCE_ID = ProviderInstanceId.make("pi");
const THREAD_ID = ThreadId.make("thread-pi-test");
const SESSION_ID = ProviderSessionId.make("provider-session-pi-test");
const FAKE_SESSION_FILE = "/fake/.pi/agent/sessions/--workspace--/0001_abc.jsonl";
/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_999;

const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const modelSelection = (model: string): ModelSelection => ({
  instanceId: PI_INSTANCE_ID,
  model,
});

interface FakePi {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly emit: (record: PiRpcRecord, chunkBytes?: number) => Effect.Effect<void>;
  readonly takeRequest: (type: string) => Effect.Effect<PiRpcRecord>;
  readonly queueEntries: (data: unknown) => void;
  readonly queueMessages: (data: unknown) => void;
  readonly vetoNextSwitch: () => void;
  readonly failNextFork: () => void;
  readonly queueState: (data: Record<string, unknown>) => void;
  readonly setStreaming: (streaming: boolean) => void;
  readonly setCompacting: (compacting: boolean) => void;
  readonly deferNextState: (started?: Deferred.Deferred<void>) => void;
  readonly resolveDeferredState: (data: unknown) => Effect.Effect<void>;
  readonly failNextState: (skip?: number) => void;
  readonly failNextThinking: () => void;
  readonly deferNextLifecycle: (
    type: "switch_session" | "new_session" | "fork" | "prompt" | "abort",
  ) => void;
  readonly deferNextModelSelection: () => void;
  readonly queueModels: (models: ReadonlyArray<unknown>) => void;
  readonly vetoNextNewSession: () => void;
  readonly allRequests: () => ReadonlyArray<PiRpcRecord>;
  readonly promptThinkingLevels: ReadonlyArray<string>;
  readonly promptModels: ReadonlyArray<string>;
  /** Simulates a native extension changing Pi's active selection. */
  readonly changeNatively: (change: {
    readonly model?: string;
    readonly thinking?: string;
  }) => void;
  /** Ankiel extension's service tier as each prompt was sent; Pi resets it with each session. */
  readonly promptServiceTiers: ReadonlyArray<string | null>;
  /** Pi reloads extensions without the adapter seeing it, e.g. a user extension's ctx.newSession(). */
  readonly reloadExtensions: (newSessionFile?: string) => void;
  /** Pi before 0.99 acknowledges prompts without a disposition. */
  readonly omitPromptDisposition: () => void;
  readonly queueStats: (data: unknown) => void;
  /** Pi before 0.84.4 answers clear_queue as an unknown command. */
  readonly setClearQueue: (
    result:
      | { readonly steering: ReadonlyArray<string>; readonly followUp: ReadonlyArray<string> }
      | "unknown_command",
  ) => void;
  readonly closeStdout: Effect.Effect<void>;
  readonly lastSpawn: () => {
    readonly args: ReadonlyArray<string>;
    readonly env: NonNullable<ChildProcess.CommandOptions["env"]>;
  };
}

/** Pi omits `model` when none is selected and `sessionName` until one is set. */
const recordedIdleState = (sessionFile: string) => ({
  thinkingLevel: "high",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  sessionFile,
  sessionId: "00000000-0000-4000-8000-000000000002",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
});

/** Pi 1.4.0 rejects every prompt while compaction runs, including steers. */
const PI_COMPACTING_PROMPT_ERROR =
  "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";

const makeFakePi: Effect.Effect<FakePi> = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests = yield* Queue.unbounded<PiRpcRecord>();
  const entriesQueue: Array<unknown> = [];
  const messagesQueue: Array<unknown> = [];
  const stateQueue: Array<Record<string, unknown>> = [];
  const statsQueue: Array<unknown> = [];
  const allRequests: Array<PiRpcRecord> = [];
  let deferState = false;
  let deferredStateStarted: Deferred.Deferred<void> | undefined;
  let deferredStateRequest: PiRpcRecord | undefined;
  let failStateAfter: number | null = null;
  let failThinking = false;
  let vetoSwitch = false;
  let failFork = false;
  let vetoNewSession = false;
  let deferredLifecycle: string | undefined;
  let sessionFile = FAKE_SESSION_FILE;
  let sessionGeneration = 0;
  let models: ReadonlyArray<unknown> = [];
  let isStreaming: boolean | null = null;
  let isCompacting = false;
  let clearQueue: Parameters<FakePi["setClearQueue"]>[0] = { steering: [], followUp: [] };
  let stdinBuffer = "";
  let thinkingLevel = "high";
  const promptThinkingLevels: Array<string> = [];
  const promptModels: Array<string> = [];
  const promptServiceTiers: Array<string | null> = [];
  let serviceTier: string | null = null;
  let promptDisposition = true;
  let currentModel = "default";
  const serviceTierCommand = `/${PI_ANKIEL_SERVICE_TIER_COMMAND}`;

  const emit = (record: PiRpcRecord, chunkBytes?: number) =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(`${encodeJsonLine(record)}\n`);
      const size = chunkBytes ?? bytes.byteLength;
      for (let offset = 0; offset < bytes.byteLength; offset += size) {
        yield* Queue.offer(stdout, bytes.subarray(offset, offset + size));
      }
    });

  const respondTo = (record: PiRpcRecord): PiRpcRecord | null => {
    if (
      typeof record["id"] !== "string" &&
      !(record["type"] === "prompt" && (isStreaming !== null || isCompacting))
    )
      return null;
    const base = {
      type: "response",
      id: record["id"],
      command: String(record["type"]),
      success: true,
    };
    switch (record["type"]) {
      case "get_state":
        if (failStateAfter !== null && failStateAfter-- === 0) {
          failStateAfter = null;
          return { ...base, success: false, error: "state unavailable" };
        }
        return {
          ...base,
          data: {
            ...recordedIdleState(sessionFile),
            thinkingLevel,
            ...(currentModel === "default"
              ? {}
              : {
                  model: {
                    provider: currentModel.slice(0, currentModel.indexOf("/")),
                    id: currentModel.slice(currentModel.indexOf("/") + 1),
                  },
                }),
            isStreaming: isStreaming ?? false,
            ...stateQueue.shift(),
          },
        };
      case "set_model":
        // Pi reapplies the target model's configured thinking default.
        thinkingLevel = "low";
        currentModel = `${String(record["provider"])}/${String(record["modelId"])}`;
        return base;
      case "set_thinking_level":
        if (failThinking) {
          failThinking = false;
          return { ...base, success: false, error: "thinking unavailable" };
        }
        thinkingLevel = String(record["level"]);
        return base;
      case "prompt":
        if (String(record["message"]).startsWith(serviceTierCommand)) {
          serviceTier = String(record["message"]).slice(serviceTierCommand.length).trim() || null;
          return promptDisposition ? { ...base, data: { disposition: "handled" } } : base;
        }
        if (isCompacting) {
          return { ...base, success: false, error: PI_COMPACTING_PROMPT_ERROR };
        }
        if (isStreaming && record["streamingBehavior"] === undefined) {
          return {
            ...base,
            success: false,
            error:
              "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
          };
        }
        return promptDisposition && isStreaming
          ? { ...base, data: { disposition: "queued" } }
          : base;
      case "get_available_models":
        return { ...base, data: { models } };
      case "new_session": {
        const cancelled = vetoNewSession;
        vetoNewSession = false;
        if (!cancelled) {
          sessionFile = `/fake/new-${++sessionGeneration}.jsonl`;
          serviceTier = null;
        }
        return { ...base, data: { cancelled } };
      }
      case "switch_session": {
        const cancelled = vetoSwitch;
        vetoSwitch = false;
        if (!cancelled) serviceTier = null;
        return { ...base, data: { cancelled } };
      }
      case "get_entries":
        return { ...base, data: entriesQueue.shift() ?? { entries: [], leafId: null } };
      case "get_messages":
        return { ...base, data: messagesQueue.shift() ?? { messages: [] } };
      case "get_session_stats":
        return { ...base, data: statsQueue.shift() ?? {} };
      case "fork":
        if (failFork) {
          failFork = false;
          return { ...base, success: false, error: "Invalid entry ID for forking" };
        }
        serviceTier = null;
        return { ...base, data: { text: "Hello pi", cancelled: false } };
      case "clear_queue":
        return clearQueue === "unknown_command"
          ? { ...base, success: false, error: "Unknown command: clear_queue" }
          : { ...base, data: clearQueue };
      default:
        return base;
    }
  };

  const handleStdinChunk = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      stdinBuffer += new TextDecoder().decode(chunk);
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline === -1) return;
        const line = stdinBuffer.slice(0, newline);
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        const record = decodeJsonLine(line) as PiRpcRecord;
        if (
          record["type"] === "prompt" &&
          !String(record["message"]).startsWith(serviceTierCommand)
        ) {
          promptThinkingLevels.push(thinkingLevel);
          promptModels.push(currentModel);
          promptServiceTiers.push(serviceTier);
        }
        allRequests.push(record);
        yield* Queue.offer(requests, record);
        if (record["type"] === "get_state" && deferState) {
          deferState = false;
          deferredStateRequest = record;
          if (deferredStateStarted !== undefined) {
            yield* Deferred.succeed(deferredStateStarted, undefined);
            deferredStateStarted = undefined;
          }
          continue;
        }
        if (record["type"] === deferredLifecycle) {
          deferredLifecycle = undefined;
          continue;
        }
        const response = respondTo(record);
        if (response !== null) yield* emit(response);
      }
    });

  let lastSpawn: ReturnType<FakePi["lastSpawn"]> = {
    args: [],
    env: {},
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (ChildProcess.isStandardCommand(command)) {
        lastSpawn = {
          args: command.args.map(String),
          env: command.options.env ?? {},
        };
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach(handleStdinChunk),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  const takeRequest = (type: string): Effect.Effect<PiRpcRecord> =>
    Effect.gen(function* () {
      while (true) {
        const record = yield* Queue.take(requests);
        if (record["type"] === type) return record;
      }
    });

  return {
    spawner,
    failNextThinking: () => {
      failThinking = true;
    },
    promptThinkingLevels,
    promptModels,
    changeNatively: (change) => {
      currentModel = change.model ?? currentModel;
      thinkingLevel = change.thinking ?? thinkingLevel;
    },
    promptServiceTiers,
    reloadExtensions: (newSessionFile) => {
      serviceTier = null;
      if (newSessionFile !== undefined) sessionFile = newSessionFile;
    },
    omitPromptDisposition: () => {
      promptDisposition = false;
    },
    emit,
    takeRequest,
    queueEntries: (data) => entriesQueue.push(data),
    queueMessages: (data) => messagesQueue.push(data),
    deferNextState: (started) => {
      deferState = true;
      deferredStateStarted = started;
    },
    resolveDeferredState: (data) =>
      Effect.gen(function* () {
        const record = deferredStateRequest;
        assert.isDefined(record);
        deferredStateRequest = undefined;
        yield* emit({
          type: "response",
          id: record!["id"],
          command: "get_state",
          success: true,
          data,
        });
      }),
    failNextState: (skip = 0) => {
      failStateAfter = skip;
    },
    deferNextLifecycle: (type) => {
      deferredLifecycle = type;
    },
    deferNextModelSelection: () => {
      deferredLifecycle = "set_model";
    },
    queueModels: (value) => {
      models = value;
    },
    vetoNextNewSession: () => {
      vetoNewSession = true;
    },
    allRequests: () => allRequests,
    vetoNextSwitch: () => {
      vetoSwitch = true;
    },
    failNextFork: () => {
      failFork = true;
    },
    queueState: (data) => stateQueue.push(data),
    setStreaming: (streaming) => {
      isStreaming = streaming;
    },
    setCompacting: (compacting) => {
      isCompacting = compacting;
    },
    queueStats: (data) => statsQueue.push(data),
    setClearQueue: (result) => {
      clearQueue = result;
    },
    closeStdout: Queue.end(stdout),
    lastSpawn: () => lastSpawn,
  } satisfies FakePi;
});

const makeAdapter = Effect.fnUntraced(function* (
  fake: FakePi,
  launchArgs = "",
  forkFake?: FakePi,
  continuationRequests?: PiAdapterV2Options["continuationRequests"],
) {
  const spawner =
    forkFake === undefined
      ? fake.spawner
      : ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.args.includes("--fork")
            ? forkFake.spawner.spawn(command)
            : fake.spawner.spawn(command),
        );
  if (continuationRequests !== undefined) {
    return yield* PiAdapterV2Driver.create({
      instanceId: PI_INSTANCE_ID,
      displayName: undefined,
      enabled: true,
      environment: [],
      config: { enabled: true, binaryPath: "pi", launchArgs, customModels: [] },
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
        ...continuationRequests,
        take: Effect.never,
      }),
    );
  }
  return yield* makePiAdapterV2({
    instanceId: PI_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "pi", launchArgs, customModels: [] },
    environment: {},
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
});

const openRuntime = Effect.fnUntraced(function* (
  fake: FakePi,
  model = "default",
  threadId = THREAD_ID,
  providerSessionId = SESSION_ID,
  forkFake?: FakePi,
  continuationRequests?: PiAdapterV2Options["continuationRequests"],
  initialNativeThreadId?: string,
) {
  const adapter = yield* makeAdapter(fake, "", forkFake, continuationRequests);
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId,
    modelSelection: modelSelection(model),
    runtimePolicy,
    ...(initialNativeThreadId === undefined ? {} : { initialNativeThreadId }),
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  return { runtime, takeEvent };
});

const makeAppThread = Effect.fnUntraced(function* (model: string, threadId = THREAD_ID) {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: "project:fixture:pi" as OrchestrationV2AppThread["projectId"],
    title: "Pi test thread",
    providerInstanceId: PI_INSTANCE_ID,
    modelSelection: modelSelection(model),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  model = "default",
  attachments: ReadonlyArray<ChatAttachment> = [],
  text = "Hello pi",
  selection?: ModelSelection,
  runOrdinal = 1,
  threadId = THREAD_ID,
  continuation = false,
) {
  const appThread = yield* makeAppThread(model, threadId);
  const runId = RunId.make(`run:${threadId}:${runOrdinal}`);
  yield* runtime.startTurn({
    appThread,
    threadId,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${threadId}:${runOrdinal}` as never,
      text,
      attachments,
      createdBy: continuation ? "agent" : "user",
      creationSource: continuation ? "provider" : "web",
    },
    modelSelection: selection ?? modelSelection(model),
    runtimePolicy,
  });
});

describe("PiAdapterV2", () => {
  it.effect(
    "replaces keyed extension statuses while idle without producing conversation items",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const updates = [
          { statusKey: "watch", statusText: "\u001b[32mWatching 3 files\u001b[0m\u0007" },
          { statusKey: "lint", statusText: "Lint clean" },
          { statusKey: "watch", statusText: "Watching 4 files" },
          { statusKey: "watch", statusText: "Watching 4 files" },
          { statusKey: "watch", statusText: "\u001b[32mWatching 4 files\u001b[0m" },
          { statusKey: "lint", statusText: "" },
          { statusKey: "missing" },
          { statusKey: "watch" },
          { statusKey: "watch", statusText: "Watching 4 files" },
        ];
        for (const update of updates) {
          yield* fake.emit({ type: "extension_ui_request", method: "setStatus", ...update });
        }
        // The following dialog is an observable milestone after the preceding native notifications.
        yield* fake.emit({
          type: "extension_ui_request",
          id: "status-barrier",
          method: "input",
          title: "Continue?",
        });
        const observed: ProviderAdapter.ProviderAdapterV2Event[] = [];
        yield* takeEvent((event) => {
          observed.push(event);
          return event.type === "runtime_request.updated";
        });
        assert.deepInclude(runtime.providerSession, {
          extensionStatuses: [{ key: "watch", text: "Watching 4 files" }],
        });
        const snapshots = observed.filter((event) => event.type === "provider_session.updated");
        assert.lengthOf(snapshots, 6);
        assert.deepInclude(snapshots[0]?.providerSession, {
          extensionStatuses: [{ key: "watch", text: "Watching 3 files" }],
        });
        assert.deepInclude(snapshots[2]?.providerSession, {
          extensionStatuses: [
            { key: "watch", text: "Watching 4 files" },
            { key: "lint", text: "Lint clean" },
          ],
        });
        assert.isFalse(observed.some((event) => event.type === "message.updated"));
        assert.isFalse(
          observed.some(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type !== "user_input_request",
          ),
        );
        assert.isFalse(
          fake.allRequests().some((request) => request["type"] === "extension_ui_response"),
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("bounds native extension statuses and lets cleared keys free capacity", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      for (let index = 0; index < 35; index++) {
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: `key-${index}`,
          statusText: index === 1 ? "w".repeat(20000) : "Watching",
        });
      }
      for (const update of [
        { statusKey: "" },
        { statusKey: "x".repeat(257) },
        { statusKey: "malformed", statusText: null },
      ]) {
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusText: "Invalid",
          ...update,
        });
      }
      yield* fake.emit({ type: "extension_ui_request", method: "setStatus", statusKey: "key-0" });
      yield* fake.emit({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "replacement",
        statusText: "New status",
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "status-barrier",
        method: "input",
        title: "Continue?",
      });
      yield* takeEvent((event) => event.type === "runtime_request.updated");
      const statuses = runtime.providerSession.extensionStatuses ?? [];
      assert.lengthOf(statuses, 32);
      assert.equal(statuses[0]?.key, "key-1");
      assert.equal(statuses[0]?.text.length, 4096);
      assert.deepEqual(statuses.at(-1), { key: "replacement", text: "New status" });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("publishes extension status while native work awaits adoption", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const offers =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        { offer: (offer) => Queue.offer(offers, offer).pipe(Effect.asVoid) },
      );
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({ type: "agent_start" });
      yield* Queue.take(offers);
      yield* fake.emit({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "watch",
        statusText: "Native wake",
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "status-barrier",
        method: "input",
        title: "Continue?",
      });
      yield* takeEvent((event) => event.type === "runtime_request.updated");
      assert.deepEqual(runtime.providerSession.extensionStatuses, [
        { key: "watch", text: "Native wake" },
      ]);
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "keeps extension status through turn settlement and clears it on native session replacement",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "watch",
          statusText: "Watching",
        });
        yield* fake.emit({ type: "agent_settled" });
        yield* takeEvent((event) => event.type === "turn.terminal");
        assert.deepInclude(runtime.providerSession, {
          status: "ready",
          extensionStatuses: [{ key: "watch", text: "Watching" }],
        });
        yield* startTurn(
          runtime,
          providerThread,
          "anthropic/other-model",
          [],
          "Hello again",
          undefined,
          2,
        );
        assert.deepEqual(runtime.providerSession.extensionStatuses, [
          { key: "watch", text: "Watching" },
        ]);
        yield* fake.emit({ type: "agent_settled" });
        yield* takeEvent((event) => event.type === "turn.terminal");
        yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        assert.deepInclude(runtime.providerSession, { extensionStatuses: [] });
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["model error", "rejected prompt", "failed compact"] as const)(
    "keeps extension status through a reusable %s and the next turn",
    (failure) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "watch",
          statusText: "Watching 3 files",
        });
        const command = failure === "failed compact" ? "compact" : "prompt";
        if (failure === "rejected prompt") fake.deferNextLifecycle("prompt");
        yield* startTurn(
          runtime,
          providerThread,
          "default",
          [],
          command === "compact" ? "/compact" : "Hello pi",
        );
        yield* fake.takeRequest(command);
        if (failure === "model error") {
          yield* fake.emit({
            type: "message_end",
            message: { role: "assistant", stopReason: "error", errorMessage: "Rate limited" },
          });
          yield* fake.emit({ type: "agent_settled" });
        } else {
          yield* fake.emit({
            type: "response",
            command,
            success: false,
            error: "Request rejected",
          });
        }
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "failed");
        assert.deepInclude(runtime.providerSession, {
          status: "error",
          extensionStatuses: [{ key: "watch", text: "Watching 3 files" }],
        });

        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "watch",
          statusText: "Watching 4 files",
        });
        yield* fake.emit({
          type: "extension_ui_request",
          id: "failed-turn-status-barrier",
          method: "input",
          title: "Continue?",
        });
        yield* takeEvent((event) => event.type === "runtime_request.updated");
        assert.deepInclude(runtime.providerSession, {
          status: "error",
          extensionStatuses: [{ key: "watch", text: "Watching 4 files" }],
        });

        yield* startTurn(runtime, providerThread, "default", [], "Hello again", undefined, 2);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_settled" });
        const nextTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(nextTerminal.type === "turn.terminal" && nextTerminal.status === "completed");
        assert.deepInclude(runtime.providerSession, {
          id: SESSION_ID,
          status: "ready",
          extensionStatuses: [{ key: "watch", text: "Watching 4 files" }],
        });
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("preserves extension statuses when a native session switch is vetoed", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "watch",
        statusText: "Watching",
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "status-barrier",
        method: "input",
        title: "Continue?",
      });
      yield* takeEvent((event) => event.type === "runtime_request.updated");
      fake.queueState({ sessionFile: "/fake/other-session.jsonl" });
      fake.vetoNextSwitch();
      const exit = yield* runtime.resumeThread({ providerThread }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepEqual(runtime.providerSession.extensionStatuses, [
        { key: "watch", text: "Watching" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["success", "cancelled", "error"] as const)(
    "handles native status publications during session switch hooks, outcome=%s",
    (outcome) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        for (const key of ["watch", "lint"])
          yield* fake.emit({
            type: "extension_ui_request",
            method: "setStatus",
            statusKey: key,
            statusText: key === "lint" ? "Lint clean" : "Watching",
          });
        fake.queueState({ sessionFile: "/fake/other-session.jsonl" });
        fake.deferNextLifecycle("switch_session");
        const switching = yield* runtime
          .resumeThread({ providerThread })
          .pipe(Effect.exit, Effect.forkScoped);
        const request = yield* fake.takeRequest("switch_session");
        yield* fake.emit({ type: "extension_ui_request", method: "setStatus", statusKey: "watch" });
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "startup",
          statusText: "Fresh status",
        });
        yield* fake.emit({
          type: "extension_ui_request",
          id: "switch-hook",
          method: "input",
          title: "Continue?",
        });
        yield* takeEvent((event) => event.type === "runtime_request.updated");
        yield* fake.emit({
          type: "response",
          id: request["id"],
          command: "switch_session",
          success: outcome !== "error",
          data: { cancelled: outcome === "cancelled" },
          ...(outcome === "error" ? { error: "Session replacement failed" } : {}),
        });
        const exit = yield* Fiber.join(switching);
        assert.equal(Exit.isFailure(exit), outcome !== "success");
        if (outcome === "error") {
          const reuse = yield* runtime.resumeThread({ providerThread }).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(reuse));
          yield* takeEvent(
            (event) =>
              event.type === "provider_session.updated" && event.providerSession.status === "error",
          );
          assert.deepEqual(runtime.providerSession.extensionStatuses, []);
          return;
        }
        assert.deepEqual(runtime.providerSession.extensionStatuses, [
          ...(outcome === "cancelled" ? [{ key: "lint", text: "Lint clean" }] : []),
          { key: "startup", text: "Fresh status" },
        ]);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["stop", "transport death"] as const)(
    "clears extension statuses on %s",
    (retirement) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        const turnStarted = yield* takeEvent((event) => event.type === "provider_turn.updated");
        assert.equal(turnStarted.type, "provider_turn.updated");
        if (turnStarted.type !== "provider_turn.updated") return;
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "watch",
          statusText: "Watching",
        });
        yield* fake.emit({
          type: "extension_ui_request",
          id: "status-barrier",
          method: "input",
          title: "Continue?",
        });
        yield* takeEvent((event) => event.type === "runtime_request.updated");
        assert.deepInclude(runtime.providerSession, {
          extensionStatuses: [{ key: "watch", text: "Watching" }],
        });
        if (retirement === "stop") {
          yield* runtime.interruptTurn({
            providerThread,
            providerTurnId: turnStarted.providerTurn.id,
            requestRuntimeRestart: true,
          });
        } else yield* fake.closeStdout;
        yield* takeEvent(
          (event) =>
            event.type === "provider_session.updated" &&
            event.providerSession.status === (retirement === "stop" ? "stopped" : "error"),
        );
        assert.deepInclude(runtime.providerSession, { extensionStatuses: [] });
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  // Session release interrupts open tool calls, such as a worktree handoff's, only with this flag.
  it.effect("declares that its tool calls end with its process", () =>
    Effect.gen(function* () {
      const { runtime } = yield* openRuntime(yield* makeFakePi);
      assert.isTrue(runtime.backgroundTasksEndWithProcess);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
