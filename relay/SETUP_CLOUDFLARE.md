# Self-Hosting Ankiel Relay on Cloudflare

Deploy your own anonymous, zero-sign-in Ankiel Code HTTP + WebSocket relay on your personal Cloudflare account in under 2 minutes.

- **Fail-closed by default:** Refuses all traffic (`503 relay_not_configured`) until `RELAY_SECRET` (or `ALLOWED_HOST_IDS`) is configured.
- **Zero accounts / zero sign-in:** Each computer generates a persistent Ed25519 keypair (`hostId = base32(sha256(pubKey))[0..26]`).
- **One shared secret (`RELAY_SECRET`):** Set once on Cloudflare; never sent in plaintext (verified via constant-time `HMAC-SHA256` over a per-connection 32-byte nonce, with failed-auth rate limiting).
- **Zero external databases:** Single SQLite-backed Durable Object (`RelayRoom`, eligible on Cloudflare's Workers Free plan) with WebSocket Hibernation.
- **Works with or without a custom domain:**
  - **Custom domain wildcard:** `https://<hostId>.relay.ankiel.com/...`
  - **Free `*.workers.dev` path prefix:** `https://ankiel-relay.<you>.workers.dev/h/<hostId>/...`

---

## Option 1: One-Command Setup Script (Easiest)

```bash
cd relay
npm install
npm run setup
```

`npm run setup` handles everything automatically:

1. Logs into Cloudflare via `wrangler login` (if needed).
2. Deploys the Worker + Durable Object (`wrangler deploy`).
3. Generates a 256-bit random `RELAY_SECRET` and uploads it directly via stdin (never hits shell history).
4. Copies your `ankiel-relay://<host>#<secret>` setup string to your clipboard.
5. Offers to configure your local computer in `~/.ankiel/userdata` (`relay.json` and
   `secrets/relay-secret` with mode `0600`). For a custom state directory, pass
   `--connect-local <dir>`.

Already deployed? Skip the deploy step and just generate + upload your secret and configure your computer:

```bash
cd relay
npm run setup -- --skip-deploy --domain ankiel-relay.<you>.workers.dev
```

To ship Worker updates later, run `npm run deploy` in `relay/`.

---

## Connecting Additional Computers & Your Phone

1. **On each additional computer:**
   - Paste your saved `ankiel-relay://<host>#<secret>` into **Settings → Remote Relay** (or launch with `ANKIEL_RELAY_SETUP="ankiel-relay://<host>#<secret>"`).
2. **On your phone:**
   - Open Ankiel Code → **Add Computer → Scan QR Code** → scan each computer's screen.
   - Your phone pairs directly with each computer using one-time tokens + DPoP sessions.

---

## Push Notifications (Optional)

The relay can deliver notifications to the Ankiel Code mobile app when an agent finishes or needs you. It only signs and forwards: it stores no device tokens. Push credentials are Worker secrets on your own Cloudflare account.

**iOS (APNs).** In the [Apple Developer portal](https://developer.apple.com/account/resources/authkeys/list), go to **Certificates, Identifiers & Profiles → Keys**, create a key with **Apple Push Notifications service (APNs)** enabled, and download the `AuthKey_<KEYID>.p8` file. Apple lets you download it only once. Then run:

```bash
cd relay
npx wrangler secret put APNS_KEY_P8 < AuthKey_XXXXXXXXXX.p8
npx wrangler secret put APNS_KEY_ID      # the 10-character key id
npx wrangler secret put APNS_TEAM_ID     # your 10-character Apple team id
# Optional: only push to these bundle ids
npx wrangler secret put APNS_TOPICS      # e.g. com.example.ankiel,com.example.ankiel.dev
```

An APNs key only reaches apps signed by the same Apple team. To get notifications from your relay, build and sign the iOS app with your own team. The App Store and TestFlight builds are signed by a different team, so your key can't reach them.

**Android (FCM).** In the Firebase console, open **Project settings → Service accounts → Generate new private key**, then run:

```bash
npx wrangler secret put FCM_SERVICE_ACCOUNT_JSON < service-account.json
```

The Android app must be built with the same Firebase project's `google-services.json`.

If your relay was deployed before push support, run `npm run deploy` first. `npm run setup` offers to upload these secrets from the files. When a host connects, the relay tells it which platforms are configured. Pushes for a platform without its secrets fail with `push_not_configured`. Each host can send up to 120 notifications per minute.

---

## Verify Locally (No Cloudflare Deploy Required)

```bash
cd relay
npm run typecheck
npm test
# Test the setup script without touching Cloudflare:
npm run setup -- --dry-run --no-clipboard
# Run local Worker + full HTTP/WS E2E test:
npx wrangler dev --port 8789 --ip 127.0.0.1 --var RELAY_SECRET:test-local-secret-123
RELAY_URL=http://127.0.0.1:8789 RELAY_SECRET=test-local-secret-123 node --experimental-strip-types test/relay-e2e.mjs
```

---

## Endpoints

| Endpoint                                       | Purpose                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /health`                                  | Health check (`{ ok, service, version, configured, requiresSecret, restrictedHosts }`) |
| `GET /relay/status/:hostId`                    | Reports `{ hostId, online }` (requires configured relay)                               |
| `WSS /relay/host/:hostId`                      | Outbound host tunnel (Ed25519 + `RELAY_SECRET` HMAC)                                   |
| `HTTPS/WSS https://<hostId>.<domain>/<path>`   | Wildcard subdomain HTTP + WS reverse tunnel                                            |
| `HTTPS/WSS https://<worker>/h/<hostId>/<path>` | Path-prefix HTTP + WS reverse tunnel (`*.workers.dev` friendly)                        |
