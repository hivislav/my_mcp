import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from '../logger.js';
import { hasOffset, offsetForZone, qualifyTimestamp } from '../weather/time.js';
import type { WatchDefinition, WatchSample, WatchStats } from './types.js';

/**
 * Durable JSON storage for watches and their samples.
 *
 * Why files rather than memory: in stateless MCP mode a fresh server instance is
 * built for every HTTP request, so anything held in the server object is gone by
 * the next call. The collector also has to survive a container restart, which
 * only a real volume gives us.
 *
 * Every write goes to a temporary file and is then renamed over the target.
 * `rename` is atomic within a filesystem, so a crash mid-write leaves the
 * previous good file intact instead of a truncated JSON document.
 */
export class WatchStore {
  readonly #dataDir: string;
  readonly #samplesDir: string;
  readonly #log: Logger;

  /** Serialises writes so the poller and tool handlers cannot interleave. */
  #writeChain: Promise<unknown> = Promise.resolve();

  #writable: boolean | null = null;

  constructor(dataDir: string, logger: Logger) {
    this.#dataDir = dataDir;
    this.#samplesDir = join(dataDir, 'samples');
    this.#log = logger.child({ component: 'watch-store' });
  }

  get dataDir(): string {
    return this.#dataDir;
  }

  get registryPath(): string {
    return join(this.#dataDir, 'watches.json');
  }

  samplePath(watchId: string): string {
    return join(this.#samplesDir, `${sanitiseId(watchId)}.json`);
  }

  /**
   * Verifies the data directory is usable before the collector starts.
   *
   * A read-only container filesystem without a mounted volume is the most likely
   * deployment mistake here, so it is surfaced explicitly rather than failing at
   * the first sample ten minutes later.
   */
  async ensureWritable(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await mkdir(this.#samplesDir, { recursive: true });
      const probe = join(this.#dataDir, '.write-probe');
      await writeFile(probe, String(Date.now()), 'utf8');
      await rm(probe, { force: true });
      this.#writable = true;
      return { ok: true };
    } catch (error) {
      this.#writable = false;
      const reason = error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? ''} ${error.message}`.trim() : String(error);
      this.#log.error('data directory is not writable', { dataDir: this.#dataDir, reason });
      return { ok: false, reason };
    }
  }

  get writable(): boolean {
    return this.#writable === true;
  }

  async loadRegistry(): Promise<{ watches: WatchDefinition[]; stats: Map<string, WatchStats> }> {
    const raw = await this.#readJson<RegistryFile>(this.registryPath);
    if (raw === null || !Array.isArray(raw.watches)) {
      return { watches: [], stats: new Map() };
    }

    const watches: WatchDefinition[] = [];
    const stats = new Map<string, WatchStats>();
    for (const entry of raw.watches) {
      if (!isUsableDefinition(entry)) {
        this.#log.warn('skipping malformed watch entry', { entry });
        continue;
      }
      const { stats: entryStats, ...stored } = entry;
      // Registries written before `enabled` existed have no such field; a missing
      // value means "collecting", so every loaded definition gets an explicit one.
      const definition: WatchDefinition = { ...stored, enabled: stored.enabled !== false };
      watches.push(definition);
      if (entryStats !== undefined) stats.set(definition.id, entryStats);
    }
    return { watches, stats };
  }

  async saveRegistry(watches: WatchDefinition[], stats: Map<string, WatchStats>): Promise<void> {
    const payload: RegistryFile = {
      version: 1,
      updated_at: new Date().toISOString(),
      watches: watches.map((definition) => ({ ...definition, stats: stats.get(definition.id) })),
    };
    await this.#atomicWrite(this.registryPath, payload);
  }

  async loadSamples(watchId: string): Promise<WatchSample[]> {
    const raw = await this.#readJson<SamplesFile>(this.samplePath(watchId));
    if (raw === null || !Array.isArray(raw.samples)) return [];
    return raw.samples.filter(isUsableSample).map(qualifySampleTimestamp);
  }

  /**
   * Rewrites sample files whose timestamps were repaired on load.
   *
   * `loadSamples` fixes ambiguous timestamps in memory, but the corrected form only
   * reaches disk on the next append — so a paused watch could keep an ambiguous
   * value in its file indefinitely, and reading the file directly would disagree
   * with what the API returns. This makes the two agree at startup, and only
   * writes files that actually needed repair.
   */
  async repairTimestamps(watchIds: readonly string[]): Promise<number> {
    let repaired = 0;
    for (const watchId of watchIds) {
      const path = this.samplePath(watchId);
      const raw = await this.#readJson<SamplesFile>(path);
      if (raw === null || !Array.isArray(raw.samples)) continue;

      const original = raw.samples.filter(isUsableSample);
      const normalised = original.map(qualifySampleTimestamp);
      if (original.every((sample, index) => sample.observed_at === normalised[index]?.observed_at)) continue;

      await this.#atomicWrite(path, {
        ...raw,
        updated_at: new Date().toISOString(),
        samples: normalised,
      });
      repaired += 1;
    }
    if (repaired > 0) this.#log.info('repaired timestamps in stored samples', { files: repaired });
    return repaired;
  }

  async loadAllSamples(watches: WatchDefinition[]): Promise<Map<string, WatchSample[]>> {
    const entries = await Promise.all(
      watches.map(async (watch) => [watch.id, await this.loadSamples(watch.id)] as const),
    );
    return new Map(entries);
  }

  /**
   * Appends one sample and prunes anything older than the retention window.
   *
   * Retention is enforced on write rather than by a separate job: the file is
   * already being rewritten, so this keeps the on-disk size bounded without a
   * second timer that could drift or be forgotten.
   */
  async appendSample(sample: WatchSample, retentionHours: number): Promise<WatchSample[]> {
    const path = this.samplePath(sample.watch_id);
    const existing = await this.loadSamples(sample.watch_id);

    // Retention is applied to the merged set, not just to the stored history, so
    // the invariant holds unconditionally: the file never contains a sample older
    // than the retention window, whatever its origin.
    const cutoff = Date.now() - retentionHours * 3_600_000;
    const merged = [...existing, sample];
    const kept = merged.filter((entry) => {
      const time = Date.parse(entry.at);
      return Number.isFinite(time) ? time >= cutoff : false;
    });
    kept.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

    const payload: SamplesFile = {
      version: 1,
      watch_id: sample.watch_id,
      updated_at: new Date().toISOString(),
      retention_hours: retentionHours,
      sample_count: kept.length,
      samples: kept,
    };
    await this.#atomicWrite(path, payload);

    const pruned = merged.length - kept.length;
    if (pruned > 0) {
      this.#log.debug('pruned expired samples', { watchId: sample.watch_id, pruned, kept: kept.length });
    }
    return kept;
  }

  async removeWatch(watchId: string): Promise<void> {
    await this.#enqueue(async () => {
      await rm(this.samplePath(watchId), { force: true });
    });
  }

  async #readJson<T>(path: string): Promise<T | null> {
    try {
      const text = await readFile(path, 'utf8');
      return JSON.parse(text) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      // A corrupt file must not take the server down: report it and start clean
      // rather than throwing out of a tool call.
      this.#log.error('could not read JSON state file', {
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  #atomicWrite(path: string, payload: unknown): Promise<void> {
    return this.#enqueue(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await rename(temporary, path);
    });
  }

  /** Chains an operation onto the write queue so writes never interleave. */
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeChain.then(operation, operation);
    // Keep the chain alive even if this operation rejects.
    this.#writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface RegistryFile {
  version: number;
  updated_at: string;
  watches: Array<WatchDefinition & { stats?: WatchStats | undefined }>;
}

interface SamplesFile {
  version: number;
  watch_id: string;
  updated_at: string;
  retention_hours: number;
  sample_count: number;
  samples: WatchSample[];
}

/** Ids become filenames, so anything path-like must be rejected. */
export function sanitiseId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

export function isValidWatchId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
}

function isUsableDefinition(value: unknown): value is WatchDefinition & { stats?: WatchStats | undefined } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WatchDefinition>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.latitude === 'number' &&
    typeof candidate.longitude === 'number' &&
    (candidate.units === 'metric' || candidate.units === 'imperial')
  );
}

/**
 * Repairs `observed_at` on samples written before offsets were recorded.
 *
 * Such a value keeps its original wall-clock reading and gains the offset implied
 * by the stored zone, so the chronology is preserved exactly; only the ambiguity
 * is removed. Idempotent, so it is safe on every load.
 */
function qualifySampleTimestamp(sample: WatchSample): WatchSample {
  if (sample.observed_at === '' || hasOffset(sample.observed_at)) return sample;
  const offset = offsetForZone(sample.timezone, new Date(sample.at));
  if (offset === null) return sample;
  return { ...sample, observed_at: qualifyTimestamp(sample.observed_at, offset) };
}

function isUsableSample(value: unknown): value is WatchSample {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WatchSample>;
  return typeof candidate.at === 'string' && typeof candidate.watch_id === 'string';
}
