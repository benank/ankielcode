import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

import {
  AuthSessionId,
  ForwardCompatibleArray,
  ClientSurface,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ServerAuthPolicy = Schema.Literals([
  "desktop-managed-local",
  "loopback-browser",
  "remote-reachable",
  "unsafe-no-auth",
]);
export type ServerAuthPolicy = typeof ServerAuthPolicy.Type;

export const ServerAuthBootstrapMethod = Schema.Literals(["desktop-bootstrap", "one-time-token"]);
export type ServerAuthBootstrapMethod = typeof ServerAuthBootstrapMethod.Type;

export const ServerAuthSessionMethod = Schema.Literals([
  "browser-session-cookie",
  "bearer-access-token",
  "dpop-access-token",
]);
export type ServerAuthSessionMethod = typeof ServerAuthSessionMethod.Type;

export const AuthOrchestrationReadScope = "orchestration:read" as const;
export const AuthOrchestrationOperateScope = "orchestration:operate" as const;
export const AuthSettingsWriteScope = "settings:write" as const;
// Also decides where credentials go: secret providers, references, and key-bearing endpoints.
export const AuthProvidersManageScope = "providers:manage" as const;
export const AuthEnvironmentMaintainScope = "environment:maintain" as const;
export const AuthPreviewOperateScope = "preview:operate" as const;
export const AuthDiagnosticsReadScope = "diagnostics:read" as const;
export const AuthTerminalReadScope = "terminal:read" as const;
export const AuthTerminalOperateScope = "terminal:operate" as const;
export const AuthSourceControlWriteScope = "source-control:write" as const;
export const AuthFilesystemReadScope = "filesystem:read" as const;
export const AuthFilesystemWriteScope = "filesystem:write" as const;
/** Retained for decoding existing credentials; grants no current RPC access. */
const AuthReviewWriteScope = "review:write" as const;
export const AuthAccessReadScope = "access:read" as const;
export const AuthAccessWriteScope = "access:write" as const;
/** Retained for decoding existing credentials; grants no current RPC access. */
const AuthRelayReadScope = "relay:read" as const;
const AuthRelayWriteScope = "relay:write" as const;
const AuthRelayConfigureScope = "relay:configure" as const;
export const AuthEnvironmentScope = Schema.Literals([
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthEnvironmentMaintainScope,
  AuthPreviewOperateScope,
  AuthDiagnosticsReadScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthReviewWriteScope,
  AuthSourceControlWriteScope,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthRelayConfigureScope,
]);
export type AuthEnvironmentScope = typeof AuthEnvironmentScope.Type;
export const AuthEnvironmentScopes = Schema.Array(AuthEnvironmentScope);
export type AuthEnvironmentScopes = typeof AuthEnvironmentScopes.Type;

export const AuthGrantScope = Schema.Literals(
  AuthEnvironmentScope.literals.filter(
    (scope) =>
      scope !== AuthReviewWriteScope &&
      scope !== AuthRelayReadScope &&
      scope !== AuthRelayWriteScope &&
      scope !== AuthRelayConfigureScope,
  ),
);
export type AuthGrantScope = typeof AuthGrantScope.Type;
export const AuthGrantScopes = Schema.Array(AuthGrantScope);
export type AuthGrantScopes = typeof AuthGrantScopes.Type;

const legacyScopes = new Set<AuthEnvironmentScope>([
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthReviewWriteScope,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
]);

export function authScopeResponse(scopes: ReadonlyArray<AuthEnvironmentScope>) {
  return { scopes: scopes.filter((scope) => legacyScopes.has(scope)), permissions: scopes };
}

const authScopeResponseFields = {
  scopes: AuthEnvironmentScopes,
  permissions: Schema.optionalKey(ForwardCompatibleArray(AuthEnvironmentScope)),
};

// Client-only fallback for old servers. Servers never expand grants; empty permissions grant nothing.
const legacyParents: Partial<Record<AuthEnvironmentScope, AuthEnvironmentScope>> = {
  [AuthFilesystemReadScope]: AuthOrchestrationReadScope,
  [AuthDiagnosticsReadScope]: AuthOrchestrationReadScope,
  [AuthSettingsWriteScope]: AuthOrchestrationOperateScope,
  [AuthProvidersManageScope]: AuthOrchestrationOperateScope,
  [AuthEnvironmentMaintainScope]: AuthOrchestrationOperateScope,
  [AuthPreviewOperateScope]: AuthOrchestrationOperateScope,
  [AuthSourceControlWriteScope]: AuthOrchestrationOperateScope,
  [AuthFilesystemWriteScope]: AuthOrchestrationOperateScope,
  [AuthTerminalReadScope]: AuthTerminalOperateScope,
};

/** Keep permission denials decodable by clients with the original scope enum. */
export function authScopeRequiredResponse(requiredPermission: AuthEnvironmentScope) {
  return {
    requiredScope:
      requiredPermission === AuthRelayConfigureScope
        ? AuthRelayWriteScope
        : (legacyParents[requiredPermission] ?? requiredPermission),
    requiredPermission,
  };
}

export interface SessionGrantInput {
  readonly authenticated: boolean;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope> | undefined;
  readonly permissions?: ReadonlyArray<AuthEnvironmentScope> | undefined;
  readonly auth?: { readonly serverUpdateScope?: string | undefined } | undefined;
}

export function sessionGrantsScope(
  session: SessionGrantInput,
  scope: AuthEnvironmentScope,
): boolean {
  if (!session.authenticated) return false;
  if (session.permissions !== undefined) return session.permissions.includes(scope);
  if (session.scopes?.includes(scope)) return true;
  if (session.auth?.serverUpdateScope !== undefined) return false;
  const parent = legacyParents[scope];
  return parent !== undefined && session.scopes?.includes(parent) === true;
}

export function sessionHasLegacyPermissions(session: SessionGrantInput): boolean {
  const permissions = session.permissions;
  return (
    session.authenticated &&
    permissions !== undefined &&
    permissions.every((scope) => legacyScopes.has(scope)) &&
    Object.values(legacyParents).some((parent) => permissions.includes(parent))
  );
}

// Shell and full-access agent scopes already confer access authority.
export const AuthStandardClientScopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthEnvironmentMaintainScope,
  AuthPreviewOperateScope,
  AuthDiagnosticsReadScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthAccessReadScope,
  AuthAccessWriteScope,
] as const;

export const AuthTokenExchangeGrantType =
  "urn:ietf:params:oauth:grant-type:token-exchange" as const;
export const AuthAccessTokenType = "urn:ietf:params:oauth:token-type:access_token" as const;
export const AuthEnvironmentBootstrapTokenType =
  "urn:ankiel:params:oauth:token-type:environment-bootstrap" as const;

export const ServerAuthDescriptor = Schema.Struct({
  policy: ServerAuthPolicy,
  bootstrapMethods: Schema.Array(ServerAuthBootstrapMethod),
  sessionMethods: Schema.Array(ServerAuthSessionMethod),
  sessionCookieName: TrimmedNonEmptyString,
  /** Older servers omit this and authorize self-updates with orchestration:operate. */
  serverUpdateScope: Schema.optionalKey(Schema.Literal(AuthEnvironmentMaintainScope)),
});
export type ServerAuthDescriptor = typeof ServerAuthDescriptor.Type;

export const AuthBrowserSessionRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
});
export type AuthBrowserSessionRequest = typeof AuthBrowserSessionRequest.Type;

export const AuthBrowserSessionResult = Schema.Struct({
  authenticated: Schema.Literal(true),
  ...authScopeResponseFields,
  sessionMethod: ServerAuthSessionMethod,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthBrowserSessionResult = typeof AuthBrowserSessionResult.Type;

export const AuthClientMetadataDeviceType = Schema.Literals([
  "desktop",
  "mobile",
  "tablet",
  "bot",
  "unknown",
]);
export type AuthClientMetadataDeviceType = typeof AuthClientMetadataDeviceType.Type;

export const AuthClientPresentationMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  deviceType: Schema.optionalKey(AuthClientMetadataDeviceType),
  os: Schema.optionalKey(TrimmedNonEmptyString),
  osMajorVersion: Schema.optionalKey(Schema.Int),
  deviceModel: Schema.optionalKey(TrimmedNonEmptyString),
  surface: Schema.optionalKey(ClientSurface),
  browser: Schema.optionalKey(TrimmedNonEmptyString),
  appVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientPresentationMetadata = typeof AuthClientPresentationMetadata.Type;

export const AuthTokenExchangeRequest = Schema.Struct({
  grant_type: Schema.Literal(AuthTokenExchangeGrantType),
  subject_token: TrimmedNonEmptyString,
  /** An access token renews its own session, with a DPoP proof from the key it is bound to. */
  subject_token_type: Schema.Literals([AuthEnvironmentBootstrapTokenType, AuthAccessTokenType]),
  requested_token_type: Schema.Literal(AuthAccessTokenType),
  scope: Schema.optionalKey(TrimmedNonEmptyString),
  client_label: Schema.optionalKey(TrimmedNonEmptyString),
  client_device_type: Schema.optionalKey(AuthClientMetadataDeviceType),
  client_os: Schema.optionalKey(TrimmedNonEmptyString),
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type AuthTokenExchangeRequest = typeof AuthTokenExchangeRequest.Type;

export const AuthAccessTokenResult = Schema.Struct({
  access_token: TrimmedNonEmptyString,
  issued_token_type: Schema.Literal(AuthAccessTokenType),
  token_type: Schema.Literals(["Bearer", "DPoP"]),
  expires_in: Schema.Number,
  scope: TrimmedNonEmptyString,
  environment_label: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthAccessTokenResult = typeof AuthAccessTokenResult.Type;

export const AuthWebSocketTicketResult = Schema.Struct({
  ticket: Schema.RedactedFromValue(TrimmedNonEmptyString),
  expiresAt: Schema.DateTimeUtc,
});
export type AuthWebSocketTicketResult = typeof AuthWebSocketTicketResult.Type;

/**
 * Media routes share a ticket across requests; RPC uses a separate ticket.
 * Use a path segment so the DPoP mint proof covers it; `htu` excludes query parameters,
 * which could be stripped to change the ticket's use.
 * Older clients mint at the bare path and receive tickets valid for either use.
 */
export const AuthWebSocketTicketUse = Schema.Literals(["rpc", "media"]);
export type AuthWebSocketTicketUse = typeof AuthWebSocketTicketUse.Type;

export const AuthWebSocketTicketParams = Schema.Struct({ use: AuthWebSocketTicketUse });

/** How far an MCP caller outside a thread may act; stored on `link_request` items in old threads. */
export const AuthMcpClientAccess = Schema.Literals([
  "read-only",
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type AuthMcpClientAccess = typeof AuthMcpClientAccess.Type;

/** The random part of a one-time pairing code: this many characters from this alphabet. */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 12;

export const AuthPairingCredentialResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingCredentialResult = typeof AuthPairingCredentialResult.Type;

export const AuthClientMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  ipAddress: Schema.optionalKey(TrimmedNonEmptyString),
  userAgent: Schema.optionalKey(TrimmedNonEmptyString),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.optionalKey(TrimmedNonEmptyString),
  browser: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientMetadata = typeof AuthClientMetadata.Type;

export const AuthPairingLink = Schema.Struct({
  id: TrimmedNonEmptyString,
  ...authScopeResponseFields,
  subject: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingLink = typeof AuthPairingLink.Type;

export const AuthClientSession = Schema.Struct({
  sessionId: AuthSessionId,
  subject: TrimmedNonEmptyString,
  ...authScopeResponseFields,
  method: ServerAuthSessionMethod,
  client: AuthClientMetadata,
  issuedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtc),
  connected: Schema.Boolean,
  current: Schema.Boolean,
});
export type AuthClientSession = typeof AuthClientSession.Type;

export const AuthAccessSnapshot = Schema.Struct({
  pairingLinks: Schema.Array(AuthPairingLink),
  clientSessions: Schema.Array(AuthClientSession),
});
export type AuthAccessSnapshot = typeof AuthAccessSnapshot.Type;

export const AuthAccessStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("snapshot"),
  payload: AuthAccessSnapshot,
});
export type AuthAccessStreamSnapshotEvent = typeof AuthAccessStreamSnapshotEvent.Type;

export const AuthAccessStreamPairingLinkUpsertedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("pairingLinkUpserted"),
  payload: AuthPairingLink,
});
export type AuthAccessStreamPairingLinkUpsertedEvent =
  typeof AuthAccessStreamPairingLinkUpsertedEvent.Type;

export const AuthAccessStreamPairingLinkRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("pairingLinkRemoved"),
  payload: Schema.Struct({
    id: TrimmedNonEmptyString,
  }),
});
export type AuthAccessStreamPairingLinkRemovedEvent =
  typeof AuthAccessStreamPairingLinkRemovedEvent.Type;

export class AuthAccessStreamError extends Schema.TaggedError<AuthAccessStreamError>()(
  "AuthAccessStreamError",
  {
    message: Schema.String,
  },
) {}

export class EnvironmentAuthorizationError extends Schema.TaggedError<EnvironmentAuthorizationError>()(
  "EnvironmentAuthorizationError",
  {
    message: Schema.String,
    requiredScope: AuthEnvironmentScope,
    requiredPermission: Schema.optionalKey(Schema.String),
  },
) {}

export const AuthAccessStreamClientUpsertedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("clientUpserted"),
  payload: AuthClientSession,
});
export type AuthAccessStreamClientUpsertedEvent = typeof AuthAccessStreamClientUpsertedEvent.Type;

export const AuthAccessStreamClientRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("clientRemoved"),
  payload: Schema.Struct({
    sessionId: AuthSessionId,
  }),
});
export type AuthAccessStreamClientRemovedEvent = typeof AuthAccessStreamClientRemovedEvent.Type;

export const AuthAccessStreamEvent = Schema.Union([
  AuthAccessStreamSnapshotEvent,
  AuthAccessStreamPairingLinkUpsertedEvent,
  AuthAccessStreamPairingLinkRemovedEvent,
  AuthAccessStreamClientUpsertedEvent,
  AuthAccessStreamClientRemovedEvent,
]);
export type AuthAccessStreamEvent = typeof AuthAccessStreamEvent.Type;

export const AuthRevokePairingLinkInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type AuthRevokePairingLinkInput = typeof AuthRevokePairingLinkInput.Type;

export const AuthRevokeClientSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type AuthRevokeClientSessionInput = typeof AuthRevokeClientSessionInput.Type;

const pairingCredentialFields = {
  label: Schema.optionalKey(TrimmedNonEmptyString),
  scopes: Schema.optionalKey(AuthGrantScopes),
};

export const AuthCreatePairingCredentialInput = Schema.Struct({
  ...pairingCredentialFields,
  /**
   * Retired agent sign-in (`access`) and environment link (`purpose`) codes. Older clients still
   * send them, and the server refuses such a request rather than mint an ordinary credential.
   */
  access: Schema.optionalKey(AuthMcpClientAccess),
  purpose: Schema.optionalKey(Schema.Literal("peer-link")),
});
export type AuthCreatePairingCredentialInput = typeof AuthCreatePairingCredentialInput.Type;

export const AuthSessionState = Schema.Struct({
  authenticated: Schema.Boolean,
  auth: ServerAuthDescriptor,
  scopes: Schema.optionalKey(AuthEnvironmentScopes),
  permissions: authScopeResponseFields.permissions,
  sessionMethod: Schema.optionalKey(ServerAuthSessionMethod),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
});
export type AuthSessionState = typeof AuthSessionState.Type;
