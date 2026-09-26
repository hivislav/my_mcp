import { METRICS, metricHeader } from './metrics.js';
import { extraKeys, metricStats, populatedMetricKeys } from './entries.js';
import type { SummaryDataset, SummaryEntry } from './types.js';
import { buildXlsx, type ColumnSpec, type SheetSpec, type WorkbookSpec } from '../xlsx/workbook.js';

/**
 * Turning a saved summary into a spreadsheet.
 *
 * Layout is fixed so the file is predictable for a human and for a script reading
 * it back:
 *
 * - `Weather` — one row per saved entry, one column per metric that actually has
 *   values. Metrics that are empty throughout are dropped rather than exported as
 *   a column of blanks, which would only imply missing data.
 * - `Stats`  — min/max/average (and totals for accumulations) per place and
 *   metric. This is the "summary" half of the summary, and the reason the file is
 *   worth opening rather than scrolling.
 * - `Info`   — where the data came from, in what units, for what period, and the
 *   agent's own written analysis in full.
 */

export interface WorkbookBuildOptions {
  generatedAt: Date;
  /** Server name/version recorded in the document properties and the Info sheet. */
  generator: string;
  /** Absolute path of the stored dataset, for provenance in the Info sheet. */
  sourceFile?: string | undefined;
}

export interface BuiltWorkbook {
  buffer: Buffer;
  sheetNames: string[];
  /** Headers of the Weather sheet, in order — echoed back to the caller. */
  columns: string[];
  rows: number;
}

export function buildSummaryWorkbook(dataset: SummaryDataset, options: WorkbookBuildOptions): BuiltWorkbook {
  const { columns, extractors } = weatherLayout(dataset);
  const weather: SheetSpec = {
    name: 'Weather',
    columns,
    rows: dataset.entries.map((entry) => extractors.map((extract) => extract(entry))),
  };

  const stats = metricStats(dataset.entries, dataset.units);
  const statsSheet: SheetSpec = {
    name: 'Stats',
    freezeHeader: true,
    autoFilter: stats.length > 0,
    columns: [
      { header: 'location', width: 22, style: 'bold' },
      { header: 'metric', width: 22 },
      { header: 'unit', width: 8 },
      { header: 'values', kind: 'integer', width: 9 },
      { header: 'min', kind: 'number', width: 10 },
      { header: 'max', kind: 'number', width: 10 },
      { header: 'avg', kind: 'number', width: 10 },
      {
        header: 'sum',
        kind: 'decimal2',
        width: 10,
      },
    ],
    rows: stats.map((stat) => [
      stat.location,
      stat.metric,
      stat.unit,
      stat.samples,
      stat.min,
      stat.max,
      stat.avg,
      stat.sum,
    ]),
  };

  const info = buildInfoSheet(dataset, options, columns, stats.length);

  const spec: WorkbookSpec = {
    sheets: [weather, statsSheet, info],
    title: dataset.title,
    creator: options.generator,
    createdAt: options.generatedAt,
  };

  return {
    buffer: buildXlsx(spec),
    sheetNames: spec.sheets.map((sheet) => sheet.name),
    columns: columns.map((column) => column.header),
    rows: dataset.entries.length,
  };
}

/* ---------------------------------------------------------------- weather -- */

type CellExtractor = (entry: SummaryEntry) => string | number | null;

interface WeatherLayout {
  columns: ColumnSpec[];
  /** One extractor per column, in the same order, so a row is built in one pass. */
  extractors: CellExtractor[];
}

function weatherLayout(dataset: SummaryDataset): WeatherLayout {
  const entries = dataset.entries;
  const columns: ColumnSpec[] = [];
  const extractors: CellExtractor[] = [];

  const add = (column: ColumnSpec, extract: CellExtractor) => {
    columns.push(column);
    extractors.push(extract);
  };

  /**
   * Adds a column only when at least one row has a value for it.
   *
   * A column of blanks implies missing data; leaving it out says nothing and keeps
   * the sheet narrow enough to read. `location` and `date` are exempt because they
   * are the row's identity, not a measurement.
   */
  const addIfPopulated = (column: ColumnSpec, extract: CellExtractor) => {
    const filled = entries.some((entry) => {
      const value = extract(entry);
      return value !== null && value !== undefined && value !== '';
    });
    if (filled) add(column, extract);
  };

  add({ header: 'location', width: 24, style: 'bold' }, (entry) => entry.location);
  addIfPopulated({ header: 'country', width: 16 }, (entry) => entry.country);
  addIfPopulated({ header: 'latitude', kind: 'decimal2', width: 11 }, (entry) => entry.latitude);
  addIfPopulated({ header: 'longitude', kind: 'decimal2', width: 11 }, (entry) => entry.longitude);
  add({ header: 'date', width: 12 }, (entry) => entry.date);
  addIfPopulated({ header: 'condition', width: 26 }, (entry) => entry.condition);
  addIfPopulated({ header: 'weather_code', kind: 'integer', width: 12 }, (entry) => entry.weather_code);

  const populated = new Set(populatedMetricKeys(entries));
  for (const spec of METRICS) {
    if (!populated.has(spec.key)) continue;
    add({ header: metricHeader(spec, dataset.units), kind: spec.kind, width: spec.width }, (entry) => entry[spec.key]);
  }

  // Headers already spoken for: an extra metric called "date" or "temperature"
  // would otherwise produce a second, identically headed column.
  const reserved = new Set(columns.map((column) => column.header));
  for (const spec of METRICS) reserved.add(spec.header);

  for (const key of extraKeys(entries)) {
    const header = reserved.has(key) ? `extra.${key}` : key;
    reserved.add(header);
    add({ header, width: Math.min(28, Math.max(12, header.length + 4)) }, (entry) => entry.extra?.[key] ?? null);
  }

  addIfPopulated({ header: 'note', width: 45, style: 'wrapped' }, (entry) => entry.note);
  return { columns, extractors };
}

/* ------------------------------------------------------------------- info -- */

function buildInfoSheet(
  dataset: SummaryDataset,
  options: WorkbookBuildOptions,
  columns: readonly ColumnSpec[],
  statRows: number,
): SheetSpec {
  const tags = dataset.tags.length === 0 ? null : dataset.tags.join(', ');
  const origin =
    dataset.origin.kind === 'watch'
      ? `watch "${dataset.origin.watch_id ?? 'unknown'}", last ${dataset.origin.watch_window_hours ?? '?'} h of collection, aggregated per day`
      : 'entries supplied by the agent';

  const rows: Array<[string, string | number | null]> = [
    ['dataset id', dataset.id],
    ['title', dataset.title],
    ['analysis', dataset.summary],
    ['source', dataset.origin.description],
    ['origin', origin],
    ['units', dataset.units],
    ['tags', tags],
    ['locations', dataset.locations.join(', ')],
    ['period from', dataset.period.from],
    ['period to', dataset.period.to],
    ['entries', dataset.entry_count],
    ['rows in Weather sheet', dataset.entries.length],
    ['rows in Stats sheet', statRows],
    ['columns in Weather sheet', columns.length],
    ['saved at', dataset.created_at],
    ['updated at', dataset.updated_at],
    ['data file', options.sourceFile ?? null],
    ['generated at', options.generatedAt.toISOString()],
    ['generated by', options.generator],
    [
      'note',
      'Empty cells mean the source did not provide that value. Dates are text in YYYY-MM-DD form so they cannot ' +
        'be reinterpreted as a different day by a timezone.',
    ],
  ];

  return {
    name: 'Info',
    freezeHeader: false,
    autoFilter: false,
    columns: [
      { header: 'field', width: 24, style: 'bold' },
      { header: 'value', width: 80, style: 'wrapped' },
    ],
    rows,
  };
}
