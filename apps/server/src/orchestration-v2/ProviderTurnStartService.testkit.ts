import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";

// No project in these tests tracks a repository, so no thread works in a task folder.
export const layerNoTaskFolders = Layer.mock(TaskFolders.TaskFolders)({
  plan: () => Effect.succeed(null),
  find: () => Effect.succeed(null),
});

export const layer = Layer.mergeAll(
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
    runForThread: () => Effect.succeed({ status: "no-script" }),
  }),
  layerNoTaskFolders,
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
    createWorktree: () => Effect.succeed({} as never),
  }),
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeedNone,
  }),
);
