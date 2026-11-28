import * as AcpError from "./errors.ts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { it, assert, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as AcpSchema from "./schema.ts";
import * as AcpProtocol from "./protocol.ts";
import { encodeJsonl, jsonRpcNotification } from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const SessionCancelNotification = jsonRpcNotification(
  "session/cancel",
  AcpSchema.CancelNotification,
);
const SessionUpdateNotification = jsonRpcNotification(
  "session/update",
  AcpSchema.SessionNotification,
);
const ElicitationCompleteNotification = jsonRpcNotification(
  "elicitation/complete",
  AcpSchema.CompleteElicitationNotification,
);
const decodeSessionCancelNotification = Schema.decodeEffect(
  Schema.fromJsonString(SessionCancelNotification),
);
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();
const MIB = 1024 * 1024;
const decodeIndex = Schema.decodeUnknownSync(Schema.Struct({ index: Schema.Number }));
const largeNotification = (index: number, textLength: number) =>
  encoder.encode(
    `${encodeUnknownJsonString({
      jsonrpc: "2.0",
      method: "x/large",
      params: { index, text: "x".repeat(textLength) },
    })}\n`,
  );

it.layer(NodeServices.layer)("effect-acp protocol", (it) => {
  it.effect(
    "emits exact JSON-RPC notifications and decodes inbound session/update and elicitation completion",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(),
        });

        const notifications =
          yield* Deferred.make<ReadonlyArray<AcpProtocol.AcpIncomingNotification>>();
        yield* transport.incoming.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.flatMap((notificationChunk) => Deferred.succeed(notifications, notificationChunk)),
          Effect.forkScoped,
        );

        yield* transport.notify("session/cancel", { sessionId: "session-1" });
        const outbound = yield* Queue.take(output);
        assert.deepEqual(yield* decodeSessionCancelNotification(outbound), {
          jsonrpc: "2.0",
          method: "session/cancel",
          params: {
            sessionId: "session-1",
          },
        });

        const updateFrame = yield* encodeJsonl(SessionUpdateNotification, {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "plan",
              entries: [
                {
                  content: "Inspect repository",
                  priority: "high",
                  status: "in_progress",
                },
              ],
            },
          },
        });
        const completionFrame = yield* encodeJsonl(ElicitationCompleteNotification, {
          jsonrpc: "2.0",
          method: "elicitation/complete",
          params: {
            elicitationId: "elicitation-1",
          },
        });

        const commandResult = {
          exit_code: null,
          signal: null,
          timed_out: false,
          termination_indeterminate: true,
        };
        const cancelledToolFrame = encoder.encode(
          `${encodeUnknownJsonString({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "session-1",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "cancelled-tool",
                status: "failed",
                command_result: commandResult,
              },
            },
          })}\n`,
        );
        // Frames split across reads, with one read ending one frame and starting the next.
        const wire = new Uint8Array([...updateFrame, ...completionFrame, ...cancelledToolFrame]);
        const splits = [10, updateFrame.length + 10, wire.length];
        let start = 0;
        for (const end of splits) {
          yield* Queue.offer(input, wire.subarray(start, end));
          start = end;
        }

        const [update, completion, cancelledTool] = yield* Deferred.await(notifications);
        assert.equal(update?._tag, "SessionUpdate");
        assert.equal(completion?._tag, "ElicitationComplete");
        assert.deepEqual(cancelledTool?.params, {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "cancelled-tool",
            status: "failed",
            command_result: commandResult,
          },
        });
      }),
  );

  it.effect("keeps only recent raw notifications after their callbacks run", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const handled = yield* Deferred.make<void>();
      let handledCount = 0;
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onNotification: () =>
          Effect.sync(() => ++handledCount).pipe(
            Effect.flatMap((count) =>
              count === 64 ? Deferred.succeed(handled, undefined).pipe(Effect.asVoid) : Effect.void,
            ),
          ),
      });

      const messages = Array.from({ length: 64 }, (_, index) =>
        encodeUnknownJsonString({
          jsonrpc: "2.0",
          method: "x/performance",
          params: { index },
        }),
      );
      yield* Queue.offer(input, encoder.encode(`${messages.join("\n")}\n`));
      yield* Deferred.await(handled);

      const retained = yield* transport.incoming.pipe(Stream.take(32), Stream.runCollect);

      assert.equal(handledCount, 64);
      assert.equal(retained.length, 32);
      assert.deepEqual(retained[0]?.params, { index: 32 });
      assert.deepEqual(retained[31]?.params, { index: 63 });
    }),
  );

  it.effect("keeps the newest unread raw notifications whose JSON fits in 16Mi characters", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const handled = yield* Queue.unbounded<number>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onNotification: (notification) =>
          Queue.offer(handled, decodeIndex(notification.params).index).pipe(Effect.asVoid),
      });

      // Ten 3 MiB notifications: only the newest five fit in the budget.
      for (let index = 0; index < 10; index++) {
        yield* Queue.offer(input, largeNotification(index, 3 * MIB));
        assert.equal(yield* Queue.take(handled), index);
      }

      const retained = yield* transport.incoming.pipe(Stream.take(5), Stream.runCollect);
      assert.deepEqual(
        retained.map((notification) => decodeIndex(notification.params).index),
        [5, 6, 7, 8, 9],
      );
    }),
  );

  it.effect("keeps a single unread raw notification that alone exceeds the budget", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const handled = yield* Queue.unbounded<number>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onNotification: (notification) =>
          Queue.offer(handled, decodeIndex(notification.params).index).pipe(Effect.asVoid),
      });

      yield* Queue.offer(input, largeNotification(0, 1));
      yield* Queue.take(handled);
      yield* Queue.offer(input, largeNotification(1, 17 * MIB));
      yield* Queue.take(handled);

      const [retained] = yield* transport.incoming.pipe(Stream.take(1), Stream.runCollect);
      assert.equal(decodeIndex(retained?.params).index, 1);
    }),
  );

  it.effect("evicts unread raw notifications while a slow reader handles an earlier one", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const handled = yield* Queue.unbounded<number>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onNotification: (notification) =>
          Queue.offer(handled, decodeIndex(notification.params).index).pipe(Effect.asVoid),
      });
      const send = (index: number, textLength: number) =>
        Queue.offer(input, largeNotification(index, textLength)).pipe(
          Effect.andThen(Queue.take(handled)),
        );

      yield* send(1, 6 * MIB);
      yield* send(2, 6 * MIB);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const reader = yield* transport.incoming.pipe(
        Stream.map((notification) => decodeIndex(notification.params).index),
        Stream.tap((index) =>
          index === 1
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);

      // Notification 2 is still unread, so 3 and 4 push it past the budget.
      yield* send(3, 6 * MIB);
      yield* send(4, 6 * MIB);
      yield* send(5, 1);
      yield* Deferred.succeed(release, undefined);

      assert.deepEqual(yield* Fiber.join(reader), [1, 3, 4, 5]);
    }),
  );

  it.effect("delivers every raw notification to a reader that keeps up, then ends", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });
      const received = yield* Queue.unbounded<number>();
      const reader = yield* transport.incoming.pipe(
        Stream.map((notification) => decodeIndex(notification.params).index),
        Stream.tap((index) => Queue.offer(received, index)),
        Stream.runCollect,
        Effect.forkScoped,
      );

      // 30 MiB in total, well past the unread budget.
      for (let index = 0; index < 10; index++) {
        yield* Queue.offer(input, largeNotification(index, 3 * MIB));
        assert.equal(yield* Queue.take(received), index);
      }
      yield* Queue.end(input);

      assert.deepEqual(yield* Fiber.join(reader), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }),
  );

  it.effect("ends the raw notification stream when the connection scope closes", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const connection = yield* Scope.make();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      }).pipe(Scope.provide(connection));
      const reader = yield* transport.incoming.pipe(Stream.runCollect, Effect.forkScoped);

      yield* Scope.close(connection, Exit.void);

      assert.deepEqual(yield* Fiber.join(reader), []);
    }),
  );

  it.effect("keeps the ended raw backlog intact when notifications arrive after termination", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const handled = yield* Queue.unbounded<number>();
      const terminated = yield* Deferred.make<void>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio: Stdio.make({
          args: stdio.args,
          stdin: stdio.stdin,
          stdout: () => Sink.forEach(() => Effect.die("stdout failed")),
          stderr: () => Sink.drain,
        }),
        serverRequestMethods: new Set(),
        onNotification: (notification) =>
          Queue.offer(handled, decodeIndex(notification.params).index).pipe(Effect.asVoid),
        onTermination: () => Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
      });
      const deliver = (index: number) =>
        Queue.offer(
          input,
          encoder.encode(
            `${encodeUnknownJsonString({ jsonrpc: "2.0", method: "x/late", params: { index } })}\n`,
          ),
        ).pipe(Effect.andThen(Queue.take(handled)));

      for (let index = 0; index < 32; index++) {
        assert.equal(yield* deliver(index), index);
      }
      // A failed write terminates the connection while the reader keeps running.
      yield* transport.notify("x/fail", {}).pipe(Effect.exit);
      yield* Deferred.await(terminated);
      assert.equal(yield* deliver(32), 32);

      const retained = yield* transport.incoming.pipe(
        Stream.map((notification) => decodeIndex(notification.params).index),
        Stream.runCollect,
      );
      assert.deepEqual(
        retained,
        Array.from({ length: 32 }, (_, index) => index),
      );
    }),
  );

  // clanka once sent a usage_update without `used` and `size`. One bad update
  // must not end a session whose later updates are fine.
  it.effect("drops a session/update that fails to decode and keeps reading", () =>
    Effect.gen(function* () {
      const secret = "acp-core-notification-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const events: Array<AcpProtocol.AcpProtocolLogEvent> = [];
      const warnings: Array<unknown> = [];
      let terminated = false;
      let transformCalls = 0;
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logIncoming: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        transformSessionUpdate: (notification) => {
          transformCalls += 1;
          return notification;
        },
        onTermination: () =>
          Effect.sync(() => {
            terminated = true;
          }),
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ logLevel, fiber }) => {
              if (logLevel === "Warn")
                warnings.push(fiber.getRef(References.CurrentLogAnnotations));
            }),
          ]),
        ),
      );
      const received = yield* Deferred.make<AcpProtocol.AcpIncomingNotification>();
      yield* transport.incoming.pipe(
        Stream.runForEach((notification) => Deferred.succeed(received, notification)),
        Effect.forkScoped,
      );

      const send = (params: unknown) =>
        Queue.offer(
          input,
          encoder.encode(
            `${encodeUnknownJsonString({ jsonrpc: "2.0", method: "session/update", params })}\n`,
          ),
        );
      const malformed = {
        sessionId: "session-1",
        update: { sessionUpdate: "usage_update", cost: { amount: 1, currency: secret } },
      };
      yield* send(malformed);
      yield* send(malformed);
      yield* send({
        sessionId: "session-1",
        update: { sessionUpdate: "usage_update", used: 10, size: 100 },
      });

      const notification = yield* TestClock.withLive(
        Deferred.await(received).pipe(Effect.timeout("2 seconds")),
      );
      assert.equal(notification._tag, "SessionUpdate");
      assert.deepEqual(notification.params, {
        sessionId: "session-1",
        update: { sessionUpdate: "usage_update", used: 10, size: 100 },
      });
      assert.isFalse(terminated);
      assert.equal(transformCalls, 1);

      const decodeFailed = events.find(({ stage }) => stage === "decode_failed");
      expect(decodeFailed?.payload).toMatchObject({
        operation: "decode-notification-payload",
        method: "session/update",
        issueSummary: expect.stringContaining("update.used missing"),
      });
      assert.lengthOf(
        events.filter(({ stage }) => stage === "decode_failed"),
        2,
      );
      assert.lengthOf(warnings, 1);
      expect(warnings[0]).toMatchObject({
        issueSummary: expect.stringContaining("update.used missing"),
      });
      assert.notInclude(encodeUnknownJsonString({ decodeFailed, warnings }), secret);
    }),
  );

  it.effect("terminates when a callback on the reader dies", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<AcpError.AcpError>();
      yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        transformSessionUpdate: () => {
          throw new Error("normalizer bug");
        },
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(
        input,
        encoder.encode(
          `${encodeUnknownJsonString({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "session-1",
              update: { sessionUpdate: "plan", entries: [] },
            },
          })}\n`,
        ),
      );

      const error = yield* TestClock.withLive(
        Deferred.await(termination).pipe(Effect.timeout("2 seconds")),
      );
      assert.instanceOf(error, AcpError.AcpTransportError);
      assert.equal((error as AcpError.AcpTransportError).operation, "read-input-stream");
    }),
  );

  // regression: #9154 notifications went out with `id` and `headers`, which Grok CLI drops
  it.effect("logs outgoing notifications when logOutgoing is enabled", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const events: Array<AcpProtocol.AcpProtocolLogEvent> = [];
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logOutgoing: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      });

      yield* transport.notify("session/cancel", { sessionId: "session-1" });

      // A notification must not carry `id` or `headers`. Grok CLI drops frames that do.
      assert.deepEqual(events, [
        {
          direction: "outgoing",
          stage: "decoded",
          payload: {
            _tag: "Notification",
            tag: "session/cancel",
            payload: {
              sessionId: "session-1",
            },
          },
        },
        {
          direction: "outgoing",
          stage: "raw",
          payload:
            '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"session-1"}}\n',
        },
      ]);
    }),
  );

  it.effect("skips blank lines between agent messages", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const outcome = yield* Deferred.make<string>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onTermination: (error) => Deferred.succeed(outcome, error._tag).pipe(Effect.asVoid),
      });
      yield* transport.incoming.pipe(
        Stream.runForEach((notification) => Deferred.succeed(outcome, notification._tag)),
        Effect.forkScoped,
      );

      const update = encodeUnknownJsonString({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "session-1", update: { sessionUpdate: "plan", entries: [] } },
      });
      yield* Queue.offer(input, encoder.encode(`\n\r\n \t\n${update}\n\n`));

      assert.equal(yield* Deferred.await(outcome), "SessionUpdate");
    }),
  );

  it.effect("logs decode failures without copying the cause or wire payload", () =>
    Effect.gen(function* () {
      const secret = "acp-wire-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const events: Array<AcpProtocol.AcpProtocolLogEvent> = [];
      const termination = yield* Deferred.make<AcpError.AcpError>();
      yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logIncoming: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(input, encoder.encode(`{"secret":"${secret}"\n`));
      yield* Deferred.await(termination);

      const event = events.find(({ stage }) => stage === "decode_failed");
      assert.deepEqual(event, {
        direction: "incoming",
        stage: "decode_failed",
        payload: {
          operation: "decode-wire-message",
        },
      });
      assert.notInclude(encodeUnknownJsonString(event), secret);
    }),
  );
});
