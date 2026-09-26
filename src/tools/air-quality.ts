import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ForecastResponse } from '../open-meteo/types.js';
import type { ToolDeps } from './deps.js';
import { num, str } from '../weather/coerce.js';
import { formatLines, guard, toolResult } from './result.js';
import { locationInputShape, locationOutputShape, locationPayload, placeLabel } from './schemas.js';
import { resolveLocation } from './shared.js';
import { assertNoUpstreamError } from '../weather/snapshot.js';
import { round } from '../weather/coerce.js';

const AIR_QUALITY_VARIABLES = [
  'pm10',
  'pm2_5',
  'carbon_monoxide',
  'nitrogen_dioxide',
  'sulphur_dioxide',
  'ozone',
  'european_aqi',
  'us_aqi',
  'uv_index',
  'dust',
  'ammonia',
  'aerosol_optical_depth',
] as const;

/**
 * European AQI bands, as published by the European Environment Agency.
 *
 * The published table gives inclusive ranges ("40-60 Moderate", "60-80 Poor")
 * that overlap at the boundaries. We resolve the overlap with half-open
 * intervals `[low, high)`, so an index of exactly 60 is "poor" — consistent
 * with how Open-Meteo itself labels the 60-80 band.
 *
 * The band and its advice are returned alongside the raw index because "EAQI 60"
 * means nothing to a model, while "poor — reduce outdoor exertion" is directly
 * actionable.
 */
function classifyEuropeanAqi(aqi: number | null): { band: string; band_ru: string; advice: string } | null {
  if (aqi === null) return null;
  if (aqi < 20) return { band: 'good', band_ru: 'Хорошо', advice: 'Air quality is good; no restrictions.' };
  if (aqi < 40)
    return { band: 'fair', band_ru: 'Приемлемо', advice: 'Air quality is acceptable for normal outdoor activity.' };
  if (aqi < 60)
    return {
      band: 'moderate',
      band_ru: 'Умеренно',
      advice: 'Sensitive groups should consider limiting prolonged exertion.',
    };
  if (aqi < 80) return { band: 'poor', band_ru: 'Плохо', advice: 'Sensitive groups should reduce outdoor exertion.' };
  if (aqi < 100)
    return { band: 'very_poor', band_ru: 'Очень плохо', advice: 'Everyone should reduce outdoor exertion.' };
  return { band: 'extremely_poor', band_ru: 'Чрезвычайно плохо', advice: 'Avoid outdoor activity.' };
}

export function registerAirQualityTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_air_quality',
    {
      title: 'Get air quality',
      description:
        'Get current air quality at a location: PM2.5 and PM10 particulates, ozone, nitrogen dioxide, sulphur dioxide, ' +
        'carbon monoxide, ammonia, dust, UV index, plus the European and US air quality indices with a decoded severity ' +
        'band and health advice. ' +
        'Provide either `latitude` + `longitude`, or a `location` place name (which is geocoded automatically). ' +
        'Data comes from the free Open-Meteo air quality API (CAMS model output, updated hourly). ' +
        'Use this for pollution, smog and health-risk questions; use `get_current_weather` for temperature and wind.',
      inputSchema: locationInputShape(),
      outputSchema: {
        location: locationOutputShape(),
        observed_at: z.string().describe('Local timestamp of the observation, ISO-8601 without timezone suffix.'),
        timezone: z.string().nullable().describe('IANA timezone the timestamp is expressed in.'),
        european_aqi: z.number().nullable().describe('European AQI. Bands: <20 good, <40 fair, <60 moderate, <80 poor, <100 very poor, 100+ extremely poor.'),
        us_aqi: z.number().nullable().describe('United States AQI, where 0-50 is good and 301+ is hazardous.'),
        aqi_band: z.string().nullable().describe('Severity band for the European AQI, e.g. "poor". Null if unavailable.'),
        aqi_band_ru: z.string().nullable().describe('Russian label for the severity band, e.g. "Плохо".'),
        aqi_advice: z.string().nullable().describe('Short health guidance derived from the European AQI band.'),
        pm2_5: z.number().nullable().describe('Fine particulate matter (PM2.5) concentration.'),
        pm10: z.number().nullable().describe('Coarse particulate matter (PM10) concentration.'),
        ozone: z.number().nullable().describe('Ozone (O3) concentration.'),
        nitrogen_dioxide: z.number().nullable().describe('Nitrogen dioxide (NO2) concentration.'),
        sulphur_dioxide: z.number().nullable().describe('Sulphur dioxide (SO2) concentration.'),
        carbon_monoxide: z.number().nullable().describe('Carbon monoxide (CO) concentration.'),
        ammonia: z.number().nullable().describe('Ammonia (NH3) concentration.'),
        dust: z.number().nullable().describe('Saharan dust concentration.'),
        aerosol_optical_depth: z.number().nullable().describe('Aerosol optical depth, a unitless haze measure.'),
        uv_index: z.number().nullable().describe('UV index. 3+ warrants sun protection.'),
        units: z
          .object({
            particulate_matter: z.string().describe('Unit for all pollutant concentrations.'),
          })
          .describe('Units that apply to the pollutant concentration values.'),
      },
      annotations: {
        title: 'Get air quality',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      guard(
        'get_air_quality',
        deps.logger,
        async ({ latitude, longitude, location, countryCode, language }) => {
          const resolved = await resolveLocation(
            deps.clients,
            { latitude, longitude, location, countryCode, language },
            { defaultLanguage: language },
          );

          const payload = await deps.clients.airQuality.getJson<ForecastResponse>('/v1/air-quality', {
            latitude: resolved.latitude,
            longitude: resolved.longitude,
            current: [...AIR_QUALITY_VARIABLES],
            timezone: 'auto',
          });
          assertNoUpstreamError(payload, 'Air quality request was rejected');

          const current = payload.current ?? {};
          // Open-Meteo reports concentrations in μg/m³ for every pollutant here.
          const concentrationUnit = payload.current_units?.['pm2_5'] ?? 'μg/m³';
          const timezone = payload.timezone ?? resolved.timezone ?? null;
          const europeanAqi = num(current['european_aqi']);
          const band = classifyEuropeanAqi(europeanAqi);

          const structured = {
            location: { ...locationPayload(resolved), timezone },
            observed_at: str(current['time']) ?? '',
            timezone,
            european_aqi: europeanAqi,
            us_aqi: num(current['us_aqi']),
            aqi_band: band?.band ?? null,
            aqi_band_ru: band?.band_ru ?? null,
            aqi_advice: band?.advice ?? null,
            pm2_5: round(num(current['pm2_5'])),
            pm10: round(num(current['pm10'])),
            ozone: round(num(current['ozone'])),
            nitrogen_dioxide: round(num(current['nitrogen_dioxide'])),
            sulphur_dioxide: round(num(current['sulphur_dioxide'])),
            carbon_monoxide: round(num(current['carbon_monoxide'])),
            ammonia: round(num(current['ammonia'])),
            dust: round(num(current['dust'])),
            aerosol_optical_depth: round(num(current['aerosol_optical_depth']), 2),
            uv_index: round(num(current['uv_index'])),
            units: { particulate_matter: concentrationUnit },
          };

          const text = [
            `Air quality in ${placeLabel(resolved)} (${resolved.latitude}, ${resolved.longitude})`,
            formatLines([
              ['observed at', `${structured.observed_at}${timezone !== null ? ` (${timezone})` : ''}`],
              [
                'European AQI',
                europeanAqi === null ? null : `${europeanAqi} — ${band?.band ?? 'unknown'} / ${band?.band_ru ?? ''}`,
              ],
              ['US AQI', structured.us_aqi],
              ['advice', structured.aqi_advice],
              ['PM2.5', structured.pm2_5 === null ? null : `${structured.pm2_5} ${concentrationUnit}`],
              ['PM10', structured.pm10 === null ? null : `${structured.pm10} ${concentrationUnit}`],
              ['ozone (O3)', structured.ozone === null ? null : `${structured.ozone} ${concentrationUnit}`],
              [
                'nitrogen dioxide (NO2)',
                structured.nitrogen_dioxide === null ? null : `${structured.nitrogen_dioxide} ${concentrationUnit}`,
              ],
              [
                'sulphur dioxide (SO2)',
                structured.sulphur_dioxide === null ? null : `${structured.sulphur_dioxide} ${concentrationUnit}`,
              ],
              [
                'carbon monoxide (CO)',
                structured.carbon_monoxide === null ? null : `${structured.carbon_monoxide} ${concentrationUnit}`,
              ],
              ['UV index', structured.uv_index],
            ]),
          ].join('\n');

          return toolResult(text, structured);
        },
        args,
      ),
  );
}
