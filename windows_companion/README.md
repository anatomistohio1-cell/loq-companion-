# LOQ Link Windows Companion

This service runs on the Lenovo LOQ and is the only component that accesses Windows telemetry and Core Audio endpoints. It initiates an authenticated outbound WebSocket to the Cloudflare relay; do not port-forward the companion port or expose it to the public internet.

## Start

1. Install Python 3.11 or newer for Windows.
2. Deploy/configure the cloud relay and set the matching `PAIRING_CODE`, `DEVICE_TOKEN`, and device ID as described in `../docs/deployment.md`.
3. Open PowerShell in the extracted project root and run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\windows_companion\Start-LOQLink.ps1
   ```

4. Enter the relay HTTPS origin and device ID. Enter the pairing code and device token at the secure prompts. These values are held in process environment only; the launcher does not write them to disk.
5. Keep the companion process running. Pair either deployed frontend using the same pairing code.

The first launch creates `.venv` and installs `requirements.txt`. Later launches reuse that local environment. Stop the foreground companion with `Ctrl+C`.

The FastAPI health route is loopback-only by default and does not provide public access to hardware. Production website pairing and control go through Netlify Functions and the authenticated cloud relay.
