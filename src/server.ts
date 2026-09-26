import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { createClients } from './open-meteo/client.js';
import { SummaryService } from './summary/service.js';
import { registerAllTools } from './tools/index.js';
import type { ToolDeps } from './tools/deps.js';
import { WatchService } from './watch/service.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

/**
 * The server-level `instructions` string is the only place we can brief the model
 * once, instead of repeating guidance inside every tool description. Agents that
 * surface it (per the MCP spec) get told how the tools fit together up front.
 */
const INSTRUCTIONS = `Weather and air-quality data from the free Open-Meteo API.

Tools:
- geocode_location              — resolve a place name to coordinates and disambiguate same-named places.
- get_current_weather           — present conditions (temperature, wind, humidity, precipitation).
- get_weather_forecast          — daily forecast up to 16 days, optionally hourly.
- get_air_quality               — pollutants and air quality indices with health guidance.
- start/stop/delete/list_weather_watch(es) — background collection for a location over time.
- get_weather_watch_report      — aggregated report over the collected history.
- save_weather_summary          — keep a table of weather values (and your own analysis) on the server.
- list_weather_summaries        — see which saved summaries exist and read their ids.
- export_weather_summary_excel  — turn a saved summary into a real .xlsx file and return it.

How to use them together:
1. Every weather tool accepts EITHER \`latitude\` + \`longitude\` OR a \`location\` place name.
   When you know only a city name, just pass \`location\` — the server geocodes it for you and
   picks the most populous match, so a single call is usually enough.
2. Call geocode_location when you are unsure which place is meant, when a city name is ambiguous
   (for example "Springfield"), or when you need the coordinates, country or timezone explicitly.
   If a name is genuinely ambiguous, add \`countryCode\` to the weather call rather than guessing.
3. Results are returned both as readable text and as structured JSON validated against each tool's
   output schema. Prefer the structured values for calculations, comparisons and unit conversions.
4. All temperatures, wind speeds and precipitation amounts follow the \`units\` argument, and every
   response repeats the units it used in a \`units\` field. Never assume a unit.
5. Forecast accuracy decreases with lead time: treat days 1-7 as a forecast and days 8-16 as a trend.
6. Weather data is read on demand and is never kept unless you ask. When the user wants to compare
   places or days, keep the numbers with save_weather_summary and hand back a spreadsheet with
   export_weather_summary_excel, rather than pasting a table into the chat.
7. Watch tools are for weather over time (\`watch\`, \`monitor\`, \`track\`); a saved summary is a
   finished table you chose to keep, and it does not expire.

Constraints worth knowing:
- Open-Meteo geocoding matches place names only; street addresses, postcodes and landmarks will not resolve.
- Timestamps are returned in the location's local time, not the caller's.
- Data is model output refreshed roughly every 15 minutes for weather and hourly for air quality;
  it is not a station observation, so it can differ slightly from a local thermometer.
- Saved summaries and their .xlsx exports live in the server's data directory. Over a remote HTTP
  transport that filesystem is not reachable by the caller, so pass the file back in the tool result
  and report the path as a server-side detail.`;

export function buildDeps(config: Config, logger: Logger): ToolDeps {
  const clients = createClients(config, logger);
  return {
    clients,
    logger,
    config,
    // One collector per process. It must NOT be created inside createServer():
    // stateless MCP builds a fresh server for every HTTP request, so the timer
    // would be recreated per call and could never fire on a schedule.
    watches: new WatchService({ config, source: { clients, config }, logger }),
    // Saved summaries are files on disk, so a fresh service per request would be
    // functionally fine — but sharing one instance keeps the index warm and gives
    // a single place that reports whether the data directory is writable.
    summaries: new SummaryService({ config, logger }),
  };
}

/**
 * Creates a fully configured MCP server.
 *
 * A factory rather than a singleton because the stateless HTTP transport needs a
 * fresh server per request, and tests need isolated instances.
 */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, logging: {} },
      instructions: INSTRUCTIONS,
    },
  );

  registerAllTools(server, deps);
  deps.logger.debug('mcp server created', { name: SERVER_NAME, version: SERVER_VERSION });
  return server;
}
