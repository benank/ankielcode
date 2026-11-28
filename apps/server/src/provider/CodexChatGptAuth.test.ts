// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Local mock OAuth server validates the browser callback boundary.
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as ServerConfig from "../config.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@ankielcode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import { subscribeChatGptHandoff } from "./CodexChatGptHandoff.ts";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";

const assertSameCallback = (actual: string | null, expected: string | null) => {
  const left = new URL(actual!);
  const right = new URL(expected!);
  assert.strictEqual(left.protocol, right.protocol);
  assert.strictEqual(left.hostname, right.hostname);
  assert.strictEqual(left.pathname, right.pathname);
};
const environmentIds = new WeakMap<Map<string, Uint8Array>, EnvironmentId>();
const instanceId = ProviderInstanceId.make("managed-codex-test");
const makeHarnessFor = Effect.fnUntraced(function* (
  instanceId: ProviderInstanceId,
  bytes: Map<string, Uint8Array> = new Map(),
) {
  const environmentId = environmentIds.get(bytes) ?? EnvironmentId.make(NodeCrypto.randomUUID());
  environmentIds.set(bytes, environmentId);
  const environment = ServerEnvironment.ServerEnvironmentIdentity.of({
    getEnvironmentId: Effect.succeed(environmentId),
  });
  const signingKeyFor = (kid: string) => {
    const pair = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    return {
      kid,
      privateKey: pair.privateKey,
      publicJwk: { ...pair.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" },
    };
  };
  let signingKey = signingKeyFor("test");
  let jwksRequests = 0;
  const untrustedKeys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signIdToken = (claims: Record<string, unknown>, privateKey: NodeCrypto.KeyObject) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signingInput = `${encode({ alg: "RS256", kid: signingKey.kid })}.${encode(claims)}`;
    const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  };
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(bytes.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        bytes.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        bytes.delete(name);
      }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("Host identity must come from the environment."),
  });
  let authorize: URL | undefined;
  let refreshes = 0;
  let revoked = false;
  let refreshError: string | undefined;
  let revocationStatus = 200;
  let codeError: string | undefined;
  const revocations: URLSearchParams[] = [];
  let transient = false;
  let invalidNonce = false;
  let identityFailure: "issuer" | "audience" | "signature" | undefined;
  let mismatchedState = false;
  let callbackClientId: string | undefined;
  let subject = "user-test";
  let email = "hidden@example.test";
  let grantScope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  let origin = "";
  const exchanges: URLSearchParams[] = [];
  const authorizationRequests: URL[] = [];
  const callbackResponses: { body: string; headers: Headers }[] = [];
  let returnUrl = "http://localhost:7001/welcome";
  const server = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve) => {
          const server = NodeHttp.createServer(async (request, response) => {
            response.setHeader("content-type", "application/json");
            if (request.url === "/discovery") {
              response.end(
                JSON.stringify({
                  issuer: origin,
                  authorization_endpoint: `${origin}/authorize`,
                  token_endpoint: `${origin}/token`,
                  jwks_uri: `${origin}/jwks`,
                  revocation_endpoint: `${origin}/revoke`,
                }),
              );
              return;
            }
            if (request.url === "/jwks") {
              jwksRequests += 1;
              response.end(JSON.stringify({ keys: [signingKey.publicJwk] }));
              return;
            }
            if (request.url === "/revoke") {
              let text = "";
              for await (const chunk of request) text += chunk.toString();
              revocations.push(new URLSearchParams(text));
              response.statusCode = revocationStatus;
              response.end();
              return;
            }
            if (request.url === "/token") {
              let text = "";
              for await (const chunk of request) text += chunk.toString();
              assert.strictEqual(
                request.headers["content-type"],
                "application/x-www-form-urlencoded",
              );
              assert.isUndefined(request.headers.authorization);
              const body = new URLSearchParams(text);
              assert.isFalse(body.has("client_secret"));
              assert.strictEqual(body.get("resource"), `${origin}/v1`);
              exchanges.push(body);
              if (body.get("grant_type") === "refresh_token") {
                refreshes++;
                if (transient) {
                  response.statusCode = 503;
                  response.end(JSON.stringify({ error: "temporarily_unavailable" }));
                  return;
                }
                if (revoked || refreshError) {
                  response.statusCode = 400;
                  response.end(JSON.stringify({ error: refreshError ?? "invalid_grant" }));
                  return;
                }
                response.end(
                  JSON.stringify({
                    access_token: `access-${refreshes}`,
                    refresh_token: `refresh-${refreshes}`,
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: grantScope,
                  }),
                );
                return;
              }
              if (codeError) {
                response.statusCode = 400;
                response.end(JSON.stringify({ error: codeError }));
                return;
              }
              if (!authorize) {
                response.statusCode = 400;
                response.end("{}");
                return;
              }
              assertSameCallback(
                body.get("redirect_uri"),
                authorize.searchParams.get("redirect_uri"),
              );
              assert.strictEqual(
                NodeCrypto.createHash("sha256")
                  .update(body.get("code_verifier")!)
                  .digest("base64url"),
                authorize.searchParams.get("code_challenge"),
              );
              const token = signIdToken(
                {
                  nonce: invalidNonce ? "incorrect" : authorize.searchParams.get("nonce"),
                  email,
                  iss: identityFailure === "issuer" ? "https://untrusted-issuer.test" : origin,
                  aud:
                    identityFailure === "audience"
                      ? "oaiapp_untrusted_audience"
                      : body.get("client_id")!,
                  sub: subject,
                  exp: 4_102_444_800,
                },
                identityFailure === "signature" ? untrustedKeys.privateKey : signingKey.privateKey,
              );
              response.end(
                JSON.stringify({
                  access_token: "initial-access",
                  refresh_token: "initial-refresh",
                  id_token: token,
                  token_type: "Bearer",
                  expires_in: 3600,
                  scope: grantScope,
                }),
              );
              return;
            }
            response.statusCode = 404;
            response.end("{}");
          });
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock address");
  origin = `http://127.0.0.1:${address.port}`;
  const auth = yield* makeCodexChatGptAuth({
    instanceId,
    discoveryUrl: `${origin}/discovery`,
    resource: `${origin}/v1`,
  }).pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment),
  );
  const phase = (phase: string) =>
    auth.controller.subscribe("owner").pipe(
      Stream.filter((state) => state.phase === phase),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  const prepareCallback = (waiting: { authorizationUrl: string | null }) => {
    authorize = new URL(waiting.authorizationUrl!);
    authorizationRequests.push(authorize);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({
      code: "authorization-code",
      state: mismatchedState ? "unmatched-state" : authorize.searchParams.get("state")!,
      ...(callbackClientId
        ? { client_id: callbackClientId }
        : authorize.searchParams.get("client_id") === "dynamic_agent_client"
          ? { client_id: "oaiapp_test" }
          : {}),
    }).toString();
    return callback;
  };
  const startRemote = (methodId?: string) =>
    Effect.gen(function* () {
      yield* auth.controller.start("owner", Effect.void, methodId, returnUrl, "client");
      const waiting = yield* phase("waiting");
      return { waiting, callbackUrl: prepareCallback(waiting).toString() };
    });
  const signInWithMethod = (methodId?: string) =>
    Effect.gen(function* () {
      yield* auth.controller.start("owner", Effect.void, methodId, returnUrl);
      const waiting = yield* phase("waiting");
      assert.strictEqual(waiting.interaction?.type, "browser");
      const callback = prepareCallback(waiting);
      yield* Effect.promise(async () => {
        const response = await fetch(callback);
        callbackResponses.push({ body: await response.text(), headers: response.headers });
      });
    });
  const seedExpired = Effect.gen(function* () {
    const stored = yield* auth.read;
    const record = Option.getOrThrow(stored);
    const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );
    yield* store.set(new TextEncoder().encode(JSON.stringify({ ...record, expiresAt: 0 })));
  });
  return {
    auth,
    jwksRequests: () => jwksRequests,
    rotateSigningKey: () => {
      signingKey = signingKeyFor("rotated");
    },
    secrets,
    environmentId,
    bytes,
    handoff: (profile: Parameters<typeof subscribeChatGptHandoff>[0]["profile"]) =>
      subscribeChatGptHandoff(
        {
          instanceId,
          environmentId,
          attemptId: "test-handoff",
          returnUrl,
          profile,
        },
        "owner",
        { discoveryUrl: `${origin}/discovery`, resource: `${origin}/v1` },
      ),
    finishCallback: (state: { authorizationUrl: string | null }) =>
      Effect.promise(() => fetch(prepareCallback(state))),
    destination: Effect.gen(function* () {
      const destinationBytes = new Map<string, Uint8Array>();
      const destinationStore = ServerSecretStore.ServerSecretStore.of({
        ...secrets,
        get: (name) => Effect.sync(() => Option.fromUndefinedOr(destinationBytes.get(name))),
        set: (name, value) =>
          Effect.sync(() => {
            destinationBytes.set(name, value);
          }),
        remove: (name) =>
          Effect.sync(() => {
            destinationBytes.delete(name);
          }),
      });
      const destination = yield* makeCodexChatGptAuth({
        instanceId,
        discoveryUrl: `${origin}/discovery`,
        resource: `${origin}/v1`,
      }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, destinationStore),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment),
      );
      return { auth: destination, bytes: destinationBytes };
    }),
    bindProfile: (expectedProfileKey: string) =>
      makeCodexChatGptAuth({
        instanceId,
        expectedProfileKey,
        discoveryUrl: `${origin}/discovery`,
        resource: `${origin}/v1`,
      }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment),
      ),
    recreateAuth: makeCodexChatGptAuth({
      instanceId,
      discoveryUrl: `${origin}/discovery`,
      resource: `${origin}/v1`,
    }).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment),
    ),
    startRemote,
    signIn: signInWithMethod(),
    changeAccount: signInWithMethod("chatgpt-change-account"),
    reconnectProfile: (clientId: string) => signInWithMethod(`chatgpt-profile:${clientId}`),
    phase,
    seedExpired,
    exchanges,
    authorizationRequests,
    callbackResponses,
    setReturnUrl: (value: string) => {
      returnUrl = value;
    },
    origin,
    storedRecords: () =>
      Array.from(bytes.entries()).flatMap(([, value]) => {
        const record = JSON.parse(new TextDecoder().decode(value));
        return record.sessions ?? [record];
      }),
    revocations,
    setRefreshError: (value: string) => {
      refreshError = value;
    },
    setRevocationStatus: (value: number) => {
      revocationStatus = value;
    },
    setCodeError: (value: string | undefined) => {
      codeError = value;
    },
    refreshes: () => refreshes,
    setRevoked: () => {
      revoked = true;
    },
    setTransient: (value: boolean) => {
      transient = value;
    },
    setInvalidNonce: () => {
      invalidNonce = true;
    },
    setIdentityFailure: (value: "issuer" | "audience" | "signature") => {
      identityFailure = value;
    },
    mismatchCallbackState: (value = true) => {
      mismatchedState = value;
    },
    setCallbackClientId: (value: string) => {
      callbackClientId = value;
    },
    setIdentity: (newSubject: string, newEmail: string) => {
      subject = newSubject;
      email = newEmail;
    },
    declineSharing: () => {
      grantScope = "openid profile email";
    },
  };
});
const makeHarness = makeHarnessFor(instanceId);
const provision = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer, NodePlatformCrypto.layer),
    ),
  );
it.effect.each(["identity", "sharing"] as const)(
  "failed account change preserves the original credentials and registration: %s",
  (failure) =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        const before = h.storedRecords();
        h.setCallbackClientId("oaiapp_other_account");
        if (failure === "identity") h.setInvalidNonce();
        else h.declineSharing();
        yield* h.changeAccount;
        yield* h.phase("failed");
        assert.strictEqual(
          h.authorizationRequests[1]!.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        if (failure === "sharing") {
          assert.deepEqual(
            Option.getOrThrow(yield* h.auth.read),
            before.find((record) => record.accessToken),
          );
          assert.lengthOf(h.storedRecords().find((record) => record.profiles).profiles, 2);
        } else assert.deepEqual(h.storedRecords(), before);
      }),
    ),
);
it.effect(
  "does not redirect to an arbitrary return URL or claim success after verification fails",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        h.setReturnUrl("https://attacker.example/welcome");
        h.setInvalidNonce();
        yield* h.signIn;
        yield* h.phase("failed");
        const response = h.callbackResponses[0]!;
        assert.include(response.body, "Sign-in couldn&#39;t finish");
        assert.notInclude(response.body, 'http-equiv="refresh"');
        assert.notInclude(response.body, "attacker.example");
        assert.isTrue(Option.isNone(yield* h.auth.read));
      }),
    ),
);
it.effect(
  "verifies registration, PKCE, identity and persists rotating refresh before concurrent access",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.strictEqual(Option.getOrThrow(yield* h.auth.read).subject, "user-test");
        assert.strictEqual(h.exchanges[0]?.get("client_id"), "oaiapp_test");
        yield* h.seedExpired;
        const records = yield* Effect.all([h.auth.access, h.auth.access], {
          concurrency: "unbounded",
        });
        assert.strictEqual(h.refreshes(), 1);
        assert.strictEqual(records[0].accessToken, "access-1");
        assert.strictEqual(records[1].refreshToken, "refresh-1");
        assert.isNull(h.exchanges[1]?.get("scope"));
        yield* h.auth.controller.logout(Effect.void);
        assert.isTrue(Option.isNone(yield* h.auth.read));
      }),
    ),
);
it.effect("rejects invalid ID token nonce without saving credentials", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.setInvalidNonce();
      yield* h.signIn;
      assert.include((yield* h.phase("failed")).message!, "could not be verified");
      assert.isTrue(Option.isNone(yield* h.auth.read));
    }),
  ),
);
it.effect("clears revoked refresh credentials and does not replay them", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      yield* h.seedExpired;
      h.setRevoked();
      yield* h.auth.access.pipe(Effect.result);
      yield* h.auth.access.pipe(Effect.result);
      assert.strictEqual(h.refreshes(), 1);
      assert.isTrue(Option.isNone(yield* h.auth.read));
    }),
  ),
);

it.effect("rejects mismatched callback state and keeps waiting for the real redirect", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.mismatchCallbackState();
      yield* h.signIn;
      assert.include(h.callbackResponses[0]!.body, "does not belong to the active sign-in");
      assert.strictEqual(h.exchanges.length, 0);
      assert.deepEqual(h.storedRecords(), []);
      assert.isTrue(Option.isNone(yield* h.auth.read));
      h.mismatchCallbackState(false);
      const waiting = yield* h.phase("waiting");
      const redirectUri = new URL(waiting.authorizationUrl!).searchParams.get("redirect_uri")!;
      const unparsable = yield* Effect.promise(() => fetch(`${new URL(redirectUri).origin}//`));
      assert.strictEqual(unparsable.status, 404);
      yield* h.finishCallback(waiting);
      yield* h.phase("succeeded");
      assert.strictEqual(h.exchanges.length, 1);
    }),
  ),
);
it.effect.each(["issuer", "audience", "signature"] as const)(
  "rejects ID token %s verification before saving tokens or registration",
  (invalidClaim) =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        h.setIdentityFailure(invalidClaim);
        yield* h.signIn;
        assert.include((yield* h.phase("failed")).message!, "could not be verified");
        assert.strictEqual(h.exchanges.length, 1);
        assert.deepEqual(h.storedRecords(), []);
        assert.isTrue(Option.isNone(yield* h.auth.read));
      }),
    ),
);

it.effect(
  "rejects foreign clients and malformed remote callbacks without consuming the owner's sign-in",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarnessFor(instanceId);
      const { waiting, callbackUrl } = yield* harness.startRemote();
      assert.isTrue(Option.isNone(yield* harness.auth.read));
      yield* Effect.flip(
        harness.auth.controller.complete("other-client", { flowId: waiting.flowId!, callbackUrl }),
      );
      const wrongPort = new URL(callbackUrl);
      wrongPort.port = wrongPort.port === "65535" ? "65534" : "65535";
      for (const invalid of [
        wrongPort.toString(),
        callbackUrl.replace("/auth/callback", "/other"),
        callbackUrl + "&state=foreign",
        callbackUrl + "&code=duplicate",
        callbackUrl + "&error=access_denied",
        callbackUrl.replace("127.0.0.1", "attacker.example"),
      ]) {
        yield* Effect.flip(
          harness.auth.controller.complete("owner", {
            flowId: waiting.flowId!,
            callbackUrl: invalid,
          }),
        );
      }
      assert.strictEqual(harness.exchanges.length, 0);
      assert.isTrue(Option.isNone(yield* harness.auth.read));
      yield* harness.auth.controller.complete("owner", { flowId: waiting.flowId!, callbackUrl });
      yield* harness.phase("succeeded");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer, FetchHttpClient.layer),
      ),
    ),
);

it.effect.each([
  { disconnected: false, label: "while connected" },
  { disconnected: true, label: "after Disconnect" },
])("rejects a different verified identity during saved-profile reauth $label", ({ disconnected }) =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      if (disconnected) yield* h.auth.controller.logout(Effect.void);
      const before = h.storedRecords();
      h.setIdentity("another-user", "another@example.test");
      yield* h.signIn;
      assert.include((yield* h.phase("failed")).message!, "different ChatGPT account");
      assert.deepEqual(h.storedRecords(), before);
      assert.strictEqual(Option.isNone(yield* h.auth.read), disconnected);
    }),
  ),
);

it.effect(
  "logout revokes the latest refresh token with the selected client and clears its ID hint",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        const host = h.authorizationRequests[0]!.searchParams.get("ext_agent_host_id");
        assert.match(host!, /^urn:uuid:[0-9a-f-]{36}$/u);
        yield* h.seedExpired;
        yield* h.auth.access;
        const state = yield* h.auth.controller.logout(Effect.void);
        assert.strictEqual(state.message, "Signed out.");
        assert.deepEqual(Array.from(h.revocations[0]!), [
          ["token", "refresh-1"],
          ["token_type_hint", "refresh_token"],
          ["client_id", "oaiapp_test"],
        ]);
        assert.isTrue(Option.isNone(yield* h.auth.read));
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.isFalse(h.authorizationRequests[1]!.searchParams.has("id_token_hint"));
        assert.strictEqual(h.authorizationRequests[1]!.searchParams.get("ext_agent_host_id"), host);
      }),
    ),
);

it.effect("transferred profiles reject mismatched identities without overwriting credentials", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      const profile = yield* h.auth.exportProfile;
      const destination = yield* h.destination;
      yield* destination.auth.controller.importProfile!(profile, Effect.void);
      const original = Option.getOrThrow(yield* destination.auth.read);
      for (const credentials of [
        { ...profile.credentials, subject: "wrong-user" },
        { ...profile.credentials, clientId: "oaiapp_wrong" },
        { ...profile.credentials, idToken: "not-a-jwt" },
        { ...profile.credentials, scopes: ["openid"] },
        { ...profile.credentials, expiresAt: 0 },
      ]) {
        const result = yield* destination.auth.controller.importProfile!(
          { ...profile, credentials },
          Effect.void,
        ).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.deepEqual(Option.getOrThrow(yield* destination.auth.read), original);
      }
    }),
  ),
);

it.effect("a running session renews its bound profile but refuses a replacement sign-in", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      const profileKey = yield* h.auth.profileKey(Option.getOrThrow(yield* h.auth.read));
      const first = yield* h.bindProfile(profileKey);
      const second = yield* h.bindProfile(profileKey);
      yield* h.seedExpired;
      const renewed = yield* Effect.all([first.access, second.access], {
        concurrency: "unbounded",
      });
      assert.equal(h.refreshes(), 1);
      assert.equal(renewed[0].accessToken, "access-1");
      assert.deepEqual(renewed[0], renewed[1]);
      assert.equal(yield* h.auth.profileKey(renewed[0]), profileKey);

      // Reconnecting the same account replaces its sign-in identity, too.
      yield* h.reconnectProfile("oaiapp_test");
      yield* h.phase("succeeded");
      const replacement = Option.getOrThrow(yield* h.auth.read);
      assert.equal(replacement.clientId, renewed[0].clientId);
      assert.equal(replacement.subject, renewed[0].subject);
      yield* h.seedExpired;
      assert.equal((yield* first.access.pipe(Effect.flip)).operation, "access");
      assert.equal(h.refreshes(), 1);
      yield* h.auth.revoke;
      assert.equal((yield* second.access.pipe(Effect.flip)).operation, "access");
      assert.isTrue(Option.isNone(yield* h.auth.read));
    }),
  ),
);

const makeRenewalBroker = Effect.gen(function* () {
  const oauthEntered = yield* Deferred.make<void>();
  const oauthRelease = yield* Deferred.make<void>();
  let pauseOAuth = false;
  const refreshTokens: string[] = [];
  const credentials = {
    clientId: "oaiapp_broker",
    subject: "broker-user",
    idToken: "broker-sign-in",
    email: null,
    accessToken: "expired-access",
    refreshToken: "single-use-refresh",
    expiresAt: 0,
    earliestRefreshAt: null,
    scopes: ["chatgpt.tokens.use.direct"],
  };
  const environmentId = EnvironmentId.make("00000000-0000-4000-8000-000000000001");
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url.endsWith("openid-configuration")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            issuer: "https://auth.openai.com",
            authorization_endpoint: "https://auth.openai.com/authorize",
            token_endpoint: "https://auth.openai.com/token",
            jwks_uri: "https://auth.openai.com/jwks",
          }),
        );
      }
      assert.equal(request.url, "https://auth.openai.com/token");
      assert.equal(request.body._tag, "Uint8Array");
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Missing refresh body");
      const body = new URLSearchParams(new TextDecoder().decode(request.body.body));
      refreshTokens.push(body.get("refresh_token")!);
      yield* Deferred.succeed(oauthEntered, undefined);
      if (pauseOAuth) yield* Deferred.await(oauthRelease);
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          access_token: "renewed-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "chatgpt.tokens.use.direct",
        }),
      );
    }),
  );
  return yield* Effect.gen(function* () {
    const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
    yield* store.set(new TextEncoder().encode(JSON.stringify(credentials)));
    const auth = yield* makeCodexChatGptAuth({ instanceId });
    const profileKey = yield* auth.profileKey(credentials);
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
    const context = yield* Layer.buildWithScope(CodexManagedTokenBroker.layer, scope);
    const broker = Context.get(context, CodexManagedTokenBroker.CodexManagedTokenBroker);
    const endpoint = yield* broker.endpoint;
    yield* Effect.addFinalizer(() => Deferred.succeed(oauthRelease, undefined));
    return {
      auth,
      store,
      broker,
      endpoint,
      refreshTokens,
      request: { version: 1, instanceId, environmentId, profileKey },
      oauthEntered,
      oauthRelease,
      pause: () => {
        pauseOAuth = true;
      },
    };
  }).pipe(
    Effect.provide(ServerSecretStore.layer),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  );
});

const brokerClient = (endpoint: string, request: unknown) =>
  Effect.acquireRelease(
    Effect.callback<{ socket: NodeNet.Socket; response: Promise<string> }, Error>((resume) => {
      const socket = NodeNet.createConnection(endpoint);
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        text += chunk;
      });
      const response = new Promise<string>((resolve) => socket.once("close", () => resolve(text)));
      socket.on("error", () => {});
      socket.once("error", (error) => resume(Effect.fail(error)));
      socket.once("connect", () => {
        socket.write(JSON.stringify(request) + "\n");
        resume(Effect.succeed({ socket, response }));
      });
      return Effect.sync(() => {
        if (socket.connecting) socket.destroy();
      });
    }),
    ({ socket }) => Effect.sync(() => socket.destroy()),
  );
const provideBroker = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-renewal-test-" }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
      ),
    ),
  );

it.live("the private broker refuses another environment, instance, or sign-in profile", () =>
  provideBroker(
    Effect.gen(function* () {
      const h = yield* makeRenewalBroker;
      yield* Effect.forEach(
        [
          {
            ...h.request,
            environmentId: EnvironmentId.make("00000000-0000-4000-8000-000000000002"),
          },
          { ...h.request, instanceId: ProviderInstanceId.make("another-instance") },
          { ...h.request, profileKey: "0".repeat(64) },
        ],
        (request) =>
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* brokerClient(h.endpoint, request);
              assert.equal(yield* Effect.promise(() => client.response), "");
            }),
          ),
      );
      yield* h.broker.awaitIdle;
      assert.deepEqual(h.refreshTokens, []);
      const client = yield* brokerClient(h.endpoint, h.request);
      assert.deepEqual(JSON.parse(yield* Effect.promise(() => client.response)), {
        token: "renewed-access",
      });
      yield* h.broker.awaitIdle;
      assert.deepEqual(h.refreshTokens, ["single-use-refresh"]);
    }),
  ),
);
