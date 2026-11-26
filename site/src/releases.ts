export interface GitHubReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size?: number;
}

export interface GitHubReleasePayload {
  readonly tag_name: string;
  readonly name?: string | null;
  readonly html_url: string;
  readonly published_at?: string | null;
  readonly assets?: ReadonlyArray<GitHubReleaseAsset>;
}

export interface ReleaseDownloads {
  readonly macArm64Dmg: string | null;
  readonly macArm64Zip: string | null;
  readonly macX64Dmg: string | null;
  readonly winX64Exe: string | null;
  readonly winArm64Exe: string | null;
  readonly checksums: string | null;
}

export interface ReleaseSummary {
  readonly tag: string;
  readonly version: string;
  readonly name: string;
  readonly publishedAt: string | null;
  readonly releaseUrl: string;
  readonly downloads: ReleaseDownloads;
}

export interface FetchReleaseOptions {
  readonly repo: string;
  readonly fetcher?: typeof fetch;
  readonly githubToken?: string;
}

const RELEASE_CACHE_TTL_SECONDS = 300;

function normalizeName(name: string): string {
  return name.toLowerCase();
}

function isBlockmapOrMetadata(lowerName: string): boolean {
  return (
    lowerName.endsWith(".blockmap") || lowerName.endsWith(".yml") || lowerName.endsWith(".yaml")
  );
}

function findAssetUrl(
  assets: ReadonlyArray<GitHubReleaseAsset>,
  predicate: (lowerName: string) => boolean,
): string | null {
  for (const asset of assets) {
    const lower = normalizeName(asset.name);
    if (isBlockmapOrMetadata(lower)) continue;
    if (predicate(lower)) {
      return asset.browser_download_url;
    }
  }
  return null;
}

export function extractReleaseSummary(payload: GitHubReleasePayload): ReleaseSummary {
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const version = payload.tag_name.replace(/^v/i, "");

  const macArm64Dmg =
    findAssetUrl(assets, (n) => n.endsWith(".dmg") && n.includes("arm64")) ??
    findAssetUrl(assets, (n) => n.endsWith(".dmg") && !n.includes("x64") && !n.includes("intel"));

  const macArm64Zip =
    findAssetUrl(assets, (n) => n.endsWith(".zip") && n.includes("arm64") && !n.includes("win")) ??
    findAssetUrl(
      assets,
      (n) => n.endsWith(".zip") && !n.includes("x64") && !n.includes("win") && !n.includes("linux"),
    );

  const macX64Dmg = findAssetUrl(
    assets,
    (n) => n.endsWith(".dmg") && (n.includes("x64") || n.includes("intel")),
  );

  const winX64Exe =
    findAssetUrl(assets, (n) => n.endsWith(".exe") && n.includes("x64")) ??
    findAssetUrl(assets, (n) => n.endsWith(".exe") && !n.includes("arm64"));

  const winArm64Exe = findAssetUrl(assets, (n) => n.endsWith(".exe") && n.includes("arm64"));

  // SHA256SUMS.txt covers every download; SHA256SUMS covers only the CLI archives.
  const checksums =
    findAssetUrl(assets, (n) => n === "sha256sums.txt") ??
    findAssetUrl(assets, (n) => n === "sha256sums");

  return {
    tag: payload.tag_name,
    version,
    name: payload.name?.trim() || `Ankiel Code ${payload.tag_name}`,
    publishedAt: payload.published_at ?? null,
    releaseUrl: payload.html_url,
    downloads: {
      macArm64Dmg,
      macArm64Zip,
      macX64Dmg,
      winX64Exe,
      winArm64Exe,
      checksums,
    },
  };
}

export function releasesPageUrl(repo: string): string {
  return `https://github.com/${repo}/releases`;
}

export async function fetchLatestRelease(
  options: FetchReleaseOptions,
): Promise<ReleaseSummary | null> {
  const fetcher = options.fetcher ?? fetch;
  const apiUrl = `https://api.github.com/repos/${options.repo}/releases/latest`;
  const cacheKey = new Request(apiUrl, { method: "GET" });

  const defaultCache =
    typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;

  if (defaultCache && !options.fetcher) {
    const cached = await defaultCache.match(cacheKey);
    if (cached) {
      return (await cached.json()) as ReleaseSummary;
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ankiel-code-site",
  };
  if (options.githubToken) {
    headers.Authorization = `Bearer ${options.githubToken}`;
  }

  const response = await fetcher(apiUrl, { headers });
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as GitHubReleasePayload;
  if (!payload?.tag_name || !payload?.html_url) {
    return null;
  }

  const summary = extractReleaseSummary(payload);

  if (defaultCache && !options.fetcher) {
    const toCache = new Response(JSON.stringify(summary), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${RELEASE_CACHE_TTL_SECONDS}`,
      },
    });
    await defaultCache.put(cacheKey, toCache);
  }

  return summary;
}
