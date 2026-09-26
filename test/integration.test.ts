import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { buildDeps, createServer } from '../src/server.js';
import type { ToolDeps } from '../src/tools/deps.js';
import { WatchService } from '../src/watch/service.js';
import { WatchStore } from '../src/watch/store.js';
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
let deps: ToolDeps;
let watchDataDir: string;

function makeConfig(
  baseUrl: string,
  watchDataDir: string,
  overrides: Partial<Config['openMeteo']> = {},
  watchOverrides: Partial<Config['watch']> = {},
): Config {
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
      // Exercise the default ensemble backend so the suite matches production.
      forecastPath: '/v1/ensemble',
      models: 'gfs05',
      geocodingBaseUrl: baseUrl,
      airQualityBaseUrl: baseUrl,
      apiKey: undefined,
      timeoutMs: 5000,
      maxRetries: 1,
      userAgent: 'open-meteo-mcp-test/1.0.0',
      ...overrides,
    },
    watch: {
      enabled: true,
      intervalSeconds: 900,
      retentionHours: 168,
      dataDir: watchDataDir,
      maxWatches: 20,
      ...watchOverrides,
    },
    logLevel: 'silent',
  };
}

/** Boots an isolated client/server pair so a test can vary the configuration. */
async function connectWith(config: Config): Promise<{ client: Client; close: () => Promise<void> }> {
  const isolatedDeps = buildDeps(config, createLogger('silent'));
  // Load persisted state but do NOT start the timer: the startup poll would add a
  // fresh sample and change what a windowed report sees.
  await isolatedDeps.watches.initialise();

  const server = createServer(isolatedDeps);
  const isolated = new Client({ name: 'test-client-isolated', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([isolated.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client: isolated,
    close: async () => {
      await isolated.close();
      await server.close();
    },
  };
}

before(async () => {
  // A real temp directory: the watcher persists to disk, and tests must not write
  // into the repository or share state between runs.
  watchDataDir = await mkdtemp(join(tmpdir(), 'open-meteo-mcp-test-'));
  upstream = await startMockUpstream();
  const config = makeConfig(upstream.url, watchDataDir);
  const logger = createLogger('silent');

  deps = buildDeps(config, logger);
  // Start the collector so its tools are usable, but the poller never fires: the
  // configured interval is 900 s and tests drive collection explicitly.
  await deps.watches.start();

  server = createServer(deps);
  client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

after(async () => {
  await deps.watches.stop();
  await client.close();
  await server.close();
  await upstream.close();
  await rm(watchDataDir, { recursive: true, force: true });
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
  it('registers exactly the documented tools', async () => {
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

      // A zero-argument tool such as list_weather_watches is legitimate, but when
      // parameters do exist every one of them must carry a usable description.
      for (const [param, definition] of Object.entries(properties)) {
        assert.ok(
          typeof definition.description === 'string' && definition.description.trim().length > 10,
          `${tool.name}.${param}: parameter is missing a usable description`,
        );
      }
      assert.ok(tool.outputSchema !== undefined, `${tool.name}: no outputSchema declared`);
    }
  });

  it('declares coherent annotations, including for state-changing tools', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const tool of tools) {
      assert.notEqual(tool.annotations?.readOnlyHint, undefined, `${tool.name}: readOnlyHint must be declared`);
      assert.notEqual(tool.annotations?.destructiveHint, undefined, `${tool.name}: destructiveHint must be declared`);
      // Nothing may claim to be read-only and destructive at the same time.
      assert.ok(
        !(tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === true),
        `${tool.name}: cannot be both read-only and destructive`,
      );
    }

    // The collection tools genuinely change server state, so they must not be
    // advertised as read-only — that would licence an agent to call them freely,
    // and stop_weather_watch deletes history.
    assert.equal(byName.get('start_weather_watch')?.annotations?.readOnlyHint, false);
    assert.equal(byName.get('stop_weather_watch')?.annotations?.readOnlyHint, false);
    // Pausing keeps every sample, so it must NOT be flagged destructive — an
    // agent that saw destructiveHint would hesitate or ask for confirmation.
    assert.equal(byName.get('stop_weather_watch')?.annotations?.destructiveHint, false);
    // Actually deleting history is destructive.
    assert.equal(byName.get('delete_weather_watch')?.annotations?.readOnlyHint, false);
    assert.equal(byName.get('delete_weather_watch')?.annotations?.destructiveHint, true);

    for (const name of [
      'geocode_location',
      'get_current_weather',
      'get_weather_forecast',
      'get_air_quality',
      'list_weather_watches',
      'get_weather_watch_report',
    ]) {
      assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} should be read-only`);
      assert.equal(byName.get(name)?.annotations?.destructiveHint, false, `${name} should be non-destructive`);
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

    const lastForecast = upstream.requests.filter((r) => r.path === '/v1/ensemble').at(-1);
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
    const request = upstream.requests.find((r) => r.path === '/v1/ensemble');
    assert.equal(request?.query.get('forecast_days'), '10');
  });

  it('uses the configured forecast path and sends the configured model', async () => {
    // The ensemble backend rejects `best_match`, so the model id must be sent;
    // and the request must go to the configured path, not a hardcoded one.
    upstream.requests.length = 0;
    await call('get_weather_forecast', { location: 'Moscow', days: 3 });

    const forecastRequests = upstream.requests.filter(
      (r) => r.path === '/v1/ensemble' || r.path === '/v1/forecast',
    );
    assert.equal(forecastRequests.length, 1, 'exactly one forecast request expected');
    assert.equal(forecastRequests[0]?.path, '/v1/ensemble');
    assert.equal(forecastRequests[0]?.query.get('models'), 'gfs05');
  });

  it('also sends the model on current-weather requests', async () => {
    upstream.requests.length = 0;
    await call('get_current_weather', { location: 'Moscow' });
    const request = upstream.requests.find((r) => r.path === '/v1/ensemble');
    assert.equal(request?.query.get('models'), 'gfs05');
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

describe('switching the forecast backend (the VPS configuration)', () => {
  it('talks to the standard forecast host when configured that way', async () => {
    // This is the configuration a VPS uses: the real api.open-meteo.com, which
    // also restores precipitation probability that the ensemble host lacks.
    upstream.requests.length = 0;
    const session = await connectWith(
      makeConfig(upstream.url, watchDataDir, {
        forecastPath: '/v1/forecast',
        models: '',
      }),
    );

    try {
      const result = (await session.client.callTool({
        name: 'get_weather_forecast',
        arguments: { location: 'Moscow', days: 3 },
      })) as CallToolResult;

      assert.notEqual(result.isError, true, firstText(result));

      const requests = upstream.requests.filter((r) => r.path === '/v1/forecast' || r.path === '/v1/ensemble');
      assert.equal(requests.length, 1, 'one forecast request expected');
      assert.equal(requests[0]?.path, '/v1/forecast', 'must use the standard path');
      // The standard host picks its own best_match when no model is named.
      assert.equal(requests[0]?.query.get('models'), null);
    } finally {
      await session.close();
    }
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

describe('periodic weather watches', () => {
  it('registers a watch, derives an id and collects the first sample immediately', async () => {
    const result = await call('start_weather_watch', { location: 'Paris', language: 'en' });
    assert.notEqual(result.isError, true, firstText(result));

    const data = structured<{
      watch: Record<string, unknown>;
      replaced_existing: boolean;
      interval_seconds: number;
      first_sample_status: string;
    }>(result);

    assert.equal(data.watch['id'], 'paris', 'id should be derived from the place label');
    assert.equal(data.watch['resolved_from'], 'Paris');
    assert.equal(data.interval_seconds, 900);
    assert.equal(data.replaced_existing, false);
    // The first sample is awaited, so the caller can report on real data at once.
    assert.match(data.first_sample_status, /collected/);
  });

  it('accepts an explicit id and raw coordinates', async () => {
    const result = await call('start_weather_watch', {
      id: 'spb-center',
      latitude: 59.9386,
      longitude: 30.3141,
      units: 'imperial',
      language: 'ru',
    });
    assert.notEqual(result.isError, true, firstText(result));

    const data = structured<{ watch: Record<string, unknown> }>(result);
    assert.equal(data.watch['id'], 'spb-center');
    assert.equal(data.watch['resolved_from'], null, 'coordinates should not be geocoded');
    assert.equal(data.watch['units'], 'imperial');
  });

  it('lists watches with collection health', async () => {
    const result = await call('list_weather_watches', {});
    assert.notEqual(result.isError, true, firstText(result));

    const data = structured<{
      count: number;
      interval_seconds: number;
      data_directory: string;
      watches: Array<Record<string, unknown>>;
    }>(result);

    assert.ok(data.count >= 2, 'the two watches registered above should be listed');
    assert.equal(data.interval_seconds, 900);
    assert.equal(data.data_directory, watchDataDir);

    const paris = data.watches.find((entry) => (entry['definition'] as Record<string, unknown>)['id'] === 'paris');
    assert.ok(paris !== undefined);
    assert.equal(paris['healthy'], true);
    assert.ok((paris['sample_count'] as number) >= 1);
    assert.equal(typeof paris['staleness_minutes'], 'number');
  });

  it('aggregates a report over the collected samples', async () => {
    const result = await call('get_weather_watch_report', { id: 'paris', window_hours: 24 });
    assert.notEqual(result.isError, true, firstText(result));

    const data = structured<{
      aggregate: Record<string, unknown>;
      stored_samples: number;
      samples: unknown[];
    }>(result);
    const agg = data.aggregate as Record<string, any>;

    assert.ok(data.stored_samples >= 1);
    assert.equal(agg['window_hours'], 24);
    assert.ok(agg['sample_count'] >= 1);
    assert.ok(
      typeof agg['observed_span_minutes'] === 'number',
      'the report must state the period the samples span',
    );
    assert.equal('coverage_percent' in agg, false, 'no coverage quota may be exposed');
    assert.equal(agg['temperature']['min'], 12.4, 'the mock reports 12.4 °C');
    assert.equal(agg['apparent_temperature']['min'], 10.9, 'the mock reports 10.9 °C feels-like');
    assert.equal(agg['dominant_condition']['condition'], 'slight_rain');
    assert.equal(agg['dominant_condition']['share_percent'], 100);
    assert.equal(agg['samples_with_precipitation'], 1);

    // Raw samples stay out unless explicitly requested.
    assert.deepEqual(data.samples, []);
  });

  it('includes raw samples only when asked', async () => {
    const result = await call('get_weather_watch_report', { id: 'paris', include_samples: true });
    const data = structured<{ samples: Array<Record<string, unknown>> }>(result);
    assert.ok(data.samples.length >= 1);
    assert.equal(typeof data.samples[0]?.['at'], 'string');
    assert.equal(typeof data.samples[0]?.['observed_at'], 'string');
    assert.equal(data.samples[0]?.['condition'], 'slight_rain');
  });

  it('explains how to recover from an unknown watch id', async () => {
    const result = await call('get_weather_watch_report', { id: 'does-not-exist' });
    assert.equal(result.isError, true);
    const text = firstText(result);
    assert.match(text, /does-not-exist/);
    assert.match(text, /list_weather_watches/);
  });

  it('rejects an id that could not be used as a filename', async () => {
    const result = await call('start_weather_watch', { id: '../escape', location: 'Paris' });
    assert.equal(result.isError, true);
  });

  it('replaces a watch when the same id is reused', async () => {
    const first = await call('start_weather_watch', { id: 'repeat', location: 'Paris' });
    assert.equal(structured<{ replaced_existing: boolean }>(first).replaced_existing, false);

    const second = await call('start_weather_watch', { id: 'repeat', location: 'London', countryCode: 'GB' });
    assert.notEqual(second.isError, true, firstText(second));
    assert.equal(structured<{ replaced_existing: boolean }>(second).replaced_existing, true);
    assert.equal(structured<{ watch: Record<string, unknown> }>(second).watch['resolved_from'], 'London');
  });

  it('pausing stops collection but keeps the history, and resuming continues it', async () => {
    await call('start_weather_watch', { id: 'pausable', location: 'Paris' });

    const paused = await call('stop_weather_watch', { id: 'pausable' });
    assert.notEqual(paused.isError, true, firstText(paused));
    const pauseData = structured<{
      found: boolean;
      already_stopped: boolean;
      stored_samples: number;
    }>(paused);
    assert.equal(pauseData.found, true);
    assert.equal(pauseData.already_stopped, false);
    assert.ok(pauseData.stored_samples >= 1, 'pausing must not delete samples');
    assert.match(firstText(paused), /kept/i);

    // The history is still readable after pausing.
    const report = await call('get_weather_watch_report', { id: 'pausable' });
    assert.notEqual(report.isError, true, firstText(report));
    assert.ok(structured<{ stored_samples: number }>(report).stored_samples >= 1);
    assert.match(firstText(report), /PAUSED/, 'the report must say the watch is paused');

    // It is no longer polled.
    const listed = await call('list_weather_watches', {});
    const entry = structured<{ watches: Array<Record<string, unknown>> }>(listed).watches.find(
      (w) => (w['definition'] as Record<string, unknown>)['id'] === 'pausable',
    );
    assert.equal(entry?.['enabled'], false);

    // Pausing twice is not an error and still keeps the data.
    const again = await call('stop_weather_watch', { id: 'pausable' });
    assert.notEqual(again.isError, true);
    assert.equal(structured<{ already_stopped: boolean }>(again).already_stopped, true);
    assert.ok(structured<{ stored_samples: number }>(again).stored_samples >= 1);

    // Resuming re-enables collection and preserves the accumulated samples.
    const before = structured<{ stored_samples: number }>(
      await call('get_weather_watch_report', { id: 'pausable' }),
    ).stored_samples;

    const resumed = await call('start_weather_watch', { id: 'pausable', location: 'Paris' });
    assert.notEqual(resumed.isError, true, firstText(resumed));
    const after = structured<{ stored_samples: number }>(
      await call('get_weather_watch_report', { id: 'pausable' }),
    ).stored_samples;
    assert.ok(after > before, 'resuming must add a sample to the existing history');
  });

  it('reports clearly when pausing an unknown watch', async () => {
    const result = await call('stop_weather_watch', { id: 'never-existed' });
    assert.notEqual(result.isError, true, firstText(result));
    const data = structured<{ found: boolean }>(result);
    assert.equal(data.found, false);
    assert.match(firstText(result), /list_weather_watches/);
  });

  it('deletes a watch and its history only when explicitly confirmed', async () => {
    await call('start_weather_watch', { id: 'doomed', location: 'Paris' });

    // The confirm flag is a deliberate speed bump; omitting it must be refused.
    const unconfirmed = await call('delete_weather_watch', { id: 'doomed' });
    assert.equal(unconfirmed.isError, true);
    assert.match(firstText(unconfirmed), /confirm/i);

    // The watch survives a refused deletion.
    assert.notEqual((await call('get_weather_watch_report', { id: 'doomed' })).isError, true);

    const deleted = await call('delete_weather_watch', { id: 'doomed', confirm: true });
    assert.notEqual(deleted.isError, true, firstText(deleted));
    const data = structured<{ deleted: boolean; deleted_samples: number }>(deleted);
    assert.equal(data.deleted, true);
    assert.ok(data.deleted_samples >= 1, 'the response should say how much history was destroyed');

    // History is gone, so a report can no longer be produced.
    assert.equal((await call('get_weather_watch_report', { id: 'doomed' })).isError, true);
  });

  it('reports nothing deleted for an unknown id', async () => {
    const result = await call('delete_weather_watch', { id: 'never-existed', confirm: true });
    assert.notEqual(result.isError, true, firstText(result));
    assert.equal(structured<{ deleted: boolean }>(result).deleted, false);
  });

  it('persists watches and samples across a restart of the collector', async () => {
    await call('start_weather_watch', { id: 'survivor', location: 'Paris' });

    // A second service instance on the same directory models a container restart:
    // in-memory state is gone, only the JSON on disk remains.
    const restarted = new WatchService({
      config: makeConfig(upstream.url, watchDataDir),
      source: { clients: deps.clients, config: makeConfig(upstream.url, watchDataDir) },
      logger: createLogger('silent'),
    });
    await restarted.start();
    try {
      assert.equal(restarted.has('survivor'), true, 'the watch registry must survive a restart');

      const report = restarted.report('survivor', 24, true);
      assert.ok(report !== null);
      assert.ok(report.stored_samples >= 1, 'stored samples must survive a restart');
      assert.equal(report.samples[0]?.['condition'], 'slight_rain');
    } finally {
      await restarted.stop();
    }
  });

  it('enforces the configured watch limit', async () => {
    // Its own directory: the registry is persisted, so watches created by other
    // tests would otherwise already be at the limit before this one starts.
    const limitDir = await mkdtemp(join(tmpdir(), 'open-meteo-mcp-limit-'));
    const limited = await connectWith(makeConfig(upstream.url, limitDir, {}, { maxWatches: 1 }));
    try {
      const first = (await limited.client.callTool({
        name: 'start_weather_watch',
        arguments: { id: 'only-one', location: 'Paris' },
      })) as CallToolResult;
      assert.notEqual(first.isError, true, firstText(first));

      const second = (await limited.client.callTool({
        name: 'start_weather_watch',
        arguments: { id: 'one-too-many', location: 'Paris' },
      })) as CallToolResult;
      assert.equal(second.isError, true);
      assert.match(firstText(second), /limit/i);

      // Replacing the existing watch is still allowed at the limit.
      const replace = (await limited.client.callTool({
        name: 'start_weather_watch',
        arguments: { id: 'only-one', location: 'Paris' },
      })) as CallToolResult;
      assert.notEqual(replace.isError, true, firstText(replace));
    } finally {
      await limited.close();
      await rm(limitDir, { recursive: true, force: true });
    }
  });

  it('disables the watch tools with an actionable message when storage is unusable', async () => {
    // A path under a regular file can never be created, which is how a read-only
    // container without a mounted volume behaves.
    const blocker = join(watchDataDir, 'blocker');
    await writeFile(blocker, 'x', 'utf8');

    const broken = await connectWith(makeConfig(upstream.url, join(blocker, 'data')));
    try {
      const result = (await broken.client.callTool({
        name: 'start_weather_watch',
        arguments: { location: 'Paris' },
      })) as CallToolResult;

      assert.equal(result.isError, true);
      const text = firstText(result);
      assert.match(text, /not writable/i);
      assert.match(text, /WATCH_DATA_DIR|volume/i, 'the message must say how to fix it');

      // Listing still works so an operator can see the state.
      const listed = (await broken.client.callTool({
        name: 'list_weather_watches',
        arguments: {},
      })) as CallToolResult;
      assert.notEqual(listed.isError, true, firstText(listed));
    } finally {
      await broken.close();
    }
  });
});

describe('report windows versus available history', () => {
  it('returns whatever exists when the window is far longer than the history', async () => {
    // A freshly registered watch has only a few minutes of data, but asking for
    // 24 h must still succeed and simply aggregate what is there.
    await call('start_weather_watch', { id: 'partial', location: 'Paris' });

    const result = await call('get_weather_watch_report', { id: 'partial', window_hours: 24 });
    assert.notEqual(result.isError, true, firstText(result));

    const data = structured<{ aggregate: Record<string, any>; stored_samples: number }>(result);
    assert.equal(data.aggregate['window_hours'], 24);
    assert.ok(data.aggregate['sample_count'] >= 1, 'the few available samples must be returned');
    // A short span is stated plainly. It must NOT be framed as "N of 96", which
    // is what made a task agent refuse to summarise the data it had.
    assert.equal(typeof data.aggregate['observed_span_minutes'], 'number');
    assert.equal('expected_samples' in data.aggregate, false);
    assert.equal('coverage_percent' in data.aggregate, false);
    assert.match(firstText(result), /covering .* min of the requested 24 h/);
  });

  it('distinguishes an empty window from a watch with no history at all', async () => {
    // Seed history that is inside retention but outside the requested window, so
    // the two cases cannot be confused.
    const historicDir = await mkdtemp(join(tmpdir(), 'open-meteo-mcp-historic-'));
    const store = new WatchStore(historicDir, createLogger('silent'));
    await store.ensureWritable();

    const tenHoursAgo = new Date(Date.now() - 10 * 3_600_000).toISOString();
    await store.saveRegistry(
      [
        {
          id: 'historic',
          label: 'Historic place',
          latitude: 55.75,
          longitude: 37.61,
          country: null,
          admin1: null,
          timezone: 'Europe/Moscow',
          resolved_from: null,
          units: 'metric',
          language: 'en',
          created_at: tenHoursAgo,
        },
      ],
      new Map(),
    );
    await store.appendSample(
      {
        watch_id: 'historic',
        at: tenHoursAgo,
        observed_at: tenHoursAgo,
        timezone: 'Europe/Moscow',
        is_day: true,
        weather_code: 61,
        condition: 'slight_rain',
        condition_en: 'Slight rain',
        condition_ru: 'Небольшой дождь',
        temperature: 9,
        apparent_temperature: 7,
        relative_humidity: 80,
        precipitation: 0.4,
        cloud_cover: 90,
        pressure_msl: 1008,
        wind_speed: 4,
        wind_direction: 200,
        wind_gusts: 8,
      },
      168,
    );

    // A one hour window cannot reach a sample taken ten hours ago.
    const session = await connectWith(makeConfig(upstream.url, historicDir));
    try {
      const result = (await session.client.callTool({
        name: 'get_weather_watch_report',
        arguments: { id: 'historic', window_hours: 1 },
      })) as CallToolResult;

      assert.notEqual(result.isError, true, firstText(result));
      const text = firstText(result);
      const data = result.structuredContent as { stored_samples: number; aggregate: Record<string, unknown> };

      assert.equal(data.stored_samples, 1, 'the older sample is still on disk');
      assert.equal(data.aggregate['sample_count'], 0, 'but it is outside the window');
      assert.match(text, /window is empty/i);
      assert.match(text, /does hold 1 older sample/i, 'must not claim there is no data at all');
      assert.match(text, /window_hours/, 'must tell the caller how to reach it');
      assert.doesNotMatch(text, /Nothing has been collected/i);
    } finally {
      await session.close();
      await rm(historicDir, { recursive: true, force: true });
    }
  });

  it('says nothing has been collected when the watch truly has no history', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'open-meteo-mcp-empty-'));
    const store = new WatchStore(emptyDir, createLogger('silent'));
    await store.ensureWritable();
    await store.saveRegistry(
      [
        {
          id: 'blank',
          label: 'Never collected',
          latitude: 55.75,
          longitude: 37.61,
          country: null,
          admin1: null,
          timezone: null,
          resolved_from: null,
          units: 'metric',
          language: 'en',
          created_at: new Date().toISOString(),
        },
      ],
      new Map(),
    );

    const session = await connectWith(makeConfig(upstream.url, emptyDir));
    try {
      const result = (await session.client.callTool({
        name: 'get_weather_watch_report',
        arguments: { id: 'blank', window_hours: 24 },
      })) as CallToolResult;

      assert.notEqual(result.isError, true, firstText(result));
      const text = firstText(result);
      assert.match(text, /Nothing has been collected/i);
      assert.match(text, /15 minutes/, 'should explain how often sampling happens');
      assert.doesNotMatch(text, /older sample/i);
    } finally {
      await session.close();
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('duplicate location handling', () => {
  // This block needs its own data directory: the shared server already holds
  // watches for London and Paris from earlier tests, and deduplication is exactly
  // what those would interfere with.
  let dedupClient: Client;
  let dedupClose: () => Promise<void>;
  let dedupDir: string;

  const dedupCall = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
    (await dedupClient.callTool({ name, arguments: args })) as CallToolResult;

  before(async () => {
    dedupDir = await mkdtemp(join(tmpdir(), 'open-meteo-mcp-dedup-'));
    const session = await connectWith(makeConfig(upstream.url, dedupDir));
    dedupClient = session.client;
    dedupClose = session.close;
  });

  after(async () => {
    await dedupClose();
    await rm(dedupDir, { recursive: true, force: true });
  });

  it('reuses an existing watch instead of creating a suffixed duplicate', async () => {
    // This is the exact bug that produced "ekaterinburg-2" and "-3": calling start
    // twice by place name used to derive a fresh id each time.
    const first = await dedupCall('start_weather_watch', { location: 'London', countryCode: 'GB' });
    assert.notEqual(first.isError, true, firstText(first));
    const firstData = structured<{ watch: Record<string, unknown>; reused_existing_location: boolean }>(first);
    assert.equal(firstData.reused_existing_location, false, 'the first registration is not a reuse');

    const second = await dedupCall('start_weather_watch', { location: 'London', countryCode: 'GB' });
    assert.notEqual(second.isError, true, firstText(second));
    const secondData = structured<{ watch: Record<string, unknown>; reused_existing_location: boolean }>(second);

    assert.equal(secondData.reused_existing_location, true);
    assert.equal(secondData.watch['id'], firstData.watch['id'], 'the same watch must be reused, not a -2 copy');
    assert.match(firstText(second), /already tracked/i);

    const listed = await dedupCall('list_weather_watches', {});
    const london = structured<{ watches: Array<Record<string, unknown>> }>(listed).watches.filter(
      (entry) => (entry['definition'] as Record<string, unknown>)['resolved_from'] === 'London',
    );
    assert.equal(london.length, 1, 'only one watch may exist per point');
  });

  it('resumes the existing watch when start is called again for a paused location', async () => {
    const started = await dedupCall('start_weather_watch', { location: 'Paris', countryCode: 'FR' });
    const id = structured<{ watch: Record<string, unknown> }>(started).watch['id'] as string;

    await dedupCall('stop_weather_watch', { id });

    const restarted = await dedupCall('start_weather_watch', { location: 'Paris', countryCode: 'FR' });
    assert.notEqual(restarted.isError, true, firstText(restarted));
    const data = structured<{ watch: Record<string, unknown>; reused_existing_location: boolean }>(restarted);

    assert.equal(data.watch['id'], id, 'resuming must target the same watch');
    assert.equal(data.reused_existing_location, true);
    // The wording may be "resuming" (reuse path) or "Resumed" (plain restart).
    assert.match(firstText(restarted), /resum(ed|ing)/i);
  });

  it('still creates a separate watch when an explicit id is given for the same point', async () => {
    // Naming an id is a deliberate request; deduplication must not override it.
    const auto = await dedupCall('start_weather_watch', { location: 'London', countryCode: 'GB' });
    const autoId = structured<{ watch: Record<string, unknown> }>(auto).watch['id'] as string;

    const explicit = await dedupCall('start_weather_watch', {
      id: 'london-second',
      location: 'London',
      countryCode: 'GB',
    });
    assert.notEqual(explicit.isError, true, firstText(explicit));
    const data = structured<{ watch: Record<string, unknown>; reused_existing_location: boolean }>(explicit);

    assert.equal(data.watch['id'], 'london-second');
    assert.equal(data.reused_existing_location, false, 'an explicit id must not be deduplicated away');
    assert.notEqual(data.watch['id'], autoId);
  });

  it('keeps the original creation time when reusing a watch', async () => {
    const first = await dedupCall('start_weather_watch', { location: 'Paris', countryCode: 'FR' });
    const createdAt = structured<{ watch: Record<string, unknown> }>(first).watch['created_at'];

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await dedupCall('start_weather_watch', { location: 'Paris', countryCode: 'FR' });
    const after = structured<{ watch: Record<string, unknown> }>(second).watch['created_at'];
    assert.equal(after, createdAt, 'reuse is not a re-creation');
  });

  it('registers a distinct watch for a different point with the same name', async () => {
    // Moscow exists in both RU and US; these are genuinely different places.
    const ru = await dedupCall('start_weather_watch', { location: 'Moscow', countryCode: 'RU' });
    const us = await dedupCall('start_weather_watch', { location: 'Moscow', countryCode: 'US' });

    assert.notEqual(ru.isError, true, firstText(ru));
    assert.notEqual(us.isError, true, firstText(us));

    const ruId = structured<{ watch: Record<string, unknown> }>(ru).watch['id'];
    const usId = structured<{ watch: Record<string, unknown> }>(us).watch['id'];
    assert.notEqual(ruId, usId, 'different coordinates must stay separate watches');
    assert.equal(structured<{ reused_existing_location: boolean }>(us).reused_existing_location, false);
  });
});

describe('reports are self-contained about time', () => {
  it('states when the report was generated, in UTC and in the location timezone', async () => {
    await call('start_weather_watch', { id: 'timestamped', location: 'Moscow', countryCode: 'RU' });

    const before = Date.now();
    const result = await call('get_weather_watch_report', { id: 'timestamped', window_hours: 24 });
    const after = Date.now();
    assert.notEqual(result.isError, true, firstText(result));

    const data = structured<{ generated_at: string; generated_at_local: string | null }>(result);
    const generated = Date.parse(data.generated_at);

    // The stamp must be a real instant inside the call window, not a placeholder.
    assert.ok(Number.isFinite(generated), 'generated_at must be a parsable timestamp');
    assert.ok(generated >= before - 1000 && generated <= after + 1000, 'generated_at must be the current instant');

    // The mock geocodes Moscow to a known timezone, so a local rendering exists.
    assert.equal(typeof data.generated_at_local, 'string');
    assert.match(firstText(result), /generated at:? \d{4}-\d{2}-\d{2}T[\d:.]+Z \(UTC\)/);
  });

  it('states when a listing was generated', async () => {
    const result = await call('list_weather_watches', {});
    assert.notEqual(result.isError, true, firstText(result));

    const data = structured<{ generated_at: string }>(result);
    assert.ok(Number.isFinite(Date.parse(data.generated_at)));
    assert.match(firstText(result), /generated at:? \d{4}-\d{2}-\d{2}T[\d:.]+Z \(UTC\)/);
  });

  it('makes the staleness figure interpretable against a known instant', async () => {
    const result = await call('get_weather_watch_report', { id: 'timestamped', window_hours: 24 });
    const data = structured<{
      generated_at: string;
      aggregate: { last_sample_at: string | null; staleness_minutes: number | null };
    }>(result);

    const agg = data.aggregate;
    assert.ok(agg.last_sample_at !== null && agg.staleness_minutes !== null);

    // staleness_minutes must actually equal generated_at - last_sample_at, which is
    // only checkable because the report now states its own instant.
    const expected = (Date.parse(data.generated_at) - Date.parse(agg.last_sample_at!)) / 60_000;
    assert.ok(
      Math.abs(expected - agg.staleness_minutes!) <= 1,
      `staleness (${agg.staleness_minutes}) should match the gap to generated_at (${expected})`,
    );
  });
});
