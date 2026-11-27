import { DurableObject } from "cloudflare:workers";

import { randomNonce, verifyHostAuth } from "./crypto.ts";
import {
  deliverPush,
  pushAvailability,
  PushRateLimiter,
  summarizePushResult,
  type PushEnv,
} from "./push.ts";
import {
  BINARY_FRAME_HTTP_REQ_BODY,
  BINARY_FRAME_HTTP_RES_BODY,
  BINARY_FRAME_WS_DATA,
  buildResponseHeaders,
  decodeBinaryFrame,
  encodeBinaryFrame,
  filterRequestHeaders,
  filterWsUpgradeHeaders,
  parseHostControlMessage,
  parseRejectedPush,
  type HeaderEntries,
  type PushMessage,
  type RelayToClientMessage,
  type RelayToHostMessage,
} from "./protocol.ts";

export interface RelayEnv extends PushEnv {
  readonly RELAY_ROOM: DurableObjectNamespace;
  readonly RELAY_SECRET?: string;
  readonly ALLOWED_HOST_IDS?: string;
  readonly ALLOW_PUBLIC_RELAY?: string;
  readonly MAX_CLIENTS_PER_HOST?: string;
}

type SocketAttachment =
  | {
      readonly role: "host-pending";
      readonly hostId: string;
      readonly nonce: string;
      readonly timestamp: number;
    }
  | {
      readonly role: "host";
      readonly hostId: string;
      readonly authenticatedAt: number;
    }
  | {
      readonly role: "client";
      readonly hostId: string;
      readonly connId: string;
      readonly rawTunnel: boolean;
    };

interface PendingHttpRequest {
  readonly reqId: string;
  readonly resolveResponse: (response: Response) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  resolved: boolean;
  bodyController: ReadableStreamDefaultController<Uint8Array> | null;
}

const AUTH_TIMEOUT_MS = 15_000;
const HTTP_RESPONSE_START_TIMEOUT_MS = 30_000;
const HTTP_CHUNK_BYTES = 64 * 1024;
const MAX_HTTP_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
const MAX_PENDING_HTTP_REQUESTS = 64;
const MAX_PENDING_HOST_SOCKETS = 4;
const FAILED_AUTH_WINDOW_MS = 60_000;
const MAX_FAILED_AUTH_ATTEMPTS = 10;
const DEFAULT_MAX_CLIENTS = 32;

const CLOSE_AUTH_FAILED = 4401;
const CLOSE_AUTH_TIMEOUT = 4408;
const CLOSE_REPLACED = 4409;
const CLOSE_HOST_DISCONNECTED = 4503;

function sendHostJson(ws: WebSocket, msg: RelayToHostMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Ignore sends to already-closing sockets.
  }
}

function sendClientJson(ws: WebSocket, msg: RelayToClientMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Ignore sends to already-closing sockets.
  }
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Ignore close errors on already-closed sockets.
  }
}

function sanitizeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  return 1000;
}

export class RelayRoom extends DurableObject<RelayEnv> {
  // In-flight HTTP requests keep the DO awake until resolved/closed, so in-memory tracking is safe.
  private readonly pendingHttp = new Map<string, PendingHttpRequest>();
  private failedAuthTimestamps: number[] = [];
  private pushRateLimiter: PushRateLimiter | null = null;

  private pruneFailedAuth(now: number): void {
    const cutoff = now - FAILED_AUTH_WINDOW_MS;
    this.failedAuthTimestamps = this.failedAuthTimestamps.filter((ts) => ts > cutoff);
  }

  private isHostAuthRateLimited(now: number): boolean {
    this.pruneFailedAuth(now);
    return this.failedAuthTimestamps.length >= MAX_FAILED_AUTH_ATTEMPTS;
  }

  private recordFailedAuth(now: number): void {
    this.pruneFailedAuth(now);
    this.failedAuthTimestamps.push(now);
  }

  private getAttachment(ws: WebSocket): SocketAttachment | null {
    return (ws.deserializeAttachment() as SocketAttachment | null) ?? null;
  }

  private getAuthenticatedHost(): WebSocket | null {
    for (const ws of this.ctx.getWebSockets("host")) {
      const attachment = this.getAttachment(ws);
      if (attachment?.role === "host") {
        return ws;
      }
    }
    return null;
  }

  private getClientSocket(connId: string): WebSocket | null {
    const sockets = this.ctx.getWebSockets(`client:${connId}`);
    return sockets[0] ?? null;
  }

  private maxClients(): number {
    const parsed = Number.parseInt(this.env.MAX_CLIENTS_PER_HOST ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CLIENTS;
  }

  private requiresRelaySecret(): boolean {
    return Boolean(this.env.RELAY_SECRET?.trim());
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const hostId = url.searchParams.get("hostId") ?? "";

    if (url.pathname === "/status") {
      const host = this.getAuthenticatedHost();
      return Response.json({
        hostId,
        online: host !== null,
      });
    }

    if (url.pathname === "/host") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "upgrade_required" }, { status: 426 });
      }
      return this.handleHostUpgrade(hostId);
    }

    if (url.pathname === "/client") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "upgrade_required" }, { status: 426 });
      }
      return this.handleClientUpgrade(hostId, request, {
        path: url.searchParams.get("path") ?? "/ws",
        sendConnectedControlFrame: true,
      });
    }

    if (url.pathname === "/tunnel") {
      const targetPath = url.searchParams.get("path") ?? "/";
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        return this.handleClientUpgrade(hostId, request, {
          path: targetPath,
          sendConnectedControlFrame: false,
        });
      }
      return this.handleHttpTunnel(hostId, targetPath, request);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async handleHostUpgrade(hostId: string): Promise<Response> {
    const now = Date.now();
    if (this.isHostAuthRateLimited(now)) {
      return Response.json({ error: "rate_limited" }, { status: 429 });
    }

    const pendingCount = this.ctx
      .getWebSockets("host")
      .filter((ws) => this.getAttachment(ws)?.role === "host-pending").length;
    if (pendingCount >= MAX_PENDING_HOST_SOCKETS) {
      return Response.json({ error: "too_many_pending_auth" }, { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    const nonce = randomNonce(32);
    const timestamp = now;
    this.ctx.acceptWebSocket(server, ["host"]);
    server.serializeAttachment({
      role: "host-pending",
      hostId,
      nonce,
      timestamp,
    } satisfies SocketAttachment);

    await this.ctx.storage.setAlarm(timestamp + AUTH_TIMEOUT_MS);
    sendHostJson(server, {
      type: "challenge",
      nonce,
      timestamp,
      requiresSecret: this.requiresRelaySecret(),
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleClientUpgrade(
    hostId: string,
    request: Request,
    options: {
      readonly path: string;
      readonly sendConnectedControlFrame: boolean;
    },
  ): Response {
    const host = this.getAuthenticatedHost();
    if (!host) {
      return Response.json({ error: "host_offline", hostId }, { status: 503 });
    }

    const activeClients = this.ctx.getWebSockets("client");
    if (activeClients.length >= this.maxClients()) {
      return Response.json({ error: "too_many_clients", hostId }, { status: 429 });
    }

    const connId = crypto.randomUUID();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.ctx.acceptWebSocket(server, ["client", `client:${connId}`]);
    server.serializeAttachment({
      role: "client",
      hostId,
      connId,
      rawTunnel: !options.sendConnectedControlFrame,
    } satisfies SocketAttachment);

    sendHostJson(host, {
      type: "client_open",
      connId,
      path: options.path,
      headers: filterWsUpgradeHeaders(request.headers),
    });

    if (options.sendConnectedControlFrame) {
      sendClientJson(server, { type: "connected", connId, hostId });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleHttpTunnel(
    hostId: string,
    targetPath: string,
    request: Request,
  ): Promise<Response> {
    const host = this.getAuthenticatedHost();
    if (!host) {
      return Response.json({ error: "host_offline", hostId }, { status: 503 });
    }

    if (this.pendingHttp.size >= MAX_PENDING_HTTP_REQUESTS) {
      return Response.json({ error: "too_many_requests", hostId }, { status: 429 });
    }

    const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTP_REQUEST_BODY_BYTES) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }

    const reqId = crypto.randomUUID();
    const method = request.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;

    const responsePromise = new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pendingHttp.get(reqId);
        if (!entry) return;
        this.pendingHttp.delete(reqId);
        if (!entry.resolved) {
          entry.resolved = true;
          resolve(Response.json({ error: "host_timeout", reqId }, { status: 504 }));
        } else if (entry.bodyController) {
          try {
            entry.bodyController.error(new Error("Host response stream timed out"));
          } catch {
            // Stream already closed.
          }
        }
      }, HTTP_RESPONSE_START_TIMEOUT_MS);

      this.pendingHttp.set(reqId, {
        reqId,
        resolveResponse: resolve,
        timer,
        resolved: false,
        bodyController: null,
      });
    });

    try {
      sendHostJson(host, {
        type: "http_request",
        reqId,
        method,
        path: targetPath,
        headers: filterRequestHeaders(request.headers),
        hasBody,
      });

      if (hasBody && request.body) {
        const reader = request.body.getReader();
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_HTTP_REQUEST_BODY_BYTES) {
            await reader.cancel();
            this.failPendingHttp(reqId, 413, "Request body exceeded limit.");
            return responsePromise;
          }
          for (let offset = 0; offset < value.byteLength; offset += HTTP_CHUNK_BYTES) {
            const slice = value.subarray(
              offset,
              Math.min(offset + HTTP_CHUNK_BYTES, value.byteLength),
            );
            host.send(encodeBinaryFrame(BINARY_FRAME_HTTP_REQ_BODY, reqId, slice));
          }
        }
        sendHostJson(host, { type: "http_request_end", reqId });
      }
    } catch {
      this.failPendingHttp(reqId, 502, "Failed to forward request to host.");
    }

    return responsePromise;
  }

  private startPendingHttpResponse(
    reqId: string,
    status: number,
    statusText: string | undefined,
    headers: HeaderEntries,
  ): void {
    const entry = this.pendingHttp.get(reqId);
    if (!entry || entry.resolved) return;

    clearTimeout(entry.timer);
    entry.resolved = true;

    const responseHeaders = buildResponseHeaders(headers);
    const noBodyStatus = status === 101 || status === 204 || status === 205 || status === 304;
    if (noBodyStatus) {
      this.pendingHttp.delete(reqId);
      entry.resolveResponse(
        new Response(null, {
          status,
          ...(statusText ? { statusText } : {}),
          headers: responseHeaders,
        }),
      );
      return;
    }

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        entry.bodyController = controller;
      },
      cancel: () => {
        this.pendingHttp.delete(reqId);
      },
    });

    entry.resolveResponse(
      new Response(stream, {
        status,
        ...(statusText ? { statusText } : {}),
        headers: responseHeaders,
        ...(responseHeaders.has("content-encoding") ? { encodeBody: "manual" as const } : {}),
      }),
    );
  }

  private pushPendingHttpChunk(reqId: string, chunk: Uint8Array): void {
    const entry = this.pendingHttp.get(reqId);
    if (!entry?.bodyController) return;
    try {
      entry.bodyController.enqueue(chunk.slice());
    } catch {
      this.pendingHttp.delete(reqId);
    }
  }

  private finishPendingHttp(reqId: string): void {
    const entry = this.pendingHttp.get(reqId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingHttp.delete(reqId);
    if (!entry.resolved) {
      entry.resolved = true;
      entry.resolveResponse(new Response(null, { status: 502 }));
      return;
    }
    if (entry.bodyController) {
      try {
        entry.bodyController.close();
      } catch {
        // Already closed.
      }
    }
  }

  private failPendingHttp(reqId: string, status: number, message: string): void {
    const entry = this.pendingHttp.get(reqId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingHttp.delete(reqId);
    if (!entry.resolved) {
      entry.resolved = true;
      entry.resolveResponse(Response.json({ error: "bad_gateway", message }, { status }));
      return;
    }
    if (entry.bodyController) {
      try {
        entry.bodyController.error(new Error(message));
      } catch {
        // Already errored/closed.
      }
    }
  }

  private failAllPendingHttp(message: string): void {
    for (const reqId of this.pendingHttp.keys()) {
      this.failPendingHttp(reqId, 502, message);
    }
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    let nextAlarm: number | null = null;

    for (const ws of this.ctx.getWebSockets("host")) {
      const attachment = this.getAttachment(ws);
      if (attachment?.role !== "host-pending") continue;
      const deadline = attachment.timestamp + AUTH_TIMEOUT_MS;
      if (deadline <= now) {
        sendHostJson(ws, {
          type: "error",
          code: "auth_timeout",
          message: "Host authentication timed out.",
        });
        safeClose(ws, CLOSE_AUTH_TIMEOUT, "auth_timeout");
      } else if (nextAlarm === null || deadline < nextAlarm) {
        nextAlarm = deadline;
      }
    }

    if (nextAlarm !== null) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = this.getAttachment(ws);
    if (!attachment) {
      safeClose(ws, 1011, "missing_attachment");
      return;
    }

    if (attachment.role === "host-pending") {
      await this.handlePendingHostMessage(ws, attachment, message);
      return;
    }

    if (attachment.role === "host") {
      await this.handleAuthenticatedHostMessage(ws, message);
      return;
    }

    this.handleClientMessage(attachment.connId, message);
  }

  private async handlePendingHostMessage(
    ws: WebSocket,
    attachment: Extract<SocketAttachment, { readonly role: "host-pending" }>,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      sendHostJson(ws, {
        type: "error",
        code: "invalid_auth_message",
        message: "Expected JSON auth message.",
      });
      safeClose(ws, CLOSE_AUTH_FAILED, "invalid_auth_message");
      return;
    }

    const parsed = parseHostControlMessage(message);
    if (parsed?.type !== "auth") {
      sendHostJson(ws, {
        type: "error",
        code: "auth_required",
        message: "Authenticate before sending relay traffic.",
      });
      safeClose(ws, CLOSE_AUTH_FAILED, "auth_required");
      return;
    }

    const verification = await verifyHostAuth({
      expectedHostId: attachment.hostId,
      expectedNonce: attachment.nonce,
      expectedTimestamp: attachment.timestamp,
      publicKeyBase64Url: parsed.publicKey,
      signatureBase64Url: parsed.signature,
      relaySecret: this.env.RELAY_SECRET,
      secretProofBase64Url: parsed.secretProof,
    });

    if (!verification.ok) {
      this.recordFailedAuth(Date.now());
      sendHostJson(ws, {
        type: "error",
        code: verification.reason,
        message: `Host authentication failed: ${verification.reason}`,
      });
      safeClose(ws, CLOSE_AUTH_FAILED, verification.reason);
      return;
    }

    // Replace any previously authenticated host socket cleanly.
    for (const existing of this.ctx.getWebSockets("host")) {
      if (existing === ws) continue;
      const existingAttachment = this.getAttachment(existing);
      if (existingAttachment?.role === "host") {
        safeClose(existing, CLOSE_REPLACED, "replaced_by_new_host");
      }
    }

    ws.serializeAttachment({
      role: "host",
      hostId: attachment.hostId,
      authenticatedAt: Date.now(),
    } satisfies SocketAttachment);

    this.sendReady(ws, attachment.hostId);
  }

  private sendReady(ws: WebSocket, hostId: string): void {
    sendHostJson(ws, { type: "ready", hostId, push: pushAvailability(this.env) });
  }

  private async handlePush(ws: WebSocket, message: PushMessage): Promise<void> {
    this.pushRateLimiter ??= new PushRateLimiter(Date.now());
    const result = await deliverPush(message, {
      env: this.env,
      rateLimiter: this.pushRateLimiter,
      fetch: (input, init) => fetch(input, init),
      now: Date.now,
    });
    console.log(summarizePushResult(result));
    sendHostJson(ws, result);
  }

  private async handleAuthenticatedHostMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      const decoded = decodeBinaryFrame(message);
      if (!decoded) {
        sendHostJson(ws, {
          type: "error",
          code: "malformed_binary_frame",
          message: "Binary frame header is invalid.",
        });
        return;
      }
      if (decoded.kind === BINARY_FRAME_HTTP_RES_BODY) {
        this.pushPendingHttpChunk(decoded.id, decoded.payload);
        return;
      }
      if (decoded.kind === BINARY_FRAME_WS_DATA) {
        const client = this.getClientSocket(decoded.id);
        if (!client) {
          sendHostJson(ws, { type: "client_close", connId: decoded.id, reason: "not_found" });
          return;
        }
        try {
          client.send(decoded.payload);
        } catch {
          safeClose(client, 1011, "send_failed");
        }
      }
      return;
    }

    const parsed = parseHostControlMessage(message);
    if (!parsed) {
      const rejectedPush = parseRejectedPush(message);
      if (rejectedPush) {
        console.log({ event: "push_rejected", reason: rejectedPush.reason });
        sendHostJson(ws, {
          type: "push_result",
          pushId: rejectedPush.pushId,
          results: [],
          error: "invalid_push",
        });
        return;
      }
      sendHostJson(ws, {
        type: "error",
        code: "invalid_message",
        message: "Unrecognized host control message.",
      });
      return;
    }

    switch (parsed.type) {
      case "ping":
        sendHostJson(ws, { type: "pong" });
        return;
      case "frame": {
        const client = this.getClientSocket(parsed.connId);
        if (!client) {
          sendHostJson(ws, { type: "client_close", connId: parsed.connId, reason: "not_found" });
          return;
        }
        try {
          client.send(parsed.data);
        } catch {
          safeClose(client, 1011, "send_failed");
        }
        return;
      }
      case "client_close": {
        const client = this.getClientSocket(parsed.connId);
        if (client) {
          safeClose(client, sanitizeCloseCode(parsed.code), parsed.reason ?? "closed_by_host");
        }
        return;
      }
      case "http_response_start":
        this.startPendingHttpResponse(
          parsed.reqId,
          parsed.status,
          parsed.statusText,
          parsed.headers,
        );
        return;
      case "http_response_end":
        this.finishPendingHttp(parsed.reqId);
        return;
      case "http_response_error":
        this.failPendingHttp(parsed.reqId, parsed.status ?? 502, parsed.message);
        return;
      case "auth":
        this.sendReady(ws, this.getAttachment(ws)?.hostId ?? "");
        return;
      case "push":
        await this.handlePush(ws, parsed);
        return;
    }
  }

  private handleClientMessage(connId: string, message: string | ArrayBuffer): void {
    const host = this.getAuthenticatedHost();
    if (!host) {
      const client = this.getClientSocket(connId);
      if (client) {
        safeClose(client, CLOSE_HOST_DISCONNECTED, "host_disconnected");
      }
      return;
    }

    if (typeof message === "string") {
      sendHostJson(host, { type: "frame", connId, data: message });
      return;
    }

    try {
      host.send(encodeBinaryFrame(BINARY_FRAME_WS_DATA, connId, message));
    } catch {
      safeClose(host, 1011, "host_send_failed");
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.handleDisconnect(ws, code, reason);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.handleDisconnect(ws, 1011, "socket_error");
  }

  private handleDisconnect(ws: WebSocket, code: number, reason: string): void {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    if (attachment.role === "client") {
      const host = this.getAuthenticatedHost();
      if (host) {
        sendHostJson(host, {
          type: "client_close",
          connId: attachment.connId,
          code,
          reason,
        });
      }
      return;
    }

    if (attachment.role === "host") {
      const replacement = this.ctx.getWebSockets("host").find((other) => {
        if (other === ws) return false;
        return this.getAttachment(other)?.role === "host";
      });
      if (!replacement) {
        this.failAllPendingHttp("Host disconnected during request.");
        for (const client of this.ctx.getWebSockets("client")) {
          safeClose(client, CLOSE_HOST_DISCONNECTED, "host_disconnected");
        }
      }
    }
  }
}
