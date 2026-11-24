import type { APIRoute } from "astro";

import { buildAnkielProjectFileJsonSchema } from "@ankielcode/shared/ankielProjectFile";

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildAnkielProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
