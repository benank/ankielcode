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
  | { readonly type: "ping" };

export type RelayToHostMessage =
  | {
      readonly type: "challenge";
      readonly nonce: string;
      readonly timestamp: number;
      readonly requiresSecret: boolean;
    }
  | { readonly type: "ready"; readonly hostId: string }
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
    default:
      return null;
  }
}

const STRIPPED_REQUEST_HEADERS = new Set([
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
