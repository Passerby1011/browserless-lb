import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized, requestToken } from '../src/auth.js';

test('authenticates the proxy token without exposing Browserless keys', () => {
  assert.equal(requestToken('/scrape?token=proxy-secret&timeout=30000'), 'proxy-secret');
  assert.equal(isAuthorized('/scrape?token=proxy-secret', 'proxy-secret'), true);
  assert.equal(isAuthorized('/scrape?token=wrong', 'proxy-secret'), false);
  assert.equal(isAuthorized('/scrape', 'proxy-secret'), false);
});
