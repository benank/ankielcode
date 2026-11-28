import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@ankielcode/client-runtime/connection";
import { EnvironmentId, IsoDateTime } from "@ankielcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatPairingInviteOrigin,
  formatRemainingPairingTime,
  formatVerificationCode,
  isPairingInviteBlockedError,
  isPairingInviteExpired,
  isPairingInviteTransientError,
  pairingInviteTerminalMessage,
  resolvePairingInvitePollTransition,
} from "./PairingInviteDialog.logic";

const SAMPLE_CLAIM = {
  inviteId: "inv_abc123",
  environmentId: EnvironmentId.make("env-1"),
  environmentLabel: "Studio Mac",
  httpBaseUrl: "https://studio.example.com/",
  verificationCode: "482-910",
  expiresAt: IsoDateTime.make("2026-11-27T18:05:00.000Z"),
};

describe("PairingInviteDialog.logic", () => {
  it("keeps the exact scheme and relay host path visible when formatting invite origins", () => {
    const hostId = "abcdefghijklmnopqrstuvwxyz".replace(/[0189]/g, "a");
    expect(formatPairingInviteOrigin("http://192.168.1.44:3773/")).toBe("http://192.168.1.44:3773");
    expect(formatPairingInviteOrigin("https://studio.ts.net/")).toBe("https://studio.ts.net");
    expect(formatPairingInviteOrigin(`https://relay.example.workers.dev/h/${hostId}/`)).toBe(
      `https://relay.example.workers.dev/h/${hostId}/`,
    );
    expect(formatPairingInviteOrigin("https://studio.ts.net/extra/path")).toBe(
      "https://studio.ts.net",
    );
  });

  it("formats 6-digit verification codes consistently", () => {
    expect(formatVerificationCode("482-910")).toBe("482-910");
    expect(formatVerificationCode("482910")).toBe("482-910");
    expect(formatVerificationCode(" 123-456 ")).toBe("123-456");
  });

  it("formats remaining pairing time and detects expiration", () => {
    const expiresAt = "2026-11-27T18:05:00.000Z";
    const expiresAtMs = Date.parse(expiresAt);

    expect(formatRemainingPairingTime(expiresAt, expiresAtMs - 125_000)).toEqual({
      expired: false,
      remainingSeconds: 125,
      label: "Expires in 2:05",
    });
    expect(formatRemainingPairingTime(expiresAt, expiresAtMs - 4_100)).toEqual({
      expired: false,
      remainingSeconds: 5,
      label: "Expires in 0:05",
    });
    expect(formatRemainingPairingTime(expiresAt, expiresAtMs)).toEqual({
      expired: true,
      remainingSeconds: 0,
      label: "Expiring…",
    });
    expect(formatRemainingPairingTime("not-a-date", expiresAtMs)).toEqual({
      expired: false,
      remainingSeconds: 0,
      label: "",
    });
  });

  it("classifies transient, blocked, and expired pairing invite states", () => {
    const transient = new ConnectionTransientError({
      reason: "transport",
      detail: "Temporary network blip",
    });
    const blocked = new ConnectionBlockedError({
      reason: "authentication",
      detail: "Invite expired",
    });

    expect(isPairingInviteTransientError(transient)).toBe(true);
    expect(isPairingInviteTransientError(blocked)).toBe(false);
    expect(isPairingInviteTransientError(new Error("generic"))).toBe(false);

    expect(isPairingInviteBlockedError(blocked)).toBe(true);
    expect(isPairingInviteBlockedError(transient)).toBe(false);
    expect(isPairingInviteBlockedError(new Error("generic"))).toBe(false);

    const expiresAt = "2026-11-27T18:05:00.000Z";
    const expiresAtMs = Date.parse(expiresAt);
    expect(isPairingInviteExpired(undefined, expiresAtMs)).toBe(false);
    expect(isPairingInviteExpired("not-a-date", expiresAtMs)).toBe(false);
    expect(isPairingInviteExpired(expiresAt, expiresAtMs - 1)).toBe(false);
    expect(isPairingInviteExpired(expiresAt, expiresAtMs)).toBe(true);
    expect(isPairingInviteExpired(expiresAt, expiresAtMs + 1_000)).toBe(true);
  });

  it("maps poll statuses to continue, approved, and terminal transitions", () => {
    const unchanged = resolvePairingInvitePollTransition(SAMPLE_CLAIM, {
      status: "claimed",
      expiresAt: SAMPLE_CLAIM.expiresAt,
    });
    expect(unchanged).toEqual({ kind: "continue", claim: SAMPLE_CLAIM });

    const extendedExpiresAt = IsoDateTime.make("2026-11-27T18:10:00.000Z");
    const extended = resolvePairingInvitePollTransition(SAMPLE_CLAIM, {
      status: "claimed",
      expiresAt: extendedExpiresAt,
    });
    expect(extended).toEqual({
      kind: "continue",
      claim: { ...SAMPLE_CLAIM, expiresAt: extendedExpiresAt },
    });

    const approved = resolvePairingInvitePollTransition(SAMPLE_CLAIM, {
      status: "approved",
      grantExpiresAt: IsoDateTime.make("2026-11-27T19:00:00.000Z"),
      credential: "cred-secret-token",
    });
    expect(approved).toEqual({
      kind: "approved",
      claim: SAMPLE_CLAIM,
      credential: "cred-secret-token",
    });

    for (const status of ["denied", "cancelled", "expired"] as const) {
      expect(resolvePairingInvitePollTransition(SAMPLE_CLAIM, { status })).toEqual({
        kind: "terminal",
        state: {
          phase: "terminal",
          reason: status,
          canRetry: false,
        },
      });
      expect(pairingInviteTerminalMessage(status).length).toBeGreaterThan(0);
    }
  });
});
