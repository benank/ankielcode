import {
  type ConnectionCatalogEntry,
  connectionRouteId,
  connectionRoutes,
  routeHttpBaseUrl,
} from "@ankielcode/client-runtime/connection";
import {
  type AuthEnvironmentScope,
  type AuthPairingInviteStatus,
  AuthStandardClientScopes,
  EnvironmentAuthInvalidError,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
  type SessionGrantInput,
  sessionGrantsScope,
} from "@ankielcode/contracts";
import {
  isLocalLoopbackHost,
  isWildcardHost,
  normalizeHostname,
} from "@ankielcode/shared/hostClassification";
import {
  encodePairingInviteFile,
  extractRelayBasePath,
  PAIRING_INVITE_FILE_EXTENSION,
  PAIRING_INVITE_MIME_TYPE,
  PAIRING_INVITE_UTTYPE,
  type PairingInvitePayload,
} from "@ankielcode/shared/remote";
import * as Schema from "effect/Schema";
import type { SharingOptions } from "expo-sharing";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

const PAIRING_INVITE_FILE_PREFIX = "ankiel-pair-";

interface SelectShareablePairingBaseUrlInput {
  readonly relayStatus?: {
    readonly configured: boolean;
    readonly connected: boolean;
    readonly publicBaseUrl: string | null;
  } | null;
  readonly entry?: ConnectionCatalogEntry | null;
  readonly activeRouteId?: string | null;
}

interface TempPairingInviteFile {
  readonly uri: string;
  readonly delete: () => void | Promise<void>;
}

interface SharePairingInviteFileDeps {
  readonly dialogTitle?: string;
  readonly writeTempFile?: (filename: string, contents: string) => Promise<TempPairingInviteFile>;
  readonly isSharingAvailable?: () => Promise<boolean>;
  readonly shareFile?: (uri: string, options: SharingOptions) => Promise<void>;
}

export type PairingPollErrorClassification =
  | { readonly kind: "expired" }
  | { readonly kind: "permanent"; readonly error: Error }
  | { readonly kind: "transient" };

const isResourceNotFoundError = Schema.is(EnvironmentResourceNotFoundError);
const isPermanentAuthError = Schema.is(
  Schema.Union([
    EnvironmentAuthInvalidError,
    EnvironmentScopeRequiredError,
    EnvironmentOperationForbiddenError,
  ]),
);

export function classifyPairingPollError(failure: unknown): PairingPollErrorClassification {
  if (isResourceNotFoundError(failure)) {
    return { kind: "expired" };
  }
  if (isPermanentAuthError(failure)) {
    return { kind: "permanent", error: failure };
  }
  return { kind: "transient" };
}

function isUnshareablePairingHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized.length === 0 ||
    isLocalLoopbackHost(normalized) ||
    isWildcardHost(normalized) ||
    normalized.endsWith(".localhost")
  );
}

function normalizeShareablePairingUrl(
  rawUrl: string | null | undefined,
  options?: { readonly requireHttps?: boolean },
): string | null {
  const trimmed = rawUrl?.trim() ?? "";
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (options?.requireHttps && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (isUnshareablePairingHost(url.hostname)) return null;
  url.pathname = extractRelayBasePath(url.pathname);
  url.search = "";
  url.hash = "";
  return url.href;
}

export function selectShareablePairingBaseUrl(
  input: SelectShareablePairingBaseUrlInput,
): string | null {
  const relayUrl = input.relayStatus
    ? normalizeShareablePairingUrl(input.relayStatus.publicBaseUrl, { requireHttps: true })
    : null;

  if (input.relayStatus?.connected === true && relayUrl !== null) {
    return relayUrl;
  }
  const disconnectedRelayUrl = input.relayStatus?.configured === true ? relayUrl : null;

  const routes = input.entry ? connectionRoutes(input.entry) : [];
  const prioritized =
    input.activeRouteId !== undefined && input.activeRouteId !== null
      ? [
          ...routes.filter((route) => connectionRouteId(route.target) === input.activeRouteId),
          ...routes.filter((route) => connectionRouteId(route.target) !== input.activeRouteId),
        ]
      : routes;
  let httpUrl: string | null = null;
  for (const route of prioritized) {
    const url = normalizeShareablePairingUrl(routeHttpBaseUrl(route));
    if (url === null || url === disconnectedRelayUrl) continue;
    if (url.startsWith("https://")) return url;
    httpUrl ??= url;
  }

  return httpUrl ?? disconnectedRelayUrl;
}

export function sessionGrantedScopes(
  session: SessionGrantInput | null | undefined,
): ReadonlySet<AuthEnvironmentScope> | null {
  if (!session?.authenticated) return null;
  return new Set(AuthStandardClientScopes.filter((scope) => sessionGrantsScope(session, scope)));
}

export function resolveDefaultPairingScopes(
  sessionScopes: ReadonlySet<AuthEnvironmentScope> | null | undefined,
): ReadonlyArray<AuthEnvironmentScope> | undefined {
  if (!sessionScopes) return undefined;
  const granted = AuthStandardClientScopes.filter((scope) => sessionScopes.has(scope));
  if (granted.length === 0 || granted.length === AuthStandardClientScopes.length) {
    return undefined;
  }
  return granted;
}

export function isFullStandardClientScopeSet(scopes: ReadonlyArray<AuthEnvironmentScope>): boolean {
  const granted = new Set(scopes);
  return AuthStandardClientScopes.every((scope) => granted.has(scope));
}

export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatClaimDeviceFallback(
  claim: Pick<NonNullable<AuthPairingInviteStatus["claim"]>, "clientDeviceType" | "clientOs">,
  resolve: MessageResolver = m,
): string {
  const os = claim.clientOs.trim();
  const hasKnownOs = os.length > 0 && os.toLowerCase() !== "unknown";
  switch (claim.clientDeviceType) {
    case "desktop":
      return hasKnownOs ? resolve(msg("{os} desktop", { os })) : resolve(msg("Desktop device"));
    case "mobile":
      return hasKnownOs ? resolve(msg("{os} mobile", { os })) : resolve(msg("Mobile device"));
    case "tablet":
      return hasKnownOs ? resolve(msg("{os} tablet", { os })) : resolve(msg("Tablet device"));
    case "bot":
      return resolve(msg("Automated client"));
    case "unknown":
      return hasKnownOs ? os : resolve(msg("Another device"));
  }
}

async function defaultWriteTempFile(
  filename: string,
  contents: string,
): Promise<TempPairingInviteFile> {
  const { File, Paths } = await import("expo-file-system");
  const file = new File(Paths.cache, filename);
  try {
    file.create({ intermediates: true, overwrite: true });
    await file.write(contents);
    return {
      uri: file.uri,
      delete: () => {
        if (file.exists) file.delete();
      },
    };
  } catch (error) {
    try {
      if (file.exists) file.delete();
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function isPairingInviteCacheFilename(name: string): boolean {
  return (
    name.startsWith(PAIRING_INVITE_FILE_PREFIX) && name.endsWith(PAIRING_INVITE_FILE_EXTENSION)
  );
}

async function sweepStalePairingInviteFiles(): Promise<void> {
  try {
    const { File, Paths } = await import("expo-file-system");
    if (!Paths.cache.exists) return;
    for (const entry of Paths.cache.list()) {
      if (!(entry instanceof File)) continue;
      if (!isPairingInviteCacheFilename(entry.name)) continue;
      try {
        if (entry.exists) entry.delete();
      } catch {
        // Ignore individual stale file cleanup errors.
      }
    }
  } catch {
    // Cache sweeping is best-effort and must never fail sharing or teardown.
  }
}

export { sweepStalePairingInviteFiles as cleanupPairingInviteCacheFiles };

export async function sharePairingInviteFile(
  invite: PairingInvitePayload,
  deps: SharePairingInviteFileDeps = {},
): Promise<void> {
  const payload = encodePairingInviteFile(invite);
  const safeId = invite.inviteId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "invite";
  const filename = `${PAIRING_INVITE_FILE_PREFIX}${safeId}${PAIRING_INVITE_FILE_EXTENSION}`;

  const isAvailable =
    deps.isSharingAvailable ?? (async () => (await import("expo-sharing")).isAvailableAsync());
  if (!(await isAvailable())) {
    throw new Error(m(msg("Sharing files is unavailable on this device.")));
  }

  await sweepStalePairingInviteFiles();

  const shareFile = deps.shareFile ?? (await import("expo-sharing")).shareAsync;
  const writeTempFile = deps.writeTempFile ?? defaultWriteTempFile;
  const tempFile = await writeTempFile(filename, payload);
  // Leave the shared file in cache after shareAsync resolves so iOS sharingd can finish
  // transferring it during AirDrop acceptance; stale files are swept on next share or teardown.
  try {
    await shareFile(tempFile.uri, {
      UTI: PAIRING_INVITE_UTTYPE,
      mimeType: PAIRING_INVITE_MIME_TYPE,
      dialogTitle: deps.dialogTitle ?? m(msg("Pair a Device")),
    });
  } catch (error) {
    try {
      await tempFile.delete();
    } catch {
      // Cleanup failure must never mask the share error.
    }
    throw error;
  }
}
