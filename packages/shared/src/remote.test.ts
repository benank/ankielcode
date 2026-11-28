import { describe, expect, it } from "vite-plus/test";

import {
  buildPairingAppLink,
  buildThreadAppLink,
  readPairingAppLink,
  readThreadAppLink,
  RemoteBackendUrlMissingError,
  RemotePairingTokenMissingError,
  RemotePairingUrlInvalidError,
  resolveRemotePairingTarget,
} from "./remote.ts";

describe("remote", () => {
  it("derives backend urls and token from a pairing url", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("accepts pairing urls that still use a query token", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair?token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("derives backend URLs from HTTPS pairing links", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://desktop.tailnet.ts.net:44342/pair#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://desktop.tailnet.ts.net:44342/",
      wsBaseUrl: "wss://desktop.tailnet.ts.net:44342/",
    });
  });

  it("derives backend urls from a host and pairing code", () => {
    expect(
      resolveRemotePairingTarget({
        host: "https://remote.example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("treats a protocol-relative host as https", () => {
    expect(
      resolveRemotePairingTarget({
        host: "//remote.example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("collapses extra leading slashes instead of producing an empty host", () => {
    expect(
      resolveRemotePairingTarget({
        host: "///example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://example.com/",
      wsBaseUrl: "wss://example.com/",
    });
  });

  it("does not double-prepend https when the host already carries a scheme", () => {
    expect(
      resolveRemotePairingTarget({
        host: "//https://example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://example.com/",
      wsBaseUrl: "wss://example.com/",
    });
  });

  it("preserves host ports when normalizing a bare host input", () => {
    expect(
      resolveRemotePairingTarget({
        host: "myserver.com:3000",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://myserver.com:3000/",
      wsBaseUrl: "wss://myserver.com:3000/",
    });
  });

  it("rejects unsupported direct pairing URL protocols", () => {
    let pairingUrlError: unknown;
    try {
      resolveRemotePairingTarget({
        pairingUrl: "ftp://remote.example.com/pair#token=pairing-token",
      });
    } catch (cause) {
      pairingUrlError = cause;
    }

    expect(pairingUrlError).toBeInstanceOf(RemotePairingUrlInvalidError);
    expect(pairingUrlError).toMatchObject({ protocol: "ftp:" });
    expect((pairingUrlError as RemotePairingUrlInvalidError).cause).toBeUndefined();
  });

  it("uses distinct structural errors for missing pairing inputs", () => {
    expect(() => resolveRemotePairingTarget({})).toThrowError(RemoteBackendUrlMissingError);
    expect(() =>
      resolveRemotePairingTarget({ pairingUrl: "https://remote.example.com/pair" }),
    ).toThrowError(RemotePairingTokenMissingError);
    expect(() =>
      resolveRemotePairingTarget({
        host: "https://user:secret@remote.example.com/path?token=sensitive#fragment",
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "RemotePairingCodeMissingError",
        host: "remote.example.com",
      }),
    );
  });

  it("round-trips pairing urls through app links on every channel scheme", () => {
    const pairingUrl = "https://vps.example.com/pair#token=ABC123";
    const appLink = buildPairingAppLink(pairingUrl);
    expect(appLink.startsWith("ankielcode://pair?")).toBe(true);
    expect(readPairingAppLink(appLink)).toBe(pairingUrl);
    expect(readPairingAppLink(appLink.replace("ankielcode:", "ankielcode-dev:"))).toBe(pairingUrl);
    expect(readPairingAppLink("ankielcode://pair")).toBeNull();
    expect(readPairingAppLink(appLink.replace("//pair?", "//pair/other?"))).toBeNull();
    expect(
      readPairingAppLink(`ankielcode://threads?pairingUrl=${encodeURIComponent(pairingUrl)}`),
    ).toBeNull();
    expect(
      readPairingAppLink(`https://pair?pairingUrl=${encodeURIComponent(pairingUrl)}`),
    ).toBeNull();
  });

  it("round-trips thread links on every channel scheme", () => {
    const thread = { environmentId: "env 1:ü", threadId: "thread-abc" };
    const link = buildThreadAppLink(thread);
    expect(link).toBe("ankielcode://thread/env%201%3A%C3%BC/thread-abc");
    expect(readThreadAppLink(link)).toEqual(thread);
    expect(readThreadAppLink(buildThreadAppLink(thread, "ankielcode-dev"))).toEqual(thread);
  });

  it("refuses thread links that are not exactly in canonical form", () => {
    for (const link of [
      "ankielcode://thread/env",
      "ankielcode://thread/env/",
      "ankielcode://thread/env/thread/",
      "ankielcode://thread/env/thread/extra",
      "ankielcode://thread//thread",
      "ankielcode://thread/./thread",
      "ankielcode://thread/env/../other/thread",
      "ankielcode://thread/env/..",
      "ankielcode://thread/env%2Fx/thread",
      "ankielcode://thread/env%5Cx/thread",
      "ankielcode://thread/env%2fx/thread",
      "ankielcode://thread/env%E0%A4%A/thread",
      "ankielcode://thread/env%0A/thread",
      "ankielcode://thread/%20env/thread",
      "ankielcode://thread/env/thread?approve=1",
      "ankielcode://thread/env/thread#reply",
      "ankielcode://user@thread/env/thread",
      "ankielcode://thread:1/env/thread",
      "ankielcode://Thread/env/thread",
      "ankielcode://threads/env/thread",
      "ankielcode:thread/env/thread",
      "ankielcodex://thread/env/thread",
      "https://thread/env/thread",
      `ankielcode://thread/${"e".repeat(257)}/thread`,
      "not a url",
    ]) {
      expect(readThreadAppLink(link), link).toBeNull();
    }
  });

  it("preserves /h/<hostId>/ relay base paths for workers.dev pairing urls and hosts", () => {
    const hostId = "abcdefghijklmnopqrstuvwxyz";
    expect(
      resolveRemotePairingTarget({
        pairingUrl: `https://ankiel-relay.me.workers.dev/h/${hostId}/#token=pairing-token`,
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: `https://ankiel-relay.me.workers.dev/h/${hostId}/`,
      wsBaseUrl: `wss://ankiel-relay.me.workers.dev/h/${hostId}/`,
    });

    expect(
      resolveRemotePairingTarget({
        host: `https://ankiel-relay.me.workers.dev/h/${hostId}`,
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: `https://ankiel-relay.me.workers.dev/h/${hostId}/`,
      wsBaseUrl: `wss://ankiel-relay.me.workers.dev/h/${hostId}/`,
    });
  });
});
