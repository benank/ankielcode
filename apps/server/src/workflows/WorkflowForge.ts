// Issues for workflows: the same trackers the app's own Issues page reads, through the project's
// credentials. A step names a project the way an agent step does, by id or by folder.
import {
  IssueDetail,
  IssueListEntry,
  type IssueCreateResult,
  type IssueListState,
  type IssueRef,
  ProjectId,
} from "@ankielcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as IssueService from "../issue/IssueService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { issueReference, noteReference } from "./runReferences.ts";
import { isProjectPath } from "./WorkflowAgents.ts";

export class WorkflowForgeError extends Schema.TaggedError<WorkflowForgeError>()(
  "WorkflowForgeError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** What an issue trigger gives its run, and what `issues.list` returns rows of. */
export const Issue = IssueListEntry;
export type Issue = typeof Issue.Type;
export { IssueDetail };

/** An issue by its web address, or as a trigger or a listing gave it. */
export type IssueAddress =
  | { readonly project: string; readonly url: string }
  | Pick<Issue, "projectId" | "tracker" | "host" | "scope" | "key">;
export interface IssueQuery {
  readonly project: string;
  /** Defaults to open. */
  readonly state?: IssueListState | undefined;
  /** Label names an issue must carry, every one of them. */
  readonly labels?: ReadonlyArray<string> | undefined;
  /** Free text the tracker matches itself. */
  readonly query?: string | undefined;
  readonly assignee?: string | undefined;
  readonly sort?: "updated" | "created" | undefined;
  readonly limit?: number | undefined;
}
export class WorkflowForge extends Context.Service<
  WorkflowForge,
  {
    readonly issues: {
      readonly list: (query: IssueQuery) => Effect.Effect<ReadonlyArray<Issue>, WorkflowForgeError>;
      readonly read: (issue: IssueAddress) => Effect.Effect<IssueDetail, WorkflowForgeError>;
      readonly comment: (
        issue: IssueAddress,
        body: string,
      ) => Effect.Effect<void, WorkflowForgeError>;
      readonly setState: (
        issue: IssueAddress,
        state: string,
      ) => Effect.Effect<void, WorkflowForgeError>;
      readonly create: (input: {
        readonly project: string;
        readonly title: string;
        readonly body?: string | undefined;
        readonly labels?: ReadonlyArray<string> | undefined;
        readonly assignees?: ReadonlyArray<string> | undefined;
      }) => Effect.Effect<IssueCreateResult, WorkflowForgeError>;
    };
  }
>()("@ankielcode/server/workflows/WorkflowForge") {}

const failed =
  (what: string) =>
  (cause: unknown): WorkflowForgeError =>
    new WorkflowForgeError({
      reason: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });

const missing = (what: string) => () =>
  Effect.fail(
    new WorkflowForgeError({
      reason: `${what} are not available to workflows on this server.`,
    }),
  );
/** For an engine with no trackers behind it: every call says so. */
export const unavailable = WorkflowForge.of({
  issues: {
    list: missing("Issues"),
    read: missing("Issues"),
    comment: missing("Issues"),
    setState: missing("Issues"),
    create: missing("Issues"),
  },
});

export const layer = Layer.effect(
  WorkflowForge,
  Effect.gen(function* () {
    const issues = yield* IssueService.IssueService;
    const projects = yield* ProjectService.ProjectService;

    const projectIdOf = Effect.fn("WorkflowForge.projectIdOf")(function* (project: string) {
      if (!isProjectPath(project)) return ProjectId.make(project);
      const found = yield* projects
        .getByWorkspaceRoot(project)
        .pipe(Effect.mapError(failed("Could not read the project")));
      if (Option.isNone(found)) {
        return yield* new WorkflowForgeError({ reason: `No project is registered at ${project}.` });
      }
      return found.value.id;
    });

    const issueRef = Effect.fn("WorkflowForge.issueRef")(function* (issue: IssueAddress) {
      if (!("project" in issue)) {
        return {
          projectId: issue.projectId,
          tracker: issue.tracker,
          host: issue.host,
          scope: issue.scope,
          key: issue.key,
        } satisfies IssueRef;
      }
      const resolved = yield* issues
        .resolveUrl(issue.url, yield* projectIdOf(issue.project))
        .pipe(Effect.mapError(failed(`Could not find the issue at ${issue.url}`)));
      return {
        projectId: resolved.projectId,
        tracker: resolved.tracker,
        host: resolved.host,
        scope: resolved.scope,
        key: resolved.key,
      } satisfies IssueRef;
    });

    // An address that is a whole listing row already says what the item is called.
    const seenOf = (address: object) => ({
      ...("title" in address && typeof address.title === "string" ? { title: address.title } : {}),
      ...("url" in address && typeof address.url === "string" ? { url: address.url } : {}),
    });
    const issueTouched = (ref: IssueRef, address: IssueAddress) =>
      noteReference({ ...issueReference(ref), ...seenOf(address) });

    return WorkflowForge.of({
      issues: {
        list: Effect.fn("WorkflowForge.issues.list")(function* (query) {
          const result = yield* issues
            .list({
              projectId: yield* projectIdOf(query.project),
              state: query.state ?? "open",
              ...(query.labels === undefined ? {} : { labels: [...query.labels] }),
              ...(query.query === undefined ? {} : { query: query.query }),
              ...(query.assignee === undefined ? {} : { assignee: query.assignee }),
              ...(query.sort === undefined ? {} : { sort: query.sort }),
              ...(query.limit === undefined ? {} : { limit: query.limit }),
            })
            .pipe(Effect.mapError(failed("Could not list issues")));
          // A listing answers with what it could read. One that read nothing is a failure.
          const problem = result.errors[0];
          if (result.entries.length === 0 && problem !== undefined) {
            return yield* new WorkflowForgeError({
              reason: `Could not list issues: ${problem.message}`,
            });
          }
          return result.entries;
        }),
        read: Effect.fn("WorkflowForge.issues.read")(function* (issue) {
          const ref = yield* issueRef(issue);
          const detail = yield* issues
            .detail(ref)
            .pipe(Effect.mapError(failed("Could not read the issue")));
          yield* noteReference(issueReference(ref, detail));
          return detail;
        }),
        comment: Effect.fn("WorkflowForge.issues.comment")(function* (issue, body) {
          const ref = yield* issueRef(issue);
          yield* issues
            .comment({ ...ref, body })
            .pipe(Effect.mapError(failed("Could not comment on the issue")));
          yield* issueTouched(ref, issue);
        }),
        setState: Effect.fn("WorkflowForge.issues.setState")(function* (issue, state) {
          const ref = yield* issueRef(issue);
          yield* issues
            .setState({ ...ref, state })
            .pipe(Effect.mapError(failed("Could not change the issue's state")));
          yield* issueTouched(ref, issue);
        }),
        create: Effect.fn("WorkflowForge.issues.create")(function* (input) {
          const scope = yield* issues
            .projectScope(yield* projectIdOf(input.project))
            .pipe(Effect.mapError(failed("Could not find the project's issue tracker")));
          const created = yield* issues
            .create({
              projectId: scope.projectId,
              tracker: scope.tracker,
              host: scope.host,
              scope: scope.scope,
              title: input.title,
              body: input.body ?? "",
              labels: [...(input.labels ?? [])],
              assignees: [...(input.assignees ?? [])],
            })
            .pipe(Effect.mapError(failed("Could not file the issue")));
          yield* noteReference({
            ...issueReference({ ...scope, key: created.key }),
            title: input.title,
            url: created.url,
            state: "open",
          });
          return created;
        }),
      },
    });
  }),
);
