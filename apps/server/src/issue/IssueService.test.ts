import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SourceControlRateLimit from "@ankielcode/source-control-core/server/SourceControlRateLimit";
import {
  IssueTrackerKind,
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@ankielcode/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
  type TrackerIssueDetail,
} from "@ankielcode/source-control-core/server/IssueTracker";

import { normalizeGitRemoteUrl } from "@ankielcode/shared/git";

import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const GITHUB = IssueTrackerKind.make("github");

function project(input: {
  readonly id: string;
  readonly repository?: string;
  readonly provider?: string;
  readonly host?: string;
}): OrchestrationProjectShell {
  const host = input.host ?? "github.com";
  return {
    id: input.id as ProjectId,
    title: input.id,
    workspaceRoot: `/w/${input.id}`,
    ...(input.repository
      ? {
          repositoryIdentity: {
            canonicalKey: normalizeGitRemoteUrl(`https://${host}/${input.repository}.git`),
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `https://${host}/${input.repository}.git`,
            },
            provider: SourceControlProviderKind.make(input.provider ?? "github"),
            displayName: input.repository,
          },
        }
      : {}),
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

function issue(key: string, updatedAt = "2026-07-02T00:00:00Z"): TrackerIssueDetail {
  return {
    key,
    displayKey: `#${key}`,
    title: `Issue ${key}`,
    url: `https://github.com/acme/web/issues/${key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    body: "",
    viewer: "alex",
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    states: [],
    comments: [],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
  };
}

function fakeTracker(overrides: Partial<IssueTrackerApi> = {}): IssueTrackerApi {
  return {
    kind: GITHUB,
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: false,
      templates: false,
      linkedPullRequests: true,
      events: true,
      search: true,
    },
    getViewer: () => Effect.succeed("alex"),
    listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
    getIssue: (input) => Effect.succeed(issue(input.key)),
    getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
    comment: () => Effect.void,
    update: () => Effect.void,
    setState: () => Effect.void,
    ...overrides,
  };
}

function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly trackers: ReadonlyArray<IssueTrackerApi>;
  readonly githubEnabled?: boolean;
}) {
  return IssueService.IssueService.pipe(
    Effect.provide(
      IssueService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.ServerSettingsService.layerTest({
              githubIntegrationEnabled: input.githubEnabled ?? true,
            }),
            Layer.succeed(
              IssueTrackerRegistry.IssueTrackerRegistry,
              IssueTrackerRegistry.fromTrackers(input.trackers),
            ),
            Layer.mock(ProjectService.ProjectService)({
              listShells: () => Effect.succeed(input.projects),
              getShell: (projectId) =>
                Effect.succeed(
                  Option.fromNullishOr(input.projects.find((p) => p.id === projectId)),
                ),
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () => Effect.succeed(null),
            }),
          ),
        ),
      ),
    ),
  );
}

describe("IssueService", () => {
  it.effect("skips GitHub projects and issue links when GitHub integration is off", () =>
    Effect.gen(function* () {
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            kind: GITHUB,
            listIssues: () => Effect.die("GitHub issues should not be listed"),
            getIssue: () => Effect.die("GitHub issues should not be read"),
          }),
        ],
        githubEnabled: false,
      });
      expect((yield* service.list({ state: "open" })).entries).toEqual([]);
      expect(
        yield* Effect.flip(service.resolveUrl("https://github.com/acme/web/issues/1")),
      ).toMatchObject({
        operation: "resolveUrl",
      });
    }),
  );

  it.effect("refuses a link to a tracker this build does not ship, such as Linear", () =>
    Effect.gen(function* () {
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [fakeTracker()],
      });
      const ref = {
        projectId: "web" as ProjectId,
        tracker: IssueTrackerKind.make("linear"),
        host: "linear.app",
        scope: "ENG",
        key: "ENG-1",
      };
      expect(yield* Effect.flip(service.detail(ref))).toMatchObject({
        _tag: "IssueUnavailableError",
        reason: "tracker-unsupported",
      });
      expect(
        yield* Effect.flip(service.resolveUrl("https://linear.app/acme/issue/ENG-1/title")),
      ).toMatchObject({ operation: "resolveUrl", reason: "not-found" });
    }),
  );

  it.effect("reads another repository on the same host but refuses to write to it", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            comment: (input) =>
              Effect.sync(() => {
                writes.push(`${input.scope}#${input.key}`);
              }),
          }),
        ],
      });
      const own = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
      const external = { ...own, scope: "other/backend", key: "7" };

      expect((yield* service.detail(own)).writable).toBe(true);
      // The external issue is served by the project's checkout and credentials, read-only.
      const detail = yield* service.detail(external);
      expect(detail).toMatchObject({ writable: false, scope: "other/backend", key: "7" });

      yield* service.comment({ ...own, body: "ok" });
      const refused = yield* service.comment({ ...external, body: "no" }).pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "IssueOperationError", reason: "read-only" },
      });
      expect(writes).toEqual(["acme/web#1"]);

      // A GitHub Enterprise Server's hostname need not say "github"; its project vouches for it.
      const enterprise = yield* makeService({
        projects: [project({ id: "ghes", repository: "acme/web", host: "code.acme.test" })],
        trackers: [fakeTracker()],
      });
      expect(
        yield* enterprise.resolveUrl("https://code.acme.test/acme/web/issues/7"),
      ).toMatchObject({ projectId: "ghes", host: "code.acme.test", key: "7", writable: true });

      // A fork lists its upstream's issues and its own, counted once, and may write to both.
      const fork = project({ id: "fork", repository: "acme/web" });
      const forked = yield* makeService({
        projects: [
          {
            ...fork,
            repositoryIdentity: {
              ...fork.repositoryIdentity!,
              origin: { canonicalKey: "github.com/me/web" },
            },
          },
        ],
        trackers: [
          fakeTracker({
            listIssues: (input) =>
              Effect.succeed({ items: [issue(input.scope)], nextCursor: null }),
            comment: (input) =>
              Effect.sync(() => {
                writes.push(`${input.scope}#${input.key}`);
              }),
          }),
        ],
      });
      const listed = yield* forked.list({ state: "open" });
      expect(listed.entries.map((entry) => entry.scope).sort()).toEqual(["acme/web", "me/web"]);
      expect(listed.trackers).toEqual([expect.objectContaining({ projectCount: 1 })]);
      yield* forked.comment({
        ...own,
        projectId: "fork" as ProjectId,
        scope: "me/web",
        body: "ok",
      });
      expect(writes).toEqual(["acme/web#1", "me/web#1"]);

      // Another host is not reachable through this project's credentials at all.
      const elsewhere = yield* Effect.flip(service.detail({ ...own, host: "ghe.example.test" }));
      expect(elsewhere).toMatchObject({
        _tag: "IssueUnavailableError",
        reason: "tracker-unsupported",
      });
    }),
  );

  it.effect(
    "does not call a GitHub issue URL unbrowsable when no project is a GitHub checkout",
    () =>
      Effect.gen(function* () {
        // A plain folder project, while GitHub itself is a supported tracker.
        const service = yield* makeService({
          projects: [project({ id: "folder" })],
          trackers: [fakeTracker()],
        });
        const resolved = yield* service
          .resolveUrl("https://github.com/acme/web/issues/1", "folder" as ProjectId)
          .pipe(Effect.result);
        if (resolved._tag === "Failure") {
          expect(resolved.failure).not.toMatchObject({
            _tag: "IssueUnavailableError",
            reason: "tracker-unsupported",
          });
        }
      }),
  );

  it.effect("sends writes as interactive requests and reads as background ones", () =>
    Effect.gen(function* () {
      const interactive: Array<readonly [string, boolean]> = [];
      const record = (operation: string) =>
        Effect.gen(function* () {
          interactive.push([operation, yield* SourceControlRateLimit.Interactive]);
        });
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            getComments: () =>
              record("comments").pipe(Effect.as({ comments: [], nextCursor: null })),
            comment: () => record("comment"),
          }),
        ],
      });
      const ref = {
        projectId: "web" as ProjectId,
        tracker: GITHUB,
        scope: "acme/web",
        key: "42",
      };
      yield* service.comments({ ...ref, cursor: "next" });
      yield* service.comment({ ...ref, body: "Repro attached." });
      expect(interactive).toEqual([
        ["comments", false],
        ["comment", true],
      ]);
    }),
  );

  it.effect("refuses what the tracker did not declare before calling it", () =>
    Effect.gen(function* () {
      let calls = 0;
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            setState: () =>
              Effect.sync(() => {
                calls += 1;
              }),
            setReaction: () =>
              Effect.sync(() => {
                calls += 1;
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };

      // The state is the tracker's own name, passed through: the tracker is what proves it.
      yield* service.setState({ ...ref, state: "In Review" });
      const reaction = yield* Effect.flip(
        service.react({ ...ref, content: "heart", reacted: true }),
      );
      expect(reaction._tag).toBe("IssueOperationError");
      expect(calls).toBe(1);
    }),
  );

  it.effect("deduplicates and pages repositories despite partial failures", () =>
    Effect.gen(function* () {
      const listed: string[] = [];
      let failContinuation = true;
      const service = yield* makeService({
        projects: [
          project({ id: "web", repository: "Acme/Web" }),
          project({ id: "web-worktree", repository: "acme/web" }),
          project({ id: "api", repository: "acme/api" }),
          project({ id: "docs", repository: "acme/docs" }),
          project({
            id: "gitlab",
            repository: "acme/gl",
            provider: "gitlab",
            host: "gitlab.com",
          }),
          project({ id: "plain" }),
        ],
        trackers: [
          fakeTracker({
            listIssues: (input) =>
              Effect.gen(function* () {
                listed.push(input.scope);
                if (input.scope === "acme/api")
                  return yield* new IssueTrackerError({
                    tracker: GITHUB,
                    operation: "listIssues",
                    reason: "failed",
                    // A tracker may fail without a detail; the wire error still needs one.
                    detail: " ",
                  });
                if (input.scope === "acme/docs")
                  return { items: [issue("3", "2026-07-04T00:00:00Z")], nextCursor: null };
                if (input.cursor === "next" && failContinuation) {
                  failContinuation = false;
                  return yield* new IssueTrackerError({
                    tracker: GITHUB,
                    operation: "listIssues",
                    reason: "failed",
                    detail: "try again",
                  });
                }
                if (input.cursor === "next")
                  return { items: [issue("4", "2026-07-01T00:00:00Z")], nextCursor: null };
                return {
                  items: [issue("1"), issue("2", "2026-07-05T00:00:00Z")],
                  nextCursor: "next",
                };
              }),
          }),
        ],
      });
      const result = yield* service.list({ state: "open" });
      expect(listed.sort()).toEqual(["Acme/Web", "acme/api", "acme/docs"]);
      expect(result.entries.map((entry) => [entry.projectId, entry.key])).toEqual([
        ["web", "2"],
        ["docs", "3"],
        ["web", "1"],
      ]);
      expect(
        result.entries.filter((entry) => entry.projectId === "web").map((entry) => entry.scope),
      ).toEqual(["Acme/Web", "Acme/Web"]);
      expect(result.nextCursors).toEqual({ "github.com acme/web": "next" });
      expect(result.errors).toEqual([
        { projectId: "api", projectTitle: "api", message: "The issue tracker request failed." },
      ]);
      expect(result.viewers).toEqual({});
      expect(result.trackers).toEqual([
        expect.objectContaining({ host: "github.com", projectCount: 4, configured: true }),
        expect.objectContaining({
          host: "gitlab.com",
          tracker: "gitlab",
          projectCount: 1,
          configured: false,
          capabilities: null,
        }),
      ]);

      // Narrowing to one host still names every tracker, so the client can switch between them.
      // Narrowing by involvement reads the account it compares against.
      const narrowed = yield* service.list({
        state: "open",
        host: "github.com",
        involvement: "assigned",
      });
      expect(narrowed.viewers).toEqual({ "github.com": "alex" });
      expect(narrowed.entries.every((entry) => entry.host === "github.com")).toBe(true);
      expect(narrowed.trackers.map((tracker) => tracker.host)).toEqual([
        "github.com",
        "gitlab.com",
      ]);

      // A continuation only reads the scopes it names.
      listed.length = 0;
      const failed = yield* service.list({
        state: "open",
        cursors: result.nextCursors,
      });
      expect(listed).toEqual(["Acme/Web"]);
      expect(failed.nextCursors).toEqual(result.nextCursors);
      expect(failed.errors).toEqual([
        { projectId: "web", projectTitle: "web", message: "try again" },
      ]);
      const next = yield* service.list({ state: "open", cursors: failed.nextCursors });
      expect(next.entries.map((entry) => [entry.projectId, entry.key])).toEqual([["web", "4"]]);
      expect(next.nextCursors).toEqual({});
      expect(next.errors).toEqual([]);

      // The cursor belongs to the scope, not to the project whose spelling first read it.
      listed.length = 0;
      const through = yield* service.list({
        state: "open",
        projectId: "web-worktree" as ProjectId,
        cursors: result.nextCursors,
      });
      expect(listed).toEqual(["acme/web"]);
      expect(through.entries.map((entry) => entry.key)).toEqual(["4"]);
    }),
  );
});
