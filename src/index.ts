#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type Config } from './config.js';
import { startHttpServer } from './http.js';
import { createLogger, type Logger } from './logger.js';
import { buildDeps, createServer } from './server.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

MCP server for the free Open-Meteo weather and air-quality APIs.

Besides reading weather, it can keep a table of values on disk
(save_weather_summary) and turn it into an .xlsx file
(export_weather_summary_excel).

Usage:
  open-meteo-mcp [--transport stdio|http] [--help]

Transports:
  stdio   Speak MCP over stdin/stdout. Used when the MCP client spawns this
          process itself (Claude Desktop, most IDE agents). This is the default.
  http    Serve MCP over Streamable HTTP. Used for a remote/VPS deployment.

Environment:
  MCP_HOST, MCP_PORT, MCP_PATH         HTTP bind address (default 127.0.0.1:3000/mcp)
  MCP_AUTH_TOKEN                       Required bearer token for remote requests
  MCP_ALLOW_UNAUTHENTICATED            Set to true to allow a public bind with no token
  MCP_SESSION_MODE                     stateless (default) or stateful
  MCP_JSON_RESPONSE                    true (default) for JSON replies instead of SSE
  MCP_ALLOWED_ORIGINS                  Comma-separated CORS origins, or * for any
  MCP_MAX_BODY_BYTES                   Maximum accepted request size
  OPEN_METEO_FORECAST_URL              Override the forecast API base URL
  OPEN_METEO_GEOCODING_URL             Override the geocoding API base URL
  OPEN_METEO_AIR_QUALITY_URL           Override the air quality API base URL
  OPEN_METEO_API_KEY                   Optional key for a commercial Open-Meteo plan
  OPEN_METEO_TIMEOUT_MS                Per-request timeout (default 15000)
  OPEN_METEO_MAX_RETRIES               Retries for transient failures (default 2)
  WATCH_ENABLED                        Run the periodic collector (default true)
  WATCH_INTERVAL_SECONDS               Seconds between collections (default 900 = 15 min)
  WATCH_RETENTION_HOURS                How long samples are kept (default 168 = 7 days)
  WATCH_DATA_DIR                       Where watches.json and samples/ live (default ./data)
  WATCH_MAX_WATCHES                    Maximum concurrent watches (default 20)
  SUMMARY_DATA_DIR                     Where saved summaries and .xlsx exports live
                                       (default <WATCH_DATA_DIR>/summaries)
  SUMMARY_MAX_DATASETS                 Maximum saved summaries (default 200)
  SUMMARY_MAX_ENTRIES                  Maximum rows in one saved summary (default 5000)
  SUMMARY_MAX_INLINE_BYTES             Largest .xlsx returned inline, base64 (default 8388608)
  SUMMARY_MAX_EXPORTS                  .xlsx files kept per dataset (default 10)
  LOG_LEVEL                            debug | info | warn | error | silent

See .env.example and README.md for details.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const config = loadConfig(argv);
  const logger = createLogger(config.logLevel, { server: SERVER_NAME, version: SERVER_VERSION });
  const deps = buildDeps(config, logger);

  // Start the collector once, here in the entry point — never inside
  // createServer(). Stateless MCP builds a fresh server per HTTP request, so a
  // timer started there would be recreated on every call and never fire on
  // schedule. Starting it before the transport also guarantees that the first
  // tool call already sees the persisted registry.
  if (config.watch.enabled) {
    await deps.watches.start();
  } else {
    logger.info('weather watcher disabled by configuration (WATCH_ENABLED=false)');
  }

  // Probed once at startup rather than on the first tool call: a data directory
  // that cannot be written is a deployment mistake, and it should be visible in
  // /healthz and in the logs before anyone depends on it.
  await deps.summaries.initialise();

  if (config.transport === 'stdio') {
    await runStdio(config, deps, logger);
  } else {
    await runHttp(config, deps, logger);
  }
}

async function runStdio(config: Config, deps: ReturnType<typeof buildDeps>, logger: Logger): Promise<void> {
  const server = createServer(deps);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  logger.info('stdio transport ready', {
    forecastUrl: config.openMeteo.forecastBaseUrl,
    geocodingUrl: config.openMeteo.geocodingBaseUrl,
  });

  const shutdown = () => {
    logger.info('shutting down stdio transport');
    void deps.watches
      .stop()
      .catch(() => undefined)
      .finally(() => {
        void server.close().finally(() => process.exit(0));
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // The stdio transport keeps the process alive while stdin is open; when the
  // client closes it, `onclose` fires and the process should exit rather than
  // linger as an orphan.
  transport.onclose = () => {
    logger.info('stdio transport closed by client');
    process.exit(0);
  };
}

async function runHttp(config: Config, deps: ReturnType<typeof buildDeps>, logger: Logger): Promise<void> {
  const handle = await startHttpServer(config, deps, logger);
  logger.info('http transport ready', {
    url: handle.url,
    sessionMode: config.http.sessionMode,
    authenticated: config.http.authToken !== undefined,
    jsonResponse: config.http.jsonResponse,
  });
  // Also print the bare URL to stdout: it is the one line a deploy script or a
  // human wants to copy, and on the HTTP transport stdout is not the MCP channel.
  process.stdout.write(`${handle.url}\n`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down http transport', { signal });
    void deps.watches.stop().catch(() => undefined);
    void handle
      .close()
      .catch((error: unknown) => {
        logger.error('error during shutdown', { message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => process.exit(0));
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // Configuration and startup failures must be loud and actionable.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${SERVER_NAME}: fatal: ${message}\n`);
  process.exit(1);
});
