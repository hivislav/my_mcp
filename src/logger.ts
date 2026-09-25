import type { LogLevel } from './config.js';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Logs always go to stderr.
 *
 * This is not a style choice: on the stdio transport stdout is the JSON-RPC
 * channel, and a single stray console.log corrupts the protocol stream and
 * breaks the client connection.
 */
export function createLogger(level: LogLevel, bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVEL_WEIGHT[level];

  const emit = (entryLevel: Exclude<LogLevel, 'silent'>, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_WEIGHT[entryLevel] < threshold) return;
    const payload = { level: entryLevel, time: new Date().toISOString(), msg: message, ...bindings, ...fields };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
