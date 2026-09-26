import { z } from 'zod';
import type { ResolvedLocation } from './shared.js';
import { UNIT_SYSTEM_DESCRIPTION } from '../weather/units.js';

/**
 * The location inputs are shared by every weather tool so that the parameter
 * names, descriptions and semantics an agent sees never drift between tools.
 *
 * `latitude`/`longitude` and `location` are all optional here because JSON Schema
 * (as rendered to models by MCP clients) cannot express "exactly one of these two
 * forms". The either/or rule is enforced in `resolveLocation`, which returns an
 * error message that tells the model precisely what to do differently.
 */
export function locationInputShape() {
  return {
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .describe(
        'Latitude in decimal degrees, -90..90. Must be supplied together with `longitude`. ' +
          'If you only know a place name, omit both and use `location` instead.',
      )
      .optional(),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .describe('Longitude in decimal degrees, -180..180. Must be supplied together with `latitude`.')
      .optional(),
    location: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'Free-text place name such as "Moscow" or "Санкт-Петербург". The server geocodes it automatically and picks ' +
          'the most populous match. Use this when you do not have coordinates. Ignored when latitude/longitude are given.',
      )
      .optional(),
    countryCode: z
      .string()
      .length(2, 'countryCode must be a 2-letter ISO-3166-1 alpha-2 code, for example "RU" or "US"')
      .describe(
        'Optional ISO-3166-1 alpha-2 country code that narrows geocoding of `location`, for example "RU" or "US". ' +
          'Recommended whenever the place name is ambiguous.',
      )
      .optional(),
    language: z
      .string()
      .min(2)
      .max(10)
      .describe('Language for the returned place name, as an ISO-639 code such as "en" or "ru". Defaults to "en".')
      .default('en'),
    units: z
      .enum(['metric', 'imperial'])
      .describe(UNIT_SYSTEM_DESCRIPTION)
      .default('metric'),
  };
}

/** Structured shape describing where an answer applies. Shared by all tools. */
export function locationOutputShape() {
  return z.object({
    name: z.string().describe('Resolved place name.'),
    latitude: z.number().describe('Latitude actually used for the query.'),
    longitude: z.number().describe('Longitude actually used for the query.'),
    country: z.string().nullable().describe('Country name, or null when coordinates were supplied directly.'),
    admin1: z.string().nullable().describe('Region/state, or null when unavailable.'),
    timezone: z.string().nullable().describe('IANA timezone of the location, or null when unknown.'),
    resolvedFrom: z.string().nullable().describe('The place name that was geocoded, or null if coordinates were given.'),
  });
}

export function locationPayload(location: ResolvedLocation) {
  return {
    name: location.name,
    latitude: location.latitude,
    longitude: location.longitude,
    country: location.country ?? null,
    admin1: location.admin1 ?? null,
    timezone: location.timezone ?? null,
    resolvedFrom: location.geocodedFrom ?? null,
  };
}

/** Human-readable one-line place label for the text channel. */
export function placeLabel(location: ResolvedLocation): string {
  const extra = [location.admin1, location.country].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const deduped = [location.name, ...extra].filter((part, index, all) => all.indexOf(part) === index);
  return deduped.join(', ');
}
