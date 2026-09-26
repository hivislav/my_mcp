import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { InvalidInputError, WatchUnavailableError } from '../errors.js';
import { METRICS } from '../summary/metrics.js';
import { LIMITS, entriesFromWatchSamples, normaliseEntries, type RawEntry } from '../summary/entries.js';
import { XLSX_MIME_TYPE, type ExportResult } from '../summary/service.js';
import type { SummaryDatasetMeta, SummaryEntry, SummaryOrigin } from '../summary/types.js';
import { UNIT_SYSTEM_DESCRIPTION, type UnitSystem } from '../weather/units.js';
import type { ToolDeps } from './deps.js';
import { formatLines, guard, toolResult } from './result.js';

/**
 * The storage/export half of the server.
 *
 * `save_weather_summary` keeps a table of weather values (plus the agent's own
 * analysis) on disk, `list_weather_summaries` shows what is stored, and
 * `export_weather_summary_excel` turns a stored dataset into a real .xlsx that is
 * written to the server and returned in the tool result.
 *
 * Why a summary at all, when the watch tools already persist samples: a watch
 * history is raw readings tied to one location and pruned by retention, while a
 * summary is a finished artefact selected by the agent — several cities, several
 * days, whatever it decided was worth keeping — and it never expires.
 */

/* ------------------------------------------------------------------ shapes -- */

/** One selectable metric field, generated from the shared metric table. */
function metricInputFields(): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};
  for (const spec of METRICS) {
    shape[spec.key] = z
      .number()
      .nullable()
      .describe(`${spec.description} Pass null (or omit) when the source has no value.`)
      .optional();
  }
  return shape;
}

function entryInputShape() {
  return {
    location: z
      .string()
      .min(1)
      .max(LIMITS.location)
      .describe(
        'Place this row describes, e.g. "Moscow" or "Сочи". Required unless the dataset-level `location` is set, ' +
          'which covers the one-city-many-days case.',
      )
      .optional(),
    country: z.string().max(LIMITS.country).describe('Country name or code for this row.').optional(),
    latitude: z.number().min(-90).max(90).describe('Latitude of the place, if you have it.').optional(),
    longitude: z.number().min(-180).max(180).describe('Longitude of the place, if you have it.').optional(),
    date: z
      .string()
      .min(1)
      .max(40)
      .describe(
        'Calendar date this row describes, "YYYY-MM-DD". Taken from the forecast day or the observation timestamp.',
      )
      .optional(),
    condition: z
      .string()
      .min(1)
      .max(LIMITS.condition)
      .describe('Weather condition as text, e.g. "Light rain" or "Небольшой дождь" (from condition_en/condition_ru).')
      .optional(),
    weather_code: z.number().int().describe('Raw WMO weather code, when you have it.').optional(),
    ...metricInputFields(),
    note: z
      .string()
      .max(LIMITS.note)
      .describe('Free-text remark for this row: a caveat, a source quirk, or why the row is unusual.')
      .optional(),
    extra: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .describe(
        'Any additional scalar values worth a spreadsheet column but without a fixed field, e.g. ' +
          '{"pm2_5": 12.5, "sunrise": "06:12", "aqi": 42}. Each key becomes its own column.',
      )
      .optional(),
  };
}

function entryOutputShape() {
  const metrics = Object.fromEntries(METRICS.map((spec) => [spec.key, z.number().nullable()]));
  return z.object({
    location: z.string(),
    country: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    date: z.string().nullable(),
    condition: z.string().nullable(),
    weather_code: z.number().nullable(),
    ...metrics,
    note: z.string().nullable(),
    extra: z.record(z.string(), z.union([z.string(), z.number()])).nullable(),
  });
}

function datasetMetaShape() {
  return z.object({
    id: z.string().describe('Dataset id, used by the other summary tools.'),
    title: z.string().describe('Human-readable title.'),
    summary: z.string().nullable().describe('The written analysis stored with the data, or null.'),
    units: z.enum(['metric', 'imperial']).describe('Unit system every stored value is expressed in.'),
    tags: z.array(z.string()).describe('Free-form labels attached when saving.'),
    locations: z.array(z.string()).describe('Distinct places covered by the rows, in first-seen order.'),
    period: z
      .object({ from: z.string().nullable(), to: z.string().nullable() })
      .describe('Earliest and latest date in the rows, YYYY-MM-DD, or nulls when no row carries a date.'),
    entry_count: z.number().int().describe('Number of rows.'),
    created_at: z.string().describe('When the dataset was first saved, ISO-8601 UTC.'),
    updated_at: z.string().describe('When the dataset was last written, ISO-8601 UTC.'),
    origin: z
      .object({
        kind: z.enum(['agent', 'watch']).describe('Whether the rows were supplied by the agent or derived from a watch.'),
        watch_id: z.string().nullable().describe('Watch the rows came from, or null.'),
        watch_window_hours: z.number().int().nullable().describe('Collection window that was aggregated, or null.'),
        description: z.string().nullable().describe('Free-text provenance supplied when saving.'),
      })
      .describe('Where the rows came from.'),
    size_bytes: z.number().int().describe('Size of the stored JSON file.'),
    file_path: z.string().describe('Absolute path of the stored JSON file on the server.'),
  });
}

/* ------------------------------------------------------------------- tools -- */

export function registerWeatherSummaryTools(server: McpServer, deps: ToolDeps): void {
  const summaries = deps.summaries;

  // ----------------------------------------------------------------- save ---
  server.registerTool(
    'save_weather_summary',
    {
      title: 'Save a weather summary locally',
      description:
        'Store a table of weather values on the server so it can be reused later and exported to Excel. ' +
        'Reach for this after you have read weather data and decided it is worth keeping: several cities compared, ' +
        'or one city across several days. Nothing is fetched here — the server only stores what you pass. ' +
        'Call it once per dataset with one object per place-and-day in `entries`. ' +
        'Mapping from the weather tools: get_current_weather gives location.name, observed_at, temperature, ' +
        'apparent_temperature, relative_humidity, precipitation, cloud_cover, pressure_msl, wind_speed, ' +
        'wind_direction, wind_gusts, condition_en and weather_code; a get_weather_forecast day gives date, ' +
        'temperature_min, temperature_max, apparent_temperature_min/max, precipitation → precipitation_sum, ' +
        'snowfall → snowfall_sum, precipitation_probability → precipitation_probability_max, ' +
        'wind_speed → wind_speed_max, wind_gusts → wind_gusts_max, wind_direction → wind_direction_dominant, ' +
        'uv_index → uv_index_max. Put anything without a field (sunrise, air quality, AQI) in `extra`. ' +
        'If every row is the same place, pass `location` once at the top level instead of on each entry. ' +
        'Alternatively pass `watch_id` to save what the server has already collected for a watched location, ' +
        'aggregated into one row per day. ' +
        'The dataset id is derived from `title` (Latin transliteration), or set `dataset_id` explicitly; saving ' +
        'over an existing id is refused unless you pass replace: true. ' +
        'Put your own written analysis in `summary` — it is stored with the data and printed in full on the ' +
        'exported spreadsheet\'s Info sheet. Afterwards use export_weather_summary_excel to produce the .xlsx file.',
      inputSchema: {
        title: z
          .string()
          .min(1)
          .max(LIMITS.title)
          .describe(
            'Human-readable title, e.g. "Погода в Москве и Сочи, 20-25 сентября". Used to derive the dataset id ' +
              'when `dataset_id` is omitted. Defaults to one built from the places and dates when omitted.',
          )
          .optional(),
        dataset_id: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'use letters, digits, hyphen and underscore only')
          .describe(
            'Explicit id for this dataset. Omit it to derive one from the title; pass the same id with replace: true ' +
              'to update a dataset you saved earlier.',
          )
          .optional(),
        summary: z
          .string()
          .max(LIMITS.summary)
          .describe(
            'Your own written summarisation of the data — the conclusions, not the numbers. Stored with the dataset ' +
              'and printed in full on the Info sheet of the exported spreadsheet.',
          )
          .optional(),
        source: z
          .string()
          .max(200)
          .describe('Where the values came from, e.g. "get_weather_forecast, ensemble gfs05". Recorded for provenance.')
          .optional(),
        tags: z
          .array(z.string().min(1).max(40))
          .max(15)
          .describe('Free-form tags to find the dataset by later, e.g. ["travel", "september"].')
          .optional(),
        units: z
          .enum(['metric', 'imperial'])
          .describe(`${UNIT_SYSTEM_DESCRIPTION} Ignored when watch_id is used: a watch stores its own unit system.`)
          .default('metric'),
        replace: z
          .boolean()
          .describe(
            'Overwrite an existing dataset with the same id. Defaults to false, which refuses the save and tells you ' +
              'which id already exists — that keeps a repeated call from silently discarding earlier data.',
          )
          .default(false),
        entries: z
          .array(z.object(entryInputShape()))
          .describe(
            'One object per place-and-day. Every metric field is optional: include what you actually have, and the ' +
              'spreadsheet will carry only the columns that have data.',
          )
          .optional(),
        location: z
          .string()
          .min(1)
          .max(LIMITS.location)
          .describe(
            'Default place name applied to entries that do not set their own. Use it when all rows describe the same ' +
              'city, e.g. a multi-day forecast.',
          )
          .optional(),
        country: z.string().max(LIMITS.country).describe('Default country applied to entries without one.').optional(),
        latitude: z.number().min(-90).max(90).describe('Default latitude applied to entries without one.').optional(),
        longitude: z.number().min(-180).max(180).describe('Default longitude applied to entries without one.').optional(),
        date: z
          .string()
          .min(1)
          .max(40)
          .describe('Default date applied to entries without one, "YYYY-MM-DD".')
          .optional(),
        watch_id: z
          .string()
          .min(1)
          .max(64)
          .describe(
            'Alternative to `entries`: save the history the server has already collected for this watch, aggregated ' +
              'into one row per day (min/max/mean temperature, total precipitation, peak wind, dominant condition). ' +
              'Find ids with list_weather_watches. Cannot be combined with `entries`.',
          )
          .optional(),
        watch_window_hours: z
          .number()
          .int()
          .min(1)
          .max(8760)
          .describe('How far back to take watch history when `watch_id` is used. Defaults to 24.')
          .default(24),
      },
      outputSchema: {
        dataset: datasetMetaShape().describe('The dataset that was written.'),
        replaced: z.boolean().describe('True when an existing dataset with this id was overwritten.'),
        derived_id: z.boolean().describe('True when the id was derived from the title rather than supplied.'),
        total_datasets: z.number().int().describe('How many datasets are now stored.'),
        next_step: z
          .string()
          .describe('The call that turns this dataset into an .xlsx file, with the id already filled in.'),
      },
      annotations: {
        title: 'Save a weather summary locally',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      guard(
        'save_weather_summary',
        deps.logger,
        async (input) => {
          const { entries, title, units, origin } = await resolveDatasetInput(deps, input);
          const saved = await summaries.save({
            title,
            summary: input.summary?.trim() ?? null,
            units,
            tags: (input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== ''),
            datasetId: input.dataset_id ?? null,
            replace: input.replace,
            entries,
            origin,
          });

          const meta = saved.dataset;
          const structured = {
            dataset: meta,
            replaced: saved.replaced,
            derived_id: saved.derived_id,
            total_datasets: saved.total_datasets,
            next_step: `Call export_weather_summary_excel with dataset_id: "${meta.id}" to get the .xlsx file.`,
          };

          const text = [
            `${saved.replaced ? 'Updated' : 'Saved'} weather summary "${meta.id}" — ${meta.entry_count} row(s), ` +
              `${meta.locations.length} location(s), ${meta.units} units.`,
            formatLines([
              ['title', meta.title],
              ['locations', meta.locations.join(', ')],
              ['period', meta.period.from === null ? null : `${meta.period.from} .. ${meta.period.to}`],
              ['origin', describeOrigin(meta.origin)],
              ['stored at', `${meta.file_path} (${meta.size_bytes} bytes)`],
              ['analysis', meta.summary === null ? null : `${meta.summary.length} character(s) stored`],
            ]),
            '',
            saved.derived_id ? `The id was derived from the title; reuse "${meta.id}" to update it later.` : null,
            `This call only stores data — no file is produced yet. Use export_weather_summary_excel with ` +
              `dataset_id: "${meta.id}" to write the .xlsx.`,
            `${saved.total_datasets} dataset(s) are stored in total; list_weather_summaries shows them.`,
          ]
            .filter((line): line is string => line !== null && line !== '')
            .join('\n');

          return toolResult(text, structured);
        },
        args,
      ),
  );

  // ----------------------------------------------------------------- list ---
  server.registerTool(
    'list_weather_summaries',
    {
      title: 'List saved weather summaries',
      description:
        'List every weather summary stored on the server: id, title, when it was saved, how many rows it holds, ' +
        'which places and dates it covers, whether it came from a watch, and the file it lives in. ' +
        'Call this first when you need a dataset id for export_weather_summary_excel, to check whether a dataset ' +
        'with a given id already exists before saving, or to recall what was saved in an earlier session — the id ' +
        'cannot be guessed reliably, so read it from here. ' +
        'Pass `dataset_id` to inspect one dataset in detail, and `include_entries` to also return its rows.',
      inputSchema: {
        dataset_id: z
          .string()
          .min(1)
          .max(64)
          .describe('Show only this dataset. Omit to list everything that is stored.')
          .optional(),
        include_entries: z
          .boolean()
          .describe(
            'Also return the stored rows. This can be large, so it is off by default; enable it only when you need ' +
              'the values themselves rather than the dataset metadata.',
          )
          .default(false),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .describe('Maximum number of datasets to list, newest first. Defaults to 50.')
          .default(50),
      },
      outputSchema: {
        count: z.number().int().describe('How many datasets this listing contains.'),
        total: z.number().int().describe('How many datasets exist in total, before the limit was applied.'),
        limit: z.number().int().describe('The limit that was applied.'),
        generated_at: z.string().describe('When this listing was produced, ISO-8601 UTC.'),
        data_directory: z.string().describe('Where datasets are stored on the server.'),
        exports_directory: z.string().describe('Where generated .xlsx files are written.'),
        datasets: z
          .array(
            datasetMetaShape().extend({
              entries: z
                .array(entryOutputShape())
                .nullable()
                .describe('The stored rows when include_entries was true, otherwise null.'),
            }),
          )
          .describe('Datasets, newest first.'),
      },
      annotations: {
        title: 'List saved weather summaries',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guard(
        'list_weather_summaries',
        deps.logger,
        async ({ dataset_id, include_entries, limit }) => {
          const all = await summaries.list();
          const selected = dataset_id === undefined ? all.slice(0, limit) : all.filter((meta) => meta.id === dataset_id);

          if (dataset_id !== undefined && selected.length === 0) {
            throw new InvalidInputError(
              `No saved summary with id "${dataset_id}". Call list_weather_summaries without arguments to see the ` +
                'available ids, or save one with save_weather_summary.',
            );
          }

          const datasets: Array<SummaryDatasetMeta & { entries: SummaryEntry[] | null }> = [];
          for (const meta of selected) {
            let entries: SummaryEntry[] | null = null;
            if (include_entries) {
              const record = await summaries.get(meta.id);
              entries = record?.entries ?? [];
            }
            datasets.push({ ...meta, entries });
          }

          const structured = {
            count: datasets.length,
            total: all.length,
            limit,
            generated_at: new Date().toISOString(),
            data_directory: summaries.dataDir,
            exports_directory: summaries.exportsDir,
            datasets,
          };

          const text =
            all.length === 0
              ? `No weather summaries are saved yet. Look up some weather, then call save_weather_summary to keep it. ` +
                `Datasets are stored in ${summaries.dataDir}.`
              : [
                  `${datasets.length} of ${all.length} saved weather summar${all.length === 1 ? 'y' : 'ies'} ` +
                    `(newest first, stored in ${summaries.dataDir})`,
                  ...datasets.map((meta) =>
                    [
                      `- ${meta.id}: ${meta.title}`,
                      formatLines([
                        [
                          'rows',
                          `${meta.entry_count} row(s), ${meta.locations.length} location(s)` +
                            (meta.period.from === null ? '' : `, ${meta.period.from} .. ${meta.period.to}`),
                        ],
                        ['units', meta.units],
                        ['origin', describeOrigin(meta.origin)],
                        ['updated', meta.updated_at],
                        ['tags', meta.tags.length === 0 ? null : meta.tags.join(', ')],
                        ['analysis', meta.summary === null ? null : `${meta.summary.length} character(s)`],
                        ['file', meta.file_path],
                      ])
                        .split('\n')
                        .map((line) => `    ${line}`)
                        .join('\n'),
                    ].join('\n'),
                  ),
                  '',
                  'Use export_weather_summary_excel with one of these ids to get an .xlsx file.',
                  include_entries ? '' : 'Pass include_entries: true to see the stored rows.',
                ]
                  .filter((line) => line !== '')
                  .join('\n');

          return toolResult(text, structured);
        },
        args,
      ),
  );

  // --------------------------------------------------------------- export ---
  server.registerTool(
    'export_weather_summary_excel',
    {
      title: 'Export a saved weather summary to Excel',
      description:
        'Build a real .xlsx spreadsheet from a saved weather summary and return the file itself. ' +
        'Use this whenever the user asks for a table, a spreadsheet, Excel, xlsx or a file they can open — the ' +
        'workbook is returned as an embedded resource in this result and is also written to disk on the server. ' +
        'The workbook has three sheets: "Weather" (one row per saved entry, only the columns that hold data), ' +
        '"Stats" (min, max, average and totals per place and metric) and "Info" (title, units, period, provenance ' +
        'and the full stored analysis). ' +
        'You need a dataset id first: save one with save_weather_summary, or read the ids with ' +
        'list_weather_summaries. Each call writes a new timestamped file, and older exports of the same dataset are ' +
        'pruned automatically. The reply states the absolute path, the size and a SHA-256 so the file can be ' +
        'verified; when the workbook exceeds SUMMARY_MAX_INLINE_BYTES it is written to disk but not embedded, and ' +
        'the reply says so.',
      inputSchema: {
        dataset_id: z
          .string()
          .min(1)
          .max(64)
          .describe('Id of the saved summary to export, as returned by save_weather_summary or list_weather_summaries.'),
        file_name: z
          .string()
          .min(1)
          .max(80)
          .describe(
            'Optional base name for the file, without a path and without the .xlsx extension, e.g. ' +
              '"weather-moscow-september". The dataset id is always prefixed, and a timestamp is added when omitted.',
          )
          .optional(),
        include_file_content: z
          .boolean()
          .describe(
            'Embed the workbook in the tool result as base64, so the caller receives the file itself and not just ' +
              'its path. Defaults to true; set false for a path-only reply.',
          )
          .default(true),
      },
      outputSchema: {
        dataset_id: z.string().describe('Id of the dataset that was exported.'),
        title: z.string().describe('Title of the exported dataset.'),
        file_name: z.string().describe('File name of the generated workbook.'),
        file_path: z.string().describe('Absolute path of the generated workbook on the server.'),
        file_uri: z.string().describe('file:// URI of the generated workbook.'),
        bytes: z.number().int().describe('Size of the workbook in bytes.'),
        sha256: z.string().describe('SHA-256 of the workbook, for verifying the received file.'),
        mime_type: z.string().describe('MIME type of the workbook.'),
        rows: z.number().int().describe('Number of data rows in the Weather sheet.'),
        columns: z.array(z.string()).describe('Column headers of the Weather sheet, in order.'),
        sheets: z.array(z.string()).describe('Sheet names in the workbook.'),
        created_at: z.string().describe('When the workbook was generated, ISO-8601 UTC.'),
        content_included: z.boolean().describe('True when the workbook is embedded in this result as base64.'),
        content_omitted_reason: z.string().nullable().describe('Why the workbook was not embedded, or null.'),
        inline_limit_bytes: z.number().int().describe('The configured embedding size limit.'),
        exports_directory: z.string().describe('Directory holding generated workbooks.'),
        older_exports_removed: z.number().int().describe('How many older exports of this dataset were pruned.'),
      },
      annotations: {
        title: 'Export a saved weather summary to Excel',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      guard(
        'export_weather_summary_excel',
        deps.logger,
        async ({ dataset_id, file_name, include_file_content }) => {
          const result = await summaries.exportExcel(dataset_id, {
            fileName: file_name,
            includeContent: include_file_content,
          });

          const structured = exportStructured(result);
          const text = [
            `Exported weather summary "${result.dataset.id}" to ${result.fileName} ` +
              `(${result.bytes} bytes, ${result.rows} data row(s) across ${result.sheetNames.length} sheet(s)).`,
            formatLines([
              ['file', result.filePath],
              ['sheets', result.sheetNames.join(', ')],
              // Quoted because a header carries its unit after a comma ("temperature, °C").
              ['columns', result.columns.map((column) => `"${column}"`).join(', ')],
              ['sha256', result.sha256],
              ['older exports pruned', result.prunedExports === 0 ? null : result.prunedExports],
            ]),
            '',
            result.base64 === null
              ? `The workbook was NOT embedded in this reply: ${result.inlineSkippedReason ?? 'unknown reason'}. ` +
                `It is on the server at ${result.filePath}.`
              : 'The workbook is attached to this result as an embedded Excel resource (base64). ' +
                'Save it as a .xlsx file; the path above is where the server keeps its own copy.',
          ]
            .filter((line) => line !== '')
            .join('\n');

          const content: CallToolResult['content'] = [{ type: 'text', text }];
          if (result.base64 !== null) {
            // Embedded resource: this is how the file itself reaches the caller,
            // which is what makes the tool useful over a remote HTTP transport
            // where the server's filesystem is not reachable.
            content.push({
              type: 'resource',
              resource: {
                uri: result.uri,
                mimeType: XLSX_MIME_TYPE,
                blob: result.base64,
              },
            });
          }

          return { content, structuredContent: structured };
        },
        args,
      ),
  );
}

/* ---------------------------------------------------------------- helpers -- */

interface SaveInput {
  title?: string | undefined;
  dataset_id?: string | undefined;
  summary?: string | undefined;
  source?: string | undefined;
  tags?: string[] | undefined;
  units: UnitSystem;
  replace: boolean;
  entries?: RawEntry[] | undefined;
  location?: string | undefined;
  country?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  date?: string | undefined;
  watch_id?: string | undefined;
  watch_window_hours: number;
}

/**
 * Resolves the two ways a dataset can be built into normalised entries.
 *
 * Keeping both paths here means the tool handler stays a straight line and the
 * rules ("exactly one source", "a watch must exist", "the window must reach some
 * samples") are stated once.
 */
async function resolveDatasetInput(
  deps: ToolDeps,
  input: SaveInput,
): Promise<{ entries: SummaryEntry[]; title: string; units: UnitSystem; origin: SummaryOrigin }> {
  const hasEntries = input.entries !== undefined && input.entries.length > 0;
  const hasWatch = input.watch_id !== undefined;

  if (hasEntries && hasWatch) {
    throw new InvalidInputError(
      'Pass either `entries` or `watch_id`, not both: they are two different sources for the same dataset. ' +
        'Save the watch history first, then save your own entries as a separate dataset if you need both.',
    );
  }

  if (hasWatch) {
    const watchId = input.watch_id!;
    // The collector owns watch state; initialise before reading it so a process
    // that never started the timer still answers from what is on disk.
    await deps.watches.initialise();
    if (deps.watches.unavailableReason !== null) {
      throw new WatchUnavailableError(deps.watches.unavailableReason);
    }

    const definition = deps.watches.get(watchId);
    if (definition === undefined) {
      throw new InvalidInputError(
        `No weather watch with id "${watchId}". Call list_weather_watches to see the ids, or register one with ` +
          'start_weather_watch and let it collect for a while before saving a summary from it.',
      );
    }

    const report = deps.watches.report(watchId, input.watch_window_hours, true);
    const samples = report?.samples ?? [];
    if (samples.length === 0) {
      const stored = report?.stored_samples ?? 0;
      throw new InvalidInputError(
        stored === 0
          ? `Watch "${watchId}" has not collected any samples yet, so there is nothing to save. It takes its first ` +
            'sample within seconds of start_weather_watch.'
          : `Watch "${watchId}" has ${stored} sample(s), but none inside the last ${input.watch_window_hours} h. ` +
            `Raise watch_window_hours to reach them, or pass your own data in \`entries\` instead.`,
      );
    }

    const entries = entriesFromWatchSamples(definition, samples);
    const title =
      input.title?.trim() ??
      `${definition.label} — weather collected over the last ${input.watch_window_hours} h ` +
        `(aggregated per day from watch "${watchId}")`;

    return {
      entries,
      title,
      units: definition.units,
      origin: {
        kind: 'watch',
        watch_id: watchId,
        watch_window_hours: input.watch_window_hours,
        description: input.source?.trim() ?? `collected by the periodic weather watcher (${samples.length} samples)`,
      },
    };
  }

  if (!hasEntries) {
    throw new InvalidInputError(
      'Nothing to save. Pass `entries` with one object per place-and-day, or `watch_id` to save the history the ' +
        'server already collected for a watched location.',
    );
  }

  const entries = normaliseEntries(input.entries!, {
    location: input.location,
    country: input.country,
    latitude: input.latitude,
    longitude: input.longitude,
    date: input.date,
  });

  return {
    entries,
    title: input.title?.trim() ?? deriveTitle(entries),
    units: input.units,
    origin: { kind: 'agent', watch_id: null, watch_window_hours: null, description: input.source?.trim() ?? null },
  };
}

/** Builds a title from the rows when the caller did not supply one. */
function deriveTitle(entries: readonly SummaryEntry[]): string {
  const locations = [...new Set(entries.map((entry) => entry.location))];
  const dates = entries
    .map((entry) => entry.date)
    .filter((date): date is string => date !== null)
    .sort((a, b) => a.localeCompare(b));

  const places = locations.slice(0, 3).join(', ') + (locations.length > 3 ? ` and ${locations.length - 3} more` : '');
  const span = dates.length === 0 ? '' : dates[0] === dates.at(-1) ? `, ${dates[0]}` : `, ${dates[0]}..${dates.at(-1)}`;
  return `Weather summary: ${places}${span}`;
}

function describeOrigin(origin: SummaryOrigin): string {
  if (origin.kind === 'watch') {
    return `watch "${origin.watch_id ?? 'unknown'}" (last ${origin.watch_window_hours ?? '?'} h, aggregated per day)`;
  }
  return origin.description === null ? 'entries supplied by the agent' : `agent entries — ${origin.description}`;
}

/** The structured reply of the export tool: everything except the base64 payload. */
function exportStructured(result: ExportResult) {
  return {
    dataset_id: result.dataset.id,
    title: result.dataset.title,
    file_name: result.fileName,
    file_path: result.filePath,
    file_uri: result.uri,
    bytes: result.bytes,
    sha256: result.sha256,
    mime_type: result.mimeType,
    rows: result.rows,
    columns: result.columns,
    sheets: result.sheetNames,
    created_at: result.createdAt,
    content_included: result.base64 !== null,
    content_omitted_reason: result.inlineSkippedReason,
    inline_limit_bytes: result.inlineLimitBytes,
    exports_directory: result.exportsDir,
    older_exports_removed: result.prunedExports,
  };
}
