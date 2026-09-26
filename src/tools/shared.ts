import type { Clients } from '../open-meteo/client.js';
import { InvalidInputError } from '../open-meteo/errors.js';
import type { GeoResult } from '../open-meteo/types.js';

export interface ResolvedLocation {
  name: string;
  latitude: number;
  longitude: number;
  country: string | undefined;
  countryCode: string | undefined;
  admin1: string | undefined;
  timezone: string | undefined;
  elevation: number | undefined;
  /** True when the coordinates were supplied directly instead of geocoded. */
  fromCoordinates: boolean;
  /** Populated only when a place name had to be geocoded. */
  geocodedFrom: string | undefined;
}

export interface LocationArgs {
  latitude?: number | undefined;
  longitude?: number | undefined;
  location?: string | undefined;
  countryCode?: string | undefined;
  language?: string | undefined;
}

/**
 * Weather tools accept either explicit coordinates or a free-text place name.
 *
 * Agents almost always know a city name and rarely know its coordinates, so
 * forcing `geocode_location` as a separate manual step would make every weather
 * call a two-turn conversation. Accepting both keeps the common case to one turn
 * while still allowing precise coordinates when the caller has them.
 *
 * Validation happens here rather than in the JSON Schema because "either A or B"
 * is not expressible in the subset of JSON Schema that MCP clients render for
 * tool parameters — a half-expressed schema would confuse the model more than a
 * clear runtime error message does.
 */
export async function resolveLocation(
  clients: Clients,
  args: LocationArgs,
  options: { language?: string | undefined; defaultLanguage?: string } = {},
): Promise<ResolvedLocation> {
  const hasLat = args.latitude !== undefined;
  const hasLon = args.longitude !== undefined;

  if (hasLat !== hasLon) {
    throw new InvalidInputError(
      '`latitude` and `longitude` must be provided together. Supply both coordinates, or omit both and pass `location` instead.',
    );
  }

  if (hasLat && hasLon) {
    const latitude = args.latitude!;
    const longitude = args.longitude!;
    assertRange(latitude, -90, 90, 'latitude');
    assertRange(longitude, -180, 180, 'longitude');
    return {
      name: `${formatCoord(latitude)}, ${formatCoord(longitude)}`,
      latitude,
      longitude,
      country: undefined,
      countryCode: undefined,
      admin1: undefined,
      timezone: undefined,
      elevation: undefined,
      fromCoordinates: true,
      geocodedFrom: undefined,
    };
  }

  const query = args.location?.trim();
  if (query === undefined || query.length === 0) {
    throw new InvalidInputError(
      'No location given. Pass either `latitude` + `longitude`, or `location` with a place name such as "Moscow" or "Санкт-Петербург".',
    );
  }

  const match = await geocodeBestMatch(clients, query, {
    countryCode: args.countryCode,
    language: options.language ?? args.language ?? options.defaultLanguage ?? 'en',
  });

  return {
    name: match.name,
    latitude: match.latitude,
    longitude: match.longitude,
    country: match.country,
    countryCode: match.country_code,
    admin1: match.admin1,
    timezone: match.timezone,
    elevation: match.elevation,
    fromCoordinates: false,
    geocodedFrom: query,
  };
}

export async function geocodeBestMatch(
  clients: Clients,
  name: string,
  options: { countryCode?: string | undefined; language?: string } = {},
): Promise<GeoResult> {
  const results = await searchPlaces(clients, name, { ...options, count: 5 });

  if (results.length === 0) {
    throw new InvalidInputError(
      `No place matched "${name}"${options.countryCode !== undefined ? ` in country "${options.countryCode}"` : ''}. ` +
        'Try a different spelling, a larger nearby city, or pass explicit latitude/longitude. ' +
        'Note that Open-Meteo geocoding matches place names only — not street addresses or landmarks.',
    );
  }

  // Open-Meteo returns relevance-ordered results, but population is a far better
  // signal for the "which Moscow did you mean" problem, so prefer the largest.
  return results.reduce((best, candidate) => {
    const bestPopulation = best.population ?? 0;
    const candidatePopulation = candidate.population ?? 0;
    return candidatePopulation > bestPopulation ? candidate : best;
  }, results[0]!);
}

export async function searchPlaces(
  clients: Clients,
  name: string,
  options: { count?: number; countryCode?: string | undefined; language?: string } = {},
): Promise<GeoResult[]> {
  const payload = await clients.geocoding.getJson<{ results?: GeoResult[] }>('/v1/search', {
    name,
    count: options.count ?? 10,
    language: options.language ?? 'en',
    format: 'json',
    countryCode: options.countryCode,
  });

  if (!Array.isArray(payload.results)) return [];
  // Upstream occasionally includes entries without usable coordinates; drop them
  // rather than letting `undefined` reach the numeric range checks downstream.
  return payload.results.filter(
    (r) => typeof r?.latitude === 'number' && typeof r?.longitude === 'number' && typeof r?.name === 'string',
  );
}

/** Bounds-checks a coordinate before it reaches the upstream API. */
export function assertRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new InvalidInputError(`\`${label}\` must be a finite number, got ${String(value)}.`);
  }
  if (value < min || value > max) {
    throw new InvalidInputError(`\`${label}\` must be between ${min} and ${max}, got ${value}.`);
  }
}

export function formatCoord(value: number): string {
  return value.toFixed(4);
}
