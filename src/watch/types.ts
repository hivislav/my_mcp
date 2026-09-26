import type { WeatherSnapshot } from '../weather/snapshot.js';
import type { UnitSystem } from '../weather/units.js';

/** A location the collector polls on a schedule. */
export interface WatchDefinition {
  /** Stable, filesystem-safe identifier chosen by the caller. */
  id: string;
  /** Human-readable place label, e.g. "Москва, Россия". */
  label: string;
  latitude: number;
  longitude: number;
  country: string | null;
  admin1: string | null;
  timezone: string | null;
  /** The place name that was geocoded, or null if coordinates were supplied. */
  resolved_from: string | null;
  units: UnitSystem;
  language: string;
  created_at: string;
  /**
   * Whether the collector should keep polling this watch.
   *
   * Pausing is deliberately separate from deleting: `stop_weather_watch` only
   * flips this to false, so the accumulated history stays readable and resuming
   * is a single call. Losing history is irreversible, so it demands its own
   * explicit action (`delete_weather_watch`).
   *
   * Optional so registries written before this field existed still load; an
   * absent value means enabled.
   */
  enabled?: boolean;
}

/** Reads the effective enabled flag, treating an absent value as enabled. */
export function isEnabled(definition: WatchDefinition): boolean {
  return definition.enabled !== false;
}

/**
 * One collected sample.
 *
 * `at` is when this server took the reading and is what retention and windowing
 * use; `observed_at` is the provider's own timestamp for the values. They differ
 * because the upstream model is refreshed on its own schedule, and conflating
 * them would make a window boundary depend on provider behaviour.
 */
export interface WatchSample {
  watch_id: string;
  at: string;
  observed_at: string;
  timezone: string | null;
  is_day: boolean | null;
  weather_code: number | null;
  condition: string;
  condition_en: string;
  condition_ru: string;
  temperature: number | null;
  apparent_temperature: number | null;
  relative_humidity: number | null;
  precipitation: number | null;
  cloud_cover: number | null;
  pressure_msl: number | null;
  wind_speed: number | null;
  wind_direction: number | null;
  wind_gusts: number | null;
}

/** Collection health for one watch. */
export interface WatchStats {
  last_attempt_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
  /** Lifetime counters, so they stay meaningful after samples are pruned. */
  total_samples: number;
  total_failures: number;
}

export function emptyStats(): WatchStats {
  return {
    last_attempt_at: null,
    last_success_at: null,
    consecutive_failures: 0,
    last_error: null,
    total_samples: 0,
    total_failures: 0,
  };
}

/** Flattens a snapshot into a storable sample, dropping fields the tools do not expose. */
export function sampleFromSnapshot(watchId: string, collectedAt: string, snapshot: WeatherSnapshot): WatchSample {
  return {
    watch_id: watchId,
    at: collectedAt,
    observed_at: snapshot.observed_at,
    timezone: snapshot.timezone,
    is_day: snapshot.is_day,
    weather_code: snapshot.weather_code,
    condition: snapshot.condition,
    condition_en: snapshot.condition_en,
    condition_ru: snapshot.condition_ru,
    temperature: snapshot.temperature,
    apparent_temperature: snapshot.apparent_temperature,
    relative_humidity: snapshot.relative_humidity,
    precipitation: snapshot.precipitation,
    cloud_cover: snapshot.cloud_cover,
    pressure_msl: snapshot.pressure_msl,
    wind_speed: snapshot.wind_speed,
    wind_direction: snapshot.wind_direction,
    wind_gusts: snapshot.wind_gusts,
  };
}

export interface NumericSummary {
  min: number | null;
  max: number | null;
  avg: number | null;
  /** Difference between the last and first value in the window. */
  change: number | null;
  trend: 'rising' | 'falling' | 'steady' | 'unknown';
}

export interface ConditionTally {
  condition: string;
  condition_en: string;
  condition_ru: string;
  samples: number;
  share_percent: number;
}

export interface WatchAggregate {
  window_hours: number;
  sample_count: number;
  /**
   * Minutes between the oldest and newest sample actually in the window.
   *
   * Deliberately not a percentage of a quota: a partial window is the normal state
   * for a young watch, and reporting it as "7 of 96" invited callers to treat
   * available data as unusable.
   */
  observed_span_minutes: number | null;
  first_sample_at: string | null;
  last_sample_at: string | null;
  /** Minutes since the newest sample; large values mean collection is stalled. */
  staleness_minutes: number | null;
  temperature: NumericSummary;
  apparent_temperature: NumericSummary;
  relative_humidity: NumericSummary;
  pressure_msl: NumericSummary;
  wind_speed: NumericSummary;
  wind_gusts_max: number | null;
  precipitation_total: number | null;
  precipitation_max: number | null;
  /** How many samples in the window recorded any precipitation at all. */
  samples_with_precipitation: number;
  conditions: ConditionTally[];
  dominant_condition: ConditionTally | null;
}
