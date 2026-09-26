/**
 * Unit handling for weather values.
 *
 * Every payload this server returns carries an explicit `units` object, so a
 * model never has to guess whether a number is Celsius or Fahrenheit. The
 * upstream API is asked for the matching unit system rather than converting
 * locally, which keeps the numbers exactly as the provider computed them.
 */

export type UnitSystem = 'metric' | 'imperial';

export interface UnitSet {
  temperature: string;
  wind_speed: string;
  precipitation: string;
}

export function unitsFor(system: UnitSystem): UnitSet {
  return system === 'imperial'
    ? { temperature: '°F', wind_speed: 'mph', precipitation: 'inch' }
    : { temperature: '°C', wind_speed: 'km/h', precipitation: 'mm' };
}

export function upstreamParamsFor(system: UnitSystem) {
  return system === 'imperial'
    ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' }
    : { temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm' };
}

export const UNIT_SYSTEM_DESCRIPTION =
  'Unit system for all returned values: "metric" (°C, km/h, mm) or "imperial" (°F, mph, inch). Defaults to metric.';
