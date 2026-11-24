import { releasesPageUrl, type ReleaseSummary } from "./releases.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

  const macHref = hasMac ? "/download/mac" : allReleasesUrl;
  const winHref = hasWin ? "/download/win" : allReleasesUrl;
  const notesHref = release ? release.releaseUrl : allReleasesUrl;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#030508" />
  <title>ANKIEL CODE — All your agents in one spot.</title>
  <meta name="description" content="Use Claude Code, Codex, and every other coding harness in a single interface. Free and open source with self hosted sync for your phone." />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #030508;
      --ink: #f5f8fc;
      --muted: rgba(226, 236, 248, 0.58);
      --faint: rgba(226, 236, 248, 0.34);
      --rule: rgba(226, 236, 248, 0.1);
      --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: "Helvetica Neue", -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--sans);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      overflow-x: hidden;
    }

    a { color: inherit; text-decoration: none; }

    .hero {
      position: relative;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 34px 56px 56px;
      overflow: hidden;
      background: var(--bg);
    }

    canvas#canopy {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 0;
    }

    /* Soft atmospheric fade dissolving the burnt canopy cleanly into obsidian */
    .hero::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(
        180deg,
        rgba(3, 5, 8, 0) 0%,
        rgba(3, 5, 8, 0) 46%,
        rgba(3, 5, 8, 0.84) 76%,
        var(--bg) 100%
      );
      pointer-events: none;
      z-index: 1;
    }

    .brand-bar {
      position: relative;
      z-index: 3;
      display: flex;
      align-items: center;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 12px;
    }

    .brand svg {
      height: 12px;
      width: auto;
      display: block;
      color: #ffffff;
    }

    .brand span {
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.28em;
      text-transform: uppercase;
      color: rgba(235, 246, 255, 0.72);
      padding-left: 12px;
      border-left: 1px solid rgba(255, 255, 255, 0.22);
      line-height: 1;
    }

    .hero-bottom {
      position: relative;
      z-index: 3;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 56px;
      margin-top: auto;
      padding-top: 240px;
    }

    .hero-left {
      max-width: 640px;
    }

    h1 {
      margin: 0 0 22px;
      font-size: clamp(44px, 5.2vw, 68px);
      font-weight: 400;
      line-height: 1.02;
      letter-spacing: -0.042em;
      color: #f7faff;
    }

    .sub {
      margin: 0;
      max-width: 560px;
      font-size: clamp(16px, 1.55vw, 19px);
      font-weight: 300;
      line-height: 1.55;
      letter-spacing: -0.01em;
      color: var(--muted);
    }

    .download-col {
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: 310px;
      flex-shrink: 0;
    }

    .btn-glass {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      width: 100%;
      padding: 14px 20px;
      background: rgba(242, 248, 255, 0.06);
      border: 1px solid rgba(220, 240, 255, 0.16);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      color: #f6faff;
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.01em;
      transition: background 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
    }

    .btn-glass:hover {
      background: rgba(242, 248, 255, 0.12);
      border-color: rgba(145, 232, 255, 0.48);
      box-shadow: 0 0 30px -6px rgba(56, 214, 255, 0.35);
    }

    .btn-glass.primary {
      background: #f6faff;
      color: #04070d;
      border-color: #f6faff;
      box-shadow: 0 0 38px -8px rgba(86, 220, 255, 0.52);
    }

    .btn-glass.primary:hover {
      background: #ffffff;
      border-color: #ffffff;
      box-shadow: 0 0 44px -6px rgba(112, 232, 255, 0.68);
    }

    .btn-glass .tag {
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      opacity: 0.58;
    }

    .dl-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 2px 0;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--faint);
    }

    .dl-meta a {
      color: var(--muted);
      transition: color 0.15s ease;
    }

    .dl-meta a:hover { color: #ffffff; }

    /* Ultra-dark lower section */
    .below {
      background: var(--bg);
      padding: 72px 56px 56px;
      border-top: 1px solid var(--rule);
    }

    .below-inner {
      max-width: 1328px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 48px;
    }

    .col-kicker {
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: #62d8f8;
      margin-bottom: 12px;
    }

    .col-text {
      margin: 0;
      font-size: 15px;
      line-height: 1.65;
      font-weight: 300;
      color: var(--muted);
    }

    .col-text strong {
      color: var(--ink);
      font-weight: 400;
    }

    .note {
      max-width: 1328px;
      margin: 48px auto 0;
      padding-top: 24px;
      border-top: 1px solid var(--rule);
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.7;
      color: var(--faint);
    }

    .note strong {
      color: var(--muted);
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .note code {
      color: #b7efff;
      background: rgba(242, 248, 255, 0.06);
      padding: 1px 6px;
    }

    footer {
      background: var(--bg);
      padding: 24px 56px 36px;
      border-top: 1px solid var(--rule);
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 12px;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--faint);
    }

    footer a {
      color: var(--muted);
      transition: color 0.15s ease;
    }

    footer a:hover { color: #ffffff; }

    @media (max-width: 900px) {
      .hero { padding: 26px 24px 44px; }
      .hero-bottom {
        flex-direction: column;
        align-items: stretch;
        gap: 36px;
        padding-top: 180px;
      }
      .download-col { width: 100%; max-width: 380px; }
      .below { padding: 52px 24px 44px; }
      .below-inner { grid-template-columns: 1fr; gap: 32px; }
      footer { padding: 20px 24px 32px; }
    }
  </style>
</head>
<body>
  <section class="hero">
    <canvas id="canopy" aria-hidden="true"></canvas>

    <div class="brand-bar">
      <a class="brand" href="/">
        ${ANKIEL_WORDMARK_SVG}
        <span>Code</span>
      </a>
    </div>

    <div class="hero-bottom">
      <div class="hero-left">
        <h1>All your agents<br/>in one spot.</h1>
        <p class="sub">Use Claude Code, Codex, and every other coding harness in a single interface. Free and open source with self hosted sync for your phone.</p>
      </div>

      <div class="download-col" id="download-buttons">
        <a class="btn-glass primary" id="btn-mac" href="${escapeHtml(macHref)}">
          <span>${hasMac ? "Download for macOS" : "macOS Releases"}</span>
          <span class="tag">ARM64 &middot; .DMG</span>
        </a>
        <a class="btn-glass" id="btn-win" href="${escapeHtml(winHref)}">
          <span>${hasWin ? "Download for Windows" : "Windows Releases"}</span>
          <span class="tag">X64 &middot; .EXE</span>
        </a>
        <a class="btn-glass" href="${escapeHtml(repoUrl)}">
          <span>GitHub</span>
          <span class="tag">SOURCE &rarr;</span>
        </a>
        <div class="dl-meta">
          <a href="${escapeHtml(notesHref)}">${release ? `v${escapeHtml(release.version)} notes` : "Releases"}</a>
          ${release?.downloads.checksums ? '<a href="/download/checksums">SHA256SUMS</a>' : `<a href="${escapeHtml(relayGuideUrl)}">Self-host relay</a>`}
        </div>
      </div>
    </div>
  </section>

  <section class="below">
    <div class="below-inner">
      <div>
        <div class="col-kicker">01 &mdash; Orchestrate</div>
        <p class="col-text"><strong>Every harness, one desk.</strong> Run Claude Code, Codex, Cursor, and OpenCode locally on your existing subscriptions.</p>
      </div>
      <div>
        <div class="col-kicker">02 &mdash; Phone Sync</div>
        <p class="col-text"><strong>Control from anywhere.</strong> Pair your phone by QR over a self-hosted <a href="${escapeHtml(relayGuideUrl)}" style="text-decoration:underline;text-underline-offset:3px;">Cloudflare relay</a> with zero accounts.</p>
      </div>
      <div>
        <div class="col-kicker">03 &mdash; Sovereign</div>
        <p class="col-text"><strong>Zero telemetry, direct updates.</strong> Local state on your machine with automatic updates straight from GitHub Releases.</p>
      </div>
    </div>

    ${
      hasAnyDownload
        ? `<div class="note">
      <strong>Unsigned preview:</strong>
      macOS &mdash; System Settings &rarr; Privacy &amp; Security &rarr; Open Anyway (or <code>xattr -cr "/Applications/Ankiel Code.app"</code>).
      Windows &mdash; More info &rarr; Run anyway.
    </div>`
        : `<div class="note">
      <strong>First release coming soon:</strong>
      Direct installers for macOS (Apple Silicon) and Windows (x64) appear here automatically once the first GitHub Release is published.
    </div>`
    }
  </section>

  <footer>
    <span>ANKIEL CODE &middot; MIT</span>
    <span><a href="${escapeHtml(allReleasesUrl)}">Releases</a> &middot; <a href="${escapeHtml(repoUrl)}">${escapeHtml(repo)}</a> &middot; <a href="https://ankiel.com">ankiel.com</a></span>
  </footer>

  <script>
    (function () {
      var ua = navigator.userAgent || "";
      if (/Windows/i.test(ua)) {
        var macBtn = document.getElementById("btn-mac");
        var winBtn = document.getElementById("btn-win");
        var container = document.getElementById("download-buttons");
        if (macBtn && winBtn && container) {
          macBtn.classList.remove("primary");
          winBtn.classList.add("primary");
          container.insertBefore(winBtn, macBtn);
        }
      }

      var canvas = document.getElementById("canopy");
      if (!canvas || !canvas.getContext) return;
      var ctx = canvas.getContext("2d");

      function hash(x, y) {
        var n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        return n - Math.floor(n);
      }

      function renderCanopy() {
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var w = canvas.clientWidth;
        var h = canvas.clientHeight;
        if (!w || !h) return;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.fillStyle = "#030508";
        ctx.fillRect(0, 0, w, h);

        // 1. Parabolic burnt white -> glacier cyan -> deep sapphire canopy
        var deep = ctx.createRadialGradient(w * 0.5, -h * 0.18, h * 0.05, w * 0.5, h * 0.02, w * 0.68);
        deep.addColorStop(0.0, "rgba(255, 255, 255, 0.96)");
        deep.addColorStop(0.16, "rgba(195, 248, 255, 0.92)");
        deep.addColorStop(0.32, "rgba(42, 206, 245, 0.78)");
        deep.addColorStop(0.54, "rgba(16, 86, 204, 0.52)");
        deep.addColorStop(0.76, "rgba(6, 22, 72, 0.24)");
        deep.addColorStop(1.0, "rgba(3, 5, 8, 0)");
        ctx.fillStyle = deep;
        ctx.fillRect(0, 0, w, h);

        // 2. Asymmetric burnt white-hot crown highlight
        var flare = ctx.createRadialGradient(w * 0.62, h * 0.04, 10, w * 0.56, h * 0.08, w * 0.42);
        flare.addColorStop(0.0, "rgba(255, 255, 255, 0.92)");
        flare.addColorStop(0.24, "rgba(130, 242, 255, 0.55)");
        flare.addColorStop(0.58, "rgba(14, 114, 224, 0.22)");
        flare.addColorStop(1.0, "rgba(3, 5, 8, 0)");
        ctx.fillStyle = flare;
        ctx.fillRect(0, 0, w, h);

        // 3. Secondary deep cobalt left wing
        var leftWing = ctx.createRadialGradient(w * 0.22, h * 0.14, 10, w * 0.24, h * 0.18, w * 0.45);
        leftWing.addColorStop(0.0, "rgba(32, 182, 236, 0.48)");
        leftWing.addColorStop(0.45, "rgba(12, 58, 168, 0.34)");
        leftWing.addColorStop(1.0, "rgba(3, 5, 8, 0)");
        ctx.fillStyle = leftWing;
        ctx.fillRect(0, 0, w, h);

        // 4. Static ASCII/glyph dither modulated by luminance
        var cellW = 10;
        var cellH = 14;
        var glyphs = [" ", ".", ":", "+", "x", "0", "8", "#", "A", "N", "K"];
        ctx.font = '500 10px ui-monospace, "SF Mono", Menlo, monospace';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        for (var y = 8; y < h * 0.72; y += cellH) {
          for (var x = 6; x < w; x += cellW) {
            var nx = (x - w * 0.5) / (w * 0.54);
            var ny = (y + h * 0.08) / (h * 0.64);
            var dist = Math.sqrt(nx * nx * 0.82 + ny * ny * 1.18);
            var baseLum = Math.max(0, 1 - dist);
            if (baseLum <= 0.04) continue;

            var lum = Math.max(0, Math.min(1, baseLum + (hash(x, y) - 0.5) * 0.24));
            if (lum < 0.08) continue;

            var ch = glyphs[Math.min(glyphs.length - 1, Math.floor(lum * glyphs.length))];
            if (ch === " ") continue;

            var alpha = Math.min(0.42, lum * 0.44);
            ctx.fillStyle = lum > 0.72
              ? "rgba(255, 255, 255, " + alpha + ")"
              : lum > 0.42
                ? "rgba(170, 244, 255, " + alpha + ")"
                : "rgba(82, 168, 255, " + (alpha * 0.85) + ")";
            ctx.fillText(ch, x, y);
          }
        }
      }

      renderCanopy();
      var resizeTimer = 0;
      window.addEventListener("resize", function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(renderCanopy, 120);
      });
    })();
  </script>
</body>
</html>`;
}
