import { DurableObject } from 'cloudflare:workers';

const SESSION_TTL_SECONDS = 8 * 60 * 60;
const ALLOWED_COMMANDS = new Set([
  '/metrics',
  '/audio/devices',
  '/audio/default',
  '/audio/volume',
  '/audio/mute',
  '/disconnect',
]);

const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });

const safeEqual = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
};

const validDeviceId = (deviceId, env) =>
  typeof deviceId === 'string'
  && deviceId.length > 0
  && deviceId.length <= 128
  && safeEqual(deviceId, env.DEVICE_ID);

const proxyAuthorized = (request, env) =>
  safeEqual(request.headers.get('authorization') || '', `Bearer ${env.INTERNAL_API_SECRET || ''}`)
  && Boolean(env.INTERNAL_API_SECRET);

const getRoom = (env, deviceId) =>
  env.DEVICE_ROOM.get(env.DEVICE_ROOM.idFromName(deviceId));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ status: 'ok', relay: 'ready' });
    }

    if (url.pathname === '/v1/pair' && request.method === 'POST') {
      if (!proxyAuthorized(request, env)) return json({ detail: 'Unauthorized.' }, 401);
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ detail: 'Invalid request body.' }, 400);
      }
      if (!validDeviceId(payload?.device_id, env)) return json({ detail: 'Unknown device.' }, 404);
      if (!env.PAIRING_CODE) return json({ detail: 'Pairing is not configured.' }, 503);

      const room = getRoom(env, payload.device_id);
      return room.fetch('https://device-room/issue-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairing_code: payload.pairing_code,
          expected_code: env.PAIRING_CODE,
          ip: request.headers.get('CF-Connecting-IP') || 'unknown',
        }),
      });
    }

    if (url.pathname === '/v1/command' && request.method === 'POST') {
      if (!proxyAuthorized(request, env)) return json({ detail: 'Unauthorized.' }, 401);
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ detail: 'Invalid request body.' }, 400);
      }
      if (!validDeviceId(payload?.device_id, env)) return json({ detail: 'Unknown device.' }, 404);
      if (
        typeof payload?.path !== 'string'
        || !ALLOWED_COMMANDS.has(payload.path)
        || typeof payload?.access_token !== 'string'
        || payload.access_token.length < 32
      ) {
        return json({ detail: 'Invalid relay command.' }, 400);
      }

      return getRoom(env, payload.device_id).fetch('https://device-room/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: payload.access_token,
          path: payload.path,
          body: payload.body,
        }),
      });
    }

    if (url.pathname.startsWith('/v1/connect/') && request.method === 'GET') {
      const deviceId = decodeURIComponent(url.pathname.slice('/v1/connect/'.length));
      if (!validDeviceId(deviceId, env)) return json({ detail: 'Unknown device.' }, 404);
      if (!env.DEVICE_TOKEN || !safeEqual(request.headers.get('authorization') || '', `Bearer ${env.DEVICE_TOKEN}`)) {
        return json({ detail: 'Unauthorized companion.' }, 401);
      }
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return json({ detail: 'A WebSocket upgrade is required.' }, 426);
      }

      const headers = new Headers(request.headers);
      headers.set('x-relay-role', 'companion');
      return getRoom(env, deviceId).fetch(
        new Request(new URL('/companion', request.url), {
          method: 'GET',
          headers,
        }),
      );
    }

    return json({ detail: 'Not found.' }, 404);
  },
};

export class LoqDeviceRoom extends DurableObject {
  pendingCommands = new Map();

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/issue-ticket' && request.method === 'POST') {
      return this.issueTicket(request);
    }
    if (url.pathname === '/command' && request.method === 'POST') {
      return this.dispatchCommand(request);
    }
    if (url.pathname === '/companion' && request.method === 'GET') {
      return this.acceptCompanion(request);
    }
    if (url.pathname === '/snapshot' && request.method === 'GET') {
      const snapshot = await this.ctx.storage.get('snapshot');
      return snapshot
        ? json({ ...snapshot, age_seconds: Math.max(0, Math.floor((Date.now() - snapshot.captured_at) / 1000)) })
        : json({ detail: 'No companion snapshot is available.' }, 503);
    }

    return json({ detail: 'Not found.' }, 404);
  }

  async issueTicket(request) {
    const payload = await request.json();
    const ip = String(payload.ip || 'unknown').slice(0, 64);
    const attemptsKey = `pair-attempts:${ip}`;
    const attempts = await this.ctx.storage.get(attemptsKey);
    if (attempts && attempts.expiresAt > Date.now() && attempts.count >= 8) {
      return json({ detail: 'Too many pairing attempts. Try again later.' }, 429);
    }

    if (!safeEqual(payload.pairing_code, payload.expected_code)) {
      const next = attempts && attempts.expiresAt > Date.now()
        ? { count: attempts.count + 1, expiresAt: attempts.expiresAt }
        : { count: 1, expiresAt: Date.now() + 60_000 };
      await this.ctx.storage.put(attemptsKey, next);
      return json({ detail: 'Invalid pairing code.' }, 401);
    }

    await this.ctx.storage.delete(attemptsKey);
    const accessToken = this.randomToken();
    const tokenHash = await this.hashToken(accessToken);
    await this.ctx.storage.put(`session:${tokenHash}`, Date.now() + SESSION_TTL_SECONDS * 1000);
    return json({
      status: 'paired',
      access_token: accessToken,
      expires_in_seconds: SESSION_TTL_SECONDS,
    });
  }

  async dispatchCommand(request) {
    const payload = await request.json();
    const tokenHash = await this.hashToken(String(payload.access_token || ''));
    const expiresAt = await this.ctx.storage.get(`session:${tokenHash}`);
    if (typeof expiresAt !== 'number' || expiresAt <= Date.now()) {
      await this.ctx.storage.delete(`session:${tokenHash}`);
      return json({ detail: 'The paired session has expired.' }, 401);
    }

    if (payload.path === '/disconnect') {
      await this.ctx.storage.delete(`session:${tokenHash}`);
      return json({ status: 'disconnected' });
    }
    if (!ALLOWED_COMMANDS.has(payload.path)) return json({ detail: 'Command is not allowed.' }, 400);

    const companion = this.ctx.getWebSockets('companion')[0];
    if (!companion) return json({ detail: 'LOQ Link is offline.' }, 503);

    const requestId = crypto.randomUUID();
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error('The Windows companion did not respond in time.'));
      }, 6_000);
      this.pendingCommands.set(requestId, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });

    try {
      companion.send(JSON.stringify({
        type: 'command',
        id: requestId,
        path: payload.path,
        body: payload.body && typeof payload.body === 'object' && !Array.isArray(payload.body)
          ? payload.body
          : {},
      }));
      const result = await response;
      return json(result.body || {}, result.status || 200);
    } catch (error) {
      return json({ detail: error.message }, error.message.includes('timed out') ? 504 : 503);
    } finally {
      this.pendingCommands.delete(requestId);
    }
  }

  async acceptCompanion(request) {
    if (request.headers.get('x-relay-role') !== 'companion') {
      return json({ detail: 'Unauthorized role.' }, 401);
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json({ detail: 'A WebSocket upgrade is required.' }, 426);
    }

    for (const existing of this.ctx.getWebSockets('companion')) {
      existing.close(1012, 'Companion reconnected.');
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ['companion']);
    server.serializeAttachment({ role: 'companion' });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.role !== 'companion' || typeof message !== 'string' || message.length > 128_000) {
      socket.close(1003, 'Invalid companion message.');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      socket.close(1003, 'Invalid JSON.');
      return;
    }

    if (payload.type === 'snapshot' && payload.snapshot && typeof payload.snapshot === 'object') {
      await this.ctx.storage.put('snapshot', {
        captured_at: Date.now(),
        metrics: payload.snapshot.metrics || null,
        devices: Array.isArray(payload.snapshot.devices) ? payload.snapshot.devices : [],
      });
      return;
    }

    if (payload.type === 'response' && typeof payload.id === 'string') {
      const resolve = this.pendingCommands.get(payload.id);
      if (!resolve) return;
      const status = Number.isInteger(payload.status) ? payload.status : payload.ok ? 200 : 503;
      resolve({
        status,
        body: payload.ok
          ? payload.result || {}
          : { detail: typeof payload.error === 'string' ? payload.error : 'LOQ Link command failed.' },
      });
      return;
    }

    socket.close(1003, 'Unsupported companion message.');
  }

  webSocketClose(socket) {
    try {
      socket.close();
    } catch {
      return;
    }
  }

  webSocketError(socket) {
    try {
      socket.close(1011, 'Companion connection error.');
    } catch {
      return;
    }
  }

  randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async hashToken(token) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}
