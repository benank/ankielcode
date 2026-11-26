import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@ankielcode/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("112_DropIssueTrackerTables", (it) => {
  it.effect("drops the Linear bindings and accounts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 111 });
      yield* sql`
        INSERT INTO issue_tracker_bindings (project_id, tracker, scope, updated_at, account_id)
        VALUES ('web', 'linear', 'ENG', '2026-11-21', 'work')
      `;
      yield* sql`
        INSERT INTO issue_tracker_accounts VALUES ('linear', 'work', '2026-11-21')
      `;
      yield* runMigrations({ toMigrationInclusive: 112 });
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'issue_tracker_%'
      `;
      assert.deepStrictEqual(tables, []);
    }),
  );
});
