import { SourceControlProviderKind } from "@ankielcode/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
import type { GitActionProgressEvent, ModelSelection, ServerProvider } from "@ankielcode/contracts";

import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  GitCommandError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SourceControlProviderError as SourceControlProviderFailure,
  TextGenerationError,
  ThreadId,
} from "@ankielcode/contracts";
import * as DateTime from "effect/DateTime";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import type { SourceControlProvider } from "@ankielcode/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitManager from "./GitManager.ts";

interface FakeProviderScenario {
  /** The kind the fake host reports itself as. */
  kind?: string;
  defaultBranch?: string;
  repositoryCloneUrls?: Record<string, { url: string; sshUrl: string }>;
  failWith?: string;
  failCause?: unknown;
  failAfterCalls?: number;
}

type FakeProviderCall =
  | { readonly operation: "getRepositoryCloneUrls"; readonly repository: string }
  | { readonly operation: "getDefaultBranch" };

type FakeGitTextGeneration = TextGeneration.TextGeneration["Service"];

function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function removePath(
  targetPath: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.remove(targetPath, { recursive: true, force: true });
  });
}

function makeDirectory(
  dirPath: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(dirPath, { recursive: true });
  });
}

function runGit(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<
  {
    readonly exitCode: GitVcsDriver.ExecuteGitResult["exitCode"];
    readonly stdout: string;
    readonly stderr: string;
  },
  GitCommandError,
  GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* git.execute({
      operation: "GitManager.test.runGit",
      cwd,
      args,
      allowNonZeroExit,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
}

/** A committed repository and an empty bare remote, built once and copied into each test. */
class GitFixtureTemplates extends Context.Service<
  GitFixtureTemplates,
  { readonly repo: string; readonly bareRemote: string }
>()("@ankielcode/server/git/GitManager.test/GitFixtureTemplates") {}

const layerGitFixtureTemplates = Layer.effect(
  GitFixtureTemplates,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repo = yield* makeTempDir("ankielcode-git-template-");
    // An empty template skips copying git's sample hooks into every test repository.
    yield* runGit(repo, ["init", "--initial-branch=main", "--template="]);
    yield* runGit(repo, ["config", "user.email", "test@example.com"]);
    yield* runGit(repo, ["config", "user.name", "Test User"]);
    // Override global autocrlf on Windows for LF assertions, including linked worktrees.
    yield* runGit(repo, ["config", "core.autocrlf", "false"]);
    yield* fs.writeFileString(NodePath.join(repo, "README.md"), "hello\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial commit"]);
    const bareRemote = yield* makeTempDir("ankielcode-git-remote-template-");
    yield* runGit(bareRemote, ["init", "--bare", "--template="]);
    yield* fs.makeDirectory(NodePath.join(bareRemote, "hooks"), { recursive: true });
    return { repo, bareRemote };
  }),
);

function initRepo(
  cwd: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | GitFixtureTemplates> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const templates = yield* GitFixtureTemplates;
    for (const entry of [".git", "README.md"]) {
      yield* fs.copy(NodePath.join(templates.repo, entry), NodePath.join(cwd, entry));
    }
  });
}

function createBareRemote(): Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope | GitFixtureTemplates
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const templates = yield* GitFixtureTemplates;
    const remoteDir = yield* makeTempDir("ankielcode-git-remote-");
    yield* fs.copy(templates.bareRemote, remoteDir, { overwrite: true });
    return remoteDir;
  });
}

function createTextGeneration(
  overrides: Partial<FakeGitTextGeneration> = {},
): TextGeneration.TextGeneration["Service"] {
  const implementation: FakeGitTextGeneration = {
    generateCommitMessage: (input) =>
      Effect.succeed({
        subject: "Implement stacked git actions",
        body: "",
        ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
      }),
    generateBranchName: () =>
      Effect.succeed({
        branch: "update-workflow",
      }),
    generateThreadTitle: () =>
      Effect.succeed({
        title: "Update workflow",
      }),
    generateTranscriptionPostProcessing: () =>
      Effect.succeed({ transcription: "processed transcript" }),
    ...overrides,
  };

  return {
    generateCommitMessage: (input) =>
      implementation.generateCommitMessage(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateBranchName: (input) =>
      implementation.generateBranchName(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateThreadTitle: (input) =>
      implementation.generateThreadTitle(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateTranscriptionPostProcessing: (input) =>
      implementation.generateTranscriptionPostProcessing(input),
  };
}

/**
 * A host that answers from the scenario and records what it was asked, so tests assert on the
 * selectors GitManager chose rather than on any host's wire format.
 */
function createFakeSourceControlProvider(scenario: FakeProviderScenario = {}): {
  service: SourceControlProvider["Service"];
  calls: FakeProviderCall[];
} {
  const kind = SourceControlProviderKind.make(scenario.kind ?? "github");
  const calls: FakeProviderCall[] = [];

  const record = (cwd: string, call: FakeProviderCall) =>
    Effect.suspend(() => {
      calls.push(call);
      return scenario.failWith && calls.length > (scenario.failAfterCalls ?? 0)
        ? Effect.fail(
            new SourceControlProviderFailure({
              provider: kind,
              operation: call.operation,
              cwd,
              detail: scenario.failWith,
              cause: scenario.failCause,
            }),
          )
        : Effect.void;
    });

  return {
    service: {
      kind,
      getDefaultBranch: (input) =>
        record(input.cwd, { operation: "getDefaultBranch" }).pipe(
          Effect.map(() => {
            const value = (scenario.defaultBranch ?? "main").trim();
            return value.length > 0 ? value : null;
          }),
        ),
      getRepositoryCloneUrls: (input) =>
        record(input.cwd, {
          operation: "getRepositoryCloneUrls",
          repository: input.repository,
        }).pipe(
          Effect.flatMap(() => {
            const repository = input.host ? `${input.host}/${input.repository}` : input.repository;
            const cloneUrls =
              scenario.repositoryCloneUrls?.[repository] ??
              (input.host === "github.com"
                ? scenario.repositoryCloneUrls?.[input.repository]
                : undefined);
            return cloneUrls
              ? Effect.succeed({ nameWithOwner: input.repository, ...cloneUrls })
              : Effect.fail(
                  new SourceControlProviderFailure({
                    provider: kind,
                    operation: "getRepositoryCloneUrls",
                    cwd: input.cwd,
                    detail: `Unexpected repository lookup: ${input.repository}`,
                  }),
                );
          }),
        ),
      createRepository: (input) =>
        Effect.fail(
          new SourceControlProviderFailure({
            provider: kind,
            operation: "createRepository",
            cwd: input.cwd,
            detail: `Unexpected repository create: ${input.repository}`,
          }),
        ),
    },
    calls,
  };
}

function runStackedAction(
  manager: GitManager.GitManager["Service"],
  input: {
    cwd: string;
    action: "commit" | "push" | "commit_push";
    actionId?: string;
    commitMessage?: string;
    featureBranch?: boolean;
    filePaths?: readonly string[];
  },
  options?: Parameters<GitManager.GitManager["Service"]["runStackedAction"]>[1],
) {
  return manager.runStackedAction(
    {
      ...input,
      actionId: input.actionId ?? "test-action-id",
    },
    options,
  );
}

function makeManager(input?: {
  providerScenario?: FakeProviderScenario;
  sourceControlProvider?: SourceControlProvider["Service"];
  textGeneration?: Partial<FakeGitTextGeneration>;
  providers?: ReadonlyArray<ServerProvider>;
  serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  setupScriptRunner?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  gitConfigReads?: string[];
  gitCommands?: string[];
  gitSpawnGate?: {
    readonly matches: (args: ReadonlyArray<string>) => boolean;
    readonly reached: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
  seed?: Effect.Effect<
    void,
    ProjectionStore.ProjectionStoreV2Error | ProjectStore.ProjectStoreV2Error,
    ProjectionStore.ProjectionStoreV2 | ProjectStore.ProjectStoreV2
  >;
}) {
  const { service: fakeProvider, calls: providerCalls } = createFakeSourceControlProvider(
    input?.providerScenario,
  );
  const textGeneration = createTextGeneration(input?.textGeneration);
  const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
    prefix: "ankiel-git-manager-test-",
  });

  const layerServerSettings = ServerSettings.ServerSettingsService.layerTest({
    githubIntegrationEnabled: true,
    ...input?.serverSettings,
  });

  const gitCommands = input?.gitCommands;
  const gitSpawnGate = input?.gitSpawnGate;
  const watchesGitSpawns = gitCommands !== undefined || gitSpawnGate !== undefined;
  const layerGitDriverSpawner = watchesGitSpawns
    ? Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) => {
            // On Windows the driver starts git by its full path to git.exe.
            const args =
              command._tag === "StandardCommand" &&
              NodePath.parse(command.command).name.toLowerCase() === "git"
                ? command.args.map(String)
                : null;
            if (args !== null) gitCommands?.push(args.join(" "));
            if (args === null || gitSpawnGate === undefined || !gitSpawnGate.matches(args)) {
              return spawner.spawn(command);
            }
            return spawner
              .spawn(command)
              .pipe(
                Effect.tap((handle) =>
                  handle.exitCode.pipe(
                    Effect.andThen(Deferred.succeed(gitSpawnGate.reached, undefined)),
                    Effect.andThen(Deferred.await(gitSpawnGate.release)),
                  ),
                ),
              );
          });
        }),
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))
    : Layer.empty;
  const gitVcsDriver = input?.gitConfigReads
    ? Layer.effect(
        GitVcsDriver.GitVcsDriver,
        GitVcsDriver.make.pipe(
          Effect.map((service) =>
            GitVcsDriver.GitVcsDriver.of({
              ...service,
              readConfigValue: (cwd, key) =>
                Effect.sync(() => input.gitConfigReads?.push(key)).pipe(
                  Effect.andThen(service.readConfigValue(cwd, key)),
                ),
            }),
          ),
        ),
      )
    : GitVcsDriver.layer;
  const layerVcsDriver = (watchesGitSpawns ? Layer.fresh(gitVcsDriver) : gitVcsDriver).pipe(
    Layer.provide(layerGitDriverSpawner),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provideMerge(layerServerConfig),
  );
  const layerSourceControlRegistry = Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    Effect.gen(function* () {
      const context = yield* Effect.context<GitVcsDriver.GitVcsDriver>();
      void context;
      return input?.sourceControlProvider ?? fakeProvider;
    }).pipe(
      Effect.map((provider) =>
        SourceControlProviderRegistry.SourceControlProviderRegistry.of({
          resolveLink: (input) => provider.resolveLink?.(input),
          get: () => Effect.succeed(provider),
          resolveHandle: () => Effect.succeed({ provider, context: null }),
          resolve: () => Effect.succeed(provider),
          discover: Effect.succeed([]),
        }),
      ),
    ),
  );

  const layerManager = Layer.mergeAll(
    Layer.succeed(TextGeneration.TextGeneration, textGeneration),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(input?.providers ?? []),
    }),
    Layer.succeed(
      ProjectSetupScriptRunner.ProjectSetupScriptRunner,
      input?.setupScriptRunner ?? {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      },
    ),
    layerServerSettings,
  ).pipe(
    Layer.provideMerge(layerSourceControlRegistry),
    Layer.provideMerge(layerVcsDriver),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const layerStores = Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

  return Effect.gen(function* () {
    const stores = yield* Layer.build(layerStores);
    if (input?.seed !== undefined) {
      yield* input.seed.pipe(Effect.provideContext(stores), Effect.orDie);
    }
    const manager = yield* GitManager.make.pipe(
      Effect.provide(layerManager),
      Effect.provideContext(stores),
    );
    return { manager, providerCalls };
  });
}

const layerGitManagerTest = layerGitFixtureTemplates.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-git-manager-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(layerGitManagerTest)("GitManager", (it) => {
  it.effect("status returns an explicit non-repo result for deleted directories", () =>
    Effect.gen(function* () {
      const rootDir = yield* makeTempDir("ankielcode-git-manager-missing-dir-");
      const cwd = NodePath.join(rootDir, "deleted-repo");
      yield* makeDirectory(cwd);
      yield* removePath(cwd);
      const { manager } = yield* makeManager();

      const status = yield* manager.status({ cwd });

      expect(status).toEqual({
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }),
  );

  it.effect("status of a repository without remotes runs no remote, provider or PR lookups", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/local-only"]);
      const gitCommands: string[] = [];
      const { manager } = yield* makeManager({ gitCommands });

      const local = yield* manager.localStatus({ cwd: repoDir });
      const remote = yield* manager.remoteStatus({ cwd: repoDir });

      expect(local.hasPrimaryRemote).toBe(false);
      expect(local.sourceControlProvider).toBeUndefined();
      expect(remote?.pr ?? null).toBeNull();
      // Once git reports no remotes, remote URLs, branch remotes and remote refs cannot exist.
      expect(
        gitCommands.filter((args) =>
          /remote get-url|remote\.[^ ]+\.url|branch\.[^ ]+\.remote|refs\/remotes/.test(args),
        ),
      ).toEqual([]);

      // A remote added outside Ankiel Code shows on the next read.
      yield* runGit(repoDir, [
        "remote",
        "add",
        "origin",
        "https://github.com/benank/codething-mvp.git",
      ]);
      yield* TestClock.adjust("2 seconds");
      const afterRemote = yield* manager.localStatus({ cwd: repoDir });
      expect(afterRemote.hasPrimaryRemote).toBe(true);
      expect(afterRemote.sourceControlProvider?.kind).toBe("github");
    }),
  );

  it.effect("creates a commit when working tree is dirty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nworld\n");
      let generatedPolicy: TextGeneration.CommitMessageGenerationInput["policy"] = undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          sourceControlWritingStyle: {
            mode: "custom" as const,
            customInstructions: "Use a direct tone.",
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedPolicy = input.policy;
            return Effect.succeed({ subject: "Implement stacked git actions", body: "" });
          },
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(generatedPolicy).toMatchObject({ commitInstructions: "Use a direct tone." });
      expect(result.toast).toMatchObject({
        description: "Implement stacked git actions",
        cta: {
          kind: "run_action",
          label: "Push",
          action: {
            kind: "push",
          },
        },
      });
      expect(result.toast.title).toMatch(/^Committed [0-9a-f]{7}$/);
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%s"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("Implement stacked git actions");
    }),
  );

  it.effect("stages the worktree once for a typed commit message", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "typed\n");
      const gitCommands: string[] = [];
      const { manager } = yield* makeManager({ gitCommands });

      const created = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        commitMessage: "Typed subject\n\nTyped body",
      });

      expect(created.commit).toMatchObject({ status: "created", subject: "Typed subject" });
      expect(gitCommands.filter((args) => args.endsWith("add -A"))).toHaveLength(1);
      expect((yield* runGit(repoDir, ["log", "-1", "--pretty=%B"])).stdout.trim()).toBe(
        "Typed subject\n\nTyped body",
      );

      // Status shows the staged change, but staging the reverted worktree leaves nothing.
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "staged\n");
      yield* runGit(repoDir, ["add", "README.md"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "typed\n");
      const head = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout;

      const skipped = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        commitMessage: "Nothing to commit",
      });

      expect(skipped.commit.status).toBe("skipped_no_changes");
      expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout).toBe(head);
      expect((yield* runGit(repoDir, ["show", ":README.md"])).stdout).toBe("staged\n");

      // A generated message already checked a scratch index, so staging again stays at two.
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "generated\n");
      gitCommands.length = 0;
      const generated = yield* runStackedAction(manager, { cwd: repoDir, action: "commit" });
      expect(generated.commit.status).toBe("created");
      expect(gitCommands.filter((args) => args.endsWith("add -A"))).toHaveLength(2);
    }),
  );

  it.effect("includes CLAUDE.md for Claude writers only when it differs from AGENTS.md", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "AGENTS.md"), "Use imperative subjects.\n");
      NodeFS.copyFileSync(NodePath.join(repoDir, "AGENTS.md"), NodePath.join(repoDir, "CLAUDE.md"));
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\n");
      const commitInstructions: Array<string | undefined> = [];

      const { manager } = yield* makeManager({
        serverSettings: {
          textGenerationModelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-5",
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            commitInstructions.push(input.policy?.commitInstructions);
            return Effect.succeed({ subject: "Update readme", body: "" });
          },
        },
      });

      yield* runStackedAction(manager, { cwd: repoDir, action: "commit" });

      NodeFS.writeFileSync(NodePath.join(repoDir, "CLAUDE.md"), "Mention the Claude provider.\n");
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello again\n");
      yield* runStackedAction(manager, { cwd: repoDir, action: "commit" });

      expect(commitInstructions[0]).toContain("Local AGENTS.md:\nUse imperative subjects.");
      expect(commitInstructions[0]).not.toContain("Local CLAUDE.md:");
      expect(commitInstructions[1]).toContain("Local CLAUDE.md:\nMention the Claude provider.");
    }),
  );

  it.effect("keeps signature output out of recent commit subjects", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      const signingKey = NodePath.join(yield* makeTempDir("ankielcode-git-signing-key-"), "key");
      NodeChildProcess.execFileSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        signingKey,
      ]);
      yield* runGit(repoDir, ["config", "gpg.format", "ssh"]);
      // A global signer such as 1Password's cannot use the fixture's generated key.
      yield* runGit(repoDir, ["config", "gpg.ssh.program", "ssh-keygen"]);
      yield* runGit(repoDir, ["config", "user.signingkey", `${signingKey}.pub`]);
      yield* runGit(repoDir, ["config", "log.showSignature", "true"]);
      yield* runGit(repoDir, ["commit", "--amend", "-S", "--no-edit"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello again\n");
      let commitInstructions: string | undefined;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) => {
            commitInstructions = input.policy?.commitInstructions;
            return Effect.succeed({ subject: "Update readme", body: "" });
          },
        },
      });

      yield* runStackedAction(manager, { cwd: repoDir, action: "commit" });

      expect(commitInstructions).toMatch(
        /Recent commit subjects from this repository:\nInitial commit$/,
      );
    }),
  );

  it.effect("falls back when the dedicated source control writer is unavailable", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nworld\n");
      const missingInstanceId = ProviderInstanceId.make("missing_writer");
      let generatedModelSelection:
        | TextGeneration.CommitMessageGenerationInput["modelSelection"]
        | undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          providerInstances: {
            [missingInstanceId]: {
              driver: ProviderDriverKind.make("missing-driver"),
              config: {},
            },
          },
          sourceControlWriterModelSelection: {
            instanceId: missingInstanceId,
            model: "missing-model",
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedModelSelection = input.modelSelection;
            return Effect.succeed({ subject: "Use the available writer", body: "" });
          },
        },
      });

      yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(generatedModelSelection).toEqual(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
    }),
  );

  it.effect("uses an explicit project's provider settings for generated commit text", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nproject\n");
      const projectId = ProjectId.make("project:git-action-settings");
      const disabledInstanceId = DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId;
      let generatedModelSelection:
        | TextGeneration.CommitMessageGenerationInput["modelSelection"]
        | undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          projectSettingsOverrides: {
            [projectId]: {
              providerInstances: { [disabledInstanceId]: { enabled: false } },
            },
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedModelSelection = input.modelSelection;
            return Effect.succeed({ subject: "Use the project writer", body: "" });
          },
        },
      });

      yield* manager.runStackedAction({
        actionId: "test-project-action-settings",
        cwd: repoDir,
        action: "commit",
        projectId,
      });

      expect(generatedModelSelection?.instanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    }),
  );

  it.effect("prefers a V2-native thread's project settings over an explicit project", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nproject\n");
      const projectId = ProjectId.make("project:git-settings");
      const threadId = ThreadId.make("thread:git-settings");
      const projectModel: ModelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-project-writer",
      };
      const providerInstanceId = ProviderInstanceId.make("codex");
      const createdAt = DateTime.makeUnsafe("2026-09-27T00:00:00.000Z");
      let generatedModelSelection:
        | TextGeneration.CommitMessageGenerationInput["modelSelection"]
        | undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          projectSettingsOverrides: { [projectId]: { textGenerationModelSelection: projectModel } },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedModelSelection = input.modelSelection;
            return Effect.succeed({ subject: "Use the project writer", body: "" });
          },
        },
        seed: Effect.gen(function* () {
          yield* (yield* ProjectStore.ProjectStoreV2).apply({
            sequence: 1,
            eventId: EventId.make("event:git-settings:project"),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: DateTime.formatIso(createdAt),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId,
              title: "Git settings",
              workspaceRoot: "/elsewhere",
              defaultModelSelection: null,
              scripts: [],
              createdAt: DateTime.formatIso(createdAt),
              updatedAt: DateTime.formatIso(createdAt),
            },
          });
          yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
            id: EventId.make("event:git-settings:thread"),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt: createdAt,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId,
              title: "Git settings",
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: repoDir,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
        }),
      });

      yield* manager.runStackedAction({
        actionId: "test-action-id",
        cwd: repoDir,
        action: "commit",
        threadId,
        projectId: ProjectId.make("project:other"),
      });

      expect(generatedModelSelection).toEqual(projectModel);
    }),
  );

  it.effect.each([undefined, ["README.md"]])(
    "a failed generation preserves staging changed while generating (paths: %s)",
    (filePaths) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("ankielcode-git-manager-");
        yield* initRepo(repoDir);
        NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nstaged\n");
        yield* runGit(repoDir, ["add", "README.md"]);
        NodeFS.appendFileSync(NodePath.join(repoDir, "README.md"), "unstaged\n");
        NodeFS.writeFileSync(NodePath.join(repoDir, "untracked.txt"), "untracked\n");
        const indexBefore = NodeFS.readFileSync(NodePath.join(repoDir, ".git/index"));
        const headBefore = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout;
        const gitDriver = yield* GitVcsDriver.GitVcsDriver;
        let indexDuring: Buffer | undefined;
        let indexAfterUserStage: Buffer | undefined;
        const { manager } = yield* makeManager({
          textGeneration: {
            generateCommitMessage: () =>
              Effect.gen(function* () {
                indexDuring = NodeFS.readFileSync(NodePath.join(repoDir, ".git/index"));
                yield* runGit(repoDir, ["add", "untracked.txt"]).pipe(
                  Effect.provideService(GitVcsDriver.GitVcsDriver, gitDriver),
                  Effect.orDie,
                );
                indexAfterUserStage = NodeFS.readFileSync(NodePath.join(repoDir, ".git/index"));
                return yield* new TextGenerationError({
                  operation: "generateCommitMessage",
                  detail: "Provider rejected generation",
                });
              }),
          },
        });
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit",
          ...(filePaths ? { filePaths } : {}),
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(indexDuring).toEqual(indexBefore);
        expect(NodeFS.readFileSync(NodePath.join(repoDir, ".git/index"))).toEqual(
          indexAfterUserStage,
        );
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout).toBe(headBefore);
        expect((yield* runGit(repoDir, ["diff"])).stdout).toContain("+unstaged");
      }),
  );

  it.effect("creates feature branch, commits, and pushes with featureBranch option", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nfeature-branch\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "Implement stacked git actions",
                body: "",
                ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
        featureBranch: true,
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/implement-stacked-git-actions");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("pushed");
      expect(result.toast).toMatchObject({
        description: "Implement stacked git actions",
        cta: { kind: "none" },
      });
      expect(result.toast.title).toMatch(
        /^Pushed [0-9a-f]{7} to origin\/feature\/implement-stacked-git-actions$/,
      );
      expect(
        yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("feature/implement-stacked-git-actions");

      const mainSha = yield* runGit(repoDir, ["rev-parse", "main"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      const mergeBase = yield* runGit(repoDir, ["merge-base", "main", "HEAD"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(mergeBase).toBe(mainSha);
      expect(generatedCount).toBe(1);
    }),
  );

  it.effect.each([
    { branch: "fix/name", existingBranches: ["fix"], expected: "fix-2/name" },
    { branch: "fix/name", existingBranches: ["fix/name/child"], expected: "fix/name-2" },
  ])("commits on $expected when $branch has ref namespace collisions", (scenario) =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      const mainSha = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
      for (const branch of scenario.existingBranches) {
        yield* runGit(repoDir, ["branch", branch]);
      }
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nnamespace-collision\n");

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: () =>
            Effect.succeed({
              subject: "Fix namespace collision",
              body: "",
              branch: scenario.branch,
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
      });

      expect(result.branch).toEqual({ status: "created", name: scenario.expected });
      expect(result.commit.status).toBe("created");
      expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe(
        scenario.expected,
      );
      expect((yield* runGit(repoDir, ["status", "--porcelain"])).stdout.trim()).toBe("");
      for (const branch of ["main", ...scenario.existingBranches]) {
        expect((yield* runGit(repoDir, ["rev-parse", branch])).stdout.trim()).toBe(mainSha);
      }
    }),
  );

  it.effect("pushes existing commits without committing dirty worktree changes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/push-dirty"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "push-dirty.txt"), "push dirty\n");
      yield* runGit(repoDir, ["add", "push-dirty.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Push dirty branch"]);
      NodeFS.mkdirSync(NodePath.join(repoDir, ".vercel"));
      NodeFS.writeFileSync(NodePath.join(repoDir, ".vercel", "project.json"), "{}\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "push",
      });

      expect(result.commit.status).toBe("skipped_not_requested");
      expect(result.push.status).toBe("pushed");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(
        yield* runGit(repoDir, ["status", "--porcelain"]).pipe(
          Effect.map((output) => output.stdout.trim()),
        ),
      ).toContain("?? .vercel/");
      expect(
        yield* runGit(remoteDir, [
          "--git-dir=.",
          "log",
          "-1",
          "--pretty=%s",
          "feature/push-dirty",
        ]).pipe(Effect.map((output) => output.stdout.trim())),
      ).toBe("Push dirty branch");
    }),
  );

  it.effect("finishes a pushed commit when the final status read fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-after-push"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "change.txt"), "change\n");
      const gate = {
        matches: (args: ReadonlyArray<string>) => args[0] === "push",
        reached: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      const events: GitActionProgressEvent[] = [];
      const { manager } = yield* makeManager({ gitSpawnGate: gate });

      const action = yield* Effect.forkChild(
        runStackedAction(
          manager,
          { cwd: repoDir, action: "commit_push", commitMessage: "Status after push" },
          {
            progressReporter: {
              publish: (event) =>
                Effect.sync(() => {
                  events.push(event);
                }),
            },
          },
        ),
      );
      yield* Deferred.await(gate.reached);
      NodeFS.appendFileSync(NodePath.join(repoDir, ".git", "config"), "\n[broken\n");
      yield* Deferred.succeed(gate.release, undefined);
      const result = yield* Fiber.join(action);

      expect(result.push.status).toBe("pushed");
      expect(result.toast.cta).toEqual({ kind: "none" });
      expect(events.at(-1)?.kind).toBe("action_finished");
      expect(
        (yield* runGit(remoteDir, [
          "--git-dir=.",
          "log",
          "-1",
          "--pretty=%s",
          "feature/status-after-push",
        ])).stdout.trim(),
      ).toBe("Status after push");
    }),
  );

  it.effect("hands the branch base to the host when a failed first push is retried", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "HEAD:main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/retried-push", "--track", "origin/main"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "retried.txt"), "retried\n");
      yield* runGit(repoDir, ["add", "retried.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Retried push"]);
      const rejectOnce = NodePath.join(remoteDir, "reject-once");
      NodeFS.writeFileSync(rejectOnce, "");
      NodeFS.writeFileSync(
        NodePath.join(remoteDir, "hooks", "pre-receive"),
        `#!/bin/sh\nif [ -f "${rejectOnce}" ]; then rm "${rejectOnce}"; exit 1; fi\n`,
        { mode: 0o755 },
      );

      const recorded: Array<{ branch: string; baseBranch: string }> = [];
      const { service } = createFakeSourceControlProvider();
      const { manager } = yield* makeManager({
        sourceControlProvider: {
          ...service,
          recordBranchBase: ({ branch, baseBranch }) =>
            Effect.sync(() => {
              recorded.push({ branch, baseBranch });
            }),
        },
      });
      const failed = yield* runStackedAction(manager, { cwd: repoDir, action: "push" }).pipe(
        Effect.flip,
      );
      expect(failed).toBeDefined();
      const result = yield* runStackedAction(manager, { cwd: repoDir, action: "push" });

      expect(result.push.status).toBe("pushed");
      expect(recorded).toEqual([{ branch: "feature/retried-push", baseBranch: "main" }]);
    }),
  );

  it.effect("refuses the pull request actions older clients still send", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      const { manager } = yield* makeManager();
      for (const action of ["create_pr", "commit_push_pr"] as const) {
        const error = yield* manager
          .runStackedAction({ actionId: "retired", cwd: repoDir, action })
          .pipe(Effect.flip);
        expect(error.message).toContain("no longer creates pull requests");
      }
    }),
  );

  it.effect("rejects push actions from detached HEAD", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("ankielcode-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "--detach", "HEAD"]);

      const { manager } = yield* makeManager();
      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );
      expect(errorMessage).toContain("detached HEAD");
    }),
  );
});
