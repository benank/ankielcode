import { DurableObject } from "cloudflare:workers";

import { randomNonce, verifyHostAuth } from "./crypto.ts";
import {
  decodeBinaryRelayFrame,
  encodeBinaryRelayFrame,
  parseHostControlMessage,
  type RelayToClientMessage,
  type RelayToHostMessage,
} from "./protocol.ts";

export interface RelayEnv {
  readonly RELAY_ROOM: DurableObjectNamespace;
  readonly ALLOWED_HOST_IDS?: string;
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
    };

const AUTH_TIMEOUT_MS = 15_000;
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

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const hostId = url.searchParams.get("hostId") ?? "";

    if (url.pathname === "/status") {
      const host = this.getAuthenticatedHost();
      const clients = this.ctx.getWebSockets("client").length;
      return Response.json({
        hostId,
        online: host !== null,
        clients,
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "upgrade_required" }, { status: 426 });
    }

    if (url.pathname === "/host") {
      return this.handleHostUpgrade(hostId);
    }

    if (url.pathname === "/client") {
      return this.handleClientUpgrade(hostId);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async handleHostUpgrade(hostId: string): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    const nonce = randomNonce(32);
    const timestamp = Date.now();
    this.ctx.acceptWebSocket(server, ["host"]);
    server.serializeAttachment({
      role: "host-pending",
      hostId,
      nonce,
      timestamp,
    } satisfies SocketAttachment);

    await this.ctx.storage.setAlarm(timestamp + AUTH_TIMEOUT_MS);
    sendHostJson(server, { type: "challenge", nonce, timestamp });

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleClientUpgrade(hostId: string): Response {
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
    } satisfies SocketAttachment);

    sendHostJson(host, { type: "client_open", connId });
    sendClientJson(server, { type: "connected", connId, hostId });

    return new Response(null, { status: 101, webSocket: client });
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
      this.handleAuthenticatedHostMessage(ws, message);
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
    });

    if (!verification.ok) {
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

    sendHostJson(ws, { type: "ready", hostId: attachment.hostId });
  }

  private handleAuthenticatedHostMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") {
      const decoded = decodeBinaryRelayFrame(message);
      if (!decoded) {
        sendHostJson(ws, {
          type: "error",
          code: "malformed_binary_frame",
          message: "Binary frame header is invalid.",
        });
        return;
      }
      const client = this.getClientSocket(decoded.connId);
      if (!client) {
        sendHostJson(ws, { type: "client_close", connId: decoded.connId, reason: "not_found" });
        return;
      }
      try {
        client.send(decoded.payload);
      } catch {
        safeClose(client, 1011, "send_failed");
      }
      return;
    }

    const parsed = parseHostControlMessage(message);
    if (!parsed) {
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
      case "auth":
        sendHostJson(ws, { type: "ready", hostId: this.getAttachment(ws)?.hostId ?? "" });
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
      host.send(encodeBinaryRelayFrame(connId, message));
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
      // Only disconnect clients if no newer authenticated host has already taken over.
      const replacement = this.ctx.getWebSockets("host").find((other) => {
        if (other === ws) return false;
        return this.getAttachment(other)?.role === "host";
      });
      if (!replacement) {
        for (const client of this.ctx.getWebSockets("client")) {
          safeClose(client, CLOSE_HOST_DISCONNECTED, "host_disconnected");
        }
      }
    }
  }
}
