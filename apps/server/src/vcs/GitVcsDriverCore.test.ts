// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@ankielcode/shared/HostProcess";
import { assert, it, describe } from "@effect/vitest";
import { afterAll } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { GitCommandError } from "@ankielcode/contracts";
import { symlinksSupported } from "@ankielcode/shared/testing/symlinks";
import * as ServerConfig from "../config.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "ankiel-git-vcs-driver-test-",
});
const layerTest = GitVcsDriver.layer.pipe(
  Layer.provideMerge(layerServerConfig),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const makeNonRepositoryHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.encodeText(Stream.make("fatal: not a git repository")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeSuccessfulHandle = (stdout: string) =>
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
  });

const makeFailedHandle = (stderr: string) =>
  ChildProcessSpawner.makeHandle({
    ...makeNonRepositoryHandle(),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    stderr: Stream.encodeText(Stream.make(stderr)),
  });

// Releases the lock as soon as a matching git command fails on it, before the driver retries.
const makeDriverReleasingLock = (
  matches: (args: ReadonlyArray<string>) => boolean,
  lockPath: string,
) =>
  Effect.gen(function* () {
    const failures = yield* Ref.make(0);
    const fileSystem = yield* FileSystem.FileSystem;
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const handle = yield* delegate.spawn(command);
        if (!ChildProcess.isStandardCommand(command) || !matches(command.args.map(String)))
          return handle;
        return ChildProcessSpawner.makeHandle({
          ...handle,
          exitCode: handle.exitCode.pipe(
            Effect.tap((exitCode) =>
              exitCode === 0
                ? Effect.void
                : Ref.update(failures, (count) => count + 1).pipe(
                    Effect.andThen(fileSystem.remove(lockPath, { force: true })),
                    Effect.orDie,
                  ),
            ),
          ),
        });
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(layerServerConfig),
    );
    return { driver, failures };
  });

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped({ prefix }));
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    // Git commits whatever already sits in cwd, so only an empty one can take the shared copy.
    const empty =
      !(yield* fileSystem.exists(cwd)) || (yield* fileSystem.readDirectory(cwd)).length === 0;
    if (empty) {
      if (!repoTemplate) {
        const template = yield* fileSystem.makeTempDirectory({
          prefix: "git-vcs-driver-template-",
        });
        yield* commitInitialRepo(template);
        repoTemplate = template;
      }
      yield* fileSystem.copy(repoTemplate, cwd);
    } else {
      yield* commitInitialRepo(cwd);
    }
    const head = yield* fileSystem.readFileString(pathService.join(cwd, ".git", "HEAD"));
    return { initialBranch: head.trim().replace(/^ref: refs\/heads\//, "") };
  });

const commitInitialRepo = (cwd: string, initArgs: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* git(cwd, ["init", ...initArgs]);
    // Newer Git detaches auto-maintenance after commit; its lock file would race the template copy.
    yield* fileSystem.writeFileString(
      pathService.join(cwd, ".git", "config"),
      "[user]\n\temail = test@test.com\n\tname = Test\n[maintenance]\n\tauto = false\n",
      { flag: "a" },
    );
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });

// Most tests start from the same one-commit repository; they copy it instead of spawning git.
let repoTemplate: string | undefined;
afterAll(() => {
  if (repoTemplate) NodeFS.rmSync(repoTemplate, { recursive: true, force: true });
});

describe("pullCurrentBranch", () => {
  const cloneBehindRemote = Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    const updater = yield* makeTmpDir("git-vcs-driver-updater-");
    const { initialBranch } = yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);
    yield* git(cwd, ["remote", "add", "origin", remote]);
    yield* git(cwd, ["push", "-u", "origin", initialBranch]);
    yield* git(updater, ["clone", remote, "."]);
    yield* git(updater, ["config", "user.email", "test@test.com"]);
    yield* git(updater, ["config", "user.name", "Test"]);
    yield* writeTextFile(updater, "remote.txt", "remote\n");
    yield* git(updater, ["add", "remote.txt"]);
    yield* git(updater, ["commit", "-m", "remote commit"]);
    yield* git(updater, ["push", "origin", initialBranch]);
    return {
      cwd,
      remote,
      updater,
      initialBranch,
      remoteHead: yield* git(updater, ["rev-parse", "HEAD"]),
    };
  });

  it.effect("reports an upstream lock after the fallback without removing it", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const { cwd, initialBranch } = yield* cloneBehindRemote;
      const before = yield* git(cwd, ["rev-parse", "HEAD"]);
      const lock = `.git/refs/remotes/origin/${initialBranch}.lock`;
      yield* writeTextFile(cwd, lock, "");

      const error = yield* Effect.flip(driver.pullCurrentBranch(cwd));

      assert.include(error.detail, "could not update a local reference");
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), before);
      assert.isTrue(yield* fs.exists(`${cwd}/${lock}`));
    }).pipe(Effect.provide(layerTest)),
  );
});

it.effect("invalidates a ref snapshot when a mutation fails after changing Git", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const partiallyFailingSpawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            return yield* Effect.die("expected a standard Git command");
          }
          if (command.args[0] === "branch" && command.args.at(-1) === "feature/partial-failure") {
            const handle = yield* delegate.spawn(command);
            yield* handle.exitCode;
            return makeNonRepositoryHandle();
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, partiallyFailingSpawner),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
      yield* driver.listRefs({ cwd, refresh: true });

      yield* driver.createRef({ cwd, refName: "feature/partial-failure" }).pipe(Effect.flip);

      const refs = yield* driver.listRefs({ cwd });
      assert.isTrue(refs.refs.some((ref) => ref.name === "feature/partial-failure"));
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.effect("commits selected files with git that rejects --pathspec-from-file", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Git before 2.25 has no `add --pathspec-from-file` and exits with a usage error.
      const oldGitSpawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) {
          return Effect.die("expected a standard Git command");
        }
        if (command.args.at(-1) === "version") {
          return Effect.succeed(makeSuccessfulHandle("git version 2.24.4\n"));
        }
        if (command.args.some((arg) => String(arg).startsWith("--pathspec-from-file"))) {
          return Effect.succeed(makeFailedHandle("error: unknown option `pathspec-from-file=-'"));
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, oldGitSpawner),
      );
      yield* Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const selected = ["selected[1].txt", "-dash.txt", "with space.txt"];
        for (const file of selected) yield* writeTextFile(cwd, file, "selected\n");
        yield* writeTextFile(cwd, "left.txt", "left\n");

        yield* driver.commit(cwd, "Selected", "", { stage: { filePaths: selected } });

        assert.sameMembers(
          (yield* git(cwd, ["show", "--pretty=", "--name-only", "-z", "HEAD"]))
            .split("\0")
            .filter(Boolean),
          selected,
        );
        assert.equal(yield* git(cwd, ["status", "--porcelain"]), "?? left.txt");
      }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

it.layer(layerTest)("GitVcsDriver core integration", (it) => {
  // regression: #26577 a timed-out git that outlives its timeout holds a process permit
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "kills a timed-out git command that ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const markerPath = pathService.join(yield* makeTmpDir(), "outlived-timeout");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const trapped = yield* Deferred.make<void>();

        const command = yield* driver
          .execute({
            operation: "GitVcsDriver.test.ignoresSigterm",
            cwd,
            args: [
              "-c",
              `alias.hang=!trap '' TERM; echo trapped; sleep 3; touch '${markerPath}'`,
              "hang",
            ],
            progress: {
              onStdoutLine: (line) =>
                line === "trapped" ? Deferred.succeed(trapped, undefined) : Effect.void,
            },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(trapped);
        // The driver's timeout ends a command the same way: by interrupting it.
        yield* Fiber.interrupt(command);

        assert.isFalse(
          yield* fileSystem.exists(markerPath),
          "the timed-out git command kept running until it finished on its own",
        );
      }),
  );
  describe("structured errors", () => {
    it.effect("does not retain git arguments or stderr in command failures", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });

        const secret = "secret-token-value";
        const error = yield* driver
          .execute({
            operation: "GitVcsDriver.test.redactedFailure",
            cwd,
            args: ["status", `--unknown-option=${secret}`],
          })
          .pipe(Effect.flip);

        assert.deepInclude(error, {
          _tag: "GitCommandError",
          operation: "GitVcsDriver.test.redactedFailure",
          command: "git",
          argumentCount: 2,
          cwd,
        });
        assert.isNumber(error.exitCode);
        assert.isAbove(error.stderrLength ?? 0, 0);
        assert.notInclude(error.detail, secret);
        assert.notInclude(error.message, secret);
        assert.notProperty(error, "args");
        assert.notProperty(error, "stderr");
        assert.notProperty(error, "reason");
      }),
    );
  });

  describe("review diff previews", () => {
    it.effect("propagates patch failures instead of reporting an empty complete diff", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "README.md", "changed\n");
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.args.includes("--patch")
            ? Effect.succeed(makeNonRepositoryHandle())
            : delegate.spawn(command),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const result = yield* driver.getReviewDiffPreview({ cwd }).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.equal(result.failure.operation, "GitVcsDriver.getReviewDiffPreview.patch");
        }
        const metadata = yield* driver.getReviewDiffPreview({
          cwd,
          sourceKind: "working-tree",
          metadataOnly: true,
        });
        assert.isTrue(metadata.sources[0]!.patchesDeferred);
        assert.isEmpty(metadata.sources[0]!.diff);
        assert.deepStrictEqual(metadata.sources[0]!.files, [
          {
            path: "README.md",
            previousPath: null,
            changeType: "change",
            additions: 1,
            deletions: 1,
          },
        ]);
      }),
    );

    it.effect("detects an unstaged rename with edits without mutating a split index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        yield* writeTextFile(cwd, "before.ts", "one\ntwo\nthree\nfour\nfive\n");
        yield* git(cwd, ["add", "before.ts"]);
        yield* git(cwd, ["commit", "-m", "add source file"]);
        yield* git(cwd, ["config", "core.splitIndex", "true"]);
        yield* git(cwd, ["config", "splitIndex.sharedIndexExpire", "now"]);
        yield* git(cwd, ["update-index", "--split-index"]);
        const indexPath = yield* git(cwd, ["rev-parse", "--git-path", "index"]);
        const indexHashBefore = yield* git(cwd, ["hash-object", indexPath]);
        const gitDirValue = yield* git(cwd, ["rev-parse", "--git-dir"]);
        const gitDir = pathService.isAbsolute(gitDirValue)
          ? gitDirValue
          : pathService.resolve(cwd, gitDirValue);
        const sharedIndexesBefore = (yield* fileSystem.readDirectory(gitDir))
          .filter((entry) => entry.startsWith("sharedindex."))
          .sort();
        yield* fileSystem.rename(
          pathService.join(cwd, "before.ts"),
          pathService.join(cwd, "after.ts"),
        );
        yield* writeTextFile(cwd, "after.ts", "one\ntwo\nTHREE\nfour\nfive\n");

        const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
        const diff = preview.sources.find((source) => source.kind === "working-tree")?.diff ?? "";
        const indexHashAfter = yield* git(cwd, ["hash-object", indexPath]);
        const sharedIndexesAfter = (yield* fileSystem.readDirectory(gitDir))
          .filter((entry) => entry.startsWith("sharedindex."))
          .sort();

        const source = preview.sources.find((candidate) => candidate.kind === "working-tree")!;
        assert.deepStrictEqual(source.files, [
          {
            path: "after.ts",
            previousPath: "before.ts",
            changeType: "rename-changed",
            additions: 1,
            deletions: 1,
          },
        ]);
        const scoped = yield* driver.getReviewDiffPreview({
          cwd,
          file: { path: "after.ts", previousPath: "before.ts", sourceKind: "working-tree" },
        });
        const scopedSource = scoped.sources.find((candidate) => candidate.kind === "working-tree")!;
        assert.deepStrictEqual(scopedSource.files, source.files);
        assert.equal(scopedSource.diff, diff);
        assert.include(diff, "rename from before.ts");
        assert.include(diff, "rename to after.ts");
        assert.include(diff, "-three");
        assert.include(diff, "+THREE");
        assert.strictEqual(diff.match(/^diff --git /gm)?.length, 1);
        assert.strictEqual(indexHashAfter, indexHashBefore);
        assert.deepStrictEqual(sharedIndexesAfter, sharedIndexesBefore);
      }),
    );

    it.effect.each([
      { stagedCopy: false, expected: ["deleted file mode", "-remove me"] },
      { stagedCopy: true, expected: ["rename from removed.txt", "rename to copy.txt"] },
    ])(
      "preserves a staged deletion when the removed path still exists (staged copy: $stagedCopy)",
      ({ stagedCopy, expected }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* writeTextFile(cwd, "removed.txt", "remove me\n");
          yield* git(cwd, ["add", "removed.txt"]);
          yield* git(cwd, ["commit", "-m", "add removable file"]);
          yield* git(cwd, ["rm", "--cached", "removed.txt"]);
          if (stagedCopy) {
            yield* writeTextFile(cwd, "copy.txt", "remove me\n");
            yield* git(cwd, ["add", "copy.txt"]);
          }

          const preview = yield* driver.getReviewDiffPreview({ cwd, ignoreWhitespace: false });
          const source = preview.sources.find((candidate) => candidate.kind === "working-tree")!;
          const [file] = source.files ?? [];
          const single = yield* driver.getReviewDiffPreview({
            cwd,
            sourceKind: "working-tree",
            file: { path: file!.path, previousPath: file!.previousPath, sourceKind: source.kind },
          });

          for (const diff of [source.diff, single.sources[0]!.diff]) {
            for (const text of expected) assert.include(diff, text);
            assert.notInclude(diff, "new file mode");
          }
        }),
    );
  });

  describe("repository status", () => {
    it.effect("reads Changes totals without rewriting the real index for stat-dirty files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(cwd, "tracked.txt", "same content\n");
        yield* git(cwd, ["add", "tracked.txt"]);
        yield* git(cwd, ["commit", "-m", "add tracked file"]);
        yield* fileSystem.utimes(path.join(cwd, "tracked.txt"), 1_000_000_000, 1_000_000_000);
        const indexPath = path.join(cwd, ".git", "index");
        const originalIndex = yield* fileSystem.readFile(indexPath);

        const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });

        assert.strictEqual(status.branchChanges?.insertions, 0);
        assert.strictEqual(status.branchChanges?.deletions, 0);
        // Writing the index takes index.lock, which makes concurrent user Git writes fail.
        assert.deepStrictEqual(yield* fileSystem.readFile(indexPath), originalIndex);
      }),
    );

    it.effect("commits selected files from a nested project directory", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        // A root basename ending in whitespace catches a root lookup that trims Git's output.
        const cwd = path.join(yield* makeTmpDir(), "repo ");
        yield* (yield* FileSystem.FileSystem).makeDirectory(cwd);
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "nested/tracked.txt", "one\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "add nested file"]);
        yield* writeTextFile(cwd, "nested/tracked.txt", "one\ntwo\n");
        yield* writeTextFile(cwd, "nested/new.txt", "new\n");
        yield* writeTextFile(cwd, "README.md", "# test\nleft out\n");
        const nestedCwd = path.join(cwd, "nested");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const status = yield* driver.statusDetails(nestedCwd);

        assert.deepEqual(status.workingTree.files, [
          { path: "nested/new.txt", insertions: 0, deletions: 0 },
          { path: "nested/tracked.txt", insertions: 1, deletions: 0 },
          { path: "README.md", insertions: 1, deletions: 0 },
        ]);
        // The root is what the paths above are relative to, not the nested cwd, and it keeps
        // the trailing space so the resolved editor target is the file that exists.
        assert.equal(status.workingTree.rootPath, NodeFS.realpathSync.native(cwd));
        assert.equal(
          NodeFS.existsSync(path.join(status.workingTree.rootPath!, "nested", "new.txt")),
          true,
        );
        yield* driver.commit(nestedCwd, "Commit nested selection", "", {
          stage: { filePaths: ["nested/new.txt", "nested/tracked.txt"] },
        });
        assert.equal(yield* git(cwd, ["status", "--porcelain"]), "M README.md");
      }),
    );
  });

  describe("refName operations", () => {
    it.effect.each(["rename", "createWorktree"] as const)(
      "preserves a concurrent creator's branch when %s loses the atomic ref operation",
      (operation) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const expected = yield* git(cwd, [
            "commit-tree",
            "HEAD^{tree}",
            "-m",
            "concurrent winner",
          ]);
          const original = yield* GitVcsDriver.GitVcsDriver;
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          let claimed = false;
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (
                !claimed &&
                ChildProcess.isStandardCommand(command) &&
                command.args[0] === "branch" &&
                command.args.includes(operation === "rename" ? "-m" : "--no-track")
              ) {
                claimed = true;
                yield* original
                  .execute({
                    cwd,
                    operation: "test.concurrentCreator",
                    args: ["update-ref", "refs/heads/topic", expected, ""],
                  })
                  .pipe(Effect.orDie);
              }
              return yield* delegate.spawn(command);
            }),
          );
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(layerServerConfig),
          );
          const result = yield* (
            operation === "rename"
              ? driver
                  .renameBranch({ cwd, oldBranch: initialBranch, newBranch: "topic" })
                  .pipe(Effect.asVoid)
              : driver
                  .createWorktree({
                    cwd,
                    refName: initialBranch,
                    newRefName: "topic",
                    path: NodePath.join(cwd, "checkout"),
                  })
                  .pipe(Effect.asVoid)
          ).pipe(Effect.result);
          assert.isTrue(claimed);
          assert.isTrue(Result.isFailure(result));
          assert.equal(yield* git(cwd, ["rev-parse", "refs/heads/topic"]), expected);
          assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
        }),
    );

    it.effect("rejects a missing branch without restoring a matching dirty file", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* writeTextFile(cwd, "obsolete-branch", "original\n");
        yield* git(cwd, ["add", "obsolete-branch"]);
        yield* git(cwd, ["commit", "-m", "tracked file"]);
        yield* git(cwd, ["branch", "obsolete-branch"]);
        yield* git(cwd, ["branch", "-D", "obsolete-branch"]);
        yield* writeTextFile(cwd, "obsolete-branch", "uncommitted work\n");

        const result = yield* driver
          .switchRef({ cwd, refName: "obsolete-branch" })
          .pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        assert.equal(
          yield* fileSystem.readFileString(path.join(cwd, "obsolete-branch")),
          "uncommitted work\n",
        );
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
      }),
    );
  });

  describe("worktree operations", () => {
    it.effect.each(["current", "legacy"] as const)(
      "preserves another creator's worktree on its new branch at the same path (%s)",
      (version) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const path = NodePath.join(yield* makeTmpDir("git-worktrees-"), "contested");
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const reachedAdd = yield* Deferred.make<void>();
          let paused = false;
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (
                ChildProcess.isStandardCommand(command) &&
                command.args.includes("worktree") &&
                command.args.includes("add")
              ) {
                if (command.args.includes("-h")) {
                  return version === "legacy"
                    ? makeFailedHandle("usage: git worktree add [--lock]")
                    : yield* delegate.spawn(command);
                }
                if (!paused) {
                  paused = true;
                  yield* Deferred.succeed(reachedAdd, undefined);
                  return yield* Effect.never;
                }
              }
              return yield* delegate.spawn(command);
            }),
          );
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(layerServerConfig),
          );
          const creator = yield* driver
            .createWorktree({
              cwd,
              path,
              refName: initialBranch,
              newRefName: "contested",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(reachedAdd);
          yield* git(cwd, ["worktree", "add", "--", path, "contested"]);
          yield* writeTextFile(path, "owned-by-B.txt", "keep this work\n");
          yield* Fiber.interrupt(creator);
          assert.include(yield* git(cwd, ["worktree", "list", "--porcelain"]), path);
          assert.equal(yield* git(path, ["branch", "--show-current"]), "contested");
          assert.equal(
            yield* (yield* FileSystem.FileSystem).readFileString(
              NodePath.join(path, "owned-by-B.txt"),
            ),
            "keep this work\n",
          );
          const created = yield* driver.createWorktree({
            cwd,
            path: `${path}-retry`,
            refName: initialBranch,
            newRefName: "retry",
          });
          assert.equal(yield* git(created.worktree.path, ["branch", "--show-current"]), "retry");
          assert.notInclude(yield* git(cwd, ["worktree", "list", "--porcelain"]), "locked");
        }),
    );

    it.effect.each(["main", "linked"] as const)(
      "removes its worktree and branch when cancelled before the claim (%s)",
      (checkout) =>
        Effect.gen(function* () {
          const repo = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(repo);
          const cwd =
            checkout === "main"
              ? repo
              : NodePath.join(yield* makeTmpDir("git-linked-"), "checkout");
          if (checkout === "linked") {
            yield* git(repo, ["config", "worktree.useRelativePaths", "true"]);
            yield* git(repo, ["worktree", "add", "--detach", cwd]);
          }
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "cancelled ü");
          const hookPath = path.join(repo, ".git/hooks/post-checkout");
          const connected = Promise.withResolvers<void>();
          const sockets = new Set<NodeNet.Socket>();
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              NodeNet.createServer((socket) => {
                sockets.add(socket);
                connected.resolve();
              }),
            ),
            (server) =>
              Effect.sync(() => {
                for (const socket of sockets) socket.destroy();
                server.close();
              }),
          );
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
              }),
          );
          const address = server.address();
          assert.isTrue(address !== null && typeof address !== "string");
          if (address === null || typeof address === "string") return;
          const gate = path.join(cwd, "hook-gate.cjs");
          yield* fs.writeFileString(
            gate,
            `const s = require('node:net').connect(${address.port}, '127.0.0.1'); s.on('connect', () => process.stderr.write('Updating files:  50% (1/1000)\\n')); s.resume();`,
          );
          yield* writeTextFile(
            repo,
            ".git/hooks/post-checkout",
            `#!/bin/sh\nexec "${process.execPath.replaceAll("\\", "/")}" "${gate.replaceAll("\\", "/")}"\n`,
          );
          yield* fs.chmod(hookPath, 0o755);
          const hookStarted = yield* Deferred.make<void>();
          let claims = 0;
          const input = {
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "ankiel/cancel",
          };
          const worktrees = git(cwd, ["worktree", "list", "--porcelain"]);

          const cancelled = yield* driver
            .createWorktree(input, {
              progress: {
                onCheckoutProgress: ({ total }) =>
                  total === 1000 ? Deferred.succeed(hookStarted, undefined) : Effect.void,
                onWorktreeClaimed: () => Effect.sync(() => void claims++),
              },
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(hookStarted);
          yield* Effect.promise(() => connected.promise);
          assert.include(yield* worktrees, worktreePath);
          yield* Fiber.interrupt(cancelled);

          assert.equal(claims, 0);
          assert.notInclude(yield* worktrees, worktreePath);
          assert.equal(yield* git(cwd, ["branch", "--list", "ankiel/cancel"]), "");
          assert.isFalse(yield* fs.exists(worktreePath));

          // A retry gets the same path and branch, and a claimed worktree outlives a later cancel.
          yield* fs.remove(hookPath);
          const claimed = yield* Deferred.make<void>();
          const retry = yield* driver
            .createWorktree(input, {
              progress: { onWorktreeClaimed: () => Deferred.succeed(claimed, undefined) },
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(claimed);
          yield* Fiber.interrupt(retry);
          assert.include(yield* worktrees, worktreePath);
          assert.notInclude(yield* worktrees, "locked");
          assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "ankiel/cancel");
        }),
    );

    // regression: #28354 a failed worktree add left its new branch behind and blocked retries
    it.effect("removes the new branch when the worktree cannot be added", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        const occupiedPath = yield* makeTmpDir("git-worktrees-");
        yield* writeTextFile(occupiedPath, "existing.txt", "occupied\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const failed = yield* driver
          .createWorktree({
            cwd,
            path: occupiedPath,
            refName: initialBranch,
            newRefName: "ankiel/collide",
          })
          .pipe(Effect.result);

        assert.isTrue(Result.isFailure(failed));
        assert.equal(yield* git(cwd, ["branch", "--list", "ankiel/collide"]), "");
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "retry");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "ankiel/collide",
        });
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "ankiel/collide");
      }),
    );

    it.effect.each([false, true])(
      "cleans up links left by successful worktree removal, preserving ordinary files: %s",
      (keepFile) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const fileSystem = yield* FileSystem.FileSystem;
          const pathService = yield* Path.Path;
          const outside = yield* makeTmpDir("git-worktree-link-target-");
          yield* writeTextFile(outside, "keep.txt", "external target\n");
          const worktreePath = pathService.join(cwd, "leftover");
          const nested = pathService.join(worktreePath, "node_modules");
          yield* fileSystem.makeDirectory(nested, { recursive: true });
          yield* fileSystem.makeDirectory(pathService.join(worktreePath, "empty"));
          NodeFS.symlinkSync(outside, pathService.join(worktreePath, "linked"), "junction");
          NodeFS.symlinkSync(outside, pathService.join(nested, "pkg"), "junction");
          if (keepFile) {
            yield* writeTextFile(worktreePath, "notes/draft.txt", "new work\n");
          }

          // Git removes symlinks on Unix; simulate its successful Windows removal
          // leaving junctions behind so the cleanup is exercised on every platform.
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const spawner = ChildProcessSpawner.make((command) =>
            ChildProcess.isStandardCommand(command) &&
            command.args.join(" ").includes("worktree remove")
              ? Effect.succeed(makeSuccessfulHandle(""))
              : delegate.spawn(command),
          );
          const driver = yield* makeGitVcsDriverCore().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(layerServerConfig),
          );

          yield* driver.removeWorktree({ cwd, path: worktreePath });

          assert.equal(
            yield* fileSystem.readFileString(pathService.join(outside, "keep.txt")),
            "external target\n",
          );
          if (keepFile) {
            assert.deepEqual(yield* fileSystem.readDirectory(worktreePath), ["notes"]);
            assert.equal(
              yield* fileSystem.readFileString(pathService.join(worktreePath, "notes/draft.txt")),
              "new work\n",
            );
          } else {
            assert.equal(yield* fileSystem.exists(worktreePath), false);
          }
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "removes a worktree whose .git file git-annex replaced with a symlink, keeping the symlink when refused",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const pathService = yield* Path.Path;
          const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "annexed");
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* driver.createWorktree({
            cwd,
            path: worktreePath,
            refName: initialBranch,
            newRefName: "feature/annexed",
          });
          const gitFile = pathService.join(worktreePath, ".git");
          const adminDir = (yield* git(worktreePath, ["rev-parse", "--absolute-git-dir"])).trim();
          NodeFS.rmSync(gitFile);
          NodeFS.symlinkSync(adminDir, gitFile);
          yield* writeTextFile(worktreePath, "notes.txt", "draft\n");

          const refused = yield* Effect.result(driver.removeWorktree({ cwd, path: worktreePath }));

          assert.isTrue(Result.isFailure(refused));
          assert.isTrue(NodeFS.lstatSync(gitFile).isSymbolicLink());
          assert.equal(NodeFS.realpathSync(gitFile), NodeFS.realpathSync(adminDir));
          NodeFS.rmSync(pathService.join(worktreePath, "notes.txt"));

          yield* driver.removeWorktree({ cwd, path: worktreePath });

          assert.isFalse(NodeFS.existsSync(worktreePath));
          assert.isFalse(NodeFS.existsSync(adminDir));
        }),
    );

    it.effect("leaves a folder alone that only shares the worktree's short name", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "short");
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/short",
        });
        // Unrelated to the worktree, but resolving "short" against cwd lands here.
        const outside = yield* makeTmpDir("git-worktree-link-target-");
        const unrelated = pathService.join(cwd, "short");
        NodeFS.mkdirSync(unrelated);
        NodeFS.symlinkSync(outside, pathService.join(unrelated, "linked"), "junction");

        yield* Effect.result(driver.removeWorktree({ cwd, path: "short" }));

        assert.isTrue(NodeFS.lstatSync(pathService.join(unrelated, "linked")).isSymbolicLink());
        assert.equal(yield* fileSystem.exists(worktreePath), true);
      }),
    );

    it.effect("force-removes a worktree without deleting what its junctions point to", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitignore", "node_modules\n");
        yield* git(cwd, ["add", ".gitignore"]);
        yield* git(cwd, ["commit", "-m", "ignore node_modules"]);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const outside = yield* makeTmpDir("git-worktree-link-target-");
        yield* writeTextFile(outside, "keep.txt", "keep\n");
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "linked");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/linked",
        });
        // Junctions on Windows, the way pnpm links packages; symlinks elsewhere.
        NodeFS.mkdirSync(pathService.join(worktreePath, "node_modules"));
        NodeFS.symlinkSync(
          outside,
          pathService.join(worktreePath, "node_modules", "dep"),
          "junction",
        );
        NodeFS.symlinkSync(outside, pathService.join(worktreePath, "shared"), "junction");

        yield* driver.removeWorktree({ cwd, path: worktreePath, force: true });

        assert.deepEqual(NodeFS.readdirSync(pathService.dirname(worktreePath)), []);
        assert.equal(
          yield* fileSystem.readFileString(pathService.join(outside, "keep.txt")),
          "keep\n",
        );
      }),
    );

    it.effect("keeps the junctions of a worktree that git refuses to remove", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, ".gitignore", "node_modules\n");
        yield* git(cwd, ["add", ".gitignore"]);
        yield* git(cwd, ["commit", "-m", "ignore node_modules"]);
        const pathService = yield* Path.Path;
        const outside = yield* makeTmpDir("git-worktree-link-target-");
        const worktreePath = pathService.join(yield* makeTmpDir("git-worktrees-"), "linked");
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/linked",
        });
        const link = pathService.join(worktreePath, "node_modules");
        NodeFS.symlinkSync(outside, link, "junction");
        yield* writeTextFile(worktreePath, "notes.txt", "draft\n");

        const result = yield* Effect.result(driver.removeWorktree({ cwd, path: worktreePath }));

        assert.isTrue(Result.isFailure(result));
        assert.isTrue(NodeFS.lstatSync(link).isSymbolicLink());
        assert.deepEqual(NodeFS.readdirSync(pathService.dirname(worktreePath)), ["linked"]);
      }),
    );
  });

  describe("commit context", () => {
    it.effect("leaves no objects behind when no commit follows, in a linked worktree too", () =>
      Effect.gen(function* () {
        const repo = yield* makeTmpDir();
        yield* initRepoWithCommit(repo);
        const linked = `${repo}/linked`;
        yield* git(repo, ["worktree", "add", "--quiet", linked]);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        for (const cwd of [repo, linked]) {
          yield* writeTextFile(cwd, "README.md", `changed in ${cwd}\n`);
          yield* writeTextFile(cwd, "draft.txt", `drafted in ${cwd}\n`);
          const blobs = [
            yield* git(cwd, ["hash-object", "draft.txt"]),
            yield* git(cwd, ["hash-object", "README.md"]),
          ];
          const context = yield* driver.prepareCommitContext(cwd);
          assert.include(context?.stagedPatch ?? "", `+drafted in ${cwd}`);
          assert.include(context?.stagedPatch ?? "", "-# test");
          for (const blob of blobs) {
            const probe = yield* driver.execute({
              operation: "GitVcsDriver.test.git",
              cwd,
              args: ["cat-file", "-e", blob],
              allowNonZeroExit: true,
              timeoutMs: 10_000,
            });
            assert.notEqual(probe.exitCode, 0, `${blob} stayed in the repository`);
          }
        }
      }),
    );

    it.effect("can omit the patch while preserving change detection and the real index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        assert.isNull(yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false }));
        yield* writeTextFile(cwd, "selected.txt", "selected content\n");
        yield* writeTextFile(cwd, "other.txt", "other content\n");
        yield* git(cwd, ["add", "other.txt"]);
        const before = yield* git(cwd, ["diff", "--cached"]);
        const summaryOnly = yield* driver.prepareCommitContext(cwd, ["selected.txt"], {
          includePatch: false,
        });
        assert.include(summaryOnly?.stagedSummary ?? "", "selected.txt");
        assert.notInclude(summaryOnly?.stagedSummary ?? "", "other.txt");
        assert.equal(summaryOnly?.stagedPatch, "");
        const full = yield* driver.prepareCommitContext(cwd, ["selected.txt"]);
        assert.equal(full?.stagedSummary, summaryOnly?.stagedSummary);
        assert.include(full?.stagedPatch ?? "", "+selected content");
        assert.equal(yield* git(cwd, ["diff", "--cached"]), before);
      }),
    );

    it.effect.each(["root", "aliased-nested"] as const)(
      "prepares selected files without staging and commits only those files from %s",
      (location) =>
        Effect.gen(function* () {
          const sandbox = yield* makeTmpDir();
          const path = yield* Path.Path;
          const fileSystem = yield* FileSystem.FileSystem;
          const repository = path.join(sandbox, "repo");
          const nested = path.join(repository, "sub", "dir");
          yield* fileSystem.makeDirectory(nested, { recursive: true });
          yield* initRepoWithCommit(repository);
          const cwd = location === "aliased-nested" ? path.join(sandbox, "link") : repository;
          if (location === "aliased-nested") NodeFS.symlinkSync(nested, cwd, "junction");
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const selected = "sub/dir/a.txt";
          yield* writeTextFile(repository, selected, "a\n");
          yield* writeTextFile(repository, "b.txt", "b\n");

          const context = yield* driver.prepareCommitContext(cwd, [selected]);
          assert.include(context?.stagedSummary ?? "", "a.txt");
          assert.notInclude(context?.stagedSummary ?? "", "b.txt");
          assert.equal(yield* git(repository, ["diff", "--cached", "--name-only"]), "");

          // A selected file staged and then reverted stages to nothing, like git commit --only.
          const head = yield* git(repository, ["rev-parse", "HEAD"]);
          yield* writeTextFile(repository, "README.md", "staged\n");
          yield* git(repository, ["add", "README.md"]);
          yield* git(repository, ["restore", "--source=HEAD", "--worktree", "--", "README.md"]);
          const empty = yield* driver
            .commit(cwd, "Empty", "", { stage: { filePaths: ["README.md"] } })
            .pipe(Effect.flip);
          assert.equal(empty._tag, "GitNothingToCommitError");
          assert.equal(yield* git(repository, ["rev-parse", "HEAD"]), head);

          const commit = yield* driver.commit(cwd, "Add a", "", {
            stage: { filePaths: [selected] },
          });
          assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
          assert.equal(yield* git(repository, ["log", "-1", "--pretty=%s"]), "Add a");
          assert.equal(
            yield* git(repository, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]),
            selected,
          );
          const status = yield* git(repository, ["status", "--porcelain"]);
          assert.include(status, "?? b.txt");
          assert.notInclude(status, "a.txt");
        }),
    );

    it.effect("stops a selected-file commit when another process holds the index lock", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "staged.txt", "staged\n");
        yield* git(cwd, ["add", "staged.txt"]);
        const lockPath = (yield* Path.Path).join(cwd, ".git", "index.lock");
        yield* (yield* FileSystem.FileSystem).writeFileString(lockPath, "");
        const { driver } = yield* makeDriverReleasingLock(
          (args) => args.includes("reset"),
          lockPath,
        );

        const error = yield* driver
          .commit(cwd, "Add a", "", { stage: { filePaths: ["a.txt"] } })
          .pipe(Effect.flip);

        assert.equal(error.operation, "GitVcsDriver.commit.reset");
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), head);
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "staged.txt");
      }),
    );

    it.effect.each([
      { location: "root", conflict: false, encoding: "utf8" },
      { location: "nested", conflict: false, encoding: "utf8" },
      { location: "worktree", conflict: false, encoding: "utf8" },
      { location: "root", conflict: true, encoding: "utf8" },
      { location: "nested", conflict: true, encoding: "utf8" },
      { location: "worktree", conflict: true, encoding: "utf8" },
      { location: "root", conflict: true, encoding: "utf16le" },
      { location: "root", conflict: true, encoding: "utf16le", large: true },
    ])(
      "rejects selected-file merge commits without mutation ($location, conflict: $conflict, $encoding)",
      ({ location, conflict, encoding, large }) =>
        Effect.gen(function* () {
          let cwd = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          const writeReadme = (text: string) =>
            Effect.sync(() =>
              NodeFS.writeFileSync(
                NodePath.join(cwd, "README.md"),
                encoding === "utf16le" ? Buffer.from(`\ufeff${text}`, "utf16le") : text,
              ),
            );
          if (encoding === "utf16le") {
            yield* writeTextFile(
              cwd,
              ".gitattributes",
              "README.md text working-tree-encoding=UTF-16\n",
            );
            yield* writeReadme("base\n");
            yield* git(cwd, ["add", "."]);
            yield* git(cwd, ["commit", "-m", "Declare UTF-16 encoding"]);
          }
          const driver = yield* GitVcsDriver.GitVcsDriver;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* git(cwd, ["checkout", "-b", "feature"]);
          yield* writeTextFile(cwd, "feature.txt", "feature\n");
          if (conflict) yield* writeReadme("feature version\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "Feature"]);
          const featureHead = yield* git(cwd, ["rev-parse", "HEAD"]);
          yield* git(cwd, ["checkout", initialBranch]);
          yield* writeTextFile(cwd, "main.txt", "main\n");
          if (conflict) yield* writeReadme("main version\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "Main"]);
          const mainHead = yield* git(cwd, ["rev-parse", "HEAD"]);
          if (location === "worktree") {
            const worktree = path.join(yield* makeTmpDir(), "linked");
            yield* git(cwd, ["worktree", "add", "-b", "linked", worktree]);
            cwd = worktree;
          }
          const merge = yield* driver.execute({
            operation: "test.merge",
            cwd,
            args: ["merge", "--no-commit", "--no-ff", "feature"],
            allowNonZeroExit: true,
          });
          assert.equal(merge.exitCode, conflict ? 1 : 0);
          yield* writeTextFile(cwd, "unrelated.txt", "unrelated\n");
          const commitCwd = location === "nested" ? path.join(cwd, "nested") : cwd;
          yield* fs.makeDirectory(commitCwd, { recursive: true });
          const gitDir = yield* git(cwd, ["rev-parse", "--absolute-git-dir"]);
          const names = ["index", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "ORIG_HEAD"];
          const before = names.map((name) => NodeFS.readFileSync(path.join(gitDir, name)));
          const files = ["README.md", "feature.txt", "main.txt", "unrelated.txt"];
          const contents = files.map((name) => NodeFS.readFileSync(path.join(cwd, name)));
          const unmerged = yield* git(cwd, ["ls-files", "--unmerged"]);

          const result = yield* driver
            .commit(commitCwd, "Partial merge", "", { stage: { filePaths: ["feature.txt"] } })
            .pipe(Effect.result);
          if (Result.isSuccess(result)) {
            const parents = yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]);
            assert.fail(
              `Selected merge commit succeeded with parents ${parents}; MERGE_HEAD exists: ${NodeFS.existsSync(path.join(gitDir, "MERGE_HEAD"))}`,
            );
          } else {
            assert.include(result.failure.detail, "Cannot commit selected files during a merge");
            assert.include(result.failure.detail, "Commit all files");
          }
          assert.deepEqual(
            names.map((name) => NodeFS.readFileSync(path.join(gitDir, name))),
            before,
          );
          assert.deepEqual(
            files.map((name) => NodeFS.readFileSync(path.join(cwd, name))),
            contents,
          );
          assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), mainHead);
          assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);

          const resolvedText = `Heading\n=======\n\nresolved${large ? "x".repeat(17 * 1024 * 1024) : ""}\n`;
          if (conflict) {
            const unresolved = yield* driver
              .commit(commitCwd, "Unresolved merge", "", { stage: {} })
              .pipe(Effect.result);
            assert.isTrue(Result.isFailure(unresolved), "committed an unresolved conflict");
            assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), mainHead);
            assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);
            // A lone "=======" is a heading underline, not a conflict boundary.
            yield* writeReadme(resolvedText);
            assert.isNotNull(
              yield* driver.prepareCommitContext(commitCwd, undefined, { includePatch: false }),
            );
          }
          yield* driver.commit(commitCwd, "Finish merge", "", { stage: {} });
          assert.equal(
            yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]),
            `${mainHead} ${featureHead}`,
          );
          assert.isFalse(NodeFS.existsSync(path.join(gitDir, "MERGE_HEAD")));
          assert.equal(yield* git(cwd, ["show", "HEAD:feature.txt"]), "feature");
          assert.equal(yield* git(cwd, ["show", "HEAD:unrelated.txt"]), "unrelated");
          if (large) {
            assert.equal(
              yield* git(cwd, ["cat-file", "-s", "HEAD:README.md"]),
              String(Buffer.byteLength(resolvedText)),
            );
          } else if (conflict)
            assert.equal(
              yield* git(cwd, ["show", "HEAD:README.md"]),
              "Heading\n=======\n\nresolved",
            );
        }),
    );

    it.effect("treats selected file paths literally", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "selected[1].txt", "literal\n");
        yield* writeTextFile(cwd, "selected1.txt", "pattern match\n");

        const context = yield* driver.prepareCommitContext(cwd, ["selected[1].txt"]);

        assert.include(context?.stagedSummary ?? "", "selected[1].txt");
        assert.notInclude(context?.stagedSummary ?? "", "selected1.txt");
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "");
        yield* driver.commit(cwd, "Add literal path", "", {
          stage: { filePaths: ["selected[1].txt"] },
        });
        assert.equal(
          yield* git(cwd, ["show", "--pretty=", "--name-only", "HEAD"]),
          "selected[1].txt",
        );

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? selected1.txt");
      }),
    );

    it.effect("keeps other files conflicted through a selected-file commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        // git stash pop leaves README.md conflicted with no merge in progress.
        yield* writeTextFile(cwd, "README.md", "stashed version\n");
        yield* git(cwd, ["stash"]);
        yield* writeTextFile(cwd, "README.md", "committed version\n");
        yield* writeTextFile(cwd, "same.txt", "same\n");
        yield* writeTextFile(cwd, "gone.txt", "gone\n");
        yield* git(cwd, ["add", "same.txt", "gone.txt"]);
        yield* git(cwd, ["commit", "-am", "Change README"]);
        const pop = yield* driver.execute({
          operation: "test.stashPop",
          cwd,
          args: ["stash", "pop"],
          allowNonZeroExit: true,
        });
        assert.equal(pop.exitCode, 1);
        const unmerged = yield* git(cwd, ["ls-files", "--unmerged"]);

        // A selected file staged and then reverted has nothing to commit despite the conflict.
        const unchangedHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(cwd, "same.txt", "staged\n");
        yield* git(cwd, ["add", "same.txt"]);
        yield* git(cwd, ["restore", "--source=HEAD", "--worktree", "--", "same.txt"]);
        const empty = yield* driver
          .commit(cwd, "Empty", "", { stage: { filePaths: ["same.txt"] } })
          .pipe(Effect.flip);
        assert.equal(empty._tag, "GitNothingToCommitError");
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), unchangedHead);
        assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);

        yield* (yield* FileSystem.FileSystem).remove((yield* Path.Path).join(cwd, "gone.txt"));
        yield* driver.commit(cwd, "Remove gone", "", { stage: { filePaths: ["gone.txt"] } });
        assert.equal(
          yield* git(cwd, ["show", "--pretty=", "--name-status", "HEAD"]),
          "D\tgone.txt",
        );

        yield* writeTextFile(cwd, "other.txt", "other\n");
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const nested = path.join(cwd, "nested");
        yield* fs.makeDirectory(nested);
        // A formatting hook stages its edit into the temporary index that --only commits from.
        yield* writeTextFile(
          cwd,
          ".git/hooks/pre-commit",
          "#!/bin/sh\necho formatted >> other.txt\ngit add other.txt\n",
        );
        yield* fs.chmod(path.join(cwd, ".git/hooks/pre-commit"), 0o755);

        yield* driver.commit(cwd, "Add other", "", { stage: { filePaths: ["other.txt"] } });

        assert.equal(yield* git(cwd, ["rev-parse", "HEAD~1"]), head);
        assert.equal(yield* git(cwd, ["show", "--pretty=", "--name-only", "HEAD"]), "other.txt");
        assert.equal(yield* git(cwd, ["show", "HEAD:other.txt"]), "other\nformatted");
        assert.equal(yield* git(cwd, ["show", ":other.txt"]), "other\nformatted");
        assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);
        const all = yield* driver.prepareCommitContext(nested).pipe(Effect.flip);
        assert.equal(
          all.detail,
          "Cannot commit with unresolved merge conflicts in README.md. Resolve them, then commit.",
        );
      }),
    );

    it.effect.each([false, true])(
      "preserves partial staging and split-index files (split: %s)",
      (split) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          if (split) yield* git(cwd, ["config", "core.splitIndex", "true"]);
          yield* writeTextFile(cwd, "README.md", "# test\nstaged\n");
          yield* git(cwd, ["add", "README.md"]);
          yield* writeTextFile(cwd, "README.md", "# test\nstaged\nunstaged\n");
          yield* writeTextFile(cwd, "untracked.txt", "untracked\n");
          yield* writeTextFile(cwd, ".gitignore", "ignored.txt\n");
          yield* writeTextFile(cwd, "ignored.txt", "ignored\n");
          const before = NodeFS.readFileSync(`${cwd}/.git/index`);
          const shared = NodeFS.readdirSync(`${cwd}/.git`).filter((name) =>
            name.startsWith("sharedindex."),
          );
          const driver = yield* GitVcsDriver.GitVcsDriver;
          for (const paths of [undefined, ["README.md"]]) {
            const context = yield* driver.prepareCommitContext(cwd, paths);
            assert.include(context?.stagedPatch ?? "", "unstaged");
            assert.notInclude(context?.stagedSummary ?? "", "ignored.txt");
            assert.deepEqual(NodeFS.readFileSync(`${cwd}/.git/index`), before);
            assert.deepEqual(
              NodeFS.readdirSync(`${cwd}/.git`).filter((name) => name.startsWith("sharedindex.")),
              shared,
            );
          }
        }),
    );

    it.effect("preserves merge metadata while preparing selected and all files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["checkout", "-b", "feature"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Feature"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* git(cwd, ["merge", "--no-commit", "--no-ff", "feature"]);
        yield* writeTextFile(cwd, "README.md", "# test\nmerge edit\n");
        const names = ["index", "MERGE_HEAD", "MERGE_MSG", "ORIG_HEAD"];
        const before = names.map((name) => NodeFS.readFileSync(`${cwd}/.git/${name}`));
        const driver = yield* GitVcsDriver.GitVcsDriver;
        for (const paths of [undefined, ["README.md"]]) {
          yield* driver.prepareCommitContext(cwd, paths);
          assert.deepEqual(
            names.map((name) => NodeFS.readFileSync(`${cwd}/.git/${name}`)),
            before,
          );
        }
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("fails instead of falling back when the worktree base remote is unreachable", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(cwd, ["remote", "add", "origin", `${cwd}/missing.git`]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const error = yield* driver
          .fetchWorktreeBaseCommit({ cwd, refName: initialBranch })
          .pipe(Effect.flip);
        assert.equal(error._tag, "GitCommandError");
      }),
    );

    it.effect.each([false, true])(
      "pushes with upstream setup and skips when already up to date (autoSetupMerge=%s)",
      (autoSetupMerge) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir("git-remote-");
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          if (autoSetupMerge) {
            yield* git(cwd, ["config", "branch.autoSetupMerge", "always"]);
          }
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
            cwd,
            refName: "feature/push",
          });
          yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
            cwd,
            refName: "feature/push",
          });
          yield* writeTextFile(cwd, "feature.txt", "feature\n");
          yield* git(cwd, ["add", "-A"]);
          yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

          const driver = yield* GitVcsDriver.GitVcsDriver;
          if (autoSetupMerge) {
            assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/push.remote"), ".");
            assert.equal(
              yield* driver.readConfigValue(cwd, "branch.feature/push.merge"),
              `refs/heads/${initialBranch}`,
            );
          }

          const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
          assert.deepInclude(pushed, {
            status: "pushed",
            branch: "feature/push",
            setUpstream: true,
          });
          assert.equal(
            yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
            "origin/feature/push",
          );

          if (autoSetupMerge) {
            assert.equal(
              yield* driver.readConfigValue(cwd, "branch.feature/push.ankiel-merge-base"),
              initialBranch,
            );
            assert.equal(
              yield* driver.readConfigValue(cwd, "branch.feature/push.ankiel-merge-base-ref"),
              `refs/heads/${initialBranch}`,
            );
          }

          const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
          assert.deepInclude(skipped, {
            status: "skipped_up_to_date",
            branch: "feature/push",
          });
        }),
    );

    it.effect("pushes to the requested remote instead of the primary remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const originRemote = yield* makeTmpDir("git-origin-remote-");
        const publishRemote = yield* makeTmpDir("git-publish-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(originRemote, ["init", "--bare"]);
        yield* git(publishRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", originRemote]);
        yield* git(cwd, ["remote", "add", "origin-1", publishRemote]);

        const pushed = yield* driver.pushCurrentBranch(cwd, null, { remoteName: "origin-1" });

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "main",
          upstreamBranch: "origin-1/main",
          setUpstream: true,
        });
        assert.equal(
          yield* git(publishRemote, ["--git-dir=.", "log", "-1", "--pretty=%s", "main"]),
          "initial commit",
        );
        const originMain = yield* driver.execute({
          operation: "GitVcsDriver.test.originMainMissing",
          cwd: originRemote,
          args: ["--git-dir=.", "show-ref", "--verify", "--quiet", "refs/heads/main"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        assert.notEqual(originMain.exitCode, 0);
      }),
    );
  });
});
