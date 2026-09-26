import { InvalidInputError } from '../errors.js';
import { summarise, tallyConditions } from '../watch/aggregate.js';
import type { WatchDefinition, WatchSample } from '../watch/types.js';
import type { UnitSystem } from '../weather/units.js';
import { METRICS, metricHeader, metricValue, roundMetric, unitSuffix, type MetricKey } from './metrics.js';
import type { MetricStat, SummaryEntry } from './types.js';

/**
 * Turning loose input into storable entries.
 *
 * Two sources feed a summary: values an agent passes in (after it has read them
 * from the weather tools), and the server's own watch history. Both end up in the
 * same row shape, so the spreadsheet writer never needs to care which it was.
 */

/** Upper bounds that keep a saved dataset small enough to read and export quickly. */
export const LIMITS = {
  location: 120,
  country: 60,
  condition: 80,
  note: 500,
  summary: 8000,
  title: 200,
  extraKeys: 25,
  extraKeyLength: 40,
  extraValueLength: 200,
} as const;

/**
 * Dataset-level values applied to entries that do not carry their own.
 *
 * This exists because the common case is "one city, many days": the agent has a
 * forecast for a single place and should not have to repeat the place name on
 * every row. Naming it once is both less typing and fewer places to get it wrong.
 */
export interface EntryDefaults {
  location?: string | undefined;
  country?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  date?: string | undefined;
}

/** Raw entry as it arrives from the tool boundary (validated by zod, then normalised here). */
export type RawEntry = Record<string, unknown>;

export function normaliseEntries(raws: readonly RawEntry[], defaults: EntryDefaults): SummaryEntry[] {
  if (raws.length === 0) {
    throw new InvalidInputError(
      'No entries to save. Pass at least one object in `entries`, or use `watch_id` to save the history ' +
        'the collector already has for a watched location.',
    );
  }

  return raws.map((raw, index) => normaliseEntry(raw, defaults, index));
}

function normaliseEntry(raw: RawEntry, defaults: EntryDefaults, index: number): SummaryEntry {
  const where = `entries[${index}]`;

  const location = text(raw['location'], LIMITS.location) ?? text(defaults.location, LIMITS.location);
  if (location === null) {
    throw new InvalidInputError(
      `${where} has no place name. Give it a \`location\` such as "Moscow", or pass a dataset-level ` +
        '`location` when every row describes the same place (a multi-day forecast for one city, for example).',
    );
  }

  const entry: SummaryEntry = {
    location,
    country: text(raw['country'], LIMITS.country) ?? text(defaults.country, LIMITS.country),
    latitude: numberOrNull(raw['latitude']) ?? numberOrNull(defaults.latitude),
    longitude: numberOrNull(raw['longitude']) ?? numberOrNull(defaults.longitude),
    date: normaliseDate(raw['date']) ?? normaliseDate(defaults.date),
    condition: text(raw['condition'], LIMITS.condition),
    weather_code: integerOrNull(raw['weather_code']),
    temperature: null,
    apparent_temperature: null,
    temperature_min: null,
    temperature_max: null,
    relative_humidity: null,
    precipitation: null,
    precipitation_probability: null,
    snowfall: null,
    cloud_cover: null,
    pressure_msl: null,
    wind_speed: null,
    wind_direction: null,
    wind_gusts: null,
    uv_index: null,
    note: text(raw['note'], LIMITS.note),
    extra: normaliseExtra(raw['extra'], where),
  };

  for (const spec of METRICS) {
    entry[spec.key] = roundMetric(spec.key, numberOrNull(raw[spec.key]));
  }

  return entry;
}

/**
 * Normalises a date to `YYYY-MM-DD`.
 *
 * Taking the leading calendar date is intentional: an ISO timestamp with a zone
 * offset ("2026-09-25T23:00+05:00" from a watch sample) must keep the *local*
 * date it was recorded in, which is exactly its first ten characters. Anything
 * that is not recognisably a date is kept as text rather than dropped, so a label
 * like "week 39" survives.
 */
export function normaliseDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (match !== null) return `${match[1]}-${match[2]}-${match[3]}`;
  return trimmed.slice(0, 40);
}

function normaliseExtra(value: unknown, where: string): Record<string, string | number> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidInputError(`${where}.extra must be an object of scalar values, e.g. {"pm2_5": 12.5}.`);
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== null && item !== undefined);
  if (entries.length === 0) return null;
  if (entries.length > LIMITS.extraKeys) {
    throw new InvalidInputError(
      `${where}.extra has ${entries.length} fields; at most ${LIMITS.extraKeys} are supported. ` +
        'Keep the ones worth a spreadsheet column.',
    );
  }

  const result: Record<string, string | number> = {};
  for (const [key, item] of entries) {
    const name = key.trim();
    if (name === '' || name.length > LIMITS.extraKeyLength) {
      throw new InvalidInputError(
        `${where}.extra has an unusable field name ("${key}"). Use 1..${LIMITS.extraKeyLength} characters.`,
      );
    }
    if (typeof item === 'number') {
      result[name] = Number.isFinite(item) ? item : 0;
    } else if (typeof item === 'string') {
      result[name] = item.trim().slice(0, LIMITS.extraValueLength);
    } else if (typeof item === 'boolean') {
      result[name] = item ? 'true' : 'false';
    } else {
      throw new InvalidInputError(
        `${where}.extra["${name}"] must be a string or a number; nested objects and arrays cannot become ` +
          'spreadsheet cells.',
      );
    }
  }
  return result;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Numeric strings are accepted because a model reading a table often quotes them.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function integerOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number === null ? null : Math.round(number);
}

/* -------------------------------------------------------- watch derivation -- */

/**
 * Aggregates a watch's collected samples into one row per local day.
 *
 * Per day the row holds the day's temperature range and mean, its average
 * humidity and pressure, accumulated precipitation, peak wind, and the most
 * frequent condition. Daily rows — not raw samples — are what belongs in a
 * weather spreadsheet: a watch sampling every 15 minutes would otherwise produce
 * 96 rows per day per city.
 *
 * The values are derived from point readings, not from a forecast's own daily
 * aggregates, so "temp_max" here means "the highest reading we took that day".
 * The stored `note` says so, because the difference matters when comparing with a
 * forecast export.
 */
export function entriesFromWatchSamples(
  definition: WatchDefinition,
  samples: readonly WatchSample[],
): SummaryEntry[] {
  const byDate = new Map<string, WatchSample[]>();

  for (const sample of samples) {
    const date = normaliseDate(sample.observed_at) ?? normaliseDate(sample.at);
    if (date === null) continue;
    const bucket = byDate.get(date) ?? [];
    bucket.push(sample);
    byDate.set(date, bucket);
  }

  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, bucket]) => dayEntry(definition, date, bucket));
}

function dayEntry(definition: WatchDefinition, date: string, samples: readonly WatchSample[]): SummaryEntry {
  const temperature = summarise(samples.map((sample) => sample.temperature));
  const humidity = summarise(samples.map((sample) => sample.relative_humidity));
  const pressure = summarise(samples.map((sample) => sample.pressure_msl));
  const wind = summarise(samples.map((sample) => sample.wind_speed));
  const gusts = summarise(samples.map((sample) => sample.wind_gusts));

  const precipitations = samples
    .map((sample) => sample.precipitation)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const precipitationTotal = precipitations.length === 0 ? null : precipitations.reduce((a, b) => a + b, 0);

  const dominant = tallyConditions(samples)[0] ?? null;
  const code = mostFrequentCode(samples);
  // Direction is not averaged: the mean of 350° and 10° is 180°, the opposite of
  // the truth. The reading at the strongest sample is reported instead.
  const strongest = samples.reduce(
    (best, sample) => ((sample.wind_speed ?? -1) > (best.wind_speed ?? -1) ? sample : best),
    samples[0]!,
  );

  const badConditions = countWetSamples(samples);

  const entry: SummaryEntry = {
    location: definition.label,
    country: definition.country,
    latitude: definition.latitude,
    longitude: definition.longitude,
    date,
    condition: dominant?.condition_en ?? null,
    weather_code: code,
    temperature: roundMetric('temperature', temperature.avg),
    apparent_temperature: null,
    temperature_min: roundMetric('temperature_min', temperature.min),
    temperature_max: roundMetric('temperature_max', temperature.max),
    relative_humidity: roundMetric('relative_humidity', humidity.avg),
    precipitation: roundMetric('precipitation', precipitationTotal),
    precipitation_probability: null,
    snowfall: null,
    cloud_cover: null,
    pressure_msl: roundMetric('pressure_msl', pressure.avg),
    wind_speed: roundMetric('wind_speed', wind.max),
    wind_direction: strongest.wind_direction,
    wind_gusts: roundMetric('wind_gusts', gusts.max),
    uv_index: null,
    note:
      `${samples.length} sample(s) from watch "${definition.id}"` +
      (badConditions === 0 ? '' : `, ${badConditions} with precipitation`) +
      '; min/max are the highest and lowest readings taken, not a daily forecast range',
    extra: { samples: samples.length },
  };

  return entry;
}

function mostFrequentCode(samples: readonly WatchSample[]): number | null {
  const counts = new Map<number, number>();
  for (const sample of samples) {
    if (sample.weather_code === null) continue;
    counts.set(sample.weather_code, (counts.get(sample.weather_code) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = -1;
  // Sorted keys keep the winner deterministic when two codes tie.
  for (const code of [...counts.keys()].sort((a, b) => a - b)) {
    const count = counts.get(code)!;
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

function countWetSamples(samples: readonly WatchSample[]): number {
  return samples.filter((sample) => (sample.precipitation ?? 0) > 0).length;
}

/* ---------------------------------------------------------------- statistics -- */

/**
 * Min/max/average per place and metric, for the Stats sheet.
 *
 * Grouping by place matters as soon as a summary covers more than one city:
 * averaging Moscow and Sochi together would describe neither. Metrics with no
 * values anywhere are omitted rather than exported as an empty row.
 */
export function metricStats(entries: readonly SummaryEntry[], units: UnitSystem): MetricStat[] {
  const locations = [...new Set(entries.map((entry) => entry.location))];
  const stats: MetricStat[] = [];

  for (const location of locations) {
    const rows = entries.filter((entry) => entry.location === location);
    for (const spec of METRICS) {
      const values = rows
        .map((row) => metricValue(row, spec.key))
        .filter((value): value is number => value !== null && Number.isFinite(value));
      if (values.length === 0) continue;

      const summary = summarise(values);
      stats.push({
        location,
        metric: metricHeader(spec, units),
        unit: unitSuffix(spec.unit, units) ?? '',
        samples: values.length,
        min: summary.min,
        max: summary.max,
        // A compass direction has no meaningful mean, so the average is left blank
        // rather than reporting a number that points the wrong way.
        avg: spec.circular === true ? null : summary.avg,
        sum: spec.accumulation === true ? roundMetric(spec.key, values.reduce((a, b) => a + b, 0)) : null,
      });
    }
  }

  return stats;
}

/** Every extra-metric key used anywhere in the dataset, in a stable order. */
export function extraKeys(entries: readonly SummaryEntry[]): string[] {
  const keys = new Set<string>();
  for (const entry of entries) {
    for (const key of Object.keys(entry.extra ?? {})) keys.add(key);
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/** Metric keys that carry at least one value, in table order. */
export function populatedMetricKeys(entries: readonly SummaryEntry[]): MetricKey[] {
  return METRICS.filter((spec) => entries.some((entry) => metricValue(entry, spec.key) !== null)).map(
    (spec) => spec.key,
  );
}
