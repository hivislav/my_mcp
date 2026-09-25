import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { assertSafeHttpBinding, loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { OpenMeteoClient } from '../src/open-meteo/client.js';
import { OpenMeteoError } from '../src/open-meteo/errors.js';
import { decodeWeatherCode } from '../src/open-meteo/weather-codes.js';
import { bool, num, series, str } from '../src/tools/coerce.js';

const TOUCHED = [
  'MCP_TRANSPORT',
  'MCP_HOST',
  'MCP_PORT',
  'MCP_PATH',
  'MCP_AUTH_TOKEN',
  'MCP_ALLOW_UNAUTHENTICATED',
  'MCP_SESSION_MODE',
  'MCP_ALLOWED_ORIGINS',
  'MCP_MAX_BODY_BYTES',
  'MCP_JSON_RESPONSE',
  'OPEN_METEO_TIMEOUT_MS',
  'OPEN_METEO_MAX_RETRIES',
  'OPEN_METEO_FORECAST_URL',
  'OPEN_METEO_API_KEY',
  'LOG_LEVEL',
] as const;

const original = new Map(TOUCHED.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of TOUCHED) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearEnv(): void {
  for (const key of TOUCHED) delete process.env[key];
}

describe('weather code decoding', () => {
  it('maps known WMO codes to slugs and bilingual labels', () => {
    assert.deepEqual(decodeWeatherCode(0), { condition: 'clear_sky', en: 'Clear sky', ru: 'Ясно' });
    assert.equal(decodeWeatherCode(95).condition, 'thunderstorm');
    assert.equal(decodeWeatherCode(99).ru, 'Гроза с сильным градом');
  });

  it('degrades gracefully for unknown and missing codes', () => {
    assert.equal(decodeWeatherCode(1234).condition, 'unknown');
    assert.equal(decodeWeatherCode(null).condition, 'unknown');
    assert.equal(decodeWeatherCode(undefined).condition, 'unknown');
  });
});

describe('value coercion', () => {
  it('normalises numbers, strings and booleans from loose upstream JSON', () => {
    assert.equal(num(12.5), 12.5);
    assert.equal(num('12.5'), 12.5);
    assert.equal(num(null), null);
    assert.equal(num(Number.NaN), null);
    assert.equal(num('abc'), null);

    assert.equal(str('x'), 'x');
    assert.equal(str(5), null);

    assert.equal(bool(1), true);
    assert.equal(bool(0), false);
    assert.equal(bool(true), true);
    assert.equal(bool('yes'), null);
  });

  it('returns an empty array for absent or malformed series', () => {
    assert.deepEqual(series({ time: ['a', 'b'] }, 'time'), ['a', 'b']);
    assert.deepEqual(series({ time: 'not-an-array' as never }, 'time'), []);
    assert.deepEqual(series(undefined, 'time'), []);
  });
});

describe('configuration', () => {
  it('defaults to the stdio transport and loopback HTTP bind', () => {
    clearEnv();
    const config = loadConfig([]);
    assert.equal(config.transport, 'stdio');
    assert.equal(config.http.host, '127.0.0.1');
    assert.equal(config.http.port, 3000);
    assert.equal(config.http.path, '/mcp');
    assert.equal(config.http.sessionMode, 'stateless');
    assert.equal(config.openMeteo.forecastBaseUrl, 'https://api.open-meteo.com');
    assert.equal(config.openMeteo.maxRetries, 2);
  });

  it('accepts the transport from the CLI flag, in both spellings', () => {
    clearEnv();
    assert.equal(loadConfig(['--transport', 'http']).transport, 'http');
    assert.equal(loadConfig(['--transport=stdio']).transport, 'stdio');
  });

  it('lets the CLI flag override the environment', () => {
    clearEnv();
    process.env['MCP_TRANSPORT'] = 'stdio';
    assert.equal(loadConfig(['--transport', 'http']).transport, 'http');
  });

  it('rejects an unknown transport', () => {
    clearEnv();
    assert.throws(() => loadConfig(['--transport', 'grpc']), /Unknown transport/);
  });

  it('rejects out-of-range and malformed values instead of silently coercing them', () => {
    clearEnv();
    process.env['MCP_PORT'] = '99999';
    assert.throws(() => loadConfig([]), /MCP_PORT must be between/);

    clearEnv();
    process.env['MCP_PORT'] = 'not-a-number';
    assert.throws(() => loadConfig([]), /must be an integer/);

    clearEnv();
    process.env['OPEN_METEO_FORECAST_URL'] = 'ftp://example.com';
    assert.throws(() => loadConfig([]), /not a valid http\(s\) URL/);

    clearEnv();
    process.env['LOG_LEVEL'] = 'verbose';
    assert.throws(() => loadConfig([]), /LOG_LEVEL must be one of/);
  });

  it('normalises the MCP path and strips trailing slashes from base URLs', () => {
    clearEnv();
    process.env['MCP_PATH'] = 'rpc/v1/';
    process.env['OPEN_METEO_FORECAST_URL'] = 'https://example.com/api/';
    const config = loadConfig([]);
    assert.equal(config.http.path, '/rpc/v1');
    assert.equal(config.openMeteo.forecastBaseUrl, 'https://example.com/api');
  });

  it('parses CORS origins, including the wildcard', () => {
    clearEnv();
    process.env['MCP_ALLOWED_ORIGINS'] = 'https://a.example, https://b.example';
    assert.deepEqual(loadConfig([]).http.allowedOrigins, ['https://a.example', 'https://b.example']);

    clearEnv();
    process.env['MCP_ALLOWED_ORIGINS'] = '*';
    assert.deepEqual(loadConfig([]).http.allowedOrigins, ['*']);
  });
});

describe('public bind safety', () => {
  it('refuses a non-loopback bind with no authentication', () => {
    clearEnv();
    process.env['MCP_HOST'] = '0.0.0.0';
    const config = loadConfig([]);
    assert.throws(() => assertSafeHttpBinding(config, () => {}), /Refusing to bind/);
  });

  it('allows a public bind once a token is configured', () => {
    clearEnv();
    process.env['MCP_HOST'] = '0.0.0.0';
    process.env['MCP_AUTH_TOKEN'] = 'secret';
    assert.doesNotThrow(() => assertSafeHttpBinding(loadConfig([]), () => {}));
  });

  it('allows an explicit opt-out, but warns loudly', () => {
    clearEnv();
    process.env['MCP_HOST'] = '0.0.0.0';
    process.env['MCP_ALLOW_UNAUTHENTICATED'] = 'true';
    const warnings: string[] = [];
    assert.doesNotThrow(() => assertSafeHttpBinding(loadConfig([]), (m) => warnings.push(m)));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /without MCP_AUTH_TOKEN/);
  });

  it('never complains about a loopback bind', () => {
    clearEnv();
    assert.doesNotThrow(() => assertSafeHttpBinding(loadConfig([]), () => {}));
  });
});

describe('Open-Meteo client', () => {
  const logger = createLogger('silent');

  function makeClient(options: {
    fetchImpl: typeof globalThis.fetch;
    maxRetries?: number;
    apiKey?: string;
    timeoutMs?: number;
  }) {
    return new OpenMeteoClient({
      baseUrl: 'https://api.example.com',
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs ?? 1000,
      maxRetries: options.maxRetries ?? 0,
      userAgent: 'test-agent/1.0',
      logger,
      fetchImpl: options.fetchImpl,
    });
  }

  it('builds query strings, expanding arrays and appending the API key', async () => {
    let seen: URL | undefined;
    const client = makeClient({
      apiKey: 'k-123',
      fetchImpl: async (input) => {
        seen = new URL(String(input));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    await client.getJson('/v1/forecast', {
      latitude: 55.75,
      longitude: 37.62,
      daily: ['temperature_2m_max', 'temperature_2m_min'],
      omitted: undefined,
    });

    assert.equal(seen?.origin, 'https://api.example.com');
    assert.equal(seen?.pathname, '/v1/forecast');
    assert.equal(seen?.searchParams.get('latitude'), '55.75');
    assert.equal(seen?.searchParams.get('daily'), 'temperature_2m_max,temperature_2m_min');
    assert.equal(seen?.searchParams.get('omitted'), null);
    assert.equal(seen?.searchParams.get('apikey'), 'k-123');
  });

  it('sends an identifying user agent', async () => {
    let headers: Headers | undefined;
    const client = makeClient({
      fetchImpl: async (_input, init) => {
        headers = new Headers(init?.headers);
        return new Response('{}', { status: 200 });
      },
    });
    await client.getJson('/v1/search', { name: 'Moscow' });
    assert.equal(headers?.get('user-agent'), 'test-agent/1.0');
  });

  it('surfaces the upstream reason on a 400 without retrying', async () => {
    let calls = 0;
    const client = makeClient({
      maxRetries: 3,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: true, reason: 'Latitude must be in range of -90 to 90°' }), {
          status: 400,
        });
      },
    });

    const error = await client.getJson('/v1/forecast', {}).catch((e: unknown) => e);
    assert.ok(error instanceof OpenMeteoError);
    assert.equal(error.kind, 'invalid_request');
    assert.equal(error.retryable, false);
    assert.match(error.message, /Latitude must be in range/);
    assert.equal(calls, 1, 'a malformed request must not be retried');
  });

  it('retries a 500 and succeeds on a later attempt', async () => {
    let calls = 0;
    const client = makeClient({
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) return new Response('upstream exploded', { status: 503 });
        return new Response(JSON.stringify({ latitude: 55.75 }), { status: 200 });
      },
    });

    const payload = await client.getJson<{ latitude: number }>('/v1/forecast', {});
    assert.equal(payload.latitude, 55.75);
    assert.equal(calls, 3);
  });

  it('gives up after the configured number of retries', async () => {
    let calls = 0;
    const client = makeClient({
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        return new Response('nope', { status: 502 });
      },
    });

    await assert.rejects(() => client.getJson('/v1/forecast', {}), (error: unknown) => {
      assert.ok(error instanceof OpenMeteoError);
      assert.equal(error.kind, 'upstream_error');
      assert.equal(error.retryable, true);
      return true;
    });
    assert.equal(calls, 3, 'initial attempt plus two retries');
  });

  it('classifies a network failure and retries it', async () => {
    let calls = 0;
    const client = makeClient({
      maxRetries: 1,
      fetchImpl: async () => {
        calls += 1;
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    });

    await assert.rejects(() => client.getJson('/v1/forecast', {}), (error: unknown) => {
      assert.ok(error instanceof OpenMeteoError);
      assert.equal(error.kind, 'network');
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    });
    assert.equal(calls, 2);
  });

  it('reports rate limiting as retryable', async () => {
    const client = makeClient({
      maxRetries: 0,
      fetchImpl: async () => new Response(JSON.stringify({ reason: 'Minutely API request limit exceeded' }), { status: 429 }),
    });

    await assert.rejects(() => client.getJson('/v1/forecast', {}), (error: unknown) => {
      assert.ok(error instanceof OpenMeteoError);
      assert.equal(error.kind, 'rate_limited');
      assert.equal(error.retryable, true);
      assert.match(error.toToolMessage(), /transient/);
      return true;
    });
  });

  it('rejects a non-JSON body instead of passing it on', async () => {
    const client = makeClient({
      fetchImpl: async () => new Response('<html>gateway error</html>', { status: 200 }),
    });

    await assert.rejects(() => client.getJson('/v1/forecast', {}), (error: unknown) => {
      assert.ok(error instanceof OpenMeteoError);
      assert.equal(error.kind, 'malformed_response');
      assert.equal(error.retryable, false);
      return true;
    });
  });

  it('aborts a request that exceeds the timeout', async () => {
    const client = makeClient({
      timeoutMs: 30,
      maxRetries: 0,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));
          });
        }),
    });

    await assert.rejects(() => client.getJson('/v1/forecast', {}), (error: unknown) => {
      assert.ok(error instanceof OpenMeteoError);
      assert.equal(error.kind, 'timeout');
      return true;
    });
  });

  it('stops retrying once the caller cancels', async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = makeClient({
      maxRetries: 3,
      fetchImpl: (_input, init) => {
        calls += 1;
        controller.abort();
        return new Promise((_resolve, reject) => {
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          // The signal may already be aborted by the time we look at it, in which
          // case the event will never fire again.
          if (init?.signal?.aborted === true) {
            fail();
            return;
          }
          init?.signal?.addEventListener('abort', fail);
        });
      },
    });

    await assert.rejects(() => client.getJson('/v1/forecast', {}, controller.signal), (error: unknown) => {
      assert.ok(error instanceof OpenMeteoError);
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls, 1);
  });
});
