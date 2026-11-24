const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const HOST_ID_LENGTH = 26;
const HOST_ID_PATTERN = /^[a-z2-7]{26}$/;
const CHALLENGE_DOMAIN = "ankiel-relay-host-v1";
const MAX_CLOCK_SKEW_MS = 60_000;

export function isValidHostId(value: string): boolean {
  return HOST_ID_PATTERN.test(value);
}

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(input: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  const padded = input.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (input.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function randomNonce(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/**
 * Self-certifying host identity: first 26 chars (130 bits) of lowercase base32(SHA-256(rawEd25519PubKey)).
 */
export async function deriveHostId(rawPublicKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", rawPublicKey);
  return encodeBase32(new Uint8Array(digest)).slice(0, HOST_ID_LENGTH);
}

export function buildHostChallengeMessage(
  hostId: string,
  nonce: string,
  timestamp: number,
): Uint8Array {
  return new TextEncoder().encode(`${CHALLENGE_DOMAIN}\n${hostId}\n${nonce}\n${timestamp}`);
}

export interface VerifyHostAuthInput {
  readonly expectedHostId: string;
  readonly expectedNonce: string;
  readonly expectedTimestamp: number;
  readonly publicKeyBase64Url: string;
  readonly signatureBase64Url: string;
  readonly nowMs?: number;
}

export type VerifyHostAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export async function verifyHostAuth(input: VerifyHostAuthInput): Promise<VerifyHostAuthResult> {
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - input.expectedTimestamp) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: "challenge_expired" };
  }

  const rawPublicKey = decodeBase64Url(input.publicKeyBase64Url);
  if (!rawPublicKey || rawPublicKey.byteLength !== 32) {
    return { ok: false, reason: "invalid_public_key" };
  }

  const signature = decodeBase64Url(input.signatureBase64Url);
  if (!signature || signature.byteLength !== 64) {
    return { ok: false, reason: "invalid_signature_length" };
  }

  const derivedHostId = await deriveHostId(rawPublicKey);
  if (derivedHostId !== input.expectedHostId) {
    return { ok: false, reason: "host_id_mismatch" };
  }

  try {
    const key = await crypto.subtle.importKey("raw", rawPublicKey, "Ed25519", false, ["verify"]);
    const message = buildHostChallengeMessage(
      input.expectedHostId,
      input.expectedNonce,
      input.expectedTimestamp,
    );
    const valid = await crypto.subtle.verify("Ed25519", key, signature, message);
    return valid ? { ok: true } : { ok: false, reason: "invalid_signature" };
  } catch {
    return { ok: false, reason: "crypto_verify_error" };
  }
}

export function parseAllowedHostIds(raw: string | undefined): ReadonlySet<string> | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (ids.length === 0) return null;
  return new Set(ids);
}
