# LOQ Link Relay API Contract

Version 1 of the cloud control-plane contract. It transports telemetry and allowlisted endpoint controls; it does not transport audio.

## Trust boundaries

- The Windows companion is the only process that reads or controls Windows audio endpoints.
- The companion initiates an authenticated TLS WebSocket to the Cloudflare Worker. No inbound laptop port is required.
- NERV Deck and LOQ Link call same-origin Netlify Functions. They never receive the relay's internal proxy secret or the companion's device token.
- Netlify Functions proxy short-lived pairing and command requests to the relay.
- Pairing returns a random, eight-hour viewer session. The Durable Object stores only its SHA-256 hash and expiry.
- A pairing code and device token are separate random secrets. Rotate both independently.

## Public Netlify Function contract

### `GET /.netlify/functions/motorsport-feed?series={wec|imsa|wrc|rally}`

Returns the selected, allowlisted RSS feed as XML. The function accepts only configured Autosport WEC/IMSA/WRC feeds and the DirtFish rally feed; callers cannot supply an arbitrary URL. The dashboard renders linked headlines and dates with publisher attribution, not copied article bodies.

### `POST /.netlify/functions/pair-loq`

Request:

```json
{ "pairing_code": "a high-entropy pairing secret" }
```

Success (`200`):

```json
{
  "status": "paired",
  "device_id": "configured-device-id",
  "access_token": "short-lived-random-session-token",
  "expires_in_seconds": 28800
}
```

Pairing failures return `400`, `401`, `429`, or `503` with a safe `detail` message.

### `POST /.netlify/functions/loq-command`

Request:

```json
{
  "access_token": "session token from pairing",
  "path": "/audio/devices",
  "body": {}
}
```

Allowed command paths:

| Path | Request body | Purpose |
| --- | --- | --- |
| `/metrics` | `{}` | Current Windows host telemetry |
| `/audio/devices` | `{}` | Windows Core Audio playback endpoint snapshot |
| `/audio/default` | `{"endpoint_id":"..."}` | Set Windows Console and Multimedia defaults |
| `/audio/volume` | `{"endpoint_id":"...","volume_percent":0}` | Set supported endpoint volume |
| `/audio/mute` | `{"endpoint_id":"...","muted":true}` | Set supported endpoint mute |
| `/disconnect` | `{}` | Revoke this viewer session |

The function and relay reject other paths. Error responses preserve meaningful `401`, `409`, `422`, `503`, or `504` status codes and a safe `detail`.

## Private relay contract

The Netlify Functions authenticate to the Cloudflare Worker with `INTERNAL_API_SECRET`.

- `POST /v1/pair`: pairing code and configured device ID; returns a random viewer token.
- `POST /v1/command`: viewer token, device ID, allowlisted command and JSON body; the Durable Object forwards the command to the connected companion and returns its response.
- `GET /v1/connect/{device_id}`: companion-only WebSocket upgrade authenticated with `DEVICE_TOKEN`.
- `GET /health`: public readiness only; does not reveal laptop or pairing state.

Companion WebSocket messages:

```json
{"type":"snapshot","snapshot":{"metrics":{},"devices":[],"captured_at":0}}
{"type":"command","id":"request-correlation-id","path":"/metrics","body":{}}
{"type":"response","id":"request-correlation-id","ok":true,"status":200,"result":{},"error":null}
```

The companion validates command arguments again with Pydantic and dispatches only the documented control operations. The Cloudflare Worker contains no general-purpose command execution path.
