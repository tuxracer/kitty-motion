import {
  DEFAULT_TERMINAL_WIDTH,
  DEFAULT_TERMINAL_HEIGHT,
  CELL_SIZE_QUERY,
  CELL_SIZE_DETECT_TIMEOUT_MS,
  MIN_SANE_CELL_PX,
  MAX_SANE_CELL_PX,
} from './consts';

export * from './consts';

/** Pixel dimensions of a single terminal character cell */
export interface CellPixelSize {
  width: number;
  height: number;
}

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
 *   - CSI 16 t reply: `ESC [ 6 ; height ; width t` — cell size in pixels (preferred)
 *   - CSI 14 t reply: `ESC [ 4 ; height ; width t` — text-area size in pixels,
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

  const grid = {
    cols: process.stdout.columns || DEFAULT_TERMINAL_WIDTH,
    rows: process.stdout.rows || DEFAULT_TERMINAL_HEIGHT,
  };

  return new Promise((resolve) => {
    let settled = false;
    let responseData = '';

    const wasRaw = process.stdin.isRaw;
    const wasPaused = process.stdin.isPaused();

    process.stdin.setRawMode(true);
    if (wasPaused) {
      process.stdin.resume();
    }

    const restoreStdin = (): void => {
      process.stdin.setRawMode(wasRaw);
      if (wasPaused) {
        process.stdin.pause();
      }
    };

    const finish = (result: CellPixelSize | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      restoreStdin();
      cellPixelSizeCache = result;
      resolve(result);
    };

    const onData = (data: Buffer): void => {
      responseData += data.toString();
      const parsed = parseCellPixelSize(responseData, grid);
      if (parsed) {
        finish(parsed);
      }
    };

    process.stdin.on('data', onData);
    process.stdout.write(CELL_SIZE_QUERY);

    const timer = setTimeout(() => finish(null), CELL_SIZE_DETECT_TIMEOUT_MS);
  });
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
