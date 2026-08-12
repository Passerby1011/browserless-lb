import http from 'node:http';
import https from 'node:https';

function clientFor(url) {
  return url.protocol === 'https:' ? https : http;
}

export function maskKey(value) {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function sanitizeJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const output = {};
    for (const [name, item] of Object.entries(value)) {
      if (/token|apikey|secret|authorization/i.test(name)) continue;
      output[name] = item;
    }
    return output;
  }
  return value;
}

// Small per-process cache keyed by (usage url + key) so frequent page
// refreshes do not hammer the Browserless account API.
const cache = new Map();

export async function fetchUsageForKey(key, { url, timeoutMs = 10_000, cacheMs = 30_000 } = {}) {
  if (!url) throw new Error('usage API url is required');

  const cacheKey = `${url}|${key}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < cacheMs) return hit.value;

  const target = new URL(url.toString());
  target.searchParams.set('token', key);

  const value = await new Promise((resolve) => {
    const request = clientFor(target).get(target, { timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        let parseError = null;
        try {
          json = JSON.parse(raw);
        } catch {
          parseError = 'invalid JSON';
        }
        resolve({
          statusCode: response.statusCode,
          ok: response.statusCode === 200 && json !== null,
          json: sanitizeJson(json),
          raw: raw.split(key).join(maskKey(key)),
          error: response.statusCode === 200 ? parseError : (json?.error ?? `HTTP ${response.statusCode}`),
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error('usage request timed out')));
    request.on('error', (error) => resolve({ statusCode: 0, ok: false, json: null, raw: '', error: error.message }));
    request.end();
  });

  if (cacheMs > 0) cache.set(cacheKey, { at: now, value });
  return value;
}

export function fetchUsageForKeys(keys, options) {
  return Promise.all(keys.map((key) => fetchUsageForKey(key.value, options)));
}
