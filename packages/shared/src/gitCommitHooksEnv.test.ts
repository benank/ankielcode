import { describe, expect, it } from "vite-plus/test";
import {
  ANKIEL_GIT_HOOKS_DIR_ENV,
  ANKIEL_GIT_HOOK_ENTRYPOINT_ENV,
  ANKIEL_GIT_HOOK_NODE_ENV,
  applyGitCommitHooksEnvironment,
  gitCommitHooksShellEnvEntries,
} from "./gitCommitHooksEnv.ts";

describe("applyGitCommitHooksEnvironment", () => {
  it("returns the input unchanged when git commit hooks are not configured", () => {
    const env = { PATH: "/usr/bin" };
    expect(applyGitCommitHooksEnvironment(env)).toBe(env);
    expect(gitCommitHooksShellEnvEntries(env)).toEqual({});
  });

  it("appends core.hooksPath without overwriting existing GIT_CONFIG_* entries", () => {
    const env = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
      [ANKIEL_GIT_HOOKS_DIR_ENV]: "/state/git-hooks",
      [ANKIEL_GIT_HOOK_NODE_ENV]: "/usr/local/bin/node",
      [ANKIEL_GIT_HOOK_ENTRYPOINT_ENV]: "/app/bin.mjs",
    };

    const applied = applyGitCommitHooksEnvironment(env);
    expect(applied.GIT_CONFIG_COUNT).toBe("2");
    expect(applied.GIT_CONFIG_KEY_0).toBe("commit.gpgsign");
    expect(applied.GIT_CONFIG_VALUE_0).toBe("false");
    expect(applied.GIT_CONFIG_KEY_1).toBe("core.hooksPath");
    expect(applied.GIT_CONFIG_VALUE_1).toBe("/state/git-hooks");

    // Calling again is idempotent.
    const twice = applyGitCommitHooksEnvironment(applied);
    expect(twice.GIT_CONFIG_COUNT).toBe("2");
  });

  it("extracts shell env entries for Codex shell_environment_policy", () => {
    const entries = gitCommitHooksShellEnvEntries({
      PATH: "/usr/bin",
      [ANKIEL_GIT_HOOKS_DIR_ENV]: "/state/git-hooks",
      [ANKIEL_GIT_HOOK_NODE_ENV]: "/usr/local/bin/node",
    });

    expect(entries).toEqual({
      [ANKIEL_GIT_HOOKS_DIR_ENV]: "/state/git-hooks",
      [ANKIEL_GIT_HOOK_NODE_ENV]: "/usr/local/bin/node",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/state/git-hooks",
    });
  });
});
