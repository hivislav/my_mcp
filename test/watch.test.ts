import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { aggregate, summarise, tallyConditions, trendOf } from '../src/watch/aggregate.js';
import { WatchStore, isValidWatchId, sanitiseId } from '../src/watch/store.js';
import type { WatchSample } from '../src/watch/types.js';
import { createLogger } from '../src/logger.js';
import { formatOffset, hasOffset, offsetForZone, qualifyTimestamp } from '../src/weather/time.js';

const logger = createLogger('silent');

/** Builds a sample with sensible defaults so each test states only what it cares about. */
function sample(overrides: Partial<WatchSample> & { at: string }): WatchSample {
  return {
    watch_id: 'test',
    observed_at: overrides.at,
    timezone: 'Europe/Moscow',
    is_day: true,
    weather_code: 61,
    condition: 'slight_rain',
    condition_en: 'Slight rain',
    condition_ru: 'Небольшой дождь',
    temperature: 10,
    apparent_temperature: 8,
    relative_humidity: 70,
    precipitation: 0,
    cloud_cover: 80,
    pressure_msl: 1010,
    wind_speed: 5,
    wind_direction: 180,
    wind_gusts: 9,
    ...overrides,
  };
}

/** Fixed clock so every window and staleness calculation is deterministic. */
const NOW = Date.parse('2026-09-25T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe('numeric summaries', () => {
  it('returns nulls and an unknown trend for an empty series', () => {
    assert.deepEqual(summarise([]), { min: null, max: null, avg: null, change: null, trend: 'unknown' });
  });

  it('ignores nulls rather than treating them as zero', () => {
    // A provider that omits a field must not drag the average towards zero.
    const summary = summarise([10, null, 20, null]);
    assert.equal(summary.min, 10);
    assert.equal(summary.max, 20);
    assert.equal(summary.avg, 15);
  });

  it('reports min, max, average and the endpoint change', () => {
    const summary = summarise([5, 10, 15]);
    assert.equal(summary.min, 5);
    assert.equal(summary.max, 15);
    assert.equal(summary.avg, 10);
    assert.equal(summary.change, 10);
  });

  it('detects direction from the halves, not from noisy endpoints', () => {
    // Rises overall, but the last reading dips: endpoint comparison would say
    // "falling" while the halves correctly say "rising".
    assert.equal(summarise([10, 20, 30, 29]).trend, 'rising');
    assert.equal(summarise([30, 20, 10, 11]).trend, 'falling');
    assert.equal(summarise([10, 10.2, 10.1, 10.3]).trend, 'steady');
  });

  it('classifies trends at the epsilon boundary', () => {
    assert.equal(trendOf(10, 10.5), 'steady', 'exactly at the threshold is steady');
    assert.equal(trendOf(10, 10.6), 'rising');
    assert.equal(trendOf(10, 9.4), 'falling');
    assert.equal(trendOf(null, 10), 'unknown');
  });
});

describe('condition tally', () => {
  it('orders by frequency and computes shares', () => {
    const tally = tallyConditions([
      sample({ at: minutesAgo(30), condition: 'cloudy', condition_en: 'Cloudy', condition_ru: 'Пасмурно' }),
      sample({ at: minutesAgo(20), condition: 'cloudy', condition_en: 'Cloudy', condition_ru: 'Пасмурно' }),
      sample({ at: minutesAgo(10), condition: 'clear_sky', condition_en: 'Clear sky', condition_ru: 'Ясно' }),
    ]);

    assert.equal(tally.length, 2);
    assert.equal(tally[0]?.condition, 'cloudy');
    assert.equal(tally[0]?.samples, 2);
    assert.equal(tally[0]?.share_percent, 67);
    assert.equal(tally[1]?.condition, 'clear_sky');
    assert.equal(tally[1]?.share_percent, 33);
  });

  it('returns nothing for an empty window', () => {
    assert.deepEqual(tallyConditions([]), []);
  });
});

describe('aggregation over a window', () => {
  it('excludes samples older than the window', () => {
    const result = aggregate(
      [
        sample({ at: minutesAgo(600), temperature: 100 }), // 10 h ago, outside a 1 h window
        sample({ at: minutesAgo(30), temperature: 10 }),
        sample({ at: minutesAgo(10), temperature: 12 }),
      ],
      { windowHours: 1, now: NOW },
    );

    assert.equal(result.sample_count, 2);
    assert.equal(result.temperature.max, 12, 'the out-of-window outlier must not leak in');
  });

  it('reports the period the samples actually span', () => {
    const samples = Array.from({ length: 6 }, (_, index) =>
      sample({ at: minutesAgo(index * 10), temperature: 10 + index }),
    );
    const result = aggregate(samples, { windowHours: 1, now: NOW });

    assert.equal(result.sample_count, 6);
    assert.equal(result.observed_span_minutes, 50, 'oldest to newest is 5 x 10 minutes');
  });

  it('describes a partial window as a short span, never as a failure', () => {
    // Three samples over 20 minutes, asked for 24 hours. This must read as a
    // factual short span, with no "expected" quota that a caller could fail.
    const result = aggregate(
      [sample({ at: minutesAgo(20) }), sample({ at: minutesAgo(10) }), sample({ at: minutesAgo(0) })],
      { windowHours: 24, now: NOW },
    );

    assert.equal(result.window_hours, 24);
    assert.equal(result.sample_count, 3);
    assert.equal(result.observed_span_minutes, 20);
    assert.equal('expected_samples' in result, false, 'no quota field may be exposed');
    assert.equal('coverage_percent' in result, false, 'no percentage may be exposed');
  });

  it('reports a zero span for a single sample rather than inventing one', () => {
    const result = aggregate([sample({ at: minutesAgo(5) })], { windowHours: 24, now: NOW });
    assert.equal(result.sample_count, 1);
    assert.equal(result.observed_span_minutes, 0);
  });

  it('reports staleness from the newest sample', () => {
    const result = aggregate([sample({ at: minutesAgo(45) })], {
      windowHours: 24,
      intervalSeconds: 600,
      now: NOW,
    });
    assert.equal(result.staleness_minutes, 45);
    assert.equal(result.last_sample_at, minutesAgo(45));
  });

  it('sums precipitation and counts the samples that actually had any', () => {
    const result = aggregate(
      [
        sample({ at: minutesAgo(30), precipitation: 0.5 }),
        sample({ at: minutesAgo(20), precipitation: 0 }),
        sample({ at: minutesAgo(10), precipitation: 1.5 }),
      ],
      { windowHours: 1, now: NOW },
    );

    assert.equal(result.precipitation_total, 2);
    assert.equal(result.precipitation_max, 1.5);
    assert.equal(result.samples_with_precipitation, 2);
  });

  it('returns a coherent empty aggregate when nothing was collected', () => {
    const result = aggregate([], { windowHours: 24, now: NOW });
    assert.equal(result.sample_count, 0);
    assert.equal(result.observed_span_minutes, null);
    assert.equal(result.last_sample_at, null);
    assert.equal(result.staleness_minutes, null);
    assert.equal(result.dominant_condition, null);
    assert.equal(result.precipitation_total, null);
    assert.equal(result.temperature.trend, 'unknown');
  });

  it('sorts samples by time so trend direction is unambiguous', () => {
    const result = aggregate(
      [
        sample({ at: minutesAgo(10), temperature: 20 }),
        sample({ at: minutesAgo(30), temperature: 5 }),
        sample({ at: minutesAgo(20), temperature: 10 }),
      ],
      { windowHours: 1, now: NOW },
    );

    assert.equal(result.first_sample_at, minutesAgo(30));
    assert.equal(result.last_sample_at, minutesAgo(10));
    assert.equal(result.temperature.change, 15);
    assert.equal(result.temperature.trend, 'rising');
  });

});

describe('watch store', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'open-meteo-mcp-store-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts a writable directory', async () => {
    const target = join(dir, 'writable');
    const store = new WatchStore(target, logger);
    assert.deepEqual(await store.ensureWritable(), { ok: true });
    assert.equal(store.writable, true);
  });

  it('reports a clear failure for an unwritable directory', async () => {
    // A path underneath a regular file can never be created, which is how a
    // read-only container filesystem without a mounted volume behaves.
    const filePath = join(dir, 'not-a-dir');
    await writeFile(filePath, 'x', 'utf8');

    const store = new WatchStore(join(filePath, 'data'), logger);
    const result = await store.ensureWritable();
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; reason: string }).reason, /ENOTDIR|EEXIST|ENOENT|not a directory/i);
    assert.equal(store.writable, false);
  });

  it('round-trips definitions and stats through the registry file', async () => {
    const store = new WatchStore(join(dir, 'registry'), logger);
    await store.ensureWritable();

    const definition = {
      id: 'moscow',
      label: 'Москва, Россия',
      latitude: 55.75204,
      longitude: 37.61781,
      country: 'Россия',
      admin1: 'Москва',
      timezone: 'Europe/Moscow',
      resolved_from: 'Москва',
      units: 'metric' as const,
      language: 'ru',
      created_at: '2026-09-25T12:00:00.000Z',
    };
    const stats = new Map([
      [
        'moscow',
        {
          last_attempt_at: '2026-09-25T12:10:00.000Z',
          last_success_at: '2026-09-25T12:10:00.000Z',
          consecutive_failures: 0,
          last_error: null,
          total_samples: 3,
          total_failures: 1,
        },
      ],
    ]);

    await store.saveRegistry([definition], stats);
    const loaded = await store.loadRegistry();

    assert.equal(loaded.watches.length, 1);
    // The fixture deliberately omits `enabled`, mimicking a registry written
    // before that field existed: loading must default it to true rather than
    // leaving it undefined.
    assert.deepEqual(loaded.watches[0], { ...definition, enabled: true });
    assert.equal(loaded.stats.get('moscow')?.total_samples, 3);
  });

  it('returns an empty registry when no file exists yet', async () => {
    const store = new WatchStore(join(dir, 'fresh'), logger);
    const loaded = await store.loadRegistry();
    assert.deepEqual(loaded.watches, []);
    assert.equal(loaded.stats.size, 0);
  });

  it('survives a corrupt registry file instead of throwing out of a tool call', async () => {
    const target = join(dir, 'corrupt');
    const store = new WatchStore(target, logger);
    await store.ensureWritable();
    await writeFile(store.registryPath, '{ this is not json', 'utf8');

    const loaded = await store.loadRegistry();
    assert.deepEqual(loaded.watches, []);
  });

  it('skips malformed registry entries but keeps the valid ones', async () => {
    const target = join(dir, 'partial');
    const store = new WatchStore(target, logger);
    await store.ensureWritable();
    await writeFile(
      store.registryPath,
      JSON.stringify({
        version: 1,
        updated_at: 'now',
        watches: [
          { id: 'good', label: 'Good', latitude: 1, longitude: 2, units: 'metric' },
          { id: 'bad', label: 'Bad' },
          null,
        ],
      }),
      'utf8',
    );

    const loaded = await store.loadRegistry();
    assert.deepEqual(
      loaded.watches.map((w) => w.id),
      ['good'],
    );
  });

  it('defaults a stored watch without an enabled flag to collecting', async () => {
    const target = join(dir, 'legacy');
    const store = new WatchStore(target, logger);
    await store.ensureWritable();
    await writeFile(
      store.registryPath,
      JSON.stringify({
        version: 1,
        updated_at: 'now',
        // No `enabled` key: this is what an older registry looks like.
        watches: [{ id: 'legacy', label: 'Legacy', latitude: 1, longitude: 2, units: 'metric' }],
      }),
      'utf8',
    );

    const loaded = await store.loadRegistry();
    assert.equal(loaded.watches[0]?.enabled, true);

    // An explicitly paused watch must stay paused across a restart.
    await store.saveRegistry([{ ...loaded.watches[0]!, enabled: false }], new Map());
    const reloaded = await store.loadRegistry();
    assert.equal(reloaded.watches[0]?.enabled, false);
  });

  it('appends samples and prunes those past retention', async () => {
    const store = new WatchStore(join(dir, 'samples'), logger);
    await store.ensureWritable();

    const now = () => new Date().toISOString();

    const first = await store.appendSample(sample({ at: now(), temperature: 1 }), 100);
    assert.equal(first.length, 1);

    // Older than the 100 h retention: must never be written, even on append.
    const withAncient = await store.appendSample(
      sample({ at: new Date(Date.now() - 200 * 3_600_000).toISOString(), temperature: 99 }),
      100,
    );
    assert.equal(withAncient.length, 1, 'an out-of-retention sample must be dropped');
    assert.equal(withAncient[0]?.temperature, 1);

    // Inside the window: kept, and the file comes back sorted by time.
    const withRecent = await store.appendSample(
      sample({ at: new Date(Date.now() - 10 * 3_600_000).toISOString(), temperature: 2 }),
      100,
    );
    assert.equal(withRecent.length, 2);
    assert.deepEqual(
      withRecent.map((entry) => entry.temperature),
      [2, 1],
      'samples must be stored oldest-first',
    );

    const reloaded = await store.loadSamples('test');
    assert.equal(reloaded.length, 2);
  });

  it('writes valid JSON that a human can read on the host', async () => {
    const store = new WatchStore(join(dir, 'human'), logger);
    await store.ensureWritable();
    await store.appendSample(sample({ at: new Date().toISOString() }), 168);

    const raw = await readFile(store.samplePath('test'), 'utf8');
    const parsed = JSON.parse(raw) as { samples: unknown[]; sample_count: number };
    assert.equal(parsed.samples.length, 1);
    assert.equal(parsed.sample_count, 1);
    assert.match(raw, /\n {2}"samples"/, 'should be pretty-printed');
  });

  it('removes a watch and its samples', async () => {
    const store = new WatchStore(join(dir, 'removal'), logger);
    await store.ensureWritable();
    await store.appendSample(sample({ at: new Date().toISOString() }), 168);
    assert.equal((await store.loadSamples('test')).length, 1);

    await store.removeWatch('test');
    assert.deepEqual(await store.loadSamples('test'), []);
  });

  it('keeps ids filesystem-safe', () => {
    assert.equal(sanitiseId('../../etc/passwd'), '______etc_passwd');
    assert.equal(sanitiseId('Москва'), '______');
    assert.equal(sanitiseId('moscow-2'), 'moscow-2');
    assert.ok(sanitiseId('x'.repeat(200)).length <= 64);

    assert.equal(isValidWatchId('moscow-2'), true);
    assert.equal(isValidWatchId('_leading'), false);
    assert.equal(isValidWatchId('../etc'), false);
    assert.equal(isValidWatchId(''), false);
    assert.equal(isValidWatchId('has space'), false);
    assert.ok(sanitiseId('../../etc/passwd').indexOf('/') === -1, 'sanitised ids must not contain a path separator');
  });
});

describe('timestamp qualification', () => {
  it('formats UTC offsets as ±HH:MM', () => {
    assert.equal(formatOffset(0), '+00:00');
    assert.equal(formatOffset(10800), '+03:00');
    assert.equal(formatOffset(18000), '+05:00');
    assert.equal(formatOffset(-18000), '-05:00');
    assert.equal(formatOffset(19800), '+05:30', 'half-hour zones must not be rounded');
    assert.equal(formatOffset(20700), '+05:45', '45-minute zones must survive');
    assert.equal(formatOffset(null), null);
    assert.equal(formatOffset(undefined), null);
    assert.equal(formatOffset(Number.NaN), null);
  });

  it('appends an offset only when the timestamp lacks one', () => {
    assert.equal(qualifyTimestamp('2026-09-25T22:30', '+05:00'), '2026-09-25T22:30+05:00');
    assert.equal(qualifyTimestamp('2026-09-25T22:30Z', '+05:00'), '2026-09-25T22:30Z');
    assert.equal(qualifyTimestamp('2026-09-25T22:30+03:00', '+05:00'), '2026-09-25T22:30+03:00');
    // Idempotent: running it twice must not double the suffix.
    assert.equal(
      qualifyTimestamp(qualifyTimestamp('2026-09-25T22:30', '+05:00'), '+05:00'),
      '2026-09-25T22:30+05:00',
    );
    assert.equal(qualifyTimestamp('', '+05:00'), '');
    assert.equal(qualifyTimestamp('2026-09-25T22:30', null), '2026-09-25T22:30');
  });

  it('detects a bare wall-clock time as unqualified', () => {
    assert.equal(hasOffset('2026-09-25T22:30'), false);
    assert.equal(hasOffset('2026-09-25T22:30:00'), false);
    assert.equal(hasOffset('2026-09-25T22:30Z'), true);
    assert.equal(hasOffset('2026-09-25T22:30+05:00'), true);
    assert.equal(hasOffset('2026-09-25T22:30-0500'), true);
  });

  it('resolves an offset from an IANA zone', () => {
    const winter = new Date('2026-01-15T12:00:00Z');
    const summer = new Date('2026-07-15T12:00:00Z');

    // Yekaterinburg is UTC+5 all year.
    assert.equal(offsetForZone('Asia/Yekaterinburg', winter), '+05:00');
    assert.equal(offsetForZone('Asia/Yekaterinburg', summer), '+05:00');
    // Moscow is UTC+3 all year.
    assert.equal(offsetForZone('Europe/Moscow', winter), '+03:00');
    // London observes DST, so the same zone yields different offsets.
    assert.equal(offsetForZone('Europe/London', winter), '+00:00');
    assert.equal(offsetForZone('Europe/London', summer), '+01:00');
    assert.equal(offsetForZone('UTC', winter), '+00:00');

    assert.equal(offsetForZone('Not/AZone', winter), null, 'an unknown zone must not throw');
    assert.equal(offsetForZone(null, winter), null);
    assert.equal(offsetForZone('', winter), null);
  });

  it('repairs legacy samples on load without changing their wall-clock reading', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'open-meteo-mcp-legacy-time-'));
    const store = new WatchStore(scratch, logger);
    await store.ensureWritable();

    // Exactly what earlier versions wrote: no offset on observed_at.
    const legacy = sample({ at: '2026-09-25T17:34:24.949Z' });
    (legacy as { observed_at: string }).observed_at = '2026-09-25T22:30';
    (legacy as { timezone: string | null }).timezone = 'Asia/Yekaterinburg';

    await store.appendSample(legacy, 168);
    // appendSample returns the merged set before reload, so read back from disk.
    const reloaded = await store.loadSamples('test');

    assert.equal(reloaded[0]?.observed_at, '2026-09-25T22:30+05:00');
    // The local reading is untouched: only the ambiguity was removed.
    assert.ok(reloaded[0]?.observed_at.startsWith('2026-09-25T22:30'));

    await rm(scratch, { recursive: true, force: true });
  });
});

describe('timestamp repair on disk', () => {
  it('rewrites only the files that needed repair', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'open-meteo-mcp-repair-'));
    const store = new WatchStore(scratch, logger);
    await store.ensureWritable();

    const legacy = {
      ...sample({ at: '2026-09-25T17:34:24.949Z' }),
      observed_at: '2026-09-25T22:30',
      timezone: 'Asia/Yekaterinburg',
    };
    const already = {
      ...sample({ at: '2026-09-25T17:34:24.949Z' }),
      observed_at: '2026-09-25T22:30+05:00',
      timezone: 'Asia/Yekaterinburg',
    };
    // Two distinct watch ids, since the sample path is derived from the id.
    await store.appendSample({ ...legacy, watch_id: 'legacy' }, 168);
    await store.appendSample({ ...already, watch_id: 'modern' }, 168);

    const repaired = await store.repairTimestamps(['legacy', 'modern', 'missing']);
    assert.equal(repaired, 1, 'only the ambiguous file should be rewritten');

    const legacyRaw = JSON.parse(await readFile(store.samplePath('legacy'), 'utf8')) as {
      samples: Array<{ observed_at: string }>;
    };
    const modernRaw = JSON.parse(await readFile(store.samplePath('modern'), 'utf8')) as {
      samples: Array<{ observed_at: string }>;
    };
    assert.equal(legacyRaw.samples[0]?.observed_at, '2026-09-25T22:30+05:00');
    assert.equal(modernRaw.samples[0]?.observed_at, '2026-09-25T22:30+05:00');

    // Idempotent: a second pass finds nothing left to do.
    assert.equal(await store.repairTimestamps(['legacy', 'modern']), 0);

    await rm(scratch, { recursive: true, force: true });
  });
});
