import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { handleRequest } from "../src/index.ts";
import { extractReleaseSummary, type GitHubReleasePayload } from "../src/releases.ts";

const { describe, it } = NodeTest;
const assert = NodeAssert;

const SITE_DIR = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = NodePath.join(SITE_DIR, "public");

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

describe("static site & SEO assets", () => {
  it("ships static HTML, OG preview, icons, robots, sitemap, llms.txt, and headers", () => {
    for (const file of [
      "index.html",
      "og.png",
      "favicon.svg",
      "apple-touch-icon.png",
      "robots.txt",
      "sitemap.xml",
      "llms.txt",
      "_headers",
    ]) {
      const fullPath = NodePath.join(PUBLIC_DIR, file);
      assert.ok(NodeFS.existsSync(fullPath), `Expected static asset ${file} to exist`);
      assert.ok(
        NodeFS.statSync(fullPath).size > 0,
        `Expected static asset ${file} to be non-empty`,
      );
    }

    const html = NodeFS.readFileSync(NodePath.join(PUBLIC_DIR, "index.html"), "utf8");
    assert.match(html, /<link rel="canonical" href="https:\/\/code\.ankiel\.com\/" \/>/);
    assert.match(html, /property="og:image" content="https:\/\/code\.ankiel\.com\/og\.png"/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.match(html, /application\/ld\+json/);
    assert.match(html, /All your agents<br\s*\/>in one spot\./);
    assert.match(html, />Download for macOS<\/a\s*>/);
    assert.match(html, />Download for Windows<\/a\s*>/);
    assert.match(html, />GitHub<\/a\s*>/);
    assert.equal((html.match(/target="_blank"/g) ?? []).length, 3);
    assert.doesNotMatch(html, /Ankiel\s*\|/i);
    assert.doesNotMatch(html, /SHA256SUMS/i);
  });
});

describe("code.ankiel.com Worker routes", () => {
  const env = { GITHUB_REPO: "benank/ankielcode" };

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

  it("serves /health, /releases, 404, and 405", async () => {
    const health = await handleRequest(new Request("https://code.ankiel.com/health"), env);
    assert.equal(health.status, 200);

    const releases = await handleRequest(new Request("https://code.ankiel.com/releases"), env);
    assert.equal(releases.status, 302);
    assert.equal(releases.headers.get("location"), "https://github.com/benank/ankielcode/releases");

    const notFound = await handleRequest(new Request("https://code.ankiel.com/nope"), env);
    assert.equal(notFound.status, 404);

    const methodNotAllowed = await handleRequest(
      new Request("https://code.ankiel.com/download/mac", { method: "POST" }),
      env,
    );
    assert.equal(methodNotAllowed.status, 405);
  });
});
