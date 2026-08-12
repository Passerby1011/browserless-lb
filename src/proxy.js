import http from 'node:http';
import https from 'node:https';

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function clientFor(url) {
  return url.protocol === 'https:' ? https : http;
}

export function targetUrl(baseUrl, requestUrl, key) {
  const incoming = new URL(requestUrl, 'http://browserless-lb.local');
  const target = new URL(baseUrl.toString());
  const basePath = target.pathname.replace(/\/$/, '');
  target.pathname = `${basePath}${incoming.pathname}` || '/';
  target.search = incoming.search;
  target.searchParams.delete('token');
  target.searchParams.set('token', key);
  return target;
}

export function isRetryableStatus(statusCode) {
  return RETRYABLE_STATUS_CODES.has(statusCode);
}

export function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body is too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function requestOptions(target, request, key, body) {
  const headers = { ...request.headers };
  delete headers.host;
  delete headers.connection;
  if (body !== undefined) headers['content-length'] = body.length;
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: request.method,
    path: `${target.pathname}${target.search}`,
    headers: {
      ...headers,
      host: target.host,
      'x-forwarded-for': request.socket?.remoteAddress ?? '',
    },
    agent: false,
  };
}

function responseHeaders(headers) {
  const output = { ...headers };
  delete output.connection;
  delete output['transfer-encoding'];
  return output;
}

function collectResponse(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  });
}

function sendBufferedResponse(response, body, clientResponse) {
  const headers = responseHeaders(response.headers);
  headers['content-length'] = body.length;
  clientResponse.writeHead(response.statusCode, response.statusMessage, headers);
  clientResponse.end(body);
}

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  });
  response.end(body);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function forwardHttp({ request, response, body, pool, config, logger = console }) {
  let lastFailure = null;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    let key = pool.pick();
    if (!key) {
      const delay = pool.nextAvailableDelay();
      if (delay > 0) await wait(delay);
      key = pool.pick();
    }
    if (!key) {
      sendJson(response, 503, { error: 'No Browserless key is available' });
      return;
    }

    try {
      const result = await forwardHttpOnce({ request, response, body, key, config });
      if (result.retryable) {
        pool.markFailure(key);
        lastFailure = result;
        logger.warn?.(`Browserless key ${key.id} returned ${result.statusCode}; cooling down`);
        if (attempt < config.maxRetries) continue;
        sendBufferedResponse(result.upstreamResponse, result.body, response);
        return;
      }
      pool.markSuccess(key);
      return;
    } catch (error) {
      pool.markFailure(key);
      lastFailure = error;
      logger.warn?.(`Browserless key ${key.id} failed: ${error.message}; cooling down`);
      if (attempt >= config.maxRetries) break;
    }
  }

  sendJson(response, 502, {
    error: 'Browserless request failed after retries',
    detail: lastFailure?.message ?? 'unknown upstream error',
  });
}

function forwardHttpOnce({ request, response, body, key, config }) {
  const target = targetUrl(config.browserlessUrl, request.url, key.value);
  const client = clientFor(target);
  return new Promise((resolve, reject) => {
    const upstreamRequest = client.request(requestOptions(target, request, key.value, body), async (upstreamResponse) => {
      if (isRetryableStatus(upstreamResponse.statusCode)) {
        try {
          const responseBody = await collectResponse(upstreamResponse);
          resolve({ retryable: true, statusCode: upstreamResponse.statusCode, upstreamResponse, body: responseBody });
        } catch (error) {
          reject(error);
        }
        return;
      }

      response.writeHead(upstreamResponse.statusCode, upstreamResponse.statusMessage, responseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
      upstreamResponse.on('error', () => resolve({ retryable: false }));
      upstreamResponse.on('end', () => resolve({ retryable: false }));
    });

    upstreamRequest.setTimeout(config.upstreamTimeoutMs, () => {
      upstreamRequest.destroy(new Error('Upstream request timed out'));
    });
    upstreamRequest.on('error', reject);
    if (body.length > 0) upstreamRequest.write(body);
    upstreamRequest.end();
  });
}

function rawStatusLine(response) {
  return `HTTP/1.1 ${response.statusCode} ${response.statusMessage || ''}\r\n`;
}

function writeRawResponse(socket, response, body) {
  const headers = responseHeaders(response.headers);
  headers['content-length'] = body.length;
  let raw = rawStatusLine(response);
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) raw += `${name}: ${item}\r\n`;
    } else if (value !== undefined) {
      raw += `${name}: ${value}\r\n`;
    }
  }
  socket.write(`${raw}\r\n`);
  socket.write(body);
  socket.end();
}

export async function forwardWebSocket({ request, socket, head, pool, config, logger = console }) {
  let lastFailure = null;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    let key = pool.pick();
    if (!key) {
      const delay = pool.nextAvailableDelay();
      if (delay > 0) await wait(delay);
      key = pool.pick();
    }
    if (!key) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }

    try {
      const result = await forwardWebSocketOnce({ request, socket, head, key, config });
      if (result.retryable) {
        pool.markFailure(key);
        lastFailure = result;
        logger.warn?.(`Browserless key ${key.id} returned ${result.statusCode}; cooling down`);
        if (attempt < config.maxRetries) continue;
        writeRawResponse(socket, result.upstreamResponse, result.body);
        return;
      }
      pool.markSuccess(key);
      return;
    } catch (error) {
      pool.markFailure(key);
      lastFailure = error;
      logger.warn?.(`Browserless key ${key.id} failed: ${error.message}; cooling down`);
      if (attempt >= config.maxRetries) break;
    }
  }

  socket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ error: 'Browserless WebSocket failed after retries', detail: lastFailure?.message ?? 'unknown upstream error' })}`);
}

function forwardWebSocketOnce({ request, socket, head, key, config }) {
  const target = targetUrl(config.browserlessUrl, request.url, key.value);
  const client = clientFor(target);
  return new Promise((resolve, reject) => {
    const headers = requestOptions(target, request, key.value).headers;
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    const upstreamRequest = client.request({ ...requestOptions(target, request, key.value), headers });
    upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      let raw = rawStatusLine(upstreamResponse);
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) raw += `${name}: ${item}\r\n`;
        } else if (value !== undefined) {
          raw += `${name}: ${value}\r\n`;
        }
      }
      socket.write(`${raw}\r\n`);
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
      resolve({ retryable: false });
    });
    upstreamRequest.on('response', async (upstreamResponse) => {
      try {
        const responseBody = await collectResponse(upstreamResponse);
        resolve({
          retryable: isRetryableStatus(upstreamResponse.statusCode),
          statusCode: upstreamResponse.statusCode,
          upstreamResponse,
          body: responseBody,
        });
      } catch (error) {
        reject(error);
      }
    });
    upstreamRequest.setTimeout(config.upstreamTimeoutMs, () => {
      upstreamRequest.destroy(new Error('Upstream WebSocket timed out'));
    });
    upstreamRequest.on('error', reject);
    upstreamRequest.end();
  });
}

export { RETRYABLE_STATUS_CODES };
