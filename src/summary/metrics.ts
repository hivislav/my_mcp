import type { ColumnKind } from '../xlsx/workbook.js';
import { unitsFor, type UnitSystem } from '../weather/units.js';
import type { SummaryEntry } from './types.js';

/**
 * The single table describing every numeric weather metric a summary can hold.
 *
 * One table drives four things that would otherwise drift apart: the tool's input
 * schema, entry normalisation and rounding, the spreadsheet columns, and the
 * aggregated statistics sheet. Adding a metric here adds it everywhere.
 */

export type MetricKey =
  | 'temperature'
  | 'apparent_temperature'
  | 'temperature_min'
  | 'temperature_max'
  | 'relative_humidity'
  | 'precipitation'
  | 'precipitation_probability'
  | 'snowfall'
  | 'cloud_cover'
  | 'pressure_msl'
  | 'wind_speed'
  | 'wind_direction'
  | 'wind_gusts'
  | 'uv_index';

/** Unit families, resolved to a concrete symbol per unit system. */
export type MetricUnit =
  | 'temperature'
  | 'wind_speed'
  | 'precipitation'
  | 'percent'
  | 'hpa'
  | 'degrees'
  | 'centimetres'
  | 'index';

export interface MetricSpec {
  key: MetricKey;
  /** Column header, without the unit suffix. */
  header: string;
  unit: MetricUnit;
  /** Decimals kept in storage and shown in the spreadsheet. */
  digits: number;
  kind: ColumnKind;
  width: number;
  /** True when values accumulate over the period, so a total is meaningful. */
  accumulation?: boolean;
  /**
   * True for compass directions, where averaging is meaningless (the mean of 350°
   * and 10° is 180° — the opposite of the truth). Kept out of the average column.
   */
  circular?: boolean;
  description: string;
}

export const METRICS: readonly MetricSpec[] = [
  {
    key: 'temperature',
    header: 'temperature',
    unit: 'temperature',
    digits: 1,
    kind: 'number',
    width: 13,
    description: 'Air temperature at 2 m. Use the current reading, or the daily mean if you have one.',
  },
  {
    key: 'apparent_temperature',
    header: 'feels_like',
    unit: 'temperature',
    digits: 1,
    kind: 'number',
    width: 13,
    description: 'Feels-like temperature, from get_current_weather or the forecast feels-like range.',
  },
  {
    key: 'temperature_min',
    header: 'temp_min',
    unit: 'temperature',
    digits: 1,
    kind: 'number',
    width: 12,
    description: 'Daily minimum temperature — forecast days[].temperature_min.',
  },
  {
    key: 'temperature_max',
    header: 'temp_max',
    unit: 'temperature',
    digits: 1,
    kind: 'number',
    width: 12,
    description: 'Daily maximum temperature — forecast days[].temperature_max.',
  },
  {
    key: 'relative_humidity',
    header: 'humidity',
    unit: 'percent',
    digits: 0,
    kind: 'integer',
    width: 11,
    description: 'Relative humidity in percent, rounded to a whole number.',
  },
  {
    key: 'precipitation',
    header: 'precipitation',
    unit: 'precipitation',
    digits: 2,
    kind: 'decimal2',
    width: 14,
    accumulation: true,
    description: 'Precipitation amount — forecast days[].precipitation_sum, or the current reading.',
  },
  {
    key: 'precipitation_probability',
    header: 'precip_probability',
    unit: 'percent',
    digits: 0,
    kind: 'integer',
    width: 15,
    description:
      'Precipitation probability in percent — forecast days[].precipitation_probability_max. Often null with the default ensemble source.',
  },
  {
    key: 'snowfall',
    header: 'snowfall',
    unit: 'centimetres',
    digits: 1,
    kind: 'number',
    width: 12,
    accumulation: true,
    description: 'Snowfall in centimetres — forecast days[].snowfall_sum.',
  },
  {
    key: 'cloud_cover',
    header: 'cloud_cover',
    unit: 'percent',
    digits: 0,
    kind: 'integer',
    width: 13,
    description: 'Total cloud cover in percent.',
  },
  {
    key: 'pressure_msl',
    header: 'pressure',
    unit: 'hpa',
    digits: 1,
    kind: 'number',
    width: 12,
    description: 'Mean sea-level pressure in hPa.',
  },
  {
    key: 'wind_speed',
    header: 'wind_speed',
    unit: 'wind_speed',
    digits: 1,
    kind: 'number',
    width: 13,
    description: 'Wind speed — the current reading, or forecast days[].wind_speed_max for a daily row.',
  },
  {
    key: 'wind_direction',
    header: 'wind_direction',
    unit: 'degrees',
    digits: 0,
    kind: 'integer',
    width: 15,
    circular: true,
    description: 'Wind direction in degrees clockwise from north.',
  },
  {
    key: 'wind_gusts',
    header: 'wind_gusts',
    unit: 'wind_speed',
    digits: 1,
    kind: 'number',
    width: 13,
    description: 'Wind gusts — the current reading, or forecast days[].wind_gusts_max for a daily row.',
  },
  {
    key: 'uv_index',
    header: 'uv_index',
    unit: 'index',
    digits: 1,
    kind: 'number',
    width: 10,
    description: 'Maximum UV index for the day — forecast days[].uv_index_max.',
  },
] as const;

const BY_KEY = new Map<string, MetricSpec>(METRICS.map((metric) => [metric.key, metric]));

export function metricSpec(key: string): MetricSpec | undefined {
  return BY_KEY.get(key);
}

export function isMetricKey(key: string): key is MetricKey {
  return BY_KEY.has(key);
}

/** Column header including the unit that applies to the dataset. */
export function metricHeader(spec: MetricSpec, units: UnitSystem): string {
  const suffix = unitSuffix(spec.unit, units);
  return suffix === null ? spec.header : `${spec.header}, ${suffix}`;
}

export function unitSuffix(unit: MetricUnit, units: UnitSystem): string | null {
  const set = unitsFor(units);
  switch (unit) {
    case 'temperature':
      return set.temperature;
    case 'wind_speed':
      return set.wind_speed;
    case 'precipitation':
      return set.precipitation;
    case 'percent':
      return '%';
    case 'hpa':
      return 'hPa';
    case 'degrees':
      return '°';
    case 'centimetres':
      return 'cm';
    case 'index':
      return null;
    default:
      return null;
  }
}

/** Rounds a metric to its stored precision, mapping non-finite input to null. */
export function roundMetric(key: MetricKey, value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const digits = BY_KEY.get(key)?.digits ?? 1;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Every metric key, in table order. Used by tests to detect schema drift. */
export const METRIC_KEYS: readonly MetricKey[] = METRICS.map((metric) => metric.key);

/** Reads a metric field off an entry without an index signature. */
export function metricValue(entry: SummaryEntry, key: MetricKey): number | null {
  return entry[key];
}
