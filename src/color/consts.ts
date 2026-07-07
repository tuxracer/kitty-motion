import type { EmojiColor } from './types.ts';

/** Bit mask isolating one 5-bit RGB15 channel after shifting it down to bits 0-4 */
export const RGB15_CHANNEL_MASK = 0x1f;

/** Bit shift for green channel in RGB15 format */
export const RGB15_GREEN_SHIFT = 5;

/** Bit shift for blue channel in RGB15 format */
export const RGB15_BLUE_SHIFT = 10;

/** Mask isolating the 15 color bits of an rgb15 value (bit 15 is unused) */
export const RGB15_COLOR_MASK = 0x7fff;

/** Colors in an rgb15 lookup table (one entry per 15-bit color) */
export const RGB15_LUT_COLORS = 32_768;

/** Bit shift for expanding 5-bit to 8-bit (left shift) */
export const RGB5_TO_8_LEFT_SHIFT = 3;

/** Bit shift for expanding 5-bit to 8-bit (right shift for replication) */
export const RGB5_TO_8_RIGHT_SHIFT = 2;

/** Maximum 8-bit color value */
export const MAX_8BIT = 255;

/** LUT size for 8-bit color operations (256 entries) */
export const LUT_SIZE_8BIT = 256;

// ITU-R BT.601 luminance coefficients

/** Red luminance coefficient for grayscale conversion */
export const LUMINANCE_R = 0.299;

/** Green luminance coefficient for grayscale conversion */
export const LUMINANCE_G = 0.587;

/** Blue luminance coefficient for grayscale conversion */
export const LUMINANCE_B = 0.114;

// =============================================================================
// Linear-light averaging (gamma-correct box downsampling)
// =============================================================================

/** Exponent of the gamma 2.2 transfer curve used for linear-light averaging */
export const LINEAR_GAMMA = 2.2;

/** Maximum 16-bit linear-light channel value */
export const MAX_LINEAR_16BIT = 65_535;

/** Entries in the linear-to-sRGB table (one per 16-bit linear value) */
export const LINEAR_LUT_SIZE = 65_536;

// =============================================================================
// xterm palette quantization (cell-mode SGR output)
// =============================================================================

/** Channel values of the xterm 6x6x6 color cube (palette indices 16-231) */
/* eslint-disable-next-line @typescript-eslint/no-magic-numbers */
export const ANSI256_CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

/** First palette index of the 6x6x6 color cube */
export const ANSI256_CUBE_OFFSET = 16;

/** First palette index of the 24-step grayscale ramp (indices 232-255) */
export const ANSI256_GRAY_OFFSET = 232;

/** Number of entries in the grayscale ramp */
export const ANSI256_GRAY_STEPS = 24;

/** Gray channel value of ramp entry 0; each following entry adds ANSI256_GRAY_STEP */
export const ANSI256_GRAY_BASE = 8;

/** Channel value increment between grayscale ramp entries */
export const ANSI256_GRAY_STEP = 10;

/** Entries in a palette quantization LUT: one per 5-bit-per-channel color */
export const PALETTE_LUT_SIZE = 32_768;

/** Distinct values of one 5-bit LUT channel */
export const PALETTE_LUT_CHANNEL_LEVELS = 32;

/** Bits dropped from each 8-bit channel when forming a palette LUT index */
export const PALETTE_LUT_CHANNEL_DROP = 3;

/** Bit shift placing the red channel in a palette LUT index */
export const PALETTE_LUT_RED_SHIFT = 10;

/** Bit shift placing the green channel in a palette LUT index */
export const PALETTE_LUT_GREEN_SHIFT = 5;

/** RGB values of the standard 16 ANSI colors (xterm defaults) */
/* eslint-disable @typescript-eslint/no-magic-numbers */
export const ANSI16_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];
/* eslint-enable @typescript-eslint/no-magic-numbers */

/** Render palette for emoji mode: nine emoji squares and their RGB values */
/* eslint-disable @typescript-eslint/no-magic-numbers */
export const EMOJI_COLORS: readonly EmojiColor[] = [
  { emoji: '⬜️', rgb: [255, 255, 255] },
  { emoji: '🟨', rgb: [250, 220, 80] },
  { emoji: '🟧', rgb: [240, 140, 20] },
  { emoji: '🟥', rgb: [220, 40, 40] },
  { emoji: '🟫', rgb: [130, 80, 30] },
  { emoji: '🟩', rgb: [50, 160, 30] },
  { emoji: '🟦', rgb: [50, 120, 220] },
  { emoji: '🟪', rgb: [160, 70, 200] },
  { emoji: '⬛️', rgb: [0, 0, 0] },
];
/* eslint-enable @typescript-eslint/no-magic-numbers */

/** Emoji glyphs indexed by palette index, for the renderer's per-cell emit */
export const EMOJI_GLYPHS: readonly string[] = EMOJI_COLORS.map((c) => c.emoji);
