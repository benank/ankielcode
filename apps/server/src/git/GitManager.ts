import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ByteSize from "effect/ByteSize";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import {
  GitActionProgressEvent,
  GitActionProgressPhase,
  GitCommandError,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  VcsStatusResult,
  ModelSelection,
  type ProjectId,
  type SourceControlWritingStyleSettings,
  type ThreadId,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
} from "@ankielcode/contracts";
import {
  hasProjectSettingsOverrides,
  resolveProjectSettings,
} from "@ankielcode/shared/projectSettings";
import { removeAgentCredits } from "@ankielcode/shared/commitMessage";
import {
  mergeGitStatusParts,
  resolveAutoFeatureBranchName,
  sanitizeFeatureBranchName,
} from "@ankielcode/shared/git";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

import { GitManagerError } from "@ankielcode/contracts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  conventionalCommitsTextGenerationPolicy,
  customTextGenerationPolicy,
  repositoryConventionsTextGenerationPolicy,
} from "../textGeneration/TextGenerationPresets.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { GitManagerServiceError } from "@ankielcode/contracts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isNonRepositoryGitStderr } from "../vcs/GitVcsDriverCore.ts";
import * as SourceControlRateLimit from "@ankielcode/source-control-core/server/SourceControlRateLimit";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";

export interface GitActionProgressReporter {
  readonly publish: (event: GitActionProgressEvent) => Effect.Effect<void, never>;
}

export interface GitRunStackedActionOptions {
  readonly actionId?: string;
  readonly progressReporter?: GitActionProgressReporter;
}

export interface GitLocalStatusOptions {
  /** Defaults to true. The branch-wide totals cost about half of a local status read. */
  readonly includeBranchChanges?: boolean;
}

export interface GitRemoteStatusOptions extends GitVcsDriver.GitRemoteStatusOptions {
  /** Details the caller just read without fetching; used instead of reading them again. */
  readonly statusDetails?: GitVcsDriver.GitRemoteStatusDetails;
}

interface SourceControlTextGenerationSettings {
  readonly modelSelection: ModelSelection;
  readonly projectId: ProjectId | null;
  readonly style: SourceControlWritingStyleSettings;
}

export class GitManager extends Context.Service<
  GitManager,
  {
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
      options?: GitLocalStatusOptions,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
  }
>()("@ankielcode/server/git/GitManager") {}

const COMMIT_TIMEOUT_MS = 10 * 60_000;
const MAX_PROGRESS_TEXT_LENGTH = 500;
const SHORT_SHA_LENGTH = 7;
const TOAST_DESCRIPTION_MAX = 72;
const STATUS_RESULT_CACHE_TTL = Duration.seconds(1);
const STATUS_RESULT_CACHE_CAPACITY = 2_048;

type StripProgressContext<T> = T extends any ? Omit<T, "actionId" | "cwd" | "action"> : never;
type GitActionProgressPayload = StripProgressContext<GitActionProgressEvent>;

function isNotGitRepositoryError(error: GitCommandError): boolean {
  return isNonRepositoryGitStderr(error.message);
}

function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function shortenSha(sha: string | undefined): string | null {
  if (!sha) return null;
  return sha.slice(0, SHORT_SHA_LENGTH);
}

function truncateText(
  value: string | undefined,
  maxLength = TOAST_DESCRIPTION_MAX,
): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return "...".slice(0, maxLength);
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function withDescription(title: string, description: string | undefined) {
  return description ? { title, description } : { title };
}

function summarizeGitActionResult(result: Pick<GitRunStackedActionResult, "commit" | "push">): {
  title: string;
  description?: string;
} {
  if (result.push.status === "pushed") {
    const shortSha = shortenSha(result.commit.commitSha);
    const branch = result.push.upstreamBranch ?? result.push.branch;
    const pushedCommitPart = shortSha ? ` ${shortSha}` : "";
    const branchPart = branch ? ` to ${branch}` : "";
    return withDescription(
      `Pushed${pushedCommitPart}${branchPart}`,
      truncateText(result.commit.subject),
    );
  }

  if (result.commit.status === "created") {
    const shortSha = shortenSha(result.commit.commitSha);
    const title = shortSha ? `Committed ${shortSha}` : "Committed changes";
    return withDescription(title, truncateText(result.commit.subject));
  }

  return { title: "Done" };
}

function buildCompletionToast(
  result: Pick<GitRunStackedActionResult, "action" | "commit" | "push">,
): GitRunStackedActionResult["toast"] {
  const cta =
    result.action === "commit" && result.commit.status === "created"
      ? { kind: "run_action" as const, label: "Push", action: { kind: "push" as const } }
      : { kind: "none" as const };
  return { ...summarizeGitActionResult(result), cta };
}

// A backstop for models that ignore the preset's lowercase instruction; acronyms and names like GitHub are left alone.
const CONVENTIONAL_CAPITALIZED_DESCRIPTION =
  /^([a-z]+(?:\([^)\n]*\))?!?: )([A-Z][a-z]*)(?![A-Za-z0-9])/;

function sanitizeCommitMessage(
  generated: {
    subject: string;
    body: string;
    branch?: string | undefined;
  },
  conventionalCommits: boolean,
): {
  subject: string;
  body: string;
  branch?: string | undefined;
} {
  const rawSubject = generated.subject.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const trimmedSubject = rawSubject.replace(/[.]+$/g, "").trim();
  const subject = conventionalCommits
    ? trimmedSubject.replace(
        CONVENTIONAL_CAPITALIZED_DESCRIPTION,
        (_, prefix: string, word: string) => prefix + word.toLowerCase(),
      )
    : trimmedSubject;
  const safeSubject = subject.length > 0 ? subject.slice(0, 72).trimEnd() : "Update project files";
  return {
    subject: safeSubject,
    body: removeAgentCredits(generated.body.trim()).trim(),
    ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
  };
}

function sanitizeProgressText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length <= MAX_PROGRESS_TEXT_LENGTH) {
    return trimmed;
  }
  return trimmed.slice(0, MAX_PROGRESS_TEXT_LENGTH).trimEnd();
}

interface CommitAndBranchSuggestion {
  subject: string;
  body: string;
  branch?: string | undefined;
  commitMessage: string;
}

function isCommitAction(action: GitStackedAction): action is "commit" | "commit_push" {
  return action === "commit" || action === "commit_push";
}

function formatCommitMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return subject;
  }
  return `${subject}\n\n${trimmedBody}`;
}

function parseCustomCommitMessage(raw: string): { subject: string; body: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }

  const [firstLine, ...rest] = normalized.split("\n");
  const subject = firstLine?.trim() ?? "";
  if (subject.length === 0) {
    return null;
  }

  return {
    subject,
    body: removeAgentCredits(rest.join("\n").trim()).trim(),
  };
}

export const make = Effect.gen(function* () {
  const gitCore = yield* GitVcsDriver.GitVcsDriver;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const sourceControlProvider = (cwd: string) => sourceControlProviders.resolve({ cwd });
  // Git fetches from a remote's first URL; `config --get` returns the last of several.
  const readRemoteUrl = (cwd: string, remoteName: string) =>
    gitCore
      .execute({
        operation: "GitManager.readRemoteUrl",
        cwd,
        args: ["config", "--get-all", `remote.${remoteName}.url`],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.stdout.split("\n", 1)[0]?.trim() || null));
  const serverSettingsService = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectSettingsFor = Effect.fnUntraced(function* (input: {
    readonly cwd: string;
    readonly threadId?: ThreadId | undefined;
    readonly projectId?: ProjectId | undefined;
  }) {
    const settings = yield* serverSettingsService.getSettings;
    if (!hasProjectSettingsOverrides(settings))
      return { settings, projectId: null as ProjectId | null };
    const threadProjectId =
      input.threadId === undefined
        ? null
        : yield* threads.getThreadShell(input.threadId).pipe(
            Effect.map((thread) => thread?.projectId ?? null),
            Effect.orElseSucceed(() => null),
          );
    const projectId =
      threadProjectId ??
      input.projectId ??
      (yield* projects.findActiveByWorkspaceRoot(input.cwd).pipe(
        Effect.map((project) => Option.getOrNull(project)?.projectId ?? null),
        Effect.orElseSucceed(() => null),
      ));
    return { settings: resolveProjectSettings(settings, projectId).settings, projectId };
  });
  // Hands the base Ankiel recorded for a branch to the host, whose own tools may keep it elsewhere.
  // Best-effort: nothing Ankiel does reads it back from there.
  const shareBranchBase = Effect.fn("GitManager.shareBranchBase")(function* (
    cwd: string,
    branch: string,
  ) {
    const baseBranch = yield* gitCore
      .readBranchBase(cwd, branch)
      .pipe(Effect.orElseSucceed(() => null));
    if (baseBranch === null) return;
    const provider = yield* sourceControlProvider(cwd).pipe(Effect.orElseSucceed(() => null));
    yield* provider?.recordBranchBase?.({ cwd, branch, baseBranch }) ?? Effect.void;
  });
  // Publishing a branch that tracks its base records that base first, even when the push then
  // fails, so the host hears of it after every successful push rather than the first attempt.
  const pushCurrentBranch = Effect.fn("GitManager.pushCurrentBranch")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const result = yield* gitCore.pushCurrentBranch(cwd, branch);
    if (result.status === "pushed" && result.branch) {
      yield* shareBranchBase(cwd, result.branch);
    }
    return result;
  });
  const readWorktreeCreationSettings = serverSettingsService.getSettings.pipe(
    Effect.map((settings) => ({
      worktreesDirectory: settings.worktreesDirectory,
      fastCheckout: settings.fastWorktreeCheckout,
    })),
    Effect.orElseSucceed(() => ({ worktreesDirectory: "" })),
  );
  // Turning fast checkout off deletes its cache right away, not at the next worktree.
  yield* serverSettingsService.streamChanges.pipe(
    Stream.map((settings) => settings.fastWorktreeCheckout),
    Stream.changes,
    Stream.filter((enabled) => !enabled),
    Stream.runForEach(() => gitCore.clearWorktreeCheckoutCache),
    Effect.forkScoped,
  );
  const createWorktree: GitManager["Service"]["createWorktree"] = Effect.fn(
    "GitManager.createWorktree",
  )(function* (input, options) {
    const submodules =
      options?.submodules !== undefined
        ? options.submodules
        : yield* projectSettingsFor(input).pipe(
            Effect.map(({ settings }) => settings.worktreeSubmodules),
            Effect.orElseSucceed(() => null),
          );
    const result = yield* gitCore.createWorktree(input, {
      ...(yield* readWorktreeCreationSettings),
      ...options,
      submodules,
    });
    if (input.newRefName && input.baseRefName) {
      yield* shareBranchBase(input.cwd, input.newRefName);
    }
    return result;
  });

  const readRepositoryInstructions = Effect.fn("GitManager.readRepositoryInstructions")(
    function* (cwd: string, fileName: string) {
      const root = yield* fileSystem.realPath(cwd);
      const instructionPath = yield* fileSystem.realPath(path.join(root, fileName));
      const relative = path.relative(root, instructionPath);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        return "";
      }
      const info = yield* fileSystem.stat(instructionPath);
      if (info.type !== "File" || info.size > ByteSize.bytes(20_000)) {
        return "";
      }
      return (yield* fileSystem.readFileString(instructionPath)).trim();
    },
    Effect.orElseSucceed(() => ""),
  );

  const readRecentCommitSubjects = (cwd: string) =>
    gitCore
      .execute({
        operation: "GitManager.readRecentCommitSubjects",
        cwd,
        args: ["log", "-n", "20", "--no-merges", "--no-show-signature", "--pretty=format:%s"],
      })
      .pipe(
        Effect.map((result) =>
          result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        ),
        Effect.orElseSucceed(() => []),
      );

  const resolveStylePolicy = Effect.fn("GitManager.resolveStylePolicy")(function* (
    cwd: string,
    settings: SourceControlTextGenerationSettings,
  ) {
    switch (settings.style.mode) {
      case "conventional_commits":
        return conventionalCommitsTextGenerationPolicy;
      case "custom":
        return customTextGenerationPolicy(
          settings.style.customInstructions
            ? {
                commitInstructions: settings.style.customInstructions,
                changeRequestInstructions: settings.style.customInstructions,
              }
            : {},
        );
      case "repo_conventions": {
        const subjects = yield* readRecentCommitSubjects(cwd);
        const agentInstructions = yield* readRepositoryInstructions(cwd, "AGENTS.md");
        const isClaudeWriter =
          settings.modelSelection.instanceId === "claudeAgent" ||
          (yield* providerRegistry.getProviders).some(
            (provider) =>
              provider.instanceId === settings.modelSelection.instanceId &&
              provider.driver === "claudeAgent",
          );
        const claudeInstructions = isClaudeWriter
          ? yield* readRepositoryInstructions(cwd, "CLAUDE.md")
          : "";
        const examples = [
          ...(subjects.length > 0
            ? [["Recent commit subjects from this repository:", ...subjects].join("\n")]
            : []),
          ...(agentInstructions ? [`Local AGENTS.md:\n${agentInstructions}`] : []),
          // CLAUDE.md is often a symlink or copy of AGENTS.md; skip the duplicate.
          ...(claudeInstructions && claudeInstructions !== agentInstructions
            ? [`Local CLAUDE.md:\n${claudeInstructions}`]
            : []),
        ].join("\n\n");
        if (!examples) {
          return repositoryConventionsTextGenerationPolicy;
        }
        return {
          ...repositoryConventionsTextGenerationPolicy,
          commitInstructions: `${repositoryConventionsTextGenerationPolicy.commitInstructions}\n\n${examples}`,
          changeRequestInstructions: `${repositoryConventionsTextGenerationPolicy.changeRequestInstructions}\n\n${examples}`,
        };
      }
    }
  });
  const randomUUIDv4 = (cwd: string) =>
    random.uuidV4().pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation: "randomUUIDv4",
            cwd,
            detail: "Failed to generate Git operation identifier.",
            cause,
          }),
      ),
    );

  const createProgressEmitter = (
    input: { cwd: string; action: GitStackedAction },
    options?: GitRunStackedActionOptions,
  ) =>
    (options?.actionId === undefined
      ? randomUUIDv4(input.cwd)
      : Effect.succeed(options.actionId)
    ).pipe(
      Effect.map((actionId) => {
        const reporter = options?.progressReporter;
        const emit = (event: GitActionProgressPayload) =>
          reporter
            ? reporter.publish({
                actionId,
                cwd: input.cwd,
                action: input.action,
                ...event,
              } as GitActionProgressEvent)
            : Effect.void;

        return {
          actionId,
          emit,
        };
      }),
    );

  const canonicalizeExistingPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
  const normalizeStatusCacheKey = canonicalizeExistingPath;
  const nonRepositoryStatusDetails: GitVcsDriver.GitStatusDetails = {
    isRepo: false,
    hasOriginRemote: false,
    isDefaultBranch: false,
    branch: null,
    upstreamRef: null,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
  };
  const readLocalStatus = Effect.fn("readLocalStatus")(function* (
    cwd: string,
    includeBranchChanges: boolean,
  ) {
    const details = yield* gitCore
      .statusDetailsLocal(cwd, { includeDivergence: false, includeBranchChanges })
      .pipe(
        Effect.catchIf(isNotGitRepositoryError, () => Effect.succeed(nonRepositoryStatusDetails)),
      );
    const hostingProvider = details.hasOriginRemote
      ? yield* resolveHostingProvider(cwd, details.branch)
      : null;

    return {
      isRepo: details.isRepo,
      ...(hostingProvider ? { sourceControlProvider: hostingProvider } : {}),
      hasPrimaryRemote: details.hasOriginRemote,
      isDefaultRef: details.isDefaultBranch,
      refName: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      workingTree: details.workingTree,
      ...(details.branchChanges ? { branchChanges: details.branchChanges } : {}),
    } satisfies VcsStatusLocalResult;
  });
  const makeLocalStatusResultCache = (includeBranchChanges: boolean) =>
    Cache.makeWith((cwd: string) => readLocalStatus(cwd, includeBranchChanges), {
      capacity: STATUS_RESULT_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_RESULT_CACHE_TTL : Duration.zero),
    });
  // Separate entries, so a read without totals is never served to a caller that shows them.
  const localStatusResultCache = yield* makeLocalStatusResultCache(true);
  const localStatusWithoutBranchChangesCache = yield* makeLocalStatusResultCache(false);
  const invalidateLocalStatusResultCache = (cwd: string) =>
    normalizeStatusCacheKey(cwd).pipe(
      Effect.flatMap((cacheKey) =>
        Effect.all([
          Cache.invalidate(localStatusResultCache, cacheKey),
          Cache.invalidate(localStatusWithoutBranchChangesCache, cacheKey),
        ]),
      ),
    );
  const readRemoteStatus = Effect.fn("readRemoteStatus")(function* (
    cwd: string,
    options?: GitRemoteStatusOptions,
  ) {
    const details =
      options?.statusDetails ??
      (yield* gitCore
        .statusDetailsRemote(cwd, options)
        .pipe(Effect.catchIf(isNotGitRepositoryError, () => Effect.succeed(null))));
    if (details === null || !details.isRepo) {
      return null;
    }

    return {
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      aheadOfDefaultCount: details.aheadOfDefaultCount,
      pr: null,
    } satisfies VcsStatusRemoteResult;
  });
  const remoteStatusResultCache = yield* Cache.makeWith((cwd: string) => readRemoteStatus(cwd), {
    capacity: STATUS_RESULT_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_RESULT_CACHE_TTL : Duration.zero),
  });
  const invalidateRemoteStatusResultCache = (cwd: string) =>
    normalizeStatusCacheKey(cwd).pipe(
      Effect.flatMap((cacheKey) => Cache.invalidate(remoteStatusResultCache, cacheKey)),
    );

  const readConfigValueNullable = (cwd: string, key: string) =>
    gitCore.readConfigValue(cwd, key).pipe(Effect.orElseSucceed(() => null));
  const readRemoteUrlNullable = (cwd: string, remoteName: string) =>
    readRemoteUrl(cwd, remoteName).pipe(Effect.orElseSucceed(() => null));

  const resolveHostingProvider = Effect.fn("resolveHostingProvider")(function* (
    cwd: string,
    branch: string | null,
  ) {
    const preferredRemoteName =
      branch === null
        ? "origin"
        : ((yield* readConfigValueNullable(cwd, `branch.${branch}.remote`)) ?? "origin");
    const remoteUrl =
      (yield* readRemoteUrlNullable(cwd, preferredRemoteName)) ??
      (yield* readRemoteUrlNullable(cwd, "origin"));

    const provider = remoteUrl ? sourceControlDefinitions.recognizeRemote(remoteUrl) : null;
    if (!remoteUrl || provider?.kind !== "unknown") return provider;
    const handle = yield* sourceControlProviders
      .resolveHandle({
        cwd,
        context: { provider, remoteName: preferredRemoteName, remoteUrl },
      })
      .pipe(Effect.orElseSucceed(() => null));
    return handle?.context?.provider ?? provider;
  });
  const resolveCommitAndBranchSuggestion = Effect.fn("resolveCommitAndBranchSuggestion")(
    function* (input: {
      cwd: string;
      branch: string | null;
      commitMessage?: string;
      includeBranch?: boolean;
      filePaths?: readonly string[];
      settings: SourceControlTextGenerationSettings;
    }) {
      const customCommit = parseCustomCommitMessage(input.commitMessage ?? "");
      const context = yield* gitCore.prepareCommitContext(input.cwd, input.filePaths, {
        includePatch: customCommit === null,
      });
      if (!context) {
        return null;
      }

      if (customCommit) {
        return {
          subject: customCommit.subject,
          body: customCommit.body,
          ...(input.includeBranch
            ? { branch: sanitizeFeatureBranchName(customCommit.subject) }
            : {}),
          commitMessage: formatCommitMessage(customCommit.subject, customCommit.body),
        };
      }

      const policy = yield* resolveStylePolicy(input.cwd, input.settings);

      const generated = yield* textGeneration
        .generateCommitMessage({
          cwd: input.cwd,
          branch: input.branch,
          stagedSummary: limitContext(context.stagedSummary, 8_000),
          stagedPatch: limitContext(context.stagedPatch, 50_000),
          ...(input.includeBranch ? { includeBranch: true } : {}),
          ...(policy ? { policy } : {}),
          modelSelection: input.settings.modelSelection,
          projectId: input.settings.projectId,
        })
        .pipe(
          Effect.map((result) =>
            sanitizeCommitMessage(result, policy?.kind === "conventional_commits"),
          ),
        );

      return {
        subject: generated.subject,
        body: generated.body,
        ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
        commitMessage: formatCommitMessage(generated.subject, generated.body),
      };
    },
  );

  const runCommitStep = Effect.fn("runCommitStep")(function* (
    settings: SourceControlTextGenerationSettings,
    cwd: string,
    action: "commit" | "commit_push",
    branch: string | null,
    commitMessage?: string,
    preResolvedSuggestion?: CommitAndBranchSuggestion,
    filePaths?: readonly string[],
    progressReporter?: GitActionProgressReporter,
    actionId?: string,
  ) {
    const emit = (event: GitActionProgressPayload) =>
      progressReporter && actionId
        ? progressReporter.publish({
            actionId,
            cwd,
            action,
            ...event,
          } as GitActionProgressEvent)
        : Effect.void;

    const customCommit = parseCustomCommitMessage(commitMessage ?? "");
    let suggestion: CommitAndBranchSuggestion | null | undefined =
      preResolvedSuggestion ??
      (customCommit && {
        ...customCommit,
        commitMessage: formatCommitMessage(customCommit.subject, customCommit.body),
      });
    if (!suggestion) {
      const needsGeneration = !commitMessage?.trim();
      if (needsGeneration) {
        yield* emit({
          kind: "phase_started",
          phase: "commit",
          label: "Generating commit message...",
        });
      }
      suggestion = yield* resolveCommitAndBranchSuggestion({
        cwd,
        branch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(filePaths ? { filePaths } : {}),
        settings,
      });
    }
    if (!suggestion) {
      return { status: "skipped_no_changes" as const };
    }

    yield* emit({
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    });

    let currentHookName: string | null = null;
    const commitProgress =
      progressReporter && actionId
        ? {
            onOutputLine: ({ stream, text }: { stream: "stdout" | "stderr"; text: string }) => {
              const sanitized = sanitizeProgressText(text);
              if (!sanitized) {
                return Effect.void;
              }
              return emit({
                kind: "hook_output",
                hookName: currentHookName,
                stream,
                text: sanitized,
              });
            },
            onHookStarted: (hookName: string) => {
              currentHookName = hookName;
              return emit({
                kind: "hook_started",
                hookName,
              });
            },
            onHookFinished: ({
              hookName,
              exitCode,
              durationMs,
            }: {
              hookName: string;
              exitCode: number | null;
              durationMs: number | null;
            }) => {
              if (currentHookName === hookName) {
                currentHookName = null;
              }
              return emit({
                kind: "hook_finished",
                hookName,
                exitCode,
                durationMs,
              });
            },
          }
        : null;
    const committed = yield* gitCore
      .commit(cwd, suggestion.subject, suggestion.body, {
        timeoutMs: COMMIT_TIMEOUT_MS,
        stage: {
          ...(filePaths ? { filePaths } : {}),
          ...(!preResolvedSuggestion && customCommit ? { unverified: true } : {}),
        },
        ...(commitProgress ? { progress: commitProgress } : {}),
      })
      .pipe(Effect.catchTags({ GitNothingToCommitError: () => Effect.succeed(null) }));
    if (!committed) {
      return { status: "skipped_no_changes" as const };
    }
    const { commitSha } = committed;
    if (currentHookName !== null) {
      yield* emit({
        kind: "hook_finished",
        hookName: currentHookName,
        exitCode: 0,
        durationMs: null,
      });
      currentHookName = null;
    }
    return {
      status: "created" as const,
      commitSha,
      subject: suggestion.subject,
    };
  });

  const localStatus: GitManager["Service"]["localStatus"] = Effect.fn("localStatus")(
    function* (input, options) {
      const cacheKey = yield* normalizeStatusCacheKey(input.cwd);
      return yield* Cache.get(
        options?.includeBranchChanges === false
          ? localStatusWithoutBranchChangesCache
          : localStatusResultCache,
        cacheKey,
      );
    },
  );
  const remoteStatus: GitManager["Service"]["remoteStatus"] = Effect.fn("remoteStatus")(
    function* (input, options) {
      const cacheKey = yield* normalizeStatusCacheKey(input.cwd);
      if (options?.refreshUpstream === false) {
        return yield* readRemoteStatus(cacheKey, options);
      }
      return yield* Cache.get(remoteStatusResultCache, cacheKey);
    },
  );
  const status: GitManager["Service"]["status"] = Effect.fn("status")(function* (input) {
    const [local, remote] = yield* Effect.all([localStatus(input), remoteStatus(input)], {
      concurrency: "unbounded",
    });
    return mergeGitStatusParts(local, remote);
  });

  const invalidateLocalStatus: GitManager["Service"]["invalidateLocalStatus"] = Effect.fn(
    "invalidateLocalStatus",
  )(function* (cwd) {
    yield* invalidateLocalStatusResultCache(cwd);
  });
  const invalidateRemoteStatus: GitManager["Service"]["invalidateRemoteStatus"] = Effect.fn(
    "invalidateRemoteStatus",
  )(function* (cwd) {
    yield* invalidateRemoteStatusResultCache(cwd);
  });
  const invalidateStatus: GitManager["Service"]["invalidateStatus"] = Effect.fn("invalidateStatus")(
    function* (cwd) {
      yield* invalidateLocalStatusResultCache(cwd);
      yield* invalidateRemoteStatusResultCache(cwd);
    },
  );

  // A user is waiting on these, so a host's background rate-limit pause must not refuse them.
  const asUserAction = Effect.provideService(SourceControlRateLimit.Interactive, true);

  const runFeatureBranchStep = Effect.fn("runFeatureBranchStep")(function* (
    settings: SourceControlTextGenerationSettings,
    cwd: string,
    branch: string | null,
    commitMessage?: string,
    filePaths?: readonly string[],
  ) {
    const suggestion = yield* resolveCommitAndBranchSuggestion({
      cwd,
      branch,
      ...(commitMessage ? { commitMessage } : {}),
      ...(filePaths ? { filePaths } : {}),
      includeBranch: true,
      settings,
    });
    if (!suggestion) {
      return yield* new GitManagerError({
        operation: "runFeatureBranchStep",
        cwd,
        detail: "Cannot create a feature branch because there are no changes to commit.",
      });
    }

    const preferredBranch = suggestion.branch ?? sanitizeFeatureBranchName(suggestion.subject);
    const existingBranchNames = yield* gitCore.listLocalBranchNames(cwd);
    const resolvedBranch = resolveAutoFeatureBranchName(existingBranchNames, preferredBranch);

    yield* gitCore.createRef({ cwd, refName: resolvedBranch });
    yield* Effect.scoped(gitCore.switchRef({ cwd, refName: resolvedBranch }));

    return {
      branchStep: { status: "created" as const, name: resolvedBranch },
      resolvedCommitMessage: suggestion.commitMessage,
      resolvedCommitSuggestion: suggestion,
    };
  });

  const runStackedAction: GitManager["Service"]["runStackedAction"] = Effect.fn("runStackedAction")(
    function* (request, options) {
      const { action } = request;
      if (action === "create_pr" || action === "commit_push_pr") {
        return yield* new GitManagerError({
          operation: "runStackedAction",
          cwd: request.cwd,
          detail: "This server no longer creates pull requests. Update Ankiel Code on this device.",
        });
      }
      const input = { ...request, action };
      const progress = yield* createProgressEmitter(input, options);
      const currentPhase = yield* Ref.make<Option.Option<GitActionProgressPhase>>(Option.none());

      const runAction = Effect.fn("runStackedAction.runAction")(function* (): Effect.fn.Return<
        GitRunStackedActionResult,
        GitManagerServiceError
      > {
        const initialStatus = yield* gitCore.statusDetails(input.cwd);
        const wantsCommit = isCommitAction(input.action);
        const wantsPush = input.action === "push" || input.action === "commit_push";

        if (input.featureBranch && !wantsCommit) {
          return yield* new GitManagerError({
            operation: "runStackedAction",
            cwd: input.cwd,
            detail: "Feature-branch checkout is only supported for commit actions.",
          });
        }
        const phases: GitActionProgressPhase[] = [
          ...(input.featureBranch ? (["branch"] as const) : []),
          ...(wantsCommit ? (["commit"] as const) : []),
          ...(wantsPush ? (["push"] as const) : []),
        ];

        yield* progress.emit({
          kind: "action_started",
          phases,
        });

        if (!input.featureBranch && wantsPush && !initialStatus.branch) {
          return yield* new GitManagerError({
            operation: "runStackedAction",
            cwd: input.cwd,
            detail: "Cannot push from detached HEAD.",
          });
        }

        let branchStep: { status: "created" | "skipped_not_requested"; name?: string };
        let commitMessageForStep = input.commitMessage;
        let preResolvedCommitSuggestion: CommitAndBranchSuggestion | undefined = undefined;

        const textGenerationSettings = yield* projectSettingsFor(input).pipe(
          Effect.flatMap(({ settings, projectId }) =>
            settings.sourceControlWriterModelSelection === null
              ? Effect.succeed({
                  modelSelection: settings.textGenerationModelSelection,
                  projectId,
                  style: settings.sourceControlWritingStyle,
                })
              : providerRegistry.getProviders.pipe(
                  Effect.map((providers) => ({
                    modelSelection: ServerSettings.resolveSourceControlWriterModelSelection(
                      settings,
                      providers,
                      projectId,
                    ),
                    projectId,
                    style: settings.sourceControlWritingStyle,
                  })),
                ),
          ),
          Effect.mapError(
            (cause) =>
              new GitManagerError({
                operation: "runStackedAction",
                cwd: input.cwd,
                detail: "Failed to get server settings.",
                cause,
              }),
          ),
        );

        if (input.featureBranch) {
          yield* Ref.set(currentPhase, Option.some("branch"));
          yield* progress.emit({
            kind: "phase_started",
            phase: "branch",
            label: "Preparing feature branch...",
          });
          const result = yield* runFeatureBranchStep(
            textGenerationSettings,
            input.cwd,
            initialStatus.branch,
            input.commitMessage,
            input.filePaths,
          );
          branchStep = result.branchStep;
          commitMessageForStep = result.resolvedCommitMessage;
          preResolvedCommitSuggestion = result.resolvedCommitSuggestion;
        } else {
          branchStep = { status: "skipped_not_requested" as const };
        }

        const currentBranch = branchStep.name ?? initialStatus.branch;
        const commitAction = isCommitAction(input.action) ? input.action : null;
        const commit = commitAction
          ? yield* Ref.set(currentPhase, Option.some("commit")).pipe(
              Effect.flatMap(() =>
                runCommitStep(
                  textGenerationSettings,
                  input.cwd,
                  commitAction,
                  currentBranch,
                  commitMessageForStep,
                  preResolvedCommitSuggestion,
                  input.filePaths,
                  options?.progressReporter,
                  progress.actionId,
                ),
              ),
            )
          : { status: "skipped_not_requested" as const };

        const push = wantsPush
          ? yield* progress
              .emit({
                kind: "phase_started",
                phase: "push",
                label: "Pushing...",
              })
              .pipe(
                Effect.tap(() => Ref.set(currentPhase, Option.some("push"))),
                Effect.flatMap(() => pushCurrentBranch(input.cwd, currentBranch)),
              )
          : { status: "skipped_not_requested" as const };

        const toast = buildCompletionToast({ action: input.action, commit, push });

        const result = {
          action: input.action,
          branch: branchStep,
          commit,
          push,
          pr: { status: "skipped_not_requested" as const },
          toast,
        };
        yield* progress.emit({
          kind: "action_finished",
          result,
        });
        return result;
      });

      return yield* runAction().pipe(
        Effect.ensuring(invalidateStatus(input.cwd)),
        Effect.tapError((error) =>
          Effect.flatMap(Ref.get(currentPhase), (phase) =>
            progress.emit({
              kind: "action_failed",
              phase: Option.getOrNull(phase),
              message: error.message,
            }),
          ),
        ),
      );
    },
    asUserAction,
  );

  return GitManager.of({
    createWorktree,
    localStatus,
    remoteStatus,
    status,
    invalidateLocalStatus,
    invalidateRemoteStatus,
    invalidateStatus,
    runStackedAction,
  });
});

export const layer = Layer.effect(GitManager, make);
