import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ANKIEL_GIT_HOOKS_DIR_ENV,
  ANKIEL_GIT_HOOK_ENTRYPOINT_ENV,
  ANKIEL_GIT_HOOK_NODE_ENV,
  type GitCommitHooksEnvConfig,
} from "@ankielcode/shared/gitCommitHooksEnv";
import { resolveSelfInvocation } from "@ankielcode/shared/nodeRuntime";

const CLIENT_SIDE_GIT_HOOKS = [
  "applypatch-msg",
  "commit-msg",
  "post-applypatch",
  "post-checkout",
  "post-commit",
  "post-index-change",
  "post-merge",
  "post-rewrite",
  "pre-applypatch",
  "pre-auto-gc",
  "pre-commit",
  "pre-merge-commit",
  "pre-push",
  "pre-rebase",
  "prepare-commit-msg",
  "reference-transaction",
  "sendemail-validate",
] as const;

const HOOK_DISPATCHER_NAME = "_ankiel-run-hook.sh";

const HOOK_DISPATCHER_SCRIPT = `#!/bin/sh
set -e

HOOK_NAME="$1"
shift

SELF_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"

resolve_dir() {
  (CDPATH= cd -- "$1" 2>/dev/null && pwd -P) || printf '%s\\n' "$1"
}

find_original_hook() {
  hooks_dir=""
  orig_path="$(git config --local --path --get core.hooksPath 2>/dev/null || true)"
  if [ -n "$orig_path" ]; then
    case "$orig_path" in
      /*|[A-Za-z]:/*|[A-Za-z]:\\\\*)
        hooks_dir="$orig_path"
        ;;
      *)
        top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
        if [ -n "$top" ]; then
          hooks_dir="$top/$orig_path"
        fi
        ;;
    esac
  fi
  if [ -z "$hooks_dir" ]; then
    orig_path="$(git config --global --path --get core.hooksPath 2>/dev/null || true)"
    [ -n "$orig_path" ] && hooks_dir="$orig_path"
  fi
  if [ -z "$hooks_dir" ]; then
    orig_path="$(git config --system --path --get core.hooksPath 2>/dev/null || true)"
    [ -n "$orig_path" ] && hooks_dir="$orig_path"
  fi
  if [ -z "$hooks_dir" ]; then
    common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
    [ -n "$common_dir" ] && hooks_dir="$common_dir/hooks"
  fi
  if [ -z "$hooks_dir" ]; then
    return 1
  fi
  resolved_hooks_dir="$(resolve_dir "$hooks_dir")"
  if [ "$resolved_hooks_dir" = "$SELF_DIR" ]; then
    return 1
  fi
  candidate="$hooks_dir/$HOOK_NAME"
  if [ -f "$candidate" ] && [ -x "$candidate" ]; then
    printf '%s\\n' "$candidate"
    return 0
  fi
  return 1
}

strip_commit_msg() {
  msg_file="$1"
  [ -n "$msg_file" ] && [ -f "$msg_file" ] || return 0
  [ -n "$${ANKIEL_GIT_HOOK_NODE_ENV}" ] || return 0
  if [ -n "$${ANKIEL_GIT_HOOK_ENTRYPOINT_ENV}" ]; then
    ELECTRON_RUN_AS_NODE=1 "$${ANKIEL_GIT_HOOK_NODE_ENV}" "$${ANKIEL_GIT_HOOK_ENTRYPOINT_ENV}" __git-strip-commit-msg "$msg_file" >/dev/null 2>&1 || true
  else
    ELECTRON_RUN_AS_NODE=1 "$${ANKIEL_GIT_HOOK_NODE_ENV}" __git-strip-commit-msg "$msg_file" >/dev/null 2>&1 || true
  fi
}

case "$HOOK_NAME" in
  prepare-commit-msg)
    if orig="$(find_original_hook)"; then
      "$orig" "$@"
    fi
    strip_commit_msg "$1"
    ;;
  commit-msg)
    strip_commit_msg "$1"
    if orig="$(find_original_hook)"; then
      exec "$orig" "$@"
    fi
    ;;
  *)
    if orig="$(find_original_hook)"; then
      exec "$orig" "$@"
    fi
    ;;
esac
`;

function hookShimScript(hookName: string): string {
  return `#!/bin/sh\nexec "$(dirname -- "$0")/${HOOK_DISPATCHER_NAME}" "${hookName}" "$@"\n`;
}

/**
 * Materializes Ankiel Code's delegating git hooks directory under `stateDir/git-hooks` so any
 * `git commit` run inside agent or terminal commands strips AI attribution without touching any
 * repository's own `.git/hooks`.
 */
export const ensureGitCommitHooks = Effect.fn("CommitMessageHooks.ensureGitCommitHooks")(function* (
  stateDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const self = yield* resolveSelfInvocation();
  const hooksDir = path.join(stateDir, "git-hooks");
  yield* fileSystem.makeDirectory(hooksDir, { recursive: true });

  const dispatcherPath = path.join(hooksDir, HOOK_DISPATCHER_NAME);
  yield* fileSystem.writeFileString(dispatcherPath, HOOK_DISPATCHER_SCRIPT);
  yield* fileSystem.chmod(dispatcherPath, 0o755).pipe(Effect.ignore);

  yield* Effect.forEach(
    CLIENT_SIDE_GIT_HOOKS,
    (hookName) => {
      const hookPath = path.join(hooksDir, hookName);
      return fileSystem
        .writeFileString(hookPath, hookShimScript(hookName))
        .pipe(Effect.andThen(fileSystem.chmod(hookPath, 0o755).pipe(Effect.ignore)));
    },
    { concurrency: "unbounded", discard: true },
  );

  return {
    hooksDir,
    nodePath: self.command,
    entrypoint: self.entrypoint,
  } satisfies GitCommitHooksEnvConfig;
});

/** Publishes the materialized hook configuration to `process.env` so provider and terminal envs inherit it. */
export function publishGitCommitHooksToProcessEnv(config: GitCommitHooksEnvConfig): void {
  process.env[ANKIEL_GIT_HOOKS_DIR_ENV] = config.hooksDir;
  process.env[ANKIEL_GIT_HOOK_NODE_ENV] = config.nodePath;
  if (config.entrypoint !== undefined) {
    process.env[ANKIEL_GIT_HOOK_ENTRYPOINT_ENV] = config.entrypoint;
  } else {
    delete process.env[ANKIEL_GIT_HOOK_ENTRYPOINT_ENV];
  }
}
