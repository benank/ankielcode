// @effect-diagnostics nodeBuiltinImport:off - Path-routed relay DPoP test uses local node:http/fs fixtures.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import {
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  EnvironmentHttpApi,
} from "@ankielcode/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  BINARY_FRAME_HTTP_REQ_BODY,
  decodeBinaryFrame,
  encodeBinaryFrame,
  parseRelaySetupString,
} from "../relay/relayProtocol.ts";
import {
  loadOrCreateRelayHostIdentity,
  startRelayTunnelClient,
} from "../relay/RelayTunnelClient.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { makeDpopKey } from "./dpop.testkit.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-auth-http-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(layerEnvironmentAuth),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.promise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const retiredScopeResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "review:write",
              }),
            }),
            requestContext,
          );
          expect(retiredScopeResponse.status).toBe(400);
          expect(await retiredScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("ankiel_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^ankiel_session_[^=]*=;.*Max-Age=0/),
          );
          expect(devCookies.filter((cookie) => /;\s*Secure/i.test(cookie))).toEqual([]);
          const httpsResponse = await environmentA.handler(
            postJson(
              "/api/auth/browser-session",
              { credential: DEV_TOKEN },
              { "x-forwarded-proto": "https" },
            ),
            requestContext,
          );
          const httpsCookies = httpsResponse.headers.getSetCookie();
          expect(httpsCookies).toHaveLength(2);
          for (const cookie of httpsCookies) expect(cookie).toMatch(/;\s*Secure/i);
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^ankiel_session_/);
          expect(restrictedCookies[0]).not.toContain("ankiel_dev_session_");
          // Older clients still ask for agent sign-in and link codes; those are refused, not
          // answered with an ordinary credential.
          for (const retired of [
            { access: "auto" },
            { access: "full-access", purpose: "peer-link" },
          ]) {
            const refused = await environmentA.handler(
              postJson("/api/auth/pairing-token", retired, { cookie: devCookieHeader }),
              requestContext,
            );
            expect(refused.status).toBe(400);
          }
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["DPoP", "dpop"])("challenges a refused %s request with DPoP", (scheme) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const refused = await environment.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { authorization: `${scheme} not-a-valid-token` },
            ),
            requestContext,
          );
          expect(refused.status).toBe(401);
          expect(refused.headers.get("www-authenticate")).toBe("DPoP");
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

// The web handler runs on its own runtime, so proofs need wall-clock time.
it.live("checks token-endpoint DPoP proofs without writing replay state", () =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const written: Array<string> = [];
    const recordingSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: (name) => Effect.sync(() => void written.push(name)),
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, recordingSecretStore),
    );
    const url = "http://127.0.0.1/oauth/token";
    const key = makeDpopKey();
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const tokenRequest = (subjectToken: string, proof: string) =>
      new Request(url, {
        method: "POST",
        headers: { host: "127.0.0.1", dpop: proof },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: subjectToken,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (environment) =>
        Effect.promise(async () => {
          const unknownToken = await environment.handler(
            tokenRequest("not-a-pairing-token", key.sign({ method: "POST", url, token: "", iat })),
            requestContext,
          );
          expect(unknownToken.status).toBe(401);
          expect(await unknownToken.json()).not.toHaveProperty("dpopFailureReason");

          const accepted = await environment.handler(
            tokenRequest(DEV_TOKEN, key.sign({ method: "POST", url, token: "", iat })),
            requestContext,
          );
          expect(accepted.status).toBe(200);
          expect(await accepted.json()).toMatchObject({ token_type: "DPoP" });

          const badProof = await environment.handler(
            tokenRequest(DEV_TOKEN, "not-a-proof"),
            requestContext,
          );
          expect(badProof.status).toBe(401);
          expect(badProof.headers.get("www-authenticate")).toBe("DPoP");
          expect(written).toEqual([]);
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

const makePairingTestHandler = Effect.fn(function* () {
  const clock = yield* Clock.Clock;
  const random = yield* SecureRandom.SecureRandom;
  const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeedNone,
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.die("Not used by these routes."),
    remove: () => Effect.void,
  });
  const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
    Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    Context.add(Clock.Clock, clock),
  );
  const clockedRoutes = layerRoutes.pipe(Layer.provideMerge(Layer.succeed(Clock.Clock, clock)));
  const webHandler = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(clockedRoutes, { disableLogger: true })),
    (environment) => Effect.promise(() => environment.dispose()),
  );
  const call = (request: Request) =>
    Effect.promise(() => webHandler.handler(request, requestContext));
  const exchangeBearer = Effect.fn(function* (scopes?: ReadonlyArray<string>) {
    const body = new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: DEV_TOKEN,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      ...(scopes ? { scope: scopes.join(" ") } : {}),
    });
    const res = yield* call(new Request("http://127.0.0.1/oauth/token", { method: "POST", body }));
    expect(res.status).toBe(200);
    const json = (yield* Effect.promise(() => res.json())) as { access_token: string };
    return { authorization: `Bearer ${json.access_token}` };
  });
  return { call, exchangeBearer, webHandler, requestContext };
});

it.effect("completes the full device pairing invite lifecycle with DPoP proof binding", () =>
  Effect.gen(function* () {
    const { call, exchangeBearer } = yield* makePairingTestHandler();
    const ownerHeaders = yield* exchangeBearer();
    const otherSessionHeaders = yield* exchangeBearer();
    const readOnlyHeaders = yield* exchangeBearer(["orchestration:read"]);
    const narrowAccessHeaders = yield* exchangeBearer(["access:write", "orchestration:read"]);

    // Scope and retired-field guards on create.
    expect(
      (yield* call(
        postJson("/api/auth/pairing-invites", { scopes: ["orchestration:read"] }, readOnlyHeaders),
      )).status,
    ).toBe(403);
    expect(
      (yield* call(
        postJson(
          "/api/auth/pairing-invites",
          { scopes: ["orchestration:operate"] },
          narrowAccessHeaders,
        ),
      )).status,
    ).toBe(403);
    for (const invalidBody of [
      { scopes: [] },
      { scopes: ["orchestration:read", "orchestration:read"] },
      { scopes: ["review:write"] },
      { access: "full-access" },
      { purpose: "peer-link" },
    ]) {
      const bad = yield* call(postJson("/api/auth/pairing-invites", invalidBody, ownerHeaders));
      expect(bad.status).toBe(400);
      expect(yield* Effect.promise(() => bad.json())).toMatchObject({ reason: "invalid_scope" });
    }

    // Create invite.
    const createRes = yield* call(
      postJson(
        "/api/auth/pairing-invites",
        { label: "Ben's iPhone", scopes: ["orchestration:read", "orchestration:operate"] },
        ownerHeaders,
      ),
    );
    expect(createRes.status).toBe(200);
    expect(createRes.headers.get("cache-control")).toBe("no-store");
    const created = (yield* Effect.promise(() => createRes.json())) as {
      inviteId: string;
      expiresAt: string;
      scopes: Array<string>;
    };
    expect(created.inviteId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(created.scopes).toEqual(["orchestration:read", "orchestration:operate"]);

    // Creator-session isolation.
    expect(
      (yield* call(
        new Request(`http://127.0.0.1/api/auth/pairing-invites/${created.inviteId}`, {
          headers: otherSessionHeaders,
        }),
      )).status,
    ).toBe(404);
    expect(
      (yield* call(
        postJson(
          `/api/auth/pairing-invites/${created.inviteId}/approve`,
          { verificationCode: "000-000" },
          otherSessionHeaders,
        ),
      )).status,
    ).toBe(404);
    expect(
      (yield* call(
        new Request(`http://127.0.0.1/api/auth/pairing-invites/${created.inviteId}/deny`, {
          method: "POST",
          headers: otherSessionHeaders,
        }),
      )).status,
    ).toBe(404);

    const claimPath = `/api/auth/pairing-invites/${created.inviteId}/claim`;
    const claimUrl = `http://127.0.0.1${claimPath}`;
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const claimantKey = makeDpopKey();
    const attackerKey = makeDpopKey();

    // Missing or malformed DPoP rejected on claim & poll with WWW-Authenticate: DPoP.
    const missingProof = yield* call(postJson(claimPath, { clientLabel: "iPhone" }));
    expect(missingProof.status).toBe(401);
    expect(missingProof.headers.get("www-authenticate")).toBe("DPoP");

    const badProof = yield* call(
      postJson(claimPath, { clientLabel: "iPhone" }, { dpop: "not-a-proof" }),
    );
    expect(badProof.status).toBe(401);
    expect(badProof.headers.get("www-authenticate")).toBe("DPoP");

    const missingPollProof = yield* call(new Request(claimUrl));
    expect(missingPollProof.status).toBe(401);
    expect(missingPollProof.headers.get("www-authenticate")).toBe("DPoP");

    // Claim with valid DPoP proof.
    const claimRes = yield* call(
      postJson(
        claimPath,
        { clientLabel: "iPhone 16", clientDeviceType: "mobile", clientOs: "iOS" },
        {
          host: "127.0.0.1",
          dpop: claimantKey.sign({ method: "POST", url: claimUrl, token: "", iat }),
        },
      ),
    );
    expect(claimRes.status).toBe(200);
    expect(claimRes.headers.get("cache-control")).toBe("no-store");
    const claimed = (yield* Effect.promise(() => claimRes.json())) as {
      status: string;
      verificationCode: string;
      expiresAt: string;
    };
    expect(claimed.status).toBe("claimed");
    expect(claimed.verificationCode).toMatch(/^\d{3}-\d{3}$/);

    // Same key claim is idempotent; different key claim is rejected.
    const retryClaimRes = yield* call(
      postJson(
        claimPath,
        { clientLabel: "iPhone 16" },
        {
          host: "127.0.0.1",
          dpop: claimantKey.sign({ method: "POST", url: claimUrl, token: "", iat }),
        },
      ),
    );
    expect(retryClaimRes.status).toBe(200);
    expect(yield* Effect.promise(() => retryClaimRes.json())).toEqual(claimed);

    const hijackClaimRes = yield* call(
      postJson(
        claimPath,
        { clientLabel: "Attacker" },
        {
          host: "127.0.0.1",
          dpop: attackerKey.sign({ method: "POST", url: claimUrl, token: "", iat }),
        },
      ),
    );
    expect(hijackClaimRes.status).toBe(403);
    expect(yield* Effect.promise(() => hijackClaimRes.json())).toMatchObject({
      reason: "pairing_invite_invalid_state",
    });

    // Owner sees claim metadata without secrets; attacker cannot poll claim.
    const ownerClaimedRes = yield* call(
      new Request(`http://127.0.0.1/api/auth/pairing-invites/${created.inviteId}`, {
        headers: ownerHeaders,
      }),
    );
    expect(ownerClaimedRes.status).toBe(200);
    const ownerClaimed = (yield* Effect.promise(() => ownerClaimedRes.json())) as Record<
      string,
      unknown
    >;
    expect(ownerClaimed).toMatchObject({
      inviteId: created.inviteId,
      status: "claimed",
      claim: {
        clientLabel: "iPhone 16",
        clientDeviceType: "mobile",
        clientOs: "iOS",
        verificationCode: claimed.verificationCode,
      },
    });
    expect(ownerClaimed).not.toHaveProperty("credential");
    expect(ownerClaimed.claim).not.toHaveProperty("proofKeyThumbprint");

    const wrongKeyPoll = yield* call(
      new Request(claimUrl, {
        headers: {
          host: "127.0.0.1",
          dpop: attackerKey.sign({ method: "GET", url: claimUrl, token: "", iat }),
        },
      }),
    );
    expect(wrongKeyPoll.status).toBe(401);
    expect(wrongKeyPoll.headers.get("www-authenticate")).toBe("DPoP");
    expect(yield* Effect.promise(() => wrongKeyPoll.json())).toMatchObject({
      dpopFailureReason: "key_mismatch",
    });

    // Missing or wrong verification code fails; matching code approves.
    const missingCodeRes = yield* call(
      postJson(`/api/auth/pairing-invites/${created.inviteId}/approve`, {}, ownerHeaders),
    );
    expect(missingCodeRes.status).toBe(400);

    const wrongCode = claimed.verificationCode === "000-000" ? "111-111" : "000-000";
    const mismatchRes = yield* call(
      postJson(
        `/api/auth/pairing-invites/${created.inviteId}/approve`,
        { verificationCode: wrongCode },
        ownerHeaders,
      ),
    );
    expect(mismatchRes.status).toBe(400);
    expect(yield* Effect.promise(() => mismatchRes.json())).toMatchObject({
      reason: "pairing_invite_verification_code_mismatch",
    });

    const approveRes = yield* call(
      postJson(
        `/api/auth/pairing-invites/${created.inviteId}/approve`,
        { verificationCode: claimed.verificationCode },
        ownerHeaders,
      ),
    );
    expect(approveRes.status).toBe(200);
    expect(approveRes.headers.get("cache-control")).toBe("no-store");
    const approved = (yield* Effect.promise(() => approveRes.json())) as {
      status: string;
      grantExpiresAt: string;
    };
    expect(approved.status).toBe("approved");

    // Owner status NEVER contains credential even after approval.
    const ownerApprovedRes = yield* call(
      new Request(`http://127.0.0.1/api/auth/pairing-invites/${created.inviteId}`, {
        headers: ownerHeaders,
      }),
    );
    expect(ownerApprovedRes.status).toBe(200);
    const ownerApproved = (yield* Effect.promise(() => ownerApprovedRes.json())) as Record<
      string,
      unknown
    >;
    expect(ownerApproved.status).toBe("approved");
    expect(ownerApproved).not.toHaveProperty("credential");

    // Claimant polls twice (retry-safe while unspent).
    const pollClaim = () =>
      call(
        new Request(claimUrl, {
          headers: {
            host: "127.0.0.1",
            dpop: claimantKey.sign({ method: "GET", url: claimUrl, token: "", iat }),
          },
        }),
      );
    const firstPoll = yield* pollClaim();
    expect(firstPoll.status).toBe(200);
    const pollBody = (yield* Effect.promise(() => firstPoll.json())) as {
      status: string;
      credential: string;
      grantExpiresAt: string;
    };
    expect(pollBody.status).toBe("approved");
    expect(pollBody.credential).toBeTruthy();

    const retryPoll = yield* pollClaim();
    expect(retryPoll.status).toBe(200);
    expect(yield* Effect.promise(() => retryPoll.json())).toEqual(pollBody);

    // /oauth/token with missing or wrong DPoP fails and leaves grant UNSPENT.
    const tokenUrl = "http://127.0.0.1/oauth/token";
    const tokenForm = () =>
      new URLSearchParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: pollBody.credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
      });

    const noDpopTokenRes = yield* call(
      new Request(tokenUrl, { method: "POST", body: tokenForm() }),
    );
    expect(noDpopTokenRes.status).toBe(401);
    expect(noDpopTokenRes.headers.get("www-authenticate")).toBe("DPoP");
    expect(yield* Effect.promise(() => noDpopTokenRes.json())).toMatchObject({
      dpopFailureReason: "key_mismatch",
    });

    const wrongDpopTokenRes = yield* call(
      new Request(tokenUrl, {
        method: "POST",
        headers: {
          host: "127.0.0.1",
          dpop: attackerKey.sign({ method: "POST", url: tokenUrl, token: "", iat }),
        },
        body: tokenForm(),
      }),
    );
    expect(wrongDpopTokenRes.status).toBe(401);
    expect(wrongDpopTokenRes.headers.get("www-authenticate")).toBe("DPoP");
    expect(yield* Effect.promise(() => wrongDpopTokenRes.json())).toMatchObject({
      dpopFailureReason: "key_mismatch",
    });

    // Matching DPoP succeeds (proving prior failed attempts left the grant unspent).
    const matchingTokenRes = yield* call(
      new Request(tokenUrl, {
        method: "POST",
        headers: {
          host: "127.0.0.1",
          dpop: claimantKey.sign({ method: "POST", url: tokenUrl, token: "", iat }),
        },
        body: tokenForm(),
      }),
    );
    expect(matchingTokenRes.status).toBe(200);
    expect(yield* Effect.promise(() => matchingTokenRes.json())).toMatchObject({
      token_type: "DPoP",
      scope: "orchestration:read orchestration:operate",
    });

    // Polling after redemption returns expired with credential wiped.
    const postRedeemPoll = yield* pollClaim();
    expect(postRedeemPoll.status).toBe(200);
    const postRedeemBody = (yield* Effect.promise(() => postRedeemPoll.json())) as Record<
      string,
      unknown
    >;
    expect(postRedeemBody).toEqual({ status: "expired" });
    expect(postRedeemBody).not.toHaveProperty("credential");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("cancels, denies, revokes, caps, and expires pairing invites via TestClock", () =>
  Effect.gen(function* () {
    const { call, exchangeBearer } = yield* makePairingTestHandler();
    const ownerHeaders = yield* exchangeBearer();
    const claimantKey = makeDpopKey();

    // 1. Cancel pending invite -> cancelled.
    const pendingRes = yield* call(postJson("/api/auth/pairing-invites", {}, ownerHeaders));
    const pending = (yield* Effect.promise(() => pendingRes.json())) as { inviteId: string };
    const cancelRes = yield* call(
      new Request(`http://127.0.0.1/api/auth/pairing-invites/${pending.inviteId}/deny`, {
        method: "POST",
        headers: ownerHeaders,
      }),
    );
    expect(cancelRes.status).toBe(200);
    expect(yield* Effect.promise(() => cancelRes.json())).toEqual({ status: "cancelled" });

    // 2. Deny approved invite -> denied + revokes issued pairing link.
    const approvedInviteRes = yield* call(postJson("/api/auth/pairing-invites", {}, ownerHeaders));
    const approvedInvite = (yield* Effect.promise(() => approvedInviteRes.json())) as {
      inviteId: string;
    };
    const claimUrl = `http://127.0.0.1/api/auth/pairing-invites/${approvedInvite.inviteId}/claim`;
    const iatNow = () =>
      DateTime.now.pipe(Effect.map((now) => Math.floor(now.epochMilliseconds / 1_000)));
    const claim = yield* call(
      postJson(
        `/api/auth/pairing-invites/${approvedInvite.inviteId}/claim`,
        {},
        {
          host: "127.0.0.1",
          dpop: claimantKey.sign({
            method: "POST",
            url: claimUrl,
            token: "",
            iat: yield* iatNow(),
          }),
        },
      ),
    );
    expect(claim.status).toBe(200);
    const { verificationCode: approvedVerificationCode } = (yield* Effect.promise(() =>
      claim.json(),
    )) as { verificationCode: string };
    expect(
      (yield* call(
        postJson(
          `/api/auth/pairing-invites/${approvedInvite.inviteId}/approve`,
          { verificationCode: approvedVerificationCode },
          ownerHeaders,
        ),
      )).status,
    ).toBe(200);

    const beforeDenyPoll = yield* call(
      new Request(claimUrl, {
        headers: {
          host: "127.0.0.1",
          dpop: claimantKey.sign({ method: "GET", url: claimUrl, token: "", iat: yield* iatNow() }),
        },
      }),
    );
    const { credential } = (yield* Effect.promise(() => beforeDenyPoll.json())) as {
      credential: string;
    };

    const denyRes = yield* call(
      new Request(`http://127.0.0.1/api/auth/pairing-invites/${approvedInvite.inviteId}/deny`, {
        method: "POST",
        headers: ownerHeaders,
      }),
    );
    expect(denyRes.status).toBe(200);
    expect(yield* Effect.promise(() => denyRes.json())).toEqual({ status: "denied" });

    // Poll sees denied without credential; /oauth/token rejects the revoked grant.
    const afterDenyPoll = yield* call(
      new Request(claimUrl, {
        headers: {
          host: "127.0.0.1",
          dpop: claimantKey.sign({ method: "GET", url: claimUrl, token: "", iat: yield* iatNow() }),
        },
      }),
    );
    expect(yield* Effect.promise(() => afterDenyPoll.json())).toEqual({ status: "denied" });

    const tokenUrl = "http://127.0.0.1/oauth/token";
    const revokedExchange = yield* call(
      new Request(tokenUrl, {
        method: "POST",
        headers: {
          host: "127.0.0.1",
          dpop: claimantKey.sign({
            method: "POST",
            url: tokenUrl,
            token: "",
            iat: yield* iatNow(),
          }),
        },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      }),
    );
    expect(revokedExchange.status).toBe(401);

    // 3. Enforce max 16 active invites, then prune expired after 120s via TestClock.
    const inviteIds: Array<string> = [];
    for (let i = 0; i < 16; i += 1) {
      const res = yield* call(postJson("/api/auth/pairing-invites", {}, ownerHeaders));
      expect(res.status).toBe(200);
      inviteIds.push(((yield* Effect.promise(() => res.json())) as { inviteId: string }).inviteId);
    }
    const seventeenth = yield* call(postJson("/api/auth/pairing-invites", {}, ownerHeaders));
    expect(seventeenth.status).toBe(403);
    expect(yield* Effect.promise(() => seventeenth.json())).toMatchObject({
      reason: "pairing_invite_limit_reached",
    });

    // Claim the first invite before expiry so we can verify claimed->expired transition too.
    const firstClaimUrl = `http://127.0.0.1/api/auth/pairing-invites/${inviteIds[0]}/claim`;
    expect(
      (yield* call(
        postJson(
          `/api/auth/pairing-invites/${inviteIds[0]}/claim`,
          {},
          {
            host: "127.0.0.1",
            dpop: claimantKey.sign({
              method: "POST",
              url: firstClaimUrl,
              token: "",
              iat: yield* iatNow(),
            }),
          },
        ),
      )).status,
    ).toBe(200);

    yield* TestClock.adjust(Duration.seconds(121));

    const expiredOwner = yield* call(
      new Request(`http://127.0.0.1/api/auth/pairing-invites/${inviteIds[0]}`, {
        headers: ownerHeaders,
      }),
    );
    expect(yield* Effect.promise(() => expiredOwner.json())).toMatchObject({ status: "expired" });

    const expiredPoll = yield* call(
      new Request(firstClaimUrl, {
        headers: {
          host: "127.0.0.1",
          dpop: claimantKey.sign({
            method: "GET",
            url: firstClaimUrl,
            token: "",
            iat: yield* iatNow(),
          }),
        },
      }),
    );
    expect(yield* Effect.promise(() => expiredPoll.json())).toMatchObject({ status: "expired" });

    const expiredApprove = yield* call(
      postJson(
        `/api/auth/pairing-invites/${inviteIds[0]}/approve`,
        { verificationCode: "000-000" },
        ownerHeaders,
      ),
    );
    expect(expiredApprove.status).toBe(403);

    // Pruning expired invites frees capacity for a fresh invite.
    const afterPrune = yield* call(postJson("/api/auth/pairing-invites", {}, ownerHeaders));
    expect(afterPrune.status).toBe(200);
    const grantExpiryInvite = (yield* Effect.promise(() => afterPrune.json())) as {
      inviteId: string;
    };
    const grantClaimUrl = `http://127.0.0.1/api/auth/pairing-invites/${grantExpiryInvite.inviteId}/claim`;
    const grantClaimRes = yield* call(
      postJson(
        `/api/auth/pairing-invites/${grantExpiryInvite.inviteId}/claim`,
        {},
        {
          host: "127.0.0.1",
          dpop: claimantKey.sign({
            method: "POST",
            url: grantClaimUrl,
            token: "",
            iat: yield* iatNow(),
          }),
        },
      ),
    );
    expect(grantClaimRes.status).toBe(200);
    const { verificationCode: grantVerificationCode } = (yield* Effect.promise(() =>
      grantClaimRes.json(),
    )) as { verificationCode: string };
    expect(
      (yield* call(
        postJson(
          `/api/auth/pairing-invites/${grantExpiryInvite.inviteId}/approve`,
          { verificationCode: grantVerificationCode },
          ownerHeaders,
        ),
      )).status,
    ).toBe(200);

    // Approved grant expires after 120s and wipes stored credential on poll.
    yield* TestClock.adjust(Duration.seconds(121));
    const expiredGrantPoll = yield* call(
      new Request(grantClaimUrl, {
        headers: {
          host: "127.0.0.1",
          dpop: claimantKey.sign({
            method: "GET",
            url: grantClaimUrl,
            token: "",
            iat: yield* iatNow(),
          }),
        },
      }),
    );
    expect(expiredGrantPoll.status).toBe(200);
    const expiredGrantBody = (yield* Effect.promise(() => expiredGrantPoll.json())) as Record<
      string,
      unknown
    >;
    expect(expiredGrantBody).toEqual({ status: "expired" });
    expect(expiredGrantBody).not.toHaveProperty("credential");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

// Real loopback HTTP/WS sockets exercise RelayTunnelClient's /h/<hostId>/ header forwarding.
it.live(
  "verifies DPoP proofs on pairing invite claim routes through /h/<hostId>/ relay paths",
  () =>
    Effect.gen(function* () {
      const { call, exchangeBearer, webHandler, requestContext } = yield* makePairingTestHandler();
      const ownerHeaders = yield* exchangeBearer();
      const createRes = yield* call(postJson("/api/auth/pairing-invites", {}, ownerHeaders));
      const { inviteId } = (yield* Effect.promise(() => createRes.json())) as { inviteId: string };

      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ankiel-invite-relay-"));
      const identity = yield* Effect.promise(() =>
        loadOrCreateRelayHostIdentity(NodePath.join(tempDir, "relay-host-identity.json")),
      );
      const localServer = NodeHttp.createServer((req, res) => {
        const chunks: Array<Buffer> = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === "string") headers.set(key, value);
            else if (Array.isArray(value)) headers.set(key, value.join(", "));
          }
          const host = req.headers.host ?? "127.0.0.1";
          const body = Buffer.concat(chunks);
          const webRequest = new Request(`http://${host}${req.url ?? "/"}`, {
            method: req.method ?? "GET",
            headers,
            ...(req.method !== "GET" && req.method !== "HEAD" && body.byteLength > 0
              ? { body }
              : {}),
          });
          void webHandler.handler(webRequest, requestContext).then(async (webRes) => {
            const responseHeaders: Record<string, string> = {};
            webRes.headers.forEach((value, key) => {
              responseHeaders[key] = value;
            });
            res.writeHead(webRes.status, responseHeaders);
            res.end(Buffer.from(await webRes.arrayBuffer()));
          });
        });
      });
      const relayServer = NodeHttp.createServer();
      const relayWss = new NodeWS.WebSocketServer({ server: relayServer });
      const responses = new Map<
        string,
        { status?: number; chunks: Array<Buffer>; resolve?: () => void }
      >();
      let hostSocket: InstanceType<typeof NodeWS.WebSocket> | null = null;
      relayWss.on("connection", (ws) => {
        hostSocket = ws;
        ws.send(
          JSON.stringify({
            type: "challenge",
            nonce: "invite-relay-nonce",
            timestamp: 1_700_000_000_000,
            requiresSecret: true,
          }),
        );
        ws.on("message", (data, isBinary) => {
          if (isBinary) {
            const decoded = decodeBinaryFrame(new Uint8Array(data as Buffer));
            if (!decoded) return;
            const entry = responses.get(decoded.id);
            if (entry) entry.chunks.push(Buffer.from(decoded.payload));
            return;
          }
          const msg = JSON.parse(data.toString("utf8")) as {
            type: string;
            reqId?: string;
            status?: number;
          };
          if (msg.type === "auth") {
            ws.send(JSON.stringify({ type: "ready", hostId: identity.hostId }));
          } else if (msg.type === "http_response_start" && msg.reqId) {
            const entry = responses.get(msg.reqId);
            if (entry && msg.status !== undefined) entry.status = msg.status;
          } else if (msg.type === "http_response_end" && msg.reqId) {
            responses.get(msg.reqId)?.resolve?.();
          }
        });
      });

      yield* Effect.promise(
        () => new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve)),
      );
      const localPort = (localServer.address() as { port: number }).port;
      const relayPort = (relayServer.address() as { port: number }).port;
      const tunnel = startRelayTunnelClient({
        setup: parseRelaySetupString(`http://127.0.0.1:${relayPort}#relay-secret`),
        identity,
        localHost: "127.0.0.1",
        localPort,
      });

      const random = yield* SecureRandom.SecureRandom;
      const tunnelRequest = (
        method: string,
        path: string,
        headers: ReadonlyArray<readonly [string, string]>,
        body?: string,
      ) =>
        Effect.gen(function* () {
          const reqId = yield* random.uuidV4();
          return yield* Effect.promise(async () => {
            const entry: { status?: number; chunks: Array<Buffer>; resolve?: () => void } = {
              chunks: [],
            };
            const done = new Promise<void>((resolve) => {
              entry.resolve = resolve;
            });
            responses.set(reqId, entry);
            hostSocket!.send(
              JSON.stringify({
                type: "http_request",
                reqId,
                method,
                path,
                headers,
                hasBody: body !== undefined,
              }),
            );
            if (body !== undefined) {
              hostSocket!.send(
                encodeBinaryFrame(
                  BINARY_FRAME_HTTP_REQ_BODY,
                  reqId,
                  new TextEncoder().encode(body),
                ),
              );
              hostSocket!.send(JSON.stringify({ type: "http_request_end", reqId }));
            }
            await done;
            return {
              status: entry.status ?? 0,
              json: JSON.parse(Buffer.concat(entry.chunks).toString("utf8")) as Record<
                string,
                unknown
              >,
            };
          });
        });

      return yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.promise(() => tunnel.waitUntilReady());
          const claimantKey = makeDpopKey();
          const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
          const claimPath = `/api/auth/pairing-invites/${inviteId}/claim`;
          const publicClaimUrl = `${tunnel.publicBaseUrl}api/auth/pairing-invites/${inviteId}/claim`;
          const unprefixedUrl = `http://127.0.0.1:${relayPort}${claimPath}`;

          // Unprefixed DPoP htu is rejected on path-routed relay.
          const unprefixed = yield* tunnelRequest(
            "POST",
            claimPath,
            [
              ["content-type", "application/json"],
              ["dpop", claimantKey.sign({ method: "POST", url: unprefixedUrl, token: "", iat })],
            ],
            "{}",
          );
          expect(unprefixed.status).toBe(401);
          expect(unprefixed.json).toMatchObject({ dpopFailureReason: "request_mismatch" });

          // Prefixed /h/<hostId>/... DPoP htu succeeds for both POST claim and GET poll.
          const claimed = yield* tunnelRequest(
            "POST",
            claimPath,
            [
              ["content-type", "application/json"],
              ["dpop", claimantKey.sign({ method: "POST", url: publicClaimUrl, token: "", iat })],
            ],
            JSON.stringify({
              clientLabel: "Relay iPhone",
              clientDeviceType: "mobile",
              clientOs: "iOS",
            }),
          );
          expect(claimed.status).toBe(200);
          expect(claimed.json).toMatchObject({ status: "claimed" });

          const polled = yield* tunnelRequest("GET", claimPath, [
            ["dpop", claimantKey.sign({ method: "GET", url: publicClaimUrl, token: "", iat })],
          ]);
          expect(polled.status).toBe(200);
          expect(polled.json).toMatchObject({ status: "claimed" });
        }),
        Effect.promise(async () => {
          await tunnel.stop();
          relayWss.close();
          localServer.close();
          relayServer.close();
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
