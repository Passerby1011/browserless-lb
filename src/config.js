function positiveInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const rawKeys = env.BROWSERLESS_KEYS ?? env.BROWSERLESS_API_KEYS ?? '';
  const keys = rawKeys
    .split(/[\s,\r\n]+/)
    .map((key) => key.trim())
    .filter(Boolean);

  if (keys.length === 0) {
    throw new Error('Set BROWSERLESS_KEYS to a comma- or newline-separated list of API keys');
  }

  const proxyAuthToken = env.PROXY_AUTH_TOKEN?.trim();
  if (!proxyAuthToken) {
    throw new Error('Set PROXY_AUTH_TOKEN to protect the proxy endpoint');
  }

  const browserlessUrl = env.BROWSERLESS_URL ?? 'https://production-sfo.browserless.io';
  let parsedUrl;
  try {
    parsedUrl = new URL(browserlessUrl);
  } catch {
    throw new Error('BROWSERLESS_URL must be a valid http(s) URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('BROWSERLESS_URL must use http or https');
  }

  const usageApiUrl = env.USAGE_API_URL ?? 'https://api.browserless.io/v1/account/usage';
  let parsedUsageUrl;
  try {
    parsedUsageUrl = new URL(usageApiUrl);
  } catch {
    throw new Error('USAGE_API_URL must be a valid http(s) URL');
  }
  if (!['http:', 'https:'].includes(parsedUsageUrl.protocol)) {
    throw new Error('USAGE_API_URL must use http or https');
  }

  return {
    port: positiveInt(env.PORT, 3000, 'PORT'),
    browserlessUrl: parsedUrl,
    keys,
    proxyAuthToken,
    maxRetries: positiveInt(env.MAX_RETRIES, 2, 'MAX_RETRIES'),
    cooldownMs: positiveInt(env.COOLDOWN_SECONDS, 30, 'COOLDOWN_SECONDS') * 1000,
    upstreamTimeoutMs: positiveInt(env.UPSTREAM_TIMEOUT_SECONDS, 120, 'UPSTREAM_TIMEOUT_SECONDS') * 1000,
    maxRequestBodyBytes: positiveInt(env.MAX_REQUEST_BODY_MB, 32, 'MAX_REQUEST_BODY_MB') * 1024 * 1024,
    usageApiUrl: parsedUsageUrl,
    usageTimeoutMs: positiveInt(env.USAGE_TIMEOUT_SECONDS, 10, 'USAGE_TIMEOUT_SECONDS') * 1000,
    usageCacheMs: positiveInt(env.USAGE_CACHE_SECONDS, 30, 'USAGE_CACHE_SECONDS') * 1000,
  };
}
