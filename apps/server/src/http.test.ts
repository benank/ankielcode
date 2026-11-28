import { expect, it } from "@effect/vitest";
import { describe, vi } from "vite-plus/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Etag, HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/http";
import { openMediaFile } from "./assets/MediaFile.ts";
import {
  EnvironmentHttpApi,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_HEADER,
} from "@ankielcode/contracts";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import {
  DESKTOP_READINESS_PROOF_PATH,
  isValidDesktopReadinessProof,
} from "@ankielcode/shared/desktopReadinessProof";

import * as ServerConfig from "./config.ts";

import { assetResponseHeaders, assetFileResponse, downloadContentDisposition } from "./http.ts";
import * as ServerHttp from "./http.ts";

describe("browser API CORS", () => {
  it("accepts protocol negotiation with authenticated browser headers", async () => {
    const layerRoute = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
      }),
    );
    const layerApp = Layer.merge(layerRoute, ServerHttp.layerBrowserApiCors).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-cors-test-" })),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });

    try {
      const response = await handler(
        new Request("https://backend.example/api/environment", {
          method: "OPTIONS",
          headers: {
            origin: "https://client.example",
            "access-control-request-method": "GET",
            "access-control-request-headers": [
              ORCHESTRATION_PROTOCOL_HEADER,
              "authorization",
              "dpop",
            ].join(", "),
          },
        }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const allowedHeaders = new Set(
        (response.headers.get("access-control-allow-headers") ?? "")
          .split(",")
          .map((header) => header.trim().toLowerCase()),
      );
      expect(allowedHeaders.has(ORCHESTRATION_PROTOCOL_HEADER)).toBe(true);
      expect(allowedHeaders.has("authorization")).toBe(true);
      expect(allowedHeaders.has("dpop")).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("allows originless desktop requests in dev mode while still rejecting disallowed browser origins", async () => {
    const layerRoute = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add(
          "GET",
          "/api/environment",
          HttpServerResponse.empty({ headers: { vary: "Accept-Encoding" } }),
        );
      }),
    );
    const layerDevConfig = Layer.effect(
      ServerConfig.ServerConfig,
      Effect.map(ServerConfig.ServerConfig, (config) => ({
        ...config,
        devUrl: new URL("http://127.0.0.1:5733"),
      })),
    ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-dev-cors-test-" })));
    const layerApp = Layer.merge(layerRoute, ServerHttp.layerBrowserApiCors).pipe(
      Layer.provide(layerDevConfig),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });

    try {
      const originless = await handler(
        new Request("https://dev.example/api/environment", { method: "GET" }),
      );
      expect(originless.headers.get("access-control-allow-origin")).toBe("*");
      expect(originless.headers.get("access-control-allow-credentials")).toBeNull();
      expect(originless.headers.get("vary")).toBe("Accept-Encoding, Origin");

      const originlessPreflight = await handler(
        new Request("https://dev.example/api/environment", { method: "OPTIONS" }),
      );
      expect(originlessPreflight.status).toBe(204);
      expect(originlessPreflight.headers.get("access-control-allow-origin")).toBe("*");
      expect(originlessPreflight.headers.get("vary")).toBe("Origin");

      const allowed = await handler(
        new Request("https://dev.example/api/environment", {
          method: "GET",
          headers: { origin: "http://127.0.0.1:5733" },
        }),
      );
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5733");
      expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");

      const disallowed = await handler(
        new Request("https://dev.example/api/environment", {
          method: "GET",
          headers: { origin: "https://evil.example" },
        }),
      );
      expect(disallowed.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await dispose();
    }
  });
});

describe("desktop readiness proof", () => {
  // Request handlers read these from the app's own context.
  const serveRoute = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          ServerHttp.layerDesktopReadinessProofRoute.pipe(
            Layer.provideMerge(
              Layer.effect(
                ServerConfig.ServerConfig,
                Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, ...overrides })),
              ).pipe(
                Layer.provide(
                  ServerConfig.layerTest(process.cwd(), { prefix: "http-readiness-test-" }),
                ),
              ),
            ),
            Layer.provideMerge(NodeCrypto.layerMac),
            Layer.provide(NodeServices.layer),
          ),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(() => dispose()),
    ).pipe(
      Effect.map(
        ({ handler }) =>
          (query: string) =>
            Effect.promise(() =>
              handler(
                new Request(`http://172.20.84.98:3773${DESKTOP_READINESS_PROOF_PATH}${query}`),
              ),
            ),
      ),
    );

  it.effect("answers a challenge with a proof bound to the launch's readiness secret", () =>
    Effect.gen(function* () {
      const get = yield* serveRoute({ desktopReadinessSecret: "launch-secret" });

      const response = yield* get("?challenge=abc123");
      const proof = yield* Effect.promise(() => response.text());

      expect(response.status).toBe(200);
      expect(yield* isValidDesktopReadinessProof("launch-secret", "abc123", proof)).toBe(true);
      expect(yield* isValidDesktopReadinessProof("launch-secret", "other", proof)).toBe(false);
      expect(yield* isValidDesktopReadinessProof("another-launch", "abc123", proof)).toBe(false);
      expect(proof).not.toContain("launch-secret");

      expect((yield* get("")).status).toBe(404);
      expect((yield* get(`?challenge=${"a".repeat(129)}`)).status).toBe(404);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layerMac)),
  );

  it.effect("does not answer on a server launched without a readiness secret", () =>
    Effect.gen(function* () {
      const get = yield* serveRoute({});

      expect((yield* get("?challenge=abc123")).status).toBe(404);
    }).pipe(Effect.scoped),
  );
});

const layerFileResponse = Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer);

const makeStaticRequest = Effect.fn("HttpTest.makeStaticRequest")(function* (staticDir?: string) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const layerApp = Layer.merge(
    ServerHttp.layerStaticAndDevRoute,
    ServerHttp.layerHttpCompression,
  ).pipe(Layer.provideMerge(NodeHttpPlatform.layer));
  // HttpRouter.serve prefers outer services; inject the test FileSystem between it and NodeHttpServer.layerTest.
  const services = yield* Layer.build(
    HttpRouter.serve(layerApp, { disableListenLog: true }).pipe(
      Layer.provideMerge(ServerConfig.layer({ ...config, staticDir })),
      Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fileSystem)),
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  );
  const client = Context.get(services, HttpClient.HttpClient);
  return (resource: string, options?: HttpClientRequest.Options) =>
    client.execute(HttpClientRequest.make(options?.method ?? "GET")(resource, options));
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "ankiel-static-http-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("static HTTP responses", (it) => {
  it.effect("does not serve the app from a production server", () =>
    Effect.gen(function* () {
      const request = yield* makeStaticRequest();
      expect((yield* request("/")).status).toBe(404);
      expect((yield* request("/pair")).status).toBe(404);
    }),
  );
});

describe("video asset byte ranges", () => {
  it.effect(
    "rejects unaddressable ranges before streaming and preserves small ranges on large files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "ankiel-guarded-offset-limit-",
        });
        const filePath = path.join(directory, "clip.mp4");
        yield* fs.writeFileString(filePath, "0123456789");
        const canonicalPath = yield* fs.realPath(filePath);
        const unsafeOffset = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
        const size = unsafeOffset + 32n;
        for (const [range, status] of [
          [`bytes=${unsafeOffset}-${unsafeOffset}`, 416],
          [`bytes=0-${unsafeOffset}`, 416],
          ["bytes=-1", 416],
          [undefined, 413],
          ["bytes=0-1", 206],
        ] as const) {
          const file = yield* openMediaFile(canonicalPath);
          if (!file) throw new Error("Expected an opened media file");
          const info = yield* Effect.promise(() => file.handle.stat({ bigint: true }));
          info.size = size;
          const statSpy = vi.spyOn(file.handle, "stat").mockResolvedValue(info);
          yield* Effect.addFinalizer(() => Effect.sync(() => statSpy.mockRestore()));
          const response = HttpServerResponse.toWeb(
            yield* assetFileResponse({ path: canonicalPath, file, mimeType: "video/mp4" }, range),
          );
          expect(response.status).toBe(status);
          if (status === 416) {
            expect(response.headers.get("content-range")).toBe(`bytes */${size}`);
            expect(yield* Effect.promise(() => response.text())).toBe("");
          } else if (status === 206) {
            expect(response.headers.get("content-range")).toBe(`bytes 0-1/${size}`);
            expect(yield* Effect.promise(() => response.text())).toBe("01");
          } else {
            expect(yield* Effect.promise(() => response.text())).toBe(
              "File is too large to preview.",
            );
          }
        }
      }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("keeps attachment media out of the cache once its signed URL expires", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ankiel-attachment-media-" });
      const filePath = path.join(directory, "audio.wav");
      yield* fs.writeFileString(filePath, "RIFF");
      const canonicalPath = yield* fs.realPath(filePath);
      const response = HttpServerResponse.toWeb(
        yield* assetFileResponse({ path: canonicalPath, mimeType: "audio/wav" }),
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
    }).pipe(Effect.provide(layerFileResponse)),
  );
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG and other XML assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
    for (const name of ["page.xhtml", "page.XHT", "feed.xml", "sheet.xsl", "feed.rss"]) {
      expect(assetResponseHeaders(`/workspace/${name}`)).toHaveProperty(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
    }
    expect(assetResponseHeaders("/workspace/photo.png")).not.toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("downloads uploaded documents without executing their content", () => {
    expect(assetResponseHeaders("/attachments/upload.html", { download: true })).toMatchObject({
      "Content-Disposition": "attachment",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/octet-stream",
    });
  });

  it("keeps renderable mime types as octet-stream downloads", () => {
    for (const mimeType of [
      "text/html",
      "text/xml",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/rss+xml",
      "APPLICATION/XML",
      "IMAGE/SVG+XML",
      "application/xml-dtd",
      "application/xml-external-parsed-entity",
      "not a mime",
    ]) {
      expect(
        assetResponseHeaders("/attachments/upload.bin", { download: true, mimeType }),
      ).toHaveProperty("Content-Type", "application/octet-stream");
    }
  });
});

describe("downloadContentDisposition", () => {
  it("quotes plain names and strips quotes and control characters", () => {
    expect(downloadContentDisposition("report.pdf")).toBe('attachment; filename="report.pdf"');
    expect(downloadContentDisposition('we"ird\n.pdf')).toBe('attachment; filename="we_ird_.pdf"');
  });
});

const layerEnvironmentAuth = (prefix: string) =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(Sqlite.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.fresh,
  );

describe("environment descriptor redaction", () => {
  it.live(
    "redacts computer label and platform for unauthenticated requests and returns them when authenticated",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          class MetadataApi extends HttpApi.make("environment").add(
            EnvironmentHttpApi.groups.metadata,
          ) {}
          const authContext = yield* Layer.build(layerEnvironmentAuth("ankiel-descriptor-test-"));
          const auth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
          const layerEnv = Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env-secret-box")),
            getDescriptor: Effect.succeed({
              environmentId: EnvironmentId.make("env-secret-box"),
              label: "Hyperspeed",
              platform: { os: "darwin", arch: "arm64", machine: "mac-mini" } as const,
              serverVersion: "0.1.11",
              orchestrationProtocolVersion: 2,
              capabilities: { repositoryIdentity: true },
            }),
          });
          const routes = HttpApiBuilder.layer(MetadataApi).pipe(
            Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
            Layer.provide(layerEnv),
            Layer.provide(Layer.succeedContext(authContext)),
            Layer.provide(NodeHttpPlatform.layer),
            Layer.provide(Etag.layerWeak),
          );
          const { handler, dispose } = HttpRouter.toWebHandler(routes);
          yield* Effect.addFinalizer(() => Effect.promise(dispose));

          const unauthRes = yield* Effect.promise(() =>
            handler(new Request("http://127.0.0.1/.well-known/ankiel/environment")),
          );
          expect(unauthRes.status).toBe(200);
          const unauthJson = yield* Effect.promise(() => unauthRes.json());
          expect(unauthJson).toMatchObject({
            environmentId: "env-secret-box",
            label: "Ankiel Code",
            platform: { os: "unknown", arch: "other" },
            serverVersion: "0.1.11",
            orchestrationProtocolVersion: 2,
            capabilities: { repositoryIdentity: true },
          });
          expect(unauthJson).not.toHaveProperty("platform.machine");

          const pairing = yield* auth.issuePairingCredential();
          const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
            pairing.credential,
            undefined,
            { label: "Test", deviceType: "desktop" },
          );
          const authRes = yield* Effect.promise(() =>
            handler(
              new Request("http://127.0.0.1/.well-known/ankiel/environment", {
                headers: { Authorization: `Bearer ${token.access_token}` },
              }),
            ),
          );
          expect(authRes.status).toBe(200);
          const authJson = yield* Effect.promise(() => authRes.json());
          expect(authJson).toMatchObject({
            environmentId: "env-secret-box",
            label: "Hyperspeed",
            platform: { os: "darwin", arch: "arm64", machine: "mac-mini" },
          });

          // The CLI's `/mcp` session is no environment session, so it reads the redacted one.
          const mcp = yield* auth.issueCliMcpClientSession({ label: "ankiel thread cli" });
          const mcpRes = yield* Effect.promise(() =>
            handler(
              new Request("http://127.0.0.1/.well-known/ankiel/environment", {
                headers: { Authorization: `Bearer ${mcp.token}` },
              }),
            ),
          );
          expect(mcpRes.status).toBe(200);
          const mcpJson = yield* Effect.promise(() => mcpRes.json());
          expect(mcpJson).toMatchObject({
            environmentId: "env-secret-box",
            label: "Ankiel Code",
            platform: { os: "unknown", arch: "other" },
          });
        }),
      ),
  );
});
