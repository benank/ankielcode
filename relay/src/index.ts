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

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return withCors(
        Response.json({
          ok: true,
          service: "ankiel-relay",
          version: "0.1.0",
          restricted: parseAllowedHostIds(env.ALLOWED_HOST_IDS) !== null,
        }),
      );
    }

    const match = /^\/relay\/(host|client|status)\/([a-z2-7]+)$/.exec(url.pathname);
    if (!match) {
      return jsonError("not_found", 404);
    }

    const [, route, hostId] = match as [string, "host" | "client" | "status", string];
    if (!isValidHostId(hostId)) {
      return jsonError("invalid_host_id", 400);
    }

    const allowlist = parseAllowedHostIds(env.ALLOWED_HOST_IDS);
    if (allowlist && !allowlist.has(hostId)) {
      return jsonError("host_not_allowed", 403);
    }

    const stub = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(hostId));
    const internalUrl = new URL(`https://relay-room/${route}`);
    internalUrl.searchParams.set("hostId", hostId);

    const response = await stub.fetch(new Request(internalUrl.toString(), request));
    return route === "status" ? withCors(response) : response;
  },
} satisfies ExportedHandler<RelayEnv>;
