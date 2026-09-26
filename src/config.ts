/**
 * Runtime configuration.
 *
 * Everything that must change between "laptop + stdio" and "VPS + HTTP behind a
 * reverse proxy" is an environment variable, so the same build artefact runs in
 * both places without a code change.
 */

export type TransportKind = 'stdio' | 'http';
export type SessionMode = 'stateless' | 'stateful';

export interface Config {
  transport: TransportKind;
  /** HTTP transport only. */
  http: {
    host: string;
    port: number;
    path: string;
    sessionMode: SessionMode;
    /**
     * When set, every request must carry `Authorization: Bearer <token>`.
     * Left empty the server refuses to bind to a non-loopback host unless
     * MCP_ALLOW_UNAUTHENTICATED=true is set explicitly.
     */
    authToken: string | undefined;
    allowUnauthenticated: boolean;
    allowedOrigins: string[] | undefined;
    maxBodyBytes: number;
    /**
     * Reply with a single JSON body instead of an SSE stream. Simpler for plain
     * HTTP agents and transparent through reverse proxies; SSE is only needed for
     * server-initiated messages, which this server never sends.
     */
    jsonResponse: boolean;
  };
  openMeteo: {
    /**
     * Overridable so a self-hosted Open-Meteo instance, a proxy, or an
     * alternative Open-Meteo host can be used.
     *
     * The default is NOT `api.open-meteo.com`: that host is unreachable from some
     * networks (the bare IP blackholes while every other Open-Meteo host answers).
     * The ensemble host serves the identical JSON schema — same variable names,
     * same WMO weather codes, same units — so it is a drop-in replacement.
     */
    forecastBaseUrl: string;
    /** `/v1/forecast` on the standard host, `/v1/ensemble` on the ensemble host. */
    forecastPath: string;
    /**
     * Comma-separated model ids sent as `models=`. Required by the ensemble host
     * (it rejects `best_match`); must be empty for the standard forecast host.
     */
    models: string;
    geocodingBaseUrl: string;
    airQualityBaseUrl: string;
    /** Free tier needs no key; a commercial key can be supplied here. */
    apiKey: string | undefined;
    timeoutMs: number;
    maxRetries: number;
    /** Sent as User-Agent so the upstream operator can identify the caller. */
    userAgent: string;
  };
  watch: {
    /** When false the collector never starts and the watch tools report why. */
    enabled: boolean;
    /** Seconds between collection cycles. */
    intervalSeconds: number;
    /** Samples older than this are pruned on every write. */
    retentionHours: number;
    /**
     * Directory holding watches.json and samples/. MUST be a writable mount when
     * the container runs with a read-only root filesystem.
     */
    dataDir: string;
    maxWatches: number;
  };
  logLevel: LogLevel;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

function envStr(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Like `envStr`, but preserves an explicitly blank value as an empty string. */
function rawTrim(name: string): string {
  return (process.env[name] ?? '').trim();
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = envStr(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = envStr(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`Environment variable ${name} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

function envUrl(name: string, fallback: string): string {
  const raw = envStr(name) ?? fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('must be http or https');
    }
    // Normalise away a trailing slash so path joining stays predictable.
    return raw.replace(/\/+$/, '');
  } catch (error) {
    throw new Error(`Environment variable ${name} is not a valid http(s) URL: ${raw} (${String(error)})`);
  }
}

function parseTransport(argv: string[]): TransportKind {
  const flagIndex = argv.findIndex((a) => a === '--transport' || a.startsWith('--transport='));
  let value: string | undefined;
  if (flagIndex !== -1) {
    const arg = argv[flagIndex]!;
    value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[flagIndex + 1];
  }
  value ??= envStr('MCP_TRANSPORT');
  value ??= 'stdio';
  const normalised = value.toLowerCase();
  if (normalised !== 'stdio' && normalised !== 'http') {
    throw new Error(`Unknown transport "${value}". Expected "stdio" or "http".`);
  }
  return normalised;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const transport = parseTransport(argv);

  const logLevelRaw = (envStr('LOG_LEVEL') ?? 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${logLevelRaw}"`);
  }

  const sessionModeRaw = (envStr('MCP_SESSION_MODE') ?? 'stateless').toLowerCase();
  if (sessionModeRaw !== 'stateless' && sessionModeRaw !== 'stateful') {
    throw new Error(`MCP_SESSION_MODE must be "stateless" or "stateful", got "${sessionModeRaw}"`);
  }

  const allowedOriginsRaw = envStr('MCP_ALLOWED_ORIGINS');
  const allowedOrigins =
    allowedOriginsRaw === undefined
      ? undefined
      : allowedOriginsRaw === '*'
        ? ['*']
        : allowedOriginsRaw
            .split(',')
            .map((o) => o.trim())
            .filter((o) => o.length > 0);

  return {
    transport,
    http: {
      host: envStr('MCP_HOST') ?? '127.0.0.1',
      port: envInt('MCP_PORT', 3000, 0, 65535),
      path: normalisePath(envStr('MCP_PATH') ?? '/mcp'),
      sessionMode: sessionModeRaw,
      authToken: envStr('MCP_AUTH_TOKEN'),
      allowUnauthenticated: envBool('MCP_ALLOW_UNAUTHENTICATED', false),
      allowedOrigins,
      maxBodyBytes: envInt('MCP_MAX_BODY_BYTES', 1_048_576, 1024, 64 * 1024 * 1024),
      jsonResponse: envBool('MCP_JSON_RESPONSE', true),
    },
    openMeteo: {
      forecastBaseUrl: envUrl('OPEN_METEO_FORECAST_URL', 'https://ensemble-api.open-meteo.com'),
      forecastPath: envStr('OPEN_METEO_FORECAST_PATH') ?? '/v1/ensemble',
      // An unset variable keeps the default model. An explicitly blank value
      // means "send no models parameter", which is what the standard forecast
      // host wants so it can pick its own best_match.
      models: process.env['OPEN_METEO_MODELS'] === undefined ? 'gfs05' : rawTrim('OPEN_METEO_MODELS'),
      geocodingBaseUrl: envUrl('OPEN_METEO_GEOCODING_URL', 'https://geocoding-api.open-meteo.com'),
      airQualityBaseUrl: envUrl('OPEN_METEO_AIR_QUALITY_URL', 'https://air-quality-api.open-meteo.com'),
      apiKey: envStr('OPEN_METEO_API_KEY'),
      timeoutMs: envInt('OPEN_METEO_TIMEOUT_MS', 15_000, 1000, 120_000),
      maxRetries: envInt('OPEN_METEO_MAX_RETRIES', 2, 0, 5),
      userAgent: envStr('OPEN_METEO_USER_AGENT') ?? 'open-meteo-mcp/1.0.0 (+https://github.com/)',
    },
    watch: {
      enabled: envBool('WATCH_ENABLED', true),
      // 15 minutes: frequent enough to see a trend within a day, far below the
      // free tier's minutely request limit even with several watches.
      intervalSeconds: envInt('WATCH_INTERVAL_SECONDS', 900, 30, 86_400),
      retentionHours: envInt('WATCH_RETENTION_HOURS', 168, 1, 8760),
      dataDir: envStr('WATCH_DATA_DIR') ?? './data',
      maxWatches: envInt('WATCH_MAX_WATCHES', 20, 1, 500),
    },
    logLevel: logLevelRaw as LogLevel,
  };
}

function normalisePath(value: string): string {
  const withSlash = value.startsWith('/') ? value : `/${value}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

/**
 * A public bind with no auth token is a common and expensive mistake on a VPS:
 * it exposes the tool surface to the whole internet. Fail fast instead.
 */
export function assertSafeHttpBinding(config: Config, logger: (msg: string) => void): void {
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(config.http.host);
  if (!isLoopback && config.http.authToken === undefined && !config.http.allowUnauthenticated) {
    throw new Error(
      `Refusing to bind HTTP transport to "${config.http.host}" without authentication. ` +
        'Set MCP_AUTH_TOKEN to a strong secret, or set MCP_ALLOW_UNAUTHENTICATED=true if the ' +
        'endpoint is protected by another layer (VPN, private network, mTLS proxy).',
    );
  }
  if (!isLoopback && config.http.authToken === undefined) {
    logger(
      `WARNING: HTTP transport is bound to ${config.http.host} without MCP_AUTH_TOKEN. ` +
        'Anyone who can reach this port can call every tool.',
    );
  }
}
