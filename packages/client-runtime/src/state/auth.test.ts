import { AuthSessionId, EnvironmentId } from "@ankielcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Dpop from "../dpop.ts";
import * as RpcHttp from "../rpc/http.ts";
import type * as RpcSession from "../rpc/session.ts";
import {
  applyAuthAccessStreamEvent,
  createAuthEnvironmentAtoms,
  EMPTY_AUTH_ACCESS_SNAPSHOT,
} from "./auth.ts";

describe("applyAuthAccessStreamEvent", () => {
  it("accumulates rapid pairing-link and client updates into one snapshot", () => {
    const pairingLink = {
      id: "pairing-link",
      scopes: ["orchestration:read"],
      subject: "subject",
      label: "Phone",
      createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-04-07T00:05:00.000Z"),
    } as const;
    const clientSession = {
      sessionId: AuthSessionId.make("session-client"),
      subject: "subject",
      scopes: ["orchestration:read"],
      method: "browser-session-cookie",
      client: {
        label: "Phone",
        deviceType: "mobile",
      },
      issuedAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
      expiresAt: DateTime.makeUnsafe("2036-05-07T00:00:00.000Z"),
      lastConnectedAt: null,
      connected: true,
      current: false,
    } as const;

    const withPairingLink = applyAuthAccessStreamEvent(EMPTY_AUTH_ACCESS_SNAPSHOT, {
      version: 1,
      revision: 1,
      type: "pairingLinkUpserted",
      payload: pairingLink,
    });
    const withClient = applyAuthAccessStreamEvent(withPairingLink, {
      version: 1,
      revision: 2,
      type: "clientUpserted",
      payload: clientSession,
    });

    expect(withClient).toEqual({
      pairingLinks: [pairingLink],
      clientSessions: [clientSession],
    });
  });

  it("applies removals without disturbing unrelated access state", () => {
    const snapshot = applyAuthAccessStreamEvent(
      {
        pairingLinks: [
          {
            id: "pairing-link",
            scopes: ["orchestration:read"],
            subject: "subject",
            label: "Phone",
            createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2036-04-07T00:05:00.000Z"),
          },
        ],
        clientSessions: [],
      },
      {
        version: 1,
        revision: 2,
        type: "pairingLinkRemoved",
        payload: { id: "pairing-link" },
      },
    );

    expect(snapshot).toEqual(EMPTY_AUTH_ACCESS_SNAPSHOT);
  });
});

describe("createAuthEnvironmentAtoms pairing invites", () => {
  it.effect(
    "creates, polls, approves, and denies pairing invites with DPoP-bound canonical URLs",
    () =>
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("environment-approver");
        const relayBaseUrl = "https://ankiel-relay.me.workers.dev/h/abcdefghijklmnopqrstuvwxyz/";
        const target = new BearerConnectionTarget({
          environmentId,
          label: "Desk Mac",
          connectionId: "bearer:environment-approver:https://ankiel-relay.me.workers.dev",
        });
        const prepared: PreparedConnection = {
          environmentId,
          label: target.label,
          httpBaseUrl: relayBaseUrl,
          socketUrl: "wss://ankiel-relay.me.workers.dev/h/abcdefghijklmnopqrstuvwxyz/ws",
          httpAuthorization: {
            _tag: "Dpop",
            accessToken: "approver-token",
            expiresAtEpochMs: 3_600_000,
            directConnection: { connectionId: target.connectionId, httpBaseUrl: relayBaseUrl },
          },
          target,
        };
        const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
        const proofs: Array<Dpop.DpopProofInput> = [];
        const responses = [
          Response.json({
            inviteId: "inv:abc",
            expiresAt: "2026-05-01T12:05:00.000Z",
            scopes: ["orchestration:read"],
          }),
          Response.json({
            inviteId: "inv:abc",
            expiresAt: "2026-05-01T12:05:00.000Z",
            scopes: ["orchestration:read"],
            status: "claimed",
            claim: {
              clientLabel: "Phone",
              clientDeviceType: "mobile",
              clientOs: "iOS",
              verificationCode: "123-456",
              claimedAt: "2026-05-01T12:01:00.000Z",
            },
          }),
          Response.json({
            status: "approved",
            grantExpiresAt: "2026-05-01T12:10:00.000Z",
          }),
          Response.json({
            status: "denied",
          }),
        ];
        let index = 0;
        const fetchFn: typeof fetch = async (request, init) => {
          calls.push({ url: String(request), init: init ?? {} });
          return responses[index++]!;
        };
        const preparedRef = yield* SubscriptionRef.make(Option.some(prepared));
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            desired: true,
            network: "online",
            phase: "connected",
            stage: null,
            attempt: 1,
            generation: 1,
            lastFailure: null,
            retryAt: null,
            refusedRouteIds: [],
          }),
          prepared: preparedRef,
          session: yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(Option.none()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const registryService = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
          entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map(),
          ),
          networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
          run: <A, E, R>(_id: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        });
        const signer = Dpop.DpopSigner.of({
          thumbprint: Effect.succeed("approver-key"),
          createProof: (input) =>
            Effect.sync(() => {
              proofs.push(input);
              return `approver-proof-${proofs.length}`;
            }),
        });
        const remoteAuthorization = Layer.mock(
          RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
        )({
          authorizeDirectDpopHttp: (connection) =>
            Effect.succeed({
              _tag: "Dpop" as const,
              accessToken: "approver-token",
              expiresAtEpochMs: 3_600_000,
              directConnection: connection,
            }),
        });
        const atomRuntime = Atom.runtime(
          Layer.mergeAll(
            registryService,
            RpcHttp.layerRemoteHttpClient(fetchFn),
            Layer.succeed(Dpop.DpopSigner, signer),
            remoteAuthorization,
          ),
        );
        const authAtoms = createAuthEnvironmentAtoms(atomRuntime);
        const atomRegistry = AtomRegistry.make();

        const created = yield* authAtoms.createPairingInvite.run(atomRegistry, {
          environmentId,
          input: { label: "Phone", scopes: ["orchestration:read"] },
        });
        const status = yield* authAtoms.getPairingInvite.run(atomRegistry, {
          environmentId,
          input: { inviteId: "inv:abc" },
        });
        const approved = yield* authAtoms.approvePairingInvite.run(atomRegistry, {
          environmentId,
          input: { inviteId: "inv:abc", verificationCode: "123-456" },
        });
        const denied = yield* authAtoms.denyPairingInvite.run(atomRegistry, {
          environmentId,
          input: { inviteId: "inv:abc" },
        });

        expect(created).toEqual({
          inviteId: "inv:abc",
          expiresAt: "2026-05-01T12:05:00.000Z",
          scopes: ["orchestration:read"],
        });
        expect(status).toMatchObject({
          inviteId: "inv:abc",
          status: "claimed",
          claim: { verificationCode: "123-456" },
        });
        expect(approved).toEqual({
          status: "approved",
          grantExpiresAt: "2026-05-01T12:10:00.000Z",
        });
        expect(denied).toEqual({ status: "denied" });

        const expectedUrls = [
          `${relayBaseUrl}api/auth/pairing-invites`,
          `${relayBaseUrl}api/auth/pairing-invites/inv%3Aabc`,
          `${relayBaseUrl}api/auth/pairing-invites/inv%3Aabc/approve`,
          `${relayBaseUrl}api/auth/pairing-invites/inv%3Aabc/deny`,
        ];
        expect(calls.map((call) => call.url)).toEqual(expectedUrls);
        expect(calls.map((call) => call.init.method)).toEqual(["POST", "GET", "POST", "POST"]);
        expect(calls.map((call) => call.init.redirect)).toEqual([
          "error",
          "error",
          "error",
          "error",
        ]);
        expect(proofs).toEqual([
          { method: "POST", url: expectedUrls[0]!, accessToken: "approver-token" },
          { method: "GET", url: expectedUrls[1]!, accessToken: "approver-token" },
          { method: "POST", url: expectedUrls[2]!, accessToken: "approver-token" },
          { method: "POST", url: expectedUrls[3]!, accessToken: "approver-token" },
        ]);
        const approveBody = calls[2]!.init.body;
        expect(
          JSON.parse(
            approveBody instanceof Uint8Array
              ? new TextDecoder().decode(approveBody)
              : String(approveBody),
          ),
        ).toEqual({ verificationCode: "123-456" });
      }),
  );
});
