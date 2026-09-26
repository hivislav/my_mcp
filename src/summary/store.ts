import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logger.js';
import { atomicWriteFile, atomicWriteJson, probeWritableDirectory, readJsonFile, WriteQueue } from '../storage/json-file.js';
import type { SummaryDataset, SummaryDatasetMeta, SummaryDatasetRecord, SummaryIndexEntry } from './types.js';

/**
 * Durable storage for saved summaries.
 *
 * Two kinds of file live under the data directory:
 *
 * - `<id>.json` — one dataset, its metadata and all of its rows;
 * - `index.json` — metadata only for every dataset, so `list_weather_summaries`
 *   never has to parse megabytes of rows to show a table of titles.
 *
 * The index is a cache, never the source of truth: if it is missing or has been
 * edited by hand, it is rebuilt from the dataset files on first use. That keeps a
 * corrupt index a non-event instead of a data loss.
 *
 * Generated .xlsx files go to `exports/`, which the index deliberately ignores.
 */
export class SummaryStore {
  readonly #dataDir: string;
  readonly #exportsDir: string;
  readonly #log: Logger;
  readonly #writes = new WriteQueue();
  #index: Map<string, SummaryIndexEntry> | undefined;

  constructor(dataDir: string, logger: Logger) {
    this.#dataDir = dataDir;
    this.#exportsDir = join(dataDir, 'exports');
    this.#log = logger.child({ component: 'summary-store' });
  }

  get dataDir(): string {
    return this.#dataDir;
  }

  get exportsDir(): string {
    return this.#exportsDir;
  }

  get indexPath(): string {
    return join(this.#dataDir, 'index.json');
  }

  datasetPath(id: string): string {
    return join(this.#dataDir, `${sanitiseDatasetId(id)}.json`);
  }

  async ensureWritable(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await probeWritableDirectory(this.#dataDir);
    if (!result.ok) {
      this.#log.error('summary data directory is not writable', {
        dataDir: this.#dataDir,
        reason: result.reason,
      });
      return result;
    }

    // The export directory is checked separately: a failure there blocks only
    // Excel export, while saving and listing still work, so it must not disable
    // the whole feature.
    const exportsProbe = await probeWritableDirectory(this.#exportsDir);
    if (!exportsProbe.ok) {
      this.#log.warn('summary export directory is not writable', {
        exportsDir: this.#exportsDir,
        reason: exportsProbe.reason,
      });
    }
    return result;
  }

  /** Metadata for every saved dataset, newest first. */
  async list(): Promise<SummaryDatasetMeta[]> {
    const index = await this.#loadIndex();
    return [...index.values()]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
      .map((entry) => this.#toMeta(entry));
  }

  async has(id: string): Promise<boolean> {
    return (await this.#loadIndex()).has(id);
  }

  async read(id: string): Promise<SummaryDatasetRecord | null> {
    const stored = await readJsonFile<{ version?: number; dataset?: unknown }>(this.datasetPath(id), this.#log);
    if (stored === null || !isUsableDataset(stored.dataset)) {
      if (stored !== null) this.#log.warn('skipping malformed summary dataset', { id });
      return null;
    }

    const dataset: SummaryDataset = stored.dataset;
    return { ...dataset, file_path: this.datasetPath(id), size_bytes: await this.#sizeOf(this.datasetPath(id)) };
  }

  async write(dataset: SummaryDataset): Promise<SummaryDatasetMeta> {
    const path = this.datasetPath(dataset.id);
    const { entries, ...meta } = dataset;

    await atomicWriteJson(path, { version: 1, updated_at: dataset.updated_at, dataset }, this.#writes);

    const sizeBytes = await this.#sizeOf(path);
    const indexEntry: SummaryIndexEntry = {
      ...meta,
      file: `${sanitiseDatasetId(dataset.id)}.json`,
      size_bytes: sizeBytes,
    };
    const index = await this.#loadIndex({ fresh: true });
    index.set(dataset.id, indexEntry);
    await this.#saveIndex(index);

    this.#log.info('summary dataset saved', {
      id: dataset.id,
      entries: entries.length,
      bytes: sizeBytes,
    });

    return this.#toMeta(indexEntry);
  }

  /** Removes a dataset together with every .xlsx exported from it. */
  async remove(id: string): Promise<boolean> {
    const index = await this.#loadIndex();
    if (!index.has(id)) return false;

    await this.#writes.enqueue(async () => {
      await rm(this.datasetPath(id), { force: true });
    });
    await this.#removeExports(id);

    index.delete(id);
    await this.#saveIndex(index);
    return true;
  }

  /* ------------------------------------------------------------- exports -- */

  /** Existing exports of one dataset, newest first. */
  async listExports(id: string): Promise<Array<{ file: string; path: string; bytes: number; modified_at: string }>> {
    const prefix = `${sanitiseDatasetId(id)}-`;
    try {
      const names = await readdir(this.#exportsDir);
      const found = await Promise.all(
        names
          .filter((name) => name.startsWith(prefix) && name.endsWith('.xlsx'))
          .map(async (name) => {
            const path = join(this.#exportsDir, name);
            const info = await stat(path);
            return { file: name, path, bytes: info.size, modified_at: info.mtime.toISOString() };
          }),
      );
      // Ties are broken by name so the order is deterministic even when several
      // exports land inside the same filesystem timestamp tick.
      return found.sort((a, b) => b.modified_at.localeCompare(a.modified_at) || b.file.localeCompare(a.file));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw error;
    }
  }

  async writeExport(path: string, data: Uint8Array): Promise<number> {
    await atomicWriteFile(path, data, this.#writes);
    return this.#sizeOf(path);
  }

  /**
   * Keeps only the newest `keep` exports of a dataset.
   *
   * Every export writes a new file, so without this a dataset exported daily would
   * fill the volume. `keepPath` — the file just written — is never a candidate:
   * three exports inside one filesystem timestamp tick would otherwise be ordered
   * arbitrarily and the caller could be handed a file that no longer exists.
   */
  async pruneExports(id: string, keep: number, options: { keepPath: string }): Promise<number> {
    const exports = (await this.listExports(id)).filter((entry) => entry.path !== options.keepPath);
    const stale = exports.slice(Math.max(0, keep - 1));
    for (const entry of stale) {
      await this.#writes.enqueue(async () => {
        await rm(entry.path, { force: true });
      });
    }
    if (stale.length > 0) this.#log.debug('pruned older exports', { id, removed: stale.length, keep });
    return stale.length;
  }

  async #removeExports(id: string): Promise<void> {
    for (const entry of await this.listExports(id)) {
      await this.#writes.enqueue(async () => {
        await rm(entry.path, { force: true });
      });
    }
  }

  /* --------------------------------------------------------------- index -- */

  async #loadIndex(options: { fresh?: boolean } = {}): Promise<Map<string, SummaryIndexEntry>> {
    if (options.fresh !== true && this.#index !== undefined) return this.#index;

    const stored = await readJsonFile<{ version?: number; datasets?: unknown }>(this.indexPath, this.#log);
    if (stored !== null && Array.isArray(stored.datasets)) {
      const index = new Map<string, SummaryIndexEntry>();
      for (const entry of stored.datasets) {
        if (isUsableIndexEntry(entry)) index.set(entry.id, entry);
      }
      this.#index = index;
      return index;
    }

    // No usable index: rebuild it from the dataset files rather than reporting an
    // empty library. This is the recovery path when index.json is deleted, and the
    // path taken by a data directory populated by an older version.
    const rebuilt = await this.#rebuildIndex();
    this.#index = rebuilt;
    if (rebuilt.size > 0) await this.#saveIndex(rebuilt);
    return rebuilt;
  }

  async #rebuildIndex(): Promise<Map<string, SummaryIndexEntry>> {
    const index = new Map<string, SummaryIndexEntry>();
    let names: string[];
    try {
      names = await readdir(this.#dataDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return index;
      throw error;
    }

    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      const path = join(this.#dataDir, name);
      const stored = await readJsonFile<{ dataset?: unknown }>(path, this.#log);
      if (stored === null || !isUsableDataset(stored.dataset)) continue;
      const { entries: _entries, ...meta } = stored.dataset;
      index.set(stored.dataset.id, { ...meta, file: name, size_bytes: await this.#sizeOf(path) });
    }
    if (index.size > 0) this.#log.info('rebuilt summary index from dataset files', { datasets: index.size });
    return index;
  }

  async #saveIndex(index: Map<string, SummaryIndexEntry>): Promise<void> {
    this.#index = index;
    await atomicWriteJson(
      this.indexPath,
      { version: 1, updated_at: new Date().toISOString(), datasets: [...index.values()] },
      this.#writes,
    );
  }

  #toMeta(entry: SummaryIndexEntry): SummaryDatasetMeta {
    const { file, ...meta } = entry;
    return { ...meta, file_path: join(this.#dataDir, file) };
  }

  async #sizeOf(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  }
}

/** Ids become file names, so anything path-like must be rejected. */
export function sanitiseDatasetId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

export function isValidDatasetId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
}

function isUsableDataset(value: unknown): value is SummaryDataset {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SummaryDataset>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    Array.isArray(candidate.entries) &&
    (candidate.units === 'metric' || candidate.units === 'imperial')
  );
}

function isUsableIndexEntry(value: unknown): value is SummaryIndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SummaryIndexEntry>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.file === 'string' &&
    typeof candidate.entry_count === 'number'
  );
}
