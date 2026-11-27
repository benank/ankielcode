import { encodeBase64Url } from "./crypto.ts";
import type { ApnsPushDelivery, PushDeliveryResult } from "./protocol.ts";

export interface ApnsCredentials {
  readonly keyP8: string;
  readonly keyId: string;
  readonly teamId: string;
}

// APNs rejects provider tokens older than 1h and throttles refreshes more often than every 20 min.
export const APNS_JWT_REFRESH_MS = 50 * 60 * 1000;
const APNS_TIMEOUT_MS = 10_000;
const UNREGISTERED_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);
const STALE_JWT_REASONS = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);

interface CachedJwt {
  readonly cacheKey: string;
  readonly jwt: Promise<string>;
  readonly issuedAtMs: number;
}

// Module scope so every RelayRoom in an isolate shares one token, and concurrent sends share one signing.
let cachedJwt: CachedJwt | null = null;

export function resetApnsJwtCache(): void {
  cachedJwt = null;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s/g, "");
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
}

function encodeJsonSegment(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function signApnsJwt(
  credentials: ApnsCredentials,
  issuedAtMs: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(credentials.keyP8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signingInput = `${encodeJsonSegment({ alg: "ES256", kid: credentials.keyId })}.${encodeJsonSegment({ iss: credentials.teamId, iat: Math.floor(issuedAtMs / 1000) })}`;
  // WebCrypto ECDSA already returns the raw r||s form that JWS ES256 expects.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export function getApnsJwt(credentials: ApnsCredentials, nowMs: number): Promise<string> {
  const cacheKey = `${credentials.teamId}:${credentials.keyId}`;
  if (
    cachedJwt &&
    cachedJwt.cacheKey === cacheKey &&
    nowMs - cachedJwt.issuedAtMs < APNS_JWT_REFRESH_MS &&
    nowMs >= cachedJwt.issuedAtMs
  ) {
    return cachedJwt.jwt;
  }
  const entry: CachedJwt = { cacheKey, jwt: signApnsJwt(credentials, nowMs), issuedAtMs: nowMs };
  entry.jwt.catch(() => {
    if (cachedJwt === entry) cachedJwt = null;
  });
  cachedJwt = entry;
  return entry.jwt;
}

async function readApnsReason(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { reason?: unknown };
    return typeof body.reason === "string" ? body.reason : undefined;
  } catch {
    return undefined;
  }
}

export async function sendApns(
  delivery: ApnsPushDelivery,
  credentials: ApnsCredentials,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<PushDeliveryResult> {
  const base = { token: delivery.token, platform: "apns" as const };
  let jwt: string;
  try {
    jwt = await getApnsJwt(credentials, nowMs);
  } catch {
    return { ...base, ok: false, reason: "apns_key_invalid" };
  }

  const host =
    delivery.environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
  const pushType = delivery.pushType ?? "alert";
  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": delivery.topic,
    "apns-push-type": pushType,
    "apns-priority": String(delivery.priority ?? (pushType === "background" ? 5 : 10)),
    "content-type": "application/json",
  };
  if (delivery.collapseId !== undefined) headers["apns-collapse-id"] = delivery.collapseId;
  if (delivery.expiration !== undefined) headers["apns-expiration"] = String(delivery.expiration);

  let response: Response;
  try {
    response = await fetchImpl(`${host}/3/device/${delivery.token}`, {
      method: "POST",
      headers,
      body: JSON.stringify(delivery.payload),
      signal: AbortSignal.timeout(APNS_TIMEOUT_MS),
    });
  } catch {
    // Fetch errors can echo the URL, which contains the device token.
    return { ...base, ok: false, reason: "network_error" };
  }

  if (response.status === 200) {
    await response.body?.cancel();
    return { ...base, ok: true, status: 200 };
  }
  const reason = await readApnsReason(response);
  if (response.status === 403 && reason !== undefined && STALE_JWT_REASONS.has(reason)) {
    resetApnsJwtCache();
  }
  const unregistered =
    response.status === 410 || (reason !== undefined && UNREGISTERED_REASONS.has(reason));
  return {
    ...base,
    ok: false,
    status: response.status,
    ...(reason !== undefined ? { reason } : {}),
    ...(unregistered ? { unregistered: true } : {}),
  };
}
