import * as HostProcess from "@ankielcode/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { makeAntigravityUsageProbe } from "./antigravityUsageLimits.ts";

// Trimmed from a real `agy -p "/usage" --output-format json` answer.
const usage = {
  conversation_id: "",
  status: "SUCCESS",
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.57,
              reset_time: "2026-12-01T16:03:44Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.03,
              reset_time: "2026-11-25T02:03:44Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
            { id: "3p-off", window: "5h", remaining_fraction: 0.5, disabled: true },
            { id: "3p-none", window: "weekly" },
          ],
        },
      ],
    },
  },
};

/** A fake `agy` on PATH; `answer` returns stdout, or undefined when it is not installed. */
function fakeAgy(answer: (args: ReadonlyArray<string>) => string | undefined) {
  const calls: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
    calls.push(args);
    const stdout = answer(args);
    if (stdout === undefined) {
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          pathOrDescriptor: "agy",
        }),
      );
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { calls, spawner };
}

const makeProbe = (
  agy: ReturnType<typeof fakeAgy>,
  authMethod: Parameters<typeof makeAntigravityUsageProbe>[0]["authMethod"] = "oauth-personal",
) =>
  makeAntigravityUsageProbe({ authMethod, environment: {} }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, agy.spawner),
  );

const usageArgs = ["-p", "/usage", "--output-format", "json"];

describe("Antigravity subscription limits", () => {
  it.effect("reads each quota group's windows from the agy CLI", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-24T23:30:00Z"));
      const agy = fakeAgy((args) => (args[0] === "--version" ? "1.5.16\n" : JSON.stringify(usage)));
      const limits = yield* (yield* makeProbe(agy)).probe;
      expect(agy.calls).toEqual([["--version"], usageArgs]);
      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows).toEqual(
        expect.arrayContaining([
          {
            id: "gemini-weekly",
            label: "Gemini Models · Weekly",
            kind: "weekly",
            usedPercent: expect.closeTo(43, 5),
            resetsAt: "2026-12-01T16:03:44.000Z",
            windowDurationMins: 7 * 24 * 60,
          },
          {
            id: "gemini-5h",
            label: "Gemini Models · 5-hour",
            kind: "session",
            usedPercent: expect.closeTo(97, 5),
            resetsAt: "2026-11-25T02:03:44.000Z",
            windowDurationMins: 5 * 60,
          },
          // Untouched buckets report the epoch, which is not a reset.
          {
            id: "3p-weekly",
            label: "Claude and GPT models · Weekly",
            kind: "weekly",
            usedPercent: 0,
            windowDurationMins: 7 * 24 * 60,
          },
        ]),
      );
      // Each group's windows sit together, ordered by label.
      expect(limits.windows.map((window) => window.label)).toEqual([
        "Claude and GPT models · 5-hour",
        "Claude and GPT models · Weekly",
        "Gemini Models · 5-hour",
        "Gemini Models · Weekly",
      ]);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("reuses a reading for five minutes and reads again after clear", () =>
    Effect.gen(function* () {
      const agy = fakeAgy((args) =>
        args[0] === "--version" ? "agy 1.5.16" : JSON.stringify(usage),
      );
      const { probe, clear } = yield* makeProbe(agy);
      yield* probe;
      yield* TestClock.adjust("4 minutes");
      yield* probe;
      expect(agy.calls).toHaveLength(2);
      yield* clear;
      yield* probe;
      expect(agy.calls).toHaveLength(4);
      yield* TestClock.adjust("5 minutes");
      yield* probe;
      expect(agy.calls).toHaveLength(6);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("never sends /usage to a CLI too old to answer it without a turn", () =>
    Effect.gen(function* () {
      const agy = fakeAgy(() => "1.1.10");
      const limits = yield* (yield* makeProbe(agy)).probe;
      expect(agy.calls).toEqual([["--version"]]);
      expect(limits.unavailable?.reason).toBe("unsupported");
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("reports limits as unsupported when agy is not on PATH", () =>
    Effect.gen(function* () {
      const agy = fakeAgy(() => undefined);
      const limits = yield* (yield* makeProbe(agy)).probe;
      expect(limits.unavailable?.reason).toBe("unsupported");
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("reports a failed read when agy answers without usable quota", () =>
    Effect.gen(function* () {
      const agy = fakeAgy((args) => (args[0] === "--version" ? "1.5.16" : "not json"));
      const limits = yield* (yield* makeProbe(agy)).probe;
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("does not start agy for API-key sign-ins", () =>
    Effect.gen(function* () {
      const agy = fakeAgy(() => "1.5.16");
      const limits = yield* (yield* makeProbe(agy, "gemini-api-key")).probe;
      expect(agy.calls).toEqual([]);
      expect(limits.unavailable?.reason).toBe("unsupported");
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );
});
