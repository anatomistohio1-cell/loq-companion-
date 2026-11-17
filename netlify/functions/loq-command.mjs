const ALLOWED_PATHS = new Set([
  '/metrics',
  '/audio/devices',
  '/audio/default',
  '/audio/volume',
  '/audio/mute',
  '/disconnect',
]);

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

  const { access_token: accessToken, path, body } = payload || {};
  const relayUrl = process.env.NERV_RELAY_URL;
  const proxySecret = process.env.NERV_RELAY_PROXY_SECRET;
  const deviceId = process.env.NERV_RELAY_DEVICE_ID;
  if (
    typeof accessToken !== 'string'
    || accessToken.length < 32
    || typeof path !== 'string'
    || !ALLOWED_PATHS.has(path)
  ) {
    return json({ detail: 'The relay command is invalid.' }, 400);
  }
  if (!relayUrl || !proxySecret || !deviceId) {
    console.error('LOQ relay configuration is incomplete.');
    return json({ detail: 'Cloud connection is not configured for this deployment.' }, 503);
  }

  let relay;
  try {
    relay = new URL('/v1/command', relayUrl);
  } catch {
    console.error('NERV_RELAY_URL is invalid.');
    return json({ detail: 'Cloud connection is misconfigured.' }, 503);
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
      body: JSON.stringify({
        access_token: accessToken,
        device_id: deviceId,
        path,
        body: body && typeof body === 'object' && !Array.isArray(body) ? body : {},
      }),
      signal: AbortSignal.timeout(8000),
    });
    const result = await response.json();
    return json(result, response.status);
  } catch (error) {
    console.error('LOQ relay command failed:', error);
    return json({ detail: 'LOQ Link is offline or the relay did not respond.' }, 502);
  }
};
