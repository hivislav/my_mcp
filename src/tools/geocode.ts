import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolDeps } from './deps.js';
import { formatLines, guard, toolResult } from './result.js';
import { searchPlaces } from './shared.js';

/**
 * Tool 1 — resolve a place name to coordinates.
 *
 * This exists as a separate tool because the weather tools accept a `location`
 * string too, but an agent that must ask "which of these three Springfields?"
 * needs the raw candidate list, which the weather tools deliberately hide.
 */
export function registerGeocodeTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'geocode_location',
    {
      title: 'Geocode a place name',
      description:
        'Resolve a place name (city, town, region) into geographic coordinates and metadata such as ' +
        'country, region and IANA timezone, using the free Open-Meteo geocoding API. ' +
        'Use this when you need coordinates, when you must disambiguate between places with the same name, ' +
        'or when a weather call reported an ambiguous location. ' +
        'Matching is on place names only: street addresses, postcodes and landmark names are not supported. ' +
        'Results are ordered by relevance; each carries a population figure so the largest/most likely match is easy to pick.',
      inputSchema: {
        name: z
          .string()
          .min(1, 'Place name must not be empty')
          .max(200)
          .describe(
            'Place name to look up, for example "Moscow", "Санкт-Петербург" or "Springfield". ' +
              'Use the plain local or English name; do not append a country or postcode.',
          ),
        count: z
          .number()
          .int()
          .min(1)
          .max(20)
          .describe('Maximum number of candidate matches to return. Defaults to 5.')
          .default(5),
        language: z
          .string()
          .min(2)
          .max(10)
          .describe(
            'Language for returned place names, as an ISO-639 code such as "en", "ru" or "de". Defaults to "en".',
          )
          .default('en'),
        countryCode: z
          .string()
          .length(2, 'countryCode must be a 2-letter ISO-3166-1 alpha-2 code, for example "RU" or "US"')
          .describe(
            'Optional ISO-3166-1 alpha-2 country code used to restrict the search, for example "RU" or "US". ' +
              'Strongly recommended when the place name is ambiguous.',
          )
          .optional(),
      },
      outputSchema: {
        query: z.string().describe('The place name that was searched for.'),
        count: z.number().int().describe('Number of matches returned.'),
        results: z
          .array(
            z.object({
              name: z.string().describe('Resolved place name.'),
              latitude: z.number().describe('Latitude in decimal degrees, WGS84.'),
              longitude: z.number().describe('Longitude in decimal degrees, WGS84.'),
              country: z.string().nullable().describe('Country name, or null if unavailable.'),
              countryCode: z.string().nullable().describe('ISO-3166-1 alpha-2 country code, or null.'),
              admin1: z.string().nullable().describe('First-level administrative region (state/oblast), or null.'),
              timezone: z.string().nullable().describe('IANA timezone identifier, or null.'),
              elevation: z.number().nullable().describe('Elevation above sea level in metres, or null.'),
              population: z.number().nullable().describe('Population, or null when unknown. Useful for disambiguation.'),
            }),
          )
          .describe('Candidate matches, most relevant first.'),
        ambiguous: z
          .boolean()
          .describe('True when more than one distinct place matched, so the caller should confirm the intended one.'),
      },
      annotations: {
        title: 'Geocode a place name',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      guard(
        'geocode_location',
        deps.logger,
        async ({ name, count, language, countryCode }) => {
          const matches = await searchPlaces(deps.clients, name, { count, language, countryCode });

          const results = matches.map((match) => ({
            name: match.name,
            latitude: match.latitude,
            longitude: match.longitude,
            country: match.country ?? null,
            countryCode: match.country_code ?? null,
            admin1: match.admin1 ?? null,
            timezone: match.timezone ?? null,
            elevation: match.elevation ?? null,
            population: match.population ?? null,
          }));

          const structured = {
            query: name,
            count: results.length,
            results,
            // Two results in different regions is the signal that the caller must
            // disambiguate, so expose it directly instead of making the model infer it.
            ambiguous: new Set(results.map((r) => `${r.latitude},${r.longitude}`)).size > 1,
          };

          const text =
            results.length === 0
              ? `No place matched "${name}".${countryCode !== undefined ? ` Searched only within country "${countryCode}".` : ''} Try another spelling, a nearby larger city, or pass explicit latitude/longitude.`
              : [
                  `Found ${results.length} match(es) for "${name}":`,
                  ...results.map((r, index) => {
                    const details = formatLines([
                      ['country', [r.admin1, r.country].filter(Boolean).join(', ') || null],
                      ['coordinates', `${r.latitude}, ${r.longitude}`],
                      ['timezone', r.timezone],
                      ['population', r.population],
                    ]);
                    // Indent every detail line, not just the first: formatLines
                    // returns a multi-line block.
                    const indented = details
                      .split('\n')
                      .map((line) => `   ${line}`)
                      .join('\n');
                    return `${index + 1}. ${r.name}\n${indented}`;
                  }),
                  structured.ambiguous
                    ? 'Multiple distinct places matched — confirm which one is intended before using the coordinates.'
                    : '',
                ]
                  .filter((line) => line !== '')
                  .join('\n');

          return toolResult(text, structured);
        },
        args,
      ),
  );
}
