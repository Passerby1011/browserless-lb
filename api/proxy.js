import { loadConfig } from '../src/config.js';
import { KeyPool } from '../src/scheduler.js';
import { forwardHttp, readBody } from '../src/proxy.js';
import { isAuthorized, sendUnauthorized } from '../src/auth.js';
import { fetchUsageForKeys, maskKey } from '../src/usage.js';
import { renderUsagePage } from '../src/ui.js';

// Vercel reads this static config from the entrypoint. Browserless REST calls
// (content/scrape/screenshot/...) can run for tens of seconds, so the default
// function duration is not enough. Keep this in sync with the README.
export const config = { maxDuration: 60 };

let runtime;

function getRuntime() {
  if (!runtime) {
    const config = loadConfig();
    runtime = { config, pool: new KeyPool(config.keys, config.cooldownMs) };
  }
  return runtime;
}

function pathFromRequest(request) {
  const incoming = new URL(request.url || '/', 'http://vercel.local');
  const parameter = request.query?.__proxy_path ?? incoming.searchParams.get('__proxy_path');
  const rawPath = Array.isArray(parameter) ? parameter.join('/') : parameter;
  const pathname = rawPath ? `/${String(rawPath).replace(/^\/+/, '')}` : '/';
  return pathname === '/api' || pathname.startsWith('/api/')
    ? pathname.slice(4) || '/'
    : pathname;
}

export function browserlessRequestUrl(request) {
  const incoming = new URL(request.url || '/', 'http://vercel.local');
  const pathname = pathFromRequest(request);
  incoming.searchParams.delete('__proxy_path');
  return `${pathname}${incoming.search}`;
}

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  });
  response.end(body);
}

function sendHtml(response, html) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  });
  response.end(html);
}

async function usagePayload(pool, config) {
  const results = await fetchUsageForKeys(pool.keys, {
    url: config.usageApiUrl,
    timeoutMs: config.usageTimeoutMs,
    cacheMs: config.usageCacheMs,
  });
  return {
    generatedAt: new Date().toISOString(),
    keys: pool.keys.map((key, index) => ({
      id: key.id,
      masked: maskKey(key.value),
      coolingDown: key.cooldownUntil > Date.now(),
      cooldownRemainingMs: Math.max(0, key.cooldownUntil - Date.now()),
      usage: results[index] ?? { ok: false, error: 'no result' },
    })),
  };
}

async function requestBody(request, maxBytes) {
  if (request.body !== undefined && request.body !== null) {
    if (Buffer.isBuffer(request.body)) return request.body;
    if (typeof request.body === 'string') return Buffer.from(request.body);
    return Buffer.from(JSON.stringify(request.body));
  }

  const contentLength = Number(request.headers?.['content-length'] ?? 0);
  if (contentLength === 0 && !request.headers?.['transfer-encoding']) return Buffer.alloc(0);
  return readBody(request, maxBytes);
}

export default async function handler(request, response) {
  try {
    const active = getRuntime();
    if (!isAuthorized(request.url, active.config.proxyAuthToken)) {
      sendUnauthorized(response);
      return;
    }

    const path = browserlessRequestUrl(request).split('?')[0];
    if (path === '/healthz' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, keys: active.pool.status() });
      return;
    }

    if ((path === '/ui' || path === '/') && request.method === 'GET') {
      sendHtml(response, renderUsagePage());
      return;
    }

    if (path === '/usage' && request.method === 'GET') {
      sendJson(response, 200, await usagePayload(active.pool, active.config));
      return;
    }

    const proxyRequest = Object.create(request);
    proxyRequest.url = browserlessRequestUrl(request);
    const body = await requestBody(request, active.config.maxRequestBodyBytes);
    await forwardHttp({
      request: proxyRequest,
      response,
      body,
      pool: active.pool,
      config: active.config,
      logger: console,
    });
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.statusCode ?? 500, { error: error.message });
    else response.destroy(error);
  }
}
