export const BINARY_FRAME_VERSION = 0x01;
export const CONN_ID_BYTE_LENGTH = 36; // Standard UUID string length
const BINARY_HEADER_LENGTH = 1 + CONN_ID_BYTE_LENGTH;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type HostControlMessage =
  | { readonly type: "auth"; readonly publicKey: string; readonly signature: string }
  | { readonly type: "frame"; readonly connId: string; readonly data: string }
  | { readonly type: "client_close"; readonly connId: string; readonly code?: number; readonly reason?: string }
  | { readonly type: "ping" };

export type RelayToHostMessage =
  | { readonly type: "challenge"; readonly nonce: string; readonly timestamp: number }
  | { readonly type: "ready"; readonly hostId: string }
  | { readonly type: "client_open"; readonly connId: string }
  | { readonly type: "client_close"; readonly connId: string; readonly code?: number; readonly reason?: string }
  | { readonly type: "frame"; readonly connId: string; readonly data: string }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "pong" };

export type RelayToClientMessage =
  | { readonly type: "connected"; readonly connId: string; readonly hostId: string }
  | { readonly type: "error"; readonly code: string; readonly message: string };

/**
 * Encodes a binary payload with a 37-byte header: [0x01][36-byte ASCII connId][payload].
 */
export function encodeBinaryRelayFrame(connId: string, payload: ArrayBuffer | Uint8Array): Uint8Array {
  const connIdBytes = textEncoder.encode(connId);
  if (connIdBytes.byteLength !== CONN_ID_BYTE_LENGTH) {
    throw new Error(`Invalid connId byte length: expected ${CONN_ID_BYTE_LENGTH}, got ${connIdBytes.byteLength}`);
  }
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const frame = new Uint8Array(BINARY_HEADER_LENGTH + payloadBytes.byteLength);
  frame[0] = BINARY_FRAME_VERSION;
  frame.set(connIdBytes, 1);
  frame.set(payloadBytes, BINARY_HEADER_LENGTH);
  return frame;
}

/**
 * Decodes a binary relay frame into `{ connId, payload }`, or `null` if malformed.
 */
export function decodeBinaryRelayFrame(
  data: ArrayBuffer | Uint8Array,
): { readonly connId: string; readonly payload: Uint8Array } | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < BINARY_HEADER_LENGTH || bytes[0] !== BINARY_FRAME_VERSION) {
    return null;
  }
  const connId = textDecoder.decode(bytes.subarray(1, BINARY_HEADER_LENGTH));
  if (!/^[0-9a-f-]{36}$/i.test(connId)) {
    return null;
  }
  return {
    connId,
    payload: bytes.subarray(BINARY_HEADER_LENGTH),
  };
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
        return { type: "auth", publicKey: msg.publicKey, signature: msg.signature };
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
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}
