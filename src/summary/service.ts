import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from '../config.js';
import { InvalidInputError, SummaryLimitError, SummaryUnavailableError } from '../errors.js';
import type { Logger } from '../logger.js';
import { slugify } from '../slug.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import { SummaryStore, isValidDatasetId } from './store.js';
import type { SummaryDataset, SummaryDatasetMeta, SummaryDatasetRecord, SummaryEntry, SummaryOrigin } from './types.js';
import { buildSummaryWorkbook } from './workbook.js';
import type { UnitSystem } from '../weather/units.js';

/**
 * Saved summaries: the store, the id rules and the Excel export.
 *
 * The service deliberately knows nothing about the MCP layer. Tools hand it
 * already-normalised entries and get back datasets and export results, which keeps
 * the persistence and spreadsheet logic testable without a client.
 */

export interface SaveSummaryInput {
  title: string;
  summary: string | null;
  units: UnitSystem;
  tags: string[];
  datasetId: string | null;
  replace: boolean;
  entries: SummaryEntry[];
  origin: SummaryOrigin;
}

export interface SaveSummaryResult {
  dataset: SummaryDatasetMeta;
  replaced: boolean;
  /** True when the id was derived from the title rather than supplied. */
  derived_id: boolean;
  total_datasets: number;
}

export interface ExportOptions {
  fileName?: string | undefined;
  /** When false only the file is written, and no base64 copy is produced. */
  includeContent: boolean;
}

export interface ExportResult {
  dataset: SummaryDatasetMeta;
  filePath: string;
  fileName: string;
  uri: string;
  bytes: number;
  sha256: string;
  mimeType: string;
  createdAt: string;
  sheetNames: string[];
  columns: string[];
  rows: number;
  /** Base64 of the workbook, or null when it was not inlined. */
  base64: string | null;
  /** Why the workbook was not inlined, when it was not. */
  inlineSkippedReason: string | null;
  inlineLimitBytes: number;
  prunedExports: number;
  exportsDir: string;
}

export const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export class SummaryService {
  readonly #config: Config;
  readonly #log: Logger;
  readonly #store: SummaryStore;
  #unavailableReason: string | null = null;
  #initPromise: Promise<void> | undefined;

  constructor(options: { config: Config; logger: Logger }) {
    this.#config = options.config;
    this.#log = options.logger.child({ component: 'summary' });
    this.#store = new SummaryStore(options.config.summary.dataDir, options.logger);
  }

  get dataDir(): string {
    return this.#store.dataDir;
  }

  get exportsDir(): string {
    return this.#store.exportsDir;
  }

  get maxEntries(): number {
    return this.#config.summary.maxEntries;
  }

  get maxInlineBytes(): number {
    return this.#config.summary.maxInlineBytes;
  }

  get unavailableReason(): string | null {
    return this.#unavailableReason;
  }

  /**
   * Checks that storage is usable. Runs once, and mutating calls await it so a
   * process that forgot to initialise can never write into a directory that is
   * about to turn out to be read-only.
   */
  initialise(): Promise<void> {
    this.#initPromise ??= this.#doInitialise();
    return this.#initPromise;
  }

  async #doInitialise(): Promise<void> {
    const writable = await this.#store.ensureWritable();
    if (!writable.ok) {
      this.#unavailableReason =
        `Saving weather summaries is unavailable: directory "${this.#store.dataDir}" is not writable ` +
        `(${writable.reason}). Mount a writable volume at that path, or point SUMMARY_DATA_DIR at a writable location.`;
      this.#log.error('saved summaries disabled', { reason: this.#unavailableReason });
      return;
    }
    this.#log.info('summary storage ready', { dataDir: this.#store.dataDir, exportsDir: this.#store.exportsDir });
  }

  /* ----------------------------------------------------------------- save -- */

  async save(input: SaveSummaryInput): Promise<SaveSummaryResult> {
    await this.initialise();
    this.#assertAvailable();

    if (input.entries.length === 0) {
      throw new InvalidInputError('Nothing to save: the dataset would have no rows.');
    }
    if (input.entries.length > this.maxEntries) {
      throw new SummaryLimitError(
        `This summary has ${input.entries.length} rows, above the limit of ${this.maxEntries}. ` +
          'Split it into several datasets, or raise SUMMARY_MAX_ENTRIES on the server.',
      );
    }

    const id = input.datasetId ?? deriveDatasetId(input.title);
    if (!isValidDatasetId(id)) {
      throw new InvalidInputError(
        `"${id}" is not a usable dataset id. Use letters, digits, hyphen and underscore only.`,
      );
    }

    const existing = await this.#store.read(id);
    if (existing !== null && !input.replace) {
      throw new InvalidInputError(
        `A dataset with id "${id}" already exists ("${existing.title}", saved ${existing.updated_at}). ` +
          `Pass replace: true to overwrite it, or a different dataset_id to keep both.`,
      );
    }

    if (existing === null) {
      const total = (await this.#store.list()).length;
      if (total >= this.#config.summary.maxDatasets) {
        throw new SummaryLimitError(
          `The limit of ${this.#config.summary.maxDatasets} saved datasets is reached. Overwrite an existing dataset ` +
            `with replace: true, or remove files under ${this.#store.dataDir} on the host. ` +
            'SUMMARY_MAX_DATASETS raises the limit.',
        );
      }
    }

    const now = new Date().toISOString();
    const dataset: SummaryDataset = {
      id,
      title: input.title,
      summary: input.summary,
      units: input.units,
      tags: input.tags,
      locations: [...new Set(input.entries.map((entry) => entry.location))],
      period: periodOf(input.entries),
      entry_count: input.entries.length,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      origin: input.origin,
      entries: input.entries,
    };

    const meta = await this.#store.write(dataset);
    return {
      dataset: meta,
      replaced: existing !== null,
      derived_id: input.datasetId === null,
      total_datasets: (await this.#store.list()).length,
    };
  }

  /* ----------------------------------------------------------- read paths -- */

  async list(): Promise<SummaryDatasetMeta[]> {
    await this.initialise();
    this.#assertAvailable();
    return this.#store.list();
  }

  async get(id: string): Promise<SummaryDatasetRecord | null> {
    await this.initialise();
    this.#assertAvailable();
    if (!isValidDatasetId(id)) return null;
    return this.#store.read(id);
  }

  /** Dataset metadata plus how many exports of it already exist. */
  async exportsFor(id: string): Promise<number> {
    return (await this.#store.listExports(id)).length;
  }

  /* --------------------------------------------------------------- export -- */

  async exportExcel(id: string, options: ExportOptions): Promise<ExportResult> {
    await this.initialise();
    this.#assertAvailable();

    const dataset = await this.#store.read(id);
    if (dataset === null) {
      throw new InvalidInputError(
        `No saved summary with id "${id}". Call list_weather_summaries to see what is available, or save one with ` +
          'save_weather_summary.',
      );
    }

    const createdAt = new Date();
    const built = buildSummaryWorkbook(dataset, {
      generatedAt: createdAt,
      generator: `${SERVER_NAME}/${SERVER_VERSION}`,
      sourceFile: dataset.file_path,
    });

    const fileName = await this.#uniqueExportName(id, options.fileName, createdAt);
    const filePath = join(this.#store.exportsDir, fileName);
    const bytes = await this.#store.writeExport(filePath, built.buffer);

    // Pruning happens after the new file is on disk, so a failure in cleanup can
    // never take away the very export the caller is waiting for.
    const prunedExports = await this.#store.pruneExports(id, this.#config.summary.maxExportsPerDataset, {
      keepPath: filePath,
    });

    const inlineLimit = this.maxInlineBytes;
    const wantsContent = options.includeContent;
    const inlineSkippedReason = !wantsContent
      ? 'include_file_content was false'
      : bytes > inlineLimit
        ? `the workbook is ${bytes} bytes, above the SUMMARY_MAX_INLINE_BYTES limit of ${inlineLimit}`
        : null;

    this.#log.info('summary exported to xlsx', {
      id,
      file: fileName,
      bytes,
      rows: built.rows,
      columns: built.columns.length,
      inlined: inlineSkippedReason === null,
    });

    return {
      dataset: toMetaWithoutFilePath(dataset),
      filePath,
      fileName,
      uri: pathToFileURL(filePath).href,
      bytes,
      sha256: createHash('sha256').update(built.buffer).digest('hex'),
      mimeType: XLSX_MIME_TYPE,
      createdAt: createdAt.toISOString(),
      sheetNames: built.sheetNames,
      columns: built.columns,
      rows: built.rows,
      base64: inlineSkippedReason === null ? built.buffer.toString('base64') : null,
      inlineSkippedReason,
      inlineLimitBytes: inlineLimit,
      prunedExports,
      exportsDir: this.#store.exportsDir,
    };
  }

  /**
   * Picks a file name for the export.
   *
   * Always prefixed with the dataset id: export pruning and dataset deletion find
   * a dataset's files by that prefix, so a name without it would leave orphaned
   * workbooks on the volume forever.
   */
  async #uniqueExportName(id: string, requested: string | undefined, at: Date): Promise<string> {
    const safeId = slugify(id) || 'summary';
    const stamp = at.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

    const requestedBase = sanitiseFileName(requested ?? '');
    const base = requestedBase === '' ? `${safeId}-${stamp}` : `${safeId}-${requestedBase}`;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const name = attempt === 0 ? `${base}.xlsx` : `${base}-${attempt + 1}.xlsx`;
      try {
        await access(join(this.#store.exportsDir, name));
      } catch {
        return name;
      }
    }
    return `${base}-${Date.now().toString(36)}.xlsx`;
  }

  #assertAvailable(): void {
    if (this.#unavailableReason !== null) throw new SummaryUnavailableError(this.#unavailableReason);
  }
}

/**
 * Derives a dataset id from its title.
 *
 * "Погода в Москве, 20-25 сентября" becomes "pogoda-v-moskve-20-25-sentyabrya",
 * which is readable in the listing and stable enough to be reused as the
 * `dataset_id` on a later replace.
 */
export function deriveDatasetId(title: string): string {
  return slugify(title) || 'summary';
}

function periodOf(entries: readonly SummaryEntry[]): { from: string | null; to: string | null } {
  const dates = entries
    .map((entry) => entry.date)
    .filter((date): date is string => date !== null && /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort((a, b) => a.localeCompare(b));

  return { from: dates[0] ?? null, to: dates.at(-1) ?? null };
}

function toMetaWithoutFilePath(dataset: SummaryDatasetRecord): SummaryDatasetMeta {
  const { entries: _entries, ...meta } = dataset;
  return meta;
}

/**
 * Makes a caller-supplied file name safe, without mangling it beyond recognition.
 *
 * Path separators become hyphens — that is the part that actually matters, since a
 * name containing them could otherwise write outside the export directory. The
 * characters Windows forbids (`<>:"|?*`) are dropped, and the extension is removed
 * because the export always writes .xlsx itself.
 */
export function sanitiseFileName(value: string): string {
  return value
    .replace(/\.xlsx$/i, '')
    .replace(/[/\\]/g, '-')
    .replace(/[<>:"|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[.\s]+$/, '');
}
