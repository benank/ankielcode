import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildHostChallengeMessage,
  deriveHostId,
  encodeBase64Url,
  isValidHostId,
  parseAllowedHostIds,
  randomNonce,
  verifyHostAuth,
} from "../src/crypto.ts";
import {
  decodeBinaryRelayFrame,
  encodeBinaryRelayFrame,
  parseHostControlMessage,
} from "../src/protocol.ts";

async function makeTestHostKey() {
  const keyPair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
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
  it("round-trips binary relay frames", () => {
    const connId = crypto.randomUUID();
    const payload = new Uint8Array([0, 1, 2, 3, 250, 255]);
    const encoded = encodeBinaryRelayFrame(connId, payload);
    const decoded = decodeBinaryRelayFrame(encoded);
    assert.ok(decoded);
    assert.equal(decoded.connId, connId);
    assert.deepEqual(decoded.payload, payload);
  });

  it("rejects malformed binary frames and parses valid host control messages", () => {
    assert.equal(decodeBinaryRelayFrame(new Uint8Array([0x02, 1, 2, 3])), null);
    assert.deepEqual(parseHostControlMessage(JSON.stringify({ type: "ping" })), { type: "ping" });
    assert.equal(parseHostControlMessage("not-json"), null);
  });
});
