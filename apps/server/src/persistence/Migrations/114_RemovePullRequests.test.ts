import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@ankielcode/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("114_RemovePullRequests", (it) => {
  it.effect("drops pull request tables and links and rebuilds the active shell index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 113 });
      const createdAt = "2026-11-27T00:00:00.000Z";
      const link = {
        host: "github.com",
        repository: "owner/repo",
        number: 7,
        url: "https://github.com/owner/repo/pull/7",
        source: "agent",
        linkedAt: createdAt,
        snapshot: null,
        stack: null,
        watch: { startedAt: createdAt },
      };
      const insertThread = (id: string, payload: Record<string, unknown>) =>
        sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${id}, 'project-1', ${id}, 'codex', 'full-access', 'default',
            ${createdAt}, ${createdAt}, ${JSON.stringify({ id, title: id, ...payload })}
          )
        `;
      yield* insertThread("linked", {
        branch: "feature",
        pullRequests: [link],
        linkedPullRequest: { repository: "owner/repo", number: 7, url: link.url },
        branchPullRequest: null,
      });
      yield* insertThread("plain", { branch: "main" });
      yield* sql`
        INSERT INTO pull_request_review_guides (host, repository, number, guide_json)
        VALUES ('github.com', 'owner/repo', 7, '{}')
      `;
      yield* sql`
        INSERT INTO pull_request_files_viewed (
          provider, host, repository, number, viewer, path, revision, viewed_at
        ) VALUES ('github', 'github.com', 'owner/repo', 7, 'octocat', 'a.ts', NULL, ${createdAt})
      `;

      yield* runMigrations({ toMigrationInclusive: 114 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'projection_thread_pull_requests', 'pull_request_files_viewed', 'pull_request_review_guides'
        )
      `;
      assert.deepStrictEqual(tables, []);
      const threads = yield* sql<{ readonly thread_id: string; readonly payload_json: string }>`
        SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(
        threads.map((row) => [row.thread_id, JSON.parse(row.payload_json)]),
        [
          ["linked", { id: "linked", title: "linked", branch: "feature" }],
          ["plain", { id: "plain", title: "plain", branch: "main" }],
        ],
      );
      const [index] = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'orchestration_v2_projection_threads_active_shell_idx'
      `;
      assert.include(index?.sql, "$.snoozedUntil");
      assert.notInclude(index?.sql, "pullRequests");
    }),
  );
});
