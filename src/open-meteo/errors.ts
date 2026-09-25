/**
 * Error taxonomy for upstream calls.
 *
 * The distinction between "the caller asked for something impossible" and
 * "upstream is having a bad day" matters a lot for an agent: the first must be
 * fixed by changing the arguments, the second is worth retrying. The handler
 * layer maps these onto tool errors with actionable text.
 */

export type OpenMeteoErrorKind =
  | 'invalid_request'
  | 'not_found'
  | 'rate_limited'
  | 'upstream_error'
  | 'network'
  | 'timeout'
  | 'malformed_response';

export class OpenMeteoError extends Error {
  readonly kind: OpenMeteoErrorKind;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(
    kind: OpenMeteoErrorKind,
    message: string,
    options: { status?: number; retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OpenMeteoError';
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? (kind === 'network' || kind === 'timeout' || kind === 'upstream_error');
    this.details = options.details;
  }

  /** Single-line, human/LLM readable explanation suitable for a tool error. */
  toToolMessage(): string {
    const suffix = this.status !== undefined ? ` (HTTP ${this.status})` : '';
    const retryHint = this.retryable ? ' This looks transient — retrying may succeed.' : '';
    return `Open-Meteo request failed [${this.kind}]${suffix}: ${this.message}.${retryHint}`;
  }
}

/** Raised when the caller's arguments are wrong, before any network call. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}
