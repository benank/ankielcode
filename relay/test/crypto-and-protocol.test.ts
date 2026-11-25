import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildHostChallengeMessage,
  deriveHostId,
  encodeBase64Url,
  isValidHostId,
  parseAllowedHostIds,
  randomNonce,
  signRelaySecret,
  verifyHostAuth,
} from "../src/crypto.ts";
import {
  BINARY_FRAME_HTTP_REQ_BODY,
  BINARY_FRAME_HTTP_RES_BODY,
  BINARY_FRAME_WS_DATA,
  decodeBinaryFrame,
  decodeBinaryRelayFrame,
  encodeBinaryFrame,
  encodeBinaryRelayFrame,
  filterRequestHeaders,
  parseHostControlMessage,
} from "../src/protocol.ts";

async function makeTestHostKey() {
  const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const hostId = await deriveHostId(rawPub);
  return {
    keyPair,
    rawPub,
    publicKeyBase64Url: encodeBase64Url(rawPub),
    hostId,
  };
}

describe("crypto", () => {
  it("derives a valid 26-char lowercase base32 hostId and verifies Ed25519 challenge", async () => {
    const host = await makeTestHostKey();
    assert.equal(isValidHostId(host.hostId), true);

    const nonce = randomNonce(32);
    const timestamp = Date.now();
    const msg = buildHostChallengeMessage(host.hostId, nonce, timestamp);
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", host.keyPair.privateKey, msg));

    const result = await verifyHostAuth({
      expectedHostId: host.hostId,
      expectedNonce: nonce,
      expectedTimestamp: timestamp,
      publicKeyBase64Url: host.publicKeyBase64Url,
      signatureBase64Url: encodeBase64Url(sig),
      nowMs: timestamp + 1_000,
    });
    assert.deepEqual(result, { ok: true });
  });

  it("enforces RELAY_SECRET HMAC proof when configured", async () => {
    const host = await makeTestHostKey();
    const nonce = randomNonce(32);
    const timestamp = Date.now();
    const secret = "super-secret-relay-key-123";
    const msg = buildHostChallengeMessage(host.hostId, nonce, timestamp);
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", host.keyPair.privateKey, msg));

    const missingSecret = await verifyHostAuth({
      expectedHostId: host.hostId,
      expectedNonce: nonce,
      expectedTimestamp: timestamp,
      publicKeyBase64Url: host.publicKeyBase64Url,
      signatureBase64Url: encodeBase64Url(sig),
      relaySecret: secret,
      nowMs: timestamp,
    });
    assert.deepEqual(missingSecret, { ok: false, reason: "invalid_relay_secret" });

    const wrongSecretProof = await signRelaySecret("wrong-secret", host.hostId, nonce, timestamp);
    const wrongSecret = await verifyHostAuth({
      expectedHostId: host.hostId,
      expectedNonce: nonce,
      expectedTimestamp: timestamp,
      publicKeyBase64Url: host.publicKeyBase64Url,
      signatureBase64Url: encodeBase64Url(sig),
      relaySecret: secret,
      secretProofBase64Url: wrongSecretProof,
      nowMs: timestamp,
    });
    assert.deepEqual(wrongSecret, { ok: false, reason: "invalid_relay_secret" });

    const validSecretProof = await signRelaySecret(secret, host.hostId, nonce, timestamp);
    const ok = await verifyHostAuth({
      expectedHostId: host.hostId,
      expectedNonce: nonce,
      expectedTimestamp: timestamp,
      publicKeyBase64Url: host.publicKeyBase64Url,
      signatureBase64Url: encodeBase64Url(sig),
      relaySecret: secret,
      secretProofBase64Url: validSecretProof,
      nowMs: timestamp,
    });
    assert.deepEqual(ok, { ok: true });
  });

  it("rejects hostId mismatch, tampered signature, and expired challenge", async () => {
    const host = await makeTestHostKey();
    const otherHost = await makeTestHostKey();
    const nonce = randomNonce(32);
    const timestamp = Date.now();
    const msg = buildHostChallengeMessage(host.hostId, nonce, timestamp);
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", host.keyPair.privateKey, msg));

    const wrongId = await verifyHostAuth({
      expectedHostId: otherHost.hostId,
      expectedNonce: nonce,
      expectedTimestamp: timestamp,
      publicKeyBase64Url: host.publicKeyBase64Url,
      signatureBase64Url: encodeBase64Url(sig),
      nowMs: timestamp,
    });
    assert.deepEqual(wrongId, { ok: false, reason: "host_id_mismatch" });

    const tampered = new Uint8Array(sig);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const badSig = await verifyHostAuth({
      expectedHostId: host.hostId,
      expectedNonce: nonce,
      expectedTimestamp: timestamp,
      publicKeyBase64Url: host.publicKeyBase64Url,
      signatureBase64Url: encodeBase64Url(tampered),
      nowMs: timestamp,
    });
    assert.deepEqual(badSig, { ok: false, reason: "invalid_signature" });

    const expired = await verifyHostAuth({
      expectedHostId: host.hostId,
      expectedNonce: nonce,
      expectedTimestamp: timestamp,
      publicKeyBase64Url: host.publicKeyBase64Url,
      signatureBase64Url: encodeBase64Url(sig),
      nowMs: timestamp + 120_000,
    });
    assert.deepEqual(expired, { ok: false, reason: "challenge_expired" });
  });

  it("parses ALLOWED_HOST_IDS cleanly", () => {
    assert.equal(parseAllowedHostIds(undefined), null);
    assert.equal(parseAllowedHostIds("   "), null);
    const set = parseAllowedHostIds("abc234, DEF567 , ");
    assert.deepEqual([...(set ?? [])], ["abc234", "def567"]);
  });
});

describe("protocol", () => {
  it("round-trips WS and HTTP binary frames", () => {
    const id = crypto.randomUUID();
    const payload = new Uint8Array([0, 1, 2, 3, 250, 255]);

    const wsEncoded = encodeBinaryRelayFrame(id, payload);
    const wsDecoded = decodeBinaryRelayFrame(wsEncoded);
    assert.ok(wsDecoded);
    assert.equal(wsDecoded.connId, id);
    assert.deepEqual(wsDecoded.payload, payload);

    for (const kind of [
      BINARY_FRAME_WS_DATA,
      BINARY_FRAME_HTTP_REQ_BODY,
      BINARY_FRAME_HTTP_RES_BODY,
    ] as const) {
      const encoded = encodeBinaryFrame(kind, id, payload);
      const decoded = decodeBinaryFrame(encoded);
      assert.ok(decoded);
      assert.equal(decoded.kind, kind);
      assert.equal(decoded.id, id);
      assert.deepEqual(decoded.payload, payload);
    }
  });

  it("rejects malformed frames and filters hop-by-hop headers", () => {
    assert.equal(decodeBinaryFrame(new Uint8Array([0x09, 1, 2, 3])), null);
    assert.deepEqual(parseHostControlMessage(JSON.stringify({ type: "ping" })), { type: "ping" });
    assert.deepEqual(
      parseHostControlMessage(
        JSON.stringify({
          type: "http_response_start",
          reqId: "req-1",
          status: 200,
          headers: [["content-type", "application/json"]],
        }),
      ),
      {
        type: "http_response_start",
        reqId: "req-1",
        status: 200,
        headers: [["content-type", "application/json"]],
      },
    );
    assert.equal(parseHostControlMessage("not-json"), null);

    const headers = new Headers({
      Authorization: "DPoP tok",
      DPoP: "proof-jwt",
      Connection: "keep-alive",
      "CF-Ray": "abc",
    });
    const filtered = Object.fromEntries(filterRequestHeaders(headers));
    assert.equal(filtered.authorization, "DPoP tok");
    assert.equal(filtered.dpop, "proof-jwt");
    assert.equal("connection" in filtered, false);
    assert.equal("cf-ray" in filtered, false);
  });
});
