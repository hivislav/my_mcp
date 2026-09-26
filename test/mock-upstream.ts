import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the Open-Meteo APIs.
 *
 * The real forecast host is unreachable from some networks (and is rate limited
 * on others), so the test suite runs against this local mock. It mirrors the
 * upstream contract closely enough to catch real breakage: it honours the
 * `current`/`daily`/`hourly` variable lists, returns aligned arrays, echoes the
 * requested units, and reproduces both the empty-result and error envelopes.
 */

export interface MockRequest {
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
}

export interface MockUpstream {
  url: string;
  /** Every request received, in order, for assertions. */
  requests: MockRequest[];
  close(): Promise<void>;
}

const PLACES = [
  {
    id: 524901,
    name: 'Moscow',
    latitude: 55.75204,
    longitude: 37.61781,
    elevation: 155,
    country_code: 'RU',
    country: 'Russia',
    admin1: 'Moscow',
    timezone: 'Europe/Moscow',
    population: 10381222,
  },
  {
    id: 5601538,
    name: 'Moscow',
    latitude: 46.73239,
    longitude: -117.00017,
    elevation: 786,
    country_code: 'US',
    country: 'United States',
    admin1: 'Idaho',
    timezone: 'America/Los_Angeles',
    population: 25060,
  },
  {
    id: 2643743,
    name: 'London',
    latitude: 51.50853,
    longitude: -0.12574,
    elevation: 25,
    country_code: 'GB',
    country: 'United Kingdom',
    admin1: 'England',
    timezone: 'Europe/London',
    population: 7556900,
  },
  {
    id: 2988507,
    name: 'Paris',
    latitude: 48.85341,
    longitude: 2.3488,
    elevation: 42,
    country_code: 'FR',
    country: 'France',
    admin1: 'Île-de-France',
    timezone: 'Europe/Paris',
    population: 2138551,
  },
];

export async function startMockUpstream(): Promise<MockUpstream> {
  const requests: MockRequest[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({ path: url.pathname, query: url.searchParams, headers: req.headers });

    if (url.pathname === '/v1/search') return handleSearch(url, res);
    // The server's default backend is the ensemble host, which serves the same
    // JSON schema from a different path. Both are mocked so the suite covers
    // whichever backend the configuration points at.
    if (url.pathname === '/v1/forecast' || url.pathname === '/v1/ensemble') return handleForecast(url, res);
    if (url.pathname === '/v1/air-quality') return handleAirQuality(url, res);

    sendJson(res, 404, { error: true, reason: `Unknown endpoint ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function handleSearch(url: URL, res: ServerResponse): void {
  const name = (url.searchParams.get('name') ?? '').toLowerCase();
  const countryCode = url.searchParams.get('countryCode')?.toUpperCase();
  const count = Number(url.searchParams.get('count') ?? '10');

  let matches = PLACES.filter((place) => place.name.toLowerCase().startsWith(name));
  if (countryCode !== undefined) {
    matches = matches.filter((place) => place.country_code === countryCode);
  }

  // Upstream omits `results` entirely when nothing matched.
  if (matches.length === 0) {
    sendJson(res, 200, { generationtime_ms: 0.2 });
    return;
  }
  sendJson(res, 200, { results: matches.slice(0, count), generationtime_ms: 0.2 });
}

function handleForecast(url: URL, res: ServerResponse): void {
  // A schema-valid value that the upstream still rejects, so tests can exercise
  // the "valid arguments, upstream refuses" path.
  if (url.searchParams.get('latitude') === '-90') {
    sendJson(res, 400, { error: true, reason: 'Latitude must be in range of -90 to 90°' });
    return;
  }

  const days = Number(url.searchParams.get('forecast_days') ?? '7');
  const start = Date.parse('2026-09-25T00:00:00Z');
  const dates = Array.from({ length: days }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));

  const payload: Record<string, unknown> = {
    latitude: Number(url.searchParams.get('latitude') ?? 55.8),
    longitude: Number(url.searchParams.get('longitude') ?? 37.6),
    generationtime_ms: 1.2,
    utc_offset_seconds: 10800,
    timezone: 'Europe/Moscow',
    timezone_abbreviation: 'MSK',
    elevation: 140,
  };

  const currentVars = url.searchParams.get('current')?.split(',').filter(Boolean);
  if (currentVars !== undefined && currentVars.length > 0) {
    const current: Record<string, number | string | null> = { time: '2026-09-25T15:00', interval: 900 };
    for (const variable of currentVars) current[variable] = valueForCurrent(variable);
    payload['current'] = current;
    payload['current_units'] = Object.fromEntries(currentVars.map((v) => [v, unitFor(v, url)]));
  }

  const dailyVars = url.searchParams.get('daily')?.split(',').filter(Boolean);
  if (dailyVars !== undefined && dailyVars.length > 0) {
    const daily: Record<string, Array<number | string | null>> = { time: dates };
    for (const variable of dailyVars) daily[variable] = dates.map((_, i) => valueForDaily(variable, i));
    payload['daily'] = daily;
    payload['daily_units'] = Object.fromEntries(dailyVars.map((v) => [v, unitFor(v, url)]));
  }

  const hourlyVars = url.searchParams.get('hourly')?.split(',').filter(Boolean);
  if (hourlyVars !== undefined && hourlyVars.length > 0) {
    const hours = dates.flatMap((date) =>
      Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`),
    );
    const hourly: Record<string, Array<number | string | null>> = { time: hours };
    for (const variable of hourlyVars) hourly[variable] = hours.map((_, i) => valueForHourly(variable, i));
    payload['hourly'] = hourly;
    payload['hourly_units'] = Object.fromEntries(hourlyVars.map((v) => [v, unitFor(v, url)]));
  }

  sendJson(res, 200, payload);
}

function handleAirQuality(url: URL, res: ServerResponse): void {
  const currentVars = url.searchParams.get('current')?.split(',').filter(Boolean) ?? [];
  const current: Record<string, number | string | null> = { time: '2026-09-25T15:00', interval: 3600 };
  for (const variable of currentVars) current[variable] = valueForAirQuality(variable);

  sendJson(res, 200, {
    latitude: Number(url.searchParams.get('latitude') ?? 55.8),
    longitude: Number(url.searchParams.get('longitude') ?? 37.6),
    utc_offset_seconds: 10800,
    timezone: 'Europe/Moscow',
    timezone_abbreviation: 'GMT+3',
    elevation: 140,
    current_units: Object.fromEntries(currentVars.map((v) => [v, v === 'european_aqi' ? 'EAQI' : 'μg/m³'])),
    current,
  });
}

// Deterministic, plausible values so assertions can be exact.
function valueForCurrent(variable: string): number | null {
  switch (variable) {
    case 'temperature_2m':
      return 12.4;
    case 'relative_humidity_2m':
      return 71;
    case 'apparent_temperature':
      return 10.9;
    case 'is_day':
      return 1;
    case 'precipitation':
      return 0.2;
    case 'rain':
      return 0.2;
    case 'showers':
      return 0;
    case 'snowfall':
      return 0;
    case 'weather_code':
      return 61;
    case 'cloud_cover':
      return 88;
    case 'pressure_msl':
      return 1013.2;
    case 'surface_pressure':
      return 1001.5;
    case 'wind_speed_10m':
      return 14.8;
    case 'wind_direction_10m':
      return 245;
    case 'wind_gusts_10m':
      return 27.4;
    default:
      return null;
  }
}

function valueForDaily(variable: string, index: number): number | string | null {
  switch (variable) {
    case 'weather_code':
      return [61, 3, 0, 2, 80, 95, 45][index % 7]!;
    case 'temperature_2m_max':
      return 14 + index;
    case 'temperature_2m_min':
      return 5 + index;
    case 'apparent_temperature_max':
      return 12.5 + index;
    case 'apparent_temperature_min':
      return 3.5 + index;
    case 'precipitation_sum':
      return index === 2 ? 0 : 2.4;
    case 'rain_sum':
      return index === 2 ? 0 : 2.4;
    case 'snowfall_sum':
      return index === 5 ? 1.5 : 0;
    case 'precipitation_hours':
      return index === 2 ? 0 : 4;
    case 'precipitation_probability_max':
      return 20 + index * 5;
    case 'uv_index_max':
      return 3.2;
    case 'wind_speed_10m_max':
      return 18.3 + index;
    case 'wind_gusts_10m_max':
      return 31.7 + index;
    case 'wind_direction_10m_dominant':
      return 240;
    case 'sunrise':
      return `2026-09-${String(25 + index).padStart(2, '0')}T06:${String(10 + index).padStart(2, '0')}`;
    case 'sunset':
      return `2026-09-${String(25 + index).padStart(2, '0')}T18:${String(40 - index).padStart(2, '0')}`;
    case 'daylight_duration':
      return 44_000;
    default:
      return null;
  }
}

function valueForHourly(variable: string, index: number): number | null {
  switch (variable) {
    case 'temperature_2m':
      return 8 + (index % 12);
    case 'apparent_temperature':
      return 6 + (index % 12);
    case 'relative_humidity_2m':
      return 60 + (index % 30);
    case 'precipitation':
      return index % 6 === 0 ? 0.4 : 0;
    case 'precipitation_probability':
      return index % 10;
    case 'weather_code':
      return 61;
    case 'cloud_cover':
      return 75;
    case 'wind_speed_10m':
      return 11.2;
    case 'wind_direction_10m':
      return 250;
    default:
      return null;
  }
}

function valueForAirQuality(variable: string): number | null {
  switch (variable) {
    case 'european_aqi':
      return 60;
    case 'us_aqi':
      return 96;
    case 'pm2_5':
      return 39.1;
    case 'pm10':
      return 45.7;
    case 'ozone':
      return 11;
    case 'nitrogen_dioxide':
      return 59.8;
    case 'sulphur_dioxide':
      return 59.2;
    case 'carbon_monoxide':
      return 549;
    case 'ammonia':
      return 2.8;
    case 'dust':
      return 0;
    case 'uv_index':
      return 0.5;
    case 'aerosol_optical_depth':
      return 0.19;
    default:
      return null;
  }
}

/** Mirrors the unit switching Open-Meteo performs based on the unit query params. */
function unitFor(variable: string, url: URL): string {
  const temperature = url.searchParams.get('temperature_unit') === 'fahrenheit' ? '°F' : '°C';
  const wind = url.searchParams.get('wind_speed_unit') === 'mph' ? 'mph' : 'km/h';
  const precipitation = url.searchParams.get('precipitation_unit') === 'inch' ? 'inch' : 'mm';

  if (/temperature/.test(variable)) return temperature;
  if (/wind|gust/.test(variable)) return wind;
  if (/precipitation|rain|snowfall/.test(variable)) return precipitation;
  if (/humidity|cloud_cover|probability/.test(variable)) return '%';
  if (/pressure/.test(variable)) return 'hPa';
  return '';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}
