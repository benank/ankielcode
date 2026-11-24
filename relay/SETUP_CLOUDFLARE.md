# Self-Hosting Ankiel Relay on Cloudflare

Deploy your own anonymous, zero-sign-in Ankiel Code relay on your personal Cloudflare account in under 2 minutes.

- **Zero accounts / zero sign-in:** Host identity is an Ed25519 keypair (`hostId = base32(sha256(pubKey))[0..26]`).
- **Zero external databases:** Uses a single Cloudflare Durable Object class (`RelayRoom`, SQLite-backed, eligible on the Workers Free plan) with WebSocket Hibernation.
- **Private by default (optional):** Lock your Worker to your own machine(s) with `ALLOWED_HOST_IDS`.

---

## Option 1: One-Prompt / Local Deploy (Manual)

```bash
cd relay
npm install
npx wrangler login
npx wrangler deploy
```

Wrangler will print your live Worker URL, e.g.:
`https://ankiel-relay.<your-subdomain>.workers.dev`

### Lock the relay to your own host(s) (Recommended)

Once your local Ankiel Code server prints its 26-character `hostId`:

```bash
cd relay
npx wrangler secret put ALLOWED_HOST_IDS
# Paste one or more comma-separated hostIds, e.g.:
# abcd2345efgh6789ijkl2345mn
```

Any connection using a `hostId` not in `ALLOWED_HOST_IDS` is rejected at the edge with `403`.

---

## Option 2: Automated Deploys on Push (GitHub Actions — Recommended)

This repo includes [`.github/workflows/ankiel-relay-deploy.yml`](../.github/workflows/ankiel-relay-deploy.yml), which automatically tests and deploys `relay/` whenever changes are pushed to `main`.

1. In the Cloudflare Dashboard, create an API Token using the **Edit Cloudflare Workers** template.
2. In your GitHub repository -> **Settings -> Secrets and variables -> Actions**, add:
   - `CLOUDFLARE_API_TOKEN` — your API token
   - `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare Account ID
3. Push to `main` (or trigger **Deploy Ankiel Relay** manually from the Actions tab).

---

## Verify a Running Relay

Run the built-in end-to-end WebSocket verification against a local `wrangler dev` or your live Worker:

```bash
cd relay
# Against local wrangler dev:
RELAY_URL=http://127.0.0.1:8789 node --experimental-strip-types test/relay-e2e.mjs

# Against a live (unrestricted) Worker:
RELAY_URL=https://ankiel-relay.<your-subdomain>.workers.dev node --experimental-strip-types test/relay-e2e.mjs
```

---

## Protocol Summary

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Health check (`{ ok, service, version, restricted }`) |
| `GET /relay/status/:hostId` | Reports `{ hostId, online, clients }` |
| `WSS /relay/host/:hostId` | Outbound host tunnel (Ed25519 challenge-response) |
| `WSS /relay/client/:hostId` | Client tunnel (bridged to authenticated host; `503` if offline) |
