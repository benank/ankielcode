import {
  AuthMcpApprovalError,
  AuthMcpAuthorizationRequest,
  AuthMcpClientAccess,
  AuthMcpClientRegistration,
  AuthMcpRegistrationError,
  EnvironmentHttpApi,
  mcpClientScopes,
  parseMcpApprovalCode,
} from "@ankielcode/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as McpOAuth from "./McpOAuth.ts";
import { renderConsentPage, renderErrorPage } from "./mcpOAuthHtml.ts";

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function approvalPage(html: string, status: number, redirectOrigin?: string) {
  const formAction = redirectOrigin ? `'self' ${redirectOrigin}` : "'none'";
  return HttpServerResponse.text(html, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: {
      ...PAGE_HEADERS,
      "content-security-policy": `${PAGE_HEADERS["content-security-policy"]}; form-action ${formAction}`,
    },
  });
}

// OAuth responses contain credentials and must not be cached.
const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, { "cache-control": "no-store", pragma: "no-cache" }),
  ),
);

const decodeAccess = Schema.decodeUnknownOption(AuthMcpClientAccess);
const requestUrls = Effect.map(HttpServerRequest.HttpServerRequest, McpOAuth.requestUrls);
const decodeAuthorizationRequest = Schema.decodeEffect(AuthMcpAuthorizationRequest);
// Decoded by the handler so malformed metadata gets the RFC 7591 error, not HttpApi's empty 400.
const decodeClientRegistration = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AuthMcpClientRegistration),
);

/**
 * An unverified client or redirect is reported, never redirected; any other problem goes back to
 * the agent through its (verified) redirect URI.
 */
const forwardedAuthorization =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (
    oauth: McpOAuth.McpOAuth["Service"],
    request: AuthMcpAuthorizationRequest,
  ) {
    const urls = yield* requestUrls;
    return yield* oauth.validateAuthorization({ urls, request }).pipe(
      Effect.catchTags({
        McpOAuthPageError: (error) =>
          Effect.fail(new AuthMcpApprovalError({ message: error.description })),
        McpOAuthRedirectError: (error) =>
          Effect.succeed({ redirectTo: McpOAuth.redirectForError(error, urls.issuer) }),
      }),
    );
  });

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mcpOAuth",
  Effect.fnUntraced(function* (handlers) {
    const oauth = yield* McpOAuth.McpOAuth;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const protectedResource = () =>
      requestUrls.pipe(Effect.map(McpOAuth.protectedResourceMetadata));

    const authorize = Effect.fn("McpOAuth.authorizePage")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const urls = yield* requestUrls;
      const url = new URL(request.url, urls.issuer);
      const authorizationRequest = yield* decodeAuthorizationRequest(
        Object.fromEntries(url.searchParams),
      ).pipe(Effect.orDie);
      const authorization = yield* oauth
        .validateAuthorization({ urls, request: authorizationRequest })
        .pipe(Effect.result);
      if (Result.isFailure(authorization)) {
        const error = authorization.failure;
        return error._tag === "McpOAuthPageError"
          ? approvalPage(renderErrorPage(error.description), 400)
          : HttpServerResponse.redirect(McpOAuth.redirectForError(error, urls.issuer), {
              headers: PAGE_HEADERS,
            });
      }

      const resolved = authorization.success;
      const redirect = new URL(resolved.redirectUri);
      const levels = AuthMcpClientAccess.literals;
      const page = (error?: string) =>
        approvalPage(
          renderConsentPage({
            clientName: resolved.client.name,
            environmentHost: url.host,
            redirectHost: redirect.host,
            levels,
            defaultAccess: "auto",
            error,
          }),
          error === undefined ? 200 : 400,
          redirect.origin,
        );

      if (request.method !== "POST") return page();
      const form = new URLSearchParams(yield* request.text.pipe(Effect.orDie));
      if (form.get("decision") === "deny") {
        return HttpServerResponse.redirect(oauth.deny(resolved), {
          status: 303,
          headers: PAGE_HEADERS,
        });
      }
      const code = form.get("code")?.trim() ?? "";
      const selectedAccess = decodeAccess(form.get("access"));
      const boundAccess = parseMcpApprovalCode(code)?.access;
      const access =
        boundAccess ?? (selectedAccess._tag === "Some" ? selectedAccess.value : undefined);
      if (
        form.get("decision") !== "approve" ||
        !code ||
        access === undefined ||
        !levels.includes(access)
      ) {
        return page("Enter a sign-in code and choose a permitted access level.");
      }
      return yield* oauth
        .approve({
          request,
          authorization: resolved,
          decision: { _tag: "pairing-code", code, access },
        })
        .pipe(
          Effect.map((location) =>
            HttpServerResponse.redirect(location, { status: 303, headers: PAGE_HEADERS }),
          ),
          Effect.catch((error) => Effect.succeed(page(error.message))),
        );
    });

    return handlers
      .handle("protectedResource", protectedResource)
      .handle("mcpProtectedResource", protectedResource)
      .handle("authorizationServer", () =>
        requestUrls.pipe(Effect.map(McpOAuth.authorizationServerMetadata)),
      )
      .handleRaw("register", ({ request }) =>
        request.text.pipe(
          Effect.orDie,
          Effect.flatMap(decodeClientRegistration),
          Effect.mapError(
            (cause) =>
              new AuthMcpRegistrationError({
                error: "invalid_client_metadata",
                error_description: `Invalid client metadata: ${cause.message}`,
              }),
          ),
          Effect.flatMap(oauth.register),
          Effect.map((client) => ({
            client_id: client.clientId,
            client_name: client.name,
            redirect_uris: client.redirectUris,
            grant_types: ["authorization_code" as const],
            response_types: ["code" as const],
            token_endpoint_auth_method: "none" as const,
          })),
          Effect.tap(() => noStore),
        ),
      )
      .handleRaw("authorize", ({ request }) => authorize(request))
      .handleRaw("authorizeForm", ({ request }) => authorize(request))
      .handle("approval", ({ payload, request }) =>
        Effect.gen(function* () {
          const resolved = yield* forwardedAuthorization(oauth, payload);
          if ("redirectTo" in resolved) return resolved;
          const urls = yield* requestUrls;
          const session = yield* oauth.approvingSession(request, resolved);
          yield* noStore;
          return {
            clientName: resolved.client.name,
            redirectHost: new URL(resolved.redirectUri).host,
            environmentHost: new URL(urls.issuer).host,
            ...(session === undefined
              ? {}
              : {
                  csrfToken: session.csrfToken,
                  oneClickAccess: AuthMcpClientAccess.literals.filter((access) =>
                    mcpClientScopes(access).every((scope) => session.scopes.includes(scope)),
                  ),
                }),
          };
        }),
      )
      .handle("decision", ({ payload, request }) =>
        Effect.gen(function* () {
          const resolved = yield* forwardedAuthorization(oauth, payload.authorization);
          if ("redirectTo" in resolved) return resolved;
          yield* noStore;
          const { decision } = payload;
          if (decision._tag === "deny") return { redirectTo: oauth.deny(resolved) };
          return yield* oauth.approve({ request, authorization: resolved, decision }).pipe(
            Effect.map((redirectTo) => ({ redirectTo })),
            Effect.mapError((error) => new AuthMcpApprovalError({ message: error.message })),
          );
        }),
      )
      .handle("token", ({ payload, request }) =>
        Effect.gen(function* () {
          yield* noStore;
          return yield* oauth.exchangeCode({ request, urls: yield* requestUrls, token: payload });
        }),
      )
      .handle("revoke", ({ payload }) =>
        Effect.gen(function* () {
          yield* noStore;
          // RFC 7009 §2.2: an unknown or already revoked token gets the same 200 as a revoked one.
          if (payload.token === undefined) return;
          yield* environmentAuth
            .revokeMcpClientToken(Redacted.value(payload.token))
            .pipe(Effect.orDie);
        }),
      );
  }),
);
