// @effect-diagnostics nodeBuiltinImport:off - Relay setup files live alongside stateDir.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const HOST_ID_LENGTH = 26;
const CHALLENGE_DOMAIN = "ankiel-relay-host-v1";
const SECRET_DOMAIN = "ankiel-relay-secret-v1";

export const BINARY_FRAME_WS_DATA = 0x01;
export const BINARY_FRAME_HTTP_REQ_BODY = 0x02;
export const BINARY_FRAME_HTTP_RES_BODY = 0x03;

export type BinaryFrameKind =
  | typeof BINARY_FRAME_WS_DATA
  | typeof BINARY_FRAME_HTTP_REQ_BODY
  | typeof BINARY_FRAME_HTTP_RES_BODY;

const STREAM_ID_BYTE_LENGTH = 36;
const BINARY_HEADER_LENGTH = 1 + STREAM_ID_BYTE_LENGTH;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type RelayRoutingMode = "path" | "subdomain";

export interface RelaySetupConfig {
  readonly relayOrigin: string;
  readonly secret?: string;
  readonly routingMode: RelayRoutingMode;
}

export type HeaderEntries = ReadonlyArray<readonly [string, string]>;

export type RelayToHostMessage =
  | {
      readonly type: "challenge";
      readonly nonce: string;
      readonly timestamp: number;
      readonly requiresSecret?: boolean;
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

function encodeBase32(bytes: Uint8Array): string {
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
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function deriveHostId(rawPublicKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", rawPublicKey);
  return encodeBase32(new Uint8Array(digest)).slice(0, HOST_ID_LENGTH);
}

export function buildHostChallengeMessage(
  hostId: string,
  nonce: string,
  timestamp: number,
): Uint8Array {
  return textEncoder.encode(`${CHALLENGE_DOMAIN}\n${hostId}\n${nonce}\n${timestamp}`);
}

export async function signRelaySecret(
  secret: string,
  hostId: string,
  nonce: string,
  timestamp: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`${SECRET_DOMAIN}\n${hostId}\n${nonce}\n${timestamp}`),
  );
  return encodeBase64Url(new Uint8Array(mac));
}

export function encodeBinaryFrame(
  kind: BinaryFrameKind,
  id: string,
  payload: Uint8Array,
): Uint8Array {
  const idBytes = textEncoder.encode(id);
  if (idBytes.byteLength !== STREAM_ID_BYTE_LENGTH) {
    throw new Error(`Invalid stream id byte length: ${idBytes.byteLength}`);
  }
  const frame = new Uint8Array(BINARY_HEADER_LENGTH + payload.byteLength);
  frame[0] = kind;
  frame.set(idBytes, 1);
  frame.set(payload, BINARY_HEADER_LENGTH);
  return frame;
}

export function decodeBinaryFrame(
  data: Uint8Array,
): { readonly kind: BinaryFrameKind; readonly id: string; readonly payload: Uint8Array } | null {
  if (data.byteLength < BINARY_HEADER_LENGTH) return null;
  const kind = data[0];
  if (
    kind !== BINARY_FRAME_WS_DATA &&
    kind !== BINARY_FRAME_HTTP_REQ_BODY &&
    kind !== BINARY_FRAME_HTTP_RES_BODY
  ) {
    return null;
  }
  const id = textDecoder.decode(data.subarray(1, BINARY_HEADER_LENGTH));
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { kind, id, payload: data.subarray(BINARY_HEADER_LENGTH) };
}

function defaultRoutingModeForHostname(hostname: string): RelayRoutingMode {
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower === "[::1]" ||
    lower.endsWith(".workers.dev") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(lower)
  ) {
    return "path";
  }
  return "subdomain";
}

/** Parses `ankiel-relay://...#<secret>` or `https://...#<secret>`, inferring path vs subdomain mode. */
export function parseRelaySetupString(
  raw: string,
  overrides?: {
    readonly secret?: string;
    readonly routingMode?: RelayRoutingMode;
  },
): RelaySetupConfig {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Relay setup string is empty.");
  }

  let normalized = trimmed;
  if (/^ankiel-relay:\/\//iu.test(normalized)) {
    const rest = normalized.slice("ankiel-relay://".length);
    const isLocal = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|#|\?|$)/iu.test(rest);
    normalized = `${isLocal ? "http" : "https"}://${rest}`;
  } else if (!/^[a-zA-Z][a-zA-Z\d+-]*:\/\//u.test(normalized)) {
    const isLocal = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|#|\?|$)/iu.test(normalized);
    normalized = `${isLocal ? "http" : "https"}://${normalized}`;
  }

  const parsed = new URL(normalized);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported relay URL protocol: ${parsed.protocol}`);
  }

  const hashValue = parsed.hash.startsWith("#") ? parsed.hash.slice(1).trim() : "";
  const hashSecret = hashValue.startsWith("secret=")
    ? (new URLSearchParams(hashValue).get("secret")?.trim() ?? "")
    : decodeURIComponent(hashValue);
  const modeParam = parsed.searchParams.get("mode")?.trim().toLowerCase();
  const explicitMode: RelayRoutingMode | undefined =
    overrides?.routingMode ??
    (modeParam === "path" || modeParam === "subdomain" ? modeParam : undefined);

  const secret = overrides?.secret?.trim() || hashSecret || undefined;
  const routingMode = explicitMode ?? defaultRoutingModeForHostname(parsed.hostname);

  return {
    relayOrigin: parsed.origin,
    ...(secret ? { secret } : {}),
    routingMode,
  };
}

export function formatRelaySetupString(config: RelaySetupConfig): string {
  const url = new URL(config.relayOrigin);
  const hostPart = url.host;
  const modeSuffix =
    config.routingMode !== defaultRoutingModeForHostname(url.hostname)
      ? `?mode=${config.routingMode}`
      : "";
  const secretSuffix = config.secret ? `#${encodeURIComponent(config.secret)}` : "";
  return `ankiel-relay://${hostPart}${modeSuffix}${secretSuffix}`;
}

export function buildHostTunnelWsUrl(config: RelaySetupConfig, hostId: string): string {
  const url = new URL(config.relayOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/relay/host/${hostId}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function buildPublicRelayBaseUrl(config: RelaySetupConfig, hostId: string): string {
  const url = new URL(config.relayOrigin);
  if (config.routingMode === "subdomain") {
    url.hostname = `${hostId}.${url.hostname}`;
    url.pathname = "/";
  } else {
    url.pathname = `/h/${hostId}/`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function publicRelayHostHeader(config: RelaySetupConfig, hostId: string): string {
  const url = new URL(buildPublicRelayBaseUrl(config, hostId));
  return url.host;
}

export function publicRelayForwardedPrefix(
  config: RelaySetupConfig,
  hostId: string,
): string | undefined {
  return config.routingMode === "path" ? `/h/${hostId}` : undefined;
}

const RELAY_SECRET_FILENAME = "relay-secret";

/**
 * Persists a Relay Setup String cleanly: non-secret config in `<stateDir>/relay.json`,
 * secret material in `<stateDir>/secrets/relay-secret` (`0600` inside `0700` dir).
 */
export function saveRelaySetupToStateDir(
  stateDir: string,
  rawSetup: string,
): {
  readonly config: RelaySetupConfig;
  readonly configPath: string;
  readonly secretPath: string | null;
} {
  const config = parseRelaySetupString(rawSetup);
  const secretsDir = NodePath.join(stateDir, "secrets");
  NodeFS.mkdirSync(stateDir, { recursive: true });
  NodeFS.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  try {
    NodeFS.chmodSync(secretsDir, 0o700);
  } catch {
    // Ignore on platforms without POSIX chmod.
  }

  const secretPath = NodePath.join(secretsDir, RELAY_SECRET_FILENAME);
  if (config.secret) {
    NodeFS.writeFileSync(secretPath, `${config.secret}\n`, { mode: 0o600 });
    try {
      NodeFS.chmodSync(secretPath, 0o600);
    } catch {
      // Ignore on platforms without POSIX chmod.
    }
  } else if (NodeFS.existsSync(secretPath)) {
    NodeFS.rmSync(secretPath, { force: true });
  }

  const configPath = NodePath.join(stateDir, "relay.json");
  NodeFS.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        url: config.relayOrigin,
        routingMode: config.routingMode,
        enabled: true,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  return {
    config,
    configPath,
    secretPath: config.secret ? secretPath : null,
  };
}

function readStoredRelaySecret(stateDir: string): string | undefined {
  const secretPath = NodePath.join(stateDir, "secrets", RELAY_SECRET_FILENAME);
  if (!NodeFS.existsSync(secretPath)) return undefined;
  try {
    return NodeFS.readFileSync(secretPath, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function removeRelaySetupFromStateDir(stateDir: string): void {
  const configPath = NodePath.join(stateDir, "relay.json");
  const secretPath = NodePath.join(stateDir, "secrets", RELAY_SECRET_FILENAME);
  if (NodeFS.existsSync(configPath)) {
    NodeFS.rmSync(configPath, { force: true });
  }
  if (NodeFS.existsSync(secretPath)) {
    NodeFS.rmSync(secretPath, { force: true });
  }
}

export function resolveRelaySetupSourceFromEnvOrFile(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { readonly config: RelaySetupConfig; readonly source: "env" | "file" } | null {
  const envMode = env.ANKIEL_RELAY_ROUTING_MODE?.trim().toLowerCase();
  const routingMode: RelayRoutingMode | undefined =
    envMode === "path" || envMode === "subdomain" ? envMode : undefined;
  const envSecret = env.ANKIEL_RELAY_SECRET?.trim() || undefined;

  const envSetup = env.ANKIEL_RELAY_SETUP?.trim();
  if (envSetup) {
    return {
      config: parseRelaySetupString(envSetup, {
        ...(envSecret ? { secret: envSecret } : {}),
        ...(routingMode ? { routingMode } : {}),
      }),
      source: "env",
    };
  }

  const envUrl = env.ANKIEL_RELAY_URL?.trim();
  if (envUrl) {
    return {
      config: parseRelaySetupString(envUrl, {
        ...(envSecret ? { secret: envSecret } : {}),
        ...(routingMode ? { routingMode } : {}),
      }),
      source: "env",
    };
  }

  const configPath = NodePath.join(stateDir, "relay.json");
  if (!NodeFS.existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(NodeFS.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (raw.enabled === false) return null;
    const rawTarget =
      (typeof raw.setup === "string" && raw.setup.trim()) ||
      (typeof raw.url === "string" && raw.url.trim()) ||
      "";
    if (!rawTarget) return null;
    const storedSecret = readStoredRelaySecret(stateDir);
    const fileSecret =
      storedSecret ?? (typeof raw.secret === "string" ? raw.secret.trim() : undefined);
    const fileMode =
      raw.routingMode === "path" || raw.routingMode === "subdomain" ? raw.routingMode : undefined;
    return {
      config: parseRelaySetupString(rawTarget, {
        ...(fileSecret ? { secret: fileSecret } : {}),
        ...(fileMode ? { routingMode: fileMode } : {}),
      }),
      source: "file",
    };
  } catch {
    return null;
  }
}

export function resolveRelaySetupFromEnvOrFile(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): RelaySetupConfig | null {
  return resolveRelaySetupSourceFromEnvOrFile(stateDir, env)?.config ?? null;
}

function readStoredRelayHostId(stateDir: string): string | null {
  for (const candidate of [
    NodePath.join(stateDir, "relay-host-identity.json"),
    NodePath.join(stateDir, "secrets", "relay-host-identity.json"),
  ]) {
    if (!NodeFS.existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(NodeFS.readFileSync(candidate, "utf8")) as Record<string, unknown>;
      if (typeof raw.hostId === "string" && raw.hostId.trim().length > 0) {
        return raw.hostId.trim();
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveStoredRelayPublicUrl(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  readonly relayOrigin: string;
  readonly publicBaseUrl: string | null;
  readonly source: "env" | "file";
} | null {
  const resolved = resolveRelaySetupSourceFromEnvOrFile(stateDir, env);
  if (!resolved) return null;
  const hostId = readStoredRelayHostId(stateDir);
  return {
    relayOrigin: resolved.config.relayOrigin,
    publicBaseUrl: hostId ? buildPublicRelayBaseUrl(resolved.config, hostId) : null,
    source: resolved.source,
  };
}
