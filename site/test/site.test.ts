import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { handleRequest } from "../src/index.ts";
import { extractReleaseSummary, type GitHubReleasePayload } from "../src/releases.ts";

const { describe, it } = NodeTest;
const assert = NodeAssert;

const SAMPLE_RELEASE: GitHubReleasePayload = {
  tag_name: "v0.2.0",
  name: "Ankiel Code v0.2.0",
  html_url: "https://github.com/benank/ankielcode/releases/tag/v0.2.0",
  published_at: "2026-11-24T18:00:00Z",
  assets: [
    {
      name: "Ankiel-Code-0.2.0-arm64.dmg",
      browser_download_url:
        "https://github.com/benank/ankielcode/releases/download/v0.2.0/Ankiel-Code-0.2.0-arm64.dmg",
    },
    {
      name: "Ankiel-Code-0.2.0-arm64.dmg.blockmap",
      browser_download_url:
        "https://github.com/benank/ankielcode/releases/download/v0.2.0/Ankiel-Code-0.2.0-arm64.dmg.blockmap",
    },
    {
      name: "Ankiel-Code-0.2.0-arm64.zip",
      browser_download_url:
        "https://github.com/benank/ankielcode/releases/download/v0.2.0/Ankiel-Code-0.2.0-arm64.zip",
    },
    {
      name: "Ankiel-Code-0.2.0-x64.exe",
      browser_download_url:
        "https://github.com/benank/ankielcode/releases/download/v0.2.0/Ankiel-Code-0.2.0-x64.exe",
    },
    {
      name: "Ankiel-Code-0.2.0-x64.exe.blockmap",
      browser_download_url:
        "https://github.com/benank/ankielcode/releases/download/v0.2.0/Ankiel-Code-0.2.0-x64.exe.blockmap",
    },
    {
      name: "latest-mac.yml",
      browser_download_url:
        "https://github.com/benank/ankielcode/releases/download/v0.2.0/latest-mac.yml",
    },
    {
      name: "latest.yml",
      browser_download_url:
        "https://github.com/benank/ankielcode/releases/download/v0.2.0/latest.yml",
    },
    {
      name: "SHA256SUMS.txt",
      browser_download_url:
        "https://github.com/benank/ankielcode/releases/download/v0.2.0/SHA256SUMS.txt",
    },
  ],
};

function mockFetcher(payload: GitHubReleasePayload | null, status = 200): typeof fetch {
  return async () =>
    new Response(payload ? JSON.stringify(payload) : JSON.stringify({ message: "Not Found" }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("extractReleaseSummary", () => {
  it("extracts macOS arm64, Windows x64, and checksum URLs while ignoring blockmaps and yml", () => {
    const summary = extractReleaseSummary(SAMPLE_RELEASE);
    assert.equal(summary.tag, "v0.2.0");
    assert.equal(summary.version, "0.2.0");
    assert.equal(
      summary.downloads.macArm64Dmg,
      "https://github.com/benank/ankielcode/releases/download/v0.2.0/Ankiel-Code-0.2.0-arm64.dmg",
    );
    assert.equal(
      summary.downloads.macArm64Zip,
      "https://github.com/benank/ankielcode/releases/download/v0.2.0/Ankiel-Code-0.2.0-arm64.zip",
    );
    assert.equal(
      summary.downloads.winX64Exe,
      "https://github.com/benank/ankielcode/releases/download/v0.2.0/Ankiel-Code-0.2.0-x64.exe",
    );
    assert.equal(
      summary.downloads.checksums,
      "https://github.com/benank/ankielcode/releases/download/v0.2.0/SHA256SUMS.txt",
    );
    assert.equal(summary.downloads.macX64Dmg, null);
    assert.equal(summary.downloads.winArm64Exe, null);
  });

  it("matches pre-rebrand T3-Code-* artifact names identically", () => {
    const summary = extractReleaseSummary({
      tag_name: "v0.1.12",
      html_url: "https://github.com/benank/ankielcode/releases/tag/v0.1.12",
      assets: [
        {
          name: "T3-Code-0.1.12-arm64.dmg",
          browser_download_url: "https://example.test/T3-Code-0.1.12-arm64.dmg",
        },
        {
          name: "T3-Code-0.1.12-x64.exe",
          browser_download_url: "https://example.test/T3-Code-0.1.12-x64.exe",
        },
      ],
    });
    assert.equal(summary.downloads.macArm64Dmg, "https://example.test/T3-Code-0.1.12-arm64.dmg");
    assert.equal(summary.downloads.winX64Exe, "https://example.test/T3-Code-0.1.12-x64.exe");
  });
});

describe("code.ankiel.com Worker routes", () => {
  const env = { GITHUB_REPO: "benank/ankielcode" };

  it("serves the landing page with release version and download links", async () => {
    const res = await handleRequest(new Request("https://code.ankiel.com/"), env, {
      fetcher: mockFetcher(SAMPLE_RELEASE),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /v0\.2\.0/);
    assert.match(html, /href="\/download\/mac"/);
    assert.match(html, /href="\/download\/win"/);
    assert.match(html, /href="\/download\/checksums"/);
  });

  it("renders a graceful landing page before any release exists", async () => {
    const res = await handleRequest(new Request("https://code.ankiel.com/"), env, {
      fetcher: mockFetcher(null, 404),
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /First release coming soon/);
    assert.match(html, /https:\/\/github\.com\/benank\/ankielcode\/releases/);
  });

  it("redirects /download/mac and /download/win directly to GitHub release artifacts", async () => {
    const macRes = await handleRequest(new Request("https://code.ankiel.com/download/mac"), env, {
      fetcher: mockFetcher(SAMPLE_RELEASE),
    });
    assert.equal(macRes.status, 302);
    assert.equal(
      macRes.headers.get("location"),
      "https://github.com/benank/ankielcode/releases/download/v0.2.0/Ankiel-Code-0.2.0-arm64.dmg",
    );

    const winRes = await handleRequest(new Request("https://code.ankiel.com/download/win"), env, {
      fetcher: mockFetcher(SAMPLE_RELEASE),
    });
    assert.equal(winRes.status, 302);
    assert.equal(
      winRes.headers.get("location"),
      "https://github.com/benank/ankielcode/releases/download/v0.2.0/Ankiel-Code-0.2.0-x64.exe",
    );

    const zipRes = await handleRequest(
      new Request("https://code.ankiel.com/download/mac-zip"),
      env,
      { fetcher: mockFetcher(SAMPLE_RELEASE) },
    );
    assert.equal(zipRes.status, 302);
    assert.equal(
      zipRes.headers.get("location"),
      "https://github.com/benank/ankielcode/releases/download/v0.2.0/Ankiel-Code-0.2.0-arm64.zip",
    );
  });

  it("falls back to the GitHub releases page when no release or matching asset exists", async () => {
    const missingArch = await handleRequest(
      new Request("https://code.ankiel.com/download/mac-x64"),
      env,
      { fetcher: mockFetcher(SAMPLE_RELEASE) },
    );
    assert.equal(missingArch.status, 302);
    assert.equal(
      missingArch.headers.get("location"),
      "https://github.com/benank/ankielcode/releases/tag/v0.2.0",
    );

    const noRelease = await handleRequest(
      new Request("https://code.ankiel.com/download/mac"),
      env,
      { fetcher: mockFetcher(null, 404) },
    );
    assert.equal(noRelease.status, 302);
    assert.equal(
      noRelease.headers.get("location"),
      "https://github.com/benank/ankielcode/releases",
    );
  });

  it("serves /api/latest JSON with CORS and cache headers", async () => {
    const res = await handleRequest(new Request("https://code.ankiel.com/api/latest"), env, {
      fetcher: mockFetcher(SAMPLE_RELEASE),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const body = (await res.json()) as { version: string; downloads: { winX64Exe: string } };
    assert.equal(body.version, "0.2.0");
    assert.match(body.downloads.winX64Exe, /x64\.exe$/);
  });

  it("serves /health, /favicon.svg, /releases, 404, and 405", async () => {
    const health = await handleRequest(new Request("https://code.ankiel.com/health"), env);
    assert.equal(health.status, 200);

    const icon = await handleRequest(new Request("https://code.ankiel.com/favicon.svg"), env);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type") ?? "", /image\/svg\+xml/);

    const releases = await handleRequest(new Request("https://code.ankiel.com/releases"), env);
    assert.equal(releases.status, 302);
    assert.equal(releases.headers.get("location"), "https://github.com/benank/ankielcode/releases");

    const notFound = await handleRequest(new Request("https://code.ankiel.com/nope"), env);
    assert.equal(notFound.status, 404);

    const methodNotAllowed = await handleRequest(
      new Request("https://code.ankiel.com/", { method: "POST" }),
      env,
    );
    assert.equal(methodNotAllowed.status, 405);
  });
});
