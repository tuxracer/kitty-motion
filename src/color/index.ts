/**
 * Color conversion utilities: gamma correction lookup tables, RGB15->RGB24
 * expansion, and 8-bit luminance.
 */

export * from './consts';

import {
  RGB15_RED_MASK,
  RGB15_GREEN_MASK,
  RGB15_GREEN_SHIFT,
  RGB15_BLUE_SHIFT,
  RGB5_TO_8_LEFT_SHIFT,
  RGB5_TO_8_RIGHT_SHIFT,
  MAX_8BIT,
  LUT_SIZE_8BIT,
  DEFAULT_GAMMA,
  LUMINANCE_R,
  LUMINANCE_G,
  LUMINANCE_B,
} from './consts';

/**
 * Convert RGB15 color to RGB24.
 * Returns 8-bit RGB components (0-255).
 */
export const rgb15ToRgb24 = (color: number): [number, number, number] => {
  const r5 = color & RGB15_RED_MASK;
  const g5 = (color >> RGB15_GREEN_SHIFT) & RGB15_GREEN_MASK;
  const b5 = (color >> RGB15_BLUE_SHIFT) & RGB15_GREEN_MASK;
  return [
    (r5 << RGB5_TO_8_LEFT_SHIFT) | (r5 >> RGB5_TO_8_RIGHT_SHIFT),
    (g5 << RGB5_TO_8_LEFT_SHIFT) | (g5 >> RGB5_TO_8_RIGHT_SHIFT),
    (b5 << RGB5_TO_8_LEFT_SHIFT) | (b5 >> RGB5_TO_8_RIGHT_SHIFT),
  ];
};

/**
 * Calculate luminance as 8-bit integer (0-255).
 */
export const calculateLuminance8 = (r: number, g: number, b: number): number =>
  Math.round(LUMINANCE_R * r + LUMINANCE_G * g + LUMINANCE_B * b);

/**
 * Build gamma correction lookup table.
 * gamma = 1.0: no change
 * gamma > 1.0: darkens midtones (CRT-like)
 * gamma < 1.0: brightens midtones
 */
export const buildGammaLUT = (gamma: number): Uint8Array => {
  const lut = new Uint8Array(LUT_SIZE_8BIT);
  if (gamma === DEFAULT_GAMMA) {
    for (let i = 0; i < LUT_SIZE_8BIT; i++) {
      lut[i] = i;
    }
  } else {
    for (let i = 0; i < LUT_SIZE_8BIT; i++) {
      lut[i] = Math.round(Math.pow(i / MAX_8BIT, gamma) * MAX_8BIT);
    }
  }
  return lut;
};
