/**
 * Temp-file naming and cleanup for file-based frame transmission (t=t).
 * The terminal deletes each file after reading it; these helpers only have
 * to produce collision-free names and clean up after crashed processes.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FRAME_FILE_PREFIX,
  SESSION_TOKEN_RADIX,
  SESSION_TOKEN_RANDOM_BYTES,
  STALE_FRAME_FILE_AGE_MS,
} from './consts.ts';

export * from './consts.ts';

/** Per-renderer token (pid + random) so concurrent processes never collide */
export const newFrameFileSession = (): string => {
  const random = randomBytes(SESSION_TOKEN_RANDOM_BYTES).toString('hex');
  return `${process.pid.toString(SESSION_TOKEN_RADIX)}-${random}`;
};

/** Absolute path for one frame's temp file */
export const frameFilePath = (session: string, seq: number, dir: string = tmpdir()): string =>
  join(dir, `${FRAME_FILE_PREFIX}${session}-${seq}.png`);

/**
 * Best-effort removal of frame files leaked by crashed processes. Files are
 * normally deleted by the terminal (t=t), so anything under our prefix that
 * is old must be garbage. Never throws: sweep failures only mean a leftover
 * temp file, which the OS cleans up eventually anyway.
 */
export const sweepStaleFrameFiles = (
  dir: string = tmpdir(),
  maxAgeMs: number = STALE_FRAME_FILE_AGE_MS,
): void => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    if (!name.startsWith(FRAME_FILE_PREFIX)) {
      continue;
    }
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
      }
    } catch {
      // Raced with the terminal's own deletion, or permissions: ignore
    }
  }
};
