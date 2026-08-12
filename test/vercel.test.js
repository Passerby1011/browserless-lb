import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Writable } from 'node:stream';

const usageUpstream = http.createServer((request, response) => {
  const token = new URL(request.url, 'http://usage.local').searchParams.get('token');
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ units: { consumed: 7, total: 100 }, concurrency: 2, token }));
});
usageUpstream.listen(0, '127.0.0.1');
await once(usageUpstream, 'listening');
after(() => usageUpstream.close());
const usagePort = usageUpstream.address().port;
process.env.BROWSERLESS_KEYS = 'vercel_test_key';
process.env.PROXY_AUTH_TOKEN = 'vercel_proxy_secret';
process.env.USAGE_API_URL = `http://127.0.0.1:${usagePort}/v1/account/usage`;
process.env.USAGE_CACHE_SECONDS = '0';
const { default: handler, browserlessRequestUrl, config: functionConfig } = await import('../api/proxy.js');

test('sets a generous max duration for slow Browserless REST calls', () => {
  assert.equal(functionConfig.maxDuration, 60);
});

test('maps Vercel API paths back to Browserless paths', () => {
  assert.equal(browserlessRequestUrl({ url: '/api/proxy?__proxy_path=scrape&token=ignored' }), '/scrape?token=ignored');
  assert.equal(browserlessRequestUrl({ url: '/api/proxy?__proxy_path=api/content&token=ignored' }), '/content?token=ignored');
  assert.equal(browserlessRequestUrl({ url: '/api/proxy?token=ignored', query: { __proxy_path: 'smart-scrape' } }), '/smart-scrape?token=ignored');
  // The explicit-builds route rewrites every path to /api/proxy.js with a leading slash.
  assert.equal(browserlessRequestUrl({ url: '/api/proxy.js?__proxy_path=/content&token=ignored' }), '/content?token=ignored');
  assert.equal(browserlessRequestUrl({ url: '/api/proxy.js?__proxy_path=/api/scrape&token=ignored' }), '/scrape?token=ignored');
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
    url: '/api/proxy.js?__proxy_path=/healthz&token=vercel_proxy_secret',
    headers: {},
  }, response);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), {
    ok: true,
    keys: [{ id: 0, coolingDown: false, cooldownRemainingMs: 0 }],
  });
});

test('serves the usage web UI from a Vercel function', async () => {
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
    url: '/api/proxy.js?__proxy_path=/ui&token=vercel_proxy_secret',
    headers: {},
  }, response);
  assert.equal(result.statusCode, 200);
  assert.match(result.headers['content-type'], /text\/html/);
  assert.match(result.body, /Browserless Key Balancer/);
});

test('serves per-key usage JSON from a Vercel function', async () => {
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
    url: '/api/proxy.js?__proxy_path=/usage&token=vercel_proxy_secret',
    headers: {},
  }, response);
  assert.equal(result.statusCode, 200);
  const data = JSON.parse(result.body);
  assert.equal(data.keys.length, 1);
  assert.equal(data.keys[0].usage.ok, true);
  assert.equal(data.keys[0].usage.json.units.consumed, 7);
  assert.equal('token' in data.keys[0].usage.json, false);
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
    url: '/api/proxy.js?__proxy_path=/content&token=vercel_proxy_secret&timeout=30000',
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
