import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ForecastResponse } from '../open-meteo/types.js';
import { decodeWeatherCode } from '../open-meteo/weather-codes.js';
import type { ToolDeps } from './deps.js';
import { num, series, str } from '../weather/coerce.js';
import { formatLines, guard, toolResult } from './result.js';
import { unitsFor, upstreamParamsFor } from '../weather/units.js';
import { locationInputShape, locationOutputShape, locationPayload, placeLabel } from './schemas.js';
import { resolveLocation } from './shared.js';
import { assertNoUpstreamError, forecastTarget } from '../weather/snapshot.js';
import { round } from '../weather/coerce.js';

const DAILY_VARIABLES = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'apparent_temperature_max',
  'apparent_temperature_min',
  'sunrise',
  'sunset',
  'daylight_duration',
  'uv_index_max',
  'precipitation_sum',
  'rain_sum',
  'snowfall_sum',
  'precipitation_hours',
  'precipitation_probability_max',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
] as const;

const HOURLY_VARIABLES = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'precipitation_probability',
  'precipitation',
  'weather_code',
  'cloud_cover',
  'wind_speed_10m',
  'wind_direction_10m',
] as const;

/** Free-tier forecast horizon. */
const MAX_FORECAST_DAYS = 16;

export function registerForecastTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_weather_forecast',
    {
      title: 'Get weather forecast',
      description:
        'Get a day-by-day weather forecast for a location, up to 16 days ahead, including min/max temperature, ' +
        'feels-like range, precipitation totals and probability, snowfall, UV index, sunrise/sunset and maximum wind. ' +
        'Optionally include hourly detail. ' +
        'Provide either `latitude` + `longitude`, or a `location` place name (which is geocoded automatically). ' +
        'Data comes from the free Open-Meteo API. Forecast confidence drops sharply beyond about 7 days, ' +
        'so treat later days as a trend rather than a precise prediction. ' +
        'Use `get_current_weather` for present conditions.',
      inputSchema: {
        ...locationInputShape(),
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_FORECAST_DAYS)
          .describe(
            `Number of forecast days to return, 1..${MAX_FORECAST_DAYS}. Day 1 is today in the location's timezone. Defaults to 7.`,
          )
          .default(7),
        include_hourly: z
          .boolean()
          .describe(
            'When true, also return an hour-by-hour series for the same period. This multiplies the response size ' +
              'by roughly 24x, so enable it only when hourly detail is actually needed.',
          )
          .default(false),
      },
      outputSchema: {
        location: locationOutputShape(),
        generated_at: z.string().describe('Server timestamp when this forecast was produced, ISO-8601 UTC.'),
        timezone: z.string().nullable().describe('IANA timezone all dates and times are expressed in.'),
        days_requested: z.number().int().describe('Number of days requested.'),
        days: z
          .array(
            z.object({
              date: z.string().describe('Calendar date, YYYY-MM-DD, in the location timezone.'),
              weather_code: z.number().nullable().describe('Dominant WMO 4677 weather code for the day.'),
              condition: z.string().describe('Machine-readable condition slug.'),
              condition_en: z.string().describe('English condition label.'),
              condition_ru: z.string().describe('Russian condition label.'),
              temperature_max: z.number().nullable().describe('Maximum air temperature at 2 m.'),
              temperature_min: z.number().nullable().describe('Minimum air temperature at 2 m.'),
              apparent_temperature_max: z.number().nullable().describe('Maximum feels-like temperature.'),
              apparent_temperature_min: z.number().nullable().describe('Minimum feels-like temperature.'),
              precipitation_sum: z.number().nullable().describe('Total precipitation for the day.'),
              rain_sum: z.number().nullable().describe('Total rainfall for the day.'),
              snowfall_sum: z.number().nullable().describe('Total snowfall for the day, in centimetres.'),
              precipitation_hours: z.number().nullable().describe('Number of hours with precipitation.'),
              precipitation_probability_max: z
                .number()
                .nullable()
                .describe(
                  'Maximum precipitation probability, percent, or null when the configured data source does not ' +
                    'provide it. The default ensemble source does not; the standard forecast source does.',
                ),
              uv_index_max: z.number().nullable().describe('Maximum UV index. Values of 3+ warrant sun protection.'),
              wind_speed_max: z.number().nullable().describe('Maximum wind speed at 10 m.'),
              wind_gusts_max: z.number().nullable().describe('Maximum wind gust at 10 m.'),
              wind_direction_dominant: z.number().nullable().describe('Dominant wind direction, degrees from north.'),
              sunrise: z.string().nullable().describe('Sunrise time, ISO-8601 local time, or null at high latitudes.'),
              sunset: z.string().nullable().describe('Sunset time, ISO-8601 local time, or null at high latitudes.'),
              daylight_duration: z.number().nullable().describe('Daylight duration in seconds.'),
            }),
          )
          .describe('One entry per forecast day, starting with today.'),
        hourly: z
          .array(
            z.object({
              time: z.string().describe('Hour timestamp, ISO-8601 local time.'),
              temperature: z.number().nullable().describe('Air temperature at 2 m.'),
              apparent_temperature: z.number().nullable().describe('Feels-like temperature.'),
              relative_humidity: z.number().nullable().describe('Relative humidity, percent.'),
              precipitation: z.number().nullable().describe('Precipitation in that hour.'),
              precipitation_probability: z
                .number()
                .nullable()
                .describe('Precipitation probability, percent, or null when the data source does not provide it.'),
              weather_code: z.number().nullable().describe('WMO weather code for that hour.'),
              cloud_cover: z.number().nullable().describe('Cloud cover, percent.'),
              wind_speed: z.number().nullable().describe('Wind speed at 10 m.'),
              wind_direction: z.number().nullable().describe('Wind direction, degrees from north.'),
            }),
          )
          .nullable()
          .describe('Hourly series when `include_hourly` was true, otherwise null.'),
        units: z
          .object({
            temperature: z.string().describe('Unit symbol for temperature values.'),
            wind_speed: z.string().describe('Unit symbol for wind speed values.'),
            precipitation: z.string().describe('Unit symbol for precipitation values.'),
          })
          .describe('Units that apply to every numeric value in this payload.'),
      },
      annotations: {
        title: 'Get weather forecast',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      guard(
        'get_weather_forecast',
        deps.logger,
        async ({ latitude, longitude, location, countryCode, language, units, days, include_hourly }) => {
          const resolved = await resolveLocation(
            deps.clients,
            { latitude, longitude, location, countryCode, language },
            { defaultLanguage: language },
          );

          const target = forecastTarget(deps.config);
          const payload = await deps.clients.forecast.getJson<ForecastResponse>(target.path, {
            latitude: resolved.latitude,
            longitude: resolved.longitude,
            daily: [...DAILY_VARIABLES],
            hourly: include_hourly ? [...HOURLY_VARIABLES] : undefined,
            forecast_days: days,
            timezone: 'auto',
            models: target.models,
            ...upstreamParamsFor(units),
          });
          assertNoUpstreamError(payload, 'Forecast request was rejected');

          const unitSet = unitsFor(units);
          const timezone = payload.timezone ?? resolved.timezone ?? null;
          const daily = payload.daily;
          const dates = series(daily, 'time').map((v) => str(v) ?? '');

          const forecastDays = dates.map((date, index) => {
            const pick = (key: string) => num(series(daily, key)[index]);
            const code = pick('weather_code');
            const condition = decodeWeatherCode(code);
            return {
              date,
              weather_code: code,
              condition: condition.condition,
              condition_en: condition.en,
              condition_ru: condition.ru,
              temperature_max: round(pick('temperature_2m_max')),
              temperature_min: round(pick('temperature_2m_min')),
              apparent_temperature_max: round(pick('apparent_temperature_max')),
              apparent_temperature_min: round(pick('apparent_temperature_min')),
              precipitation_sum: round(pick('precipitation_sum'), 2),
              rain_sum: round(pick('rain_sum'), 2),
              snowfall_sum: round(pick('snowfall_sum'), 2),
              precipitation_hours: round(pick('precipitation_hours'), 0),
              precipitation_probability_max: round(pick('precipitation_probability_max'), 0),
              uv_index_max: round(pick('uv_index_max')),
              wind_speed_max: round(pick('wind_speed_10m_max')),
              wind_gusts_max: round(pick('wind_gusts_10m_max')),
              wind_direction_dominant: round(pick('wind_direction_10m_dominant'), 0),
              sunrise: str(series(daily, 'sunrise')[index]),
              sunset: str(series(daily, 'sunset')[index]),
              daylight_duration: round(pick('daylight_duration'), 0),
            };
          });

          // `hourly` is intentionally null rather than an empty array when not
          // requested, so the model can tell "not asked for" from "asked, empty".
          const hourly = include_hourly ? buildHourly(payload) : null;

          const structured = {
            location: { ...locationPayload(resolved), timezone },
            generated_at: new Date().toISOString(),
            timezone,
            days_requested: days,
            days: forecastDays,
            hourly,
            units: unitSet,
          };

          const text = [
            `Forecast for ${placeLabel(resolved)} (${resolved.latitude}, ${resolved.longitude})`,
            `Timezone: ${timezone ?? 'unknown'} | Units: ${unitSet.temperature}, ${unitSet.wind_speed}, ${unitSet.precipitation}`,
            '',
            ...forecastDays.map((day) =>
              [
                `${day.date}: ${day.condition_en} (${day.condition_ru})`,
                formatLines([
                  [
                    'temp',
                    day.temperature_max === null || day.temperature_min === null
                      ? null
                      : `${day.temperature_min}..${day.temperature_max} ${unitSet.temperature}` +
                        (day.apparent_temperature_min !== null && day.apparent_temperature_max !== null
                          ? ` (feels ${day.apparent_temperature_min}..${day.apparent_temperature_max})`
                          : ''),
                  ],
                  [
                    'precip',
                    day.precipitation_sum === null
                      ? null
                      : `${day.precipitation_sum} ${unitSet.precipitation}` +
                        (day.precipitation_probability_max !== null
                          ? `, max probability ${day.precipitation_probability_max}%`
                          : ''),
                  ],
                  ['snow', day.snowfall_sum === null || day.snowfall_sum === 0 ? null : `${day.snowfall_sum} cm`],
                  ['wind', day.wind_speed_max === null ? null : `up to ${day.wind_speed_max} ${unitSet.wind_speed}`],
                  ['uv index', day.uv_index_max === null ? null : day.uv_index_max],
                  ['sun', day.sunrise !== null && day.sunset !== null ? `${day.sunrise} → ${day.sunset}` : null],
                ]),
              ].join('\n  '),
            ),
            hourly !== null ? `\nHourly detail: ${hourly.length} entries (see structured content).` : '',
          ]
            .filter((line) => line !== '')
            .join('\n');

          return toolResult(text, structured);
        },
        args,
      ),
  );
}

function buildHourly(payload: ForecastResponse) {
  const hourly = payload.hourly;
  return series(hourly, 'time').map((time, index) => {
    const pick = (key: string) => num(series(hourly, key)[index]);
    return {
      time: str(time) ?? '',
      temperature: round(pick('temperature_2m')),
      apparent_temperature: round(pick('apparent_temperature')),
      relative_humidity: round(pick('relative_humidity_2m'), 0),
      precipitation: round(pick('precipitation'), 2),
      precipitation_probability: round(pick('precipitation_probability'), 0),
      weather_code: pick('weather_code'),
      cloud_cover: round(pick('cloud_cover'), 0),
      wind_speed: round(pick('wind_speed_10m')),
      wind_direction: round(pick('wind_direction_10m'), 0),
    };
  });
}
