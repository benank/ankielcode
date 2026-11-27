export const BINARY_FRAME_WS_DATA = 0x01;
export const BINARY_FRAME_HTTP_REQ_BODY = 0x02;
export const BINARY_FRAME_HTTP_RES_BODY = 0x03;

export type BinaryFrameKind =
  | typeof BINARY_FRAME_WS_DATA
  | typeof BINARY_FRAME_HTTP_REQ_BODY
  | typeof BINARY_FRAME_HTTP_RES_BODY;

export const STREAM_ID_BYTE_LENGTH = 36; // Standard UUID string length
const BINARY_HEADER_LENGTH = 1 + STREAM_ID_BYTE_LENGTH;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type HeaderEntries = ReadonlyArray<readonly [string, string]>;

export type HostControlMessage =
  | {
      readonly type: "auth";
      readonly publicKey: string;
      readonly signature: string;
      readonly secretProof?: string;
    }
  | { readonly type: "frame"; readonly connId: string; readonly data: string }
  | {
      readonly type: "client_close";
      readonly connId: string;
      readonly code?: number;
      readonly reason?: string;
    }
  | {
      readonly type: "http_response_start";
      readonly reqId: string;
      readonly status: number;
      readonly statusText?: string;
      readonly headers: HeaderEntries;
    }
  | { readonly type: "http_response_end"; readonly reqId: string }
  | {
      readonly type: "http_response_error";
      readonly reqId: string;
      readonly status?: number;
      readonly message: string;
    }
  | { readonly type: "ping" }
  | PushMessage;

export type ApnsPushDelivery = {
  readonly platform: "apns";
  readonly token: string;
  /** Bundle id of the receiving app. */
  readonly topic: string;
  readonly environment: "sandbox" | "production";
  readonly payload: Readonly<Record<string, unknown>>;
  readonly pushType?: "alert" | "background";
  readonly priority?: 5 | 10;
  readonly collapseId?: string;
  /** Unix seconds; 0 means deliver once or drop. */
  readonly expiration?: number;
};

export type FcmPushDelivery = {
  readonly platform: "fcm";
  readonly token: string;
  readonly data: Readonly<Record<string, string>>;
  readonly priority?: "high" | "normal";
  readonly collapseKey?: string;
  readonly ttlSeconds?: number;
};

export type PushDelivery = ApnsPushDelivery | FcmPushDelivery;

export type PushMessage = {
  readonly type: "push";
  readonly pushId: string;
  readonly deliveries: ReadonlyArray<PushDelivery>;
};

export type PushDeliveryResult = {
  readonly token: string;
  readonly platform: "apns" | "fcm";
  readonly ok: boolean;
  /** Provider HTTP status, when the provider answered. */
  readonly status?: number;
  readonly reason?: string;
  /** The provider says this token is dead; the host should forget it. */
  readonly unregistered?: boolean;
};

/** Set when the whole message failed; `results` then repeats it per delivery (empty for `invalid_push`). */
export type PushResultError = "push_not_configured" | "rate_limited" | "invalid_push";

export type PushResultMessage = {
  readonly type: "push_result";
  readonly pushId: string;
  readonly results: ReadonlyArray<PushDeliveryResult>;
  readonly error?: PushResultError;
};

export type PushAvailability = { readonly apns: boolean; readonly fcm: boolean };

export type RelayToHostMessage =
  | {
      readonly type: "challenge";
      readonly nonce: string;
      readonly timestamp: number;
      readonly requiresSecret: boolean;
    }
  | { readonly type: "ready"; readonly hostId: string; readonly push?: PushAvailability }
  | PushResultMessage
  | {
      readonly type: "client_open";
      readonly connId: string;
      readonly path?: string;
      readonly headers?: HeaderEntries;
    }
  | {
      readonly type: "client_close";
      readonly connId: string;
      readonly code?: number;
      readonly reason?: string;
    }
  | { readonly type: "frame"; readonly connId: string; readonly data: string }
  | {
      readonly type: "http_request";
      readonly reqId: string;
      readonly method: string;
      readonly path: string;
      readonly headers: HeaderEntries;
      readonly hasBody: boolean;
    }
  | { readonly type: "http_request_end"; readonly reqId: string }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "pong" };

export type RelayToClientMessage =
  | { readonly type: "connected"; readonly connId: string; readonly hostId: string }
  | { readonly type: "error"; readonly code: string; readonly message: string };

/**
 * Encodes a binary payload with a 37-byte header: [kind][36-byte ASCII id][payload].
 */
export function encodeBinaryFrame(
  kind: BinaryFrameKind,
  id: string,
  payload: ArrayBuffer | Uint8Array,
): Uint8Array {
  const idBytes = textEncoder.encode(id);
  if (idBytes.byteLength !== STREAM_ID_BYTE_LENGTH) {
    throw new Error(
      `Invalid stream id byte length: expected ${STREAM_ID_BYTE_LENGTH}, got ${idBytes.byteLength}`,
    );
  }
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const frame = new Uint8Array(BINARY_HEADER_LENGTH + payloadBytes.byteLength);
  frame[0] = kind;
  frame.set(idBytes, 1);
  frame.set(payloadBytes, BINARY_HEADER_LENGTH);
  return frame;
}

export function encodeBinaryRelayFrame(
  connId: string,
  payload: ArrayBuffer | Uint8Array,
): Uint8Array {
  return encodeBinaryFrame(BINARY_FRAME_WS_DATA, connId, payload);
}

/**
 * Decodes a binary relay frame into `{ kind, id, payload }`, or `null` if malformed.
 */
export function decodeBinaryFrame(
  data: ArrayBuffer | Uint8Array,
): { readonly kind: BinaryFrameKind; readonly id: string; readonly payload: Uint8Array } | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < BINARY_HEADER_LENGTH) {
    return null;
  }
  const kind = bytes[0];
  if (
    kind !== BINARY_FRAME_WS_DATA &&
    kind !== BINARY_FRAME_HTTP_REQ_BODY &&
    kind !== BINARY_FRAME_HTTP_RES_BODY
  ) {
    return null;
  }
  const id = textDecoder.decode(bytes.subarray(1, BINARY_HEADER_LENGTH));
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return null;
  }
  return {
    kind,
    id,
    payload: bytes.subarray(BINARY_HEADER_LENGTH),
  };
}

export function decodeBinaryRelayFrame(
  data: ArrayBuffer | Uint8Array,
): { readonly connId: string; readonly payload: Uint8Array } | null {
  const decoded = decodeBinaryFrame(data);
  if (!decoded || decoded.kind !== BINARY_FRAME_WS_DATA) return null;
  return { connId: decoded.id, payload: decoded.payload };
}

function isHeaderEntries(value: unknown): value is HeaderEntries {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      typeof item[0] !== "string" ||
      typeof item[1] !== "string"
    ) {
      return false;
    }
  }
  return true;
}

export function parseHostControlMessage(raw: string): HostControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    return null;
  }
  const msg = parsed as Record<string, unknown>;
  switch (msg.type) {
    case "auth":
      if (typeof msg.publicKey === "string" && typeof msg.signature === "string") {
        return {
          type: "auth",
          publicKey: msg.publicKey,
          signature: msg.signature,
          ...(typeof msg.secretProof === "string" ? { secretProof: msg.secretProof } : {}),
        };
      }
      return null;
    case "frame":
      if (typeof msg.connId === "string" && typeof msg.data === "string") {
        return { type: "frame", connId: msg.connId, data: msg.data };
      }
      return null;
    case "client_close":
      if (typeof msg.connId === "string") {
        return {
          type: "client_close",
          connId: msg.connId,
          ...(typeof msg.code === "number" ? { code: msg.code } : {}),
          ...(typeof msg.reason === "string" ? { reason: msg.reason } : {}),
        };
      }
      return null;
    case "http_response_start":
      if (
        typeof msg.reqId === "string" &&
        typeof msg.status === "number" &&
        isHeaderEntries(msg.headers)
      ) {
        return {
          type: "http_response_start",
          reqId: msg.reqId,
          status: msg.status,
          ...(typeof msg.statusText === "string" ? { statusText: msg.statusText } : {}),
          headers: msg.headers,
        };
      }
      return null;
    case "http_response_end":
      if (typeof msg.reqId === "string") {
        return { type: "http_response_end", reqId: msg.reqId };
      }
      return null;
    case "http_response_error":
      if (typeof msg.reqId === "string" && typeof msg.message === "string") {
        return {
          type: "http_response_error",
          reqId: msg.reqId,
          ...(typeof msg.status === "number" ? { status: msg.status } : {}),
          message: msg.message,
        };
      }
      return null;
    case "ping":
      return { type: "ping" };
    case "push": {
      const parsed = parsePushMessage(msg);
      return parsed.ok ? parsed.message : null;
    }
    default:
      return null;
  }
}

export const MAX_PUSH_DELIVERIES = 32;
export const MAX_APNS_PAYLOAD_BYTES = 4096;
export const MAX_FCM_DATA_BYTES = 4096;
const MAX_FCM_TTL_SECONDS = 28 * 24 * 60 * 60;
const PUSH_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
// Tokens and topics land in the APNs URL path and headers, so charset matters as much as type.
const APNS_TOKEN_PATTERN = /^[0-9a-fA-F]{32,200}$/;
const APNS_TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_:.-]{1,1024}$/;
const COLLAPSE_PATTERN = /^[\x21-\x7e]{1,64}$/;
const FCM_RESERVED_DATA_KEYS = new Set(["from", "notification", "message_type", "collapse_key"]);

export type ParsedPushMessage =
  | { readonly ok: true; readonly message: PushMessage }
  | { readonly ok: false; readonly pushId: string | null; readonly reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function parseApnsDelivery(raw: Record<string, unknown>): ApnsPushDelivery | string {
  if (typeof raw.token !== "string" || !APNS_TOKEN_PATTERN.test(raw.token)) return "invalid_token";
  if (typeof raw.topic !== "string" || !APNS_TOPIC_PATTERN.test(raw.topic)) return "invalid_topic";
  if (raw.environment !== "sandbox" && raw.environment !== "production") {
    return "invalid_environment";
  }
  if (!isPlainObject(raw.payload)) return "invalid_payload";
  if (utf8Length(JSON.stringify(raw.payload)) > MAX_APNS_PAYLOAD_BYTES) return "payload_too_large";
  if (raw.pushType !== undefined && raw.pushType !== "alert" && raw.pushType !== "background") {
    return "invalid_push_type";
  }
  if (raw.priority !== undefined && raw.priority !== 5 && raw.priority !== 10) {
    return "invalid_priority";
  }
  if (
    raw.collapseId !== undefined &&
    (typeof raw.collapseId !== "string" || !COLLAPSE_PATTERN.test(raw.collapseId))
  ) {
    return "invalid_collapse_id";
  }
  if (
    raw.expiration !== undefined &&
    (typeof raw.expiration !== "number" ||
      !Number.isSafeInteger(raw.expiration) ||
      raw.expiration < 0)
  ) {
    return "invalid_expiration";
  }
  return {
    platform: "apns",
    token: raw.token,
    topic: raw.topic,
    environment: raw.environment,
    payload: raw.payload,
    ...(raw.pushType !== undefined ? { pushType: raw.pushType } : {}),
    ...(raw.priority !== undefined ? { priority: raw.priority } : {}),
    ...(raw.collapseId !== undefined ? { collapseId: raw.collapseId } : {}),
    ...(raw.expiration !== undefined ? { expiration: raw.expiration } : {}),
  };
}

function parseFcmDelivery(raw: Record<string, unknown>): FcmPushDelivery | string {
  if (typeof raw.token !== "string" || !FCM_TOKEN_PATTERN.test(raw.token)) return "invalid_token";
  if (!isPlainObject(raw.data)) return "invalid_data";
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.data)) {
    if (typeof value !== "string" || key.length === 0) return "invalid_data";
    if (FCM_RESERVED_DATA_KEYS.has(key) || key.startsWith("google.") || key.startsWith("gcm.")) {
      return "reserved_data_key";
    }
    data[key] = value;
  }
  if (utf8Length(JSON.stringify(data)) > MAX_FCM_DATA_BYTES) return "payload_too_large";
  if (raw.priority !== undefined && raw.priority !== "high" && raw.priority !== "normal") {
    return "invalid_priority";
  }
  if (
    raw.collapseKey !== undefined &&
    (typeof raw.collapseKey !== "string" || !COLLAPSE_PATTERN.test(raw.collapseKey))
  ) {
    return "invalid_collapse_key";
  }
  if (
    raw.ttlSeconds !== undefined &&
    (typeof raw.ttlSeconds !== "number" ||
      !Number.isSafeInteger(raw.ttlSeconds) ||
      raw.ttlSeconds < 0 ||
      raw.ttlSeconds > MAX_FCM_TTL_SECONDS)
  ) {
    return "invalid_ttl";
  }
  return {
    platform: "fcm",
    token: raw.token,
    data,
    ...(raw.priority !== undefined ? { priority: raw.priority } : {}),
    ...(raw.collapseKey !== undefined ? { collapseKey: raw.collapseKey } : {}),
    ...(raw.ttlSeconds !== undefined ? { ttlSeconds: raw.ttlSeconds } : {}),
  };
}

/**
 * Validates a host `push` message. Unknown fields are ignored so newer hosts keep working
 * against relays that have not been redeployed; known fields are checked strictly.
 */
export function parsePushMessage(msg: Record<string, unknown>): ParsedPushMessage {
  const pushId =
    typeof msg.pushId === "string" && PUSH_ID_PATTERN.test(msg.pushId) ? msg.pushId : null;
  if (pushId === null) return { ok: false, pushId: null, reason: "invalid_push_id" };
  if (!Array.isArray(msg.deliveries) || msg.deliveries.length === 0) {
    return { ok: false, pushId, reason: "invalid_deliveries" };
  }
  if (msg.deliveries.length > MAX_PUSH_DELIVERIES) {
    return { ok: false, pushId, reason: "too_many_deliveries" };
  }
  const deliveries: PushDelivery[] = [];
  for (const raw of msg.deliveries) {
    if (!isPlainObject(raw)) return { ok: false, pushId, reason: "invalid_delivery" };
    const parsed =
      raw.platform === "apns"
        ? parseApnsDelivery(raw)
        : raw.platform === "fcm"
          ? parseFcmDelivery(raw)
          : "invalid_platform";
    if (typeof parsed === "string") return { ok: false, pushId, reason: parsed };
    deliveries.push(parsed);
  }
  return { ok: true, message: { type: "push", pushId, deliveries } };
}

/** Reads `pushId` from a `push` message that failed validation, so the host still gets an answer. */
export function parseRejectedPush(
  raw: string,
): { readonly pushId: string; readonly reason: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || parsed.type !== "push") return null;
  const result = parsePushMessage(parsed);
  if (result.ok || result.pushId === null) return null;
  return { pushId: result.pushId, reason: result.reason };
}

const STRIPPED_REQUEST_HEADERS = new Set([
  // Edge injects `accept-encoding: br, gzip` and handles client compression on the response.
  "accept-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-for",
  "x-real-ip",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function filterRequestHeaders(headers: Headers): HeaderEntries {
  const entries: Array<readonly [string, string]> = [];
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!STRIPPED_REQUEST_HEADERS.has(lower) && !lower.startsWith("sec-websocket-")) {
      entries.push([lower, value]);
    }
  });
  return entries;
}

export function filterWsUpgradeHeaders(headers: Headers): HeaderEntries {
  const entries: Array<readonly [string, string]> = [];
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "origin" ||
      lower === "cookie" ||
      lower === "authorization" ||
      lower === "dpop" ||
      lower === "sec-websocket-protocol" ||
      lower === "user-agent"
    ) {
      entries.push([lower, value]);
    }
  });
  return entries;
}

export function buildResponseHeaders(entries: HeaderEntries): Headers {
  const headers = new Headers();
  for (const [key, value] of entries) {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      headers.append(key, value);
    }
  }
  return headers;
}
