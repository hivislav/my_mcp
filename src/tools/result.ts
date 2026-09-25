import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../logger.js';
import { InvalidInputError, OpenMeteoError } from '../open-meteo/errors.js';

/**
 * Every tool returns BOTH `content` and `structuredContent`.
 *
 * - `content` is the text an LLM reads directly; it is written as a compact,
 *   deterministic summary so the model does not have to parse JSON by eye.
 * - `structuredContent` is the same data as typed JSON, validated against the
 *   tool's declared `outputSchema`, for clients that consume it programmatically.
 *
 * Returning both is what makes one server usable by both a chat agent and an
 * automated pipeline without a second code path.
 */
export function toolResult<T extends Record<string, unknown>>(text: string, structured: T): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

/**
 * A tool-level failure. `isError: true` tells the client the call failed while
 * still delivering the message to the model, which is what lets the agent
 * self-correct (fix an argument, retry, or try another city) instead of seeing
 * an opaque transport error.
 */
export function toolError(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

/**
 * Converts thrown errors into safe tool errors.
 *
 * Unexpected errors are logged in full server-side but reported generically to
 * the client: stack traces and internal hostnames are useful to an operator and
 * are an information leak to a remote agent.
 */
export async function guard<Args>(
  toolName: string,
  logger: Logger,
  handler: (args: Args) => Promise<CallToolResult>,
  args: Args,
): Promise<CallToolResult> {
  try {
    return await handler(args);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      logger.debug('tool rejected invalid input', { tool: toolName, message: error.message });
      return toolError(`Invalid arguments for \`${toolName}\`: ${error.message}`);
    }
    if (error instanceof OpenMeteoError) {
      logger.warn('upstream failure', {
        tool: toolName,
        kind: error.kind,
        status: error.status,
        message: error.message,
      });
      return toolError(error.toToolMessage());
    }
    logger.error('unhandled tool error', {
      tool: toolName,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return toolError(
      `\`${toolName}\` failed unexpectedly. This is a server-side problem, not an issue with the arguments.`,
    );
  }
}

/** Renders `key: value` lines, skipping absent values, for the text channel. */
export function formatLines(entries: Array<[string, string | number | null | undefined]>): string {
  return entries
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value]) => `${label}: ${String(value)}`)
    .join('\n');
}

/** Shared unit metadata so a structured payload always explains its own numbers. */
export interface UnitSet {
  temperature: string;
  wind_speed: string;
  precipitation: string;
}

export type UnitSystem = 'metric' | 'imperial';

export function unitsFor(system: UnitSystem): UnitSet {
  return system === 'imperial'
    ? { temperature: '°F', wind_speed: 'mph', precipitation: 'inch' }
    : { temperature: '°C', wind_speed: 'km/h', precipitation: 'mm' };
}

export function upstreamParamsFor(system: UnitSystem) {
  return system === 'imperial'
    ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' }
    : { temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm' };
}

export const UNIT_SYSTEM_DESCRIPTION =
  'Unit system for all returned values: "metric" (°C, km/h, mm) or "imperial" (°F, mph, inch). Defaults to metric.';
