import * as NodeWS from "@effect/platform-node/NodeWS";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const { WebSocketServer } = NodeWS;

import {
  buildHostTunnelWsUrl,
  buildPublicRelayBaseUrl,
  formatRelaySetupString,
  parseRelaySetupString,
  resolveRelaySetupFromEnvOrFile,
  saveRelaySetupToStateDir,
} from "./relayProtocol.ts";
import {
  loadOrCreateRelayHostIdentity,
  RELAY_FORWARDED_PREFIX_HEADER,
  RELAY_INTERNAL_TOKEN_HEADER,
  resolveTrustedRelayForwardedPrefix,
  startRelayTunnelClient,
} from "./RelayTunnelClient.ts";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ankiel-relay-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("relayProtocol", () => {
  it("parses ankiel-relay:// setup strings and detects path vs subdomain routing", () => {
    const workersDev = parseRelaySetupString("ankiel-relay://ankiel-relay.me.workers.dev#s3cr3t");
    expect(workersDev).toEqual({
      relayOrigin: "https://ankiel-relay.me.workers.dev",
      secret: "s3cr3t",
      routingMode: "path",
    });

    const customDomain = parseRelaySetupString("ankiel-relay://relay.ankiel.com#my-secret");
    expect(customDomain).toEqual({
      relayOrigin: "https://relay.ankiel.com",
      secret: "my-secret",
      routingMode: "subdomain",
    });

    const local = parseRelaySetupString("http://127.0.0.1:8789#dev-secret");
    expect(local).toEqual({
      relayOrigin: "http://127.0.0.1:8789",
      secret: "dev-secret",
      routingMode: "path",
    });

    const hostId = "abcdefghijklmnopqrstuvwxyz".replace(/[0189]/g, "a");
    expect(buildHostTunnelWsUrl(customDomain, hostId)).toBe(
      `wss://relay.ankiel.com/relay/host/${hostId}`,
    );
    expect(buildPublicRelayBaseUrl(customDomain, hostId)).toBe(
      `https://${hostId}.relay.ankiel.com/`,
    );
    expect(buildPublicRelayBaseUrl(workersDev, hostId)).toBe(
      `https://ankiel-relay.me.workers.dev/h/${hostId}/`,
    );
    expect(formatRelaySetupString(customDomain)).toBe("ankiel-relay://relay.ankiel.com#my-secret");
  });

  it("loads setup from env vars or <stateDir>/relay.json", () => {
    const dir = makeTempDir();
    expect(resolveRelaySetupFromEnvOrFile(dir, {})).toBeNull();

    NodeFS.writeFileSync(
      NodePath.join(dir, "relay.json"),
      JSON.stringify({ setup: "ankiel-relay://relay.ankiel.com#file-secret" }),
    );
    expect(resolveRelaySetupFromEnvOrFile(dir, {})).toEqual({
      relayOrigin: "https://relay.ankiel.com",
      secret: "file-secret",
      routingMode: "subdomain",
    });

    expect(
      resolveRelaySetupFromEnvOrFile(dir, {
        ANKIEL_RELAY_SETUP: "ankiel-relay://override.workers.dev#env-secret",
      }),
    ).toEqual({
      relayOrigin: "https://override.workers.dev",
      secret: "env-secret",
      routingMode: "path",
    });
  });

  it("saves relay secret separately in 0600 secrets/relay-secret instead of relay.json", () => {
    const dir = makeTempDir();
    const saved = saveRelaySetupToStateDir(dir, "ankiel-relay://relay.ankiel.com#top-secret-value");
    expect(saved.secretPath).toBeTruthy();

    const relayJsonText = NodeFS.readFileSync(saved.configPath, "utf8");
    expect(relayJsonText).not.toContain("top-secret-value");
    expect(JSON.parse(relayJsonText)).toEqual({
      url: "https://relay.ankiel.com",
      routingMode: "subdomain",
      enabled: true,
    });

    if (NodePath.sep === "/") {
      const mode = NodeFS.statSync(saved.secretPath!).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    expect(resolveRelaySetupFromEnvOrFile(dir, {})).toEqual({
      relayOrigin: "https://relay.ankiel.com",
      secret: "top-secret-value",
      routingMode: "subdomain",
    });
  });

  it("persists and reloads the same Ed25519 host identity", async () => {
    const dir = makeTempDir();
    const idPath = NodePath.join(dir, "relay-host-identity.json");
    const first = await loadOrCreateRelayHostIdentity(idPath);
    const second = await loadOrCreateRelayHostIdentity(idPath);
    expect(first.hostId).toMatch(/^[a-z2-7]{26}$/);
    expect(second.hostId).toBe(first.hostId);
    expect(second.publicKeyBase64Url).toBe(first.publicKeyBase64Url);
  });

  it("rejects spoofed x-forwarded-prefix headers when no valid internal token is present", () => {
    expect(
      resolveTrustedRelayForwardedPrefix({
        [RELAY_FORWARDED_PREFIX_HEADER]: "/h/aaaaaaaaaaaaaaaaaaaaaaaaaa",
        [RELAY_INTERNAL_TOKEN_HEADER]: "spoofed",
      }),
    ).toBeNull();
  });

  it("forwards HTTP and WebSocket traffic cleanly against a mock relay socket", async () => {
    const dir = makeTempDir();
    const identity = await loadOrCreateRelayHostIdentity(
      NodePath.join(dir, "relay-host-identity.json"),
    );

    // Local target HTTP + WS server (simulates Ankiel Code server on loopback)
    const localServer = NodeHttp.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            trustedPrefix: resolveTrustedRelayForwardedPrefix(
              req.headers as Record<string, string | undefined>,
            ),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
    });
    const localWss = new WebSocketServer({ server: localServer, path: "/ws" });
    localWss.on("connection", (ws, req) => {
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          ws.send(data);
        } else {
          ws.send(`echo:${req.url}:${data.toString()}`);
        }
      });
    });
    await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
    const localPort = (localServer.address() as { port: number }).port;

    // Minimal mock relay server accepting /relay/host/:hostId
    const relayServer = NodeHttp.createServer();
    const relayWss = new WebSocketServer({ server: relayServer });
    const hostMessages: Array<string | Buffer> = [];
    const messageWaiters: Array<() => void> = [];
    const notifyWaiters = () => {
      for (const wake of messageWaiters.splice(0)) wake();
    };
    const waitForCondition = async (predicate: () => boolean) => {
      while (!predicate()) {
        await new Promise<void>((resolve) => {
          messageWaiters.push(resolve);
        });
      }
    };
    let hostSocket: InstanceType<typeof NodeWS.WebSocket> | null = null;

    relayWss.on("connection", (ws) => {
      hostSocket = ws;
      ws.send(
        JSON.stringify({
          type: "challenge",
          nonce: "test-nonce",
          timestamp: 1_700_000_000_000,
          requiresSecret: true,
        }),
      );
      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          const parsed = JSON.parse(data.toString("utf8")) as { type: string };
          if (parsed.type === "auth") {
            ws.send(JSON.stringify({ type: "ready", hostId: identity.hostId }));
            return;
          }
          hostMessages.push(data.toString("utf8"));
          notifyWaiters();
        } else {
          hostMessages.push(Buffer.from(data as Buffer));
          notifyWaiters();
        }
      });
    });
    await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
    const relayPort = (relayServer.address() as { port: number }).port;

    const handle = startRelayTunnelClient({
      setup: parseRelaySetupString(`http://127.0.0.1:${relayPort}#test-secret`),
      identity,
      localHost: "127.0.0.1",
      localPort,
    });

    try {
      await handle.waitUntilReady();
      expect(hostSocket).not.toBeNull();

      // Trigger tunneled HTTP GET
      const reqId = crypto.randomUUID();
      hostSocket!.send(
        JSON.stringify({
          type: "http_request",
          reqId,
          method: "GET",
          path: "/api/test?a=1",
          headers: [],
          hasBody: false,
        }),
      );

      await waitForCondition(() =>
        hostMessages
          .filter((m): m is string => typeof m === "string")
          .some((m) => {
            const parsed = JSON.parse(m) as { type: string; reqId?: string };
            return parsed.type === "http_response_end" && parsed.reqId === reqId;
          }),
      );
      const startMsg = hostMessages
        .filter((m): m is string => typeof m === "string")
        .map((m) => JSON.parse(m) as { type: string; reqId?: string; status?: number })
        .find((m) => m.type === "http_response_start" && m.reqId === reqId);
      expect(startMsg?.status).toBe(200);

      const bodyChunks = hostMessages
        .filter((m): m is Buffer => Buffer.isBuffer(m))
        .map((b) => b.subarray(37));
      const bodyJson = JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) as {
        url: string;
        trustedPrefix: string;
      };
      expect(bodyJson.url).toBe("/api/test?a=1");
      expect(bodyJson.trustedPrefix).toBe(`/h/${identity.hostId}`);

      // Trigger tunneled WS message
      const connId = crypto.randomUUID();
      hostSocket!.send(
        JSON.stringify({
          type: "client_open",
          connId,
          path: "/ws?ticket=abc",
          headers: [],
        }),
      );
      hostSocket!.send(JSON.stringify({ type: "frame", connId, data: "ping-local" }));

      await waitForCondition(() =>
        hostMessages
          .filter((m): m is string => typeof m === "string")
          .some((m) => {
            const parsed = JSON.parse(m) as { type: string; connId?: string };
            return parsed.type === "frame" && parsed.connId === connId;
          }),
      );
      const wsReply = hostMessages
        .filter((m): m is string => typeof m === "string")
        .map((m) => JSON.parse(m) as { type: string; connId?: string; data?: string })
        .find((m) => m.type === "frame" && m.connId === connId);
      expect(wsReply?.data).toBe("echo:/ws?ticket=abc:ping-local");
    } finally {
      await handle.stop();
      localWss.close();
      relayWss.close();
      localServer.close();
      relayServer.close();
    }
  });

  it.runIf(Boolean(process.env.ANKIEL_TEST_RELAY_URL))(
    "tunnels real HTTP + WebSocket traffic end-to-end through local wrangler dev Durable Object",
    async () => {
      const relayUrl = process.env.ANKIEL_TEST_RELAY_URL!;
      const relaySecret = process.env.ANKIEL_TEST_RELAY_SECRET ?? "";
      const dir = makeTempDir();
      const identity = await loadOrCreateRelayHostIdentity(
        NodePath.join(dir, "relay-host-identity.json"),
      );

      const localServer = NodeHttp.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          res.writeHead(200, {
            "content-type": "application/json",
            "x-local-server": "ankiel",
          });
          res.end(
            JSON.stringify({
              method: req.method,
              path: req.url,
              trustedPrefix: resolveTrustedRelayForwardedPrefix(
                req.headers as Record<string, string | undefined>,
              ),
              auth: req.headers.authorization ?? null,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
      });
      const localWss = new WebSocketServer({ server: localServer, path: "/ws" });
      localWss.on("connection", (ws, req) => {
        ws.on("message", (data, isBinary) => {
          if (isBinary) {
            ws.send(Buffer.concat([Buffer.from([0xaa]), Buffer.from(data as Buffer)]));
          } else {
            ws.send(JSON.stringify({ echoed: data.toString(), path: req.url }));
          }
        });
      });
      await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
      const localPort = (localServer.address() as { port: number }).port;

      const setup = parseRelaySetupString(
        relayUrl,
        relaySecret ? { secret: relaySecret } : undefined,
      );
      const tunnel = startRelayTunnelClient({
        setup,
        identity,
        localHost: "127.0.0.1",
        localPort,
      });

      try {
        await tunnel.waitUntilReady(10_000);

        const httpRes = await fetch(`${tunnel.publicBaseUrl}api/auth/session?check=1`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "DPoP demo-token",
          },
          body: JSON.stringify({ hello: "cloudflare-do" }),
        });
        expect(httpRes.status).toBe(200);
        expect(httpRes.headers.get("x-local-server")).toBe("ankiel");
        expect(await httpRes.json()).toEqual({
          method: "POST",
          path: "/api/auth/session?check=1",
          trustedPrefix: `/h/${identity.hostId}`,
          auth: "DPoP demo-token",
          body: JSON.stringify({ hello: "cloudflare-do" }),
        });

        const wsUrl = `${tunnel.publicBaseUrl.replace(/^http/, "ws")}ws?ticket=xyz`;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = "arraybuffer";
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener("error", () => reject(new Error(`WS failed: ${wsUrl}`)), {
            once: true,
          });
        });

        const textReply = new Promise<string>((resolve) =>
          ws.addEventListener("message", (e) => resolve(String(e.data)), { once: true }),
        );
        ws.send("hello-rpc");
        expect(JSON.parse(await textReply)).toEqual({
          echoed: "hello-rpc",
          path: "/ws?ticket=xyz",
        });

        const binReply = new Promise<Uint8Array>((resolve) =>
          ws.addEventListener("message", (e) => resolve(new Uint8Array(e.data as ArrayBuffer)), {
            once: true,
          }),
        );
        ws.send(new Uint8Array([1, 2, 3]));
        expect(await binReply).toEqual(new Uint8Array([0xaa, 1, 2, 3]));

        ws.close(1000, "done");
      } finally {
        await tunnel.stop();
        localWss.close();
        localServer.close();
      }
    },
  );
});
