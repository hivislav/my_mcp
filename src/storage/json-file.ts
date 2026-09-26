import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '../logger.js';

/**
 * Shared plumbing for the JSON-on-disk stores (watch history, saved summaries).
 *
 * Both stores need exactly the same three guarantees, and getting any of them
 * subtly wrong loses user data:
 *
 * - writes are atomic (temp file + `rename`, which is atomic within a filesystem),
 *   so a crash mid-write leaves the previous good file intact;
 * - writes are serialised, so a background collector and a tool handler cannot
 *   interleave read-modify-write cycles and drop each other's changes;
 * - a corrupt or unreadable file disables that data set instead of killing the
 *   process, because a JSON file on a VPS volume is not worth crashing over.
 */

/** Serialises file writes: operations run strictly one after another. */
export class WriteQueue {
  #chain: Promise<unknown> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation, operation);
    // Keep the chain alive even when this operation rejects, otherwise one
    // failure would reject every later write with the same stale error.
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Reads and parses a JSON file, returning null when it is missing.
 *
 * A malformed file is logged and treated as absent rather than thrown: the
 * caller's alternative is an error surfaced to a remote agent, which it can do
 * nothing about.
 */
export async function readJsonFile<T>(path: string, logger: Logger): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    logger.error('could not read JSON state file', {
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Writes JSON through the queue, atomically, with a trailing newline. */
export function atomicWriteJson(path: string, payload: unknown, queue: WriteQueue): Promise<void> {
  return atomicWriteFile(path, `${JSON.stringify(payload, null, 2)}\n`, queue);
}

/**
 * Writes any payload through the queue, atomically.
 *
 * Used for generated binaries (the .xlsx export) as well as JSON: a half-written
 * workbook is worse than no workbook, because the caller would receive a file
 * that no spreadsheet application can open.
 */
export function atomicWriteFile(path: string, data: string | Uint8Array, queue: WriteQueue): Promise<void> {
  return queue.enqueue(async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, path);
  });
}

/**
 * Verifies a data directory exists and is writable.
 *
 * A read-only container filesystem without a mounted volume is the most likely
 * deployment mistake, and it is far better to discover it at startup than at the
 * first write minutes or hours later.
 */
export async function probeWritableDirectory(dir: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = `${dir}/.write-probe`;
    await writeFile(probe, String(Date.now()), 'utf8');
    await rm(probe, { force: true });
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    const reason = `${code} ${error instanceof Error ? error.message : String(error)}`.trim();
    return { ok: false, reason };
  }
}
