import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Only the removed Linear tracker read these. Threads keep their own issue links.
  yield* sql`DROP TABLE IF EXISTS issue_tracker_bindings`;
  yield* sql`DROP TABLE IF EXISTS issue_tracker_accounts`;
});
