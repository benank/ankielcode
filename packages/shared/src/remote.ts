import * as Schema from "effect/Schema";

import { parseUrl } from "./url.ts";

const PAIRING_TOKEN_PARAM = "token";
const PAIRING_APP_LINK_PARAM = "pairingUrl";
const APP_LINK_PROTOCOL = /^ankielcode(?:-[a-z]+)?:$/;
const SUPPORTED_REMOTE_BACKEND_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

const readHashParams = (url: URL): URLSearchParams =>
  new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

export class RemoteBackendUrlMissingError extends Schema.TaggedError<RemoteBackendUrlMissingError>()(
  "RemoteBackendUrlMissingError",
  {},
) {
  override get message(): string {
    return "Enter a backend URL.";
  }
}

export class RemotePairingUrlInvalidError extends Schema.TaggedError<RemotePairingUrlInvalidError>()(
  "RemotePairingUrlInvalidError",
  {
    cause: Schema.optional(Schema.Defect()),
    protocol: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return "Pairing URL is invalid.";
  }
}

export class RemoteBackendUrlInvalidError extends Schema.TaggedError<RemoteBackendUrlInvalidError>()(
  "RemoteBackendUrlInvalidError",
  {
    source: Schema.Literal("direct-host"),
    cause: Schema.optional(Schema.Defect()),
    protocol: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return "Backend URL is invalid.";
  }
}

export class RemotePairingTokenMissingError extends Schema.TaggedError<RemotePairingTokenMissingError>()(
  "RemotePairingTokenMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return "Pairing URL is missing its token.";
  }
}

export class RemotePairingCodeMissingError extends Schema.TaggedError<RemotePairingCodeMissingError>()(
  "RemotePairingCodeMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return "Enter a pairing code.";
  }
}

export const RemotePairingTargetError = Schema.Union([
  RemoteBackendUrlMissingError,
  RemotePairingUrlInvalidError,
  RemoteBackendUrlInvalidError,
  RemotePairingTokenMissingError,
  RemotePairingCodeMissingError,
]);
export type RemotePairingTargetError = typeof RemotePairingTargetError.Type;

const hasSupportedRemoteBackendProtocol = (url: URL): boolean =>
  SUPPORTED_REMOTE_BACKEND_PROTOCOLS.has(url.protocol);

const RELAY_BASE_PATH_PATTERN = /^\/h\/([a-z2-7]{26})(?:\/|$)/i;

/** Preserves `/h/<hostId>/` path-prefix relay routes while normalizing all other paths to `/`. */
export const extractRelayBasePath = (pathname: string): string => {
  const match = RELAY_BASE_PATH_PATTERN.exec(pathname);
  return match ? `/h/${match[1]!.toLowerCase()}/` : "/";
};

const normalizeRemoteBaseUrl = (
  rawValue: string,
  source: RemoteBackendUrlInvalidError["source"],
): URL => {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new RemoteBackendUrlMissingError();
  }

  const withoutLeadingSlashes = trimmed.replace(/^\/+/, "");
  const normalizedInput = /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(withoutLeadingSlashes)
    ? withoutLeadingSlashes
    : `https://${withoutLeadingSlashes}`;
  let url: URL;
  try {
    url = new URL(normalizedInput);
  } catch (cause) {
    throw new RemoteBackendUrlInvalidError({ source, cause });
  }
  if (!hasSupportedRemoteBackendProtocol(url)) {
    throw new RemoteBackendUrlInvalidError({
      source,
      protocol: url.protocol,
    });
  }
  url.pathname = extractRelayBasePath(url.pathname);
  url.search = "";
  url.hash = "";
  return url;
};

const toHttpBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") {
    next.protocol = "http:";
  } else if (next.protocol === "wss:") {
    next.protocol = "https:";
  }
  next.pathname = extractRelayBasePath(next.pathname);
  next.search = "";
  next.hash = "";
  return next.toString();
};

const toWsBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "http:") {
    next.protocol = "ws:";
  } else if (next.protocol === "https:") {
    next.protocol = "wss:";
  }
  next.pathname = extractRelayBasePath(next.pathname);
  next.search = "";
  next.hash = "";
  return next.toString();
};

export interface ResolvedRemotePairingTarget {
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export const getPairingTokenFromUrl = (url: URL): string | null => {
  const hashToken = readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hashToken.length > 0) {
    return hashToken;
  }

  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return searchToken.length > 0 ? searchToken : null;
};

export const stripPairingTokenFromUrl = (url: URL): URL => {
  const next = new URL(url.toString());
  const hashParams = readHashParams(next);
  if (hashParams.has(PAIRING_TOKEN_PARAM)) {
    hashParams.delete(PAIRING_TOKEN_PARAM);
    next.hash = hashParams.toString();
  }
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  return next;
};

export const setPairingTokenOnUrl = (url: URL, credential: string): URL => {
  const next = new URL(url.toString());
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  next.hash = new URLSearchParams([[PAIRING_TOKEN_PARAM, credential]]).toString();
  return next;
};

/** Wraps a pairing URL in the `ankielcode://pair` link that desktop opens and mobile scans. */
export const buildPairingAppLink = (pairingUrl: string): string =>
  `ankielcode://pair?${new URLSearchParams([[PAIRING_APP_LINK_PARAM, pairingUrl]])}`;

/** Reads the pairing URL from a `ankielcode://pair` link on any app channel scheme. */
export const readPairingAppLink = (value: string): string | null => {
  const url = parseUrl(value);
  if (!url) return null;
  if (!APP_LINK_PROTOCOL.test(url.protocol) || url.host !== "pair") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  return url.searchParams.get(PAIRING_APP_LINK_PARAM)?.trim() || null;
};

const THREAD_APP_LINK_HOST = "thread";
const THREAD_APP_LINK_ID_MAX_LENGTH = 256;

export interface ThreadAppLink {
  readonly environmentId: string;
  readonly threadId: string;
}

/** `ankielcode://thread/<environmentId>/<threadId>`, which opens that thread in the desktop app. */
export const buildThreadAppLink = (thread: ThreadAppLink, scheme = "ankielcode"): string =>
  `${scheme}://${THREAD_APP_LINK_HOST}/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`;

const isThreadAppLinkId = (id: string) =>
  id.length > 0 &&
  id.length <= THREAD_APP_LINK_ID_MAX_LENGTH &&
  id === id.trim() &&
  id !== "." &&
  id !== ".." &&
  [...id].every((char) => {
    const code = char.charCodeAt(0);
    return code > 0x1f && code !== 0x7f && char !== "/" && char !== "\\";
  });

const decodeThreadAppLinkId = (segment: string): string | null => {
  try {
    const id = decodeURIComponent(segment);
    return isThreadAppLinkId(id) ? id : null;
  } catch {
    return null;
  }
};

/**
 * Reads a thread link on any app channel scheme. Links come from outside the app, so anything
 * but the exact form `buildThreadAppLink` writes is refused: no query, fragment, userinfo, port,
 * dot segments or alternate encodings.
 */
export const readThreadAppLink = (value: string): ThreadAppLink | null => {
  const url = parseUrl(value);
  if (!url || !APP_LINK_PROTOCOL.test(url.protocol) || url.host !== THREAD_APP_LINK_HOST) {
    return null;
  }
  const segments = url.pathname.split("/");
  if (segments.length !== 3 || segments[0] !== "") return null;
  const environmentId = decodeThreadAppLinkId(segments[1]!);
  const threadId = decodeThreadAppLinkId(segments[2]!);
  if (environmentId === null || threadId === null) return null;
  const link = { environmentId, threadId };
  return buildThreadAppLink(link, url.protocol.slice(0, -1)) === value ? link : null;
};

/** @public */
export const PAIRING_HANDOFF_ACTIVITY_TYPE = "com.ankiel.ankielcode.pair-environment";
export const PAIRING_INVITE_FILE_EXTENSION = ".ankielpair";
/** @public */
export const PAIRING_INVITE_UTTYPE = "com.ankiel.ankielcode.pairing-invite";
/** @public */
export const PAIRING_INVITE_MIME_TYPE = "application/vnd.ankielcode.pairing-invite+json";
export const PAIRING_INVITE_MAX_FILE_BYTES = 16_384;

export interface PairingInvitePayload {
  readonly version: 1;
  readonly inviteId: string;
  readonly environmentId: string;
  readonly baseUrl: string;
  readonly label?: string;
  readonly expiresAt?: string;
}

const PAIRING_INVITE_FIELDS = new Set([
  "inviteId",
  "environmentId",
  "baseUrl",
  "label",
  "expiresAt",
]);
const INVITE_CONTROL_CHARACTERS = /[\p{Cc}]/u;
const INVITE_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const inviteEncoder = new TextEncoder();

const readPairingInvite = (value: unknown): PairingInvitePayload | null => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "version" && !PAIRING_INVITE_FIELDS.has(key))
  ) {
    return null;
  }
  const { version, inviteId, environmentId, baseUrl, label, expiresAt } = value as Record<
    string,
    unknown
  >;
  if (
    version !== 1 ||
    typeof inviteId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(inviteId) ||
    typeof environmentId !== "string" ||
    environmentId.length === 0 ||
    environmentId.length > 256 ||
    environmentId !== environmentId.trim() ||
    INVITE_CONTROL_CHARACTERS.test(environmentId) ||
    typeof baseUrl !== "string" ||
    baseUrl.length > 1_024 ||
    !/^https?:\/\/[^/?#@\\\s]+(?:\/|$)/i.test(baseUrl) ||
    /[?#\\\s]/.test(baseUrl) ||
    INVITE_CONTROL_CHARACTERS.test(baseUrl) ||
    (label !== undefined &&
      (typeof label !== "string" ||
        label.length === 0 ||
        label !== label.trim() ||
        INVITE_CONTROL_CHARACTERS.test(label) ||
        inviteEncoder.encode(label).byteLength > 256)) ||
    (expiresAt !== undefined &&
      (typeof expiresAt !== "string" ||
        !INVITE_DATE.test(expiresAt) ||
        !Number.isFinite(Date.parse(expiresAt))))
  ) {
    return null;
  }
  const url = parseUrl(baseUrl);
  if (!url || url.username || url.password) return null;
  url.pathname = extractRelayBasePath(url.pathname);
  if (url.href.length > 1_024) return null;

  return {
    version: 1,
    inviteId,
    environmentId,
    baseUrl: url.href,
    ...(label === undefined ? {} : { label }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
};

const requirePairingInvite = (invite: PairingInvitePayload): PairingInvitePayload => {
  const validated = readPairingInvite(invite);
  if (!validated) throw new TypeError("Invalid pairing invite.");
  return validated;
};

/** @public */
export const isPairingInviteFilePath = (path: string): boolean =>
  path.toLowerCase().endsWith(PAIRING_INVITE_FILE_EXTENSION);

/** @public */
export const buildPairingInviteAppLink = (
  invite: PairingInvitePayload,
  scheme = "ankielcode",
): string => {
  if (!APP_LINK_PROTOCOL.test(`${scheme}:`)) throw new TypeError("Invalid pairing invite scheme.");
  const { version, ...fields } = toPairingInviteUserInfo(invite);
  return `${scheme}://pair-invite?${new URLSearchParams({ v: version!, ...fields })}`;
};

/** @public */
export const readPairingInviteAppLink = (value: string): PairingInvitePayload | null => {
  if (
    value.length > PAIRING_INVITE_MAX_FILE_BYTES ||
    value !== value.trim() ||
    INVITE_CONTROL_CHARACTERS.test(value) ||
    !/^[a-z-]+:\/\/pair-invite\?/.test(value) ||
    value.includes("#")
  ) {
    return null;
  }
  const url = parseUrl(value);
  if (!url || !APP_LINK_PROTOCOL.test(url.protocol) || url.host !== "pair-invite") return null;

  const fields: Record<string, string> = {};
  for (const [key, field] of url.searchParams) {
    if ((key !== "v" && !PAIRING_INVITE_FIELDS.has(key)) || Object.hasOwn(fields, key)) {
      return null;
    }
    fields[key] = field;
  }
  const { v, ...invite } = fields;
  return parsePairingInviteUserInfo({ version: v, ...invite });
};

/** @public */
export const encodePairingInviteFile = (invite: PairingInvitePayload): string =>
  JSON.stringify(requirePairingInvite(invite));

/** @public */
export const decodePairingInviteFile = (raw: string): PairingInvitePayload | null => {
  if (
    raw.length > PAIRING_INVITE_MAX_FILE_BYTES ||
    inviteEncoder.encode(raw).byteLength > PAIRING_INVITE_MAX_FILE_BYTES
  ) {
    return null;
  }
  try {
    return readPairingInvite(JSON.parse(raw));
  } catch {
    return null;
  }
};

/** @public */
export const toPairingInviteUserInfo = (invite: PairingInvitePayload): Record<string, string> => {
  const { version, ...fields } = requirePairingInvite(invite);
  return { version: String(version), ...fields };
};

/** @public */
export const parsePairingInviteUserInfo = (userInfo: unknown): PairingInvitePayload | null => {
  if (
    typeof userInfo !== "object" ||
    userInfo === null ||
    Array.isArray(userInfo) ||
    Object.values(userInfo).some((value) => typeof value !== "string")
  ) {
    return null;
  }
  const { version, ...fields } = userInfo as Record<string, string>;
  return version === "1" ? readPairingInvite({ version: 1, ...fields }) : null;
};

export const resolveRemotePairingTarget = (input: {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): ResolvedRemotePairingTarget => {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl.length > 0) {
    let url: URL;
    try {
      url = new URL(pairingUrl);
    } catch (cause) {
      throw new RemotePairingUrlInvalidError({ cause });
    }
    if (!hasSupportedRemoteBackendProtocol(url)) {
      throw new RemotePairingUrlInvalidError({
        protocol: url.protocol,
      });
    }
    const credential = getPairingTokenFromUrl(url) ?? "";
    if (!credential) {
      throw new RemotePairingTokenMissingError({ host: url.host });
    }
    return {
      credential,
      httpBaseUrl: toHttpBaseUrl(url),
      wsBaseUrl: toWsBaseUrl(url),
    };
  }

  const host = input.host?.trim() ?? "";
  const pairingCode = input.pairingCode?.trim() ?? "";
  if (!host) {
    throw new RemoteBackendUrlMissingError();
  }
  const normalizedHost = normalizeRemoteBaseUrl(host, "direct-host");
  if (!pairingCode) {
    throw new RemotePairingCodeMissingError({ host: normalizedHost.host });
  }

  return {
    credential: pairingCode,
    httpBaseUrl: toHttpBaseUrl(normalizedHost),
    wsBaseUrl: toWsBaseUrl(normalizedHost),
  };
};
