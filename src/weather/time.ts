/**
 * Timestamp helpers.
 *
 * The upstream API returns the observation time as a bare local wall-clock string
 * (`2026-09-25T22:30`) with the location's timezone only in a separate field. Such
 * a value is ambiguous on its own: read as UTC it is five hours off for
 * Yekaterinburg, and a report built on that mistake is confidently wrong. Every
 * timestamp this server stores is therefore qualified with an explicit offset.
 */

/** Formats a UTC offset in seconds as `±HH:MM`. */
export function formatOffset(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const sign = seconds < 0 ? '-' : '+';
  const absolute = Math.abs(Math.trunc(seconds));
  const hours = Math.floor(absolute / 3600);
  const minutes = Math.floor((absolute % 3600) / 60);
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** True when the string already pins itself to an instant (`Z` or `±HH:MM`). */
export function hasOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
}

/**
 * Appends `offset` unless the timestamp already carries one.
 *
 * Idempotent, so it is safe to run over data that has already been normalised.
 */
export function qualifyTimestamp(value: string, offset: string | null): string {
  if (value === '' || offset === null) return value;
  return hasOffset(value) ? value : `${value}${offset}`;
}

/**
 * Resolves the UTC offset of an IANA zone at a given instant, as `±HH:MM`.
 *
 * Used to repair timestamps stored before offsets were recorded, where only the
 * zone name survives. Implemented by formatting the instant in the target zone and
 * comparing the wall-clock reading against the same value interpreted as UTC —
 * the standard dependency-free way to get an offset from `Intl`.
 */
export function offsetForZone(timeZone: string | null | undefined, at: Date): string | null {
  if (timeZone === null || timeZone === undefined || timeZone === '') return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);

    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);

    // `Intl` reports whole seconds while the input may carry milliseconds, so both
    // sides are floored to seconds. Without this the 0.949 s remainder of
    // `...:24.949Z` turns a +05:00 zone into +04:59.
    const atSecond = Math.floor(at.getTime() / 1000) * 1000;

    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      // `hour12: false` can render midnight as 24 in some engines.
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    if (!Number.isFinite(asUtc)) return null;

    return formatOffset((asUtc - atSecond) / 1000);
  } catch {
    // An unknown zone is not worth failing a sample over.
    return null;
  }
}
