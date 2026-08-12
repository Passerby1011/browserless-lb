import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('injects the selected Browserless token and retries with another key', async (t) => {
  const seenTokens = [];
  const upstream = http.createServer((request, response) => {
    const token = new URL(request.url, 'http://upstream.local').searchParams.get('token');
    seenTokens.push(token);
    if (token === 'bad') {
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('busy');
      return;
    }
    response.end('ok');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const proxy = createServer({
    browserlessUrl: new URL(`http://127.0.0.1:${upstreamPort}`),
    keys: ['bad', 'good'],
    proxyAuthToken: 'proxy-secret',
    maxRetries: 1,
    cooldownMs: 60_000,
    upstreamTimeoutMs: 1_000,
    maxRequestBodyBytes: 1_024,
  }, { warn() {}, error() {} });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const health = await request(proxyPort, '/healthz?token=proxy-secret');
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), {
    ok: true,
    keys: [
      { id: 0, coolingDown: false, cooldownRemainingMs: 0 },
      { id: 1, coolingDown: false, cooldownRemainingMs: 0 },
    ],
  });

  const denied = await request(proxyPort, '/function?token=wrong-token');
  assert.equal(denied.statusCode, 401);
  assert.deepEqual(seenTokens, []);

  const result = await request(proxyPort, '/function?foo=bar&token=proxy-secret');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, 'ok');
  assert.deepEqual(seenTokens, ['bad', 'good']);
});
