import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { KeyPool } from './scheduler.js';
import { forwardHttp, forwardWebSocket, readBody } from './proxy.js';
import { isAuthorized, sendUnauthorized, unauthorizedSocket } from './auth.js';

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
