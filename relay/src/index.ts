import { isValidHostId, parseAllowedHostIds } from "./crypto.ts";
import { RelayRoom, type RelayEnv } from "./relay-room.ts";

export { RelayRoom };

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonError(error: string, status: number): Response {
  return withCors(Response.json({ error }, { status }));
}

function extractSubdomainHostId(hostname: string): string | null {
  const labels = hostname.toLowerCase().split(".");
  if (labels.length < 3) return null;
  const candidate = labels[0];
  return candidate && isValidHostId(candidate) ? candidate : null;
}

function extractPathPrefixTunnel(
  pathname: string,
): { readonly hostId: string; readonly innerPath: string } | null {
  const match = /^\/h\/([a-z2-7]{26})(\/.*)?$/.exec(pathname);
  if (!match) return null;
  return {
    hostId: match[1]!,
    innerPath: match[2] || "/",
  };
}

function isRelayConfigured(env: RelayEnv): boolean {
  return (
    Boolean(env.RELAY_SECRET?.trim()) ||
    parseAllowedHostIds(env.ALLOWED_HOST_IDS) !== null ||
    env.ALLOW_PUBLIC_RELAY?.trim().toLowerCase() === "true"
  );
}

function checkRelayAccess(env: RelayEnv, hostId: string): Response | null {
  if (!isRelayConfigured(env)) {
    return withCors(
      Response.json(
        {
          error: "relay_not_configured",
          message: "This relay is locked until RELAY_SECRET (or ALLOWED_HOST_IDS) is configured.",
        },
        { status: 503 },
      ),
    );
  }
  const allowlist = parseAllowedHostIds(env.ALLOWED_HOST_IDS);
  if (allowlist && !allowlist.has(hostId)) {
    return jsonError("host_not_allowed", 403);
  }
  return null;
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const url = new URL(request.url);

    // 1. Subdomain reverse tunnel: https://<hostId>.relay.example.com/<path>
    const subdomainHostId = extractSubdomainHostId(url.hostname);
    if (subdomainHostId) {
      const denied = checkRelayAccess(env, subdomainHostId);
      if (denied) return denied;
      const stub = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(subdomainHostId));
      const internalUrl = new URL("https://relay-room/tunnel");
      internalUrl.searchParams.set("hostId", subdomainHostId);
      internalUrl.searchParams.set("path", `${url.pathname}${url.search}`);
      return stub.fetch(new Request(internalUrl.toString(), request));
    }

    // 2. Path-prefix reverse tunnel (free *.workers.dev friendly): https://<worker>/h/<hostId>/<path>
    const pathPrefix = extractPathPrefixTunnel(url.pathname);
    if (pathPrefix) {
      const denied = checkRelayAccess(env, pathPrefix.hostId);
      if (denied) return denied;
      const stub = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(pathPrefix.hostId));
      const internalUrl = new URL("https://relay-room/tunnel");
      internalUrl.searchParams.set("hostId", pathPrefix.hostId);
      internalUrl.searchParams.set("path", `${pathPrefix.innerPath}${url.search}`);
      return stub.fetch(new Request(internalUrl.toString(), request));
    }

    // 3. Control endpoints (health, host tunnel registration, direct client WS, status)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return withCors(
        Response.json({
          ok: true,
          service: "ankiel-relay",
          version: "0.2.0",
          configured: isRelayConfigured(env),
          requiresSecret: Boolean(env.RELAY_SECRET?.trim()),
          restrictedHosts: parseAllowedHostIds(env.ALLOWED_HOST_IDS) !== null,
        }),
      );
    }

    const match = /^\/relay\/(host|client|status)\/([a-z2-7]+)$/.exec(url.pathname);
    if (!match) {
      return jsonError("not_found", 404);
    }

    const route = match[1] as "host" | "client" | "status";
    const hostId = match[2]!;
    if (!isValidHostId(hostId)) {
      return jsonError("invalid_host_id", 400);
    }

    const denied = checkRelayAccess(env, hostId);
    if (denied) return denied;

    const stub = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(hostId));
    const internalUrl = new URL(`https://relay-room/${route}`);
    internalUrl.searchParams.set("hostId", hostId);

    const response = await stub.fetch(new Request(internalUrl.toString(), request));
    return route === "status" ? withCors(response) : response;
  },
} satisfies ExportedHandler<RelayEnv>;
