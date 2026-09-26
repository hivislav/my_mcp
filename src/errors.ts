/**
 * Application-wide error types.
 *
 * `AppError` marks an error whose message is written for the model to read and
 * act on ("mount a writable volume", "watch limit reached"). The tool layer
 * forwards those messages verbatim, while any other exception is reported
 * generically so internal details never leak to a remote agent.
 */

export abstract class AppError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The caller's arguments are wrong. Raised before any network call. */
export class InvalidInputError extends AppError {
  constructor(message: string) {
    super(message);
  }
}

export type OpenMeteoErrorKind =
  | 'invalid_request'
  | 'not_found'
  | 'rate_limited'
  | 'upstream_error'
  | 'network'
  | 'timeout'
  | 'malformed_response';

export class OpenMeteoError extends AppError {
  readonly kind: OpenMeteoErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(
    kind: OpenMeteoErrorKind,
    message: string,
    options: { status?: number; retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message);
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? (kind === 'network' || kind === 'timeout' || kind === 'upstream_error');
    this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** Single-line, human/LLM readable explanation suitable for a tool error. */
  toToolMessage(): string {
    const suffix = this.status !== undefined ? ` (HTTP ${this.status})` : '';
    const retryHint = this.retryable ? ' This looks transient — retrying may succeed.' : '';
    return `Open-Meteo request failed [${this.kind}]${suffix}: ${this.message}.${retryHint}`;
  }
}

/** The collector cannot store samples, e.g. a read-only filesystem with no volume. */
export class WatchUnavailableError extends AppError {
  constructor(reason: string) {
    super(reason);
  }
}

/** Too many watches registered. */
export class WatchLimitError extends AppError {
  constructor(limit: number) {
    super(
      `Watch limit reached (${limit} active watches). Remove one with stop_weather_watch, ` +
        'or raise WATCH_MAX_WATCHES on the server.',
    );
  }
}
