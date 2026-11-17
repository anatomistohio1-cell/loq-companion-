import assert from 'node:assert/strict';
import pairFunction from '../netlify/functions/pair-loq.mjs';
import commandFunction from '../netlify/functions/loq-command.mjs';
import feedFunction from '../netlify/functions/motorsport-feed.mjs';

process.env.URL = 'https://nerv.example';
process.env.NERV_RELAY_URL = 'https://relay.example';
process.env.NERV_RELAY_PROXY_SECRET = 'test-proxy-secret';
process.env.NERV_RELAY_DEVICE_ID = 'test-device';
let fetchCalls = [];
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url: String(url), options });
  return Response.json({
    status: 'paired',
    access_token: 'a'.repeat(43),
    expires_in_seconds: 28800,
  });
};

const request = (path, body, origin = 'https://nerv.example') =>
  new Request(`https://nerv.example${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });

const deniedPair = await pairFunction(request('/.netlify/functions/pair-loq', {
  pairing_code: 'p'.repeat(24),
}, 'https://attacker.example'));
assert.equal(deniedPair.status, 403);
assert.equal(fetchCalls.length, 0);

const invalidPair = await pairFunction(request('/.netlify/functions/pair-loq', {
  pairing_code: 'short',
}));
assert.equal(invalidPair.status, 400);
assert.equal(fetchCalls.length, 0);

const paired = await pairFunction(request('/.netlify/functions/pair-loq', {
  pairing_code: 'p'.repeat(24),
}));
assert.equal(paired.status, 200);
const pairedPayload = await paired.json();
assert.equal(pairedPayload.device_id, 'test-device');
assert.equal(pairedPayload.access_token.length, 43);
assert.equal(fetchCalls[0].url, 'https://relay.example/v1/pair');
assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer test-proxy-secret');
assert.equal(JSON.parse(fetchCalls[0].options.body).pairing_code, 'p'.repeat(24));

fetchCalls = [];
const rejectedCommand = await commandFunction(request('/.netlify/functions/loq-command', {
  access_token: 'a'.repeat(43),
  path: '/admin/shell',
  body: {},
}));
assert.equal(rejectedCommand.status, 400);
assert.equal(fetchCalls.length, 0);

const forwardedCommand = await commandFunction(request('/.netlify/functions/loq-command', {
  access_token: 'a'.repeat(43),
  path: '/audio/volume',
  body: { endpoint_id: 'endpoint-1', volume_percent: 28 },
}));
assert.equal(forwardedCommand.status, 200);
assert.equal(fetchCalls[0].url, 'https://relay.example/v1/command');
assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer test-proxy-secret');
assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
  access_token: 'a'.repeat(43),
  device_id: 'test-device',
  path: '/audio/volume',
  body: { endpoint_id: 'endpoint-1', volume_percent: 28 },
});

fetchCalls = [];
const invalidFeed = await feedFunction(new Request(
  'https://nerv.example/.netlify/functions/motorsport-feed?series=unknown',
  { headers: { Origin: 'https://nerv.example' } },
));
assert.equal(invalidFeed.status, 400);
assert.equal(fetchCalls.length, 0);

globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url: String(url), options });
  const response = new Response(
    '<rss version="2.0"><channel><title>WRC</title></channel></rss>',
    { headers: { 'Content-Type': 'application/rss+xml', 'Content-Length': '64' } },
  );
  Object.defineProperty(response, 'url', { value: 'https://www.autosport.com/rss/wrc/news/' });
  return response;
};
const validFeed = await feedFunction(new Request(
  'https://nerv.example/.netlify/functions/motorsport-feed?series=wrc',
  { headers: { Origin: 'https://nerv.example' } },
));
assert.equal(validFeed.status, 200);
assert.match(validFeed.headers.get('Content-Type'), /application\/rss\+xml/);
assert.match(await validFeed.text(), /<rss/);
assert.equal(fetchCalls[0].url, 'https://www.autosport.com/rss/wrc/news/');
assert.equal(fetchCalls[0].options.redirect, 'error');

fetchCalls = [];
const deniedFeed = await feedFunction(new Request(
  'https://nerv.example/.netlify/functions/motorsport-feed?series=rally',
  { headers: { Origin: 'https://attacker.example' } },
));
assert.equal(deniedFeed.status, 403);
assert.equal(fetchCalls.length, 0);

console.log('Netlify function tests passed.');
