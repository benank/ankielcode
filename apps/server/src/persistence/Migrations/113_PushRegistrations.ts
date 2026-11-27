import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE push_registrations (
    session_id TEXT PRIMARY KEY, platform TEXT NOT NULL, token TEXT NOT NULL,
    app_id TEXT NOT NULL, apns_environment TEXT, kinds_json TEXT NOT NULL,
    locale TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX push_registrations_token_idx ON push_registrations(token)`;
  // Every revoke path, including pairing replacement, ends here, so one trigger covers them all.
  yield* sql`CREATE TRIGGER push_registrations_session_revoked
    AFTER UPDATE OF revoked_at ON auth_sessions
    WHEN NEW.revoked_at IS NOT NULL
    BEGIN
      DELETE FROM push_registrations WHERE session_id = NEW.session_id;
    END`;
});
