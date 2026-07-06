import { probeTerminal } from '../helpers/index.ts';
import type { CellGlyphMode, CellSampling, ColorDepth } from '../types.ts';
import type { SessionEnv, CellPixelSize } from './types.ts';
import {
  DEFAULT_TERMINAL_WIDTH,
  DEFAULT_TERMINAL_HEIGHT,
  CELL_SIZE_QUERY,
  CELL_SIZE_DETECT_TIMEOUT_MS,
  MIN_SANE_CELL_PX,
  MAX_SANE_CELL_PX,
  SSH_ENV_VARS,
  MULTIPLEXER_ENV_VARS,
  MULTIPLEXER_TERM_PREFIXES,
  COLOR_DEPTH_TRUECOLOR,
  COLOR_DEPTH_256,
  COLOR_DEPTH_16,
  TERM_PROGRAM_APPLE_TERMINAL,
} from './consts.ts';

export * from './consts.ts';
export * from './types.ts';

/**
 * True when this process runs in an SSH session, detected from the variables
 * sshd sets. Heuristic: tmux and screen preserve the environment from when
 * the session was created, so a locally created session attached over SSH
 * still reads as local (and the reverse).
 */
export const isSSHSession = (env: SessionEnv = process.env): boolean =>
  SSH_ENV_VARS.some((name) => Boolean(env[name]));

/**
 * True when this process runs under a terminal multiplexer (tmux or GNU
 * screen), detected from TMUX/STY or the TERM prefix. The TERM prefix
 * matters because ssh from inside a multiplexer strips TMUX/STY while
 * output still routes through the multiplexer, which intercepts graphics
 * escape sequences (tmux requires allow-passthrough to forward them).
 */
export const isMultiplexedSession = (env: SessionEnv = process.env): boolean => {
  if (MULTIPLEXER_ENV_VARS.some((name) => Boolean(env[name]))) {
    return true;
  }
  const term = env['TERM'] ?? '';
  return MULTIPLEXER_TERM_PREFIXES.some((prefix) => term.startsWith(prefix));
};

/**
 * Get terminal dimensions with fallback defaults
 */
export const getTerminalDimensions = (): { width: number; height: number } => ({
  width: process.stdout.columns || DEFAULT_TERMINAL_WIDTH,
  height: process.stdout.rows || DEFAULT_TERMINAL_HEIGHT,
});

const isSaneCell = (value: number): boolean =>
  Number.isFinite(value) && value >= MIN_SANE_CELL_PX && value <= MAX_SANE_CELL_PX;

/**
 * Parse a terminal cell-size query response into pixel dimensions.
 *
 * Handles two reply formats:
 *   - CSI 16 t reply: `ESC [ 6 ; height ; width t`, cell size in pixels (preferred)
 *   - CSI 14 t reply: `ESC [ 4 ; height ; width t`, text-area size in pixels,
 *     divided by the current grid (cols x rows) to derive per-cell size.
 *
 * Returns null if no valid, sane response is present.
 */
export const parseCellPixelSize = (
  response: string,
  grid: { cols: number; rows: number }
): CellPixelSize | null => {
  // Prefer the direct cell-size reply (code 6) when present.
  const direct = /\x1b\[6;(\d+);(\d+)t/.exec(response);
  if (direct) {
    const height = Number(direct[1]);
    const width = Number(direct[2]);
    if (isSaneCell(width) && isSaneCell(height)) {
      return { width, height };
    }
  }

  // Fall back to the text-area reply (code 4): divide by the grid.
  const area = /\x1b\[4;(\d+);(\d+)t/.exec(response);
  if (area && grid.cols > 0 && grid.rows > 0) {
    const width = Math.round(Number(area[2]) / grid.cols);
    const height = Math.round(Number(area[1]) / grid.rows);
    if (isSaneCell(width) && isSaneCell(height)) {
      return { width, height };
    }
  }

  return null;
};

// Cached cell-size detection result (null = detected-but-unavailable, undefined = not yet run)
let cellPixelSizeCache: CellPixelSize | null | undefined;

/**
 * Detect the terminal's character cell size in pixels by querying the terminal.
 *
 * This lets renderers (e.g. Kitty graphics) compute a display grid that
 * preserves aspect ratio regardless of the user's font width. Results are
 * cached for the process lifetime. Returns null when the terminal does not
 * report a size (callers should fall back to an assumed cell ratio).
 *
 * Must run before other raw-mode input handlers take over stdin.
 */
export const detectCellPixelSize = async (): Promise<CellPixelSize | null> => {
  if (cellPixelSizeCache !== undefined) {
    return cellPixelSizeCache;
  }

  if (!process.stdin.isTTY) {
    cellPixelSizeCache = null;
    return null;
  }

  const { width: cols, height: rows } = getTerminalDimensions();

  const size = await probeTerminal<CellPixelSize | null>({
    query: CELL_SIZE_QUERY,
    parse: (response) => parseCellPixelSize(response, { cols, rows }),
    timeoutMs: CELL_SIZE_DETECT_TIMEOUT_MS,
    onTimeout: null,
  });
  cellPixelSizeCache = size;
  return size;
};

/**
 * Get the cached terminal cell pixel size.
 * Returns null when detection ran but the terminal did not report a size,
 * or undefined when detection has not yet been run.
 */
export const getCellPixelSize = (): CellPixelSize | null | undefined => cellPixelSizeCache;

/** Reset the cached cell-size detection (useful for tests). */
export const resetCellPixelSizeDetection = (): void => {
  cellPixelSizeCache = undefined;
};

/**
 * Detect the terminal's SGR color depth from the environment: COLORTERM
 * advertising truecolor wins, then a 256color TERM, then the basic 16.
 */
export const detectColorDepth = (env: SessionEnv = process.env): ColorDepth => {
  const colorterm = env['COLORTERM'] ?? '';
  if (colorterm === 'truecolor' || colorterm === '24bit') {
    return COLOR_DEPTH_TRUECOLOR;
  }
  if ((env['TERM'] ?? '').includes('256color')) {
    return COLOR_DEPTH_256;
  }
  return COLOR_DEPTH_16;
};

/**
 * Detect the cell glyph strategy for the terminal. Terminal.app draws Block
 * Elements as font glyphs anchored at the baseline, and no font tiles the
 * cell exactly there (every other mainstream terminal synthesizes these
 * glyphs as cell-filling rectangles), so it gets background mode, rendering
 * one pixel per cell as a background-colored space.
 */
export const detectCellGlyphMode = (env: SessionEnv = process.env): CellGlyphMode =>
  env['TERM_PROGRAM'] === TERM_PROGRAM_APPLE_TERMINAL ? 'background' : 'half-block';

/**
 * Detect the cell downsampling strategy for the terminal. Terminal.app runs
 * in background glyph mode at one pixel per cell, where box-filtered edge
 * blends turn into chunky fringes, so it gets nearest sampling and keeps
 * hard-edged content solid. Everywhere else box averaging looks smoother.
 */
export const detectCellSampling = (env: SessionEnv = process.env): CellSampling =>
  env['TERM_PROGRAM'] === TERM_PROGRAM_APPLE_TERMINAL ? 'nearest' : 'box';
