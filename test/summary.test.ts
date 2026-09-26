import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import type { Config } from '../src/config.js';
import { InvalidInputError } from '../src/errors.js';
import { createLogger } from '../src/logger.js';
import { METRIC_KEYS, METRICS } from '../src/summary/metrics.js';
import { entriesFromWatchSamples, metricStats, normaliseEntries, normaliseDate } from '../src/summary/entries.js';
import { SummaryService, deriveDatasetId, sanitiseFileName } from '../src/summary/service.js';
import { SummaryStore, sanitiseDatasetId } from '../src/summary/store.js';
import type { SummaryEntry } from '../src/summary/types.js';
import { buildSummaryWorkbook } from '../src/summary/workbook.js';
import type { WatchDefinition, WatchSample } from '../src/watch/types.js';
import { buildXlsx, columnName, escapeXml, sanitiseSheetName } from '../src/xlsx/workbook.js';

const logger = createLogger('silent');

/* ------------------------------------------------------------- xlsx reader -- */

/**
 * Minimal ZIP reader used to inspect what the writer produced.
 *
 * Deliberately independent of `src/xlsx/zip.ts`: it walks the central directory
 * the way any other tool would, and verifies the CRC with a table-free bitwise
 * implementation, so a bug in the writer's own CRC table cannot hide behind a
 * matching reader.
 */
function readZip(buffer: Buffer): Map<string, Buffer> {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = buffer.lastIndexOf(signature);
  assert.notEqual(eocd, -1, 'archive has no end-of-central-directory record');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'bad central directory signature');
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `bad local header for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    const raw = method === 8 ? inflateRawSync(payload) : payload;

    assert.equal(raw.length, uncompressedSize, `${name}: size mismatch`);
    assert.equal(bitwiseCrc32(raw), expectedCrc, `${name}: CRC mismatch`);
    entries.set(name, raw);

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** CRC-32 from the spec, written without a lookup table. */
function bitwiseCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ fixtures -- */

function makeConfig(dataDir: string, overrides: Partial<Config['summary']> = {}): Config {
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
      forecastBaseUrl: 'http://127.0.0.1:1',
      forecastPath: '/v1/ensemble',
      models: 'gfs05',
      geocodingBaseUrl: 'http://127.0.0.1:1',
      airQualityBaseUrl: 'http://127.0.0.1:1',
      apiKey: undefined,
      timeoutMs: 1000,
      maxRetries: 0,
      userAgent: 'test',
    },
    watch: {
      enabled: false,
      intervalSeconds: 900,
      retentionHours: 168,
      dataDir,
      maxWatches: 20,
    },
    summary: {
      dataDir,
      maxDatasets: 200,
      maxEntries: 5000,
      maxInlineBytes: 8_388_608,
      maxExportsPerDataset: 10,
      ...overrides,
    },
    logLevel: 'silent',
  };
}

function entry(overrides: Partial<SummaryEntry> = {}): SummaryEntry {
  const base: SummaryEntry = {
    location: 'Moscow',
    country: 'Russia',
    latitude: 55.75204,
    longitude: 37.61781,
    date: '2026-09-25',
    condition: 'Light rain',
    weather_code: 61,
    temperature: 12.4,
    apparent_temperature: 10.1,
    temperature_min: 8.2,
    temperature_max: 14.9,
    relative_humidity: 81,
    precipitation: 1.25,
    precipitation_probability: null,
    snowfall: 0,
    cloud_cover: 90,
    pressure_msl: 1008.4,
    wind_speed: 14.2,
    wind_direction: 210,
    wind_gusts: 31.5,
    uv_index: 2.1,
    note: null,
    extra: null,
    ...overrides,
  };
  return base;
}

function watchDefinition(overrides: Partial<WatchDefinition> = {}): WatchDefinition {
  return {
    id: 'moskva',
    label: 'Москва, Россия',
    latitude: 55.75204,
    longitude: 37.61781,
    country: 'Russia',
    admin1: null,
    timezone: 'Europe/Moscow',
    resolved_from: 'Москва',
    units: 'metric',
    language: 'ru',
    created_at: '2026-09-20T00:00:00.000Z',
    enabled: true,
    ...overrides,
  };
}

function sample(overrides: Partial<WatchSample> & { at: string }): WatchSample {
  return {
    watch_id: 'moskva',
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

let workspace: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'open-meteo-mcp-summary-'));
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function freshDir(name: string): Promise<string> {
  const dir = join(workspace, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------- xlsx -- */

describe('xlsx writer', () => {
  it('emits a readable archive with every part a workbook needs', () => {
    const buffer = buildXlsx({
      title: 'Test',
      createdAt: new Date('2026-09-26T12:00:00Z'),
      sheets: [
        {
          name: 'Weather',
          columns: [{ header: 'city', width: 20 }, { header: 'temp', kind: 'number' }],
          rows: [['Москва', 12.4], ['Sochi', null]],
        },
      ],
    });

    assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK', 'an xlsx must be a ZIP archive');

    const parts = readZip(buffer);
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'docProps/app.xml',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]) {
      assert.ok(parts.has(required), `missing part ${required}`);
    }

    const sheet = parts.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    assert.match(sheet, /<t xml:space="preserve">Москва<\/t>/);
    assert.match(sheet, /<v>12.4<\/v>/);
    // Nulls leave the cell out entirely rather than writing an empty string.
    assert.doesNotMatch(sheet, /<c r="B3"/);
    assert.match(sheet, /<pane ySplit="1"[^>]*state="frozen"/);
    assert.match(sheet, /<autoFilter ref="A1:B3"\/>/);
    assert.match(sheet, /<col min="1" max="1" width="20" customWidth="1"\/>/);
  });

  it('escapes XML and drops characters XML 1.0 cannot represent', () => {
    // An agent-supplied note is free text: a control character or a stray "<"
    // would otherwise produce a workbook no application can open.
    const buffer = buildXlsx({
      sheets: [
        { name: 'S', columns: [{ header: 'h' }], rows: [['<tag> & "quote" \u0007 \uD800']] },
      ],
    });
    const sheet = readZip(buffer).get('xl/worksheets/sheet1.xml')!.toString('utf8');
    assert.match(sheet, /&lt;tag&gt; &amp; "quote"/);
    assert.doesNotMatch(sheet, /\u0007/);
    assert.doesNotMatch(sheet, /\uD800/);
  });

  it('produces the same bytes for the same input and timestamp', () => {
    const first = buildXlsx({ sheets: [{ name: 'S', columns: [{ header: 'h' }], rows: [['x']] }], createdAt: new Date(0) });
    const second = buildXlsx({ sheets: [{ name: 'S', columns: [{ header: 'h' }], rows: [['x']] }], createdAt: new Date(0) });
    assert.deepEqual(first, second);
  });

  it('names columns past Z', () => {
    assert.equal(columnName(1), 'A');
    assert.equal(columnName(26), 'Z');
    assert.equal(columnName(27), 'AA');
    assert.equal(columnName(52), 'AZ');
    assert.equal(columnName(703), 'AAA');
  });

  it('sanitises sheet names, which Excel otherwise refuses to open', () => {
    assert.equal(sanitiseSheetName('Weather [2026]: ok?'), 'Weather 2026 ok');
    assert.equal(sanitiseSheetName(''), 'Sheet');
    assert.equal(sanitiseSheetName('x'.repeat(60)).length, 31);
    assert.equal(sanitiseSheetName('Weather', new Set(['Weather'])), 'Weather 2');
  });

  it('escapes text without double-encoding an existing entity', () => {
    assert.equal(escapeXml('a & b'), 'a &amp; b');
    assert.equal(escapeXml('&amp;'), '&amp;amp;');
  });
});

/* ---------------------------------------------------------------- entries -- */

describe('entry normalisation', () => {
  it('applies dataset-level defaults to rows that omit them', () => {
    // The one-city-many-days case: the place name belongs in one argument, not
    // repeated on every row.
    const entries = normaliseEntries(
      [{ date: '2026-09-25', temperature: 12.44 }, { date: '2026-09-26', temperature: 9.06 }],
      { location: 'Sochi', latitude: 43.6, longitude: 39.7 },
    );

    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.location, 'Sochi');
    assert.equal(entries[0]?.latitude, 43.6);
    assert.equal(entries[1]?.date, '2026-09-26');
    // Rounded to the metric's stored precision, so storage and the sheet agree.
    assert.equal(entries[0]?.temperature, 12.4);
    assert.equal(entries[1]?.temperature, 9.1);
  });

  it('explains what is missing when a row has no place at all', () => {
    assert.throws(
      () => normaliseEntries([{ temperature: 10 }], {}),
      (error: unknown) => error instanceof InvalidInputError && /no place name/.test(error.message),
    );
  });

  it('keeps the local date of a timestamp that carries an offset', () => {
    // Taking the leading date of "2026-09-25T23:00+05:00" keeps the day the
    // reading was actually recorded on; parsing it as UTC would move it a day.
    assert.equal(normaliseDate('2026-09-25T23:00+05:00'), '2026-09-25');
    assert.equal(normaliseDate(' 2026-09-25 '), '2026-09-25');
    assert.equal(normaliseDate('week 39'), 'week 39');
    assert.equal(normaliseDate(''), null);
    assert.equal(normaliseDate(42), null);
  });

  it('accepts numeric strings and rejects nested extras', () => {
    const [parsed] = normaliseEntries([{ location: 'Perm', temperature: '3.5' }], {});
    assert.equal(parsed?.temperature, 3.5);

    assert.throws(
      () =>
        normaliseEntries([{ location: 'Perm', extra: { nested: { a: 1 } } }], {}),
      (error: unknown) => error instanceof InvalidInputError && /string or a number/.test(error.message),
    );
  });

  it('caps extras and keeps their values scalar', () => {
    const extras = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, index]));
    assert.throws(
      () => normaliseEntries([{ location: 'Perm', extra: extras }], {}),
      (error: unknown) => error instanceof InvalidInputError && /at most/.test(error.message),
    );

    const [parsed] = normaliseEntries([{ location: 'Perm', extra: { flag: true, aqi: 42 } }], {});
    assert.deepEqual(parsed?.extra, { flag: 'true', aqi: 42 });
  });

  it('refuses an empty dataset', () => {
    assert.throws(() => normaliseEntries([], {}), InvalidInputError);
  });
});

/* ------------------------------------------------------------ watch → rows -- */

describe('deriving summary rows from a watch', () => {
  it('groups samples into one row per local day', () => {
    const entries = entriesFromWatchSamples(watchDefinition(), [
      sample({ at: '2026-09-24T21:00:00.000Z', observed_at: '2026-09-25T00:00+03:00', temperature: 5 }),
      sample({ at: '2026-09-25T09:00:00.000Z', observed_at: '2026-09-25T12:00+03:00', temperature: 15, precipitation: 1 }),
      sample({ at: '2026-09-26T00:00:00.000Z', observed_at: '2026-09-26T03:00+03:00', temperature: -2, precipitation: 0.5 }),
    ]);

    assert.deepEqual(
      entries.map((row) => row.date),
      ['2026-09-25', '2026-09-26'],
    );

    const [first] = entries;
    // A watch row is labelled with the watch's own place label, so the export
    // never loses which location it describes.
    assert.equal(first?.location, 'Москва, Россия');
    assert.equal(first?.latitude, 55.75204);
  });

  it('summarises each day: range, mean, precipitation total and peak wind', () => {
    const entries = entriesFromWatchSamples(watchDefinition(), [
      sample({ at: '2026-09-25T06:00:00.000Z', temperature: 5, precipitation: 0.25, wind_speed: 3, wind_gusts: 20, wind_direction: 90 }),
      sample({ at: '2026-09-25T09:00:00.000Z', temperature: 15, precipitation: 1, wind_speed: 12, wind_gusts: 40, wind_direction: 270 }),
      sample({ at: '2026-09-25T12:00:00.000Z', temperature: 10, precipitation: 0, wind_speed: 7, wind_gusts: 25, wind_direction: 10 }),
    ]);

    const row = entries[0]!;
    assert.equal(row.temperature, 10); // mean
    assert.equal(row.temperature_min, 5);
    assert.equal(row.temperature_max, 15);
    assert.equal(row.precipitation, 1.25); // total
    assert.equal(row.wind_speed, 12); // peak
    assert.equal(row.wind_gusts, 40);
    // The direction of the strongest sample, because averaging 90° and 270°
    // would report the opposite of the truth.
    assert.equal(row.wind_direction, 270);
    assert.equal(row.extra?.['samples'], 3);
    assert.match(row.note ?? '', /not a daily forecast range/);
  });

  it('returns nothing when no sample carries a usable timestamp', () => {
    assert.deepEqual(entriesFromWatchSamples(watchDefinition(), [sample({ at: '', observed_at: '' })]), []);
  });
});

/* --------------------------------------------------------------- statistics -- */

describe('statistics for the Stats sheet', () => {
  it('groups by location so two cities are never averaged together', () => {
    const stats = metricStats(
      [
        entry({ location: 'Moscow', temperature: 0 }),
        entry({ location: 'Moscow', temperature: 10 }),
        entry({ location: 'Sochi', temperature: 25 }),
      ],
      'metric',
    );

    const moscow = stats.find((row) => row.location === 'Moscow' && row.metric.startsWith('temperature,'));
    const sochi = stats.find((row) => row.location === 'Sochi' && row.metric.startsWith('temperature,'));
    assert.equal(moscow?.avg, 5);
    assert.equal(moscow?.samples, 2);
    assert.equal(sochi?.avg, 25);
  });

  it('totals accumulations but leaves the column empty for point values', () => {
    const stats = metricStats([entry({ precipitation: 2 }), entry({ precipitation: 3 })], 'metric');
    const precipitation = stats.find((row) => row.metric.startsWith('precipitation,'));
    const temperature = stats.find((row) => row.metric.startsWith('temperature,'));

    assert.equal(precipitation?.sum, 5);
    assert.equal(precipitation?.min, 2);
    assert.equal(temperature?.sum, null, 'a temperature has no meaningful total');
  });

  it('leaves the average blank for a compass direction', () => {
    // 141°, 2° and 203° average to 115°, which points nowhere near where the wind
    // actually came from; min/max are reported, the mean is not.
    const stats = metricStats(
      [entry({ wind_direction: 141 }), entry({ wind_direction: 2 }), entry({ wind_direction: 203 })],
      'metric',
    );
    const direction = stats.find((row) => row.metric.startsWith('wind_direction,'));

    assert.equal(direction?.avg, null);
    assert.equal(direction?.min, 2);
    assert.equal(direction?.max, 203);
  });

  it('omits metrics that carry no values anywhere', () => {
    const stats = metricStats([entry({ uv_index: null, snowfall: null })], 'metric');
    assert.equal(stats.some((row) => row.metric.startsWith('uv_index')), false);
  });

  it('labels units according to the dataset unit system', () => {
    const [first] = metricStats([entry()], 'imperial');
    assert.match(first?.metric ?? '', /°F|mph|inch/);
  });
});

/* ----------------------------------------------------------------- workbook -- */

describe('summary workbook', () => {
  const dataset = {
    id: 'test',
    title: 'Test dataset',
    summary: 'Warm and wet.',
    units: 'metric' as const,
    tags: ['t'],
    locations: ['Moscow'],
    period: { from: '2026-09-25', to: '2026-09-25' },
    entry_count: 1,
    created_at: '2026-09-26T00:00:00.000Z',
    updated_at: '2026-09-26T00:00:00.000Z',
    origin: { kind: 'agent' as const, watch_id: null, watch_window_hours: null, description: 'forecast' },
    entries: [entry({ extra: { aqi: 42 } })],
  };

  it('carries only the metric columns that hold data', () => {
    const built = buildSummaryWorkbook(dataset, { generatedAt: new Date(), generator: 'test/1' });
    assert.ok(built.columns.includes('temperature, °C'));
    assert.ok(built.columns.includes('aqi'), 'extra metrics become their own columns');
    assert.equal(
      built.columns.some((column) => column.startsWith('precip_probability')),
      false,
      'a metric that is null everywhere must not become a column of blanks',
    );
    assert.deepEqual(built.sheetNames, ['Weather', 'Stats', 'Info']);
    assert.equal(built.rows, 1);
  });

  it('drops informational columns that are empty in every row', () => {
    // A column of blanks reads as missing data; leaving it out says nothing and
    // keeps the sheet readable. Location and date stay because they identify a row.
    const built = buildSummaryWorkbook(
      { ...dataset, entries: [entry({ country: null, condition: null, note: null, weather_code: null })] },
      { generatedAt: new Date(), generator: 'test/1' },
    );

    assert.equal(built.columns[0], 'location');
    assert.ok(built.columns.includes('date'));
    for (const absent of ['country', 'condition', 'weather_code', 'note']) {
      assert.equal(built.columns.includes(absent), false, `${absent} should be dropped when empty`);
    }
  });

  it('renames an extra that collides with a fixed column', () => {
    const built = buildSummaryWorkbook(
      { ...dataset, entries: [entry({ extra: { date: 'not-a-date' } })] },
      { generatedAt: new Date(), generator: 'test/1' },
    );
    assert.ok(built.columns.includes('extra.date'));
    assert.equal(built.columns.filter((column) => column === 'date').length, 1);
  });

  it('puts the stored analysis in full on the Info sheet', () => {
    const built = buildSummaryWorkbook(dataset, { generatedAt: new Date(), generator: 'test/1' });
    const info = readZip(built.buffer).get('xl/worksheets/sheet3.xml')!.toString('utf8');
    assert.match(info, /Warm and wet\./);
    assert.match(info, /forecast/);
  });
});

/* -------------------------------------------------------------------- store -- */

describe('summary service', () => {
  it('saves a dataset, writes an index and lists it back', async () => {
    const dir = await freshDir('save');
    const service = new SummaryService({ config: makeConfig(dir), logger });

    const saved = await service.save({
      title: 'Погода в Москве',
      summary: 'Тепло.',
      units: 'metric',
      tags: ['travel'],
      datasetId: null,
      replace: false,
      entries: [entry()],
      origin: { kind: 'agent', watch_id: null, watch_window_hours: null, description: null },
    });

    assert.equal(saved.dataset.id, 'pogoda-v-moskve');
    assert.equal(saved.derived_id, true);
    assert.equal(saved.dataset.entry_count, 1);

    const onDisk = JSON.parse(await readFile(saved.dataset.file_path, 'utf8')) as { dataset: { entries: unknown[] } };
    assert.equal(onDisk.dataset.entries.length, 1);

    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as { datasets: unknown[] };
    assert.equal(index.datasets.length, 1);

    const listed = await service.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, 'pogoda-v-moskve');
  });

  it('refuses to overwrite an existing dataset unless replace is set', async () => {
    const dir = await freshDir('replace');
    const service = new SummaryService({ config: makeConfig(dir), logger });
    const input = {
      title: 'Daily',
      summary: null,
      units: 'metric' as const,
      tags: [],
      datasetId: 'daily',
      replace: false,
      entries: [entry()],
      origin: { kind: 'agent' as const, watch_id: null, watch_window_hours: null, description: null },
    };

    const original = await service.save(input);
    await assert.rejects(
      () => service.save(input),
      (error: unknown) => error instanceof InvalidInputError && /replace: true/.test(error.message),
    );

    const replaced = await service.save({ ...input, replace: true, entries: [entry(), entry({ date: '2026-09-26' })] });
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.dataset.entry_count, 2);
    // The creation time survives an update, so the listing keeps its history.
    assert.equal(replaced.dataset.created_at, original.dataset.created_at);
    assert.equal((await service.list()).length, 1);
  });

  it('rebuilds a missing index from the dataset files instead of losing them', async () => {
    const dir = await freshDir('rebuild');
    const first = new SummaryService({ config: makeConfig(dir), logger });
    await first.save({
      title: 'Keeper',
      summary: null,
      units: 'metric',
      tags: [],
      datasetId: 'keeper',
      replace: false,
      entries: [entry()],
      origin: { kind: 'agent', watch_id: null, watch_window_hours: null, description: null },
    });

    await rm(join(dir, 'index.json'), { force: true });

    const second = new SummaryService({ config: makeConfig(dir), logger });
    const listed = await second.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, 'keeper');
    // The rebuilt index is written back, so the next start is cheap again.
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as { datasets: unknown[] };
    assert.equal(index.datasets.length, 1);
  });

  it('survives a corrupt index file', async () => {
    const dir = await freshDir('corrupt-index');
    const service = new SummaryService({ config: makeConfig(dir), logger });
    await service.save({
      title: 'Keeper',
      summary: null,
      units: 'metric',
      tags: [],
      datasetId: 'keeper',
      replace: false,
      entries: [entry()],
      origin: { kind: 'agent', watch_id: null, watch_window_hours: null, description: null },
    });
    await writeFile(join(dir, 'index.json'), '{ not json', 'utf8');

    const reloaded = new SummaryService({ config: makeConfig(dir), logger });
    assert.equal((await reloaded.list()).length, 1);
  });

  it('rejects a dataset larger than the configured row limit', async () => {
    const dir = await freshDir('limits');
    const service = new SummaryService({ config: makeConfig(dir, { maxEntries: 2 }), logger });
    await assert.rejects(
      () =>
        service.save({
          title: 'Big',
          summary: null,
          units: 'metric',
          tags: [],
          datasetId: 'big',
          replace: false,
          entries: [entry(), entry(), entry()],
          origin: { kind: 'agent', watch_id: null, watch_window_hours: null, description: null },
        }),
      /above the limit of 2/,
    );
  });

  it('reports a read-only data directory instead of writing into it', async () => {
    const dir = await freshDir('readonly');
    const service = new SummaryService({ config: makeConfig(dir), logger });
    // A file where the directory should be is the cheapest reliable stand-in for
    // an unwritable volume, and it fails at startup rather than mid-save.
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, 'not a directory', 'utf8');

    await assert.rejects(
      () =>
        service.save({
          title: 'Nope',
          summary: null,
          units: 'metric',
          tags: [],
          datasetId: null,
          replace: false,
          entries: [entry()],
          origin: { kind: 'agent', watch_id: null, watch_window_hours: null, description: null },
        }),
      /not writable/,
    );
  });
});

describe('excel export', () => {
  async function serviceWithDataset(name: string, overrides: Partial<Config['summary']> = {}) {
    const dir = await freshDir(name);
    const service = new SummaryService({ config: makeConfig(dir, overrides), logger });
    await service.save({
      title: 'Export me',
      summary: 'Two warm days.',
      units: 'metric',
      tags: ['test'],
      datasetId: 'export-me',
      replace: false,
      entries: [entry(), entry({ date: '2026-09-26', temperature: 14.2 })],
      origin: { kind: 'agent', watch_id: null, watch_window_hours: null, description: 'forecast' },
    });
    return service;
  }

  it('writes a real workbook, returns it inline and reports its path', async () => {
    const service = await serviceWithDataset('export');
    const result = await service.exportExcel('export-me', { includeContent: true });

    assert.equal(result.fileName.startsWith('export-me-'), true, 'the dataset id prefixes the file name');
    assert.equal(result.fileName.endsWith('.xlsx'), true);
    assert.equal(result.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.deepEqual(result.sheetNames, ['Weather', 'Stats', 'Info']);
    assert.equal(result.rows, 2);

    const onDisk = await readFile(result.filePath);
    assert.deepEqual(onDisk.subarray(0, 2).toString('ascii'), 'PK');
    assert.equal(onDisk.length, result.bytes);

    // Inline content must be the same file, or a caller saving the attachment
    // would end up with something that does not match the reported hash.
    assert.ok(result.base64 !== null);
    const decoded = Buffer.from(result.base64, 'base64');
    assert.deepEqual(decoded, onDisk);
    assert.match(result.uri, /^file:\/\//);
  });

  it('skips the inline copy when asked, and when the file is over the limit', async () => {
    const pathOnly = await serviceWithDataset('export-path-only');
    const skipped = await pathOnly.exportExcel('export-me', { includeContent: false });
    assert.equal(skipped.base64, null);
    assert.match(skipped.inlineSkippedReason ?? '', /include_file_content/);

    const tiny = await serviceWithDataset('export-tiny-limit', { maxInlineBytes: 10 });
    const overLimit = await tiny.exportExcel('export-me', { includeContent: true });
    assert.equal(overLimit.base64, null);
    assert.match(overLimit.inlineSkippedReason ?? '', /SUMMARY_MAX_INLINE_BYTES/);
    await readFile(overLimit.filePath); // still written to disk
  });

  it('records a caller-supplied file name without letting it escape the directory', async () => {
    const service = await serviceWithDataset('export-name');
    const result = await service.exportExcel('export-me', {
      fileName: '../../etc/Погода сентябрь.xlsx',
      includeContent: false,
    });

    assert.equal(result.fileName.includes('/'), false);
    assert.equal(result.fileName.endsWith('.xlsx'), true);
    assert.match(result.fileName, /Погода сентябрь/);
    assert.ok(result.filePath.startsWith(service.exportsDir));
  });

  it('prunes older exports of the same dataset but keeps the newest', async () => {
    const service = await serviceWithDataset('export-prune', { maxExportsPerDataset: 2 });

    // Deliberately back to back: three files can land in the same timestamp tick,
    // and the file just handed to the caller must survive that.
    const first = await service.exportExcel('export-me', { fileName: 'a', includeContent: false });
    const second = await service.exportExcel('export-me', { fileName: 'b', includeContent: false });
    const third = await service.exportExcel('export-me', { fileName: 'c', includeContent: false });

    assert.equal(third.prunedExports, 1);
    await assert.doesNotReject(() => readFile(third.filePath));
    await assert.doesNotReject(() => readFile(second.filePath));
    await assert.rejects(() => readFile(first.filePath), /ENOENT/);
  });

  it('gives an actionable error for an unknown dataset', async () => {
    const service = await serviceWithDataset('export-missing');
    await assert.rejects(
      () => service.exportExcel('nosuch', { includeContent: true }),
      (error: unknown) => error instanceof InvalidInputError && /list_weather_summaries/.test(error.message),
    );
  });
});

/* ------------------------------------------------------------------ helpers -- */

describe('ids and file names', () => {
  it('transliterates a Cyrillic title into a usable id', () => {
    assert.equal(deriveDatasetId('Погода в Москве'), 'pogoda-v-moskve');
    assert.equal(deriveDatasetId('!!!'), 'summary');
  });

  it('keeps stored ids path-safe', () => {
    assert.equal(sanitiseDatasetId('../../etc/passwd'), '______etc_passwd');
    assert.equal(sanitiseDatasetId('ok-1').includes('/'), false);
  });

  it('strips paths and forbidden characters from file names', () => {
    assert.equal(sanitiseFileName('a/b\\c:d*.xlsx'), 'a-b-cd');
    assert.equal(sanitiseFileName('  trailing dots...  '), 'trailing dots');
  });

  it('keeps the metric table and the writable entry fields in step', () => {
    // The tool schema is written by hand for good descriptions, so this guards
    // against adding a metric to the table and forgetting it in the schema.
    const [parsed] = normaliseEntries(
      [{ location: 'X', ...Object.fromEntries(METRIC_KEYS.map((key) => [key, 1])) }],
      {},
    );
    for (const key of METRIC_KEYS) {
      assert.equal(parsed?.[key], 1, `${key} is not stored`);
    }
    assert.equal(METRICS.length, METRIC_KEYS.length);
  });
});
