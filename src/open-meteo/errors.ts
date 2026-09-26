/**
 * Upstream-facing errors.
 *
 * The canonical definitions live in `src/errors.ts` because the tool and watch
 * layers need the same taxonomy; this module keeps the Open-Meteo-specific
 * import path valid for code that deals with the upstream API.
 */
export { AppError, InvalidInputError, OpenMeteoError, type OpenMeteoErrorKind } from '../errors.js';
export { WatchLimitError, WatchUnavailableError } from '../errors.js';
