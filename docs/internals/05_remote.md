# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. Same-network (LAN)
access and the self-hosted Cloudflare Relay change how the client reaches the server; they do not
introduce a different execution model.

## Identity is independent of the route

- An environment keeps its ID across restarts and endpoint changes. Repository identity can
  correlate clones across environments (preferring `upstream` for PR features, grouping forks by
  `origin`), but work never silently crosses environments.
- [Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts) publishes
  atomically and retains repair state so concurrent initializers choose the same winner; do not
  sweep that recovery state as temp cleanup.
- **Routes are untrusted hints.** Only the connecting client can prove reachability. Never fall back
  to loopback when a shareable endpoint is unavailable (loopback names the client's own machine).
  Verify a direct or learned route answers as the expected environment before sending credentials.
  A saved environment can hold both a Cloudflare Relay HTTPS route and a learned same-network LAN
  route, switching between them transparently as the client moves on and off the host's network.
- Pull request routing trust covers the saved route set: adding or changing a route revokes trust;
  reordering does not.

## Desktop previews tunnel loopback

A desktop webview for a remote environment keeps `localhost` URLs and tunnels loopback connections
through `/api/preview/tunnel` on the environment's own origin:

- **Fixed SOCKS5 proxy, not PAC.** Chromium ignores PAC scripts for loopback hosts. Use a fixed
  proxy that routes only loopback through the tunnel (excluding link-local addresses) and never
  falls back directly—a failed or disabled tunnel must error rather than silently load the
  reviewer's own localhost.
- **Media tickets and local-owner check.** Desktop main holds no environment credentials, so the
  renderer supplies a media ticket per connection (also tracking route switches). Because Chromium
  cannot authenticate to SOCKS5 and a forwarded port is a plain local port, on Linux and macOS both
  listeners serve only connections the system attributes to the current OS user (`/proc/net/tcp`
  on Linux, `lsof` on macOS), and a connection whose owner cannot be read is refused. On Windows
  the listeners do not check the owner.

## Access and process ownership are separate

- The self-hosted [Cloudflare Relay](../../relay/SETUP_CLOUDFLARE.md) supplies a public HTTPS
  endpoint (either wildcard subdomain or `/h/<hostId>/` path-prefix) via an outbound host tunnel
  authenticated with Ed25519 + `RELAY_SECRET` HMAC; client auth remains the environment's
  responsibility.
- Remote servers outlive client releases. Clients negotiate features via advertised capabilities
  rather than assuming version parity. Process replacement uses the
  [update protocol](./07_server-updates.md).
