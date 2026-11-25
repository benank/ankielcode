import type {
  AntigravitySettings,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@ankielcode/contracts";
import {
  parseGenericCliVersion,
  spawnAndCollect,
} from "@ankielcode/provider-core/server/snapshotProbe";
import { compareSemverVersions } from "@ankielcode/shared/semver";
import { resolveSpawnCommand } from "@ankielcode/shared/shell";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeUnavailableUsageLimits } from "@ankielcode/provider-core/server/usageLimits";

// Older CLIs treat `/usage` as a prompt and run a paid agent turn.
const MIN_USAGE_VERSION = "1.1.11";
// Health checks ask for limits every minute; each read starts the CLI.
const REUSE_MS = 5 * 60_000;
const WINDOW_MINS = new Map([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);
const UNAVAILABLE_MESSAGE = `Install the Antigravity CLI (agy) ${MIN_USAGE_VERSION} or newer and sign in to see Antigravity limits.`;

const UsageOutput = Schema.Struct({
  command: Schema.Struct({
    name: Schema.Literal("usage"),
    data: Schema.Struct({
      groups: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          buckets: Schema.Array(
            Schema.Struct({
              id: Schema.NonEmptyString,
              name: Schema.optional(Schema.String),
              window: Schema.optional(Schema.String),
              remaining_fraction: Schema.optional(Schema.Number),
              reset_time: Schema.optional(Schema.String),
              disabled: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  }),
});
const decodeUsageOutput = Schema.decodeEffect(Schema.fromJsonString(UsageOutput));

/** Windows from `agy -p "/usage" --output-format json`, read at `checkedAt`. */
function antigravityUsageWindows(
  output: typeof UsageOutput.Type,
  checkedAt: number,
): ServerProviderUsageWindow[] {
  const windows: ServerProviderUsageWindow[] = [];
  for (const group of output.command.data.groups) {
    for (const bucket of group.buckets) {
      const remaining = bucket.remaining_fraction;
      if (bucket.disabled || remaining === undefined || !Number.isFinite(remaining)) continue;
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const windowDurationMins = WINDOW_MINS.get(bucket.window ?? "");
      // A full bucket has nothing to reset; untouched ones report the epoch or a rolling reset.
      const reset =
        remaining < 1 && bucket.reset_time
          ? Option.getOrUndefined(DateTime.make(bucket.reset_time))
          : undefined;
      const resetsAt =
        reset && DateTime.toEpochMillis(reset) > checkedAt ? DateTime.formatIso(reset) : undefined;
      windows.push({
        id: bucket.id,
        label: `${group.name.trim() || "Antigravity"} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.name?.trim() || "Quota"}`,
        kind: weekly ? "weekly" : session ? "session" : "other",
        usedPercent: (1 - Math.max(0, Math.min(1, remaining))) * 100,
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
      });
    }
  }
  return windows;
}

/** Reads limits from the `agy` on PATH, which reports the account it is signed in with. */
export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly environment: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let cached: { readonly at: number; readonly limits: ServerProviderUsageLimits } | undefined;

  const agy = Effect.fn("AntigravityUsageProbe.agy")(
    function* (args: ReadonlyArray<string>, _timeout: Duration.Input) {
      const spawn = yield* resolveSpawnCommand("agy", args, { env: input.environment });
      return yield* spawnAndCollect(
        "agy",
        ChildProcess.make(spawn.command, spawn.args, {
          env: input.environment,
          shell: spawn.shell,
          // Signed out, the CLI waits for a pasted sign-in code instead of exiting.
          stdin: "ignore",
        }),
      );
    },
    (effect, _args, timeout) =>
      effect.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeout(timeout),
        Effect.option,
      ),
  );

  const read = Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    const now = yield* Clock.currentTimeMillis;
    if (cached && now - cached.at < REUSE_MS) return cached.limits;

    const version = Option.flatMap(yield* agy(["--version"], "10 seconds"), (result) =>
      Option.fromNullishOr(result.code === 0 ? parseGenericCliVersion(result.stdout) : null),
    );
    if (Option.isNone(version) || compareSemverVersions(version.value, MIN_USAGE_VERSION) < 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: UNAVAILABLE_MESSAGE,
      });
    }
    const usage = yield* agy(["-p", "/usage", "--output-format", "json"], "20 seconds");
    const windows = yield* Option.match(usage, {
      onNone: () => Effect.succeed([]),
      onSome: (result) =>
        decodeUsageOutput(result.stdout).pipe(
          Effect.map((output) => antigravityUsageWindows(output, now)),
          Effect.orElseSucceed(() => []),
        ),
    });
    if (windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message:
          "Could not read limits from the Antigravity CLI. Run `agy` in a terminal to check it is signed in, then refresh.",
      });
    }
    // By label, so each model group's 5-hour and weekly windows sit together.
    const limits: ServerProviderUsageLimits = {
      checkedAt,
      windows: windows.toSorted((left, right) => left.label.localeCompare(right.label)),
    };
    cached = { at: now, limits };
    return limits;
  });

  return {
    probe: read,
    clear: Effect.sync(() => {
      cached = undefined;
    }),
  };
});
