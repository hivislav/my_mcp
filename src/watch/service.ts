import type { Config } from '../config.js';
import { OpenMeteoError, WatchLimitError, WatchUnavailableError } from '../errors.js';
import type { Logger } from '../logger.js';
import { fetchWeatherSnapshot, type WeatherSource } from '../weather/snapshot.js';
import type { UnitSystem } from '../weather/units.js';
import { aggregate } from './aggregate.js';
import { WatchStore } from './store.js';
import {
  emptyStats,
  isEnabled,
  sampleFromSnapshot,
  type WatchAggregate,
  type WatchDefinition,
  type WatchSample,
  type WatchStats,
} from './types.js';

export interface WatchServiceOptions {
  config: Config;
  source: WeatherSource;
  logger: Logger;
}

export interface WatchStatus {
  definition: WatchDefinition;
  stats: WatchStats;
  /** False when the watch is paused and no longer being polled. */
  enabled: boolean;
  sample_count: number;
  /** Minutes since the newest stored sample, or null when nothing is stored. */
  staleness_minutes: number | null;
  healthy: boolean;
}

export interface WatchReport {
  definition: WatchDefinition;
  stats: WatchStats;
  aggregate: WatchAggregate;
  samples: WatchSample[];
  /** How many samples actually exist for this watch, before windowing. */
  stored_samples: number;
}

/**
 * The periodic weather collector.
 *
 * IMPORTANT: exactly one instance per process, created in `buildDeps` and started
 * from the entry point — never from `createServer`. In stateless MCP mode a fresh
 * server object is built for every HTTP request, so a timer started during tool
 * registration would be created and destroyed on each call and would never fire
 * on a schedule.
 *
 * The instance owns the in-memory registry and sample buffers; the store keeps
 * them durable across restarts.
 */
export class WatchService {
  readonly #config: Config;
  readonly #source: WeatherSource;
  readonly #log: Logger;
  readonly #store: WatchStore;

  #watches = new Map<string, WatchDefinition>();
  #samples = new Map<string, WatchSample[]>();
  #stats = new Map<string, WatchStats>();

  #timer: NodeJS.Timeout | undefined;
  #started = false;
  #pollInFlight = false;
  #unavailableReason: string | null = null;
  #initPromise: Promise<void> | undefined;

  constructor(options: WatchServiceOptions) {
    this.#config = options.config;
    this.#source = options.source;
    this.#log = options.logger.child({ component: 'watch' });
    this.#store = new WatchStore(options.config.watch.dataDir, options.logger);
  }

  get intervalSeconds(): number {
    return this.#config.watch.intervalSeconds;
  }

  get retentionHours(): number {
    return this.#config.watch.retentionHours;
  }

  get dataDir(): string {
    return this.#store.dataDir;
  }

  /** Null when the collector is usable; otherwise why it is not. */
  get unavailableReason(): string | null {
    return this.#unavailableReason;
  }

  /**
   * Loads persisted state and checks that storage is usable. Runs exactly once.
   *
   * Separated from `start()` so that reading state and scheduling collection are
   * independent: the entry point awaits this before serving, and tests can load a
   * pre-seeded directory without the startup poll mutating it.
   *
   * The mutating methods also await it, so a process that forgot to initialise can
   * never act on a half-empty registry — it would otherwise report "no such watch"
   * for a watch that exists on disk.
   */
  initialise(): Promise<void> {
    this.#initPromise ??= this.#doInitialise();
    return this.#initPromise;
  }

  async #doInitialise(): Promise<void> {
    const writable = await this.#store.ensureWritable();
    if (!writable.ok) {
      // A read-only container without a mounted volume is the likely cause. The
      // rest of the server keeps working; only the watch tools are disabled.
      this.#unavailableReason =
        `Weather collection is unavailable: data directory "${this.#store.dataDir}" is not writable ` +
        `(${writable.reason}). Mount a writable volume at that path, or point WATCH_DATA_DIR at a writable location.`;
      this.#log.error('weather watcher disabled', { reason: this.#unavailableReason });
      return;
    }

    const { watches, stats } = await this.#store.loadRegistry();
    for (const watch of watches) {
      this.#watches.set(watch.id, watch);
      this.#stats.set(watch.id, stats.get(watch.id) ?? emptyStats());
    }
    const loaded = await this.#store.loadAllSamples(watches);
    for (const [id, samples] of loaded) this.#samples.set(id, samples);

    // Bring the files themselves in line with what the API returns, so reading the
    // JSON on the host cannot show a different (ambiguous) timestamp than a tool.
    await this.#store.repairTimestamps(watches.map((watch) => watch.id));

    this.#log.info('weather watcher storage ready', {
      watches: this.#watches.size,
      intervalSeconds: this.intervalSeconds,
      retentionHours: this.retentionHours,
      dataDir: this.#store.dataDir,
      storedSamples: [...this.#samples.values()].reduce((total, list) => total + list.length, 0),
    });
  }

  async start(): Promise<void> {
    await this.initialise();
    if (this.#started) return;
    this.#started = true;

    if (this.#unavailableReason !== null) return;

    // Collect immediately: waiting a full interval would leave the first report
    // empty for ten minutes and look like a failure.
    void this.pollAll('startup');

    this.#timer = setInterval(() => {
      void this.pollAll('schedule');
    }, this.intervalSeconds * 1000);
    // Do not hold the process open purely for the timer; the HTTP server or the
    // stdio transport already does that.
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#log.info('weather watcher stopped');
  }

  /** Registers or replaces a watch, persists it, and takes a first sample. */
  async addWatch(definition: WatchDefinition): Promise<WatchDefinition> {
    await this.initialise();
    this.#assertAvailable();
    if (this.#watches.size >= this.#config.watch.maxWatches && !this.#watches.has(definition.id)) {
      throw new WatchLimitError(this.#config.watch.maxWatches);
    }

    const existing = this.#watches.get(definition.id);
    this.#watches.set(definition.id, definition);
    if (existing === undefined) {
      this.#samples.set(definition.id, this.#samples.get(definition.id) ?? []);
      this.#stats.set(definition.id, this.#stats.get(definition.id) ?? emptyStats());
    }
    await this.#store.saveRegistry([...this.#watches.values()], this.#stats);

    this.#log.info('watch registered', {
      watchId: definition.id,
      label: definition.label,
      replaced: existing !== undefined,
    });

    // Collect the first sample before returning, so the caller can read a report
    // immediately and the tool's answer is deterministic instead of "maybe soon".
    // One upstream request is ~300 ms, comfortably inside a tool-call budget.
    await this.#pollOne(definition.id);
    await this.#persistStats();

    return definition;
  }

  /**
   * Pauses or resumes collection for a watch without touching its history.
   *
   * This is what `stop_weather_watch` calls. Deleting the samples is a distinct,
   * explicit operation (`removeWatch`), because an accidental stop must never
   * destroy data that took days to accumulate.
   */
  async setEnabled(watchId: string, enabled: boolean): Promise<WatchDefinition | null> {
    await this.initialise();
    this.#assertAvailable();

    const existing = this.#watches.get(watchId);
    if (existing === undefined) return null;

    const updated: WatchDefinition = { ...existing, enabled };
    this.#watches.set(watchId, updated);
    await this.#store.saveRegistry([...this.#watches.values()], this.#stats);

    this.#log.info(enabled ? 'watch resumed' : 'watch paused', {
      watchId,
      storedSamples: (this.#samples.get(watchId) ?? []).length,
    });
    return updated;
  }

  /**
   * Finds a watch already registered at the given point.
   *
   * Used to stop `start_weather_watch` from creating duplicates: when the caller
   * names a place and the caller did not choose an id, an existing watch at the
   * same coordinates is reused instead of spawning "paris-2", "paris-3", ... —
   * each of which would poll the same point and burn the upstream request budget.
   *
   * Coordinates are compared rounded to four decimals (~11 m). Geocoding returns
   * identical values for the same place, so this catches real duplicates while
   * still keeping two deliberately distinct nearby points separate.
   */
  findAt(latitude: number, longitude: number): WatchDefinition | undefined {
    const key = coordinateKey(latitude, longitude);
    for (const definition of this.#watches.values()) {
      if (coordinateKey(definition.latitude, definition.longitude) === key) return definition;
    }
    return undefined;
  }

  /** Deletes a watch and its samples. Irreversible. */
  async removeWatch(watchId: string): Promise<boolean> {
    await this.initialise();
    this.#assertAvailable();
    const existed = this.#watches.delete(watchId);
    if (!existed) return false;

    this.#samples.delete(watchId);
    this.#stats.delete(watchId);
    await this.#store.removeWatch(watchId);
    await this.#store.saveRegistry([...this.#watches.values()], this.#stats);

    this.#log.info('watch deleted with its samples', { watchId });
    return true;
  }

  list(): WatchStatus[] {
    const now = Date.now();
    return [...this.#watches.values()]
      .map((definition) => {
        const samples = this.#samples.get(definition.id) ?? [];
        const stats = this.#stats.get(definition.id) ?? emptyStats();
        const last = samples.at(-1);
        return {
          definition,
          stats,
          enabled: isEnabled(definition),
          sample_count: samples.length,
          staleness_minutes: last === undefined ? null : Math.max(0, Math.round((now - Date.parse(last.at)) / 60_000)),
          healthy: stats.consecutive_failures === 0,
        };
      })
      .sort((a, b) => a.definition.id.localeCompare(b.definition.id));
  }

  has(watchId: string): boolean {
    return this.#watches.has(watchId);
  }

  get(watchId: string): WatchDefinition | undefined {
    return this.#watches.get(watchId);
  }

  statsFor(watchId: string): WatchStats {
    return this.#stats.get(watchId) ?? emptyStats();
  }

  report(watchId: string, windowHours: number, includeSamples: boolean): WatchReport | null {
    const definition = this.#watches.get(watchId);
    if (definition === undefined) return null;

    const all = this.#samples.get(watchId) ?? [];
    const aggregateResult = aggregate(all, { windowHours, now: Date.now() });

    const cutoff = Date.now() - windowHours * 3_600_000;
    const windowed = includeSamples
      ? all.filter((sample) => Date.parse(sample.at) >= cutoff).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      : [];

    return {
      definition,
      stats: this.#stats.get(watchId) ?? emptyStats(),
      aggregate: aggregateResult,
      samples: windowed,
      stored_samples: all.length,
    };
  }

  /** Polls every watch. Public so a test or an operator can force a cycle. */
  async pollAll(trigger: 'startup' | 'schedule' | 'manual' = 'manual'): Promise<void> {
    if (this.#unavailableReason !== null) return;
    if (this.#pollInFlight) {
      this.#log.debug('skipping poll, previous cycle still running', { trigger });
      return;
    }

    this.#pollInFlight = true;
    try {
      // Sequential on purpose: the free upstream tier applies a minutely request
      // limit, so a burst of parallel calls would be throttled.
      for (const [watchId, definition] of this.#watches) {
        // A paused watch keeps its history but is not polled.
        if (!isEnabled(definition)) continue;
        await this.#pollOne(watchId);
      }
      await this.#persistStats();
    } finally {
      this.#pollInFlight = false;
    }
  }

  async #pollOne(watchId: string): Promise<void> {
    const definition = this.#watches.get(watchId);
    if (definition === undefined) return;

    const stats = this.#stats.get(watchId) ?? emptyStats();
    const attemptAt = new Date().toISOString();

    try {
      const snapshot = await fetchWeatherSnapshot(
        this.#source,
        { latitude: definition.latitude, longitude: definition.longitude, timezone: definition.timezone },
        definition.units,
      );

      const sample = sampleFromSnapshot(watchId, attemptAt, snapshot);
      const kept = await this.#store.appendSample(sample, this.retentionHours);
      this.#samples.set(watchId, kept);

      this.#stats.set(watchId, {
        ...stats,
        last_attempt_at: attemptAt,
        last_success_at: attemptAt,
        consecutive_failures: 0,
        last_error: null,
        total_samples: stats.total_samples + 1,
      });

      this.#log.debug('sample collected', {
        watchId,
        temperature: sample.temperature,
        condition: sample.condition,
        stored: kept.length,
      });
    } catch (error) {
      // One failing watch must not stop the others, and a transient upstream
      // problem must not crash the collector.
      const message =
        error instanceof OpenMeteoError
          ? `${error.kind}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);

      this.#stats.set(watchId, {
        ...stats,
        last_attempt_at: attemptAt,
        consecutive_failures: stats.consecutive_failures + 1,
        last_error: message,
        total_failures: stats.total_failures + 1,
      });

      this.#log.warn('sample collection failed', {
        watchId,
        consecutiveFailures: stats.consecutive_failures + 1,
        reason: message,
      });
    }
  }

  async #persistStats(): Promise<void> {
    try {
      await this.#store.saveRegistry([...this.#watches.values()], this.#stats);
    } catch (error) {
      this.#log.error('could not persist watch stats', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #assertAvailable(): void {
    if (this.#unavailableReason !== null) throw new WatchUnavailableError(this.#unavailableReason);
  }
}

/** Rounds coordinates to ~11 m so trivially different floats compare equal. */
export function coordinateKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}
