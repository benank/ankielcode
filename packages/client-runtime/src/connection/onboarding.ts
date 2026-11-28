import { msg } from "gt-i18n";
import { detailFromError, translatableDetail } from "../errors/translatable.ts";
import type {
  AuthPairingInviteClaimStatus,
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  IsoDateTime,
} from "@ankielcode/contracts";
import {
  extractRelayBasePath,
  resolveRemotePairingTarget,
  type PairingInvitePayload,
} from "@ankielcode/shared/remote";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import {
  bootstrapRemoteBearerSession,
  claimRemotePairingInvite,
  exchangeRemoteDpopAccessToken,
  fetchRemotePairingInviteClaim,
} from "../authorization/remote.ts";
import {
  deriveWsBaseUrl,
  environmentEndpointUrl,
  normalizeHttpBaseUrl,
} from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Dpop from "../dpop.ts";
import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  DpopConnectionCredential,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { mapRemoteDpopEnvironmentError, mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import { connectionRoutes, routeEntry, sshTargetKey } from "./routes.ts";

export interface PairingConnectionInput {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

/** @public */
export interface PairingInviteClaimInput {
  readonly invite: PairingInvitePayload;
  readonly expectedEnvironmentId?: EnvironmentId;
}

/** @public */
export interface PairingInviteClaimResult {
  readonly inviteId: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly httpBaseUrl: string;
  readonly verificationCode: string;
  readonly expiresAt: IsoDateTime;
}

/** @public */
export interface PairingInvitePollInput {
  readonly httpBaseUrl: string;
  readonly inviteId: string;
}

/** @public */
export interface PairingInviteCompleteInput {
  readonly httpBaseUrl: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly credential: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface SshConnectionInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface BearerConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

export class ConnectionOnboarding extends Context.Service<
  ConnectionOnboarding,
  {
    readonly registerPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly claimPairingInvite: (
      input: PairingInviteClaimInput,
    ) => Effect.Effect<PairingInviteClaimResult, ConnectionAttemptError>;
    readonly pollPairingInviteClaim: (
      input: PairingInvitePollInput,
    ) => Effect.Effect<AuthPairingInviteClaimStatus, ConnectionAttemptError>;
    readonly completePairingInvite: (
      input: PairingInviteCompleteInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly registerSsh: (
      input: SshConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
    /** Whether `host` answers this device as `environmentId`. Nothing is sent but the question. */
    readonly reaches: (input: {
      readonly host: string;
      readonly environmentId: EnvironmentId;
    }) => Effect.Effect<boolean>;
  }
>()("@ankielcode/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    return yield* Effect.try({
      try: () => resolveRemotePairingTarget(input),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          ...(cause instanceof Error
            ? detailFromError(cause)
            : translatableDetail(msg("The pairing details are invalid."))),
        }),
    });
  },
);

function bearerConnectionId(environmentId: EnvironmentId, httpBaseUrl: string): string {
  return `bearer:${environmentId}:${new URL(httpBaseUrl).origin}`;
}

function differentMachineError(label: string) {
  return new ConnectionBlockedError({
    reason: "configuration",
    ...translatableDetail(
      msg(
        "That address reaches {host}, a different machine. Add it as its own environment instead.",
        { host: label },
      ),
    ),
  });
}

function devicePairingInvitesUnsupportedError(label: string) {
  return new ConnectionBlockedError({
    reason: "unsupported",
    hop: "server",
    ...translatableDetail(
      msg("Update Ankiel Code on {host} to support device pairing invites.", {
        host: label,
      }),
    ),
  });
}

const PAIRING_INVITE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const validatePairingInviteId = Effect.fn(
  "clientRuntime.connection.onboarding.validatePairingInviteId",
)(function* (inviteId: string) {
  if (!PAIRING_INVITE_ID_PATTERN.test(inviteId)) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      ...translatableDetail(msg("The pairing invite is invalid.")),
    });
  }
  return inviteId;
});

const normalizePairingInviteBaseUrl = Effect.fn(
  "clientRuntime.connection.onboarding.normalizePairingInviteBaseUrl",
)(function* (rawValue: string) {
  return yield* Effect.try({
    try: () => {
      const trimmed = rawValue.trim();
      if (!trimmed) {
        throw new Error("missing");
      }
      const url = new URL(trimmed);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
        throw new Error("invalid");
      }
      url.pathname = extractRelayBasePath(url.pathname);
      url.search = "";
      url.hash = "";
      return url.toString();
    },
    catch: () =>
      new ConnectionBlockedError({
        reason: "configuration",
        ...translatableDetail(msg("The pairing invite URL is invalid.")),
      }),
  });
});

function derivePairingInviteWsBaseUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = extractRelayBasePath(url.pathname);
  url.search = "";
  url.hash = "";
  return url.toString();
}

const requireDpopSigner = Effect.fn("clientRuntime.connection.onboarding.requireDpopSigner")(
  function* () {
    const signer = yield* Effect.serviceOption(Dpop.DpopSigner);
    if (Option.isNone(signer)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        hop: "device",
        ...translatableDetail(
          msg("This device cannot sign device pairing requests because a DPoP key is unavailable."),
        ),
      });
    }
    return signer.value;
  },
);

const createPairingInviteDpopProof = Effect.fn(
  "clientRuntime.connection.onboarding.createPairingInviteDpopProof",
)(function* (
  signer: Dpop.DpopSigner["Service"],
  input: { readonly method: "GET" | "POST"; readonly url: string },
) {
  return yield* signer.createProof(input).pipe(
    Effect.mapError(
      () =>
        new ConnectionBlockedError({
          reason: "configuration",
          hop: "device",
          ...translatableDetail(msg("Could not sign the device pairing request.")),
        }),
    ),
  );
});

const verifyPairingInviteDescriptor = Effect.fn(
  "clientRuntime.connection.onboarding.verifyPairingInviteDescriptor",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly environmentId: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: input.httpBaseUrl,
    disallowRedirects: true,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  if (
    descriptor.environmentId !== input.environmentId ||
    (input.expectedEnvironmentId !== undefined &&
      descriptor.environmentId !== input.expectedEnvironmentId)
  ) {
    return yield* differentMachineError(descriptor.label);
  }
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  if (yield* registry.isPlatformEnvironment(descriptor.environmentId)) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      ...translatableDetail(msg("This device already hosts {host}.", { host: descriptor.label })),
    });
  }
  if (
    descriptor.capabilities.devicePairingInvites !== true ||
    descriptor.capabilities.accessTokenRenewal !== true
  ) {
    return yield* devicePairingInvitesUnsupportedError(descriptor.label);
  }
  const wsBaseUrl = derivePairingInviteWsBaseUrl(input.httpBaseUrl);
  const connectionId = bearerConnectionId(descriptor.environmentId, input.httpBaseUrl);
  const route = {
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: input.httpBaseUrl,
      wsBaseUrl,
    }),
  };
  if (input.expectedEnvironmentId === undefined) {
    yield* registry.assertKnownAddress({ ...route, profile: Option.some(route.profile) });
  }
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
    return yield* compatibilityError;
  }
  return { descriptor, connectionId, wsBaseUrl };
});

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput) {
  const target = yield* resolvePairingTarget(input);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  // Checked before redeeming the one-time code, so a wrong link is not spent.
  if (
    input.expectedEnvironmentId !== undefined &&
    descriptor.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(descriptor.label);
  }
  const connectionId = bearerConnectionId(descriptor.environmentId, target.httpBaseUrl);
  const route = {
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
    }),
  };
  // The registry checks again under its lease; this early check keeps a refused code unspent.
  if (input.expectedEnvironmentId === undefined) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* registry.assertKnownAddress({ ...route, profile: Option.some(route.profile) });
  }
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  // An outdated server is still saved so it can be updated from this client.
  if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
    return yield* compatibilityError;
  }
  // A key-bound session renews itself, but only on a host that can renew it. The proof is made
  // before the one-time code is sent, so a device that cannot sign keeps the code for bearer.
  const signer = yield* Effect.serviceOption(Dpop.DpopSigner);
  const dpopProof =
    descriptor.capabilities.accessTokenRenewal === true && Option.isSome(signer)
      ? yield* signer.value
          .createProof({
            method: "POST",
            url: environmentEndpointUrl(target.httpBaseUrl, "/oauth/token"),
          })
          .pipe(Effect.option)
      : Option.none<string>();
  if (Option.isSome(dpopProof)) {
    const access = yield* exchangeRemoteDpopAccessToken({
      httpBaseUrl: target.httpBaseUrl,
      credential: target.credential,
      clientMetadata: presentation.metadata,
      dpopProof: dpopProof.value,
    }).pipe(Effect.mapError(mapRemoteEnvironmentError));
    const label = access.environment_label ?? descriptor.label;
    return new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label,
        httpBaseUrl: target.httpBaseUrl,
        wsBaseUrl: target.wsBaseUrl,
      }),
      credential: new DpopConnectionCredential({
        accessToken: access.access_token,
        expiresAtEpochMs: (yield* Clock.currentTimeMillis) + access.expires_in * 1_000,
      }),
    });
  }
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const label = access.environment_label ?? descriptor.label;

  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
    }),
    credential: new BearerConnectionCredential({
      token: access.access_token,
    }),
  });
});

const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const registration = yield* preparePairingRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const knownAddressOnly = input.expectedEnvironmentId === undefined;
  if (!(yield* registry.register(registration, { knownAddressOnly }))) {
    return registration.target.environmentId;
  }
  yield* registry.setCompatibility(registration.target.environmentId, null);
  yield* registry
    .setEnabled(registration.target.environmentId, true)
    .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));
  return registration.target.environmentId;
});

const claimPairingInviteConnection = Effect.fn(
  "clientRuntime.connection.onboarding.claimPairingInviteConnection",
)(function* (
  input: PairingInviteClaimInput,
): Effect.fn.Return<
  PairingInviteClaimResult,
  ConnectionAttemptError,
  | EnvironmentRegistry.EnvironmentRegistry
  | ClientCapabilities.ClientPresentation
  | HttpClient.HttpClient
> {
  const inviteId = yield* validatePairingInviteId(input.invite.inviteId);
  const httpBaseUrl = yield* normalizePairingInviteBaseUrl(input.invite.baseUrl);
  const signer = yield* requireDpopSigner();
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const { descriptor } = yield* verifyPairingInviteDescriptor({
    httpBaseUrl,
    environmentId: input.invite.environmentId,
    ...(input.expectedEnvironmentId === undefined
      ? {}
      : { expectedEnvironmentId: input.expectedEnvironmentId }),
  });
  const claimUrl = makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).auth.claimPairingInvite({
    params: { inviteId },
  });
  const dpopProof = yield* createPairingInviteDpopProof(signer, {
    method: "POST",
    url: claimUrl,
  });
  const claimed = yield* claimRemotePairingInvite({
    httpBaseUrl,
    inviteId,
    dpopProof,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteDpopEnvironmentError));
  return {
    inviteId,
    environmentId: descriptor.environmentId,
    environmentLabel: descriptor.label,
    httpBaseUrl,
    verificationCode: claimed.verificationCode,
    expiresAt: claimed.expiresAt,
  };
});

const pollPairingInviteClaimConnection = Effect.fn(
  "clientRuntime.connection.onboarding.pollPairingInviteClaimConnection",
)(function* (
  input: PairingInvitePollInput,
): Effect.fn.Return<AuthPairingInviteClaimStatus, ConnectionAttemptError, HttpClient.HttpClient> {
  const inviteId = yield* validatePairingInviteId(input.inviteId);
  const httpBaseUrl = yield* normalizePairingInviteBaseUrl(input.httpBaseUrl);
  const signer = yield* requireDpopSigner();
  const pollUrl = makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).auth.getPairingInviteClaim({
    params: { inviteId },
  });
  const dpopProof = yield* createPairingInviteDpopProof(signer, {
    method: "GET",
    url: pollUrl,
  });
  return yield* fetchRemotePairingInviteClaim({
    httpBaseUrl,
    inviteId,
    dpopProof,
  }).pipe(Effect.mapError(mapRemoteDpopEnvironmentError));
});

const completePairingInviteConnection = Effect.fn(
  "clientRuntime.connection.onboarding.completePairingInviteConnection",
)(function* (
  input: PairingInviteCompleteInput,
): Effect.fn.Return<
  EnvironmentId,
  ConnectionAttemptError | Persistence.ConnectionPersistenceError,
  | EnvironmentRegistry.EnvironmentRegistry
  | ClientCapabilities.ClientPresentation
  | HttpClient.HttpClient
> {
  const httpBaseUrl = yield* normalizePairingInviteBaseUrl(input.httpBaseUrl);
  const credential = input.credential.trim();
  if (!credential) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      ...translatableDetail(msg("The pairing credential is missing.")),
    });
  }
  const signer = yield* requireDpopSigner();
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const { descriptor, connectionId, wsBaseUrl } = yield* verifyPairingInviteDescriptor({
    httpBaseUrl,
    environmentId: input.environmentId,
    ...(input.expectedEnvironmentId === undefined
      ? {}
      : { expectedEnvironmentId: input.expectedEnvironmentId }),
  });
  const tokenUrl = makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).auth.token();
  const dpopProof = yield* createPairingInviteDpopProof(signer, {
    method: "POST",
    url: tokenUrl,
  });
  const access = yield* exchangeRemoteDpopAccessToken({
    httpBaseUrl,
    credential,
    clientMetadata: presentation.metadata,
    dpopProof,
    disallowRedirects: true,
  }).pipe(Effect.mapError(mapRemoteDpopEnvironmentError));
  if (access.token_type !== "DPoP") {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      hop: "server",
      ...translatableDetail(msg("The environment did not issue a key-bound session token.")),
    });
  }
  const label = access.environment_label ?? (descriptor.label || input.environmentLabel);
  const registration = new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl,
    }),
    credential: new DpopConnectionCredential({
      accessToken: access.access_token,
      expiresAtEpochMs: (yield* Clock.currentTimeMillis) + access.expires_in * 1_000,
    }),
  });
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const knownAddressOnly = input.expectedEnvironmentId === undefined;
  if (!(yield* registry.register(registration, { knownAddressOnly }))) {
    return registration.target.environmentId;
  }
  yield* registry.setCompatibility(registration.target.environmentId, null);
  yield* registry
    .setEnabled(registration.target.environmentId, true)
    .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));
  return registration.target.environmentId;
});

const REACHABILITY_TIMEOUT_MS = 6_000;

const reachesEnvironment = Effect.fn("clientRuntime.connection.onboarding.reachesEnvironment")(
  function* (input: { readonly host: string; readonly environmentId: EnvironmentId }) {
    const httpBaseUrl = yield* Effect.try({
      try: () => normalizeHttpBaseUrl(input.host),
      catch: () =>
        new ConnectionBlockedError({
          reason: "configuration",
          ...translatableDetail(msg("The environment URL is invalid.")),
        }),
    });
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl,
      timeoutMs: REACHABILITY_TIMEOUT_MS,
    });
    return descriptor.environmentId === input.environmentId;
  },
  Effect.orElseSucceed(() => false),
);

const isBearerProfile = Schema.is(BearerConnectionProfile);

const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const saved = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  const route =
    saved === undefined
      ? undefined
      : connectionRoutes(saved).find(
          (candidate) => candidate.target._tag === "BearerConnectionTarget",
        );
  const entry = saved === undefined || route === undefined ? saved : routeEntry(saved, route);
  const credential =
    entry?.target._tag === "BearerConnectionTarget"
      ? yield* credentials.get(entry.target.connectionId)
      : Option.none();
  const registration = yield* prepareBearerConnectionUpdate({
    input,
    entry: Option.fromUndefinedOr(entry),
    credential,
  });
  yield* registry.register(registration);
});

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === undefined ||
    entry === null ||
    entry.target._tag !== "BearerConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isBearerProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      ...translatableDetail(msg("Only saved bearer environments can be edited.")),
    });
  }

  const credential = options.credential;
  if (Option.isNone(credential)) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      ...translatableDetail(msg("The saved bearer credential is unavailable.")),
    });
  }

  const label = options.input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      ...translatableDetail(msg("Environment label cannot be empty.")),
    });
  }
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(options.input.httpBaseUrl),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        ...(cause instanceof Error
          ? detailFromError(cause)
          : translatableDetail(msg("The environment URL is invalid."))),
      }),
  });
  const connectionId = entry.target.connectionId;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    }),
    credential: credential.value,
  });
});

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
  const provisioned = yield* gateway.provision(input.target, input.expectedEnvironmentId);
  const connectionId = `ssh:${provisioned.environmentId}:${sshTargetKey(provisioned.bootstrap.target)}`;
  const label = input.label?.trim() || provisioned.label || provisioned.bootstrap.target.alias;

  return new SshConnectionRegistration({
    target: new SshConnectionTarget({
      environmentId: provisioned.environmentId,
      label,
      connectionId,
    }),
    profile: new SshConnectionProfile({
      connectionId,
      environmentId: provisioned.environmentId,
      label,
      target: provisioned.bootstrap.target,
    }),
    credential: new BearerConnectionCredential({ token: provisioned.bearerToken }),
  });
});

const registerSshConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSshConnection",
)(function* (input: SshConnectionInput) {
  const registration = yield* prepareSshRegistration(input);
  if (
    input.expectedEnvironmentId !== undefined &&
    registration.target.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(registration.target.label);
  }
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration, {
    knownAddressOnly: input.expectedEnvironmentId === undefined,
  });
  return registration.target.environmentId;
});

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const dpopSigner = yield* Effect.serviceOption(Dpop.DpopSigner);
  const provideOptionalDpop = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Option.isSome(dpopSigner)
      ? Effect.provideService(effect, Dpop.DpopSigner, dpopSigner.value)
      : effect;

  // Provisioning retains the delegated onboarding operation spans.
  return ConnectionOnboarding.of({
    registerPairing: Effect.fnUntraced(
      function* (input) {
        return yield* registerPairingConnection(input);
      },
      provideOptionalDpop,
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
    claimPairingInvite: Effect.fnUntraced(
      function* (input) {
        return yield* claimPairingInviteConnection(input);
      },
      provideOptionalDpop,
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
    pollPairingInviteClaim: Effect.fnUntraced(
      function* (input) {
        return yield* pollPairingInviteClaimConnection(input);
      },
      provideOptionalDpop,
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
    completePairingInvite: Effect.fnUntraced(
      function* (input) {
        return yield* completePairingInviteConnection(input);
      },
      provideOptionalDpop,
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
    registerSsh: Effect.fnUntraced(
      function* (input) {
        return yield* registerSshConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
    ),
    updateBearer: Effect.fnUntraced(
      function* (input) {
        return yield* updateBearerConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
    ),
    reaches: Effect.fnUntraced(
      function* (input) {
        return yield* reachesEnvironment(input);
      },
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);
