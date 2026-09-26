import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolDeps } from './deps.js';
import { formatLines, guard, toolResult } from './result.js';
import { unitsFor } from '../weather/units.js';
import { fetchWeatherSnapshot } from '../weather/snapshot.js';
import { locationInputShape, locationOutputShape, locationPayload, placeLabel } from './schemas.js';
import { resolveLocation } from './shared.js';

export function registerCurrentWeatherTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_current_weather',
    {
      title: 'Get current weather',
      description:
        'Get the current observed weather at a location: temperature, feels-like temperature, humidity, ' +
        'precipitation, cloud cover, pressure, wind speed/direction/gusts, and a decoded weather condition. ' +
        'Provide either `latitude` + `longitude`, or a `location` place name (which is geocoded automatically). ' +
        'Data comes from the free Open-Meteo API and is model-based, refreshed roughly every 15 minutes. ' +
        'Use `get_weather_forecast` for future days and `get_air_quality` for pollution levels.',
      inputSchema: locationInputShape(),
      outputSchema: {
        location: locationOutputShape(),
        observed_at: z
          .string()
          .describe('Local timestamp of the observation in ISO-8601 format, without a timezone suffix.'),
        timezone: z.string().nullable().describe('IANA timezone the timestamp is expressed in.'),
        utc_offset_seconds: z.number().nullable().describe('Offset from UTC in seconds.'),
        is_day: z.boolean().nullable().describe('True during daylight hours, false at night, null if unknown.'),
        weather_code: z.number().nullable().describe('Raw WMO 4677 weather code as returned by Open-Meteo.'),
        condition: z.string().describe('Machine-readable condition slug, e.g. "light_rain" or "clear_sky".'),
        condition_en: z.string().describe('English condition label, e.g. "Light rain".'),
        condition_ru: z.string().describe('Russian condition label, e.g. "Небольшой дождь".'),
        temperature: z.number().nullable().describe('Air temperature at 2 m above ground.'),
        apparent_temperature: z.number().nullable().describe('Feels-like temperature.'),
        relative_humidity: z.number().nullable().describe('Relative humidity at 2 m, in percent.'),
        precipitation: z.number().nullable().describe('Precipitation in the preceding interval.'),
        rain: z.number().nullable().describe('Rainfall in the preceding interval.'),
        showers: z.number().nullable().describe('Showers in the preceding interval.'),
        snowfall: z.number().nullable().describe('Snowfall in the preceding interval, in centimetres.'),
        cloud_cover: z.number().nullable().describe('Total cloud cover in percent.'),
        pressure_msl: z.number().nullable().describe('Mean sea-level pressure in hPa.'),
        surface_pressure: z.number().nullable().describe('Surface pressure in hPa.'),
        wind_speed: z.number().nullable().describe('Wind speed at 10 m.'),
        wind_direction: z.number().nullable().describe('Wind direction at 10 m, in degrees clockwise from north.'),
        wind_gusts: z.number().nullable().describe('Wind gusts at 10 m.'),
        units: z
          .object({
            temperature: z.string().describe('Unit symbol for temperature values.'),
            wind_speed: z.string().describe('Unit symbol for wind speed values.'),
            precipitation: z.string().describe('Unit symbol for precipitation values.'),
          })
          .describe('Units that apply to every numeric value in this payload.'),
      },
      annotations: {
        title: 'Get current weather',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      guard(
        'get_current_weather',
        deps.logger,
        async ({ latitude, longitude, location, countryCode, language, units }) => {
          const resolved = await resolveLocation(
            deps.clients,
            { latitude, longitude, location, countryCode, language },
            { defaultLanguage: language },
          );

          const snapshot = await fetchWeatherSnapshot(
            { clients: deps.clients, config: deps.config },
            { latitude: resolved.latitude, longitude: resolved.longitude, timezone: resolved.timezone },
            units,
          );

          const { condition, condition_en: conditionEn, condition_ru: conditionRu } = snapshot;
          const code = snapshot.weather_code;
          const unitSet = unitsFor(units);
          const timezone = snapshot.timezone;

          const structured = {
            location: { ...locationPayload(resolved), timezone },
            ...snapshot,
            units: unitSet,
          };

          const text = [
            `Current weather in ${placeLabel(resolved)} (${resolved.latitude}, ${resolved.longitude})`,
            formatLines([
              ['observed at', `${structured.observed_at}${timezone !== null ? ` (${timezone})` : ''}`],
              ['condition', `${conditionEn} / ${conditionRu} (WMO ${code ?? 'n/a'})`],
              ['daylight', structured.is_day === null ? null : structured.is_day ? 'day' : 'night'],
              [
                'temperature',
                structured.temperature === null
                  ? null
                  : `${structured.temperature} ${unitSet.temperature} (feels like ${structured.apparent_temperature ?? 'n/a'} ${unitSet.temperature})`,
              ],
              ['humidity', structured.relative_humidity === null ? null : `${structured.relative_humidity} %`],
              [
                'precipitation',
                structured.precipitation === null
                  ? null
                  : `${structured.precipitation} ${unitSet.precipitation}`,
              ],
              ['cloud cover', structured.cloud_cover === null ? null : `${structured.cloud_cover} %`],
              [
                'wind',
                structured.wind_speed === null
                  ? null
                  : `${structured.wind_speed} ${unitSet.wind_speed} from ${structured.wind_direction ?? 'n/a'}° ` +
                    `(gusts ${structured.wind_gusts ?? 'n/a'} ${unitSet.wind_speed})`,
              ],
              ['pressure', structured.pressure_msl === null ? null : `${structured.pressure_msl} hPa`],
            ]),
          ].join('\n');

          return toolResult(text, structured);
        },
        args,
      ),
  );
}

