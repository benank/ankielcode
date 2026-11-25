import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("preserves /h/<hostId>/ relay base paths in pairing URLs", () => {
    const hostId = "abcdefghijklmnopqrstuvwxyz".replace(/[0189]/g, "a");
    const relayBase = `https://ankiel-relay.example.workers.dev/h/${hostId}`;

    expect(resolveDesktopPairingUrl(relayBase, "PAIRCODE")).toBe(
      `https://ankiel-relay.example.workers.dev/h/${hostId}/pair#token=PAIRCODE`,
    );
  });
});
