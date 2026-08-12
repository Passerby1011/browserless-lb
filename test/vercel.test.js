import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Writable } from 'node:stream';

process.env.BROWSERLESS_KEYS = 'vercel_test_key';
process.env.PROXY_AUTH_TOKEN = 'vercel_proxy_secret';
const { default: handler, browserlessRequestUrl } = await import('../api/proxy.js');

test('maps Vercel API paths back to Browserless paths', () => {
  assert.equal(browserlessRequestUrl({ url: '/api/proxy?__proxy_path=scrape&token=ignored' }), '/scrape?token=ignored');
  assert.equal(browserlessRequestUrl({ url: '/api/proxy?__proxy_path=api/content&token=ignored' }), '/content?token=ignored');
  assert.equal(browserlessRequestUrl({ url: '/api/proxy?token=ignored', query: { __proxy_path: 'smart-scrape' } }), '/smart-scrape?token=ignored');
});

test('serves health checks from a Vercel function', async () => {
  const result = {};
  const response = {
    headersSent: false,
    writeHead(statusCode, headers) {
      result.statusCode = statusCode;
      result.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      result.body = body.toString();
    },
  };
  await handler({
    method: 'GET',
    url: '/api/proxy?__proxy_path=healthz&token=vercel_proxy_secret',
    headers: {},
  }, response);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), {
    ok: true,
    keys: [{ id: 0, coolingDown: false, cooldownRemainingMs: 0 }],
  });
});

test('keeps a REST path and JSON body when forwarding from Vercel', async (t) => {
  const received = {};
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.method = request.method;
    received.url = request.url;
    received.body = Buffer.concat(chunks).toString();
    response.end('ok');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => upstream.close());

  const { port } = upstream.address();
  const originalUrl = process.env.BROWSERLESS_URL;
  process.env.BROWSERLESS_URL = `http://127.0.0.1:${port}`;

  const moduleUrl = new URL('../api/proxy.js', import.meta.url);
  moduleUrl.searchParams.set('cacheBust', Date.now().toString());
  const freshModule = await import(moduleUrl);
  const result = { chunks: [] };
  const response = new Writable({
    write(chunk, _encoding, callback) {
      result.chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.headersSent = false;
  response.writeHead = (statusCode, headers) => {
    result.statusCode = statusCode;
    result.headers = headers;
    response.headersSent = true;
  };

  await freshModule.default({
    method: 'POST',
    url: '/api/proxy?__proxy_path=content&token=vercel_proxy_secret&timeout=30000',
    headers: { 'content-type': 'application/json' },
    body: { url: 'https://example.com' },
  }, response);

  if (originalUrl === undefined) delete process.env.BROWSERLESS_URL;
  else process.env.BROWSERLESS_URL = originalUrl;

  assert.equal(result.statusCode, 200);
  assert.equal(Buffer.concat(result.chunks).toString(), 'ok');
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/content?timeout=30000&token=vercel_test_key');
  assert.equal(received.body, '{"url":"https://example.com"}');
});
