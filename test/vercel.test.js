import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BROWSERLESS_KEYS = 'vercel_test_key';
process.env.PROXY_AUTH_TOKEN = 'vercel_proxy_secret';
const { default: handler, browserlessRequestUrl } = await import('../api/[...path].js');

test('maps Vercel API paths back to Browserless paths', () => {
  assert.equal(browserlessRequestUrl('/api/scrape?token=ignored'), '/scrape?token=ignored');
  assert.equal(browserlessRequestUrl('/api/content'), '/content');
  assert.equal(browserlessRequestUrl('/api'), '/');
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
  await handler({ method: 'GET', url: '/api/healthz?token=vercel_proxy_secret', headers: {} }, response);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), {
    ok: true,
    keys: [{ id: 0, coolingDown: false, cooldownRemainingMs: 0 }],
  });
});
