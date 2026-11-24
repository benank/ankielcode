import assert from "node:assert/strict";

import {
  buildHostChallengeMessage,
  deriveHostId,
  encodeBase64Url,
  signRelaySecret,
} from "../src/crypto.ts";
import {
  BINARY_FRAME_HTTP_REQ_BODY,
  BINARY_FRAME_HTTP_RES_BODY,
  BINARY_FRAME_WS_DATA,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from "../src/protocol.ts";

const baseUrl = (process.env.RELAY_URL ?? "http://127.0.0.1:8789").replace(/\/$/, "");
const wsBaseUrl = baseUrl.replace(/^http/, "ws");
const relaySecret = process.env.RELAY_SECRET?.trim() || undefined;

function nextMessage(ws, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket message")),
      timeoutMs,
    );
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(event.data);
      },
      { once: true },
    );
    ws.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket closed unexpectedly: ${event.code} ${event.reason}`));
      },
      { once: true },
    );
  });
}

function nextClose(ws, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket close")),
      timeoutMs,
    );
    ws.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        resolve({ code: event.code, reason: event.reason });
      },
      { once: true },
    );
  });
}

async function openSocket(url) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error(`Failed to connect to ${url}`)), {
      once: true,
    });
  });
  return ws;
}

async function run() {
  // 1. Health check
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.service, "ankiel-relay");
  assert.equal(health.configured, true);

  // Generate ephemeral Ed25519 host identity
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const hostId = await deriveHostId(rawPub);

  // Status should never expose connected client counts
  const statusRes = await fetch(`${baseUrl}/relay/status/${hostId}`);
  assert.equal(statusRes.status, 200);
  const statusJson = await statusRes.json();
  assert.deepEqual(statusJson, { hostId, online: false });

  // 2. Offline HTTP request returns 503
  const offlineHttp = await fetch(`${baseUrl}/h/${hostId}/api/ping`);
  assert.equal(offlineHttp.status, 503);

  // 3. Invalid host signature rejected with 4401
  const badHost = await openSocket(`${wsBaseUrl}/relay/host/${hostId}`);
  const badChallenge = JSON.parse(await nextMessage(badHost));
  assert.equal(badChallenge.type, "challenge");
  const badClosePromise = nextClose(badHost);
  badHost.send(
    JSON.stringify({
      type: "auth",
      publicKey: encodeBase64Url(rawPub),
      signature: encodeBase64Url(new Uint8Array(64)),
    }),
  );
  assert.equal((await badClosePromise).code, 4401);

  // 4. Valid host auth (Ed25519 + optional RELAY_SECRET HMAC)
  const hostWs = await openSocket(`${wsBaseUrl}/relay/host/${hostId}`);
  const challenge = JSON.parse(await nextMessage(hostWs));
  assert.equal(challenge.type, "challenge");
  const challengeBytes = buildHostChallengeMessage(hostId, challenge.nonce, challenge.timestamp);
  const signature = new Uint8Array(
    await crypto.subtle.sign("Ed25519", keyPair.privateKey, challengeBytes),
  );
  const secretProof = relaySecret
    ? await signRelaySecret(relaySecret, hostId, challenge.nonce, challenge.timestamp)
    : undefined;
  hostWs.send(
    JSON.stringify({
      type: "auth",
      publicKey: encodeBase64Url(rawPub),
      signature: encodeBase64Url(signature),
      ...(secretProof ? { secretProof } : {}),
    }),
  );
  assert.deepEqual(JSON.parse(await nextMessage(hostWs)), { type: "ready", hostId });

  // 5. Full HTTP POST tunnel via /h/<hostId>/api/echo?x=1 (request body + response streaming)
  const httpBodies = new Map();
  const handleHostHttp = (event) => {
    if (typeof event.data === "string") {
      const msg = JSON.parse(event.data);
      if (msg.type === "http_request") {
        httpBodies.set(msg.reqId, { msg, chunks: [] });
        if (!msg.hasBody) {
          respondEcho(msg.reqId);
        }
      } else if (msg.type === "http_request_end") {
        respondEcho(msg.reqId);
      }
      return;
    }
    const bin = decodeBinaryFrame(event.data);
    if (bin?.kind === BINARY_FRAME_HTTP_REQ_BODY) {
      httpBodies.get(bin.id)?.chunks.push(bin.payload);
    }
  };
  const respondEcho = (reqId) => {
    const entry = httpBodies.get(reqId);
    if (!entry) return;
    httpBodies.delete(reqId);
    const bodyText = Buffer.concat(entry.chunks.map((c) => Buffer.from(c))).toString("utf8");
    const responseJson = JSON.stringify({
      method: entry.msg.method,
      path: entry.msg.path,
      authHeader: Object.fromEntries(entry.msg.headers).authorization ?? null,
      body: bodyText,
    });
    const encoded = new TextEncoder().encode(responseJson);
    hostWs.send(
      JSON.stringify({
        type: "http_response_start",
        reqId,
        status: 201,
        headers: [
          ["content-type", "application/json"],
          ["x-tunneled", "yes"],
        ],
      }),
    );
    hostWs.send(encodeBinaryFrame(BINARY_FRAME_HTTP_RES_BODY, reqId, encoded.subarray(0, 10)));
    hostWs.send(encodeBinaryFrame(BINARY_FRAME_HTTP_RES_BODY, reqId, encoded.subarray(10)));
    hostWs.send(JSON.stringify({ type: "http_response_end", reqId }));
  };

  hostWs.addEventListener("message", handleHostHttp);

  const postRes = await fetch(`${baseUrl}/h/${hostId}/api/echo?x=1`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      Authorization: "DPoP my-token",
    },
    body: "hello-tunneled-http",
  });
  assert.equal(postRes.status, 201);
  assert.equal(postRes.headers.get("x-tunneled"), "yes");
  assert.deepEqual(await postRes.json(), {
    method: "POST",
    path: "/api/echo?x=1",
    authHeader: "DPoP my-token",
    body: "hello-tunneled-http",
  });

  // 6. GET request with no body via path prefix
  const getRes = await fetch(`${baseUrl}/h/${hostId}/api/health?ok=true`);
  assert.equal(getRes.status, 201);
  assert.deepEqual(await getRes.json(), {
    method: "GET",
    path: "/api/health?ok=true",
    authHeader: null,
    body: "",
  });

  hostWs.removeEventListener("message", handleHostHttp);

  // 7. Raw WebSocket tunnel via /h/<hostId>/ws?ticket=abc (no control frame injected to client!)
  const hostOpenPromise = nextMessage(hostWs);
  const wsClient = await openSocket(`${wsBaseUrl}/h/${hostId}/ws?ticket=abc`);
  const hostOpen = JSON.parse(await hostOpenPromise);
  assert.equal(hostOpen.type, "client_open");
  assert.equal(hostOpen.path, "/ws?ticket=abc");
  const connId = hostOpen.connId;

  // Client -> Host text
  const hostTextPromise = nextMessage(hostWs);
  wsClient.send(JSON.stringify({ rpc: "ping" }));
  assert.deepEqual(JSON.parse(await hostTextPromise), {
    type: "frame",
    connId,
    data: JSON.stringify({ rpc: "ping" }),
  });

  // Host -> Client text (arrives directly as first message on raw client tunnel!)
  const clientTextPromise = nextMessage(wsClient);
  hostWs.send(JSON.stringify({ type: "frame", connId, data: JSON.stringify({ rpc: "pong" }) }));
  assert.equal(await clientTextPromise, JSON.stringify({ rpc: "pong" }));

  // Client -> Host binary & Host -> Client binary
  const sampleBin = new Uint8Array([1, 2, 3, 4, 255]);
  const hostBinPromise = nextMessage(hostWs);
  wsClient.send(sampleBin);
  const decodedBin = decodeBinaryFrame(await hostBinPromise);
  assert.ok(decodedBin);
  assert.equal(decodedBin.kind, BINARY_FRAME_WS_DATA);
  assert.equal(decodedBin.id, connId);
  assert.deepEqual(decodedBin.payload, sampleBin);

  const replyBin = new Uint8Array([99, 98, 97]);
  const clientBinPromise = nextMessage(wsClient);
  hostWs.send(encodeBinaryFrame(BINARY_FRAME_WS_DATA, connId, replyBin));
  assert.deepEqual(new Uint8Array(await clientBinPromise), replyBin);

  // 8. Host disconnect closes tunneled WS client with 4503
  const clientClosePromise = nextClose(wsClient);
  hostWs.close(1000, "shutdown");
  assert.equal((await clientClosePromise).code, 4503);

  console.log(`All full HTTP+WS relay E2E checks passed against ${baseUrl} (hostId=${hostId})`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
