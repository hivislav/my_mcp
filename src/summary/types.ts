import type { UnitSystem } from '../weather/units.js';

/**
 * The saved-summary domain.
 *
 * A "summary" here is a curated table of weather values the agent decided to keep:
 * one row per place-and-day (or per place-and-hour), plus the agent's own written
 * analysis. It is deliberately separate from the watch history:
 *
 * - watch samples are raw readings the server collects on a timer, keyed to a
 *   watch id and pruned by retention;
 * - a summary is a finished artefact — a selection of values the agent judged
 *   worth keeping, in the shape it wants to publish, and it does not expire.
 *
 * Summaries are what `export_weather_summary_excel` turns into a spreadsheet, so
 * the entry shape is also the spreadsheet column set.
 */

/** One row of a saved summary. Metric fields are null when the source had no value. */
export interface SummaryEntry {
  /** Place label, e.g. "Москва" or "Moscow, RU". */
  location: string;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  /**
   * Calendar date (YYYY-MM-DD) the row describes. Stored as text on purpose: it
   * stays readable, sorts correctly and is immune to spreadsheet date-format and
   * timezone reinterpretation.
   */
  date: string | null;
  /** Free-text condition, e.g. "Light rain" or "Небольшой дождь". */
  condition: string | null;
  /** Raw WMO 4677 code, when known. */
  weather_code: number | null;
  temperature: number | null;
  apparent_temperature: number | null;
  temperature_min: number | null;
  temperature_max: number | null;
  relative_humidity: number | null;
  precipitation: number | null;
  precipitation_probability: number | null;
  snowfall: number | null;
  cloud_cover: number | null;
  pressure_msl: number | null;
  wind_speed: number | null;
  wind_direction: number | null;
  wind_gusts: number | null;
  uv_index: number | null;
  /** Free-text remark for this row. */
  note: string | null;
  /**
   * Agent-supplied extra metrics that have no fixed column (air quality,
   * probability from another model, a computed index). They become additional
   * columns in the spreadsheet.
   */
  extra: Record<string, string | number> | null;
}

/** Where a saved summary came from. */
export interface SummaryOrigin {
  kind: 'agent' | 'watch';
  /** Watch the rows were derived from, for `kind: "watch"`. */
  watch_id: string | null;
  /** Window that was aggregated, for `kind: "watch"`. */
  watch_window_hours: number | null;
  /** Free-text provenance, e.g. "get_weather_forecast (ensemble gfs05)". */
  description: string | null;
}

/** A saved summary exactly as it is stored: metadata plus every row. */
export interface SummaryDataset {
  id: string;
  title: string;
  summary: string | null;
  units: UnitSystem;
  tags: string[];
  /** Distinct place labels in the data, in first-seen order. */
  locations: string[];
  /** Earliest and latest `date` seen, ISO-8601 text, null when no row carries one. */
  period: { from: string | null; to: string | null };
  entry_count: number;
  created_at: string;
  updated_at: string;
  origin: SummaryOrigin;
  entries: SummaryEntry[];
}

/** Listing view: everything except the rows, plus where the dataset lives on disk. */
export interface SummaryDatasetMeta extends Omit<SummaryDataset, 'entries'> {
  /** Bytes of the stored JSON file, for the listing. */
  size_bytes: number;
  /** Absolute path of the stored JSON file. */
  file_path: string;
}

/** A dataset as read back from disk: its rows plus its location and size. */
export interface SummaryDatasetRecord extends SummaryDataset {
  size_bytes: number;
  file_path: string;
}

export interface SummaryIndexEntry extends Omit<SummaryDatasetMeta, 'file_path'> {
  /** File name inside the data directory, so the absolute path can be rebuilt. */
  file: string;
}

/** Aggregated statistics for one metric, one location — the Stats sheet. */
export interface MetricStat {
  location: string;
  metric: string;
  unit: string;
  samples: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  /** Filled only for accumulations (precipitation, snowfall). */
  sum: number | null;
}
