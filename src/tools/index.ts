import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './deps.js';
import { registerAirQualityTool } from './air-quality.js';
import { registerCurrentWeatherTool } from './current-weather.js';
import { registerForecastTool } from './forecast.js';
import { registerGeocodeTool } from './geocode.js';

/** Names in the order they are registered; also used by the smoke test. */
export const TOOL_NAMES = ['geocode_location', 'get_current_weather', 'get_weather_forecast', 'get_air_quality'] as const;

export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerGeocodeTool(server, deps);
  registerCurrentWeatherTool(server, deps);
  registerForecastTool(server, deps);
  registerAirQualityTool(server, deps);
}
