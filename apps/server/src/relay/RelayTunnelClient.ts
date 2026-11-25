// @effect-diagnostics nodeBuiltinImport:off globalRandom:off globalTimers:off - Local HTTP/WS reverse-proxy and reconnect loop use Node timers and node:http directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as NodeWS from "@effect/platform-node/NodeWS";

const WebSocket = NodeWS.WebSocket;
type WebSocketInstance = InstanceType<typeof NodeWS.WebSocket>;
type RawData = Buffer | ArrayBuffer | Buffer[];

import {
  BINARY_FRAME_HTTP_REQ_BODY,
  BINARY_FRAME_HTTP_RES_BODY,
  BINARY_FRAME_WS_DATA,
  buildHostChallengeMessage,
  buildHostTunnelWsUrl,
  buildPublicRelayBaseUrl,
  decodeBinaryFrame,
  deriveHostId,
  encodeBase64Url,
  encodeBinaryFrame,
  publicRelayForwardedPrefix,
  publicRelayHostHeader,
  signRelaySecret,
  type HeaderEntries,
  type RelaySetupConfig,
  type RelayToHostMessage,
} from "./relayProtocol.ts";

export const RELAY_INTERNAL_TOKEN_HEADER = "x-ankiel-relay-internal";
export const RELAY_FORWARDED_PREFIX_HEADER = "x-forwarded-prefix";

interface ActiveRelayRegistration {
  readonly publicBaseUrl: string;
  readonly forwardedPrefix: string | undefined;
  readonly internalToken: string;
}

let activeRelay: ActiveRelayRegistration | null = null;

export function getActiveRelayPublicUrl(): string | null {
  return activeRelay?.publicBaseUrl ?? null;
}

/**
 * Only honor `x-forwarded-prefix` when the request carries this process's in-memory relay token
 * and matches the active relay prefix, so external callers cannot spoof DPoP `htu` URLs.
 */
export function resolveTrustedRelayForwardedPrefix(
  headers: Readonly<Record<string, string | undefined>>,
): string | null {
  if (!activeRelay?.forwardedPrefix) return null;
  const token = headers[RELAY_INTERNAL_TOKEN_HEADER];
  const prefix = headers[RELAY_FORWARDED_PREFIX_HEADER];
  if (!token || !prefix || prefix !== activeRelay.forwardedPrefix) return null;
  const actual = Buffer.from(token);
  const expected = Buffer.from(activeRelay.internalToken);
  if (actual.byteLength !== expected.byteLength) return null;
  return NodeCrypto.timingSafeEqual(actual, expected) ? prefix : null;
}

export interface RelayHostIdentity {
  readonly hostId: string;
  readonly publicKeyBase64Url: string;
  readonly privateKey: NodeCrypto.webcrypto.CryptoKey;
}

interface StoredRelayHostIdentity {
  readonly version: 1;
  readonly hostId: string;
  readonly publicKeyBase64Url: string;
  readonly privateKeyJwk: NodeCrypto.webcrypto.JsonWebKey;
}

export async function loadOrCreateRelayHostIdentity(
  identityPath: string,
): Promise<RelayHostIdentity> {
  if (NodeFS.existsSync(identityPath)) {
    const raw = JSON.parse(await NodeFSP.readFile(identityPath, "utf8")) as StoredRelayHostIdentity;
    const privateKey = await crypto.subtle.importKey("jwk", raw.privateKeyJwk, "Ed25519", true, [
      "sign",
    ]);
    return {
      hostId: raw.hostId,
      publicKeyBase64Url: raw.publicKeyBase64Url,
      privateKey,
    };
  }

  const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as NodeCrypto.webcrypto.CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const hostId = await deriveHostId(rawPub);
  const publicKeyBase64Url = encodeBase64Url(rawPub);

  const stored: StoredRelayHostIdentity = {
    version: 1,
    hostId,
    publicKeyBase64Url,
    privateKeyJwk,
  };
  await NodeFSP.mkdir(NodePath.dirname(identityPath), { recursive: true });
  await NodeFSP.writeFile(identityPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });

  return { hostId, publicKeyBase64Url, privateKey: keyPair.privateKey };
}

function rawDataToUint8Array(data: RawData): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data);
}

function pairRawHeaders(rawHeaders: ReadonlyArray<string>): HeaderEntries {
  const entries: Array<readonly [string, string]> = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const key = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (key !== undefined && value !== undefined) {
      entries.push([key, value]);
    }
  }
  return entries;
}

const HTTP_RESPONSE_CHUNK_BYTES = 64 * 1024;
const KEEPALIVE_INTERVAL_MS = 25_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export interface RelayTunnelClientOptions {
  readonly setup: RelaySetupConfig;
  readonly identity: RelayHostIdentity;
  readonly localHost: string;
  readonly localPort: number;
  readonly onReady?: (publicBaseUrl: string) => void;
  readonly onClose?: () => void;
  readonly onError?: (message: string, cause?: unknown) => void;
}

export interface RelayTunnelHandle {
  readonly hostId: string;
  readonly publicBaseUrl: string;
  readonly isConnected: () => boolean;
  readonly waitUntilReady: (timeoutMs?: number) => Promise<void>;
  readonly stop: () => Promise<void>;
}

export function startRelayTunnelClient(options: RelayTunnelClientOptions): RelayTunnelHandle {
  const { setup, identity, localHost, localPort } = options;
  const publicBaseUrl = buildPublicRelayBaseUrl(setup, identity.hostId);
  const publicHostHeader = publicRelayHostHeader(setup, identity.hostId);
  const forwardedPrefix = publicRelayForwardedPrefix(setup, identity.hostId);
  const forwardedProto = new URL(setup.relayOrigin).protocol === "https:" ? "https" : "http";
  const internalToken = NodeCrypto.randomBytes(24).toString("base64url");
  const tunnelWsUrl = buildHostTunnelWsUrl(setup, identity.hostId);

  let stopped = false;
  let socket: WebSocketInstance | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;
  let isReady = false;

  const readyWaiters: Array<() => void> = [];
  const localHttpRequests = new Map<string, NodeHttp.ClientRequest>();
  const localWebSockets = new Map<string, WebSocketInstance>();
  const pendingLocalWsMessages = new Map<string, Array<string | Uint8Array>>();

  const sendJson = (payload: unknown) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  const sendBinary = (payload: Uint8Array) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  };

  const cleanupLocalStreams = () => {
    for (const req of localHttpRequests.values()) {
      req.destroy();
    }
    localHttpRequests.clear();
    for (const ws of localWebSockets.values()) {
      try {
        ws.close(1001, "relay_disconnected");
      } catch {
        ws.terminate();
      }
    }
    localWebSockets.clear();
    pendingLocalWsMessages.clear();
  };

  const handleHttpRequest = (
    msg: Extract<RelayToHostMessage, { readonly type: "http_request" }>,
  ) => {
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of msg.headers) {
      const lower = key.toLowerCase();
      if (lower === "accept-encoding") continue;
      const existing = headers[lower];
      if (existing === undefined) {
        headers[lower] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        headers[lower] = [existing, value];
      }
    }
    headers.host = publicHostHeader;
    headers["x-forwarded-proto"] = forwardedProto;
    if (forwardedPrefix) {
      headers[RELAY_FORWARDED_PREFIX_HEADER] = forwardedPrefix;
      headers[RELAY_INTERNAL_TOKEN_HEADER] = internalToken;
    }

    const req = NodeHttp.request(
      {
        hostname: localHost,
        port: localPort,
        method: msg.method,
        path: msg.path,
        headers,
      },
      (res) => {
        sendJson({
          type: "http_response_start",
          reqId: msg.reqId,
          status: res.statusCode ?? 502,
          ...(res.statusMessage ? { statusText: res.statusMessage } : {}),
          headers: pairRawHeaders(res.rawHeaders),
        });

        res.on("data", (chunk: Buffer) => {
          for (let offset = 0; offset < chunk.byteLength; offset += HTTP_RESPONSE_CHUNK_BYTES) {
            const slice = chunk.subarray(
              offset,
              Math.min(offset + HTTP_RESPONSE_CHUNK_BYTES, chunk.byteLength),
            );
            sendBinary(encodeBinaryFrame(BINARY_FRAME_HTTP_RES_BODY, msg.reqId, slice));
          }
        });
        res.on("end", () => {
          localHttpRequests.delete(msg.reqId);
          sendJson({ type: "http_response_end", reqId: msg.reqId });
        });
        res.on("error", (err) => {
          localHttpRequests.delete(msg.reqId);
          sendJson({
            type: "http_response_error",
            reqId: msg.reqId,
            status: 502,
            message: err.message,
          });
        });
      },
    );

    req.on("error", (err) => {
      localHttpRequests.delete(msg.reqId);
      sendJson({
        type: "http_response_error",
        reqId: msg.reqId,
        status: 502,
        message: err.message,
      });
    });

    localHttpRequests.set(msg.reqId, req);
    if (!msg.hasBody) {
      req.end();
    }
  };

  const handleClientWsOpen = (
    msg: Extract<RelayToHostMessage, { readonly type: "client_open" }>,
  ) => {
    const targetPath = msg.path || "/ws";
    const localUrl = `ws://${localHost.includes(":") ? `[${localHost}]` : localHost}:${localPort}${targetPath}`;
    const headers: Record<string, string> = {
      host: publicHostHeader,
      "x-forwarded-proto": forwardedProto,
    };
    if (forwardedPrefix) {
      headers[RELAY_FORWARDED_PREFIX_HEADER] = forwardedPrefix;
      headers[RELAY_INTERNAL_TOKEN_HEADER] = internalToken;
    }
    let protocols: string[] | undefined;
    for (const [key, value] of msg.headers ?? []) {
      const lower = key.toLowerCase();
      if (lower === "sec-websocket-protocol") {
        protocols = value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
      } else {
        headers[lower] = value;
      }
    }

    const localWs = new WebSocket(localUrl, protocols, { headers });
    localWebSockets.set(msg.connId, localWs);
    pendingLocalWsMessages.set(msg.connId, []);

    localWs.on("open", () => {
      const queued = pendingLocalWsMessages.get(msg.connId) ?? [];
      pendingLocalWsMessages.delete(msg.connId);
      for (const item of queued) {
        localWs.send(item);
      }
    });

    localWs.on("message", (data, isBinary) => {
      if (isBinary) {
        sendBinary(encodeBinaryFrame(BINARY_FRAME_WS_DATA, msg.connId, rawDataToUint8Array(data)));
      } else {
        sendJson({ type: "frame", connId: msg.connId, data: rawDataToUint8Array(data).toString() });
      }
    });

    localWs.on("close", (code, reason) => {
      localWebSockets.delete(msg.connId);
      pendingLocalWsMessages.delete(msg.connId);
      sendJson({
        type: "client_close",
        connId: msg.connId,
        code,
        reason: reason.toString("utf8"),
      });
    });

    localWs.on("error", () => {
      localWebSockets.delete(msg.connId);
      pendingLocalWsMessages.delete(msg.connId);
      sendJson({
        type: "client_close",
        connId: msg.connId,
        code: 1011,
        reason: "local_ws_error",
      });
    });
  };

  const forwardToLocalWs = (connId: string, payload: string | Uint8Array) => {
    const localWs = localWebSockets.get(connId);
    if (!localWs) return;
    if (localWs.readyState === WebSocket.CONNECTING) {
      pendingLocalWsMessages.get(connId)?.push(payload);
    } else if (localWs.readyState === WebSocket.OPEN) {
      localWs.send(payload);
    }
  };

  const handleRelayMessage = async (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      const decoded = decodeBinaryFrame(rawDataToUint8Array(data));
      if (!decoded) return;
      if (decoded.kind === BINARY_FRAME_HTTP_REQ_BODY) {
        localHttpRequests.get(decoded.id)?.write(decoded.payload);
      } else if (decoded.kind === BINARY_FRAME_WS_DATA) {
        forwardToLocalWs(decoded.id, decoded.payload);
      }
      return;
    }

    let msg: RelayToHostMessage;
    try {
      msg = JSON.parse(
        Buffer.from(rawDataToUint8Array(data)).toString("utf8"),
      ) as RelayToHostMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "challenge": {
        const challengeBytes = buildHostChallengeMessage(identity.hostId, msg.nonce, msg.timestamp);
        const signature = new Uint8Array(
          await crypto.subtle.sign("Ed25519", identity.privateKey, challengeBytes),
        );
        const secretProof = setup.secret
          ? await signRelaySecret(setup.secret, identity.hostId, msg.nonce, msg.timestamp)
          : undefined;
        sendJson({
          type: "auth",
          publicKey: identity.publicKeyBase64Url,
          signature: encodeBase64Url(signature),
          ...(secretProof ? { secretProof } : {}),
        });
        return;
      }
      case "ready": {
        reconnectAttempt = 0;
        isReady = true;
        activeRelay = { publicBaseUrl, forwardedPrefix, internalToken };
        for (const resolve of readyWaiters.splice(0)) {
          resolve();
        }
        options.onReady?.(publicBaseUrl);
        return;
      }
      case "http_request":
        handleHttpRequest(msg);
        return;
      case "http_request_end": {
        const req = localHttpRequests.get(msg.reqId);
        if (req) {
          req.end();
        }
        return;
      }
      case "client_open":
        handleClientWsOpen(msg);
        return;
      case "frame":
        forwardToLocalWs(msg.connId, msg.data);
        return;
      case "client_close": {
        const localWs = localWebSockets.get(msg.connId);
        if (localWs) {
          localWebSockets.delete(msg.connId);
          pendingLocalWsMessages.delete(msg.connId);
          try {
            localWs.close(msg.code ?? 1000, msg.reason ?? "");
          } catch {
            localWs.terminate();
          }
        }
        return;
      }
      case "error":
        options.onError?.(`Relay error (${msg.code}): ${msg.message}`);
        return;
      case "pong":
        return;
    }
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const baseDelay = Math.min(INITIAL_RECONNECT_MS * 2 ** reconnectAttempt, MAX_RECONNECT_MS);
    reconnectAttempt++;
    const jitter = Math.floor(Math.random() * 500);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, baseDelay + jitter);
  };

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(tunnelWsUrl);
    socket = ws;

    ws.on("open", () => {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (isReady) sendJson({ type: "ping" });
      }, KEEPALIVE_INTERVAL_MS);
    });

    ws.on("message", (data, isBinary) => {
      void handleRelayMessage(data, isBinary).catch((err) => {
        options.onError?.("Failed to process relay frame", err);
      });
    });

    ws.on("close", () => {
      if (socket === ws) socket = null;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      const wasReady = isReady;
      isReady = false;
      if (activeRelay?.internalToken === internalToken) {
        activeRelay = null;
      }
      if (wasReady) {
        options.onClose?.();
      }
      cleanupLocalStreams();
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      options.onError?.("Relay WebSocket error", err);
    });
  };

  connect();

  return {
    hostId: identity.hostId,
    publicBaseUrl,
    isConnected: () => isReady,
    waitUntilReady: (timeoutMs = 10_000) => {
      if (isReady) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for relay tunnel (${tunnelWsUrl})`));
        }, timeoutMs);
        readyWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    stop: async () => {
      stopped = true;
      isReady = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (activeRelay?.internalToken === internalToken) {
        activeRelay = null;
      }
      cleanupLocalStreams();
      if (socket) {
        const closing = socket;
        socket = null;
        await new Promise<void>((resolve) => {
          closing.once("close", () => resolve());
          try {
            closing.close(1000, "server_shutdown");
          } catch {
            resolve();
          }
          setTimeout(resolve, 1_000);
        });
      }
    },
  };
}
