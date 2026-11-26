import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@ankielcode/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "103_IssueTrackerAdditionalScopes",
  (it) => {
    it.effect("keeps a one-team binding with no extra teams", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 102 });
        yield* sql`INSERT INTO issue_tracker_bindings VALUES ('web', 'linear', 'ENG', '2026-11-21')`;
        yield* runMigrations({ toMigrationInclusive: 103 });
        const rows = yield* sql<{ readonly scope: string; readonly additional_scopes: string }>`
          SELECT scope, additional_scopes FROM issue_tracker_bindings WHERE project_id = 'web'
        `;
        assert.deepStrictEqual(rows, [{ scope: "ENG", additional_scopes: "[]" }]);
      }),
    );
  },
);
