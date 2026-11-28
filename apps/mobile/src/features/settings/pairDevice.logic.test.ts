import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "@ankielcode/client-runtime/connection";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  EnvironmentAuthInvalidError,
  EnvironmentId,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
} from "@ankielcode/contracts";
import {
  decodePairingInviteFile,
  PAIRING_INVITE_FILE_EXTENSION,
  PAIRING_INVITE_MIME_TYPE,
  PAIRING_INVITE_UTTYPE,
  type PairingInvitePayload,
} from "@ankielcode/shared/remote";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";

const cacheMocks = vi.hoisted(() => {
  class MockFile {
    exists = true;
    deleted = false;
    constructor(readonly name: string) {}
    delete() {
      this.deleted = true;
      this.exists = false;
    }
  }
  class MockDirectory {
    exists = true;
    delete = vi.fn();
    constructor(readonly name: string) {}
  }
  const cache = {
    exists: true,
    list: vi.fn<() => (MockFile | MockDirectory)[]>(() => []),
  };
  return { MockFile, MockDirectory, cache };
});

vi.mock("expo-file-system", () => ({
  File: cacheMocks.MockFile,
  Directory: cacheMocks.MockDirectory,
  Paths: { cache: cacheMocks.cache },
}));

import {
  classifyPairingPollError,
  cleanupPairingInviteCacheFiles,
  formatCountdown,
  resolveDefaultPairingScopes,
  selectShareablePairingBaseUrl,
  sharePairingInviteFile,
} from "./pairDevice.logic";

const ENV_ID = EnvironmentId.make("env-pair-test");

function makeBearerRoute(
  connectionId: string,
  httpBaseUrl: string,
  options?: { readonly network?: "tailscale" | "relay" },
): ConnectionRoute {
  const wsBaseUrl = httpBaseUrl.replace(/^http/, "ws");
  return {
    target: new BearerConnectionTarget({
      environmentId: ENV_ID,
      label: "Studio Mac",
      connectionId,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId: ENV_ID,
        label: "Studio Mac",
        httpBaseUrl,
        wsBaseUrl,
        ...(options?.network ? { network: options.network } : {}),
      }),
    ),
  };
}

function makeCatalogEntry(
  routes: readonly [ConnectionRoute, ...ConnectionRoute[]],
): ConnectionCatalogEntry {
  const [primary, ...alternateRoutes] = routes;
  return {
    target: primary.target,
    profile: primary.profile,
    enabled: true,
    ...(alternateRoutes.length > 0 ? { alternateRoutes } : {}),
  };
}

describe("selectShareablePairingBaseUrl", () => {
  it("prefers HTTPS Cloudflare Relay and preserves /h/<hostId>/", () => {
    const entry = makeCatalogEntry([
      makeBearerRoute("https-route", "https://studio.ts.net:3773/extra"),
      makeBearerRoute("lan-route", "http://192.168.1.42:3773"),
    ]);

    const selected = selectShareablePairingBaseUrl({
      relayStatus: {
        configured: true,
        connected: true,
        publicBaseUrl: "https://relay.example.com/h/ABCDEFGHIJKLMNOP2345672345/api?foo=1#bar",
      },
      entry,
      activeRouteId: "lan-route",
    });

    expect(selected).toBe("https://relay.example.com/h/abcdefghijklmnop2345672345/");
  });

  it("prefers saved HTTPS and LAN routes over a configured-but-disconnected relay", () => {
    const httpsAndLan = makeCatalogEntry([
      makeBearerRoute("lan-route", "http://192.168.1.42:3773"),
      makeBearerRoute(
        "https-route",
        "https://studio.tail1234.ts.net/h/abcdefghijklmnop2345672345/ws",
      ),
    ]);
    const disconnectedRelay = {
      configured: true,
      connected: false,
      publicBaseUrl: "https://relay.example.com/h/abcdefghijklmnop2345672345/",
    };
    const relayAndLan = makeCatalogEntry([
      makeBearerRoute("relay-route", disconnectedRelay.publicBaseUrl, { network: "relay" }),
      makeBearerRoute("lan-route", "http://192.168.1.42:3773"),
    ]);

    expect(
      selectShareablePairingBaseUrl({
        relayStatus: disconnectedRelay,
        entry: httpsAndLan,
        activeRouteId: "lan-route",
      }),
    ).toBe("https://studio.tail1234.ts.net/h/abcdefghijklmnop2345672345/");

    expect(
      selectShareablePairingBaseUrl({
        relayStatus: disconnectedRelay,
        entry: relayAndLan,
        activeRouteId: "relay-route",
      }),
    ).toBe("http://192.168.1.42:3773/");
  });

  it("falls back to a configured-but-disconnected HTTPS relay when no saved route is shareable", () => {
    const loopbackOnly = makeCatalogEntry([
      makeBearerRoute("loopback-route", "http://127.0.0.1:3773"),
    ]);

    expect(
      selectShareablePairingBaseUrl({
        relayStatus: {
          configured: true,
          connected: false,
          publicBaseUrl: "https://relay.example.com/h/ABCDEFGHIJKLMNOP2345672345/ws",
        },
        entry: loopbackOnly,
      }),
    ).toBe("https://relay.example.com/h/abcdefghijklmnop2345672345/");

    expect(
      selectShareablePairingBaseUrl({
        relayStatus: {
          configured: false,
          connected: false,
          publicBaseUrl: "https://relay.example.com/h/abcdefghijklmnop2345672345/",
        },
        entry: loopbackOnly,
      }),
    ).toBeNull();
  });

  it("falls back to non-loopback HTTP LAN route, preferring the active route", () => {
    const entry = makeCatalogEntry([
      makeBearerRoute("loopback-route", "http://127.0.0.1:3773"),
      makeBearerRoute("lan-a", "http://192.168.1.10:3773/status"),
      makeBearerRoute("lan-b", "http://10.0.0.15:3773"),
    ]);

    expect(
      selectShareablePairingBaseUrl({
        relayStatus: null,
        entry,
        activeRouteId: "lan-b",
      }),
    ).toBe("http://10.0.0.15:3773/");
  });

  it("rejects loopback and wildcard addresses across all inputs", () => {
    const entry = makeCatalogEntry([
      makeBearerRoute("localhost", "https://localhost:3773"),
      makeBearerRoute("ipv4-loopback", "http://127.0.0.1:3773"),
      makeBearerRoute("ipv4-loopback-other", "http://127.0.1.5:3773"),
      makeBearerRoute("ipv6-loopback", "http://[::1]:3773"),
      makeBearerRoute("wildcard", "http://0.0.0.0:3773"),
      makeBearerRoute("sub-localhost", "https://dev.localhost:3773"),
    ]);

    expect(
      selectShareablePairingBaseUrl({
        relayStatus: {
          configured: true,
          connected: true,
          publicBaseUrl: "https://127.0.0.1:8443/",
        },
        entry,
      }),
    ).toBeNull();
  });
});

describe("resolveDefaultPairingScopes", () => {
  it("omits scopes when the session holds all standard client scopes", () => {
    expect(resolveDefaultPairingScopes(new Set(AuthStandardClientScopes))).toBeUndefined();
    expect(resolveDefaultPairingScopes(null)).toBeUndefined();
  });

  it("intersects cleanly when the session holds a narrower subset of standard scopes", () => {
    const narrowed = new Set<AuthEnvironmentScope>([
      AuthAccessWriteScope,
      AuthOrchestrationReadScope,
      AuthAccessReadScope,
    ]);

    expect(resolveDefaultPairingScopes(narrowed)).toEqual([
      AuthOrchestrationReadScope,
      AuthAccessReadScope,
      AuthAccessWriteScope,
    ]);
  });
});

describe("formatCountdown", () => {
  it("formats remaining milliseconds as m:ss and clamps at 0:00", () => {
    expect(formatCountdown(114_000)).toBe("1:54");
    expect(formatCountdown(5_200)).toBe("0:06");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-4_000)).toBe("0:00");
  });
});

describe("sharePairingInviteFile", () => {
  const sampleInvite: PairingInvitePayload = {
    version: 1,
    inviteId: "inv_AbC-123",
    environmentId: "env-pair-test",
    baseUrl: "https://relay.example.com/h/abcdefghijklmnop2345672345/",
    label: "Studio Mac",
    expiresAt: "2026-11-28T01:30:00.000Z",
  };

  it("sweeps stale files before writing, shares with UTType & MIME type, and keeps the new file for AirDrop", async () => {
    const staleFile = new cacheMocks.MockFile(`ankiel-pair-old${PAIRING_INVITE_FILE_EXTENSION}`);
    cacheMocks.cache.list.mockReturnValueOnce([staleFile]);
    let writtenFilename = "";
    let writtenContents = "";
    const deleteTemp = vi.fn();
    const shareFile = vi.fn(async () => undefined);

    await sharePairingInviteFile(sampleInvite, {
      dialogTitle: "Pair Studio Mac",
      isSharingAvailable: async () => true,
      writeTempFile: async (filename, contents) => {
        expect(staleFile.deleted).toBe(true);
        writtenFilename = filename;
        writtenContents = contents;
        return { uri: `file:///cache/${filename}`, delete: deleteTemp };
      },
      shareFile,
    });

    expect(writtenFilename).toBe(`ankiel-pair-inv_AbC-123${PAIRING_INVITE_FILE_EXTENSION}`);
    expect(decodePairingInviteFile(writtenContents)).toEqual(sampleInvite);
    expect(shareFile).toHaveBeenCalledWith(
      `file:///cache/ankiel-pair-inv_AbC-123${PAIRING_INVITE_FILE_EXTENSION}`,
      {
        UTI: PAIRING_INVITE_UTTYPE,
        mimeType: PAIRING_INVITE_MIME_TYPE,
        dialogTitle: "Pair Studio Mac",
      },
    );
    expect(deleteTemp).not.toHaveBeenCalled();
  });

  it("continues sharing if sweeping older cache files fails", async () => {
    const shareFile = vi.fn(async () => undefined);
    cacheMocks.cache.list.mockImplementationOnce(() => {
      throw new Error("cache read failed");
    });

    await sharePairingInviteFile(sampleInvite, {
      isSharingAvailable: async () => true,
      writeTempFile: async (filename) => ({
        uri: `file:///cache/${filename}`,
        delete: vi.fn(),
      }),
      shareFile,
    });

    expect(shareFile).toHaveBeenCalledTimes(1);
  });

  it("deletes the temp file when sharing throws and swallows cleanup errors", async () => {
    const deleteTemp = vi.fn(() => {
      throw new Error("unlink failed");
    });
    const shareError = new Error("share failed to open");

    await expect(
      sharePairingInviteFile(sampleInvite, {
        isSharingAvailable: async () => true,
        writeTempFile: async (filename) => ({
          uri: `file:///cache/${filename}`,
          delete: deleteTemp,
        }),
        shareFile: async () => {
          throw shareError;
        },
      }),
    ).rejects.toBe(shareError);

    expect(deleteTemp).toHaveBeenCalledTimes(1);
  });

  it("cleanupPairingInviteCacheFiles removes only stale ankiel-pair-*.ankielpair files", async () => {
    const staleOne = new cacheMocks.MockFile(`ankiel-pair-old1${PAIRING_INVITE_FILE_EXTENSION}`);
    const staleTwo = new cacheMocks.MockFile(`ankiel-pair-old2${PAIRING_INVITE_FILE_EXTENSION}`);
    const unrelatedFile = new cacheMocks.MockFile("ankiel-upload-123.png");
    const matchingDir = new cacheMocks.MockDirectory(
      `ankiel-pair-dir${PAIRING_INVITE_FILE_EXTENSION}`,
    );
    cacheMocks.cache.list.mockReturnValueOnce([staleOne, staleTwo, unrelatedFile, matchingDir]);

    await cleanupPairingInviteCacheFiles();

    expect(staleOne.deleted).toBe(true);
    expect(staleTwo.deleted).toBe(true);
    expect(unrelatedFile.deleted).toBe(false);
    expect(matchingDir.delete).not.toHaveBeenCalled();
  });
});

describe("classifyPairingPollError", () => {
  it("classifies not-found as expired, auth/scope/forbidden as permanent, and others as transient", () => {
    expect(
      classifyPairingPollError(
        new EnvironmentResourceNotFoundError({
          code: "not_found",
          reason: "pairing_invite_not_found",
          traceId: "trace-1",
        }),
      ),
    ).toEqual({ kind: "expired" });

    const authError = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-2",
    });
    expect(classifyPairingPollError(authError)).toEqual({
      kind: "permanent",
      error: authError,
    });

    const scopeError = new EnvironmentScopeRequiredError({
      code: "insufficient_scope",
      requiredScope: AuthAccessWriteScope,
      traceId: "trace-3",
    });
    expect(classifyPairingPollError(scopeError)).toEqual({
      kind: "permanent",
      error: scopeError,
    });

    const forbiddenError = new EnvironmentOperationForbiddenError({
      code: "operation_forbidden",
      reason: "pairing_invite_invalid_state",
      traceId: "trace-4",
    });
    expect(classifyPairingPollError(forbiddenError)).toEqual({
      kind: "permanent",
      error: forbiddenError,
    });

    expect(classifyPairingPollError(new Error("network offline"))).toEqual({ kind: "transient" });
  });
});
