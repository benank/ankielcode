import {
  AuthStandardClientScopes,
  EnvironmentId,
  type AuthEnvironmentScope,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@ankielcode/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Dpop from "../dpop.ts";
import * as Persistence from "../platform/persistence.ts";
import { fetchRemoteSessionState } from "../authorization/remote.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  PrimaryConnectionRegistration,
} from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  PrimaryConnectionTarget,
} from "./model.ts";
import * as Onboarding from "./onboarding.ts";
import {
  prepareBearerConnectionUpdate,
  preparePairingRegistration,
  prepareSshRegistration,
} from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import { connectionRoutes, routeHttpBaseUrl } from "./routes.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const layerClientPresentation = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({
    metadata: {
      label: "Ankiel Code Test",
      deviceType: "desktop",
      os: "Test OS",
    },
  }),
);

function layerPairingHttp(
  calls: Array<{ readonly url: string; readonly init: RequestInit }>,
  options?: {
    readonly failDescriptor?: boolean;
    readonly failExchange?: boolean;
    readonly protocolVersion?: number;
    readonly selfUpdate?: boolean;
    readonly grantScopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly exchangeGate?: { readonly reached: () => void; readonly release: Promise<void> };
    readonly accessTokenRenewal?: boolean;
    readonly devicePairingInvites?: boolean;
    readonly environmentId?: string;
    readonly redirectError?: boolean;
    readonly inviteClaimResponse?: Response | (() => Response);
    readonly invitePollResponse?: Response | (() => Response);
  },
) {
  const grantScopes = options?.grantScopes ?? AuthStandardClientScopes;
  let sessionScopes: ReadonlyArray<string> = [];
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (options?.redirectError === true) {
      return Promise.reject(new TypeError("Failed to fetch: redirect mode is error"));
    }

    if (url.endsWith("/.well-known/ankiel/environment")) {
      if (options?.failDescriptor === true) {
        return Promise.resolve(
          Response.json({ message: "descriptor unavailable" }, { status: 503 }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: options?.environmentId ?? "environment-paired",
          label: "Paired environment",
          platform: {
            os: "linux",
            arch: "x64",
          },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: options?.protocolVersion ?? ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: {
            repositoryIdentity: true,
            ...(options?.selfUpdate === true ? { serverSelfUpdate: "boot-service" } : {}),
            ...(options?.accessTokenRenewal === true ? { accessTokenRenewal: true } : {}),
            ...(options?.devicePairingInvites === true ? { devicePairingInvites: true } : {}),
          },
        }),
      );
    }

    if (/\/api\/auth\/pairing-invites\/[^/]+\/claim$/.test(new URL(url).pathname)) {
      if ((init.method ?? "GET").toUpperCase() === "POST") {
        const response =
          typeof options?.inviteClaimResponse === "function"
            ? options.inviteClaimResponse()
            : (options?.inviteClaimResponse ??
              Response.json({
                status: "claimed",
                verificationCode: "847-291",
                expiresAt: "2026-05-01T12:05:00.000Z",
              }));
        return Promise.resolve(response);
      }
      const response =
        typeof options?.invitePollResponse === "function"
          ? options.invitePollResponse()
          : (options?.invitePollResponse ??
            Response.json({
              status: "approved",
              grantExpiresAt: "2026-05-01T12:10:00.000Z",
              credential: "approved-invite-credential",
            }));
      return Promise.resolve(response);
    }

    if (url.endsWith("/oauth/token")) {
      if (options?.failExchange === true) {
        return Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_credential",
              traceId: "trace-pairing-test",
            },
            { status: 401 },
          ),
        );
      }
      const body =
        init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body);
      const requestedScope = new URLSearchParams(body).get("scope");
      sessionScopes = requestedScope === null ? grantScopes : requestedScope.split(" ");
      if (!sessionScopes.every((scope) => grantScopes.some((granted) => granted === scope))) {
        return Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentRequestInvalidError",
              code: "invalid_request",
              reason: "scope_not_granted",
              traceId: "pairing-scope-test",
            },
            { status: 400 },
          ),
        );
      }
      const dpop = new Headers(init.headers).has("dpop");
      const granted = Response.json({
        access_token: dpop ? "dpop-token" : "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: dpop ? "DPoP" : "Bearer",
        expires_in: 3600,
        scope: sessionScopes.join(" "),
      });
      const gate = options?.exchangeGate;
      if (gate === undefined) return Promise.resolve(granted);
      gate.reached();
      return gate.release.then(() => granted);
    }

    if (url.endsWith("/api/auth/session")) {
      return Promise.resolve(
        Response.json({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["bearer-access-token"],
            sessionCookieName: "ankiel_session",
          },
          scopes: sessionScopes,
          sessionMethod: "bearer-access-token",
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  return RpcHttp.layerRemoteHttpClient(fetchFn);
}

function layerPairingOnboarding(
  options?: Parameters<typeof layerPairingHttp>[1] & {
    readonly dpopSigner?: Dpop.DpopSigner["Service"];
    readonly registered?: Array<unknown>;
  },
  calls: Array<{ readonly url: string; readonly init: RequestInit }> = [],
  provision?: ClientCapabilities.SshEnvironmentGateway["Service"]["provision"],
) {
  const dependencies = Layer.mergeAll(
    layerClientPresentation,
    layerPairingHttp(calls, options),
    options?.dpopSigner === undefined
      ? Layer.empty
      : Layer.succeed(Dpop.DpopSigner, options.dpopSigner),
    Layer.mock(Persistence.ConnectionTargetStore)({
      list: Effect.succeed([]),
      listDisabled: Effect.succeed([]),
    }),
    Layer.mock(Persistence.ConnectionRegistrationStore)({
      register: (registration) =>
        Effect.sync(() => {
          options?.registered?.push(registration);
        }),
      setEnabled: () => Effect.void,
    }),
    Layer.mock(Persistence.EnvironmentCacheStore)({}),
    Layer.mock(ConnectionProfileStore.ConnectionProfileStore)({}),
    Layer.mock(ConnectionCredentialStore.ConnectionCredentialStore)({
      get: () => Effect.succeedNone,
      put: () => Effect.void,
    }),
    Layer.mock(ClientCapabilities.SshEnvironmentGateway)(provision ? { provision } : {}),
    Layer.succeed(
      Connectivity.Connectivity,
      Connectivity.Connectivity.of({ status: Effect.succeed("online"), changes: Stream.never }),
    ),
    Layer.mock(ConnectionDriver.ConnectionDriver)({ connect: () => Effect.never }),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
    ),
  );
  return Onboarding.layer.pipe(
    Layer.provideMerge(EnvironmentRegistry.layer.pipe(Layer.provideMerge(dependencies))),
  );
}

const PAIRED_ENVIRONMENT_ID = EnvironmentId.make("environment-paired");
const PAIRING_INPUT = { host: "remote.example.test", pairingCode: "pairing-token" };
const PAIRED_PROFILE = new BearerConnectionProfile({
  connectionId: "bearer:environment-paired:https://remote.example.test",
  environmentId: PAIRED_ENVIRONMENT_ID,
  label: "Paired environment",
  httpBaseUrl: "https://remote.example.test/",
  wsBaseUrl: "wss://remote.example.test/",
});
const UNSUPPORTED_ERROR = new ConnectionBlockedError({
  reason: "unsupported",
  detail: "The saved server used an incompatible orchestration protocol.",
});

const registerSwitchedOffEnvironment = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const registration = new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: PAIRED_ENVIRONMENT_ID,
      connectionId: PAIRED_PROFILE.connectionId,
      label: "Old label",
    }),
    profile: new BearerConnectionProfile({ ...PAIRED_PROFILE, label: "Old label" }),
    credential: new BearerConnectionCredential({ token: "old-token" }),
  });
  yield* registry.register(registration);
  yield* registry.setEnabled(PAIRED_ENVIRONMENT_ID, false);
  yield* registry.setCompatibility(PAIRED_ENVIRONMENT_ID, UNSUPPORTED_ERROR);
  const entries = yield* SubscriptionRef.get(registry.entries);
  expect(entries.get(PAIRED_ENVIRONMENT_ID)).toEqual({
    target: registration.target,
    profile: Option.some(registration.profile),
    enabled: false,
    unsupportedReason: UNSUPPORTED_ERROR.message,
  });
  return entries;
});

describe("connection onboarding", () => {
  it.effect("prepares a persisted bearer registration from pairing details", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)));

      expect(registration).toMatchObject({
        _tag: "BearerConnectionRegistration",
        target: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
        },
        profile: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
          httpBaseUrl: "https://remote.example.test/",
          wsBaseUrl: "wss://remote.example.test/",
        },
        credential: {
          token: "bearer-token",
        },
      });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/ankiel/environment",
        "https://remote.example.test/oauth/token",
      ]);

      const tokenRequest = calls.find((call) => call.url.endsWith("/oauth/token"));
      const tokenBody =
        tokenRequest?.init.body instanceof Uint8Array
          ? new TextDecoder().decode(tokenRequest.init.body)
          : String(tokenRequest?.init.body);
      const tokenParams = new URLSearchParams(tokenBody);
      expect(tokenParams.get("subject_token")).toBe("pairing-token");
      expect(tokenParams.has("scope")).toBe(false);
      expect(tokenParams.get("client_label")).toBe("Ankiel Code Test");
      expect(tokenParams.get("client_device_type")).toBe("desktop");
      expect(tokenParams.get("client_os")).toBe("Test OS");
    }),
  );

  it.effect("turns a switched-off environment back on when it is paired again", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* registerSwitchedOffEnvironment;

      const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

      expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
      const entries = yield* SubscriptionRef.get(registry.entries);
      const entry = entries.get(environmentId);
      expect(entries.size).toBe(1);
      expect(entry?.enabled).toBe(true);
      expect(entry?.unsupportedReason).toBeUndefined();
      expect(entry?.profile).toEqual(Option.some(PAIRED_PROFILE));
      expect(entry?.target).toEqual(
        new BearerConnectionTarget({
          environmentId,
          connectionId: PAIRED_PROFILE.connectionId,
          label: PAIRED_PROFILE.label,
        }),
      );
    }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect("refuses a pairing link that claims a saved environment from a new address", () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const before = yield* registerSwitchedOffEnvironment;

      const error = yield* onboarding
        .registerPairing({ host: "attacker.example.test", pairingCode: "pairing-token" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
      expect(calls.map((call) => call.url)).toEqual([
        "https://attacker.example.test/.well-known/ankiel/environment",
      ]);
    }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)));
  });

  it.effect(
    "refuses to add an SSH route to a saved environment during untargeted onboarding",
    () => {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      };
      return Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const before = yield* registerSwitchedOffEnvironment;

        const result = yield* onboarding.registerSsh({ target }).pipe(Effect.result);

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ConnectionBlockedError", reason: "configuration" },
        });
        expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
      }).pipe(
        Effect.provide(
          layerPairingOnboarding(undefined, [], () =>
            Effect.succeed({
              environmentId: PAIRED_ENVIRONMENT_ID,
              label: "Remote development box",
              bootstrap: {
                target,
                httpBaseUrl: "http://127.0.0.1:3201",
                wsBaseUrl: "ws://127.0.0.1:3201",
                pairingToken: "pairing-token",
              },
              bearerToken: "bearer-token",
            }),
          ),
        ),
      );
    },
  );

  it.effect("refuses a new address when the environment is saved during the exchange", () => {
    let reached!: () => void;
    let release!: () => void;
    const exchangeReached = new Promise<void>((resolve) => (reached = resolve));
    const exchangeGate = {
      reached: () => reached(),
      release: new Promise<void>((resolve) => (release = resolve)),
    };
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const pairing = yield* onboarding
        .registerPairing({ host: "attacker.example.test", pairingCode: "pairing-token" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => exchangeReached);
      const before = yield* registerSwitchedOffEnvironment;
      release();

      const outcome = yield* Fiber.join(pairing);

      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionBlockedError", reason: "configuration" },
      });
      expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
    }).pipe(Effect.provide(layerPairingOnboarding({ exchangeGate })));
  });

  it.effect("adds a new address as a route when pairing targets that environment", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* registerSwitchedOffEnvironment;

      yield* onboarding.registerPairing({
        host: "lan.example.test",
        pairingCode: "pairing-token",
        expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
      });

      const entry = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID);
      expect(entry === undefined ? [] : connectionRoutes(entry).map(routeHttpBaseUrl)).toEqual(
        expect.arrayContaining(["https://remote.example.test/", "https://lan.example.test/"]),
      );
    }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect(
    "re-pairs an outdated self-updatable environment so its connection can be rechecked",
    () =>
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registerSwitchedOffEnvironment;
        yield* registry.setCompatibility(
          PAIRED_ENVIRONMENT_ID,
          new ConnectionBlockedError({
            reason: "unsupported",
            detail: "The saved server needs an update.",
            serverUpdateRequired: true,
          }),
        );
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID),
        ).toMatchObject({
          enabled: false,
          serverUpdateRequired: true,
        });

        const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

        expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
        expect(entry?.enabled).toBe(true);
        expect(entry?.unsupportedReason).toBeUndefined();
        expect(entry?.serverUpdateRequired).toBeUndefined();
        expect(entry?.profile).toEqual(Option.some(PAIRED_PROFILE));
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({
            protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1,
            selfUpdate: true,
          }),
        ),
      ),
  );

  it.effect.each([
    {
      kind: "primary",
      registration: new PrimaryConnectionRegistration({
        target: new PrimaryConnectionTarget({
          environmentId: PAIRED_ENVIRONMENT_ID,
          label: "Host environment",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
        }),
      }),
    },
    {
      kind: "bearer",
      registration: new BearerConnectionRegistration({
        target: new BearerConnectionTarget({
          environmentId: PAIRED_ENVIRONMENT_ID,
          connectionId: "platform:wsl",
          label: "WSL",
        }),
        profile: new BearerConnectionProfile({
          ...PAIRED_PROFILE,
          connectionId: "platform:wsl",
          label: "WSL",
          httpBaseUrl: "http://127.0.0.1:4000",
          wsBaseUrl: "ws://127.0.0.1:4000",
        }),
        credential: new BearerConnectionCredential({ token: "platform-token" }),
      }),
    },
  ] as const)(
    "leaves a platform-managed $kind environment untouched when its id is paired",
    ({ registration }) =>
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registry.reconcilePlatform([registration]);
        yield* registry.setCompatibility(PAIRED_ENVIRONMENT_ID, UNSUPPORTED_ERROR);
        const before = yield* SubscriptionRef.get(registry.entries);
        expect(before.get(PAIRED_ENVIRONMENT_ID)).toMatchObject({
          enabled: true,
          unsupportedReason: UNSUPPORTED_ERROR.message,
        });

        const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

        expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
        expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
      }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect("leaves a switched-off environment unchanged when the pairing exchange fails", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const before = yield* registerSwitchedOffEnvironment;

      const error = yield* onboarding.registerPairing(PAIRING_INPUT).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
        traceId: "trace-pairing-test",
      });
      const after = yield* SubscriptionRef.get(registry.entries);
      expect(after).toEqual(before);
      expect(after.get(PAIRED_ENVIRONMENT_ID)?.enabled).toBe(false);
      expect(after.get(PAIRED_ENVIRONMENT_ID)?.unsupportedReason).toBe(UNSUPPORTED_ERROR.message);
    }).pipe(Effect.provide(layerPairingOnboarding({ failExchange: true }))),
  );

  it.effect("rejects an incompatible server without consuming the pairing credential", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({ protocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 }, calls),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/ankiel/environment",
      ]);
    }),
  );
  it.effect.each([
    { label: "read-only", scopes: ["orchestration:read"] },
    { label: "default", scopes: AuthStandardClientScopes },
  ] as const)("preserves the $label grant when pairing a remote environment", ({ scopes }) =>
    Effect.gen(function* () {
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      });

      assert(registration.credential._tag === "BearerConnectionCredential");
      const session = yield* fetchRemoteSessionState({
        httpBaseUrl: registration.profile.httpBaseUrl,
        bearerToken: registration.credential.token,
      });

      expect(session.authenticated).toBe(true);
      expect(session.scopes).toEqual(scopes);
    }).pipe(Effect.provide(layerPairingOnboarding({ grantScopes: scopes }))),
  );

  it.effect.each([
    { name: "a host that renews, with a device key", renews: true, signer: true, dpop: true },
    { name: "a host that renews, without a device key", renews: true, signer: false, dpop: false },
    { name: "an older host, with a device key", renews: false, signer: true, dpop: false },
  ])("pairs with $name as DPoP: $dpop", ({ renews, signer, dpop }) =>
    Effect.gen(function* () {
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      });
      expect(registration.credential).toMatchObject(
        dpop
          ? { _tag: "DpopConnectionCredential", accessToken: "dpop-token" }
          : { _tag: "BearerConnectionCredential", token: "bearer-token" },
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerPairingOnboarding({ accessTokenRenewal: renews }),
          signer
            ? Layer.succeed(
                Dpop.DpopSigner,
                Dpop.DpopSigner.of({
                  thumbprint: Effect.succeed("device-key"),
                  createProof: (proof) => Effect.succeed(`proof:${proof.url}`),
                }),
              )
            : Layer.empty,
        ),
      ),
    ),
  );

  it.effect("refuses to add a route that reaches a different machine, keeping the code", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
        expectedEnvironmentId: EnvironmentId.make("some-other-machine"),
      }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)), Effect.flip);
      expect(error).toMatchObject({ reason: "configuration" });
      expect(error.message).toContain("different machine");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/ankiel/environment",
      ]);
    }),
  );

  it.effect("refuses an outdated server that cannot update itself", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({ protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1 }, calls),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error).not.toHaveProperty("serverUpdateRequired");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/ankiel/environment",
      ]);
    }),
  );

  it.effect("does not consume a pairing credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];

      yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(layerPairingOnboarding({ failDescriptor: true }, calls)), Effect.flip);

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/ankiel/environment",
      ]);
    }),
  );

  it.effect("updates bearer metadata while preserving the credential and identity", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const registration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "  Renamed environment  ",
          httpBaseUrl: "http://100.65.180.100:3773/path",
        },
        entry: Option.some({
          target: new BearerConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "bearer:environment-paired",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired",
              environmentId,
              label: "Old label",
              httpBaseUrl: "http://old.example.test/",
              wsBaseUrl: "ws://old.example.test/",
            }),
          ),
          enabled: true,
        }),
        credential: Option.some(new BearerConnectionCredential({ token: "bearer-token" })),
      });

      expect(registration).toMatchObject({
        target: {
          environmentId,
          label: "Renamed environment",
          connectionId: "bearer:environment-paired",
        },
        profile: {
          environmentId,
          label: "Renamed environment",
          httpBaseUrl: "http://100.65.180.100:3773/",
          wsBaseUrl: "ws://100.65.180.100:3773/",
        },
        credential: { token: "bearer-token" },
      });
    }),
  );

  it.effect("prepares an SSH registration from the provisioned platform environment", () =>
    Effect.gen(function* () {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      };
      const registration = yield* prepareSshRegistration({
        target,
      }).pipe(
        Effect.provideService(
          ClientCapabilities.SshEnvironmentGateway,
          ClientCapabilities.SshEnvironmentGateway.of({
            provision: () =>
              Effect.succeed({
                environmentId: EnvironmentId.make("environment-ssh"),
                label: "Remote development box",
                bootstrap: {
                  target,
                  httpBaseUrl: "http://127.0.0.1:3201",
                  wsBaseUrl: "ws://127.0.0.1:3201",
                  pairingToken: "pairing-token",
                },
                bearerToken: "bearer-token",
              }),
            prepare: () => Effect.die("unused"),
            disconnect: () => Effect.die("unused"),
          }),
        ),
      );

      expect(registration).toMatchObject({
        _tag: "SshConnectionRegistration",
        target: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
        },
        profile: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
          target,
        },
        // Saved so the first connect reuses this pairing instead of adding another.
        credential: { token: "bearer-token" },
      });
    }),
  );

  it.effect(
    "claims, polls, and completes a device pairing invite over a path-routed relay URL with DPoP",
    () => {
      const relayBaseUrl = "https://ankiel-relay.me.workers.dev/h/abcdefghijklmnopqrstuvwxyz/";
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const proofs: Array<Dpop.DpopProofInput> = [];
      const registered: Array<unknown> = [];
      const signer = Dpop.DpopSigner.of({
        thumbprint: Effect.succeed("device-key"),
        createProof: (proof) =>
          Effect.sync(() => {
            proofs.push(proof);
            return `proof-${proofs.length}`;
          }),
      });
      return Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;

        const claimed = yield* onboarding.claimPairingInvite({
          invite: {
            version: 1,
            inviteId: "inv_relay_1",
            environmentId: PAIRED_ENVIRONMENT_ID,
            baseUrl: "https://ankiel-relay.me.workers.dev/h/ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            label: "Desk Mac",
          },
        });
        expect(claimed).toEqual({
          inviteId: "inv_relay_1",
          environmentId: PAIRED_ENVIRONMENT_ID,
          environmentLabel: "Paired environment",
          httpBaseUrl: relayBaseUrl,
          verificationCode: "847-291",
          expiresAt: "2026-05-01T12:05:00.000Z",
        });

        const pollStatus = yield* onboarding.pollPairingInviteClaim({
          httpBaseUrl: claimed.httpBaseUrl,
          inviteId: claimed.inviteId,
        });
        expect(pollStatus).toEqual({
          status: "approved",
          grantExpiresAt: "2026-05-01T12:10:00.000Z",
          credential: "approved-invite-credential",
        });
        assert(pollStatus.status === "approved");

        const environmentId = yield* onboarding.completePairingInvite({
          httpBaseUrl: claimed.httpBaseUrl,
          environmentId: claimed.environmentId,
          environmentLabel: claimed.environmentLabel,
          credential: pollStatus.credential,
        });

        expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
        expect(proofs).toEqual([
          {
            method: "POST",
            url: `${relayBaseUrl}api/auth/pairing-invites/inv_relay_1/claim`,
          },
          {
            method: "GET",
            url: `${relayBaseUrl}api/auth/pairing-invites/inv_relay_1/claim`,
          },
          {
            method: "POST",
            url: `${relayBaseUrl}oauth/token`,
          },
        ]);
        expect(calls.map((call) => call.url)).toEqual([
          `${relayBaseUrl}.well-known/ankiel/environment`,
          `${relayBaseUrl}api/auth/pairing-invites/inv_relay_1/claim`,
          `${relayBaseUrl}api/auth/pairing-invites/inv_relay_1/claim`,
          `${relayBaseUrl}.well-known/ankiel/environment`,
          `${relayBaseUrl}oauth/token`,
        ]);
        expect(calls.map((call) => call.init.redirect)).toEqual([
          "error",
          "error",
          "error",
          "error",
          "error",
        ]);
        const claimBody = calls[1]!.init.body;
        expect(
          JSON.parse(
            claimBody instanceof Uint8Array
              ? new TextDecoder().decode(claimBody)
              : String(claimBody),
          ),
        ).toEqual({
          clientLabel: "Ankiel Code Test",
          clientDeviceType: "desktop",
          clientOs: "Test OS",
        });
        expect(registered).toHaveLength(1);
        expect(registered[0]).toMatchObject({
          _tag: "BearerConnectionRegistration",
          profile: {
            httpBaseUrl: relayBaseUrl,
            wsBaseUrl: "wss://ankiel-relay.me.workers.dev/h/abcdefghijklmnopqrstuvwxyz/",
          },
          credential: {
            _tag: "DpopConnectionCredential",
            accessToken: "dpop-token",
          },
        });
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID);
        expect(entry?.enabled).toBe(true);
        expect(entry?.profile).toEqual(
          Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired:https://ankiel-relay.me.workers.dev",
              environmentId: PAIRED_ENVIRONMENT_ID,
              label: "Paired environment",
              httpBaseUrl: relayBaseUrl,
              wsBaseUrl: "wss://ankiel-relay.me.workers.dev/h/abcdefghijklmnopqrstuvwxyz/",
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          layerPairingOnboarding(
            {
              accessTokenRenewal: true,
              devicePairingInvites: true,
              dpopSigner: signer,
              registered,
            },
            calls,
          ),
        ),
      );
    },
  );

  it.effect(
    "refuses device pairing invite operations without a DPoP signer (no bearer fallback)",
    () => {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      return Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;

        const claimError = yield* onboarding
          .claimPairingInvite({
            invite: {
              version: 1,
              inviteId: "inv_no_dpop",
              environmentId: PAIRED_ENVIRONMENT_ID,
              baseUrl: "https://remote.example.test/",
            },
          })
          .pipe(Effect.flip);
        const pollError = yield* onboarding
          .pollPairingInviteClaim({
            httpBaseUrl: "https://remote.example.test/",
            inviteId: "inv_no_dpop",
          })
          .pipe(Effect.flip);
        const completeError = yield* onboarding
          .completePairingInvite({
            httpBaseUrl: "https://remote.example.test/",
            environmentId: PAIRED_ENVIRONMENT_ID,
            environmentLabel: "Paired environment",
            credential: "approved-invite-credential",
          })
          .pipe(Effect.flip);

        for (const error of [claimError, pollError, completeError]) {
          expect(error).toMatchObject({
            _tag: "ConnectionBlockedError",
            reason: "configuration",
            hop: "device",
          });
        }
        expect(calls).toEqual([]);
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({ accessTokenRenewal: true, devicePairingInvites: true }, calls),
        ),
      );
    },
  );

  it.effect("rejects a pairing invite when descriptor environmentId does not match", () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const signer = Dpop.DpopSigner.of({
      thumbprint: Effect.succeed("device-key"),
      createProof: () => Effect.succeed("proof"),
    });
    return Effect.gen(function* () {
      const onboarding = yield* Onboarding.ConnectionOnboarding;

      const inviteMismatch = yield* onboarding
        .claimPairingInvite({
          invite: {
            version: 1,
            inviteId: "inv_mismatch",
            environmentId: "environment-expected",
            baseUrl: "https://remote.example.test/",
          },
        })
        .pipe(Effect.flip);
      const expectedMismatch = yield* onboarding
        .completePairingInvite({
          httpBaseUrl: "https://remote.example.test/",
          environmentId: PAIRED_ENVIRONMENT_ID,
          environmentLabel: "Paired environment",
          credential: "approved-invite-credential",
          expectedEnvironmentId: EnvironmentId.make("environment-other"),
        })
        .pipe(Effect.flip);

      expect(inviteMismatch).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
      });
      expect(inviteMismatch.message).toContain("different machine");
      expect(expectedMismatch).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
      });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/ankiel/environment",
        "https://remote.example.test/.well-known/ankiel/environment",
      ]);
    }).pipe(
      Effect.provide(
        layerPairingOnboarding(
          {
            accessTokenRenewal: true,
            devicePairingInvites: true,
            dpopSigner: signer,
          },
          calls,
        ),
      ),
    );
  });

  it.effect.each([
    { name: "missing devicePairingInvites", devicePairingInvites: false, accessTokenRenewal: true },
    { name: "missing accessTokenRenewal", devicePairingInvites: true, accessTokenRenewal: false },
  ])(
    "rejects an older host $name without claiming the invite",
    ({ devicePairingInvites, accessTokenRenewal }) => {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const signer = Dpop.DpopSigner.of({
        thumbprint: Effect.succeed("device-key"),
        createProof: () => Effect.succeed("proof"),
      });
      return Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const error = yield* onboarding
          .claimPairingInvite({
            invite: {
              version: 1,
              inviteId: "inv_old_host",
              environmentId: PAIRED_ENVIRONMENT_ID,
              baseUrl: "https://remote.example.test/",
            },
          })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "unsupported",
          hop: "server",
        });
        expect(error.message).toContain("Update Ankiel Code");
        expect(calls.map((call) => call.url)).toEqual([
          "https://remote.example.test/.well-known/ankiel/environment",
        ]);
      }).pipe(
        Effect.provide(
          layerPairingOnboarding(
            {
              accessTokenRenewal,
              devicePairingInvites,
              dpopSigner: signer,
            },
            calls,
          ),
        ),
      );
    },
  );

  it.effect("refuses redirects during pairing invite descriptor discovery", () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const signer = Dpop.DpopSigner.of({
      thumbprint: Effect.succeed("device-key"),
      createProof: () => Effect.succeed("proof"),
    });
    return Effect.gen(function* () {
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const error = yield* onboarding
        .claimPairingInvite({
          invite: {
            version: 1,
            inviteId: "inv_redirect",
            environmentId: PAIRED_ENVIRONMENT_ID,
            baseUrl: "https://remote.example.test/",
          },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ConnectionTransientError",
        reason: "network",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.redirect).toBe("error");
    }).pipe(
      Effect.provide(
        layerPairingOnboarding(
          {
            accessTokenRenewal: true,
            devicePairingInvites: true,
            redirectError: true,
            dpopSigner: signer,
          },
          calls,
        ),
      ),
    );
  });

  it.effect.each([
    {
      reason: "pairing_invite_not_found",
      status: 404,
      body: {
        _tag: "EnvironmentResourceNotFoundError",
        code: "not_found",
        reason: "pairing_invite_not_found",
        traceId: "trace-invite-missing",
      },
      expectedMessage:
        "This pairing invite was not found or has already expired. Start a new pairing request on your other device.",
    },
    {
      reason: "pairing_invite_invalid_state",
      status: 403,
      body: {
        _tag: "EnvironmentOperationForbiddenError",
        code: "operation_forbidden",
        reason: "pairing_invite_invalid_state",
        traceId: "trace-invite-claimed",
      },
      expectedMessage:
        "This pairing invite is no longer active or has already been claimed. Start a new pairing request on your other device.",
    },
    {
      reason: "pairing_invite_limit_reached",
      status: 403,
      body: {
        _tag: "EnvironmentOperationForbiddenError",
        code: "operation_forbidden",
        reason: "pairing_invite_limit_reached",
        traceId: "trace-invite-limit",
      },
      expectedMessage:
        "Too many pairing invites are currently active on this environment. Wait a moment or cancel one before trying again.",
    },
  ] as const)(
    "maps $reason when claiming a pairing invite to a clear user message",
    ({ status, body, expectedMessage }) => {
      const signer = Dpop.DpopSigner.of({
        thumbprint: Effect.succeed("device-key"),
        createProof: () => Effect.succeed("proof"),
      });
      return Effect.gen(function* () {
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        const error = yield* onboarding
          .claimPairingInvite({
            invite: {
              version: 1,
              inviteId: "inv_error_case",
              environmentId: PAIRED_ENVIRONMENT_ID,
              baseUrl: "https://remote.example.test/",
            },
          })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "configuration",
          hop: "server",
          traceId: body.traceId,
          detail: expectedMessage,
        });
        expect(error.message).toBe(expectedMessage);
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({
            accessTokenRenewal: true,
            devicePairingInvites: true,
            dpopSigner: signer,
            inviteClaimResponse: () => Response.json(body, { status }),
          }),
        ),
      );
    },
  );

  it.effect.each([
    {
      kind: "primary",
      registration: new PrimaryConnectionRegistration({
        target: new PrimaryConnectionTarget({
          environmentId: PAIRED_ENVIRONMENT_ID,
          label: "Host environment",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
        }),
      }),
    },
    {
      kind: "bearer",
      registration: new BearerConnectionRegistration({
        target: new BearerConnectionTarget({
          environmentId: PAIRED_ENVIRONMENT_ID,
          connectionId: "platform:wsl",
          label: "WSL",
        }),
        profile: new BearerConnectionProfile({
          ...PAIRED_PROFILE,
          connectionId: "platform:wsl",
          label: "WSL",
          httpBaseUrl: "http://127.0.0.1:4000",
          wsBaseUrl: "ws://127.0.0.1:4000",
        }),
        credential: new BearerConnectionCredential({ token: "platform-token" }),
      }),
    },
  ] as const)(
    "rejects pairing invites targeting this device's own platform-managed $kind environment before claiming or redeeming",
    ({ registration }) => {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const signer = Dpop.DpopSigner.of({
        thumbprint: Effect.succeed("device-key"),
        createProof: () => Effect.succeed("proof"),
      });
      return Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registry.reconcilePlatform([registration]);

        const claimError = yield* onboarding
          .claimPairingInvite({
            invite: {
              version: 1,
              inviteId: "inv_self_host",
              environmentId: PAIRED_ENVIRONMENT_ID,
              baseUrl: "https://remote.example.test/",
            },
          })
          .pipe(Effect.flip);
        const completeError = yield* onboarding
          .completePairingInvite({
            httpBaseUrl: "https://remote.example.test/",
            environmentId: PAIRED_ENVIRONMENT_ID,
            environmentLabel: "Paired environment",
            credential: "approved-invite-credential",
            expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
          })
          .pipe(Effect.flip);

        for (const error of [claimError, completeError]) {
          expect(error).toMatchObject({
            _tag: "ConnectionBlockedError",
            reason: "configuration",
            detail: "This device already hosts Paired environment.",
          });
          expect(error.message).toBe("This device already hosts Paired environment.");
        }
        expect(calls.map((call) => call.url)).toEqual([
          "https://remote.example.test/.well-known/ankiel/environment",
          "https://remote.example.test/.well-known/ankiel/environment",
        ]);
      }).pipe(
        Effect.provide(
          layerPairingOnboarding(
            {
              accessTokenRenewal: true,
              devicePairingInvites: true,
              dpopSigner: signer,
            },
            calls,
          ),
        ),
      );
    },
  );
});
