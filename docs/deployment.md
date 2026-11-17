# LOQ Link Netlify Deployment

This repository builds the static LOQ Link site, its short-lived Netlify Functions, the Cloudflare relay, and the Windows companion. NERV Deck is a separate site and is not included here. Windows hardware access remains in the Windows companion; it is never hosted by Netlify.

## Connection diagram

```text
NERV Deck (Netlify site A)                    LOQ Link manager (Netlify site B)
 static pages + race data                      static pairing/status UI
          │                                                │
          └──────── same-origin Netlify Functions ─────────┘
                      pair-loq / loq-command
                                │ HTTPS
                                ▼
             Cloudflare Worker + per-device Durable Object
                                ▲
                                │ outbound WSS, device-token auth
                                │
                    LOQ Link on Lenovo Windows
                    FastAPI + Core Audio + telemetry
                                │
                                ▼
                       Actual Windows outputs
```

### Verified communication paths

1. Browser → the LOQ Link Netlify site → `pair-loq` Function → Cloudflare `/v1/pair`: pairing code is submitted only over HTTPS. The function holds the internal proxy secret and returns only a short-lived viewer token.
2. LOQ Link → Cloudflare `/v1/connect/{device_id}` over outbound WSS: the companion authenticates with `DEVICE_TOKEN`, publishes snapshots, receives allowlisted requests, and reconnects with bounded backoff.
3. Browser → its own Netlify site → `loq-command` Function → Cloudflare `/v1/command` → Durable Object → companion WebSocket → Pydantic-validated Core Audio/telemetry operation. The response follows the same path back.
4. NERV Deck and LOQ Link can be deployed independently. This repository configures the LOQ Link site; connection commands require its Functions and the relay to be healthy.
5. Cloudflare never attempts to access the laptop's private address. The companion stays running locally and opens the outbound connection.

The exact request and WebSocket shapes are in [api-contract.md](./api-contract.md).

## Why the real-time relay is not a Netlify Function

Netlify's current [Server documentation](https://docs.netlify.com/build/server/) says Netlify Server supports WebSockets, but is **Early Access**. Its documented limits include one instance on Free/Personal plans, up to three instances otherwise, scale-to-zero while idle, and APIs/behavior subject to change. Ordinary Netlify Functions are short-lived and do not support open WebSocket connections. We use Netlify Functions only for short-lived pairing and command proxy requests and use Cloudflare Durable Objects for the persistent companion connection. Cloudflare documents WebSocket hibernation for Durable Objects in its [WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

This relay currently provisions one configured LOQ device per Worker deployment. It does not carry audio, provide multi-room audio, or claim synchronized playback.

## Build outputs

```powershell
npm ci
npm run build
npm run build:loq
npm run test:netlify
```

- `npm run build` and `npm run build:loq` build the LOQ Link site.
- `dist/loq-link`: the standalone desktop LOQ Link manager, shared CSS, and browser code only.
- `netlify/functions`: the two short-lived relay proxy functions.
- The Windows service, tests, and source configuration are not published as static assets.

The repository's `netlify.toml` is the LOQ Link configuration. Keep the repository root as the base directory and use a Git-connected Netlify build so the required Functions are deployed with the site. Configure deploy previews and the production branch in Netlify site settings.

## Cloudflare relay setup

1. Install Node.js 22 and run `npm ci`.
2. Create a random device ID and three separate high-entropy secrets: pairing code, companion device token, and relay proxy secret. Keep them out of source control.
3. Create local Cloudflare Worker secrets using `npx wrangler secret put` with `--config cloud-relay/wrangler.jsonc`:

   - `DEVICE_ID` — the configured device ID.
   - `PAIRING_CODE` — same value as Windows `NERV_PAIRING_TOKEN`.
   - `DEVICE_TOKEN` — same value as Windows `NERV_RELAY_DEVICE_TOKEN`.
   - `INTERNAL_API_SECRET` — same value as Netlify `NERV_RELAY_PROXY_SECRET`.

4. Deploy the relay with `npm run relay:deploy`. Verify `https://<worker-host>/health` returns only `{"status":"ok","relay":"ready"}`.
5. Set the Windows companion environment variables shown below and start LOQ Link. Confirm its log reports an authenticated relay connection.
6. Configure `NERV_RELAY_URL`, `NERV_RELAY_DEVICE_ID`, and `NERV_RELAY_PROXY_SECRET` in the **Functions runtime scope** on the LOQ Link Netlify site. Set `NERV_DECK_URL` only if you want the LOQ page to link to a separately deployed NERV Deck site. Never put secrets in `netlify.toml`, browser configuration, or the published directories.
7. Deploy the site. The companion must be connected before live telemetry and endpoint controls will work.

Use separate device IDs, pairing codes, device tokens, proxy secrets, and a separate Worker for preview/staging. Do not point untrusted deploy previews at the production laptop.

Example Windows PowerShell setup (replace placeholders locally; do not commit these values):

```powershell
$env:NERV_PAIRING_TOKEN = "<same as Cloudflare PAIRING_CODE>"
$env:NERV_RELAY_URL = "https://<worker-host>"
$env:NERV_RELAY_DEVICE_ID = "<configured-device-id>"
$env:NERV_RELAY_DEVICE_TOKEN = "<same as Cloudflare DEVICE_TOKEN>"
python -m windows_companion.server
```

The companion still supports direct local HTTPS pairing for isolated development, but production instructions use the outbound relay. A pairing code must be at least 16 characters; use a randomly generated value, not a memorable password.

## Environment variable matrix

| Variable | Cloudflare Worker | LOQ Link Netlify Functions | Windows companion | Public frontend |
| --- | --- | --- | --- | --- |
| `DEVICE_ID` / `NERV_RELAY_DEVICE_ID` | Required | Required | Required | No |
| `PAIRING_CODE` / `NERV_PAIRING_TOKEN` | Secret | No | Secret | No |
| `DEVICE_TOKEN` / `NERV_RELAY_DEVICE_TOKEN` | Secret | No | Secret | No |
| `INTERNAL_API_SECRET` / `NERV_RELAY_PROXY_SECRET` | Secret | Secret, Functions scope | No | No |
| `NERV_RELAY_URL` | No | Required | Required | No |
| `NERV_DECK_URL` | No | No | No | LOQ site's public build-time link |

Set environment values in the relevant provider's secret/environment UI. Any change to a Netlify variable requires a new deploy. Do not share secret values in chat.

## Rollback and disconnect

- Roll back the LOQ Link frontend from its Netlify **Deploys** page; the separately deployed NERV Deck site and laptop service remain untouched.
- Roll back the relay from Cloudflare Workers' deployment history. Avoid destructive Durable Object migrations; preserve existing storage keys when deploying an updated Worker.
- Use **Disconnect** in either site to revoke its current eight-hour viewer session. Stop the companion on Windows to remove the laptop's outbound connection. Rotate `DEVICE_TOKEN` to revoke the laptop credential.
- Windows endpoint enumeration, selection, volume, and mute still happen locally through Core Audio. Only data and bounded commands traverse the relay.

## Production limitations and checks

- Cloudflare and Netlify accounts, site IDs, secrets, and DNS/custom-domain choices must be supplied by the account owner. No production deployment has been performed.
- Remote audio streaming, browser audio capture of arbitrary Windows applications, Android receiver support, multi-output synchronization, and true surround are not implemented.
- Test actual endpoint detection and routing on the target LOQ before treating laptop controls as production-verified.
- Keep Cloudflare and Netlify environment variables separate for preview and production, review deploy previews, then use Netlify rollback if a frontend build fails.
