/**
 * Raw shapes returned by the Open-Meteo JSON APIs.
 *
 * Only the fields this server actually consumes are modelled; anything else in
 * the payload is intentionally ignored rather than passed through, so the tool
 * output stays small and stable for the calling agent.
 */

export interface GeoSearchResponse {
  /** Absent entirely when nothing matched — this is not an error upstream. */
  results?: GeoResult[];
  generationtime_ms?: number;
}

export interface GeoResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  elevation?: number;
  feature_code?: string;
  country_code?: string;
  country?: string;
  admin1?: string;
  admin2?: string;
  admin3?: string;
  admin4?: string;
  timezone?: string;
  population?: number;
  postcodes?: string[];
}

export interface ForecastUnits {
  [variable: string]: string;
}

export interface ForecastResponse {
  latitude: number;
  longitude: number;
  generationtime_ms?: number;
  utc_offset_seconds?: number;
  timezone?: string;
  timezone_abbreviation?: string;
  elevation?: number;
  current_units?: ForecastUnits;
  current?: Record<string, number | string | null>;
  daily_units?: ForecastUnits;
  daily?: Record<string, Array<number | string | null>>;
  hourly_units?: ForecastUnits;
  hourly?: Record<string, Array<number | string | null>>;
  /** Open-Meteo can report a problem inside an HTTP 200 response. */
  error?: boolean;
  reason?: string;
}
