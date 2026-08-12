import { loadConfig } from '../src/config.js';
import { KeyPool } from '../src/scheduler.js';
import { forwardHttp, readBody } from '../src/proxy.js';
import { isAuthorized, sendUnauthorized } from '../src/auth.js';

let runtime;

function getRuntime() {
  if (!runtime) {
    const config = loadConfig();
    runtime = { config, pool: new KeyPool(config.keys, config.cooldownMs) };
  }
  return runtime;
}

function browserlessRequestUrl(requestUrl) {
  const incoming = new URL(requestUrl || '/', 'http://vercel.local');
  let pathname = incoming.pathname;
  if (pathname === '/api') pathname = '/';
  else if (pathname.startsWith('/api/')) pathname = pathname.slice(4) || '/';
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

    const path = browserlessRequestUrl(request.url).split('?')[0];

    if (path === '/healthz' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, keys: active.pool.status() });
      return;
    }

    const proxyRequest = Object.create(request);
    proxyRequest.url = browserlessRequestUrl(request.url);
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

export { browserlessRequestUrl };
