import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { authScopeResponse, AuthStandardClientScopes } from "@ankielcode/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { makeDpopKey } from "./dpop.testkit.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";

import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const TEST_SERVER_PORT = 13_773;

const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
        port: TEST_SERVER_PORT,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-auth-server-test-" })),
  );

const layerEnvironmentAuth = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig(overrides)),
  );

/** What `EnvironmentAuth.layer` needs, shared so stores built before and after it see the same rows. */
const layerAuthStorage = Layer.mergeAll(
  ServerSecretStore.layer,
  ServerEnvironment.layerIdentity,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provideMerge(layerServerConfig()));

const makeCookieRequest = (
  cookieName: string,
  sessionToken: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {
      [cookieName]: sessionToken,
    },
    headers: {},
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const makeBearerRequest = (
  token: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {},
    headers: {
      authorization: `Bearer ${token}`,
    },
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))(
  "EnvironmentAuth.layer",
  (it) => {
    it.effect("uses the reusable dev cookie without overriding a normal scoped cookie", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const token = "reusable-dev-auth-token-that-is-long-enough";
        const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
        const pairing = yield* serverAuth.issuePairingCredential({
          scopes: ["orchestration:read"],
        });
        const scopedExchange = yield* serverAuth.createBrowserSession(
          pairing.credential,
          requestMetadata,
        );
        const request = {
          cookies: {
            [sessions.cookieName]: scopedExchange.sessionToken,
            [devExchange.cookieName ?? "missing"]: devExchange.sessionToken,
          },
          headers: {},
        } as unknown as Parameters<
          EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
        >[0];

        const authenticated = yield* serverAuth.authenticateHttpRequest(request);
        expect(devExchange.cookieName).toMatch(/^ankiel_dev_session_/);
        expect(devExchange.expireNormalCookie).toBe(true);
        expect(devExchange.response).toMatchObject(authScopeResponse(AuthStandardClientScopes));
        expect(authenticated.scopes).toEqual(["orchestration:read"]);
      }).pipe(
        Effect.provide(
          layerEnvironmentAuth({
            mode: "web",
            devUrl: new URL("http://127.0.0.1:5173"),
            devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
          }),
        ),
      ),
    );

    it.effect("does not fall back to the dev cookie after a normal cookie is rejected", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const token = "reusable-dev-auth-token-that-is-long-enough";
        const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
        const pairing = yield* serverAuth.issuePairingCredential({
          scopes: ["orchestration:read"],
        });
        const scopedExchange = yield* serverAuth.createBrowserSession(
          pairing.credential,
          requestMetadata,
        );
        const scoped = yield* sessions.verify(scopedExchange.sessionToken);
        yield* sessions.revoke(scoped.sessionId);
        const request = {
          cookies: {
            [sessions.cookieName]: scopedExchange.sessionToken,
            [devExchange.cookieName ?? "missing"]: devExchange.sessionToken,
          },
          headers: {},
        } as unknown as Parameters<
          EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
        >[0];

        const error = yield* Effect.flip(serverAuth.authenticateHttpRequest(request));
        expect(error._tag).toBe("ServerAuthInvalidCredentialError");
      }).pipe(
        Effect.provide(
          layerEnvironmentAuth({
            mode: "web",
            devUrl: new URL("http://127.0.0.1:5173"),
            devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
          }),
        ),
      ),
    );

    it.effect("does not use the dev cookie when Authorization is invalid or empty", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const token = "reusable-dev-auth-token-that-is-long-enough";
        const devExchange = yield* serverAuth.createBrowserSession(token, requestMetadata);
        for (const authorization of [
          "Bearer invalid",
          "bearer invalid",
          "bEaReR invalid",
          "Basic invalid",
          "",
        ] as const) {
          const request = {
            cookies: { [devExchange.cookieName ?? "missing"]: devExchange.sessionToken },
            headers: { authorization },
          } as unknown as Parameters<
            EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
          >[0];
          const error = yield* Effect.flip(serverAuth.authenticateHttpRequest(request));
          expect(EnvironmentAuth.isServerAuthCredentialError(error)).toBe(true);
        }
      }).pipe(
        Effect.provide(
          layerEnvironmentAuth({
            mode: "web",
            devUrl: new URL("http://127.0.0.1:5173"),
            devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
          }),
        ),
      ),
    );

    it.effect("exchanges the reusable dev token for a local scoped OAuth session", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const token = "reusable-dev-auth-token-that-is-long-enough";
        const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          token,
          ["orchestration:read"],
          requestMetadata,
        );

        expect(exchanged.access_token).not.toBe(token);
        expect(exchanged.scope).toBe("orchestration:read");
        const dpop = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          token,
          ["orchestration:read"],
          requestMetadata,
          { proofKeyThumbprint: "test-proof-key" },
        );
        expect(dpop.access_token).not.toBe(token);
        expect(dpop.access_token).not.toBe(exchanged.access_token);
        expect(dpop.token_type).toBe("DPoP");
        expect(dpop.scope).toBe("orchestration:read");

        const secondBearer = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          token,
          ["orchestration:read"],
          requestMetadata,
        );
        const firstSession = yield* serverAuth.authenticateHttpRequest(
          makeBearerRequest(exchanged.access_token),
        );
        const secondSession = yield* serverAuth.authenticateHttpRequest(
          makeBearerRequest(secondBearer.access_token),
        );
        expect(firstSession.subject).toBe("reusable-dev-token-child");
        expect(secondSession.subject).toBe("reusable-dev-token-child");
        expect((yield* sessions.verify(token)).subject).toBe("reusable-dev-token");
        const before = yield* serverAuth.listClientSessions(firstSession.sessionId);
        const denied = yield* serverAuth
          .exchangeBootstrapCredentialForAccessToken(token, ["review:write"], requestMetadata)
          .pipe(Effect.flip);
        expect(denied._tag).toBe("ServerAuthScopeNotGrantedError");
        const empty = yield* serverAuth
          .exchangeBootstrapCredentialForAccessToken(token, [], requestMetadata)
          .pipe(Effect.flip);
        expect(empty._tag).toBe("ServerAuthScopeNotGrantedError");
        expect(yield* serverAuth.listClientSessions(firstSession.sessionId)).toEqual(before);
      }).pipe(
        Effect.provide(
          layerEnvironmentAuth({
            mode: "web",
            devUrl: new URL("http://127.0.0.1:5173"),
            devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
          }),
        ),
      ),
    );

    it.effect("uses a one-time startup credential after local dev token revocation", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const token = "reusable-dev-auth-token-that-is-long-enough";
        const initial = yield* serverAuth.issueStartupPairingCredential();
        const seeded = yield* sessions.verify(token);

        yield* sessions.revoke(seeded.sessionId);
        const recovery = yield* serverAuth.issueStartupPairingCredential();

        expect(initial.credential).toBe(token);
        expect(recovery.credential).not.toBe(token);
        expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe("SessionTokenRevokedError");
        expect(
          (yield* serverAuth.createBrowserSession(recovery.credential, requestMetadata)).response,
        ).toMatchObject({
          authenticated: true,
          ...authScopeResponse(AuthStandardClientScopes),
        });
      }).pipe(
        Effect.provide(
          layerEnvironmentAuth({
            mode: "web",
            devUrl: new URL("http://127.0.0.1:5173"),
            devAuthToken: Redacted.make("reusable-dev-auth-token-that-is-long-enough"),
          }),
        ),
      ),
    );

    it.effect("prefers a bearer token over an empty primary cookie", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const bearer = yield* serverAuth.issueSession();
        const verified = yield* serverAuth.authenticateHttpRequest({
          cookies: { [sessions.cookieName]: "" },
          headers: { authorization: `Bearer ${bearer.token}` },
        } as never);

        expect(verified.sessionId).toBe(bearer.sessionId);
      }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web", host: "192.168.1.50" }))),
    );

    it.effect("renews a pairing-link DPoP session in place while its device keeps using it", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const admin = yield* serverAuth.issueSession({ label: "Owner" });
        const key = makeDpopKey();
        const other = makeDpopKey();
        const pair = (proofKeyThumbprint?: string) =>
          serverAuth
            .issuePairingCredential({ scopes: ["orchestration:read"] })
            .pipe(
              Effect.flatMap((pairing) =>
                serverAuth.exchangeBootstrapCredentialForAccessToken(
                  pairing.credential,
                  undefined,
                  requestMetadata,
                  proofKeyThumbprint ? { proofKeyThumbprint } : undefined,
                ),
              ),
            );
        const sessionExpiry = (sessionId: string) =>
          serverAuth
            .listClientSessions(admin.sessionId)
            .pipe(
              Effect.map(
                (sessions) =>
                  sessions.find((session) => session.sessionId === sessionId)?.expiresAt
                    .epochMilliseconds,
              ),
            );

        const paired = yield* pair(key.thumbprint);
        expect(paired.expires_in).toBe(60 * 60);
        const { sessionId } = yield* sessions.verify(paired.access_token);
        const pairedAt = (yield* DateTime.now).epochMilliseconds;
        // Listed for the whole renewal window, so an idle device can still be revoked.
        expect(yield* sessionExpiry(sessionId)).toBe(pairedAt + 30 * 24 * 60 * 60 * 1000);

        yield* TestClock.adjust("20 days");
        const replay = new EnvironmentAuth.ServerAuthInvalidCredentialError({
          dpopFailureReason: "replay",
        });
        const rejected = yield* serverAuth
          .renewAccessToken(paired.access_token, key.thumbprint, Effect.fail(replay))
          .pipe(Effect.flip);
        expect(rejected).toBe(replay);
        expect(yield* sessionExpiry(sessionId)).toBe(pairedAt + 30 * 24 * 60 * 60 * 1000);

        const renewed = yield* serverAuth.renewAccessToken(
          paired.access_token,
          key.thumbprint,
          Effect.void,
        );
        expect(renewed.scope).toBe("orchestration:read");
        const verified = yield* sessions.verify(renewed.access_token);
        expect(verified.sessionId).toBe(sessionId);
        expect(yield* sessionExpiry(sessionId)).toBe(pairedAt + 50 * 24 * 60 * 60 * 1000);

        const refused = (token: string, thumbprint: string) =>
          serverAuth
            .renewAccessToken(
              token,
              thumbprint,
              Effect.die("Invalid credentials cannot consume a proof."),
            )
            .pipe(
              Effect.flip,
              Effect.map((error) => error._tag),
            );
        expect(yield* refused(renewed.access_token, other.thumbprint)).toBe(
          "ServerAuthInvalidCredentialError",
        );
        // Bearer sessions keep their fixed lifetimes.
        const bearer = yield* pair();
        expect(yield* refused(bearer.access_token, key.thumbprint)).toBe(
          "ServerAuthInvalidCredentialError",
        );

        // Inside the renewed window, so only the revocation can refuse it.
        expect(yield* serverAuth.revokeClientSession(admin.sessionId, sessionId)).toBe(true);
        expect(yield* refused(renewed.access_token, key.thumbprint)).toBe(
          "ServerAuthInvalidCredentialError",
        );

        // Idle past the window, the device pairs again.
        const idle = yield* pair(key.thumbprint);
        yield* TestClock.adjust("31 days");
        expect(yield* refused(idle.access_token, key.thumbprint)).toBe(
          "ServerAuthInvalidCredentialError",
        );
      }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web", host: "192.168.1.50" }))),
    );

    it.effect(
      "revokes outside-agent and link MCP sessions at startup and accepts none of them anywhere",
      () =>
        Effect.gen(function* () {
          const stores = yield* Layer.build(
            Layer.mergeAll(SessionStore.layer, PairingGrantStore.layer),
          );
          const sessions = Context.get(stores, SessionStore.SessionStore);
          const grants = Context.get(stores, PairingGrantStore.PairingGrantStore);
          const issueLegacy = (label: string) =>
            sessions.issue({
              subject: "mcp-client",
              method: "bearer-access-token",
              scopes: ["orchestration:read", "orchestration:operate"],
              client: { label, deviceType: "bot" },
            });
          const outsideAgent = yield* issueLegacy("ChatGPT");
          const peerLink = yield* issueLegacy("Ankiel Code · laptop");
          const approvalCode = yield* grants.issueOneTimeToken({ subject: "mcp-approval:auto" });

          // The server starting after the upgrade.
          const serverAuth = Context.get(
            yield* Layer.build(EnvironmentAuth.layer),
            EnvironmentAuth.EnvironmentAuth,
          );
          const active = (yield* sessions.listActive()).map((session) => session.sessionId);
          expect(active).not.toContain(outsideAgent.sessionId);
          expect(active).not.toContain(peerLink.sessionId);
          expect((yield* grants.listActive()).map((link) => link.id)).not.toContain(
            approvalCode.id,
          );

          // One issued past the sweep is still refused by HTTP auth and by `/mcp`.
          const straggler = yield* issueLegacy("Claude Code");
          for (const session of [outsideAgent, straggler]) {
            const request = makeBearerRequest(session.token);
            expect(
              (yield* serverAuth.authenticateHttpRequest(request).pipe(Effect.flip))._tag,
            ).toBe("ServerAuthInvalidCredentialError");
            expect(
              (yield* serverAuth.authenticateCliMcpClient(request).pipe(Effect.flip))._tag,
            ).toBe("ServerAuthInvalidCredentialError");
          }

          // The CLI's own session reaches `/mcp` and nothing else.
          const cli = yield* serverAuth.issueCliMcpClientSession({ label: "ankiel thread cli" });
          expect(
            (yield* serverAuth.authenticateCliMcpClient(makeBearerRequest(cli.token))).sessionId,
          ).toBe(cli.sessionId);
          expect(
            (yield* serverAuth
              .authenticateHttpRequest(makeBearerRequest(cli.token))
              .pipe(Effect.flip))._tag,
          ).toBe("ServerAuthInvalidCredentialError");
        }).pipe(Effect.scoped, Effect.provide(layerAuthStorage)),
    );

    it.effect("preserves pairing grants after rejecting scopes they do not grant", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const pairingCredential = yield* serverAuth.issuePairingCredential({
          scopes: ["orchestration:read", "orchestration:operate"],
        });

        const error = yield* serverAuth
          .exchangeBootstrapCredentialForAccessToken(
            pairingCredential.credential,
            ["access:write"],
            requestMetadata,
          )
          .pipe(Effect.flip);

        expect(error._tag).toBe("ServerAuthScopeNotGrantedError");
        expect((yield* serverAuth.listPairingLinks()).map((link) => link.id)).toContain(
          pairingCredential.id,
        );
        expect(yield* serverAuth.listSessions()).toEqual([]);

        const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          pairingCredential.credential,
          ["orchestration:read"],
          requestMetadata,
        );
        const session = yield* serverAuth.authenticateHttpRequest(
          makeBearerRequest(token.access_token),
        );

        expect(token.scope).toBe("orchestration:read");
        expect(session.scopes).toEqual(["orchestration:read"]);
        expect((yield* serverAuth.listPairingLinks()).map((link) => link.id)).not.toContain(
          pairingCredential.id,
        );
        const reused = yield* serverAuth
          .exchangeBootstrapCredentialForAccessToken(
            pairingCredential.credential,
            ["orchestration:read"],
            requestMetadata,
          )
          .pipe(Effect.flip);
        expect(reused._tag).toBe("ServerAuthInvalidCredentialError");
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect.each([
      { label: "omits scope", requestedScopes: undefined },
      {
        label: "requests unsupported permissions alongside a granted one",
        requestedScopes: ["orchestration:read", "access:write"] as const,
      },
    ])("inherits a constrained pairing grant when token exchange $label", ({ requestedScopes }) =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const pairingCredential = yield* serverAuth.issuePairingCredential({
          scopes: ["orchestration:read"],
        });

        const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          pairingCredential.credential,
          requestedScopes,
          requestMetadata,
        );

        expect(token.scope).toBe("orchestration:read");
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect("narrows seeded desktop grants to the requested scopes", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          "desktop-bootstrap-token",
          ["orchestration:read"],
          requestMetadata,
        );
        const session = yield* serverAuth.authenticateHttpRequest(
          makeBearerRequest(token.access_token),
        );

        expect(token.scope).toBe("orchestration:read");
        expect(session.scopes).toEqual(["orchestration:read"]);
      }).pipe(
        Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
      ),
    );

    it.effect("rotates desktop bearer sessions without accumulating authorized clients", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const browser = yield* serverAuth.createBrowserSession(
          "desktop-bootstrap-token",
          requestMetadata,
        );
        const browserSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(sessions.cookieName, browser.sessionToken),
        );
        const staleSessions = yield* Effect.forEach([1, 2, 3], () =>
          sessions.issue({ subject: "desktop-bootstrap", method: "bearer-access-token" }),
        );
        const pairing = yield* serverAuth.issuePairingCredential();
        const paired = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          pairing.credential,
          undefined,
          { ...requestMetadata, label: "Ankiel Code Desktop" },
        );
        const first = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          "desktop-bootstrap-token",
          undefined,
          requestMetadata,
        );
        const firstSession = yield* serverAuth.authenticateHttpRequest(
          makeBearerRequest(first.access_token),
        );
        const second = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          "desktop-bootstrap-token",
          undefined,
          requestMetadata,
        );

        const active = yield* serverAuth.listSessions();
        const firstError = yield* serverAuth
          .authenticateHttpRequest(makeBearerRequest(first.access_token))
          .pipe(Effect.flip);
        const secondSession = yield* serverAuth.authenticateHttpRequest(
          makeBearerRequest(second.access_token),
        );

        expect(active).toHaveLength(3);
        expect(active.map((entry) => entry.sessionId)).toContain(browserSession.sessionId);
        expect(active.map((entry) => entry.sessionId)).toContain(secondSession.sessionId);
        expect(active.map((entry) => entry.sessionId)).not.toContain(firstSession.sessionId);
        expect(firstError._tag).toBe("ServerAuthInvalidCredentialError");
        for (const stale of staleSessions) {
          const error = yield* sessions.verify(stale.token).pipe(Effect.flip);
          expect(error._tag).toBe("SessionTokenRevokedError");
        }
        const pairedSession = yield* serverAuth.authenticateHttpRequest(
          makeBearerRequest(paired.access_token),
        );
        expect(pairedSession.subject).toBe("one-time-token");
        expect(active.map((entry) => entry.sessionId)).toContain(pairedSession.sessionId);
      }).pipe(
        Effect.provide(
          layerEnvironmentAuth({
            desktopBootstrapToken: "desktop-bootstrap-token",
          }),
        ),
      ),
    );

    it.effect("issues startup pairing URLs that bootstrap administrative sessions", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;

        const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
        const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
        const listedPairingLinks = yield* serverAuth.listPairingLinks();
        expect(token).toBeTruthy();
        expect(
          listedPairingLinks.some(
            (pairingLink) => pairingLink.subject === "administrative-bootstrap",
          ),
        ).toBe(false);

        const exchanged = yield* serverAuth.createBrowserSession(token ?? "", requestMetadata);
        const verified = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(sessions.cookieName, exchanged.sessionToken),
        );

        expect(verified.scopes).toEqual(AuthStandardClientScopes);
        expect(verified.subject).toBe("administrative-bootstrap");
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect(
      "lists pairing links and revokes other sessions while keeping the administrative session",
      () =>
        Effect.gen(function* () {
          const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
          const sessions = yield* SessionStore.SessionStore;

          const administrativeExchange = yield* serverAuth.createBrowserSession(
            "desktop-bootstrap-token",
            requestMetadata,
          );
          const administrativeSession = yield* serverAuth.authenticateHttpRequest(
            makeCookieRequest(sessions.cookieName, administrativeExchange.sessionToken),
          );
          const pairingCredential = yield* serverAuth.issuePairingCredential({
            label: "Alex iPhone",
          });
          const listedPairingLinks = yield* serverAuth.listPairingLinks();
          const clientExchange = yield* serverAuth.createBrowserSession(
            pairingCredential.credential,
            {
              ...requestMetadata,
              deviceType: "mobile",
              os: "iOS",
              browser: "Safari",
              ipAddress: "192.168.1.88",
            },
          );
          const clientSession = yield* serverAuth.authenticateHttpRequest(
            makeCookieRequest(sessions.cookieName, clientExchange.sessionToken),
          );
          const clientsBeforeRevoke = yield* serverAuth.listClientSessions(
            administrativeSession.sessionId,
          );
          const unspentCode = yield* serverAuth.issuePairingCredential({ label: "unspent" });
          const revokedCount = yield* serverAuth.revokeOtherClientSessions(
            administrativeSession.sessionId,
          );
          const clientsAfterRevoke = yield* serverAuth.listClientSessions(
            administrativeSession.sessionId,
          );
          expect(
            (yield* serverAuth
              .createBrowserSession(unspentCode.credential, requestMetadata)
              .pipe(Effect.exit))._tag,
          ).toBe("Failure");

          expect(listedPairingLinks.map((entry) => entry.id)).toContain(pairingCredential.id);
          expect(listedPairingLinks.find((entry) => entry.id === pairingCredential.id)?.label).toBe(
            "Alex iPhone",
          );
          expect(clientsBeforeRevoke).toHaveLength(2);
          expect(
            clientsBeforeRevoke.find((entry) => entry.sessionId === administrativeSession.sessionId)
              ?.current,
          ).toBe(true);
          expect(
            clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)
              ?.current,
          ).toBe(false);
          expect(
            clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
              .label,
          ).toBe("Alex iPhone");
          expect(
            clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
              .deviceType,
          ).toBe("mobile");
          expect(revokedCount).toBe(1);
          expect(clientsAfterRevoke).toHaveLength(1);
          expect(clientsAfterRevoke[0]?.sessionId).toBe(administrativeSession.sessionId);
        }).pipe(
          Effect.provide(
            layerEnvironmentAuth({
              desktopBootstrapToken: "desktop-bootstrap-token",
            }),
          ),
        ),
    );

    it.effect("issues no session to an exchange that revoking all others overtook", () =>
      Effect.gen(function* () {
        const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
        let afterSpend: Effect.Effect<void> = Effect.void;
        const serverAuth = yield* EnvironmentAuth.make.pipe(
          Effect.provideService(PairingGrantStore.PairingGrantStore, {
            ...pairingLinks,
            consume: (credential, input) =>
              pairingLinks.consume(credential, input).pipe(Effect.tap(() => afterSpend)),
          }),
          Effect.provide(ServerSecretStore.layer.pipe(Layer.provideMerge(layerServerConfig()))),
        );
        const owner = yield* serverAuth.issueSession();
        const succeeded = { onFailure: () => false, onSuccess: () => true };
        const exchanges = [
          (credential: string) =>
            serverAuth
              .createBrowserSession(credential, requestMetadata)
              .pipe(Effect.match(succeeded)),
          (credential: string) =>
            serverAuth
              .exchangeBootstrapCredentialForAccessToken(credential, undefined, requestMetadata)
              .pipe(Effect.match(succeeded)),
        ];
        for (const exchange of exchanges) {
          const pairing = yield* serverAuth.issuePairingCredential();
          afterSpend = serverAuth.revokeOtherClientSessions(owner.sessionId).pipe(Effect.orDie);
          const exchanged = yield* exchange(pairing.credential);
          afterSpend = Effect.void;

          expect(exchanged).toBe(false);
          expect((yield* serverAuth.listSessions()).map((session) => session.sessionId)).toEqual([
            owner.sessionId,
          ]);
        }
      }).pipe(Effect.provide(layerEnvironmentAuth())),
    );

    it.effect("accepts cookie sessions on socket upgrades only from the app's own origins", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const pairing = yield* serverAuth.issuePairingCredential();
        const exchanged = yield* serverAuth.createBrowserSession(
          pairing.credential,
          requestMetadata,
        );
        const upgrade = (headers: Record<string, string>) =>
          serverAuth.authenticateWebSocketUpgrade(
            {
              url: "/ws",
              cookies: { [sessions.cookieName]: exchanged.sessionToken },
              headers: { host: "192.168.1.50:3773", ...headers },
            } as never,
            "rpc",
          );

        yield* upgrade({ origin: "http://192.168.1.50:3773" });
        yield* upgrade({
          origin: "https://box.tail1234.ts.net",
          "x-forwarded-host": "box.tail1234.ts.net",
        });
        yield* upgrade({ origin: "ankielcode://app" });
        yield* upgrade({ origin: "http://localhost:5733" });
        yield* upgrade({});

        const otherPort = yield* Effect.flip(upgrade({ origin: "http://192.168.1.50:8080" }));
        expect(otherPort._tag).toBe("ServerAuthInvalidCredentialError");
        const opaque = yield* Effect.flip(upgrade({ origin: "null" }));
        expect(opaque._tag).toBe("ServerAuthInvalidCredentialError");
      }).pipe(
        Effect.provide(
          layerEnvironmentAuth({
            mode: "web",
            host: "192.168.1.50",
            devUrl: new URL("http://localhost:5733"),
          }),
        ),
      ),
    );

    it.effect("accepts cookie sessions on HTTP requests only from the app's own origins", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const pairing = yield* serverAuth.issuePairingCredential();
        const exchanged = yield* serverAuth.createBrowserSession(
          pairing.credential,
          requestMetadata,
        );
        const post = (headers: Record<string, string>) =>
          serverAuth.authenticateHttpRequest({
            cookies: { [sessions.cookieName]: exchanged.sessionToken },
            headers: { host: "localhost:13773", ...headers },
          } as never);

        yield* post({ origin: "http://192.168.1.50:5733", "sec-fetch-site": "same-origin" });
        yield* post({ origin: "http://localhost:13773" });

        const otherPort = yield* Effect.flip(
          post({ origin: "http://localhost:3000", "sec-fetch-site": "same-site" }),
        );
        expect(otherPort._tag).toBe("ServerAuthInvalidCredentialError");
        const state = yield* serverAuth.getSessionState({
          cookies: { [sessions.cookieName]: exchanged.sessionToken },
          headers: { host: "localhost:13773", origin: "http://localhost:3000" },
        } as never);
        expect(state.authenticated).toBe(false);
      }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web" }))),
    );

    it.effect.each(["Bearer", "bearer", "bEaReR"])(
      "accepts %s for HTTP and socket upgrades regardless of page origin",
      (scheme) =>
        Effect.gen(function* () {
          const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
          const bearer = yield* serverAuth.issueSession();
          const request = {
            url: "/ws",
            cookies: {},
            headers: {
              host: "192.168.1.50:3773",
              origin: "http://192.168.1.50:8080",
              authorization: `${scheme} ${bearer.token}`,
            },
          } as never;
          const verified = yield* serverAuth.authenticateWebSocketUpgrade(request, "rpc");
          expect(verified.sessionId).toBe(bearer.sessionId);
          expect((yield* serverAuth.authenticateHttpRequest(request)).sessionId).toBe(
            bearer.sessionId,
          );
        }).pipe(Effect.provide(layerEnvironmentAuth({ mode: "web", host: "192.168.1.50" }))),
    );

    it.effect("binds a DPoP session's RPC socket ticket to its proof key", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const key = makeDpopKey();
        const other = makeDpopKey();
        const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          "desktop-bootstrap-token",
          ["orchestration:read"],
          requestMetadata,
          { proofKeyThumbprint: key.thumbprint },
        );
        const session = yield* sessions.verify(exchanged.access_token);
        const host = "192.168.1.50:3773";
        const socketUrl = `http://${host}/ws`;
        const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
        const upgrade = (ticket: string, use: "rpc" | "media", proof?: string) =>
          serverAuth.authenticateWebSocketUpgrade(
            {
              method: "GET",
              url: `/ws?orchestrationProtocol=2&wsTicket=${ticket}${proof ? `&dpop=${proof}` : ""}`,
              cookies: {},
              headers: { host },
            } as never,
            use,
          );

        const rpc = yield* serverAuth.issueWebSocketTicket(session, { use: "rpc" });
        const bare = yield* Effect.flip(upgrade(Redacted.value(rpc.ticket), "rpc"));
        expect(bare._tag).toBe("ServerAuthInvalidCredentialError");
        const signed = yield* upgrade(
          Redacted.value(rpc.ticket),
          "rpc",
          key.sign({ method: "GET", url: socketUrl, token: Redacted.value(rpc.ticket), iat }),
        );
        expect(signed.sessionId).toBe(session.sessionId);

        const wrongKey = yield* Effect.flip(
          upgrade(
            Redacted.value(rpc.ticket),
            "rpc",
            other.sign({ method: "GET", url: socketUrl, token: Redacted.value(rpc.ticket), iat }),
          ),
        );
        expect(wrongKey._tag).toBe("ServerAuthInvalidCredentialError");
        const onMedia = yield* Effect.flip(
          upgrade(
            Redacted.value(rpc.ticket),
            "media",
            key.sign({ method: "GET", url: socketUrl, token: Redacted.value(rpc.ticket), iat }),
          ),
        );
        expect(onMedia._tag).toBe("ServerAuthInvalidCredentialError");

        const media = yield* serverAuth.issueWebSocketTicket(session, { use: "media" });
        expect((yield* upgrade(Redacted.value(media.ticket), "media")).sessionId).toBe(
          session.sessionId,
        );
        const mediaOnRpc = yield* Effect.flip(upgrade(Redacted.value(media.ticket), "rpc"));
        expect(mediaOnRpc._tag).toBe("ServerAuthInvalidCredentialError");

        // Clients that predate ticket binding still connect with the unbound ticket they mint.
        const legacy = yield* serverAuth.issueWebSocketTicket(session);
        expect((yield* upgrade(Redacted.value(legacy.ticket), "rpc")).sessionId).toBe(
          session.sessionId,
        );
      }).pipe(
        Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
      ),
    );

    it.effect.each(["DPoP", "dpop", "dPoP"])(
      "accepts %s for a proof-bound HTTP request",
      (scheme) =>
        Effect.gen(function* () {
          const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
          const key = makeDpopKey();
          const { access_token: token } =
            yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
              "desktop-bootstrap-token",
              ["orchestration:read"],
              requestMetadata,
              { proofKeyThumbprint: key.thumbprint },
            );
          const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
          const request = {
            method: "GET",
            url: "/api/auth/session",
            cookies: {},
            headers: {
              host: "192.168.1.50:3773",
              authorization: `${scheme} ${token}`,
              dpop: key.sign({
                method: "GET",
                url: "http://192.168.1.50:3773/api/auth/session",
                token,
                iat,
              }),
            },
          } as never;
          expect((yield* serverAuth.authenticateHttpRequest(request)).sessionId).toBeTypeOf(
            "string",
          );
        }).pipe(
          Effect.provide(
            layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" }),
          ),
        ),
    );

    it.effect("rejects a replayed proof on a bound RPC socket ticket", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const key = makeDpopKey();
        const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          "desktop-bootstrap-token",
          ["orchestration:read"],
          requestMetadata,
          { proofKeyThumbprint: key.thumbprint },
        );
        const session = yield* sessions.verify(exchanged.access_token);
        const rpc = yield* serverAuth.issueWebSocketTicket(session, { use: "rpc" });
        const request = {
          method: "GET",
          url: `/ws?wsTicket=${Redacted.value(rpc.ticket)}&dpop=${key.sign({
            method: "GET",
            url: "http://192.168.1.50:3773/ws",
            token: Redacted.value(rpc.ticket),
            iat: Math.floor((yield* DateTime.now).epochMilliseconds / 1_000),
          })}`,
          cookies: {},
          headers: { host: "192.168.1.50:3773" },
        } as never;

        yield* serverAuth.authenticateWebSocketUpgrade(request, "rpc");
        const replayed = yield* Effect.flip(
          serverAuth.authenticateWebSocketUpgrade(request, "rpc"),
        );
        expect(replayed._tag).toBe("ServerAuthInvalidCredentialError");
        if (replayed._tag === "ServerAuthInvalidCredentialError") {
          expect(replayed.dpopFailureReason).toBe("replay");
        }
      }).pipe(
        Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
      ),
    );

    it.effect("re-checks approver scopes when approving a claimed pairing invite", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          "desktop-bootstrap-token",
          ["access:write", "orchestration:read", "orchestration:operate"],
          requestMetadata,
        );
        const session = yield* sessions.verify(exchanged.access_token);
        const fullPrincipal = {
          sessionId: session.sessionId,
          subject: session.subject,
          method: session.method,
          scopes: new Set(session.scopes),
        };
        const created = yield* serverAuth.createPairingInvite(fullPrincipal, {
          scopes: ["orchestration:read", "orchestration:operate"],
        });

        const key = makeDpopKey();
        const url = `http://127.0.0.1/api/auth/pairing-invites/${created.inviteId}/claim`;
        const claimRequest = {
          method: "POST",
          url: `/api/auth/pairing-invites/${created.inviteId}/claim`,
          originalUrl: `/api/auth/pairing-invites/${created.inviteId}/claim`,
          protocol: "http",
          cookies: {},
          headers: {
            host: "127.0.0.1",
            dpop: key.sign({
              method: "POST",
              url,
              token: "",
              iat: Math.floor((yield* DateTime.now).epochMilliseconds / 1_000),
            }),
          },
        } as never;
        const claimed = yield* serverAuth.claimPairingInvite(claimRequest, created.inviteId, {
          clientLabel: "Test iPhone",
          clientDeviceType: "mobile",
          clientOs: "iOS",
        });

        const narrowedPrincipal = {
          ...fullPrincipal,
          scopes: new Set(["access:write", "orchestration:read"] as const),
        };
        const denied = yield* Effect.flip(
          serverAuth.approvePairingInvite(narrowedPrincipal, created.inviteId, {
            verificationCode: claimed.verificationCode,
          }),
        );
        expect(denied._tag).toBe("PairingInviteScopeRequiredError");
        if (denied._tag === "PairingInviteScopeRequiredError") {
          expect(denied.scope).toBe("orchestration:operate");
        }

        const approved = yield* serverAuth.approvePairingInvite(fullPrincipal, created.inviteId, {
          verificationCode: claimed.verificationCode,
        });
        expect(approved.status).toBe("approved");
      }).pipe(
        Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
      ),
    );

    it.effect(
      "evicts pairing invites and revokes approved grants when revoking client sessions",
      () =>
        Effect.gen(function* () {
          const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
          const sessions = yield* SessionStore.SessionStore;
          const makePrincipal = (token: string) =>
            sessions.verify(token).pipe(
              Effect.map((session) => ({
                sessionId: session.sessionId,
                subject: session.subject,
                method: session.method,
                scopes: new Set(session.scopes),
                ...(session.proofKeyThumbprint
                  ? { proofKeyThumbprint: session.proofKeyThumbprint }
                  : {}),
              })),
            );
          const makeClaimRequest = (
            method: "POST" | "GET",
            inviteId: string,
            key: ReturnType<typeof makeDpopKey>,
          ) =>
            DateTime.now.pipe(
              Effect.map(
                (now) =>
                  ({
                    method,
                    url: `/api/auth/pairing-invites/${inviteId}/claim`,
                    originalUrl: `/api/auth/pairing-invites/${inviteId}/claim`,
                    protocol: "http",
                    cookies: {},
                    headers: {
                      host: "127.0.0.1",
                      dpop: key.sign({
                        method,
                        url: `http://127.0.0.1/api/auth/pairing-invites/${inviteId}/claim`,
                        token: "",
                        iat: Math.floor(now.epochMilliseconds / 1_000),
                      }),
                    },
                  }) as never,
              ),
            );

          const admin = yield* makePrincipal((yield* serverAuth.issueSession()).token);
          const dpopOwnerKey = makeDpopKey();
          const dpopOwnerToken = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
            "desktop-bootstrap-token",
            undefined,
            requestMetadata,
            { proofKeyThumbprint: dpopOwnerKey.thumbprint },
          );
          const dpopOwner = yield* makePrincipal(dpopOwnerToken.access_token);
          const claimantKey = makeDpopKey();

          // 1. revokeClientSession evicts pending, claimed, and approved invites owned by the revoked session.
          const pendingInvite = yield* serverAuth.createPairingInvite(dpopOwner, {});
          const claimedInvite = yield* serverAuth.createPairingInvite(dpopOwner, {});
          const claimed = yield* serverAuth.claimPairingInvite(
            yield* makeClaimRequest("POST", claimedInvite.inviteId, claimantKey),
            claimedInvite.inviteId,
            {},
          );
          const approvedInvite = yield* serverAuth.createPairingInvite(dpopOwner, {});
          const approvedClaim = yield* serverAuth.claimPairingInvite(
            yield* makeClaimRequest("POST", approvedInvite.inviteId, claimantKey),
            approvedInvite.inviteId,
            {},
          );
          yield* serverAuth.approvePairingInvite(dpopOwner, approvedInvite.inviteId, {
            verificationCode: approvedClaim.verificationCode,
          });
          const approvedStatus = yield* serverAuth.getPairingInviteClaim(
            yield* makeClaimRequest("GET", approvedInvite.inviteId, claimantKey),
            approvedInvite.inviteId,
          );
          expect(approvedStatus.status).toBe("approved");
          if (approvedStatus.status !== "approved") throw new Error("Expected approved invite");

          expect(yield* serverAuth.revokeClientSession(admin.sessionId, dpopOwner.sessionId)).toBe(
            true,
          );

          expect(
            (yield* Effect.flip(serverAuth.getPairingInvite(dpopOwner, pendingInvite.inviteId)))
              ._tag,
          ).toBe("PairingInviteNotFoundError");
          expect(
            (yield* Effect.flip(
              serverAuth.approvePairingInvite(dpopOwner, claimedInvite.inviteId, {
                verificationCode: claimed.verificationCode,
              }),
            ))._tag,
          ).toBe("PairingInviteNotFoundError");
          expect(
            (yield* Effect.flip(
              serverAuth.getPairingInviteClaim(
                yield* makeClaimRequest("GET", approvedInvite.inviteId, claimantKey),
                approvedInvite.inviteId,
              ),
            ))._tag,
          ).toBe("PairingInviteNotFoundError");
          expect(
            (yield* Effect.flip(
              serverAuth.exchangeBootstrapCredentialForAccessToken(
                approvedStatus.credential,
                undefined,
                requestMetadata,
                { proofKeyThumbprint: claimantKey.thumbprint },
              ),
            ))._tag,
          ).toBe("ServerAuthInvalidCredentialError");
          expect(yield* serverAuth.listPairingLinks()).toEqual([]);

          // 2. revokeOtherClientSessions evicts other sessions' invites and keeps the caller's own.
          const other = yield* makePrincipal((yield* serverAuth.issueSession()).token);
          const otherInvite = yield* serverAuth.createPairingInvite(other, {});
          const otherClaim = yield* serverAuth.claimPairingInvite(
            yield* makeClaimRequest("POST", otherInvite.inviteId, claimantKey),
            otherInvite.inviteId,
            {},
          );
          const adminInvite = yield* serverAuth.createPairingInvite(admin, {});

          expect(yield* serverAuth.revokeOtherClientSessions(admin.sessionId)).toBe(1);
          expect(
            (yield* Effect.flip(
              serverAuth.approvePairingInvite(other, otherInvite.inviteId, {
                verificationCode: otherClaim.verificationCode,
              }),
            ))._tag,
          ).toBe("PairingInviteNotFoundError");
          expect((yield* serverAuth.getPairingInvite(admin, adminInvite.inviteId)).status).toBe(
            "pending",
          );
          expect(yield* serverAuth.listPairingLinks()).toEqual([]);
        }).pipe(
          Effect.provide(
            layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" }),
          ),
        ),
    );

    it.effect(
      "prevents approvePairingInvite overtaken by revokeOtherClientSessions from minting a grant",
      () =>
        Effect.gen(function* () {
          const pairingLinks = yield* PairingGrantStore.PairingGrantStore;
          const sessions = yield* SessionStore.SessionStore;
          const revokeEntered = yield* Deferred.make<void>();
          const releaseRevoke = yield* Deferred.make<void>();
          let gateRevoke = false;
          const serverAuth = yield* EnvironmentAuth.make.pipe(
            Effect.provideService(PairingGrantStore.PairingGrantStore, {
              ...pairingLinks,
              revokeUnspentLinksExcept: (keepProofKeyThumbprint) =>
                Effect.gen(function* () {
                  if (gateRevoke) {
                    yield* Deferred.succeed(revokeEntered, undefined);
                    yield* Deferred.await(releaseRevoke);
                  }
                  return yield* pairingLinks.revokeUnspentLinksExcept(keepProofKeyThumbprint);
                }),
            }),
            Effect.provide(ServerSecretStore.layer.pipe(Layer.provideMerge(layerServerConfig()))),
          );

          const ownerIssued = yield* serverAuth.issueSession();
          const ownerSession = yield* sessions.verify(ownerIssued.token);
          const owner = {
            sessionId: ownerSession.sessionId,
            subject: ownerSession.subject,
            method: ownerSession.method,
            scopes: new Set(ownerSession.scopes),
          };
          const invite = yield* serverAuth.createPairingInvite(owner, {});
          const claimantKey = makeDpopKey();
          const claimed = yield* serverAuth.claimPairingInvite(
            {
              method: "POST",
              url: `/api/auth/pairing-invites/${invite.inviteId}/claim`,
              originalUrl: `/api/auth/pairing-invites/${invite.inviteId}/claim`,
              protocol: "http",
              cookies: {},
              headers: {
                host: "127.0.0.1",
                dpop: claimantKey.sign({
                  method: "POST",
                  url: `http://127.0.0.1/api/auth/pairing-invites/${invite.inviteId}/claim`,
                  token: "",
                  iat: Math.floor((yield* DateTime.now).epochMilliseconds / 1_000),
                }),
              },
            } as never,
            invite.inviteId,
            {},
          );

          gateRevoke = true;
          const revokeFiber = yield* Effect.forkScoped(
            serverAuth.revokeOtherClientSessions(owner.sessionId),
          );
          yield* Deferred.await(revokeEntered);

          // Starts before revokeOtherClientSessions increments otherSessionRevocations, then waits on sessionIssueLock.
          const approveFiber = yield* Effect.forkScoped(
            serverAuth.approvePairingInvite(owner, invite.inviteId, {
              verificationCode: claimed.verificationCode,
            }),
          );
          yield* Effect.yieldNow;
          yield* Deferred.succeed(releaseRevoke, undefined);

          yield* Fiber.join(revokeFiber);
          const approveError = yield* Effect.flip(Fiber.join(approveFiber));
          expect(approveError._tag).toBe("PairingInviteForbiddenError");
          if (approveError._tag === "PairingInviteForbiddenError") {
            expect(approveError.reason).toBe("pairing_invite_invalid_state");
          }
          expect(yield* serverAuth.listPairingLinks()).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(layerEnvironmentAuth())),
    );

    it.effect(
      "retains denied pairing invites until grantExpiresAt so late denials return denied instead of 404",
      () =>
        Effect.gen(function* () {
          const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
          const sessions = yield* SessionStore.SessionStore;
          const ownerIssued = yield* serverAuth.issueSession();
          const ownerSession = yield* sessions.verify(ownerIssued.token);
          const owner = {
            sessionId: ownerSession.sessionId,
            subject: ownerSession.subject,
            method: ownerSession.method,
            scopes: new Set(ownerSession.scopes),
          };
          const claimantKey = makeDpopKey();
          const makeClaimRequest = (method: "POST" | "GET", inviteId: string) =>
            DateTime.now.pipe(
              Effect.map(
                (now) =>
                  ({
                    method,
                    url: `/api/auth/pairing-invites/${inviteId}/claim`,
                    originalUrl: `/api/auth/pairing-invites/${inviteId}/claim`,
                    protocol: "http",
                    cookies: {},
                    headers: {
                      host: "127.0.0.1",
                      dpop: claimantKey.sign({
                        method,
                        url: `http://127.0.0.1/api/auth/pairing-invites/${inviteId}/claim`,
                        token: "",
                        iat: Math.floor(now.epochMilliseconds / 1_000),
                      }),
                    },
                  }) as never,
              ),
            );

          const invite = yield* serverAuth.createPairingInvite(owner, {});
          // Claim and approve near the end of the invite TTL so grantExpiresAt extends past invite.expiresAt.
          yield* TestClock.adjust(Duration.seconds(100));
          const claimed = yield* serverAuth.claimPairingInvite(
            yield* makeClaimRequest("POST", invite.inviteId),
            invite.inviteId,
            {},
          );
          yield* serverAuth.approvePairingInvite(owner, invite.inviteId, {
            verificationCode: claimed.verificationCode,
          });

          // Move past invite.expiresAt (120s) while still inside grantExpiresAt (220s), deny, and trigger prune.
          yield* TestClock.adjust(Duration.seconds(30));
          const denied = yield* serverAuth.denyPairingInvite(owner, invite.inviteId);
          expect(denied).toEqual({ status: "denied" });
          yield* serverAuth.createPairingInvite(owner, {});

          const poll = yield* serverAuth.getPairingInviteClaim(
            yield* makeClaimRequest("GET", invite.inviteId),
            invite.inviteId,
          );
          expect(poll).toEqual({ status: "denied" });

          // Once grantExpiresAt (220s) has elapsed, pruning removes the terminal invite.
          yield* TestClock.adjust(Duration.seconds(95));
          yield* serverAuth.createPairingInvite(owner, {});
          const pruned = yield* Effect.flip(
            serverAuth.getPairingInviteClaim(
              yield* makeClaimRequest("GET", invite.inviteId),
              invite.inviteId,
            ),
          );
          expect(pruned._tag).toBe("PairingInviteNotFoundError");
        }).pipe(Effect.provide(layerEnvironmentAuth())),
    );
  },
);
