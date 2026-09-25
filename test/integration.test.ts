import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { buildDeps, createServer } from '../src/server.js';
import { TOOL_NAMES } from '../src/tools/index.js';
import { startMockUpstream, type MockUpstream } from './mock-upstream.js';

/**
 * End-to-end coverage over a real MCP client/server pair.
 *
 * The client is a genuine SDK `Client`, so these tests exercise the actual
 * handshake, tool listing, JSON Schema generation, argument validation and
 * structured-output validation — not just the handler functions in isolation.
 */

let upstream: MockUpstream;
let client: Client;
let server: ReturnType<typeof createServer>;

function makeConfig(baseUrl: string): Config {
  return {
    transport: 'stdio',
    http: {
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      sessionMode: 'stateless',
      authToken: undefined,
      allowUnauthenticated: true,
      allowedOrigins: undefined,
      maxBodyBytes: 1_048_576,
      jsonResponse: true,
    },
    openMeteo: {
      forecastBaseUrl: baseUrl,
      geocodingBaseUrl: baseUrl,
      airQualityBaseUrl: baseUrl,
      apiKey: undefined,
      timeoutMs: 5000,
      maxRetries: 1,
      userAgent: 'open-meteo-mcp-test/1.0.0',
    },
    logLevel: 'silent',
  };
}

before(async () => {
  upstream = await startMockUpstream();
  const config = makeConfig(upstream.url);
  const logger = createLogger('silent');

  server = createServer(buildDeps(config, logger));
  client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

after(async () => {
  await client.close();
  await server.close();
  await upstream.close();
});

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function structured<T = Record<string, unknown>>(result: CallToolResult): T {
  assert.ok(result.structuredContent !== undefined, 'expected structuredContent to be present');
  return result.structuredContent as T;
}

function firstText(result: CallToolResult): string {
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === 'text', 'expected a text content block');
  return (block as { type: 'text'; text: string }).text;
}

describe('tool registration and parameter descriptions', () => {
  it('registers exactly the four documented tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [...TOOL_NAMES].sort(),
    );
  });

  it('gives every tool a title and a description long enough to guide a model', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.title !== undefined && tool.title.length > 0, `${tool.name}: missing title`);
      assert.ok(
        typeof tool.description === 'string' && tool.description.length > 80,
        `${tool.name}: description too short to be useful`,
      );
    }
  });

  it('documents every input parameter via the generated JSON Schema', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const schema = tool.inputSchema as { type?: string; properties?: Record<string, { description?: string }> };
      assert.equal(schema.type, 'object', `${tool.name}: input schema must be an object`);
      const properties = schema.properties ?? {};
      assert.ok(Object.keys(properties).length > 0, `${tool.name}: no input parameters declared`);

      for (const [param, definition] of Object.entries(properties)) {
        assert.ok(
          typeof definition.description === 'string' && definition.description.trim().length > 10,
          `${tool.name}.${param}: parameter is missing a usable description`,
        );
      }
      assert.ok(tool.outputSchema !== undefined, `${tool.name}: no outputSchema declared`);
    }
  });

  it('marks every tool as read-only and non-destructive', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name}: readOnlyHint`);
      assert.equal(tool.annotations?.destructiveHint, false, `${tool.name}: destructiveHint`);
    }
  });
});

describe('geocode_location', () => {
  it('returns candidates with coordinates and population for disambiguation', async () => {
    const result = await call('geocode_location', { name: 'Moscow', count: 5, language: 'en' });
    assert.notEqual(result.isError, true);

    const data = structured<{ results: Array<Record<string, unknown>>; ambiguous: boolean }>(result);
    assert.equal(data.results.length, 2);
    assert.equal(data.ambiguous, true);
    assert.equal(data.results[0]?.['countryCode'], 'RU');
    assert.equal(typeof data.results[0]?.['latitude'], 'number');
    assert.equal(data.results[0]?.['population'], 10381222);
  });

  it('narrows the search when a country code is supplied', async () => {
    const result = await call('geocode_location', { name: 'Moscow', countryCode: 'US' });
    const data = structured<{ results: Array<Record<string, unknown>>; ambiguous: boolean }>(result);
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0]?.['admin1'], 'Idaho');
    assert.equal(data.ambiguous, false);
  });

  it('returns an actionable message instead of throwing when nothing matches', async () => {
    const result = await call('geocode_location', { name: 'Atlantis' });
    assert.notEqual(result.isError, true);
    const data = structured<{ count: number; results: unknown[] }>(result);
    assert.equal(data.count, 0);
    assert.match(firstText(result), /No place matched/i);
  });

  it('rejects a country code that is not two letters', async () => {
    const result = await call('geocode_location', { name: 'Moscow', countryCode: 'RUS' });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /countryCode/i);
  });
});

describe('get_current_weather', () => {
  it('resolves a place name and returns decoded conditions', async () => {
    const result = await call('get_current_weather', { location: 'Moscow' });
    assert.notEqual(result.isError, true);

    const data = structured<Record<string, unknown>>(result);
    assert.equal(data['weather_code'], 61);
    assert.equal(data['condition'], 'slight_rain');
    assert.equal(data['condition_ru'], 'Небольшой дождь');
    assert.equal(data['temperature'], 12.4);
    assert.equal(data['is_day'], true);

    const location = data['location'] as Record<string, unknown>;
    assert.equal(location['resolvedFrom'], 'Moscow');
    assert.equal(location['timezone'], 'Europe/Moscow');

    const units = data['units'] as Record<string, string>;
    assert.equal(units['temperature'], '°C');
    assert.equal(units['wind_speed'], 'km/h');
  });

  it('accepts explicit coordinates without geocoding', async () => {
    upstream.requests.length = 0;
    const result = await call('get_current_weather', { latitude: 55.75, longitude: 37.62 });
    assert.notEqual(result.isError, true);

    const data = structured<Record<string, unknown>>(result);
    assert.equal((data['location'] as Record<string, unknown>)['resolvedFrom'], null);
    // Precise coordinates must not trigger an extra geocoding round trip.
    assert.equal(upstream.requests.filter((r) => r.path === '/v1/search').length, 0);
  });

  it('switches to imperial units when asked', async () => {
    const result = await call('get_current_weather', { location: 'Moscow', units: 'imperial' });
    const data = structured<Record<string, unknown>>(result);
    const units = data['units'] as Record<string, string>;
    assert.equal(units['temperature'], '°F');
    assert.equal(units['wind_speed'], 'mph');

    const lastForecast = upstream.requests.filter((r) => r.path === '/v1/forecast').at(-1);
    assert.equal(lastForecast?.query.get('temperature_unit'), 'fahrenheit');
    assert.equal(lastForecast?.query.get('wind_speed_unit'), 'mph');
  });

  it('explains how to fix a call that supplies half a coordinate pair', async () => {
    const result = await call('get_current_weather', { latitude: 55.75 });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /must be provided together/i);
  });

  it('explains how to fix a call with no location at all', async () => {
    const result = await call('get_current_weather', {});
    assert.equal(result.isError, true);
    assert.match(firstText(result), /latitude.*longitude|location/i);
  });

  it('suggests alternatives when the place cannot be geocoded', async () => {
    const result = await call('get_current_weather', { location: 'Nowhereville' });
    assert.equal(result.isError, true);
    assert.match(firstText(result), /No place matched/i);
  });

  it('reports an upstream 4xx as a tool error carrying the upstream reason', async () => {
    // -90 passes our own schema but the mock upstream rejects it, which is the
    // case that matters: valid arguments, upstream refuses.
    const result = await call('get_current_weather', { latitude: -90, longitude: 37.62 });
    assert.equal(result.isError, true);
    const text = firstText(result);
    assert.match(text, /invalid_request/);
    assert.match(text, /Latitude must be in range/);
    assert.match(text, /not an issue with the arguments|Invalid arguments|failed/i);
  });

  it('rejects out-of-range coordinates before any request is made', async () => {
    upstream.requests.length = 0;
    const result = await call('get_current_weather', { latitude: 200, longitude: 37.62 });
    assert.equal(result.isError, true);
    assert.equal(upstream.requests.length, 0, 'an invalid argument must never reach the network');
  });
});

describe('get_weather_forecast', () => {
  it('returns one aligned entry per requested day', async () => {
    const result = await call('get_weather_forecast', { location: 'Moscow', days: 5 });
    assert.notEqual(result.isError, true);

    const data = structured<{ days: Array<Record<string, unknown>>; days_requested: number; hourly: unknown }>(result);
    assert.equal(data.days_requested, 5);
    assert.equal(data.days.length, 5);
    assert.equal(data.hourly, null, 'hourly must be null when not requested');

    const first = data.days[0]!;
    assert.equal(first['date'], '2026-09-25');
    assert.equal(first['temperature_max'], 14);
    assert.equal(first['temperature_min'], 5);
    assert.equal(first['condition'], 'slight_rain');
    assert.equal(first['precipitation_probability_max'], 20);
    assert.equal(first['wind_gusts_max'], 31.7);
  });

  it('decodes each day independently rather than repeating one condition', async () => {
    const result = await call('get_weather_forecast', { location: 'Moscow', days: 7 });
    const data = structured<{ days: Array<Record<string, unknown>> }>(result);
    const codes = data.days.map((d) => d['weather_code']);
    assert.deepEqual(codes, [61, 3, 0, 2, 80, 95, 45]);
    assert.equal(data.days[2]?.['condition'], 'clear_sky');
    assert.equal(data.days[5]?.['condition'], 'thunderstorm');
  });

  it('includes an hourly series only when requested', async () => {
    const result = await call('get_weather_forecast', { location: 'Moscow', days: 2, include_hourly: true });
    const data = structured<{ hourly: Array<Record<string, unknown>> | null }>(result);
    assert.ok(Array.isArray(data.hourly));
    assert.equal(data.hourly?.length, 48);
    assert.equal(data.hourly?.[0]?.['time'], '2026-09-25T00:00');
  });

  it('forwards the requested day count upstream', async () => {
    upstream.requests.length = 0;
    await call('get_weather_forecast', { location: 'Moscow', days: 10 });
    const request = upstream.requests.find((r) => r.path === '/v1/forecast');
    assert.equal(request?.query.get('forecast_days'), '10');
  });

  it('rejects a day count beyond the free-tier horizon', async () => {
    const result = await call('get_weather_forecast', { location: 'Moscow', days: 30 });
    assert.equal(result.isError, true);
  });
});

describe('get_air_quality', () => {
  it('returns pollutants plus a decoded severity band and advice', async () => {
    const result = await call('get_air_quality', { location: 'Moscow' });
    assert.notEqual(result.isError, true);

    const data = structured<Record<string, unknown>>(result);
    assert.equal(data['european_aqi'], 60);
    assert.equal(data['us_aqi'], 96);
    assert.equal(data['aqi_band'], 'poor');
    assert.equal(data['aqi_band_ru'], 'Плохо');
    assert.match(String(data['aqi_advice']), /Sensitive groups/i);
    assert.equal(data['pm2_5'], 39.1);

    const units = data['units'] as Record<string, string>;
    assert.equal(units['particulate_matter'], 'μg/m³');
  });

  it('works from explicit coordinates', async () => {
    const result = await call('get_air_quality', { latitude: 48.85, longitude: 2.35 });
    assert.notEqual(result.isError, true);
    const data = structured<Record<string, unknown>>(result);
    assert.equal((data['location'] as Record<string, unknown>)['resolvedFrom'], null);
  });
});

describe('result shape contract', () => {
  it('returns both readable text and schema-validated structured content', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['geocode_location', { name: 'Paris' }],
      ['get_current_weather', { location: 'Paris' }],
      ['get_weather_forecast', { location: 'Paris', days: 3 }],
      ['get_air_quality', { location: 'Paris' }],
    ];

    for (const [name, args] of cases) {
      const result = await call(name, args);
      assert.notEqual(result.isError, true, `${name} unexpectedly failed: ${firstText(result)}`);

      const text = firstText(result);
      assert.ok(text.length > 20, `${name}: text content is too thin`);
      assert.ok(result.structuredContent !== undefined, `${name}: missing structuredContent`);
      assert.equal(typeof result.structuredContent, 'object', `${name}: structuredContent must be an object`);
      assert.ok(!Array.isArray(result.structuredContent), `${name}: structuredContent must not be an array`);
    }
  });
});
