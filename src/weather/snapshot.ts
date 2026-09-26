import type { Config } from '../config.js';
import type { Clients } from '../open-meteo/client.js';
import { OpenMeteoError } from '../open-meteo/errors.js';
import type { ForecastResponse } from '../open-meteo/types.js';
import { decodeWeatherCode } from '../open-meteo/weather-codes.js';
import { bool, num, round, str } from './coerce.js';
import { formatOffset, qualifyTimestamp } from './time.js';
import { type UnitSet, type UnitSystem, unitsFor, upstreamParamsFor } from './units.js';

/** Everything needed to talk to the configured weather backend. */
export interface WeatherSource {
  readonly clients: Pick<Clients, 'forecast'>;
  readonly config: Config;
}

/** Current-condition variables offered by the Open-Meteo forecast endpoints. */
export const CURRENT_VARIABLES = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'is_day',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'weather_code',
  'cloud_cover',
  'pressure_msl',
  'surface_pressure',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
] as const;

/** A single point-in-time observation of the weather at one location. */
export interface WeatherSnapshot {
  observed_at: string;
  timezone: string | null;
  utc_offset_seconds: number | null;
  is_day: boolean | null;
  weather_code: number | null;
  condition: string;
  condition_en: string;
  condition_ru: string;
  temperature: number | null;
  apparent_temperature: number | null;
  relative_humidity: number | null;
  precipitation: number | null;
  rain: number | null;
  showers: number | null;
  snowfall: number | null;
  cloud_cover: number | null;
  pressure_msl: number | null;
  surface_pressure: number | null;
  wind_speed: number | null;
  wind_direction: number | null;
  wind_gusts: number | null;
  units: UnitSet;
}

export interface SnapshotTarget {
  latitude: number;
  longitude: number;
  /** Falls back to the location's own timezone when the backend omits one. */
  timezone?: string | null | undefined;
}

/**
 * Resolves the forecast endpoint from configuration.
 *
 * The path and the `models` parameter travel together: the standard forecast
 * host wants `/v1/forecast` and takes no `models`, while the ensemble host wants
 * `/v1/ensemble` and rejects the default `best_match` unless a model is named.
 * Keeping them in one place stops callers from drifting apart.
 */
export function forecastTarget(config: Config): { path: string; models: string | undefined } {
  const models = config.openMeteo.models.trim();
  return {
    path: config.openMeteo.forecastPath,
    models: models === '' ? undefined : models,
  };
}

/**
 * Open-Meteo normally signals problems with a 4xx status, which the client
 * already classifies. It can also return HTTP 200 with `{"error": true}`, so
 * every caller checks for that rather than trusting the status code alone.
 */
export function assertNoUpstreamError(payload: { error?: boolean; reason?: string }, context: string): void {
  if (payload.error === true) {
    throw new OpenMeteoError('invalid_request', `${context}: ${payload.reason ?? 'upstream reported an error'}`, {
      retryable: false,
    });
  }
}

/**
 * Fetches one current-conditions snapshot.
 *
 * Shared by the `get_current_weather` tool and the periodic watcher, so both
 * paths produce byte-identical values for the same moment — otherwise a report
 * could disagree with a direct query and look like a bug.
 */
export async function fetchWeatherSnapshot(
  source: WeatherSource,
  target: SnapshotTarget,
  units: UnitSystem,
  signal?: AbortSignal,
): Promise<WeatherSnapshot> {
  const endpoint = forecastTarget(source.config);

  const payload = await source.clients.forecast.getJson<ForecastResponse>(
    endpoint.path,
    {
      latitude: target.latitude,
      longitude: target.longitude,
      current: [...CURRENT_VARIABLES],
      timezone: 'auto',
      models: endpoint.models,
      ...upstreamParamsFor(units),
    },
    signal,
  );
  assertNoUpstreamError(payload, 'Current weather request was rejected');

  return toSnapshot(payload, target, units);
}

/** Maps a raw upstream payload onto the normalised snapshot shape. */
export function toSnapshot(payload: ForecastResponse, target: SnapshotTarget, units: UnitSystem): WeatherSnapshot {
  const current = payload.current ?? {};
  const code = num(current['weather_code']);
  const condition = decodeWeatherCode(code);

  return {
    // Qualified with an explicit offset: the provider sends a bare local
    // wall-clock string, which read as UTC would be hours off.
    observed_at: qualifyTimestamp(
      str(current['time']) ?? '',
      formatOffset(payload.utc_offset_seconds),
    ),
    timezone: payload.timezone ?? target.timezone ?? null,
    utc_offset_seconds: payload.utc_offset_seconds ?? null,
    is_day: bool(current['is_day']),
    weather_code: code,
    condition: condition.condition,
    condition_en: condition.en,
    condition_ru: condition.ru,
    temperature: round(num(current['temperature_2m'])),
    apparent_temperature: round(num(current['apparent_temperature'])),
    relative_humidity: round(num(current['relative_humidity_2m']), 0),
    precipitation: round(num(current['precipitation']), 2),
    rain: round(num(current['rain']), 2),
    showers: round(num(current['showers']), 2),
    snowfall: round(num(current['snowfall']), 2),
    cloud_cover: round(num(current['cloud_cover']), 0),
    pressure_msl: round(num(current['pressure_msl'])),
    surface_pressure: round(num(current['surface_pressure'])),
    wind_speed: round(num(current['wind_speed_10m'])),
    wind_direction: round(num(current['wind_direction_10m']), 0),
    wind_gusts: round(num(current['wind_gusts_10m'])),
    units: unitsFor(units),
  };
}
