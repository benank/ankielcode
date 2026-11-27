import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Only the removed pull request features read these.
  yield* sql`DROP TABLE IF EXISTS projection_thread_pull_requests`;
  yield* sql`DROP TABLE IF EXISTS pull_request_files_viewed`;
  yield* sql`DROP TABLE IF EXISTS pull_request_review_guides`;

  // A thread keeps its payload until its next event rewrites it, so its old links go now.
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET payload_json = json_remove(
      payload_json,
      '$.pullRequests',
      '$.linkedPullRequest',
      '$.branchPullRequest'
    )
    WHERE json_valid(payload_json)
      AND (
        json_type(payload_json, '$.pullRequests') IS NOT NULL
        OR json_type(payload_json, '$.linkedPullRequest') IS NOT NULL
        OR json_type(payload_json, '$.branchPullRequest') IS NOT NULL
      )
  `;

  // Migration 98's index ended on the first pull request link, which the shell read no longer
  // selects. Keep the expressions identical to ProjectionStore.listActiveShellIndex.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_threads_active_shell_idx`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_active_shell_idx
    ON orchestration_v2_projection_threads(
      updated_at,
      thread_id,
      project_id,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.relationshipToParent') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.parentThreadId') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.rootThreadId') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.sideChat') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.settledOverride') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.settledAt') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pinnedAt') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.pinOrderKey') END,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.snoozedUntil') END
    )
    WHERE deleted_at IS NULL AND archived_at IS NULL
  `;
});
