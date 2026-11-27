import {
  type AuthSessionId,
  PushAlertKind,
  PushApnsEnvironment,
  PushPlatform,
  type PushRegisterInput,
  PushRegistrationError,
  type PushStatus,
} from "@ankielcode/contracts";
import * as NodeSqliteClient from "@ankielcode/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as RelayTunnelService from "./RelayTunnelService.ts";

const KindsJson = Schema.fromJsonString(Schema.Array(PushAlertKind));
const encodeKinds = Schema.encodeEffect(KindsJson);

const PushRegistrationRow = Schema.Struct({
  platform: PushPlatform,
  token: Schema.String,
  appId: Schema.String,
  apnsEnvironment: Schema.NullOr(PushApnsEnvironment),
  kinds: KindsJson,
});
export type PushRegistration = typeof PushRegistrationRow.Type;

/** The device registrations of this environment's paired sessions; tokens never reach logs. */
export class PushRegistry extends Context.Service<
  PushRegistry,
  {
    /** One registration per session: a new token replaces the session's old one. */
    readonly register: (
      sessionId: AuthSessionId,
      input: PushRegisterInput,
    ) => Effect.Effect<PushStatus, PushRegistrationError>;
    readonly unregister: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<PushStatus, PushRegistrationError>;
    readonly status: (sessionId: AuthSessionId) => Effect.Effect<PushStatus, PushRegistrationError>;
    /** Registrations of sessions that are neither revoked nor expired. */
    readonly listActive: Effect.Effect<ReadonlyArray<PushRegistration>, PersistenceSqlError>;
    /** Drops every registration holding one of these tokens, whichever session made it. */
    readonly forgetTokens: (
      tokens: ReadonlyArray<string>,
    ) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("@ankielcode/server/relay/PushRegistry") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const relay = yield* RelayTunnelService.RelayTunnelService;

  const selectBySession = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: PushRegistrationRow,
    execute: (sessionId) => sql`
      SELECT platform, token, app_id AS "appId", apns_environment AS "apnsEnvironment",
        kinds_json AS "kinds"
      FROM push_registrations WHERE session_id = ${sessionId}
    `,
  });

  const selectActive = SqlSchema.findAll({
    Request: Schema.String,
    Result: PushRegistrationRow,
    execute: (nowIso) => sql`
      SELECT r.platform, r.token, r.app_id AS "appId", r.apns_environment AS "apnsEnvironment",
        r.kinds_json AS "kinds"
      FROM push_registrations r
      JOIN auth_sessions s ON s.session_id = r.session_id
      WHERE s.revoked_at IS NULL AND s.expires_at > ${nowIso}
      ORDER BY r.updated_at DESC
    `,
  });

  const status = Effect.fn("PushRegistry.status")(function* (sessionId: AuthSessionId) {
    const relayStatus = yield* relay.getStatus;
    const push = yield* relay.pushState;
    const registration = yield* selectBySession(sessionId).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(() => new PushRegistrationError({ operation: "status" })),
    );
    return {
      relayConfigured: relayStatus.configured,
      relayConnected: relayStatus.connected,
      available: {
        ios: push?.availability.apns ?? false,
        android: push?.availability.fcm ?? false,
      },
      registration: Option.match(registration, {
        onNone: () => null,
        onSome: (row) => ({ platform: row.platform, kinds: row.kinds }),
      }),
    } satisfies PushStatus;
  });

  const register = Effect.fn("PushRegistry.register")(function* (
    sessionId: AuthSessionId,
    input: PushRegisterInput,
  ) {
    yield* Effect.annotateCurrentSpan({ platform: input.platform, kinds: input.kinds.length });
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const apnsEnvironment = input.platform === "ios" ? input.apnsEnvironment : null;
    const kindsJson = yield* encodeKinds([...new Set(input.kinds)]).pipe(
      Effect.mapError(() => new PushRegistrationError({ operation: "register" })),
    );
    yield* sql`
      INSERT INTO push_registrations (
        session_id, platform, token, app_id, apns_environment, kinds_json, locale, updated_at
      ) VALUES (
        ${sessionId}, ${input.platform}, ${input.token}, ${input.appId}, ${apnsEnvironment},
        ${kindsJson}, ${input.locale}, ${updatedAt}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        platform = excluded.platform, token = excluded.token, app_id = excluded.app_id,
        apns_environment = excluded.apns_environment, kinds_json = excluded.kinds_json,
        locale = excluded.locale, updated_at = excluded.updated_at
    `.pipe(Effect.mapError(() => new PushRegistrationError({ operation: "register" })));
    return yield* status(sessionId);
  });

  const unregister = Effect.fn("PushRegistry.unregister")(function* (sessionId: AuthSessionId) {
    yield* sql`DELETE FROM push_registrations WHERE session_id = ${sessionId}`.pipe(
      Effect.mapError(() => new PushRegistrationError({ operation: "unregister" })),
    );
    return yield* status(sessionId);
  });

  const listActive = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* selectActive(now).pipe(NodeSqliteClient.readOnly);
  }).pipe(
    Effect.mapError(
      (cause) => new PersistenceSqlError({ operation: "listPushRegistrations", cause }),
    ),
    Effect.withSpan("PushRegistry.listActive"),
  );

  const forgetTokens = Effect.fn("PushRegistry.forgetTokens")(function* (
    tokens: ReadonlyArray<string>,
  ) {
    if (tokens.length === 0) return;
    yield* Effect.annotateCurrentSpan({ count: tokens.length });
    yield* sql`DELETE FROM push_registrations WHERE token IN ${sql.in(tokens)}`.pipe(
      Effect.mapError((cause) => new PersistenceSqlError({ operation: "forgetPushTokens", cause })),
    );
  });

  return PushRegistry.of({ register, unregister, status, listActive, forgetTokens });
});

export const layer = Layer.effect(PushRegistry, make);
