import { releasesPageUrl, type ReleaseSummary } from "./releases.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed)
    .toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
    .toUpperCase();
}

// Matches ankiel.com/public/favicon.svg.
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#161615"/><path transform="translate(7.45 7) scale(.09) translate(-40 -40)" d="M122.2 40h25.6l3.63 8.84L72.87 240H40ZM122.2 40h25.6L230 240h-32.87L118.57 48.84Z" fill="#f2f2ee"/></svg>`;

// Geometric Ankiel wordmark from ankiel.com/src/components/Wordmark.tsx.
const ANKIEL_WORDMARK_SVG = `<svg viewBox="40 40 943.85 200" fill="currentColor" aria-hidden="true" focusable="false">
  <path d="M122.2 40h25.6l3.63 8.84L72.87 240H40ZM122.2 40h25.6L230 240h-32.87L118.57 48.84Z" />
  <path d="M255.78 40h32v200h-32ZM255.78 40h35.93l126.07 200h-35.94ZM385.78 40h32v200h-32Z" />
  <path d="M465.78 40h32v200h-32ZM573.59 40h41.19l-133 145.5v-45.05ZM523.55 94.75 619.78 240h-36.47l-80.9-122.12Z" />
  <path d="M645.44 40h32v200h-32Z" />
  <path d="M725.44 40h32v200h-32ZM725.44 40h116v28.16h-116ZM725.44 124.79h109.04v28.16H725.44ZM725.44 211.84h116V240h-116Z" />
  <path d="M875.85 40h32v200h-32ZM875.85 211.84h108V240h-108Z" />
</svg>`;

export function renderLandingPage(repo: string, release: ReleaseSummary | null): string {
  const repoUrl = `https://github.com/${repo}`;
  const allReleasesUrl = releasesPageUrl(repo);
  const relayGuideUrl = `${repoUrl}/blob/main/relay/SETUP_CLOUDFLARE.md`;
  const hasMac = Boolean(release?.downloads.macArm64Dmg);
  const hasWin = Boolean(release?.downloads.winX64Exe);
  const hasAnyDownload = hasMac || hasWin;
  const publishedDate = formatDate(release?.publishedAt ?? null);
  const releaseTagLabel = release
    ? `v${escapeHtml(release.version)}${publishedDate ? ` &middot; ${escapeHtml(publishedDate)}` : ""}`
    : "INITIAL BUILD IN PROGRESS";

  const macHref = hasMac ? "/download/mac" : allReleasesUrl;
  const winHref = hasWin ? "/download/win" : allReleasesUrl;
  const notesHref = release ? release.releaseUrl : allReleasesUrl;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#080808" />
  <title>ANKIEL CODE — Self-Hosted Agent Orchestration</title>
  <meta name="description" content="Self-hosted orchestration for all your coding agents. Syncs with your phone. Open source for macOS and Windows." />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    :root {
      color-scheme: dark;
      --paper: #080808;
      --surface: #0d0d0d;
      --ink: #f2f2ee;
      --muted: #8a8982;
      --faint: #55544f;
      --rule: rgba(242, 242, 238, 0.1);
      --rule-strong: rgba(242, 242, 238, 0.22);
      --ember: #d95d26;
      --amber: #e2964a;
      --steel: #3b7ea8;
      --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Inter", "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      min-height: 100%;
      background-color: var(--paper);
      color: var(--ink);
      font-family: var(--sans);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      overflow-x: hidden;
    }

    /* Subtle atmospheric burnt-horizon glow + micro halftone dot matrix */
    .atmosphere {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      overflow: hidden;
    }

    .atmosphere::before {
      content: "";
      position: absolute;
      inset: -12% -10% auto -10%;
      height: 520px;
      background:
        radial-gradient(58% 42% at 78% 10%, rgba(59, 126, 168, 0.22) 0%, rgba(59, 126, 168, 0.06) 45%, transparent 72%),
        radial-gradient(46% 24% at 68% 25%, rgba(217, 93, 38, 0.22) 0%, rgba(226, 150, 74, 0.08) 44%, transparent 76%),
        radial-gradient(38% 18% at 86% 32%, rgba(217, 68, 24, 0.14) 0%, transparent 70%);
      filter: blur(28px);
      transform: rotate(-7deg);
    }

    .atmosphere::after {
      content: "";
      position: absolute;
      inset: 0;
      background-image: radial-gradient(rgba(242, 242, 238, 0.065) 0.75px, transparent 0.75px);
      background-size: 4px 4px;
      mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.7) 0%, rgba(0, 0, 0, 0.22) 55%, rgba(0, 0, 0, 0.05) 100%);
      -webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.7) 0%, rgba(0, 0, 0, 0.22) 55%, rgba(0, 0, 0, 0.05) 100%);
    }

    a { color: inherit; text-decoration: none; }

    .frame {
      position: relative;
      z-index: 1;
      max-width: 960px;
      margin: 0 auto;
      padding: 28px 28px 64px;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding-bottom: 22px;
      border-bottom: 1px solid var(--rule);
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
    }

    .brand svg {
      height: 13px;
      width: auto;
      display: block;
    }

    .brand-tag {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--muted);
      padding-left: 12px;
      border-left: 1px solid var(--rule-strong);
      line-height: 1;
    }

    nav {
      display: flex;
      align-items: center;
      gap: 22px;
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
    }

    nav a { transition: color 0.16s ease; }
    nav a:hover { color: var(--ink); }

    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 76px 0 56px;
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      width: fit-content;
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 32px;
      transition: color 0.16s ease;
    }

    .eyebrow:hover { color: var(--ink); }

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--amber), var(--ember));
      box-shadow: 0 0 10px rgba(217, 93, 38, 0.75);
    }

    .lockup {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 18px 22px;
      margin: 0 0 28px;
    }

    .lockup svg {
      height: clamp(30px, 5.2vw, 52px);
      width: auto;
      display: block;
    }

    .lockup-sub {
      font-family: var(--mono);
      font-size: clamp(13px, 1.8vw, 17px);
      font-weight: 400;
      letter-spacing: 0.34em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .statement {
      margin: 0 0 42px;
      max-width: 560px;
      font-size: clamp(18px, 2.4vw, 22px);
      font-weight: 300;
      line-height: 1.5;
      letter-spacing: -0.015em;
      color: #d7d6d0;
    }

    .statement span {
      color: var(--muted);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      margin-bottom: 22px;
    }

    .btn {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 12px;
      padding: 13px 20px;
      font-family: var(--mono);
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      border: 1px solid var(--rule-strong);
      background: rgba(13, 13, 13, 0.82);
      color: var(--ink);
      transition: border-color 0.18s ease, background-color 0.18s ease, box-shadow 0.18s ease, color 0.18s ease;
    }

    .btn .arch {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.08em;
    }

    .btn:hover {
      border-color: rgba(226, 150, 74, 0.55);
      background: rgba(20, 19, 18, 0.94);
      box-shadow: 0 0 28px -8px rgba(217, 93, 38, 0.32);
    }

    .btn-primary {
      background: var(--ink);
      color: #0b0b0a;
      border-color: var(--ink);
      box-shadow: 0 0 32px -10px rgba(217, 93, 38, 0.45);
    }

    .btn-primary .arch {
      color: #54534e;
    }

    .btn-primary:hover {
      background: #ffffff;
      color: #080808;
      border-color: #ffffff;
      box-shadow: 0 0 38px -6px rgba(217, 93, 38, 0.58), 0 0 18px -6px rgba(59, 126, 168, 0.35);
    }

    .links-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 18px;
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--faint);
    }

    .links-row a {
      color: var(--muted);
      transition: color 0.16s ease;
    }

    .links-row a:hover { color: var(--ink); }

    .horizon-rule {
      height: 1px;
      width: 100%;
      margin: 64px 0 36px;
      background: linear-gradient(
        90deg,
        transparent 0%,
        var(--rule) 12%,
        rgba(59, 126, 168, 0.42) 52%,
        rgba(217, 93, 38, 0.48) 76%,
        var(--rule) 92%,
        transparent 100%
      );
    }

    .specs {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 32px 36px;
    }

    .spec-index {
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 10px;
    }

    .spec-index em {
      font-style: normal;
      color: var(--amber);
      margin-right: 6px;
    }

    .spec p {
      margin: 0;
      font-size: 14px;
      line-height: 1.65;
      color: var(--muted);
      font-weight: 300;
    }

    .spec strong {
      color: var(--ink);
      font-weight: 400;
    }

    .note {
      margin-top: 40px;
      padding: 14px 16px;
      border-left: 1px solid rgba(217, 93, 38, 0.55);
      background: rgba(242, 242, 238, 0.02);
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.7;
      color: var(--muted);
    }

    .note strong {
      color: var(--ink);
      font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .note code {
      color: #ebd0b5;
      background: rgba(242, 242, 238, 0.06);
      padding: 1px 5px;
    }

    footer {
      margin-top: auto;
      padding-top: 22px;
      border-top: 1px solid var(--rule);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--faint);
    }

    footer a {
      color: var(--muted);
      transition: color 0.16s ease;
    }

    footer a:hover { color: var(--ink); }

    @media (max-width: 720px) {
      .frame { padding: 22px 20px 44px; }
      header { flex-wrap: wrap; }
      nav { gap: 16px; }
      main { padding: 52px 0 40px; }
      .specs { grid-template-columns: 1fr; gap: 26px; }
      .btn { width: 100%; justify-content: space-between; }
    }
  </style>
</head>
<body>
  <div class="atmosphere" aria-hidden="true"></div>

  <div class="frame">
    <header>
      <a class="brand" href="/">
        ${ANKIEL_WORDMARK_SVG}
        <span class="brand-tag">Code</span>
      </a>
      <nav>
        <a href="${escapeHtml(allReleasesUrl)}">Releases</a>
        <a href="${escapeHtml(relayGuideUrl)}">Relay</a>
        <a href="${escapeHtml(repoUrl)}">GitHub</a>
        <a href="https://ankiel.com">Ankiel</a>
      </nav>
    </header>

    <main>
      <a class="eyebrow" href="${escapeHtml(notesHref)}">
        <span class="dot" aria-hidden="true"></span>
        <span>${releaseTagLabel}</span>
      </a>

      <h1 class="lockup">
        <span class="sr-only">Ankiel Code</span>
        ${ANKIEL_WORDMARK_SVG}
        <span class="lockup-sub">Code</span>
      </h1>

      <p class="statement">
        Self-hosted orchestration for all your coding agents.
        <span>Syncs with your phone. Runs locally on your machines.</span>
      </p>

      <div class="actions" id="download-buttons">
        <a class="btn btn-primary" id="btn-mac" href="${escapeHtml(macHref)}">
          <span>${hasMac ? "Download macOS" : "macOS Releases"}</span>
          <span class="arch">ARM64 &middot; .DMG</span>
        </a>
        <a class="btn" id="btn-win" href="${escapeHtml(winHref)}">
          <span>${hasWin ? "Download Windows" : "Windows Releases"}</span>
          <span class="arch">X64 &middot; .EXE</span>
        </a>
      </div>

      <div class="links-row">
        <a href="${escapeHtml(notesHref)}">${release ? `Release notes (${escapeHtml(release.tag)})` : "View GitHub Releases"}</a>
        ${release?.downloads.checksums ? '<span>/</span><a href="/download/checksums">SHA256SUMS.txt</a>' : ""}
        <span>/</span>
        <a href="${escapeHtml(repoUrl)}">Source on GitHub</a>
      </div>

      <div class="horizon-rule" aria-hidden="true"></div>

      <section class="specs" aria-label="Architecture">
        <div class="spec">
          <div class="spec-index"><em>01</em> Orchestrate</div>
          <p><strong>One terminal-grade desk for every agent.</strong> Drive Claude Code, Codex, Cursor, OpenCode, and more with your own subscriptions.</p>
        </div>
        <div class="spec">
          <div class="spec-index"><em>02</em> Phone Sync</div>
          <p><strong>Carry every workstation in your pocket.</strong> Pair your phone by QR over a self-hosted Cloudflare Durable Objects relay—no accounts or sign-in.</p>
        </div>
        <div class="spec">
          <div class="spec-index"><em>03</em> Self-Hosted</div>
          <p><strong>Zero telemetry, direct updates.</strong> Local state, cryptographic host keys, and automatic desktop updates straight from GitHub Releases.</p>
        </div>
      </section>

      ${
        hasAnyDownload
          ? `<div class="note">
        <strong>Unsigned preview:</strong>
        macOS — System Settings &rarr; Privacy &amp; Security &rarr; Open Anyway (or <code>xattr -cr "/Applications/Ankiel Code.app"</code>).
        Windows — More info &rarr; Run anyway.
      </div>`
          : `<div class="note">
        <strong>First release coming soon:</strong>
        Installers for macOS (Apple Silicon) and Windows (x64) link here automatically once the first GitHub Release is published.
      </div>`
      }
    </main>

    <footer>
      <span>ANKIEL CODE &middot; MIT</span>
      <span><a href="${escapeHtml(repoUrl)}">${escapeHtml(repo)}</a> &middot; <a href="https://ankiel.com">ankiel.com</a></span>
    </footer>
  </div>

  <script>
    (function () {
      var ua = navigator.userAgent || "";
      var isWin = /Windows/i.test(ua);
      var macBtn = document.getElementById("btn-mac");
      var winBtn = document.getElementById("btn-win");
      var container = document.getElementById("download-buttons");
      if (isWin && macBtn && winBtn && container) {
        macBtn.classList.remove("btn-primary");
        winBtn.classList.add("btn-primary");
        container.insertBefore(winBtn, macBtn);
      }
    })();
  </script>
</body>
</html>`;
}
