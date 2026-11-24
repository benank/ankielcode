import { describe, expect, it } from "vite-plus/test";

import { environmentEndpointUrl } from "./endpoint.ts";

describe("environmentEndpointUrl", () => {
  it("resolves root-hosted origins normally", () => {
    expect(environmentEndpointUrl("https://host.example.com/", "/oauth/token")).toBe(
      "https://host.example.com/oauth/token",
    );
    expect(environmentEndpointUrl("https://host.example.com/some/page", "/api/auth/session")).toBe(
      "https://host.example.com/api/auth/session",
    );
  });

  it("preserves /h/<hostId>/ relay path prefixes", () => {
    const hostId = "abcdefghijklmnopqrstuvwxyz";
    expect(
      environmentEndpointUrl(`https://ankiel-relay.me.workers.dev/h/${hostId}/`, "/oauth/token"),
    ).toBe(`https://ankiel-relay.me.workers.dev/h/${hostId}/oauth/token`);
    expect(
      environmentEndpointUrl(
        `https://ankiel-relay.me.workers.dev/h/${hostId}`,
        "/api/auth/websocket-ticket/rpc",
      ),
    ).toBe(`https://ankiel-relay.me.workers.dev/h/${hostId}/api/auth/websocket-ticket/rpc`);
  });
});
