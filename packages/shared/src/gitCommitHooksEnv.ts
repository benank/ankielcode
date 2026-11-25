export const ANKIEL_GIT_HOOKS_DIR_ENV = "ANKIEL_GIT_HOOKS_DIR";
export const ANKIEL_GIT_HOOK_NODE_ENV = "ANKIEL_GIT_HOOK_NODE";
export const ANKIEL_GIT_HOOK_ENTRYPOINT_ENV = "ANKIEL_GIT_HOOK_ENTRYPOINT";

export interface GitCommitHooksEnvConfig {
  readonly hooksDir: string;
  readonly nodePath: string;
  readonly entrypoint?: string | undefined;
}

function readGitCommitHooksConfig(
  env: NodeJS.ProcessEnv,
  override?: GitCommitHooksEnvConfig,
): GitCommitHooksEnvConfig | undefined {
  const hooksDir = override?.hooksDir ?? env[ANKIEL_GIT_HOOKS_DIR_ENV]?.trim();
  const nodePath = override?.nodePath ?? env[ANKIEL_GIT_HOOK_NODE_ENV]?.trim();
  if (!hooksDir || !nodePath) return undefined;
  const entrypoint = override
    ? override.entrypoint
    : env[ANKIEL_GIT_HOOK_ENTRYPOINT_ENV]?.trim() || undefined;
  return { hooksDir, nodePath, entrypoint };
}

function parseGitConfigCount(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Injects `core.hooksPath` via `GIT_CONFIG_*` into an agent or command environment so any
 * `git commit` run inside Ankiel Code strips AI attribution and co-author trailers.
 */
export function applyGitCommitHooksEnvironment(
  env: NodeJS.ProcessEnv,
  override?: GitCommitHooksEnvConfig,
): NodeJS.ProcessEnv {
  const config = readGitCommitHooksConfig(env, override);
  if (!config) return env;

  const next: NodeJS.ProcessEnv = {
    ...env,
    [ANKIEL_GIT_HOOKS_DIR_ENV]: config.hooksDir,
    [ANKIEL_GIT_HOOK_NODE_ENV]: config.nodePath,
  };
  if (config.entrypoint !== undefined) {
    next[ANKIEL_GIT_HOOK_ENTRYPOINT_ENV] = config.entrypoint;
  } else {
    delete next[ANKIEL_GIT_HOOK_ENTRYPOINT_ENV];
  }

  const count = parseGitConfigCount(env.GIT_CONFIG_COUNT);
  for (let index = 0; index < count; index += 1) {
    if (
      env[`GIT_CONFIG_KEY_${index}`]?.toLowerCase() === "core.hookspath" &&
      env[`GIT_CONFIG_VALUE_${index}`] === config.hooksDir
    ) {
      return next;
    }
  }

  next.GIT_CONFIG_COUNT = String(count + 1);
  next[`GIT_CONFIG_KEY_${count}`] = "core.hooksPath";
  next[`GIT_CONFIG_VALUE_${count}`] = config.hooksDir;
  return next;
}

/** Returns the git hook env entries to forward through Codex's `shell_environment_policy.set.*`. */
export function gitCommitHooksShellEnvEntries(
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const applied = applyGitCommitHooksEnvironment(env);
  if (applied === env && !env[ANKIEL_GIT_HOOKS_DIR_ENV]) return {};
  const entries: Record<string, string> = {};
  const keys = [
    ANKIEL_GIT_HOOKS_DIR_ENV,
    ANKIEL_GIT_HOOK_NODE_ENV,
    ANKIEL_GIT_HOOK_ENTRYPOINT_ENV,
    "GIT_CONFIG_COUNT",
  ];
  const count = parseGitConfigCount(applied.GIT_CONFIG_COUNT);
  for (let index = 0; index < count; index += 1) {
    keys.push(`GIT_CONFIG_KEY_${index}`, `GIT_CONFIG_VALUE_${index}`);
  }
  for (const key of keys) {
    const value = applied[key];
    if (value !== undefined) entries[key] = value;
  }
  return entries;
}
