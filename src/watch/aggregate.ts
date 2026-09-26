import { round } from '../weather/coerce.js';
import type { ConditionTally, NumericSummary, WatchAggregate, WatchSample } from './types.js';

/**
 * Aggregation is kept as pure functions over a sample array.
 *
 * Nothing here touches the clock, the disk or the network: `now` is passed in, so
 * a report for a fixed set of samples and a fixed time is fully deterministic and
 * can be asserted exactly in tests.
 */

/** Change smaller than this is reported as "steady" rather than a trend. */
const TREND_EPSILON = 0.5;

export function aggregate(
  samples: readonly WatchSample[],
  options: { windowHours: number; now: number },
): WatchAggregate {
  const cutoff = options.now - options.windowHours * 3_600_000;
  const window = samples
    .filter((sample) => {
      const time = Date.parse(sample.at);
      return Number.isFinite(time) && time >= cutoff;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const temperatures = window.map((s) => s.temperature);
  const precipitations = window.filter((s) => s.precipitation !== null).map((s) => s.precipitation as number);

  const conditions = tallyConditions(window);
  const first = window[0];
  const last = window.at(-1);

  // The span actually covered is reported instead of a "coverage percentage".
  // An expected-sample quota reads to a model as a pass/fail threshold, and a
  // seven-out-of-ninety-six reading made a summarising agent refuse to answer even
  // though every available sample was present. A plain duration states the same
  // fact without implying that something is missing.
  const observedSpanMinutes =
    first === undefined || last === undefined
      ? null
      : round(Math.max(0, (Date.parse(last.at) - Date.parse(first.at)) / 60_000), 1);

  return {
    window_hours: options.windowHours,
    sample_count: window.length,
    observed_span_minutes: observedSpanMinutes,
    first_sample_at: first?.at ?? null,
    last_sample_at: last?.at ?? null,
    staleness_minutes:
      last === undefined ? null : round(Math.max(0, (options.now - Date.parse(last.at)) / 60_000), 1),
    temperature: summarise(temperatures),
    apparent_temperature: summarise(window.map((s) => s.apparent_temperature)),
    relative_humidity: summarise(window.map((s) => s.relative_humidity)),
    pressure_msl: summarise(window.map((s) => s.pressure_msl)),
    wind_speed: summarise(window.map((s) => s.wind_speed)),
    wind_gusts_max: maxOf(window.map((s) => s.wind_gusts)),
    precipitation_total: precipitations.length === 0 ? null : round(sum(precipitations), 2),
    precipitation_max: precipitations.length === 0 ? null : round(Math.max(...precipitations), 2),
    samples_with_precipitation: precipitations.filter((value) => value > 0).length,
    conditions,
    dominant_condition: conditions[0] ?? null,
  };
}


/**
 * Summarises a sparse numeric series.
 *
 * `values` may contain nulls (a provider that does not supply a given field), so
 * every statistic is computed over the non-null subset and the count is implied
 * by `sample_count` in the surrounding aggregate.
 *
 * The trend compares the mean of the older half against the mean of the newer
 * half instead of the first and last points: endpoints are single readings and
 * one noisy sample would otherwise flip the direction.
 */
export function summarise(values: Array<number | null>): NumericSummary {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (present.length === 0) {
    return { min: null, max: null, avg: null, change: null, trend: 'unknown' };
  }

  const midpoint = Math.floor(present.length / 2);
  const olderHalf = present.slice(0, midpoint);
  const newerHalf = present.slice(midpoint);

  return {
    min: round(Math.min(...present)),
    max: round(Math.max(...present)),
    avg: round(sum(present) / present.length),
    change: round(present[present.length - 1]! - present[0]!),
    trend: trendOf(mean(olderHalf), mean(newerHalf)),
  };
}

export function trendOf(older: number | null, newer: number | null): NumericSummary['trend'] {
  if (older === null || newer === null) return 'unknown';
  const delta = newer - older;
  if (delta > TREND_EPSILON) return 'rising';
  if (delta < -TREND_EPSILON) return 'falling';
  return 'steady';
}

/**
 * Counts how often each weather condition occurred, most frequent first.
 *
 * This is what turns a pile of samples into something a model can summarise
 * ("mostly cloudy with two hours of rain") without reading every entry.
 */
export function tallyConditions(samples: readonly WatchSample[]): ConditionTally[] {
  if (samples.length === 0) return [];

  const counts = new Map<string, { en: string; ru: string; samples: number }>();
  for (const sample of samples) {
    const key = sample.condition;
    const entry = counts.get(key) ?? { en: sample.condition_en, ru: sample.condition_ru, samples: 0 };
    entry.samples += 1;
    counts.set(key, entry);
  }

  return [...counts.entries()]
    .map(([condition, entry]) => ({
      condition,
      condition_en: entry.en,
      condition_ru: entry.ru,
      samples: entry.samples,
      share_percent: round((entry.samples / samples.length) * 100, 0) ?? 0,
    }))
    .sort((a, b) => b.samples - a.samples || a.condition.localeCompare(b.condition));
}

function maxOf(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return present.length === 0 ? null : round(Math.max(...present));
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
