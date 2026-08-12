import { timingSafeEqual } from 'node:crypto';

export function requestToken(requestUrl) {
  return new URL(requestUrl || '/', 'http://browserless-lb.local').searchParams.get('token');
}

export function isAuthorized(requestUrl, expectedToken) {
  const providedToken = requestToken(requestUrl);
  if (!providedToken || !expectedToken) return false;

  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function sendUnauthorized(response) {
  const body = Buffer.from(JSON.stringify({ error: 'Unauthorized' }));
  response.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  response.end(body);
}

export function unauthorizedSocket(socket) {
  socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n');
}
