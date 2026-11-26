// @effect-diagnostics nodeBuiltinImport:off -- Runs real git commits through the installed hooks in a subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { applyGitCommitHooksEnvironment } from "@ankielcode/shared/gitCommitHooksEnv";
import { ensureGitCommitHooks } from "./CommitMessageHooks.ts";

const binEntrypoint = NodePath.resolve(import.meta.dirname, "../bin.ts");

function runGit(cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

describe("CommitMessageHooks", () => {
  it.live(
    "strips AI model, harness, and co-author attribution on git commit and --no-verify while preserving repo hooks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-git-hooks-" });
        const stateDir = path.join(root, "state");
        const repoDir = path.join(root, "repo");
        yield* fs.makeDirectory(repoDir, { recursive: true });

        const hooksConfig = {
          ...(yield* ensureGitCommitHooks(stateDir)),
          nodePath: process.execPath,
          entrypoint: binEntrypoint,
        };

        const baseEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "user.name",
          GIT_CONFIG_VALUE_0: "Test User",
          GIT_CONFIG_KEY_1: "user.email",
          GIT_CONFIG_VALUE_1: "test@example.com",
        };
        const hookedEnv = applyGitCommitHooksEnvironment(baseEnv, hooksConfig);

        runGit(repoDir, ["init", "-q"], baseEnv);

        // Install repo-local pre-commit and commit-msg hooks to prove delegation works.
        const markerPath = path.join(root, "hook-log.txt");
        const repoPreCommit = path.join(repoDir, ".git", "hooks", "pre-commit");
        const repoCommitMsg = path.join(repoDir, ".git", "hooks", "commit-msg");
        yield* fs.writeFileString(
          repoPreCommit,
          `#!/bin/sh\necho pre-commit >> ${JSON.stringify(markerPath)}\n`,
        );
        yield* fs.chmod(repoPreCommit, 0o755);
        yield* fs.writeFileString(
          repoCommitMsg,
          `#!/bin/sh\necho commit-msg >> ${JSON.stringify(markerPath)}\nif grep -qi "Co-Authored-By: Claude" "$1"; then exit 1; fi\n`,
        );
        yield* fs.chmod(repoCommitMsg, 0o755);

        yield* fs.writeFileString(path.join(repoDir, "a.txt"), "one\n");
        runGit(repoDir, ["add", "a.txt"], hookedEnv);
        runGit(
          repoDir,
          [
            "commit",
            "-q",
            "-m",
            [
              "feat: first change",
              "",
              "Explain the fix.",
              "",
              "Model: Gemini 4 Neon (Medium) via Antigravity",
              "GPT-6.2 Sol via Codex in Ankiel Code.",
              "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
              "Co-authored-by: Alice <alice@example.com>",
            ].join("\n"),
          ],
          hookedEnv,
        );

        const firstMessage = runGit(repoDir, ["log", "-1", "--format=%B"], baseEnv).trim();
        assert.strictEqual(
          firstMessage,
          "feat: first change\n\nExplain the fix.\n\nCo-authored-by: Alice <alice@example.com>",
        );
        const hookLog = (yield* fs.readFileString(markerPath)).trim().split("\n");
        assert.deepStrictEqual(hookLog, ["pre-commit", "commit-msg"]);

        // Even --no-verify runs prepare-commit-msg and strips AI credits.
        yield* fs.writeFileString(path.join(repoDir, "b.txt"), "two\n");
        runGit(repoDir, ["add", "b.txt"], hookedEnv);
        runGit(
          repoDir,
          [
            "commit",
            "--no-verify",
            "-q",
            "-m",
            [
              "fix: second change",
              "",
              "Implemented with GPT-6.2 Sol in the Codex harness.",
              "",
              "Co-authored-by: gemini-4-neon <me+ai@stefanmirea.com>",
            ].join("\n"),
          ],
          hookedEnv,
        );

        const secondMessage = runGit(repoDir, ["log", "-1", "--format=%B"], baseEnv).trim();
        assert.strictEqual(secondMessage, "fix: second change");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
