# Self-Hosting Ankiel Relay on Cloudflare

Deploy your own anonymous, zero-sign-in Ankiel Code HTTP + WebSocket relay on your personal Cloudflare account in under 2 minutes.

- **Zero accounts / zero sign-in:** Each computer generates a persistent Ed25519 keypair (`hostId = base32(sha256(pubKey))[0..26]`).
- **One shared secret (`RELAY_SECRET`):** Set once on Cloudflare to keep strangers off your Worker quota; never sent in plaintext (verified via HMAC-SHA256 over the per-connection challenge nonce).
- **Zero external databases:** Single SQLite-backed Durable Object (`RelayRoom`, eligible on Cloudflare's Workers Free plan) with WebSocket Hibernation.
- **Works with or without a custom domain:**
  - **Custom domain wildcard:** `https://<hostId>.relay.ankiel.com/...`
  - **Free `*.workers.dev` path prefix:** `https://ankiel-relay.<you>.workers.dev/h/<hostId>/...`

---

## Option 1: Automated Deploys on Push (GitHub Actions — Recommended)

1. In Cloudflare Dashboard → **My Profile → API Tokens → Create Token** using the **Edit Cloudflare Workers** template.
2. In your GitHub repo → **Settings → Secrets and variables → Actions**, add:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
3. Push to `main` (or trigger **Deploy Ankiel Relay** manually in the Actions tab).
4. Set your one-time Worker secret (`RELAY_SECRET`) so only your computers can register tunnels:

```bash
cd relay
openssl rand -base64 32 | npx wrangler secret put RELAY_SECRET
```

Save the generated secret — you'll combine it with your Worker URL into one **Relay Setup String**:

```text
ankiel-relay://ankiel-relay.<you>.workers.dev#<YOUR_RELAY_SECRET>
```

*(Or with a wildcard custom domain: `ankiel-relay://relay.ankiel.com#<YOUR_RELAY_SECRET>`.)*

---

## Option 2: One-Prompt / Local Deploy (Manual)

```bash
cd relay
npm install
npx wrangler login
npx wrangler deploy
openssl rand -base64 32 | npx wrangler secret put RELAY_SECRET
```

---

## Connecting Your Computers & Phone

1. **On each computer (Desktop / CLI):**
   - Set `ANKIEL_RELAY_SETUP=ankiel-relay://<your-relay-host>#<YOUR_RELAY_SECRET>` (or paste it in Settings → Remote Relay).
   - The server connects outbound to your Cloudflare Worker and displays its **Pairing QR Code**.
2. **On your phone:**
   - Open Ankiel Code → **Add Computer → Scan QR Code** → scan each computer's screen.
   - Your phone pairs directly with each computer using one-time tokens + DPoP sessions.

---

## Verify Locally (No Cloudflare Deploy Required)

```bash
cd relay
npm test
# In another terminal:
npx wrangler dev --port 8789 --ip 127.0.0.1
# Run full HTTP + WS E2E test:
RELAY_URL=http://127.0.0.1:8789 node --experimental-strip-types test/relay-e2e.mjs
```

---

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Health check (`{ ok, service, version, requiresSecret, restrictedHosts }`) |
| `GET /relay/status/:hostId` | Reports `{ hostId, online, clients }` |
| `WSS /relay/host/:hostId` | Outbound host tunnel (Ed25519 + optional `RELAY_SECRET` HMAC) |
| `HTTPS/WSS https://<hostId>.<domain>/<path>` | Wildcard subdomain HTTP + WS reverse tunnel |
| `HTTPS/WSS https://<worker>/h/<hostId>/<path>` | Path-prefix HTTP + WS reverse tunnel (`*.workers.dev` friendly) |
