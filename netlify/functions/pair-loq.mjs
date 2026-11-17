const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const isAllowedOrigin = (request) => {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const siteUrl = process.env.URL;
  try {
    return Boolean(siteUrl && new URL(origin).origin === new URL(siteUrl).origin);
  } catch {
    return false;
  }
};

export default async (request) => {
  if (request.method !== 'POST') return json({ detail: 'Method not allowed.' }, 405);
  if (!isAllowedOrigin(request)) return json({ detail: 'Origin is not allowed.' }, 403);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ detail: 'Request body must be valid JSON.' }, 400);
  }

  const pairingCode = payload?.pairing_code;
  const relayUrl = process.env.NERV_RELAY_URL;
  const proxySecret = process.env.NERV_RELAY_PROXY_SECRET;
  const deviceId = process.env.NERV_RELAY_DEVICE_ID;
  if (
    typeof pairingCode !== 'string'
    || pairingCode.length < 16
    || pairingCode.length > 512
  ) {
    return json({ detail: 'Enter the pairing code shown by LOQ Link.' }, 400);
  }
  if (!relayUrl || !proxySecret || !deviceId) {
    console.error('LOQ relay configuration is incomplete.');
    return json({ detail: 'Cloud pairing is not configured for this deployment.' }, 503);
  }

  let relay;
  try {
    relay = new URL('/v1/pair', relayUrl);
  } catch {
    console.error('NERV_RELAY_URL is invalid.');
    return json({ detail: 'Cloud pairing is misconfigured.' }, 503);
  }
  if (relay.protocol !== 'https:' && !(process.env.NETLIFY_DEV && relay.hostname === '127.0.0.1')) {
    return json({ detail: 'The relay URL must use HTTPS.' }, 503);
  }

  try {
    const response = await fetch(relay, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${proxySecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pairing_code: pairingCode, device_id: deviceId }),
      signal: AbortSignal.timeout(7000),
    });
    const result = await response.json();
    if (!response.ok) {
      return json({ detail: result.detail || 'Pairing was rejected.' }, response.status);
    }
    return json({
      status: 'paired',
      device_id: deviceId,
      access_token: result.access_token,
      expires_in_seconds: result.expires_in_seconds,
    });
  } catch (error) {
    console.error('LOQ relay pairing request failed:', error);
    return json({ detail: 'LOQ Link relay is unavailable. Check the relay deployment.' }, 502);
  }
};
