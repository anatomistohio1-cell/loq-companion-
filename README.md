# LOQ Link Desktop Companion

This repository contains the LOQ Link web interface, its Netlify Functions, a Cloudflare relay, and the Windows companion service. The web interface is a static site; Windows audio access runs locally on the companion and is never hosted by Netlify.

## Build and test

```powershell
npm ci
npm run build
npm run test:netlify
```

`npm run build` (or `npm run build:loq`) creates the deployable site in `dist/loq-link`. Netlify uses the repository's `netlify.toml` to run the LOQ build and publish that directory.

See [deployment instructions](docs/deployment.md) for Netlify and Cloudflare setup, environment variables, and production limitations. The HTTP and WebSocket payloads are documented in [the API contract](docs/api-contract.md).

## Run the Windows companion

From the project directory:

```powershell
pip install -r requirements.txt
$env:NERV_PAIRING_TOKEN = "<set a strong random pairing code>"
python -m windows_companion.server
```

The companion binds to `127.0.0.1` by default. To allow direct tablet access over a LAN, provide a trusted TLS certificate and private key, configure `NERV_COMPANION_HOST=0.0.0.0`, and add the dashboard's exact HTTPS origin to `NERV_ALLOWED_ORIGINS`. The service refuses non-loopback binding without TLS. Do not put pairing secrets or TLS private keys in browser code or commit them.

For production, configure the outbound relay and pair from the LOQ Link site with the pairing code. Pairing returns a random session that expires after eight hours; the dashboard keeps it in tab-scoped session storage and clears the entered pairing code. Disconnect revokes that viewer session.

## Audio support

LOQ Link enumerates Windows render endpoints through Core Audio and reports the Windows name, state, default roles, reported form factor, available endpoint volume/mute controls, and the endpoint's current shared mix format when readable.

Implemented controls:

- View Windows-reported playback endpoints, including unavailable states.
- Set an active endpoint as the Windows Console and Multimedia default output.
- Set endpoint master volume and mute when Windows exposes those controls.
- Refresh endpoint state to reflect removal, reconnection, and default-device changes.

The current mix format is informational; it is not a list of all formats supported by a device. Windows default-device selection is system-wide, not per application. Multi-output grouping, synchronized network audio, delay compensation, Android receiver registration, audio transport, and true-surround configuration are not implemented.
