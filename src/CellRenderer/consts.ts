import type { CellSampling } from '../types.ts';
import { SHAPE_REGION_COLS, SHAPE_REGION_ROWS } from '../asciiShapes/index.ts';

/**
 * The upper half block: the foreground color paints the cell's top pixel,
 * the background color its bottom pixel, giving 1x2 pixels per cell with
 * exact color.
 */
export const HALF_BLOCK_GLYPH = '▀';

/** Target pixels per cell vertically (the block's top and bottom halves) */
export const CELL_PIXELS_Y = 2;

/** SGR reset (default colors), appended to every non-empty payload */
export const SGR_RESET = '\x1b[0m';

/** Sentinel for "no SGR color active" at the start of a payload */
export const NO_ACTIVE_COLOR = -1;

/** SGR parameter selecting foreground color (38;5;n or 38;2;r;g;b) */
export const SGR_FG_COLOR = 38;

/** SGR parameter selecting background color (48;5;n or 48;2;r;g;b) */
export const SGR_BG_COLOR = 48;

/** SGR color-mode selector for a 256-color palette index */
export const SGR_MODE_256 = 5;

/** SGR color-mode selector for a 24-bit truecolor triple */
export const SGR_MODE_TRUECOLOR = 2;

/** Base SGR code for standard (non-bright) ANSI 16 foreground colors (0-7) */
export const ANSI16_FG_BASE = 30;

/** Base SGR code for bright ANSI 16 foreground colors (8-15) */
export const ANSI16_FG_BRIGHT_BASE = 90;

/** Base SGR code for standard (non-bright) ANSI 16 background colors (0-7) */
export const ANSI16_BG_BASE = 40;

/** Base SGR code for bright ANSI 16 background colors (8-15) */
export const ANSI16_BG_BRIGHT_BASE = 100;

/** Palette index at which ANSI 16 colors switch from standard to bright */
export const ANSI16_BRIGHT_OFFSET = 8;

/** Bit shift placing the red channel in a packed 0xRRGGBB color key */
export const COLOR_KEY_RED_SHIFT = 16;

/** Bit shift placing the green channel in a packed 0xRRGGBB color key */
export const COLOR_KEY_GREEN_SHIFT = 8;

/** Mask isolating a single byte (one color channel) */
export const BYTE_MASK = 0xff;

// Cached SGR string fragments. paintDiff/paintFull call sgrFor once per
// changed cell, so its parameters are assembled from precomputed strings
// instead of per-call arrays, joins, and number formatting

/** Entries in the byte-indexed SGR tables (one per 8-bit value) */
export const SGR_TABLE_SIZE = 256;

/** Entries in the ANSI 16 SGR tables */
export const ANSI16_TABLE_SIZE = 16;

/** Decimal string for every byte value */
export const DECIMAL_BYTES: readonly string[] = Array.from({ length: SGR_TABLE_SIZE }, (_, value) =>
  String(value),
);

/** SGR parameter prefix for a truecolor foreground */
export const SGR_FG_TRUECOLOR_PREFIX = `${SGR_FG_COLOR};${SGR_MODE_TRUECOLOR};`;

/** SGR parameter prefix for a truecolor background */
export const SGR_BG_TRUECOLOR_PREFIX = `${SGR_BG_COLOR};${SGR_MODE_TRUECOLOR};`;

/** Complete SGR parameter for each 256-color foreground index */
export const SGR_FG_256: readonly string[] = Array.from(
  { length: SGR_TABLE_SIZE },
  (_, index) => `${SGR_FG_COLOR};${SGR_MODE_256};${index}`,
);

/** Complete SGR parameter for each 256-color background index */
export const SGR_BG_256: readonly string[] = Array.from(
  { length: SGR_TABLE_SIZE },
  (_, index) => `${SGR_BG_COLOR};${SGR_MODE_256};${index}`,
);

/** Complete SGR parameter for each ANSI 16 foreground index (30-37, 90-97) */
export const SGR_FG_16: readonly string[] = Array.from({ length: ANSI16_TABLE_SIZE }, (_, index) =>
  String(
    index < ANSI16_BRIGHT_OFFSET
      ? ANSI16_FG_BASE + index
      : ANSI16_FG_BRIGHT_BASE + (index - ANSI16_BRIGHT_OFFSET),
  ),
);

/** Complete SGR parameter for each ANSI 16 background index (40-47, 100-107) */
export const SGR_BG_16: readonly string[] = Array.from({ length: ANSI16_TABLE_SIZE }, (_, index) =>
  String(
    index < ANSI16_BRIGHT_OFFSET
      ? ANSI16_BG_BASE + index
      : ANSI16_BG_BRIGHT_BASE + (index - ANSI16_BRIGHT_OFFSET),
  ),
);

/** Space glyph for background mode, where the cell background color carries the pixel */
export const BACKGROUND_GLYPH = ' ';

/** Pixels per cell vertically in background mode (the whole cell is one pixel) */
export const BACKGROUND_CELL_PIXELS_Y = 1;

/** Half-pixel offset addressing the center of a target pixel's source region */
export const SAMPLE_CENTER_OFFSET = 0.5;

/** Terminal columns one emoji glyph occupies (emoji squares render double-wide) */
export const EMOJI_COLUMNS_PER_CELL = 2;

/** Cell downsampling strategy used when the cellSampling option is not set */
export const DEFAULT_CELL_SAMPLING: CellSampling = 'nearest';

/**
 * Taps per region axis when ascii mode samples a cell under "nearest"
 * (the default) cellSampling. Bounding the taps makes ascii shape sampling
 * O(cells) instead of O(source pixels), so its cost stays flat as the source
 * resolution grows. When a cell footprint is smaller than the resulting caps
 * the whole footprint is read, so small sources are sampled exactly (identical
 * to "box"). Under "box" ascii always averages the full footprint.
 */
export const ASCII_SAMPLE_TAPS_PER_REGION_AXIS = 2;

/** Max sampled columns per cell in nearest-mode ascii (region columns x taps) */
export const ASCII_SAMPLE_MAX_COLS = ASCII_SAMPLE_TAPS_PER_REGION_AXIS * SHAPE_REGION_COLS;

/** Max sampled rows per cell in nearest-mode ascii (region rows x taps) */
export const ASCII_SAMPLE_MAX_ROWS = ASCII_SAMPLE_TAPS_PER_REGION_AXIS * SHAPE_REGION_ROWS;
