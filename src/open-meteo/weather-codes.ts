/**
 * WMO 4677 weather-code interpretation.
 *
 * Open-Meteo returns bare numeric codes. An LLM can reason about "61" only if we
 * translate it, so every weather payload we return carries both the raw code and
 * a decoded label. Russian labels are included because the target users of this
 * server are Russian-speaking agents; English is the fallback.
 */

export interface WeatherCodeInfo {
  /** Machine-readable slug, stable across releases. */
  condition: string;
  en: string;
  ru: string;
}

const CODES: Record<number, WeatherCodeInfo> = {
  0: { condition: 'clear_sky', en: 'Clear sky', ru: 'Ясно' },
  1: { condition: 'mainly_clear', en: 'Mainly clear', ru: 'Преимущественно ясно' },
  2: { condition: 'partly_cloudy', en: 'Partly cloudy', ru: 'Переменная облачность' },
  3: { condition: 'overcast', en: 'Overcast', ru: 'Пасмурно' },
  45: { condition: 'fog', en: 'Fog', ru: 'Туман' },
  48: { condition: 'depositing_rime_fog', en: 'Depositing rime fog', ru: 'Туман с изморозью' },
  51: { condition: 'light_drizzle', en: 'Light drizzle', ru: 'Слабая морось' },
  53: { condition: 'moderate_drizzle', en: 'Moderate drizzle', ru: 'Умеренная морось' },
  55: { condition: 'dense_drizzle', en: 'Dense drizzle', ru: 'Сильная морось' },
  56: { condition: 'light_freezing_drizzle', en: 'Light freezing drizzle', ru: 'Слабая ледяная морось' },
  57: { condition: 'dense_freezing_drizzle', en: 'Dense freezing drizzle', ru: 'Сильная ледяная морось' },
  61: { condition: 'slight_rain', en: 'Slight rain', ru: 'Небольшой дождь' },
  63: { condition: 'moderate_rain', en: 'Moderate rain', ru: 'Умеренный дождь' },
  65: { condition: 'heavy_rain', en: 'Heavy rain', ru: 'Сильный дождь' },
  66: { condition: 'light_freezing_rain', en: 'Light freezing rain', ru: 'Слабый ледяной дождь' },
  67: { condition: 'heavy_freezing_rain', en: 'Heavy freezing rain', ru: 'Сильный ледяной дождь' },
  71: { condition: 'slight_snow', en: 'Slight snowfall', ru: 'Небольшой снег' },
  73: { condition: 'moderate_snow', en: 'Moderate snowfall', ru: 'Умеренный снег' },
  75: { condition: 'heavy_snow', en: 'Heavy snowfall', ru: 'Сильный снег' },
  77: { condition: 'snow_grains', en: 'Snow grains', ru: 'Снежная крупа' },
  80: { condition: 'slight_rain_showers', en: 'Slight rain showers', ru: 'Небольшие ливни' },
  81: { condition: 'moderate_rain_showers', en: 'Moderate rain showers', ru: 'Умеренные ливни' },
  82: { condition: 'violent_rain_showers', en: 'Violent rain showers', ru: 'Сильные ливни' },
  85: { condition: 'slight_snow_showers', en: 'Slight snow showers', ru: 'Небольшие снегопады' },
  86: { condition: 'heavy_snow_showers', en: 'Heavy snow showers', ru: 'Сильные снегопады' },
  95: { condition: 'thunderstorm', en: 'Thunderstorm', ru: 'Гроза' },
  96: { condition: 'thunderstorm_slight_hail', en: 'Thunderstorm with slight hail', ru: 'Гроза с небольшим градом' },
  99: { condition: 'thunderstorm_heavy_hail', en: 'Thunderstorm with heavy hail', ru: 'Гроза с сильным градом' },
};

const UNKNOWN: WeatherCodeInfo = { condition: 'unknown', en: 'Unknown', ru: 'Неизвестно' };

export function decodeWeatherCode(code: number | null | undefined): WeatherCodeInfo {
  if (code === null || code === undefined) return UNKNOWN;
  return CODES[code] ?? UNKNOWN;
}
