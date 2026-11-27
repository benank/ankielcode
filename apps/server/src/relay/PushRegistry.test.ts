import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@ankielcode/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PushRegistry from "./PushRegistry.ts";
import * as RelayTunnelService from "./RelayTunnelService.ts";

const layerRelay = Layer.mock(RelayTunnelService.RelayTunnelService)({
  getStatus: Effect.succeed({
    configured: true,
    connected: true,
    relayOrigin: "https://relay.example.com",
    routingMode: "subdomain",
    hostId: "host",
    publicBaseUrl: "https://host.relay.example.com/",
    hasSecret: true,
    source: "file",
    lastError: null,
  }),
  pushState: Effect.succeed({ availability: { apns: true, fcm: false }, readyAt: 0 }),
});

const layerRegistry = Layer.mergeAll(PushRegistry.layer, SessionStore.layer).pipe(
  Layer.provide(layerRelay),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("push-registry-test")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-push-registry-test-" })),
);

const pairedPhone = {
  subject: "phone",
  method: "dpop-access-token",
  proofKeyThumbprint: "phone-proof-key",
  ttl: Duration.hours(1),
  client: { label: "Phone", deviceType: "mobile" },
} as const;

const iosToken = (byte: string) => byte.repeat(64);
const register = (token: string) =>
  ({
    platform: "ios",
    token,
    appId: "com.example.app",
    apnsEnvironment: "sandbox",
    kinds: ["completed", "approval"],
    locale: "en",
  }) as const;

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("PushRegistry", (it) => {
  it.effect.each(["revoke", "revokeAllExcept", "revokeByProofKey", "replace"] as const)(
    "drops a session's registration on %s and keeps the others",
    (operation) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const registry = yield* PushRegistry.PushRegistry;
        const owner = yield* sessions.issue({ subject: "owner" });
        const phone = yield* sessions.issue(pairedPhone);
        yield* registry.register(owner.sessionId, register(iosToken("a")));
        const registered = yield* registry.register(phone.sessionId, register(iosToken("b")));
        expect(registered).toEqual({
          relayConfigured: true,
          relayConnected: true,
          available: { ios: true, android: false },
          registration: { platform: "ios", kinds: ["completed", "approval"] },
        });

        if (operation === "revoke") yield* sessions.revoke(phone.sessionId);
        else if (operation === "revokeAllExcept") yield* sessions.revokeAllExcept(owner.sessionId);
        else if (operation === "revokeByProofKey")
          yield* sessions.revokeByProofKey(pairedPhone.proofKeyThumbprint);
        else yield* sessions.issue({ ...pairedPhone, replaceSessionId: phone.sessionId });

        expect((yield* registry.status(phone.sessionId)).registration).toBeNull();
        expect((yield* registry.listActive).map((row) => row.token)).toEqual([iosToken("a")]);
      }).pipe(Effect.provide(Layer.merge(layerRegistry, TestClock.layer()))),
  );

  it.effect("keeps one registration per session and forgets dead tokens for every session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const registry = yield* PushRegistry.PushRegistry;
      const first = yield* sessions.issue(pairedPhone);
      const second = yield* sessions.issue({ ...pairedPhone, proofKeyThumbprint: "other-key" });

      yield* registry.register(first.sessionId, register(iosToken("c")));
      const replaced = yield* registry.register(first.sessionId, {
        platform: "android",
        token: "fcm:token",
        appId: "com.example.app",
        kinds: ["input", "input"],
        locale: "fr",
      });
      expect(replaced.registration).toEqual({ platform: "android", kinds: ["input"] });

      // The same phone paired twice registers one token under both sessions.
      yield* registry.register(second.sessionId, register(iosToken("c")));
      yield* registry.register(first.sessionId, register(iosToken("c")));
      expect(yield* registry.listActive).toHaveLength(2);
      yield* registry.forgetTokens([iosToken("c")]);
      expect(yield* registry.listActive).toEqual([]);

      yield* registry.register(first.sessionId, register(iosToken("d")));
      expect((yield* registry.unregister(first.sessionId)).registration).toBeNull();

      // An expired session can no longer reconnect, so its phone stops getting alerts too.
      yield* registry.register(second.sessionId, register(iosToken("e")));
      yield* TestClock.adjust(Duration.days(31));
      expect(yield* registry.listActive).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(layerRegistry, TestClock.layer()))),
  );
});
