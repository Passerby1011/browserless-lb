import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../docker/server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the usage web UI and per-key usage from the Docker server', async (t) => {
  const usageRequests = [];
  const usageUpstream = http.createServer((request, response) => {
    const token = new URL(request.url, 'http://usage.local').searchParams.get('token');
    usageRequests.push(token);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ units: { consumed: 5, total: 100 }, concurrency: 2, token }));
  });
  const usagePort = await listen(usageUpstream);
  t.after(() => usageUpstream.close());

  const proxy = createServer({
    browserlessUrl: new URL('http://127.0.0.1:1'),
    keys: ['key_one_value', 'key_two_value'],
    proxyAuthToken: 'proxy-secret',
    maxRetries: 1,
    cooldownMs: 60_000,
    upstreamTimeoutMs: 1_000,
    maxRequestBodyBytes: 1_024,
    usageApiUrl: new URL(`http://127.0.0.1:${usagePort}/v1/account/usage`),
    usageTimeoutMs: 2_000,
    usageCacheMs: 0,
  }, { warn() {}, error() {} });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const denied = await request(proxyPort, '/api/usage?token=wrong');
  assert.equal(denied.statusCode, 401);

  const ui = await request(proxyPort, '/ui?token=proxy-secret');
  assert.equal(ui.statusCode, 200);
  assert.match(ui.headers['content-type'], /text\/html/);
  assert.match(ui.body, /Browserless Key Balancer/);

  const root = await request(proxyPort, '/?token=proxy-secret');
  assert.equal(root.statusCode, 200);
  assert.match(root.body, /Browserless Key Balancer/);

  const usage = await request(proxyPort, '/api/usage?token=proxy-secret');
  assert.equal(usage.statusCode, 200);
  const data = JSON.parse(usage.body);
  assert.equal(data.keys.length, 2);
  assert.match(data.keys[0].masked, /\*\*\*\*/);
  assert.ok(!data.keys[0].masked.includes('key_one_value'), 'masked key must not leak');
  assert.equal(data.keys[0].usage.ok, true);
  assert.equal(data.keys[0].usage.json.units.consumed, 5);
  // The fake upstream echoed the token back; the proxy must strip it.
  assert.equal('token' in data.keys[0].usage.json, false);
  assert.deepEqual(usageRequests, ['key_one_value', 'key_two_value']);
});

test('reports usage lookup errors per key without failing the batch', async (t) => {
  const usageUpstream = http.createServer((request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'boom' }));
  });
  const usagePort = await listen(usageUpstream);
  t.after(() => usageUpstream.close());

  const proxy = createServer({
    browserlessUrl: new URL('http://127.0.0.1:1'),
    keys: ['broken_key'],
    proxyAuthToken: 'proxy-secret',
    maxRetries: 1,
    cooldownMs: 60_000,
    upstreamTimeoutMs: 1_000,
    maxRequestBodyBytes: 1_024,
    usageApiUrl: new URL(`http://127.0.0.1:${usagePort}/v1/account/usage`),
    usageTimeoutMs: 2_000,
    usageCacheMs: 0,
  }, { warn() {}, error() {} });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const usage = await request(proxyPort, '/usage?token=proxy-secret');
  assert.equal(usage.statusCode, 200);
  const data = JSON.parse(usage.body);
  assert.equal(data.keys.length, 1);
  assert.equal(data.keys[0].usage.ok, false);
  assert.match(data.keys[0].usage.error, /boom/);
});
