import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { InvalidInputError } from '../errors.js';
import type { WatchService } from '../watch/service.js';
import { isEnabled, type WatchDefinition } from '../watch/types.js';
import { slugify } from '../slug.js';
import { isValidWatchId, sanitiseId } from '../watch/store.js';
import type { ToolDeps } from './deps.js';
import { formatLines, guard, toolResult } from './result.js';
import { locationInputShape, placeLabel } from './schemas.js';
import { resolveLocation } from './shared.js';

/** Shared output fragment describing one registered watch. */
function watchDefinitionShape() {
  return {
    id: z.string().describe('Identifier of the watch. Use it with the other weather-watch tools.'),
    label: z.string().describe('Human-readable place label, e.g. "Москва, Россия".'),
    latitude: z.number().describe('Latitude being polled.'),
    longitude: z.number().describe('Longitude being polled.'),
    country: z.string().nullable().describe('Country name, or null when unknown.'),
    admin1: z.string().nullable().describe('Region/state, or null when unknown.'),
    timezone: z.string().nullable().describe('IANA timezone, or null when unknown.'),
    resolved_from: z.string().nullable().describe('Place name that was geocoded, or null if coordinates were given.'),
    units: z.enum(['metric', 'imperial']).describe('Unit system this watch records in.'),
    language: z.string().describe('Language used for place labels.'),
    created_at: z.string().describe('When the watch was registered, ISO-8601 UTC.'),
    enabled: z.boolean().describe('True when the collector is polling this watch; false when it is paused.'),
  };
}

function watchStatsShape() {
  return {
    last_attempt_at: z.string().nullable().describe('When collection was last attempted, ISO-8601 UTC.'),
    last_success_at: z.string().nullable().describe('When a sample was last stored successfully.'),
    consecutive_failures: z.number().int().describe('Failed attempts since the last success. 0 means healthy.'),
    last_error: z.string().nullable().describe('Message from the most recent failure, or null.'),
    total_samples: z.number().int().describe('Lifetime samples stored, including ones since pruned.'),
    total_failures: z.number().int().describe('Lifetime failed attempts.'),
  };
}

function numericSummaryShape(unit: string) {
  return z.object({
    min: z.number().nullable().describe(`Lowest value in the window, in ${unit}.`),
    max: z.number().nullable().describe(`Highest value in the window, in ${unit}.`),
    avg: z.number().nullable().describe(`Mean value over the window, in ${unit}.`),
    change: z.number().nullable().describe('Difference between the newest and oldest value in the window.'),
    trend: z
      .enum(['rising', 'falling', 'steady', 'unknown'])
      .describe('Direction of travel, comparing the older half of the window against the newer half.'),
  });
}

/**
 * Derives a stable id when the caller does not supply one.
 *
 * Built from the short place name rather than the full label ("paris", not
 * "paris, île-de-france, france"), because the id is user-visible in every later
 * call and ends up in filenames on the host. Coordinates get a readable point id.
 */
function deriveWatchId(
  resolved: { name: string; latitude: number; longitude: number; fromCoordinates: boolean },
  taken: Set<string>,
): string {
  const coordinateFallback = `point-${resolved.latitude.toFixed(2)}-${resolved.longitude.toFixed(2)}`;

  // Transliteration happens inside `slugify`: a pure ASCII slug regex would reduce
  // "Москва" to an empty string and silently produce the generic id "watch".
  const slug = resolved.fromCoordinates ? '' : slugify(resolved.name);

  const base = sanitiseId(slug) || sanitiseId(coordinateFallback) || 'watch';

  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Fall back to a time-derived id rather than looping forever.
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Renders an instant in the watched location's own timezone.
 *
 * Weather is read in local terms ("evening", "night"), and a report full of bare
 * UTC timestamps makes that awkward to judge. Returns null when the timezone is
 * unknown or unrecognised, so the caller can fall back to UTC alone.
 */
function formatLocal(iso: string, timeZone: string | null): string | null {
  if (timeZone === null || timeZone === '') return null;
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date(iso));
  } catch {
    return null;
  }
}

export function registerWeatherWatchTools(server: McpServer, deps: ToolDeps): void {
  const watches = deps.watches;

  // ---------------------------------------------------------------- start ---
  server.registerTool(
    'start_weather_watch',
    {
      title: 'Start periodic weather collection',
      description:
        `Register a location for automatic weather collection every ${Math.round(watches.intervalSeconds / 60)} minutes. ` +
        'The server keeps sampling in the background and appends each reading to a JSON file, building a history that ' +
        'survives restarts. Use `get_weather_watch_report` afterwards to read min/max/average, precipitation totals, ' +
        'temperature trend and how often each condition occurred. ' +
        'Calling this again with an existing `id` replaces that watch; registering a new location takes its first ' +
        'sample immediately, so a report is useful right away. ' +
        'When you omit `id` and the coordinates are already tracked, the existing watch is REUSED instead of a ' +
        'duplicate being created — so calling this repeatedly for the same city is safe. Pass an explicit `id` ' +
        'only when you deliberately want a second watch at the same point. ' +
        'Use this when the user wants weather tracked over time ("watch the weather", "monitor", "track", "notify me if"), ' +
        'rather than for a one-off reading — for a single current reading use `get_current_weather` instead. ' +
        'Provide either `latitude` + `longitude`, or a `location` place name.',
      inputSchema: {
        ...locationInputShape(),
        id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id may contain only letters, digits, hyphen and underscore')
          .describe(
            'Identifier for this watch, used by the other watch tools. Omit it to have one derived from the place ' +
              'name, which is usually what you want.',
          )
          .optional(),
      },
      outputSchema: {
        watch: z.object(watchDefinitionShape()).describe('The watch that was registered.'),
        replaced_existing: z.boolean().describe('True when a watch with this id already existed and was replaced.'),
        reused_existing_location: z
          .boolean()
          .describe(
            'True when a watch already existed at these exact coordinates and was reused instead of creating a ' +
              'duplicate. Pass an explicit `id` to track the same point as a separate watch on purpose.',
          ),
        interval_seconds: z.number().int().describe('How often this server collects a sample.'),
        retention_hours: z.number().int().describe('How long samples are kept before being pruned.'),
        first_sample_status: z
          .string()
          .describe('Outcome of the immediate first sample taken on registration, e.g. "collected".'),
        stored_samples: z
          .number()
          .int()
          .describe(
            'How many samples this watch holds in total. Bookkeeping only — read the weather itself with ' +
              'get_weather_watch_report.',
          ),
      },
      annotations: {
        title: 'Start periodic weather collection',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      guard(
        'start_weather_watch',
        deps.logger,
        async ({ id, latitude, longitude, location, countryCode, language, units }) => {
          const resolved = await resolveLocation(
            deps.clients,
            { latitude, longitude, location, countryCode, language },
            { defaultLanguage: language },
          );

          const label = placeLabel(resolved);
          const existingIds = new Set(watches.list().map((entry) => entry.definition.id));

          // Without an explicit id the caller is saying "watch this place", not
          // "create a second watch here". Reusing the existing watch at the same
          // point prevents the "ekaterinburg-2 / -3 / ..." pile-up, where every
          // copy polls the identical location and doubles upstream usage.
          // An explicit id always wins: naming it is a deliberate request for a
          // separate watch, even at the same coordinates.
          const samePoint = id === undefined ? watches.findAt(resolved.latitude, resolved.longitude) : undefined;
          const deduplicated = samePoint !== undefined;
          const watchId = id ?? samePoint?.id ?? deriveWatchId(resolved, existingIds);

          if (!isValidWatchId(watchId)) {
            throw new InvalidInputError(
              `"${watchId}" is not a usable watch id. Use letters, digits, hyphen and underscore only.`,
            );
          }

          const previous = watches.get(watchId);
          const replaced = previous !== undefined;
          // Distinguish resuming a paused watch from overwriting a live one: the
          // caller asked to start collection, and "Replaced" would misdescribe
          // what happened to its history.
          const wasPaused = previous !== undefined && !isEnabled(previous);
          // Measured before addWatch, which collects a fresh sample of its own —
          // otherwise the "kept" figure would include the one just added.
          const previousStored = previous === undefined ? 0 : (watches.report(watchId, 8760, false)?.stored_samples ?? 0);
          const definition: WatchDefinition = {
            id: watchId,
            label,
            latitude: resolved.latitude,
            longitude: resolved.longitude,
            country: resolved.country ?? null,
            admin1: resolved.admin1 ?? null,
            timezone: resolved.timezone ?? null,
            resolved_from: resolved.geocodedFrom ?? null,
            units,
            language,
            // Reusing an existing watch must not pretend it was just created.
            created_at: samePoint?.created_at ?? new Date().toISOString(),
            // Calling start on a paused watch resumes it; on a new one it begins
            // collecting. Either way the history that already exists is kept.
            enabled: true,
          };

          await watches.addWatch(definition);
          const stats = watches.statsFor(watchId);
          const stored = watches.report(watchId, 1, false);

          const structured = {
            watch: definition,
            replaced_existing: replaced,
            reused_existing_location: deduplicated,
            interval_seconds: watches.intervalSeconds,
            retention_hours: watches.retentionHours,
            // addWatch awaits the first collection, so this is always definitive.
            first_sample_status:
              stats.total_samples > 0
                ? 'collected'
                : `first sample failed: ${stats.last_error ?? 'unknown error'}`,
            stored_samples: stored?.stored_samples ?? 0,
          };

          const headline = deduplicated
            ? wasPaused
              ? `This location is already tracked as "${watchId}" — resuming that watch instead of creating a duplicate.`
              : `This location is already tracked as "${watchId}" — reusing that watch instead of creating a duplicate.`
            : `${
                wasPaused ? 'Resumed' : replaced ? 'Replaced' : 'Started'
              } weather watch "${watchId}" for ${label} (${definition.latitude}, ${definition.longitude}).`;

          // Deliberately terse, and deliberately free of any weather values or
          // sample statistics. An earlier version echoed "samples: 7" and
          // "state: collecting" here, and a task agent mistook this confirmation
          // for the report itself and answered from it — without ever calling
          // get_weather_watch_report. Nothing that looks like a summary belongs in
          // a receipt for an action.
          const text = [
            headline,
            `Now collecting every ${Math.round(watches.intervalSeconds / 60)} min; ` +
              `history is kept for ${watches.retentionHours} h.`,
            previousStored > 0
              ? `Its earlier history was kept and is unaffected.`
              : null,
            `This is only a confirmation. To read the collected weather call ` +
              `get_weather_watch_report (id: "${watchId}") — no weather data is returned here.`,
            deduplicated ? 'To track a genuinely different point, pass an explicit `id`.' : null,
          ]
            .filter((line): line is string => line !== null)
            .join('\n');

          return toolResult(text, structured);
        },
        args,
      ),
  );

  // ----------------------------------------------------------------- stop ---
  server.registerTool(
    'stop_weather_watch',
    {
      title: 'Pause periodic weather collection',
      description:
        'Pause automatic weather collection for a watch. The server stops polling that location immediately, but ALL ' +
        'previously collected samples are kept and remain readable with `get_weather_watch_report`. ' +
        'This is reversible: call `start_weather_watch` with the same id to resume, and the existing history continues. ' +
        'To free disk space or remove a location permanently, use `delete_weather_watch` instead — that one is ' +
        'irreversible. Use `list_weather_watches` if you are unsure of the id.',
      inputSchema: {
        id: z.string().min(1).max(64).describe('Id of the watch to pause, as returned by start_weather_watch.'),
      },
      outputSchema: {
        id: z.string().describe('Id that was targeted.'),
        found: z.boolean().describe('True when a watch with this id exists.'),
        already_stopped: z.boolean().describe('True when the watch was already paused, so nothing changed.'),
        stored_samples: z.number().int().describe('Samples kept for this watch. Pausing never deletes history.'),
        remaining_active: z.number().int().describe('How many watches are still being polled.'),
      },
      annotations: {
        title: 'Pause periodic weather collection',
        readOnlyHint: false,
        // Pausing preserves all data, so it must NOT be advertised as destructive:
        // an agent that sees destructiveHint would avoid it or ask needlessly.
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guard(
        'stop_weather_watch',
        deps.logger,
        async ({ id }) => {
          const existing = watches.get(id);
          if (existing === undefined) {
            const active = watches.list().filter((entry) => entry.enabled).length;
            return toolResult(
              `No watch with id "${id}" exists, so nothing changed. ${active} watch(es) are being polled. ` +
                'Use list_weather_watches to see the ids.',
              { id, found: false, already_stopped: false, stored_samples: 0, remaining_active: active },
            );
          }

          const wasEnabled = isEnabled(existing);
          await watches.setEnabled(id, false);

          const stored = watches.report(id, 8760, false)?.stored_samples ?? 0;
          const active = watches.list().filter((entry) => entry.enabled).length;

          const structured = {
            id,
            found: true,
            already_stopped: !wasEnabled,
            stored_samples: stored,
            remaining_active: active,
          };

          const text = wasEnabled
            ? `Paused weather watch "${id}". ${stored} sample(s) were kept and remain readable; ` +
              `${active} watch(es) are still being polled. Resume with start_weather_watch (id: "${id}").`
            : `Weather watch "${id}" was already paused, so nothing changed. ` +
              `Its ${stored} sample(s) are still stored; ${active} watch(es) are being polled.`;

          return toolResult(text, structured);
        },
        args,
      ),
  );

  // --------------------------------------------------------------- delete ---
  server.registerTool(
    'delete_weather_watch',
    {
      title: 'Delete a weather watch and its history',
      description:
        'Permanently delete a watch together with every sample it collected. This frees disk space and releases the ' +
        'id, but the history CANNOT be recovered afterwards. ' +
        'Only use this when the user explicitly asks to remove the location or its data. ' +
        'To merely stop collecting while keeping the history, use `stop_weather_watch` instead — that is the safe ' +
        'default. You must pass `confirm: true`; without it the call is refused.',
      inputSchema: {
        id: z.string().min(1).max(64).describe('Id of the watch to delete permanently.'),
        confirm: z
          .literal(true)
          .describe(
            'Must be exactly true. This is a deliberate speed bump: it forces a conscious decision before ' +
              'destroying history that may represent days of collection.',
          ),
      },
      outputSchema: {
        id: z.string().describe('Id that was targeted.'),
        deleted: z.boolean().describe('True when the watch existed and was deleted with its samples.'),
        deleted_samples: z.number().int().describe('How many samples were destroyed.'),
        remaining_watches: z.number().int().describe('How many watches remain.'),
      },
      annotations: {
        title: 'Delete a weather watch and its history',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guard(
        'delete_weather_watch',
        deps.logger,
        async ({ id }) => {
          const existing = watches.get(id);
          const stored = existing === undefined ? 0 : (watches.report(id, 8760, false)?.stored_samples ?? 0);

          const deleted = await watches.removeWatch(id);
          const remaining = watches.list().length;

          const structured = { id, deleted, deleted_samples: deleted ? stored : 0, remaining_watches: remaining };
          const text = deleted
            ? `Deleted weather watch "${id}" and its ${stored} stored sample(s). ${remaining} watch(es) remain.`
            : `No watch with id "${id}" exists, so nothing was deleted. ${remaining} watch(es) remain.`;

          return toolResult(text, structured);
        },
        args,
      ),
  );

  // ----------------------------------------------------------------- list ---
  server.registerTool(
    'list_weather_watches',
    {
      title: 'List active weather watches',
      description:
        'List every location this server is currently collecting weather for, with collection health: when the last ' +
        'sample arrived, how many are stored, how far behind the collector is, and the last error if it is failing. ' +
        'Call this before start_weather_watch to avoid duplicates, to find an id for the other watch tools, or to check ' +
        'whether collection is actually working.',
      inputSchema: {},
      outputSchema: {
        count: z.number().int().describe('Number of watches, paused ones included.'),
        active_count: z.number().int().describe('How many watches the collector is currently polling.'),
        paused_count: z.number().int().describe('How many watches are paused but keep their history.'),
        interval_seconds: z.number().int().describe('Collection interval used by this server.'),
        retention_hours: z.number().int().describe('How long samples are kept.'),
        data_directory: z.string().describe('Where the JSON history is written on the server.'),
        generated_at: z
          .string()
          .describe('When this listing was produced, ISO-8601 UTC. Staleness values are relative to this instant.'),
        watches: z
          .array(
            z.object({
              definition: z.object(watchDefinitionShape()),
              stats: z.object(watchStatsShape()),
              enabled: z
                .boolean()
                .describe('True when the collector is still polling this watch; false when it is paused.'),
              sample_count: z.number().int().describe('Samples currently stored for this watch.'),
              staleness_minutes: z
                .number()
                .nullable()
                .describe('Minutes since the newest sample, or null when none is stored. Large values mean stalled.'),
              healthy: z.boolean().describe('True when the most recent collection attempt succeeded.'),
            }),
          )
          .describe('All active watches, ordered by id.'),
      },
      annotations: {
        title: 'List active weather watches',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guard(
        'list_weather_watches',
        deps.logger,
        async () => {
          const entries = watches.list();

          const active = entries.filter((entry) => entry.enabled).length;
          const structured = {
            count: entries.length,
            active_count: active,
            paused_count: entries.length - active,
            interval_seconds: watches.intervalSeconds,
            retention_hours: watches.retentionHours,
            data_directory: watches.dataDir,
            generated_at: new Date().toISOString(),
            watches: entries,
          };

          const text =
            entries.length === 0
              ? `No weather watches are active. Sampling interval is ${watches.intervalSeconds} s. Register one with start_weather_watch.`
              : [
                  `${entries.length} weather watch(es) — ${active} collecting, ${entries.length - active} paused — sampling every ${watches.intervalSeconds} s`,
                  `generated at ${new Date().toISOString()} (UTC)`,
                  ...entries.map((entry) =>
                    [
                      `- ${entry.definition.id}: ${entry.definition.label} (${entry.definition.latitude}, ${entry.definition.longitude})`,
                      formatLines([
                        ['state', entry.enabled ? 'collecting' : 'PAUSED (history kept)'],
                        ['samples', entry.sample_count],
                        ['last sample', entry.staleness_minutes === null ? 'never' : `${entry.staleness_minutes} min ago`],
                        [
                          'health',
                          entry.enabled
                            ? entry.healthy
                              ? 'ok'
                              : `failing (${entry.stats.consecutive_failures}x): ${entry.stats.last_error}`
                            : 'not polled while paused',
                        ],
                      ])
                        .split('\n')
                        .map((line) => `    ${line}`)
                        .join('\n'),
                    ].join('\n'),
                  ),
                ].join('\n');

          return toolResult(text, structured);
        },
        args,
      ),
  );

  // --------------------------------------------------------------- report ---
  server.registerTool(
    'get_weather_watch_report',
    {
      title: 'Get aggregated report for a weather watch',
      description:
        'Read the aggregated history collected for a watch: minimum, maximum, average and trend for temperature, ' +
        'feels-like temperature, humidity, pressure and wind; total and peak precipitation; maximum wind gusts; and how ' +
        'often each weather condition occurred. ' +
        'Also reports collection health — sample count, the period the samples actually span, staleness and the last ' +
        'error — so stale data is visible rather than silently averaged. ' +
        'It returns EVERY sample collected inside the window: a window longer than the collected history is normal and ' +
        'yields the samples that exist, so aggregate over them and state the period they cover rather than treating a ' +
        'partial window as missing data. ' +
        'Use `list_weather_watches` to discover ids. Set `include_samples` to also get the raw readings, which is only ' +
        'worth it when the aggregates are not enough.',
      inputSchema: {
        id: z.string().min(1).max(64).describe('Id of the watch to report on.'),
        window_hours: z
          .number()
          .int()
          .min(1)
          .max(8760)
          .describe('How far back to aggregate, in hours. Defaults to 24.')
          .default(24),
        include_samples: z
          .boolean()
          .describe('Also return every raw sample in the window, not just the aggregates. Defaults to false.')
          .default(false),
      },
      outputSchema: {
        watch: z.object(watchDefinitionShape()).describe('The watch this report covers.'),
        stats: z.object(watchStatsShape()).describe('Collection health for the watch.'),
        stored_samples: z.number().int().describe('Total samples on disk, before applying the window.'),
        generated_at: z
          .string()
          .describe(
            'When this report was produced, ISO-8601 UTC. Every window and staleness figure is relative to this ' +
              'instant, so read it together with `last_sample_at` to judge freshness.',
          ),
        generated_at_local: z
          .string()
          .nullable()
          .describe("The generation time in the watched location's own timezone, or null if the timezone is unknown."),
        aggregate: z
          .object({
            window_hours: z.number().int().describe('Window that was aggregated.'),
            sample_count: z.number().int().describe('Samples inside the window. Every available one is returned.'),
            observed_span_minutes: z
              .number()
              .nullable()
              .describe(
                'Minutes between the oldest and newest sample in the window. A short span simply means the watch ' +
                  'has not been collecting for long; it is not an error and does not limit what can be reported.',
              ),
            first_sample_at: z.string().nullable().describe('Timestamp of the oldest sample in the window.'),
            last_sample_at: z.string().nullable().describe('Timestamp of the newest sample in the window.'),
            staleness_minutes: z.number().nullable().describe('Minutes since the newest sample; large means stalled.'),
            temperature: numericSummaryShape('the watch unit system'),
            apparent_temperature: numericSummaryShape('the watch unit system'),
            relative_humidity: numericSummaryShape('percent'),
            pressure_msl: numericSummaryShape('hPa'),
            wind_speed: numericSummaryShape('the watch unit system'),
            wind_gusts_max: z.number().nullable().describe('Strongest gust recorded in the window, or null.'),
            precipitation_total: z.number().nullable().describe('Sum of precipitation over the window, or null.'),
            precipitation_max: z.number().nullable().describe('Highest single-sample precipitation, or null.'),
            samples_with_precipitation: z.number().int().describe('How many samples recorded any precipitation.'),
            conditions: z
              .array(
                z.object({
                  condition: z.string().describe('Machine-readable condition slug.'),
                  condition_en: z.string().describe('English label.'),
                  condition_ru: z.string().describe('Russian label.'),
                  samples: z.number().int().describe('How many samples had this condition.'),
                  share_percent: z.number().describe('Share of the window, in percent.'),
                }),
              )
              .describe('Condition frequency, most common first.'),
            dominant_condition: z
              .object({
                condition: z.string(),
                condition_en: z.string(),
                condition_ru: z.string(),
                samples: z.number().int(),
                share_percent: z.number(),
              })
              .nullable()
              .describe('The most frequent condition, or null when the window is empty.'),
          })
          .describe('Aggregated statistics for the window.'),
        samples: z
          .array(
            z.object({
              at: z.string().describe('When this server collected the sample, ISO-8601 UTC.'),
              observed_at: z.string().describe("The provider's own timestamp for the values."),
              timezone: z.string().nullable().describe('IANA timezone the observation applies to.'),
              is_day: z.boolean().nullable().describe('True during daylight hours, or null if unknown.'),
              temperature: z.number().nullable(),
              apparent_temperature: z.number().nullable(),
              relative_humidity: z.number().nullable(),
              precipitation: z.number().nullable(),
              weather_code: z.number().nullable(),
              condition: z.string(),
              condition_en: z.string(),
              condition_ru: z.string(),
              cloud_cover: z.number().nullable(),
              pressure_msl: z.number().nullable(),
              wind_speed: z.number().nullable(),
              wind_direction: z.number().nullable(),
              wind_gusts: z.number().nullable(),
            }),
          )
          .describe('Raw samples in the window when include_samples was true, otherwise empty.'),
      },
      annotations: {
        title: 'Get aggregated report for a weather watch',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guard(
        'get_weather_watch_report',
        deps.logger,
        async ({ id, window_hours, include_samples }) => {
          const report = watches.report(id, window_hours, include_samples);
          if (report === null) {
            throw new InvalidInputError(
              `No watch with id "${id}". Call list_weather_watches to see the active ids, or register it with start_weather_watch.`,
            );
          }

          const { aggregate: agg, definition, stats } = report;
          const generatedAt = new Date().toISOString();
          const generatedAtLocal = formatLocal(generatedAt, definition.timezone);

          const structured = {
            watch: definition,
            stats,
            stored_samples: report.stored_samples,
            generated_at: generatedAt,
            generated_at_local: generatedAtLocal,
            aggregate: agg,
            // Projected field by field rather than spread: the stored sample also
            // carries `watch_id`, which is redundant inside its own report, and an
            // accidental extra field would be rejected by output-schema validation
            // at the protocol boundary.
            samples: report.samples.map((entry) => ({
              at: entry.at,
              observed_at: entry.observed_at,
              timezone: entry.timezone,
              is_day: entry.is_day,
              temperature: entry.temperature,
              apparent_temperature: entry.apparent_temperature,
              relative_humidity: entry.relative_humidity,
              precipitation: entry.precipitation,
              weather_code: entry.weather_code,
              condition: entry.condition,
              condition_en: entry.condition_en,
              condition_ru: entry.condition_ru,
              cloud_cover: entry.cloud_cover,
              pressure_msl: entry.pressure_msl,
              wind_speed: entry.wind_speed,
              wind_direction: entry.wind_direction,
              wind_gusts: entry.wind_gusts,
            })),
          };

          const unit = definition.units === 'imperial' ? 'imperial' : 'metric';
          const lines: string[] = [
            `Weather report for ${definition.label} (${definition.latitude}, ${definition.longitude}) — last ${window_hours} h, ${unit} units`,
            formatLines([
              [
                'generated at',
                `${generatedAt} (UTC)${generatedAtLocal !== null ? ` = ${generatedAtLocal} local (${definition.timezone})` : ''}`,
              ],
              [
                'samples',
                `${agg.sample_count} sample(s) in the window, covering ${agg.observed_span_minutes ?? 0} min of the ` +
                  `requested ${window_hours} h`,
              ],
              ['window', agg.first_sample_at === null ? null : `${agg.first_sample_at} .. ${agg.last_sample_at} (UTC)`],
              ['staleness', agg.staleness_minutes === null ? 'no data' : `${agg.staleness_minutes} min since last sample`],
            ]),
          ];

          if (agg.sample_count === 0) {
            if (report.stored_samples > 0) {
              // There IS history, it just sits outside the requested window. Saying
              // "no samples yet" here would be wrong and would push the caller
              // towards re-registering a watch that is working fine.
              lines.push(
                '',
                `The window is empty, but this watch does hold ${report.stored_samples} older sample(s).`,
                `Widen window_hours to reach them (the oldest is at ${
                  watches.report(id, 8760, false)?.aggregate.first_sample_at ?? 'an earlier time'
                }).`,
              );
            } else {
              lines.push(
                '',
                'Nothing has been collected for this watch yet. The collector takes its first sample within ' +
                  `seconds of start_weather_watch and then every ${Math.round(watches.intervalSeconds / 60)} minutes.`,
              );
            }
          } else {
            lines.push(
              '',
              'Temperature:',
              formatLines([
                ['range', `${agg.temperature.min} .. ${agg.temperature.max}`],
                ['average', agg.temperature.avg],
                ['change', `${agg.temperature.change} (${agg.temperature.trend})`],
              ]),
              '',
              'Precipitation:',
              formatLines([
                ['total', agg.precipitation_total],
                ['peak', agg.precipitation_max],
                ['samples with rain/snow', agg.samples_with_precipitation],
              ]),
              '',
              'Wind:',
              formatLines([
                ['average', agg.wind_speed.avg],
                ['maximum', agg.wind_speed.max],
                ['strongest gust', agg.wind_gusts_max],
              ]),
              '',
              `Conditions over the window (${agg.conditions.length} distinct):`,
              ...agg.conditions
                .slice(0, 8)
                .map((entry) => `  ${entry.share_percent}%  ${entry.condition_en} (${entry.condition_ru}) — ${entry.samples} samples`),
            );
          }

          if (!isEnabled(definition)) {
            // Without this, growing staleness on a paused watch looks like a
            // collection failure and would send the caller chasing a non-problem.
            lines.push(
              '',
              'NOTE: this watch is PAUSED — no new samples are being collected. Its stored history is intact.',
              `Resume it with start_weather_watch (id: "${definition.id}") when you need live data again.`,
            );
          } else if (stats.consecutive_failures > 0) {
            lines.push(
              '',
              `WARNING: the last ${stats.consecutive_failures} collection attempt(s) failed, so this data may be stale.`,
              `Last error: ${stats.last_error ?? 'unknown'}`,
            );
          }
          if (include_samples) {
            lines.push('', `Included ${report.samples.length} raw sample(s) in the structured content.`);
          }

          return toolResult(lines.join('\n'), structured);
        },
        args,
      ),
  );
}

