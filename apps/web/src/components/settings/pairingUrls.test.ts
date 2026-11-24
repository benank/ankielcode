import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.code.ankiel.com");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.code.ankiel.com/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });

  it("preserves /h/<hostId>/ relay base paths in desktop and hosted pairing URLs", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.code.ankiel.com");
    const hostId = "abcdefghijklmnopqrstuvwxyz".replace(/[0189]/g, "a");
    const relayBase = `https://ankiel-relay.example.workers.dev/h/${hostId}`;

    expect(resolveDesktopPairingUrl(relayBase, "PAIRCODE")).toBe(
      `https://ankiel-relay.example.workers.dev/h/${hostId}/pair#token=PAIRCODE`,
    );
    expect(resolveHostedPairingUrl(relayBase, "PAIRCODE")).toBe(
      `https://app.code.ankiel.com/pair?host=${encodeURIComponent(relayBase)}#token=PAIRCODE`,
    );
  });
});
