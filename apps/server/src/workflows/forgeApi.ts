// Issues as a workflow file sees them: a trigger and calls for inside a step.
import * as Effect from "effect/Effect";

import { checkOptions } from "./options.ts";
import { issuesOpened } from "./triggers.ts";
import { type IssueAddress, WorkflowForge } from "./WorkflowForge.ts";

const forge = <A, E>(use: (forge: WorkflowForge["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(WorkflowForge, use);

/**
 * The project's issues, in whichever tracker it uses. `opened` is a trigger; the rest are for
 * inside `step` or `onEnd`. An issue is named by what a trigger or `list` gave, or by
 * `{ project, url }`.
 */
export const issues = {
  opened: issuesOpened,
  list: (query: Parameters<WorkflowForge["Service"]["issues"]["list"]>[0]) => {
    checkOptions("issues.list", query, [
      "project",
      "state",
      "labels",
      "query",
      "assignee",
      "sort",
      "limit",
    ]);
    return forge((all) => all.issues.list(query));
  },
  read: (issue: IssueAddress) => forge((all) => all.issues.read(issue)),
  comment: (issue: IssueAddress, body: string) => forge((all) => all.issues.comment(issue, body)),
  /** Move the issue to one of its `states`, as `read` lists them. */
  setState: (issue: IssueAddress, state: string) =>
    forge((all) => all.issues.setState(issue, state)),
  create: (input: Parameters<WorkflowForge["Service"]["issues"]["create"]>[0]) => {
    checkOptions("issues.create", input, ["project", "title", "body", "labels", "assignees"]);
    return forge((all) => all.issues.create(input));
  },
};

// Ankiel Code no longer works with pull requests. A workflow file that still names them fails at
// that line with this message instead of reading a property of undefined.
export const pullRequests: unknown = new Proxy(
  {},
  {
    get: (_target, property) => {
      throw new Error(
        `pullRequests.${String(property)} was removed: workflows can no longer use pull requests.`,
      );
    },
  },
);
