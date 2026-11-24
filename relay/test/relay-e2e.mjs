import assert from "node:assert/strict";

import {
  buildHostChallengeMessage,
  deriveHostId,
  encodeBase64Url,
} from "../src/crypto.ts";
import { decodeBinaryRelayFrame, encodeBinaryRelayFrame } from "../src/protocol.ts";

const baseUrl = (process.env.RELAY_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const wsBaseUrl = baseUrl.replace(/^http/, "ws");

function nextMessage(ws, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), timeoutMs);
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
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close")), timeoutMs);
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
    ws.addEventListener("error", () => reject(new Error(`Failed to connect to ${url}`)), { once: true });
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

  // Generate ephemeral Ed25519 host identity
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const hostId = await deriveHostId(rawPub);

  // 2. Status offline & client rejected with 503
  const offlineStatus = await (await fetch(`${baseUrl}/relay/status/${hostId}`)).json();
  assert.equal(offlineStatus.online, false);

  const offlineRejected = await new Promise((resolve) => {
    const ws = new WebSocket(`${wsBaseUrl}/relay/client/${hostId}`);
    ws.addEventListener("open", () => {
      ws.close();
      resolve(false);
    });
    ws.addEventListener("error", () => resolve(true));
  });
  assert.equal(offlineRejected, true);

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
  const badClose = await badClosePromise;
  assert.equal(badClose.code, 4401);

  // 4. Valid host Ed25519 auth
  const hostWs = await openSocket(`${wsBaseUrl}/relay/host/${hostId}`);
  const challenge = JSON.parse(await nextMessage(hostWs));
  assert.equal(challenge.type, "challenge");
  const challengeBytes = buildHostChallengeMessage(hostId, challenge.nonce, challenge.timestamp);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keyPair.privateKey, challengeBytes));
  hostWs.send(
    JSON.stringify({
      type: "auth",
      publicKey: encodeBase64Url(rawPub),
      signature: encodeBase64Url(signature),
    }),
  );
  const ready = JSON.parse(await nextMessage(hostWs));
  assert.deepEqual(ready, { type: "ready", hostId });

  const onlineStatus = await (await fetch(`${baseUrl}/relay/status/${hostId}`)).json();
  assert.equal(onlineStatus.online, true);

  // 5. Client connects and exchanges text + binary frames
  const hostOpenPromise = nextMessage(hostWs);
  const clientWs = await openSocket(`${wsBaseUrl}/relay/client/${hostId}`);
  const clientConnected = JSON.parse(await nextMessage(clientWs));
  const hostOpen = JSON.parse(await hostOpenPromise);
  assert.equal(clientConnected.type, "connected");
  assert.equal(hostOpen.type, "client_open");
  assert.equal(clientConnected.connId, hostOpen.connId);
  const connId = clientConnected.connId;

  // Client -> Host text
  const hostTextPromise = nextMessage(hostWs);
  clientWs.send("hello-from-client");
  const hostText = JSON.parse(await hostTextPromise);
  assert.deepEqual(hostText, { type: "frame", connId, data: "hello-from-client" });

  // Host -> Client text
  const clientTextPromise = nextMessage(clientWs);
  hostWs.send(JSON.stringify({ type: "frame", connId, data: "hello-from-host" }));
  assert.equal(await clientTextPromise, "hello-from-host");

  // Client -> Host binary
  const sampleBin = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
  const hostBinPromise = nextMessage(hostWs);
  clientWs.send(sampleBin);
  const hostBinDecoded = decodeBinaryRelayFrame(await hostBinPromise);
  assert.ok(hostBinDecoded);
  assert.equal(hostBinDecoded.connId, connId);
  assert.deepEqual(hostBinDecoded.payload, sampleBin);

  // Host -> Client binary
  const replyBin = new Uint8Array([42, 43, 44, 45]);
  const clientBinPromise = nextMessage(clientWs);
  hostWs.send(encodeBinaryRelayFrame(connId, replyBin));
  assert.deepEqual(new Uint8Array(await clientBinPromise), replyBin);

  // 6. Host disconnect closes client with 4503
  const clientDisconnectPromise = nextClose(clientWs);
  hostWs.close(1000, "bye");
  const clientClose = await clientDisconnectPromise;
  assert.equal(clientClose.code, 4503);

  console.log(`All relay E2E checks passed against ${baseUrl} (hostId=${hostId})`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
