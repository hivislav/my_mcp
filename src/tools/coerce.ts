/**
 * Open-Meteo returns loosely typed JSON: numeric fields can be `null`, and the
 * `current` block is typed as `number | string | null` because it mixes values
 * with the ISO timestamp. These helpers normalise that into `number | null` and
 * `string | null` so the tool output schema can be declared precisely.
 */

export function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Some upstream fields arrive as numeric strings.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return null;
}

/** Reads one aligned array out of a `daily`/`hourly` block, returning `[]` if absent. */
export function series(block: Record<string, Array<number | string | null>> | undefined, key: string) {
  const value = block?.[key];
  return Array.isArray(value) ? value : [];
}
