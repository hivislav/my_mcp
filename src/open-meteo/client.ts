import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { OpenMeteoError } from './errors.js';

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined | null;

export interface OpenMeteoClientOptions {
  baseUrl: string;
  /** Appended as `apikey` when present. The free tier does not need one. */
  apiKey?: string | undefined;
  timeoutMs: number;
  maxRetries: number;
  userAgent: string;
  logger: Logger;
  /** Injectable for tests. */
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Minimal typed wrapper over `fetch` for the Open-Meteo JSON APIs.
 *
 * Deliberately dependency-free: the server ships to a VPS, so every avoided
 * runtime dependency is one less supply-chain and upgrade concern.
 */
export class OpenMeteoClient {
  readonly #options: OpenMeteoClientOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #log: Logger;

  constructor(options: OpenMeteoClientOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#log = options.logger.child({ component: 'open-meteo', baseUrl: options.baseUrl });
    if (typeof this.#fetch !== 'function') {
      throw new Error('No global fetch implementation available; Node.js 18+ is required.');
    }
  }

  /**
   * Performs a GET request and parses the JSON body.
   *
   * Retries only on network failures, timeouts, 429 and 5xx — retrying a 400
   * would just burn the caller's time on a request that can never succeed.
   */
  async getJson<T>(path: string, params: Record<string, QueryValue>, signal?: AbortSignal): Promise<T> {
    const url = this.#buildUrl(path, params);
    let lastError: OpenMeteoError | undefined;

    for (let attempt = 0; attempt <= this.#options.maxRetries; attempt += 1) {
      if (attempt > 0) {
        // Exponential backoff with jitter, capped so a tool call cannot hang the agent.
        const delay = Math.min(250 * 2 ** (attempt - 1), 4000) * (0.5 + Math.random() * 0.5);
        this.#log.debug('retrying upstream request', { attempt, delayMs: Math.round(delay), url: url.pathname });
        await sleep(delay, signal);
      }

      try {
        const response = await this.#fetch(url, {
          method: 'GET',
          headers: this.#headers(),
          signal: this.#requestSignal(signal),
          redirect: 'follow',
        });

        if (!response.ok) {
          const body = await safeReadText(response);
          const error = classifyHttpError(response.status, body, url);
          if (!error.retryable || attempt === this.#options.maxRetries) throw error;
          lastError = error;
          continue;
        }

        const text = await response.text();
        try {
          return JSON.parse(text) as T;
        } catch (cause) {
          throw new OpenMeteoError('malformed_response', `Upstream returned a non-JSON body from ${url.pathname}`, {
            status: response.status,
            retryable: false,
            details: text.slice(0, 300),
            cause,
          });
        }
      } catch (rawError) {
        const error = this.#normalise(rawError, url, signal);
        if (!error.retryable || attempt === this.#options.maxRetries) throw error;
        lastError = error;
      }
    }

    // Unreachable in practice: the loop always returns or throws on the last attempt.
    throw lastError ?? new OpenMeteoError('network', 'Request failed for an unknown reason', { retryable: true });
  }

  #buildUrl(path: string, params: Record<string, QueryValue>): URL {
    const url = new URL(path.replace(/^\//, ''), `${this.#options.baseUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    if (this.#options.apiKey !== undefined) {
      url.searchParams.set('apikey', this.#options.apiKey);
    }
    return url;
  }

  #headers(): Record<string, string> {
    return {
      accept: 'application/json',
      'user-agent': this.#options.userAgent,
    };
  }

  /** Combines the caller's cancellation signal with our own timeout. */
  #requestSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.#options.timeoutMs);
    if (signal === undefined) return timeout;
    return AbortSignal.any([signal, timeout]);
  }

  #normalise(rawError: unknown, url: URL, callerSignal?: AbortSignal): OpenMeteoError {
    if (rawError instanceof OpenMeteoError) return rawError;

    if (rawError instanceof Error && rawError.name === 'TimeoutError') {
      return new OpenMeteoError('timeout', `Upstream did not respond within ${this.#options.timeoutMs} ms`, {
        retryable: true,
        cause: rawError,
      });
    }
    // The caller aborted: not our failure, and must not be retried or swallowed.
    if (callerSignal?.aborted === true) {
      return new OpenMeteoError('network', 'Request cancelled by the client', {
        retryable: false,
        cause: rawError,
      });
    }
    if (rawError instanceof Error && rawError.name === 'AbortError') {
      return new OpenMeteoError('timeout', `Upstream did not respond within ${this.#options.timeoutMs} ms`, {
        retryable: true,
        cause: rawError,
      });
    }
    return new OpenMeteoError('network', `Could not reach ${url.host}: ${describe(rawError)}`, {
      retryable: true,
      cause: rawError,
    });
  }
}

function classifyHttpError(status: number, body: string, url: URL): OpenMeteoError {
  const reason = extractReason(body);
  if (status === 429) {
    return new OpenMeteoError('rate_limited', `Rate limit exceeded${reason}`, {
      status,
      retryable: true,
      details: body.slice(0, 300),
    });
  }
  if (status === 404) {
    return new OpenMeteoError('not_found', `Endpoint not found at ${url.origin}${url.pathname}`, {
      status,
      retryable: false,
    });
  }
  if (status >= 400 && status < 500) {
    return new OpenMeteoError('invalid_request', `Upstream rejected the request${reason}`, {
      status,
      retryable: false,
      details: body.slice(0, 300),
    });
  }
  return new OpenMeteoError('upstream_error', `Upstream error${reason}`, {
    status,
    retryable: true,
    details: body.slice(0, 300),
  });
}

/** Open-Meteo reports argument problems as `{"reason":"..."}`. Surface it verbatim. */
function extractReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    if (typeof parsed.reason === 'string' && parsed.reason.length > 0) return `: ${parsed.reason}`;
  } catch {
    /* not JSON — fall through */
  }
  return '';
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== undefined ? `${code} ${error.message}` : error.message;
  }
  return String(error);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new OpenMeteoError('network', 'Request cancelled by the client', { retryable: false }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OpenMeteoError('network', 'Request cancelled by the client', { retryable: false }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Builds the forecast + geocoding clients from validated configuration. */
export function createClients(config: Config, logger: Logger) {
  const shared = {
    apiKey: config.openMeteo.apiKey,
    timeoutMs: config.openMeteo.timeoutMs,
    maxRetries: config.openMeteo.maxRetries,
    userAgent: config.openMeteo.userAgent,
    logger,
  } as const;

  return {
    forecast: new OpenMeteoClient({ ...shared, baseUrl: config.openMeteo.forecastBaseUrl }),
    geocoding: new OpenMeteoClient({ ...shared, baseUrl: config.openMeteo.geocodingBaseUrl }),
    airQuality: new OpenMeteoClient({ ...shared, baseUrl: config.openMeteo.airQualityBaseUrl }),
  };
}

export type Clients = ReturnType<typeof createClients>;
