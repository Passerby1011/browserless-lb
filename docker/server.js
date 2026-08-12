import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { KeyPool } from '../src/scheduler.js';
import { forwardHttp, forwardWebSocket, readBody } from '../src/proxy.js';
import { isAuthorized, sendUnauthorized, unauthorizedSocket } from '../src/auth.js';
import { fetchUsageForKeys, maskKey } from '../src/usage.js';
import { renderUsagePage } from '../src/ui.js';

function usageDefaults(config) {
  return {
    url: config.usageApiUrl ?? new URL('https://api.browserless.io/v1/account/usage'),
    timeoutMs: config.usageTimeoutMs ?? 10_000,
    cacheMs: config.usageCacheMs ?? 30_000,
  };
}

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
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
  const results = await fetchUsageForKeys(pool.keys, usageDefaults(config));
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

export function createServer(config, logger = console) {
  const pool = new KeyPool(config.keys, config.cooldownMs);
  const server = http.createServer(async (request, response) => {
    if (!isAuthorized(request.url, config.proxyAuthToken)) {
      sendUnauthorized(response);
      return;
    }

    const requestPath = new URL(request.url || '/', 'http://browserless-lb.local').pathname;
    if (requestPath === '/healthz' && request.method === 'GET') {
      const payload = JSON.stringify({ ok: true, keys: pool.status() });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
      return;
    }

    if ((requestPath === '/ui' || requestPath === '/') && request.method === 'GET') {
      sendHtml(response, renderUsagePage());
      return;
    }

    if ((requestPath === '/api/usage' || requestPath === '/usage') && request.method === 'GET') {
      try {
        sendJson(response, 200, await usagePayload(pool, config));
      } catch (error) {
        sendJson(response, error.statusCode ?? 502, { error: error.message });
      }
      return;
    }

    try {
      const body = await readBody(request, config.maxRequestBodyBytes);
      await forwardHttp({ request, response, body, pool, config, logger });
    } catch (error) {
      if (!response.headersSent) {
        const statusCode = error.statusCode ?? 400;
        const payload = JSON.stringify({ error: error.message });
        response.writeHead(statusCode, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
        });
        response.end(payload);
      } else {
        response.destroy(error);
      }
    }
  });

  server.on('upgrade', (request, socket, head) => {
    if (!isAuthorized(request.url, config.proxyAuthToken)) {
      unauthorizedSocket(socket);
      return;
    }

    forwardWebSocket({ request, socket, head, pool, config, logger }).catch((error) => {
      logger.error?.(error);
      socket.destroy();
    });
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const server = createServer(config);
    server.listen(config.port, () => {
      console.log(`Browserless key balancer listening on :${config.port}`);
      console.log(`Upstream: ${config.browserlessUrl.origin}; keys: ${config.keys.length}; max retries: ${config.maxRetries}; cooldown: ${config.cooldownMs / 1000}s`);
    });

    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
