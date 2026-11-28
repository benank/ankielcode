import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionOnboarding,
} from "@ankielcode/client-runtime/connection";
import type { AuthPairingInviteClaimStatus } from "@ankielcode/contracts";
import { extractRelayBasePath } from "@ankielcode/shared/remote";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export const PAIRING_INVITE_POLL_INTERVAL_MS = 1_000;
export const PAIRING_INVITE_MAX_CONSECUTIVE_POLL_ERRORS = 5;

type PairingInviteTerminalReason = "denied" | "cancelled" | "expired";

export type PairingInviteRetryAction =
  | { readonly kind: "claim" }
  | {
      readonly kind: "complete";
      readonly claim: ConnectionOnboarding.PairingInviteClaimResult;
      readonly credential: string;
    };

export type PairingInviteDialogState =
  | { readonly phase: "confirm" }
  | { readonly phase: "claiming" }
  | {
      readonly phase: "waiting";
      readonly claim: ConnectionOnboarding.PairingInviteClaimResult;
    }
  | {
      readonly phase: "completing";
      readonly claim: ConnectionOnboarding.PairingInviteClaimResult;
    }
  | {
      readonly phase: "terminal";
      readonly reason: PairingInviteTerminalReason;
      readonly canRetry: false;
    }
  | {
      readonly phase: "terminal";
      readonly reason: "error";
      readonly message: string;
      readonly canRetry: false;
    }
  | {
      readonly phase: "terminal";
      readonly reason: "error";
      readonly message: string;
      readonly canRetry: true;
      readonly retry: PairingInviteRetryAction;
    };

export const INITIAL_PAIRING_INVITE_STATE: PairingInviteDialogState = { phase: "confirm" };

const isConnectionTransientError = Schema.is(ConnectionTransientError);
const isConnectionBlockedError = Schema.is(ConnectionBlockedError);

export function isPairingInviteTransientError(error: unknown): boolean {
  return (
    isConnectionTransientError(error) ||
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "ConnectionTransientError")
  );
}

export function isPairingInviteBlockedError(error: unknown): boolean {
  return (
    isConnectionBlockedError(error) ||
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "ConnectionBlockedError")
  );
}

export function isPairingInviteExpired(expiresAt: string | undefined, nowMs: number): boolean {
  if (expiresAt === undefined) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

/** Keeps scheme and relay `/h/<hostId>/` path visible so HTTP is never mistaken for HTTPS. */
export function formatPairingInviteOrigin(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed);
    const basePath = extractRelayBasePath(url.pathname);
    return basePath === "/" ? url.origin : `${url.origin}${basePath}`;
  } catch {
    return trimmed;
  }
}

export function formatVerificationCode(code: string): string {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    return `${trimmed.slice(0, 3)}-${trimmed.slice(3)}`;
  }
  return trimmed;
}

export function formatRemainingPairingTime(
  expiresAt: string,
  nowMs: number,
  resolve: MessageResolver = m,
): {
  readonly expired: boolean;
  readonly remainingSeconds: number;
  readonly label: string;
} {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return { expired: false, remainingSeconds: 0, label: "" };
  }
  const remainingMs = Math.max(0, expiresAtMs - nowMs);
  if (remainingMs <= 0) {
    return {
      expired: true,
      remainingSeconds: 0,
      label: resolve(msg("Expiring…")),
    };
  }
  const remainingSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const remaining = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return {
    expired: false,
    remainingSeconds,
    label: resolve(msg("Expires in {remaining}", { remaining })),
  };
}

export function pairingInviteTerminalMessage(
  reason: PairingInviteTerminalReason,
  resolve: MessageResolver = m,
): string {
  switch (reason) {
    case "denied":
      return resolve(msg("This pairing request was denied on your other device."));
    case "cancelled":
      return resolve(msg("This pairing invite was cancelled on your other device."));
    case "expired":
      return resolve(
        msg("This pairing invite expired. Start a new invite from your other device."),
      );
  }
}

type PairingInvitePollTransition =
  | {
      readonly kind: "continue";
      readonly claim: ConnectionOnboarding.PairingInviteClaimResult;
    }
  | {
      readonly kind: "approved";
      readonly claim: ConnectionOnboarding.PairingInviteClaimResult;
      readonly credential: string;
    }
  | {
      readonly kind: "terminal";
      readonly state: Extract<
        PairingInviteDialogState,
        { readonly phase: "terminal"; readonly reason: PairingInviteTerminalReason }
      >;
    };

export function resolvePairingInvitePollTransition(
  claim: ConnectionOnboarding.PairingInviteClaimResult,
  status: AuthPairingInviteClaimStatus,
): PairingInvitePollTransition {
  switch (status.status) {
    case "claimed":
      return {
        kind: "continue",
        claim:
          status.expiresAt && status.expiresAt !== claim.expiresAt
            ? { ...claim, expiresAt: status.expiresAt }
            : claim,
      };
    case "approved":
      return {
        kind: "approved",
        claim,
        credential: status.credential,
      };
    case "denied":
    case "cancelled":
    case "expired":
      return {
        kind: "terminal",
        state: {
          phase: "terminal",
          reason: status.status,
          canRetry: false,
        },
      };
  }
}
