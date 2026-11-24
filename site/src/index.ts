import { fetchLatestRelease, releasesPageUrl, type ReleaseSummary } from "./releases.ts";

export interface Env {
  readonly GITHUB_REPO?: string;
  readonly GITHUB_TOKEN?: string;
}

export interface HandleRequestOptions {
  readonly fetcher?: typeof fetch;
}

const DEFAULT_REPO = "benank/ankielcode";

function redirect(location: string, status: 302 | 301 = 302): Response {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      "Cache-Control": "public, max-age=120",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

function resolveDownloadTarget(pathname: string, release: ReleaseSummary | null): string | null {
  if (!release) return null;
  switch (pathname) {
    case "/download/mac":
    case "/download/mac-arm64":
      return release.downloads.macArm64Dmg;
    case "/download/mac-zip":
    case "/download/mac-arm64-zip":
      return release.downloads.macArm64Zip;
    case "/download/mac-x64":
      return release.downloads.macX64Dmg;
    case "/download/win":
    case "/download/win-x64":
      return release.downloads.winX64Exe;
    case "/download/win-arm64":
      return release.downloads.winArm64Exe;
    case "/download/checksums":
      return release.downloads.checksums;
    default:
      return null;
  }
}

const DOWNLOAD_ROUTES = new Set([
  "/download/mac",
  "/download/mac-arm64",
  "/download/mac-zip",
  "/download/mac-arm64-zip",
  "/download/mac-x64",
  "/download/win",
  "/download/win-x64",
  "/download/win-arm64",
  "/download/checksums",
]);

export async function handleRequest(
  request: Request,
  env: Env,
  options: HandleRequestOptions = {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const repo = env.GITHUB_REPO?.trim() || DEFAULT_REPO;

  if (pathname === "/health") {
    return Response.json({ ok: true, repo });
  }

  if (pathname === "/releases") {
    return redirect(releasesPageUrl(repo));
  }

  if (pathname === "/api/latest") {
    const release = await fetchLatestRelease({
      repo,
      fetcher: options.fetcher,
      githubToken: env.GITHUB_TOKEN,
    });
    if (!release) {
      return Response.json(
        { error: "no_release", releasesUrl: releasesPageUrl(repo) },
        {
          status: 404,
          headers: {
            "Cache-Control": "public, max-age=60",
            "Access-Control-Allow-Origin": "*",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }
    return Response.json(release, {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (DOWNLOAD_ROUTES.has(pathname)) {
    const release = await fetchLatestRelease({
      repo,
      fetcher: options.fetcher,
      githubToken: env.GITHUB_TOKEN,
    });
    const target = resolveDownloadTarget(pathname, release);
    return redirect(target ?? release?.releaseUrl ?? releasesPageUrl(repo));
  }

  return new Response("Not Found", { status: 404 });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
