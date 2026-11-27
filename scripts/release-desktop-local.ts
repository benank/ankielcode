#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag, Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class LocalDesktopReleaseCommandError extends Schema.TaggedError<
  LocalDesktopReleaseCommandError,
  { readonly brand: unique symbol }
>()("LocalDesktopReleaseCommandError", { step: Schema.String, exitCode: Schema.Number }) {
  override get message() {
    return `${this.step} failed with exit code ${this.exitCode}.`;
  }
}

const runCommand = Effect.fn("releaseDesktopLocal.runCommand")(function* (
  step: string,
  executable: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(executable, args, { stdout: "inherit", stderr: "inherit" }),
  );
  if (exitCode !== 0) {
    return yield* new LocalDesktopReleaseCommandError({ step, exitCode });
  }
});

const releaseExists = Effect.fn("releaseDesktopLocal.releaseExists")(function* (tag: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("gh", ["release", "view", tag, "--json", "tagName"], { stdout: "ignore" }),
  );
  const [exitCode, stderr] = yield* Effect.all(
    [child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.mkString)],
    { concurrency: "unbounded" },
  );
  if (exitCode === 0) return true;
  if (stderr.trim() === "release not found") return false;
  if (stderr.trim()) yield* Console.error(stderr.trim());
  return yield* new LocalDesktopReleaseCommandError({ step: `Looking up ${tag}`, exitCode });
}, Effect.scoped);

export const releaseDesktopLocal = Effect.fn("releaseDesktopLocal")(function* (
  tag: string,
  signed: boolean,
) {
  const version = tag.slice(1);
  const dmg = `release/Ankiel-Code-${version}-arm64.dmg`;
  const exists = yield* releaseExists(tag);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const target = exists
    ? undefined
    : yield* spawner
        .string(ChildProcess.make("git", ["rev-parse", "HEAD"], { stderr: "inherit" }))
        .pipe(
          Effect.map((output) => output.trim()),
          Effect.flatMap(
            Schema.decodeEffect(Schema.String.check(Schema.isPattern(/^[a-f\d]{40}$/))),
          ),
        );

  yield* runCommand("Building the macOS DMG", "vp", [
    "run",
    "dist:desktop:dmg:arm64",
    "--build-version",
    version,
    "--output-dir",
    "release",
    ...(signed ? ["--signed"] : []),
  ]);

  if (target === undefined) {
    yield* runCommand("Uploading the DMG", "gh", ["release", "upload", tag, dmg]);
    yield* Console.log(`Attached ${dmg} to ${tag}.`);
    return;
  }

  yield* runCommand("Creating the draft release", "gh", [
    "release",
    "create",
    tag,
    dmg,
    "--draft",
    "--generate-notes",
    "--target",
    target,
    ...(version.includes("-") ? ["--prerelease"] : []),
  ]);
});

const releaseTagPrompt = Prompt.String({
  message: "GitHub release tag (e.g. v0.2.0)",
  validate: (value) => {
    const tag = value.trim();
    return /^v\d+\.\d+\.\d+(?:-[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/.test(tag)
      ? Effect.succeed(tag)
      : Effect.fail("Enter a tag like v0.2.0 or v0.2.0-beta.1.");
  },
});

const command = Command.make(
  "release-desktop-local",
  {
    signed: Flag.Boolean("signed").pipe(
      Flag.withDescription("Sign and notarize the macOS app."),
      Flag.withDefault(false),
    ),
  },
  ({ signed }) =>
    Prompt.run(releaseTagPrompt).pipe(Effect.flatMap((tag) => releaseDesktopLocal(tag, signed))),
).pipe(Command.withDescription("Build an Apple Silicon DMG and attach it to a GitHub release."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
