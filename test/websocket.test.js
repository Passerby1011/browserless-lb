import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../docker/server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function openWebSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('connect', () => {
      socket.write([
        'GET /chrome?token=proxy-secret HTTP/1.1',
        'Host: localhost',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n') && data.includes('hello')) resolve({ socket, data });
    });
    socket.on('error', reject);
  });
}

test('forwards Browserless WebSocket upgrade and injects token', async (t) => {
  const upstream = http.createServer();
  const upstreamSockets = new Set();
  upstream.on('upgrade', (request, socket) => {
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
    const token = new URL(request.url, 'http://upstream.local').searchParams.get('token');
    assert.equal(token, 'only-key');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello');
    setTimeout(() => socket.destroy(), 10);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => {
    for (const socket of upstreamSockets) socket.destroy();
    upstream.close();
  });

  const proxy = createServer({
    browserlessUrl: new URL(`http://127.0.0.1:${upstreamPort}`),
    keys: ['only-key'],
    proxyAuthToken: 'proxy-secret',
    maxRetries: 0,
    cooldownMs: 1_000,
    upstreamTimeoutMs: 1_000,
    maxRequestBodyBytes: 1_024,
  }, { warn() {}, error() {} });
  const proxyPort = await listen(proxy);
  t.after(() => proxy.close());

  const result = await openWebSocket(proxyPort);
  assert.match(result.data, /^HTTP\/1\.1 101 Switching Protocols/);
  result.socket.destroy();
});
