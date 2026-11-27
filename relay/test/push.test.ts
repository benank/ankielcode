import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  buildHostChallengeMessage,
  decodeBase64Url,
  deriveHostId,
  encodeBase64Url,
} from "../src/crypto.ts";
import {
  MAX_PUSH_DELIVERIES,
  parseHostControlMessage,
  parseRejectedPush,
  type PushMessage,
} from "../src/protocol.ts";
import { APNS_JWT_REFRESH_MS, getApnsJwt, resetApnsJwtCache, sendApns } from "../src/push-apns.ts";
import { resetFcmAccessTokenCache, sendFcm } from "../src/push-fcm.ts";
import {
  deliverPush,
  PUSH_BUCKET_CAPACITY,
  pushAvailability,
  PushRateLimiter,
  type PushEnv,
} from "../src/push.ts";
import { RelayRoom } from "../src/relay-room.ts";

const { afterEach, beforeEach, describe, it } = NodeTest;

const NOW = 1_800_000_000_000;
const APNS_TOKEN = "a".repeat(64);
const FCM_TOKEN = "fcm-token:APA91b_example";

function toPem(label: string, der: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

async function makeApnsKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pem = toPem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { pem, publicKey: pair.publicKey };
}

async function makeFcmAccountJson() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return JSON.stringify({
    project_id: "demo-project",
    client_email: "push@demo-project.iam.gserviceaccount.com",
    private_key: toPem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  });
}

const apnsKey = await makeApnsKey();
const fcmAccountJson = await makeFcmAccountJson();
const apnsCredentials = { keyP8: apnsKey.pem, keyId: "KEY1234567", teamId: "TEAM123456" };
const apnsEnv: PushEnv = {
  APNS_KEY_P8: apnsKey.pem,
  APNS_KEY_ID: apnsCredentials.keyId,
  APNS_TEAM_ID: apnsCredentials.teamId,
};

function apnsDelivery(overrides: Record<string, unknown> = {}) {
  return {
    platform: "apns",
    token: APNS_TOKEN,
    topic: "com.example.app",
    environment: "production",
    payload: { aps: { alert: { "loc-key": "done" } } },
    ...overrides,
  };
}

function fcmDelivery(overrides: Record<string, unknown> = {}) {
  return { platform: "fcm", token: FCM_TOKEN, data: { threadId: "t1" }, ...overrides };
}

function pushJson(deliveries: unknown[], pushId: unknown = "push-1") {
  return JSON.stringify({ type: "push", pushId, deliveries });
}

function parsePush(deliveries: unknown[]): PushMessage {
  const parsed = parseHostControlMessage(pushJson(deliveries));
  NodeAssert.ok(parsed?.type === "push");
  return parsed;
}

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function mockFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(part)!)) as Record<string, unknown>;
}

beforeEach(() => {
  resetApnsJwtCache();
  resetFcmAccessTokenCache();
});

describe("push protocol", () => {
  it("parses APNs and FCM deliveries and ignores unknown fields", () => {
    const message = parsePush([
      apnsDelivery({
        pushType: "background",
        priority: 5,
        collapseId: "thread-1",
        expiration: 0,
        future: 1,
      }),
      fcmDelivery({ priority: "normal", collapseKey: "thread-1", ttlSeconds: 300 }),
    ]);
    NodeAssert.deepEqual(message, {
      type: "push",
      pushId: "push-1",
      deliveries: [
        {
          platform: "apns",
          token: APNS_TOKEN,
          topic: "com.example.app",
          environment: "production",
          payload: { aps: { alert: { "loc-key": "done" } } },
          pushType: "background",
          priority: 5,
          collapseId: "thread-1",
          expiration: 0,
        },
        {
          platform: "fcm",
          token: FCM_TOKEN,
          data: { threadId: "t1" },
          priority: "normal",
          collapseKey: "thread-1",
          ttlSeconds: 300,
        },
      ],
    });
  });

  it("rejects malformed deliveries but keeps the pushId so the host gets an answer", () => {
    const cases: Array<[unknown[], string]> = [
      [[apnsDelivery({ token: "../../3/device/x" })], "invalid_token"],
      [[apnsDelivery({ topic: "com.example/app" })], "invalid_topic"],
      [[apnsDelivery({ environment: "staging" })], "invalid_environment"],
      [[apnsDelivery({ payload: [] })], "invalid_payload"],
      [[apnsDelivery({ payload: { aps: {}, blob: "x".repeat(4096) } })], "payload_too_large"],
      [[apnsDelivery({ priority: 7 })], "invalid_priority"],
      [[apnsDelivery({ collapseId: "x".repeat(65) })], "invalid_collapse_id"],
      [[apnsDelivery({ expiration: -1 })], "invalid_expiration"],
      [[fcmDelivery({ data: { n: 1 } })], "invalid_data"],
      [[fcmDelivery({ data: { "google.foo": "x" } })], "reserved_data_key"],
      [[fcmDelivery({ data: { big: "x".repeat(4096) } })], "payload_too_large"],
      [[fcmDelivery({ ttlSeconds: 1.5 })], "invalid_ttl"],
      [[{ platform: "webpush", token: "x" }], "invalid_platform"],
      [[], "invalid_deliveries"],
      [Array.from({ length: MAX_PUSH_DELIVERIES + 1 }, () => fcmDelivery()), "too_many_deliveries"],
    ];
    for (const [deliveries, reason] of cases) {
      const raw = pushJson(deliveries);
      NodeAssert.equal(parseHostControlMessage(raw), null, reason);
      NodeAssert.deepEqual(parseRejectedPush(raw), { pushId: "push-1", reason });
    }
    NodeAssert.equal(parseRejectedPush(pushJson([fcmDelivery()], 42)), null);
    NodeAssert.equal(parseRejectedPush(JSON.stringify({ type: "ping" })), null);
  });
});

describe("APNs", () => {
  it("signs an ES256 provider JWT and reuses it until the refresh window", async () => {
    const jwt = await getApnsJwt(apnsCredentials, NOW);
    const [header, payload, signature] = jwt.split(".");
    NodeAssert.deepEqual(decodeJwtPart(header!), { alg: "ES256", kid: "KEY1234567" });
    NodeAssert.deepEqual(decodeJwtPart(payload!), { iss: "TEAM123456", iat: NOW / 1000 });
    const rawSignature = decodeBase64Url(signature!)!;
    NodeAssert.equal(rawSignature.byteLength, 64);
    NodeAssert.equal(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        apnsKey.publicKey,
        rawSignature,
        new TextEncoder().encode(`${header}.${payload}`),
      ),
      true,
    );

    NodeAssert.equal(await getApnsJwt(apnsCredentials, NOW + APNS_JWT_REFRESH_MS - 1), jwt);
    const refreshed = await getApnsJwt(apnsCredentials, NOW + APNS_JWT_REFRESH_MS);
    NodeAssert.notEqual(refreshed, jwt);
    NodeAssert.equal(
      decodeJwtPart(refreshed.split(".")[1]!).iat,
      (NOW + APNS_JWT_REFRESH_MS) / 1000,
    );
  });

  it("accepts a key whose newlines were pasted as literal \\n", async () => {
    const jwt = await getApnsJwt(
      { ...apnsCredentials, keyP8: apnsKey.pem.replace(/\n/g, "\\n") },
      NOW,
    );
    NodeAssert.equal(jwt.split(".").length, 3);
  });

  it("posts to the delivery's environment with APNs headers", async () => {
    const { calls, fetchImpl } = mockFetch(() => new Response(null, { status: 200 }));
    const delivery = parsePush([
      apnsDelivery({ environment: "sandbox", collapseId: "c1", expiration: 99 }),
    ]).deliveries[0]!;
    NodeAssert.ok(delivery.platform === "apns");
    const result = await sendApns(delivery, apnsCredentials, fetchImpl, NOW);
    NodeAssert.deepEqual(result, { token: APNS_TOKEN, platform: "apns", ok: true, status: 200 });
    NodeAssert.equal(calls[0]!.url, `https://api.sandbox.push.apple.com/3/device/${APNS_TOKEN}`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    NodeAssert.equal(headers["apns-topic"], "com.example.app");
    NodeAssert.equal(headers["apns-push-type"], "alert");
    NodeAssert.equal(headers["apns-priority"], "10");
    NodeAssert.equal(headers["apns-collapse-id"], "c1");
    NodeAssert.equal(headers["apns-expiration"], "99");
    NodeAssert.match(headers.authorization!, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    NodeAssert.equal(
      calls[0]!.init.body,
      JSON.stringify({ aps: { alert: { "loc-key": "done" } } }),
    );
  });

  it("maps dead tokens to unregistered and leaves other failures alone", async () => {
    const delivery = parsePush([apnsDelivery()]).deliveries[0]!;
    NodeAssert.ok(delivery.platform === "apns");
    const cases: Array<[number, string | null, boolean]> = [
      [410, "Unregistered", true],
      [410, null, true],
      [400, "BadDeviceToken", true],
      [400, "DeviceTokenNotForTopic", true],
      [400, "PayloadTooLarge", false],
      [429, "TooManyRequests", false],
      [500, "InternalServerError", false],
    ];
    for (const [status, reason, unregistered] of cases) {
      const { fetchImpl } = mockFetch(() =>
        reason === null ? new Response(null, { status }) : Response.json({ reason }, { status }),
      );
      const result = await sendApns(delivery, apnsCredentials, fetchImpl, NOW);
      NodeAssert.equal(result.ok, false);
      NodeAssert.equal(result.status, status);
      NodeAssert.equal(result.unregistered === true, unregistered, `${status} ${reason}`);
    }
  });

  it("drops a rejected provider token and never echoes fetch errors", async () => {
    const delivery = parsePush([apnsDelivery()]).deliveries[0]!;
    NodeAssert.ok(delivery.platform === "apns");
    const first = await getApnsJwt(apnsCredentials, NOW);
    const { fetchImpl } = mockFetch(() =>
      Response.json({ reason: "ExpiredProviderToken" }, { status: 403 }),
    );
    const expired = await sendApns(delivery, apnsCredentials, fetchImpl, NOW);
    NodeAssert.equal(expired.unregistered, undefined);
    NodeAssert.notEqual(await getApnsJwt(apnsCredentials, NOW), first);

    const failing = (async (input: RequestInfo | URL) => {
      throw new Error(`connect failed ${String(input)}`);
    }) as typeof fetch;
    const result = await sendApns(delivery, apnsCredentials, failing, NOW);
    NodeAssert.deepEqual(result, {
      token: APNS_TOKEN,
      platform: "apns",
      ok: false,
      reason: "network_error",
    });
  });
});

describe("FCM", () => {
  const account = {
    projectId: "demo-project",
    clientEmail: "push@demo-project.iam.gserviceaccount.com",
    privateKey: (JSON.parse(fcmAccountJson) as { private_key: string }).private_key,
  };

  function fcmFetch(sendResponse: () => Response) {
    return mockFetch((url) =>
      url === "https://oauth2.googleapis.com/token"
        ? Response.json({ access_token: "ya29.token", expires_in: 3600 })
        : sendResponse(),
    );
  }

  it("exchanges a service-account assertion once and sends data messages", async () => {
    const { calls, fetchImpl } = fcmFetch(() => Response.json({ name: "projects/x/messages/1" }));
    const delivery = parsePush([fcmDelivery({ ttlSeconds: 60, collapseKey: "k" })]).deliveries[0]!;
    NodeAssert.ok(delivery.platform === "fcm");
    NodeAssert.equal((await sendFcm(delivery, account, fetchImpl, NOW)).ok, true);
    NodeAssert.equal((await sendFcm(delivery, account, fetchImpl, NOW + 1000)).ok, true);

    NodeAssert.equal(calls.filter((call) => call.url.includes("oauth2")).length, 1);
    const assertion = new URLSearchParams(String(calls[0]!.init.body)).get("assertion")!;
    NodeAssert.deepEqual(decodeJwtPart(assertion.split(".")[0]!), { alg: "RS256", typ: "JWT" });
    NodeAssert.equal(decodeJwtPart(assertion.split(".")[1]!).iss, account.clientEmail);

    const send = calls[1]!;
    NodeAssert.equal(send.url, "https://fcm.googleapis.com/v1/projects/demo-project/messages:send");
    NodeAssert.equal(
      (send.init.headers as Record<string, string>).authorization,
      "Bearer ya29.token",
    );
    NodeAssert.deepEqual(JSON.parse(String(send.init.body)), {
      message: {
        token: FCM_TOKEN,
        data: { threadId: "t1" },
        android: { priority: "HIGH", ttl: "60s", collapse_key: "k" },
      },
    });
  });

  it("marks only token failures as unregistered", async () => {
    const delivery = parsePush([fcmDelivery()]).deliveries[0]!;
    NodeAssert.ok(delivery.platform === "fcm");
    const fcmError =
      (status: number, code: string, extra: Record<string, unknown> = {}) =>
      () =>
        Response.json(
          {
            error: {
              status: code,
              details: [
                { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: code },
              ],
              ...extra,
            },
          },
          { status },
        );
    const badRequest = (field: string) => ({
      "@type": "type.googleapis.com/google.rpc.BadRequest",
      fieldViolations: [{ field, description: "Invalid value" }],
    });
    const cases: Array<[() => Response, boolean]> = [
      [fcmError(404, "UNREGISTERED"), true],
      [
        fcmError(400, "INVALID_ARGUMENT", {
          message: "The registration token is not a valid FCM registration token",
        }),
        true,
      ],
      [
        () =>
          Response.json(
            {
              error: {
                status: "INVALID_ARGUMENT",
                message: "Invalid value",
                details: [badRequest("message.token")],
              },
            },
            { status: 400 },
          ),
        true,
      ],
      [
        () =>
          Response.json(
            {
              error: {
                status: "INVALID_ARGUMENT",
                message: "Invalid value at 'message.data[0].value'",
                details: [badRequest("message.data[0].value")],
              },
            },
            { status: 400 },
          ),
        false,
      ],
      [fcmError(429, "QUOTA_EXCEEDED"), false],
      [fcmError(403, "SENDER_ID_MISMATCH"), false],
    ];
    for (const [respond, unregistered] of cases) {
      resetFcmAccessTokenCache();
      const { fetchImpl } = fcmFetch(respond);
      const result = await sendFcm(delivery, account, fetchImpl, NOW);
      NodeAssert.equal(result.ok, false);
      NodeAssert.equal(result.unregistered === true, unregistered, JSON.stringify(result));
    }
  });

  it("reports an OAuth failure without caching it", async () => {
    const delivery = parsePush([fcmDelivery()]).deliveries[0]!;
    NodeAssert.ok(delivery.platform === "fcm");
    const failing = mockFetch(() => new Response("nope", { status: 400 }));
    NodeAssert.deepEqual(await sendFcm(delivery, account, failing.fetchImpl, NOW), {
      token: FCM_TOKEN,
      platform: "fcm",
      ok: false,
      reason: "fcm_auth_failed",
    });
    const { fetchImpl } = fcmFetch(() => Response.json({}));
    NodeAssert.equal((await sendFcm(delivery, account, fetchImpl, NOW)).ok, true);
  });
});

describe("push dispatch", () => {
  function deps(env: PushEnv, fetchImpl: typeof fetch, now = () => NOW) {
    return { env, rateLimiter: new PushRateLimiter(NOW), fetch: fetchImpl, now };
  }

  it("reports availability from the secrets that are present", () => {
    NodeAssert.deepEqual(pushAvailability({}), { apns: false, fcm: false });
    NodeAssert.deepEqual(pushAvailability(apnsEnv), { apns: true, fcm: false });
    NodeAssert.deepEqual(
      pushAvailability({ ...apnsEnv, APNS_TEAM_ID: " ", FCM_SERVICE_ACCOUNT_JSON: fcmAccountJson }),
      { apns: false, fcm: true },
    );
    NodeAssert.deepEqual(pushAvailability({ FCM_SERVICE_ACCOUNT_JSON: "{" }), {
      apns: false,
      fcm: false,
    });
  });

  it("fails every delivery with push_not_configured when no secrets are set", async () => {
    const { calls, fetchImpl } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await deliverPush(
      parsePush([apnsDelivery(), fcmDelivery()]),
      deps({}, fetchImpl),
    );
    NodeAssert.deepEqual(result, {
      type: "push_result",
      pushId: "push-1",
      error: "push_not_configured",
      results: [
        { token: APNS_TOKEN, platform: "apns", ok: false, reason: "push_not_configured" },
        { token: FCM_TOKEN, platform: "fcm", ok: false, reason: "push_not_configured" },
      ],
    });
    NodeAssert.equal(calls.length, 0);
  });

  it("answers per delivery when only one platform is configured or a topic is not allowed", async () => {
    const { calls, fetchImpl } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await deliverPush(
      parsePush([apnsDelivery(), fcmDelivery(), apnsDelivery({ topic: "com.other.app" })]),
      deps({ ...apnsEnv, APNS_TOPICS: "com.example.app, com.example.app.dev" }, fetchImpl),
    );
    NodeAssert.equal(result.error, undefined);
    NodeAssert.deepEqual(
      result.results.map((entry) => [entry.platform, entry.ok, entry.reason, entry.unregistered]),
      [
        ["apns", true, undefined, undefined],
        ["fcm", false, "push_not_configured", undefined],
        ["apns", false, "topic_not_allowed", undefined],
      ],
    );
    NodeAssert.equal(calls.length, 1);
  });

  it("rate limits deliveries per host and refills over time", async () => {
    let now = NOW;
    const { calls, fetchImpl } = mockFetch(() => new Response(null, { status: 200 }));
    const pushDeps = deps(apnsEnv, fetchImpl, () => now);
    const batch = parsePush(Array.from({ length: 30 }, () => apnsDelivery()));
    for (let i = 0; i < PUSH_BUCKET_CAPACITY / 30; i++) {
      NodeAssert.equal((await deliverPush(batch, pushDeps)).error, undefined);
    }
    const limited = await deliverPush(batch, pushDeps);
    NodeAssert.equal(limited.error, "rate_limited");
    NodeAssert.equal(limited.results.length, 30);
    NodeAssert.ok(
      limited.results.every((entry) => entry.reason === "rate_limited" && !entry.unregistered),
    );
    NodeAssert.equal(calls.length, PUSH_BUCKET_CAPACITY);

    now += 15_000;
    NodeAssert.equal((await deliverPush(batch, pushDeps)).error, undefined);
    NodeAssert.equal((await deliverPush(batch, pushDeps)).error, "rate_limited");
  });

  it("keeps result order while capping concurrency", async () => {
    const gates: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    let wake: (() => void) | null = null;
    const fetchImpl = ((input: RequestInfo | URL) =>
      new Promise<Response>((resolve) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        gates.push(() => {
          inFlight--;
          const token = String(input).split("/").pop()!;
          resolve(
            token.endsWith("1")
              ? Response.json({ reason: "Unregistered" }, { status: 410 })
              : new Response(null, { status: 200 }),
          );
        });
        wake?.();
      })) as typeof fetch;
    const nextFetch = () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      });

    const tokens = Array.from(
      { length: 20 },
      (_, i) => `${"b".repeat(62)}${String(i).padStart(2, "0")}`,
    );
    const pending = deliverPush(
      parsePush(tokens.map((token) => apnsDelivery({ token }))),
      deps(apnsEnv, fetchImpl),
    );
    for (let released = 0; released < tokens.length; released++) {
      const expected = Math.min(6, tokens.length - released);
      while (gates.length < expected) await nextFetch();
      NodeAssert.equal(inFlight, expected);
      gates.shift()!();
    }
    const result = await pending;

    NodeAssert.equal(peak, 6);
    NodeAssert.deepEqual(
      result.results.map((entry) => entry.token),
      tokens,
    );
    NodeAssert.deepEqual(
      result.results.map((entry) => entry.unregistered === true),
      tokens.map((token) => token.endsWith("1")),
    );
  });
});

class FakeSocket {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private attachment: unknown = null;
  readonly tags: string[];

  constructor(tags: string[]) {
    this.tags = tags;
  }

  send(data: string) {
    this.sent.push(data);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return this.attachment;
  }
  messages() {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

async function makeRoom(env: Record<string, unknown>) {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const hostId = await deriveHostId(rawPub);
  const nonce = "test-nonce";
  const timestamp = NOW;
  const socket = new FakeSocket(["host"]);
  socket.serializeAttachment({ role: "host-pending", hostId, nonce, timestamp });
  const ctx = {
    getWebSockets: (tag: string) => (socket.tags.includes(tag) ? [socket] : []),
    storage: { setAlarm: async () => {} },
  };
  const room = new RelayRoom(ctx as never, env as never);
  const authenticate = async () => {
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        buildHostChallengeMessage(hostId, nonce, timestamp),
      ),
    );
    await room.webSocketMessage(
      socket as never,
      JSON.stringify({
        type: "auth",
        publicKey: encodeBase64Url(rawPub),
        signature: encodeBase64Url(signature),
      }),
    );
  };
  return { room, socket, hostId, authenticate };
}

describe("RelayRoom push", () => {
  beforeEach(() => {
    NodeTest.mock.timers.enable({ apis: ["Date"], now: NOW });
  });
  afterEach(() => {
    NodeTest.mock.timers.reset();
  });

  it("rejects push before the host authenticates", async () => {
    const { room, socket } = await makeRoom(apnsEnv);
    await room.webSocketMessage(socket as never, pushJson([apnsDelivery()]));
    NodeAssert.deepEqual(socket.messages(), [
      {
        type: "error",
        code: "auth_required",
        message: "Authenticate before sending relay traffic.",
      },
    ]);
    NodeAssert.deepEqual(socket.closed, { code: 4401, reason: "auth_required" });
  });

  it("advertises push availability in ready", async () => {
    const configured = await makeRoom({ ...apnsEnv, RELAY_SECRET: "" });
    await configured.authenticate();
    NodeAssert.deepEqual(configured.socket.messages(), [
      { type: "ready", hostId: configured.hostId, push: { apns: true, fcm: false } },
    ]);

    const bare = await makeRoom({});
    await bare.authenticate();
    await bare.room.webSocketMessage(
      bare.socket as never,
      JSON.stringify({ type: "auth", publicKey: "x", signature: "y" }),
    );
    NodeAssert.deepEqual(bare.socket.messages(), [
      { type: "ready", hostId: bare.hostId, push: { apns: false, fcm: false } },
      { type: "ready", hostId: bare.hostId, push: { apns: false, fcm: false } },
    ]);
  });

  it("answers authenticated pushes, including invalid and unconfigured ones", async () => {
    const { room, socket, authenticate } = await makeRoom({});
    await authenticate();
    socket.sent.length = 0;

    await room.webSocketMessage(socket as never, pushJson([fcmDelivery()]));
    await room.webSocketMessage(
      socket as never,
      pushJson([apnsDelivery({ token: "nope" })], "push-2"),
    );
    NodeAssert.deepEqual(socket.messages(), [
      {
        type: "push_result",
        pushId: "push-1",
        error: "push_not_configured",
        results: [{ token: FCM_TOKEN, platform: "fcm", ok: false, reason: "push_not_configured" }],
      },
      { type: "push_result", pushId: "push-2", results: [], error: "invalid_push" },
    ]);
    NodeAssert.equal(socket.closed, null);
  });
});
