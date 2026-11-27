import { encodeBase64Url } from "./crypto.ts";
import type { FcmPushDelivery, PushDeliveryResult } from "./protocol.ts";

export interface FcmServiceAccount {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
}

const FCM_TIMEOUT_MS = 10_000;
const OAUTH_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const FCM_ERROR_TYPE = "type.googleapis.com/google.firebase.fcm.v1.FcmError";
const BAD_REQUEST_TYPE = "type.googleapis.com/google.rpc.BadRequest";

export function parseFcmServiceAccount(raw: string | undefined): FcmServiceAccount | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const projectId = parsed.project_id;
    const clientEmail = parsed.client_email;
    const privateKey = parsed.private_key;
    if (
      typeof projectId !== "string" ||
      typeof clientEmail !== "string" ||
      typeof privateKey !== "string" ||
      !projectId ||
      !clientEmail ||
      !privateKey
    ) {
      return null;
    }
    return { projectId, clientEmail, privateKey };
  } catch {
    return null;
  }
}

interface CachedAccessToken {
  readonly clientEmail: string;
  token: Promise<string>;
  expiresAtMs: number;
}

// Module scope so every RelayRoom in an isolate shares one OAuth token; concurrent sends share the in-flight fetch.
let cachedAccessToken: CachedAccessToken | null = null;

export function resetFcmAccessTokenCache(): void {
  cachedAccessToken = null;
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

export async function signFcmAssertion(
  account: FcmServiceAccount,
  issuedAtSeconds: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(account.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signingInput = `${encodeJsonSegment({ alg: "RS256", typ: "JWT" })}.${encodeJsonSegment({
    iss: account.clientEmail,
    scope: OAUTH_SCOPE,
    aud: OAUTH_TOKEN_URL,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + 3600,
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function fetchAccessToken(
  account: FcmServiceAccount,
  fetchImpl: typeof fetch,
  nowMs: number,
  entry: CachedAccessToken,
): Promise<string> {
  const assertion = await signFcmAssertion(account, Math.floor(nowMs / 1000));
  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`oauth_${response.status}`);
  const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("oauth_invalid_response");
  }
  const expiresInMs = typeof body.expires_in === "number" ? body.expires_in * 1000 : 3600_000;
  entry.expiresAtMs = nowMs + expiresInMs - OAUTH_REFRESH_MARGIN_MS;
  return body.access_token;
}

export function getFcmAccessToken(
  account: FcmServiceAccount,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<string> {
  if (
    cachedAccessToken &&
    cachedAccessToken.clientEmail === account.clientEmail &&
    nowMs < cachedAccessToken.expiresAtMs
  ) {
    return cachedAccessToken.token;
  }
  const entry: CachedAccessToken = {
    clientEmail: account.clientEmail,
    token: Promise.resolve(""),
    // Treated as fresh while the first fetch is in flight.
    expiresAtMs: Number.POSITIVE_INFINITY,
  };
  entry.token = fetchAccessToken(account, fetchImpl, nowMs, entry);
  entry.token.catch(() => {
    if (cachedAccessToken === entry) cachedAccessToken = null;
  });
  cachedAccessToken = entry;
  return entry.token;
}

interface FcmErrorBody {
  readonly error?: {
    readonly status?: unknown;
    readonly message?: unknown;
    readonly details?: ReadonlyArray<{
      readonly "@type"?: unknown;
      readonly errorCode?: unknown;
      readonly fieldViolations?: ReadonlyArray<{ readonly field?: unknown }>;
    }>;
  };
}

async function readFcmError(
  response: Response,
): Promise<{ readonly reason: string | undefined; readonly unregistered: boolean }> {
  let body: FcmErrorBody;
  try {
    body = (await response.json()) as FcmErrorBody;
  } catch {
    return { reason: undefined, unregistered: response.status === 404 };
  }
  const details = Array.isArray(body.error?.details) ? body.error.details : [];
  const fcmCode = details.find((detail) => detail["@type"] === FCM_ERROR_TYPE)?.errorCode;
  const status = body.error?.status;
  const reason =
    typeof fcmCode === "string" ? fcmCode : typeof status === "string" ? status : undefined;
  if (response.status === 404 || reason === "UNREGISTERED") {
    return { reason, unregistered: true };
  }
  if (reason !== "INVALID_ARGUMENT") return { reason, unregistered: false };
  // INVALID_ARGUMENT also covers bad payloads, so only treat it as a dead token when FCM blames the token.
  const blamesTokenField = details.some(
    (detail) =>
      detail["@type"] === BAD_REQUEST_TYPE &&
      Array.isArray(detail.fieldViolations) &&
      detail.fieldViolations.some(
        (violation: { readonly field?: unknown }) => violation?.field === "message.token",
      ),
  );
  const message = body.error?.message;
  const blamesTokenMessage = typeof message === "string" && /registration token/i.test(message);
  return { reason, unregistered: blamesTokenField || blamesTokenMessage };
}

export async function sendFcm(
  delivery: FcmPushDelivery,
  account: FcmServiceAccount,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<PushDeliveryResult> {
  const base = { token: delivery.token, platform: "fcm" as const };
  let accessToken: string;
  try {
    accessToken = await getFcmAccessToken(account, fetchImpl, nowMs);
  } catch {
    return { ...base, ok: false, reason: "fcm_auth_failed" };
  }

  const android: Record<string, string> = {
    priority: delivery.priority === "normal" ? "NORMAL" : "HIGH",
  };
  if (delivery.ttlSeconds !== undefined) android.ttl = `${delivery.ttlSeconds}s`;
  if (delivery.collapseKey !== undefined) android.collapse_key = delivery.collapseKey;

  let response: Response;
  try {
    response = await fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: { token: delivery.token, data: delivery.data, android } }),
        signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
      },
    );
  } catch {
    return { ...base, ok: false, reason: "network_error" };
  }

  if (response.ok) {
    await response.body?.cancel();
    return { ...base, ok: true, status: response.status };
  }
  if (response.status === 401) resetFcmAccessTokenCache();
  const { reason, unregistered } = await readFcmError(response);
  return {
    ...base,
    ok: false,
    status: response.status,
    ...(reason !== undefined ? { reason } : {}),
    ...(unregistered ? { unregistered: true } : {}),
  };
}
