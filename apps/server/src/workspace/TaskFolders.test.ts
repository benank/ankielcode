import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type ProjectTrackedFolder } from "@ankielcode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as TaskFolders from "./TaskFolders.ts";
import * as TaskFolderStore from "./TaskFolderStore.ts";
import {
  layerTaskFoldersWithGit,
  taskFoldersTestProjectId as projectId,
  type TaskFoldersTestState,
} from "./TaskFolders.testkit.ts";

const layerFor = (state: TaskFoldersTestState) =>
  layerTaskFoldersWithGit(state).pipe(
    Layer.provideMerge(
      GitVcsDriver.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-task-folders-" }),
        ),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const tmp = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "ankiel-task-folders-" }),
  );
  const run = (cwd: string, ...args: ReadonlyArray<string>) =>
    git
      .execute({ operation: "task-folders-test", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const repository = Effect.fnUntraced(function* (relative: string) {
    const folder = path.join(tmp, relative);
    yield* fileSystem.makeDirectory(folder, { recursive: true });
    yield* run(folder, "init", "-b", "main");
    yield* run(folder, "config", "user.email", "task-folders@example.test");
    yield* run(folder, "config", "user.name", "Task folders");
    yield* fileSystem.writeFileString(path.join(folder, "README.md"), `${relative}\n`);
    yield* run(folder, "add", ".");
    yield* run(folder, "commit", "-m", "initial");
    return folder;
  });
  const isLink = (target: string) =>
    fileSystem.readLink(target).pipe(Effect.option, Effect.map(Option.isSome));
  const worktreeCount = (folder: string) =>
    run(folder, "worktree", "list", "--porcelain").pipe(
      Effect.map((listed) => listed.split("\n").filter((line) => line.startsWith("worktree "))),
      Effect.map((worktrees) => worktrees.length),
    );
  return { fileSystem, path, tmp, run, repository, isLink, worktreeCount };
});

const tracked = (...folders: ReadonlyArray<string>): ReadonlyArray<ProjectTrackedFolder> =>
  folders.map((folder) => ({ path: folder, name: folder.split(/[\\/]/).at(-1)! }));

const create = Effect.fnUntraced(function* (
  branch: string,
  repositories?: ReadonlyArray<{ readonly path: string }>,
  baseBranch?: string,
) {
  const taskFolders = yield* TaskFolders.TaskFolders;
  const plan = yield* taskFolders.plan({ projectId, repositories });
  assert.isNotNull(plan);
  return yield* taskFolders.create({
    plan: plan!,
    branch,
    projectStart: { refName: "main", baseRefName: "main" },
    baseBranch,
    startFromOrigin: false,
    projectCommands: true,
  });
});

const withState = <A, E>(
  test: (
    state: TaskFoldersTestState,
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerFor>> | Scope.Scope>,
) => {
  const state: TaskFoldersTestState = { workspaceRoot: "/unset", trackedFolders: [], thread: null };
  return test(state).pipe(Effect.provide(layerFor(state)), Effect.scoped);
};

it.live.each([{ projectIsRepository: true }, { projectIsRepository: false }])(
  "answers an existing thread's worktree request with a task folder, project is a repository=$projectIsRepository",
  ({ projectIsRepository }) =>
    withState((state) =>
      Effect.gen(function* () {
        const { path, tmp, run, repository } = yield* fixture;
        const shop = projectIsRepository ? yield* repository("shop") : path.join(tmp, "shop");
        const api = yield* repository("shop/api");
        const web = yield* repository("web");
        state.workspaceRoot = shop;
        state.trackedFolders = tracked(api, web);
        const taskFolders = yield* TaskFolders.TaskFolders;
        const request = { cwd: shop, refName: "main", newRefName: "feature", path: null };

        const created = yield* taskFolders.createForProjectFolder(request, {
          projectCommands: true,
        });

        const taskFolder = yield* taskFolders.find(created!.worktree.path);
        assert.deepEqual(created, {
          worktree: { path: taskFolder!.projectPath, refName: "feature" },
        });
        assert.equal(taskFolder!.projectIsWorktree, projectIsRepository);
        assert.sameMembers(
          taskFolder!.repositories.map((entry) => entry.repositoryPath),
          [api, web],
        );
        for (const worktree of [
          ...(projectIsRepository ? [taskFolder!.projectPath] : []),
          ...taskFolder!.repositories.map((entry) => entry.worktreePath),
        ]) {
          assert.equal(yield* run(worktree, "symbolic-ref", "--short", "HEAD"), "feature");
        }
        // A chosen path, an existing branch and a folder that is no project stay single worktrees.
        for (const single of [
          { ...request, path: path.join(tmp, "elsewhere") },
          { cwd: shop, refName: "main", path: null },
          { ...request, cwd: web },
        ]) {
          assert.isNull(
            yield* taskFolders.createForProjectFolder(single, { projectCommands: true }),
          );
        }
      }),
    ),
);

it.live("leaves a project's layout commands out for a request that may not run them", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository, worktreeCount } = yield* fixture;
      const shop = path.join(tmp, "shop");
      const api = yield* repository("shop/api");
      const ran = path.join(tmp, "ran");
      yield* fileSystem.writeFileString(
        path.join(shop, "ankiel.json"),
        JSON.stringify({
          worktreeLayout: {
            create: `echo create >> "${ran}" && mkdir -p "$ANKIEL_WORKTREE_PROJECT_PATH" && git -C "$ANKIEL_PROJECT_ROOT/api" worktree add -q -b "$ANKIEL_WORKTREE_BRANCH" "$ANKIEL_WORKTREE_PROJECT_PATH/api"`,
            remove: `echo remove >> "${ran}"`,
          },
        }),
      );
      state.workspaceRoot = shop;
      state.trackedFolders = tracked(api);
      const taskFolders = yield* TaskFolders.TaskFolders;

      const refused = yield* taskFolders
        .createForProjectFolder(
          { cwd: shop, refName: "main", newRefName: "feature", path: null },
          { projectCommands: false },
        )
        .pipe(Effect.flip);
      assert.include(refused.detail, "not permitted to run");
      assert.isFalse(yield* fileSystem.exists(ran));
      assert.equal(yield* worktreeCount(api), 1);
      assert.equal(yield* run(api, "branch", "--list", "feature"), "");

      const { taskFolder } = yield* create("feature");
      assert.equal(yield* fileSystem.readFileString(ran), "create\n");
      // A missing checkout comes back plain, and the folder goes without the project's teardown.
      yield* fileSystem.remove(path.join(taskFolder.root, "api"), { recursive: true });
      yield* run(api, "worktree", "prune");
      yield* taskFolders.restore({
        taskFolder,
        branch: "feature",
        projectCommands: false,
        recreate: (checkout) =>
          run(checkout.repositoryPath, "worktree", "add", "-q", checkout.worktreePath, "feature"),
      });
      assert.equal(yield* worktreeCount(api), 2);
      assert.isTrue(
        yield* taskFolders.removeIfTaskFolder({
          path: taskFolder.root,
          force: true,
          projectCommands: false,
        }),
      );
      assert.equal(yield* fileSystem.readFileString(ran), "create\n");
      assert.isFalse(yield* fileSystem.exists(taskFolder.root));
    }),
  ),
);

it.live(
  "removes what a failed layout command checked out, and refuses a checkout it cannot own",
  () =>
    withState((state) =>
      Effect.gen(function* () {
        const { fileSystem, path, tmp, run, repository, worktreeCount } = yield* fixture;
        const shop = path.join(tmp, "shop");
        const api = yield* repository("shop/api");
        // Not chosen, so the thread's branch name is not moved past the `feature` it has.
        const web = yield* repository("shop/web");
        yield* run(web, "branch", "feature");
        state.workspaceRoot = shop;
        const taskFolders = yield* TaskFolders.TaskFolders;
        const attempt = Effect.fnUntraced(function* (command: string) {
          yield* fileSystem.writeFileString(
            path.join(shop, "ankiel.json"),
            JSON.stringify({ worktreeLayout: { create: command } }),
          );
          const plan = yield* taskFolders.plan({ projectId, repositories: [{ path: api }] });
          return yield* taskFolders
            .create({
              plan: plan!,
              branch: "feature",
              projectStart: { refName: "main", baseRefName: "main" },
              startFromOrigin: false,
              projectCommands: true,
            })
            .pipe(Effect.flip);
        });

        yield* attempt(
          'mkdir -p "$ANKIEL_WORKTREE_PROJECT_PATH" && git -C "$ANKIEL_PROJECT_ROOT/api" worktree add -q -b "$ANKIEL_WORKTREE_BRANCH" "$ANKIEL_WORKTREE_PROJECT_PATH/api" && exit 1',
        );
        assert.equal(yield* worktreeCount(api), 1);

        // A clone has no worktree registration to remove, and no thread branch to rename.
        const refused = yield* attempt(
          'mkdir -p "$ANKIEL_WORKTREE_PROJECT_PATH" && git clone -q "$ANKIEL_PROJECT_ROOT/api" "$ANKIEL_WORKTREE_PROJECT_PATH/api"',
        );
        assert.include(refused.detail, "is not a Git worktree of");

        // The refused checkout's folder is deleted, so its registration must go too.
        const wrongBranch = yield* attempt(
          'mkdir -p "$ANKIEL_WORKTREE_PROJECT_PATH" && git -C "$ANKIEL_PROJECT_ROOT/api" worktree add -q -b other "$ANKIEL_WORKTREE_PROJECT_PATH/api"',
        );
        assert.include(wrongBranch.detail, "is not on the branch feature");
        assert.equal(yield* worktreeCount(api), 1);

        // A branch that was there before the command checked it out outlives the rollback.
        yield* attempt(
          'mkdir -p "$ANKIEL_WORKTREE_PROJECT_PATH" && git -C "$ANKIEL_PROJECT_ROOT/web" worktree add -q "$ANKIEL_WORKTREE_PROJECT_PATH/web" "$ANKIEL_WORKTREE_BRANCH" && exit 1',
        );
        assert.equal(yield* worktreeCount(web), 1);
        assert.deepEqual((yield* run(web, "branch", "--format=%(refname:short)")).split("\n"), [
          "feature",
          "main",
        ]);
      }),
    ),
);

it.live("removes what it created when one repository fails", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository, worktreeCount } = yield* fixture;
      const api = yield* repository("shop/api");
      // Git keeps its worktrees in a folder of this name, so none can be added here.
      const broken = yield* repository("shop/broken");
      yield* fileSystem.writeFileString(path.join(broken, ".git", "worktrees"), "");
      yield* fileSystem.writeFileString(path.join(tmp, "shop", "AGENTS.md"), "rules\n");
      state.workspaceRoot = path.join(tmp, "shop");
      state.trackedFolders = tracked(api, broken);
      const config = yield* ServerConfig.ServerConfig;

      const error = yield* create("feature").pipe(Effect.flip);

      assert.include(String((error as { readonly detail?: string }).detail), "broken worktree");
      assert.equal(yield* worktreeCount(api), 1);
      assert.equal(yield* run(api, "branch", "--format=%(refname:short)"), "main");
      assert.deepEqual(yield* fileSystem.readDirectory(path.join(config.worktreesDir, "shop")), []);
      assert.deepEqual(yield* (yield* TaskFolderStore.TaskFolderStore).list, []);
      assert.isTrue(yield* fileSystem.exists(path.join(tmp, "shop", "AGENTS.md")));
    }),
  ),
);

it.live("keeps a repository git will not remove and removes the rest", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, repository, worktreeCount } = yield* fixture;
      const taskFolders = yield* TaskFolders.TaskFolders;
      const shop = path.join(tmp, "shop");
      const api = yield* repository("shop/api");
      const web = yield* repository("shop/web");
      yield* fileSystem.writeFileString(path.join(shop, "AGENTS.md"), "rules\n");
      state.workspaceRoot = shop;
      state.trackedFolders = tracked(api, web);
      const { taskFolder } = yield* create("feature");
      const root = taskFolder.root;
      yield* fileSystem.writeFileString(path.join(root, "api", "README.md"), "uncommitted\n");

      const first = yield* taskFolders.remove({
        root,
        force: false,
        forget: true,
        projectCommands: true,
      });

      assert.deepEqual(first.removed, [path.join(root, "web")]);
      assert.deepEqual(
        first.kept.map((entry) => entry.path),
        [path.join(root, "api")],
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(root, "api", "README.md")),
        "uncommitted\n",
      );
      assert.equal(yield* worktreeCount(web), 1);
      // The folder stays, so the files it shares with the project stay reachable in it.
      assert.equal(
        yield* fileSystem.readLink(path.join(root, "AGENTS.md")),
        path.join(shop, "AGENTS.md"),
      );
      // The record now lists only what is still on disk.
      assert.deepEqual(
        (yield* taskFolders.find(root))?.repositories.map((entry) => entry.repositoryPath),
        [api],
      );

      const second = yield* taskFolders.remove({
        root,
        force: true,
        forget: true,
        projectCommands: true,
      });

      assert.deepEqual(second.kept, []);
      assert.isFalse(yield* fileSystem.exists(root));
      assert.isNull(yield* taskFolders.find(root));
      assert.equal(yield* worktreeCount(api), 1);
      // Links went; what they pointed at did not.
      assert.equal(yield* fileSystem.readFileString(path.join(shop, "AGENTS.md")), "rules\n");
    }),
  ),
);

it.live("restores a recorded repository the project stopped tracking as its worktree", () =>
  withState((state) =>
    Effect.gen(function* () {
      const { fileSystem, path, tmp, run, repository, isLink } = yield* fixture;
      const shop = path.join(tmp, "shop");
      const api = yield* repository("shop/api");
      const web = yield* repository("shop/web");
      state.workspaceRoot = shop;
      const { taskFolder } = yield* create("feature");
      const root = taskFolder.root;

      yield* fileSystem.remove(root, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(shop, "ankiel.json"),
        JSON.stringify({ ignoreRepositories: ["web"] }),
      );
      yield* (yield* TaskFolders.TaskFolders).restore({
        taskFolder,
        branch: "feature",
        projectCommands: true,
        recreate: ({ repositoryPath, worktreePath }) =>
          run(repositoryPath, "worktree", "prune").pipe(
            Effect.andThen(run(repositoryPath, "worktree", "add", "-q", worktreePath, "feature")),
          ),
      });

      // A link there would be the original checkout, on its own branch.
      for (const repositoryPath of [api, web]) {
        const worktree = path.join(root, path.basename(repositoryPath));
        assert.isFalse(yield* isLink(worktree));
        assert.equal(yield* run(worktree, "symbolic-ref", "--short", "HEAD"), "feature");
      }
      assert.isTrue(yield* isLink(path.join(root, "ankiel.json")));
    }),
  ),
);
