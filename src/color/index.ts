/**
 * Color conversion utilities: gamma correction lookup tables, RGB15->RGB24
 * expansion, and 8-bit luminance.
 */

export * from './consts.ts';
export * from './types.ts';

import {
  RGB15_CHANNEL_MASK,
  RGB15_GREEN_SHIFT,
  RGB15_BLUE_SHIFT,
  RGB15_COLOR_MASK,
  RGB15_LUT_COLORS,
  RGB5_TO_8_LEFT_SHIFT,
  RGB5_TO_8_RIGHT_SHIFT,
  MAX_8BIT,
  LUT_SIZE_8BIT,
  LUMINANCE_R,
  LUMINANCE_G,
  LUMINANCE_B,
  ANSI256_CUBE_LEVELS,
  ANSI256_CUBE_OFFSET,
  ANSI256_GRAY_OFFSET,
  ANSI256_GRAY_STEPS,
  ANSI256_GRAY_BASE,
  ANSI256_GRAY_STEP,
  ANSI16_PALETTE,
  EMOJI_COLORS,
  PALETTE_LUT_SIZE,
  PALETTE_LUT_CHANNEL_LEVELS,
  PALETTE_LUT_CHANNEL_DROP,
  PALETTE_LUT_RED_SHIFT,
  PALETTE_LUT_GREEN_SHIFT,
  LINEAR_GAMMA,
  MAX_LINEAR_16BIT,
  LINEAR_LUT_SIZE,
} from './consts.ts';
import { isRgb15Buffer, type FrameToRgb24Options, type LinearLightLUTs } from './types.ts';
import type { ColorSpace, FrameBuffer } from '../types.ts';
import { DEFAULT_GAMMA, RGB24_BYTES_PER_PIXEL } from '../consts.ts';

/**
 * Convert RGB15 color to RGB24.
 * Returns 8-bit RGB components (0-255).
 */
export const rgb15ToRgb24 = (color: number): [number, number, number] => {
  const r5 = color & RGB15_CHANNEL_MASK;
  const g5 = (color >> RGB15_GREEN_SHIFT) & RGB15_CHANNEL_MASK;
  const b5 = (color >> RGB15_BLUE_SHIFT) & RGB15_CHANNEL_MASK;
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

// Built lazily on first use and shared process-wide (the tables are pure)
let linearLightLUTs: LinearLightLUTs | null = null;

const buildLinearLightLUTs = (): LinearLightLUTs => {
  const toLinear = new Uint16Array(LUT_SIZE_8BIT);
  for (let v = 0; v < LUT_SIZE_8BIT; v++) {
    const linear = Math.round(Math.pow(v / MAX_8BIT, LINEAR_GAMMA) * MAX_LINEAR_16BIT);
    // Near black the curve rounds several bytes to the same linear value.
    // Force strictly increasing entries so the roundtrip pin below stays
    // collision-free and every byte value survives averaging unchanged
    toLinear[v] = v > 0 && linear <= toLinear[v - 1] ? toLinear[v - 1] + 1 : linear;
  }
  const toSrgb = new Uint8Array(LINEAR_LUT_SIZE);
  for (let l = 0; l < LINEAR_LUT_SIZE; l++) {
    toSrgb[l] = Math.round(Math.pow(l / MAX_LINEAR_16BIT, 1 / LINEAR_GAMMA) * MAX_8BIT);
  }
  // Pin exact roundtrips so uniform regions survive averaging byte-for-byte
  for (let v = 0; v < LUT_SIZE_8BIT; v++) {
    toSrgb[toLinear[v]] = v;
  }
  return { toLinear, toSrgb };
};

/**
 * Get the shared LUT pair for gamma-correct averaging. Averaging sRGB bytes
 * directly makes blends too dark, so box downsampling converts each channel
 * to 16-bit linear light, averages there, and converts back.
 */
export const getLinearLightLUTs = (): LinearLightLUTs => {
  if (linearLightLUTs === null) {
    linearLightLUTs = buildLinearLightLUTs();
  }
  return linearLightLUTs;
};

/** Typed-array elements per pixel: 1 for rgb15 (Uint16Array), 3 for rgb24 (Uint8Array) */
export const frameUnitsPerPixel = (colorSpace: ColorSpace): number =>
  colorSpace === 'rgb15' ? 1 : RGB24_BYTES_PER_PIXEL;

/** Allocate a zeroed framebuffer sized for the color space (diff and prev-frame state) */
export const allocateFrameBuffer = (colorSpace: ColorSpace, pixelCount: number): FrameBuffer =>
  colorSpace === 'rgb15'
    ? new Uint16Array(pixelCount)
    : new Uint8Array(pixelCount * RGB24_BYTES_PER_PIXEL);

/** Allocate a zeroed framebuffer with the same element type and length as the given one */
export const allocateFrameBufferLike = (frameBuffer: FrameBuffer): FrameBuffer =>
  frameBuffer instanceof Uint16Array
    ? new Uint16Array(frameBuffer.length)
    : new Uint8Array(frameBuffer.length);

const squaredDistance = (
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number => (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;

// Index of the nearest 6x6x6 cube level for one channel value
const nearestCubeLevel = (value: number): number => {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < ANSI256_CUBE_LEVELS.length; i++) {
    const distance = Math.abs(ANSI256_CUBE_LEVELS[i] - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
};

/**
 * Nearest xterm 256-color palette index (16-255) for an rgb24 color.
 * Compares the best 6x6x6 cube entry against the best grayscale-ramp entry.
 */
export const rgbToAnsi256 = (r: number, g: number, b: number): number => {
  const ri = nearestCubeLevel(r);
  const gi = nearestCubeLevel(g);
  const bi = nearestCubeLevel(b);
  const cubeDistance = squaredDistance(
    r, g, b,
    ANSI256_CUBE_LEVELS[ri], ANSI256_CUBE_LEVELS[gi], ANSI256_CUBE_LEVELS[bi],
  );

  /* eslint-disable-next-line @typescript-eslint/no-magic-numbers */
  const gray = Math.round((r + g + b) / 3);
  const grayStep = Math.min(
    ANSI256_GRAY_STEPS - 1,
    Math.max(0, Math.round((gray - ANSI256_GRAY_BASE) / ANSI256_GRAY_STEP)),
  );
  const grayValue = ANSI256_GRAY_BASE + grayStep * ANSI256_GRAY_STEP;
  const grayDistance = squaredDistance(r, g, b, grayValue, grayValue, grayValue);

  if (grayDistance < cubeDistance) {
    return ANSI256_GRAY_OFFSET + grayStep;
  }
  /* eslint-disable-next-line @typescript-eslint/no-magic-numbers */
  return ANSI256_CUBE_OFFSET + 36 * ri + 6 * gi + bi;
};

/** Nearest ANSI 16-color palette index (0-15) for an rgb24 color */
export const rgbToAnsi16 = (r: number, g: number, b: number): number => {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < ANSI16_PALETTE.length; i++) {
    const [pr, pg, pb] = ANSI16_PALETTE[i];
    const distance = squaredDistance(r, g, b, pr, pg, pb);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
};

/** Nearest emoji-palette index (0 to 8) for an rgb24 color, by squared sRGB distance */
export const rgbToEmoji = (r: number, g: number, b: number): number => {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < EMOJI_COLORS.length; i++) {
    const [pr, pg, pb] = EMOJI_COLORS[i].rgb;
    const distance = squaredDistance(r, g, b, pr, pg, pb);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
};

/**
 * Pack an rgb24 color into a 15-bit palette-LUT index from the top 5 bits of
 * each channel. Colors differing only in the low 3 bits share an index, so a
 * LUT lookup quantizes with 5-bit-per-channel precision.
 */
export const paletteLUTIndex = (r: number, g: number, b: number): number =>
  ((r >> PALETTE_LUT_CHANNEL_DROP) << PALETTE_LUT_RED_SHIFT) |
  ((g >> PALETTE_LUT_CHANNEL_DROP) << PALETTE_LUT_GREEN_SHIFT) |
  (b >> PALETTE_LUT_CHANNEL_DROP);

// Precompute quantize() for every 5-bit-per-channel color, keyed by
// paletteLUTIndex. Each channel is expanded 5->8 bits by bit replication
// (as in rgb15ToRgb24) before quantizing.
const buildPaletteLUT = (quantize: (r: number, g: number, b: number) => number): Uint8Array => {
  const lut = new Uint8Array(PALETTE_LUT_SIZE);
  for (let r5 = 0; r5 < PALETTE_LUT_CHANNEL_LEVELS; r5++) {
    const r = (r5 << RGB5_TO_8_LEFT_SHIFT) | (r5 >> RGB5_TO_8_RIGHT_SHIFT);
    for (let g5 = 0; g5 < PALETTE_LUT_CHANNEL_LEVELS; g5++) {
      const g = (g5 << RGB5_TO_8_LEFT_SHIFT) | (g5 >> RGB5_TO_8_RIGHT_SHIFT);
      for (let b5 = 0; b5 < PALETTE_LUT_CHANNEL_LEVELS; b5++) {
        const b = (b5 << RGB5_TO_8_LEFT_SHIFT) | (b5 >> RGB5_TO_8_RIGHT_SHIFT);
        lut[(r5 << PALETTE_LUT_RED_SHIFT) | (g5 << PALETTE_LUT_GREEN_SHIFT) | b5] = quantize(r, g, b);
      }
    }
  }
  return lut;
};

/** Quantization LUT mapping paletteLUTIndex to the nearest xterm 256 palette index */
export const buildAnsi256LUT = (): Uint8Array => buildPaletteLUT(rgbToAnsi256);

/** Quantization LUT mapping paletteLUTIndex to the nearest ANSI 16 palette index */
export const buildAnsi16LUT = (): Uint8Array => buildPaletteLUT(rgbToAnsi16);

/** Quantization LUT mapping paletteLUTIndex to the nearest emoji-palette index */
export const buildEmojiLUT = (): Uint8Array => buildPaletteLUT(rgbToEmoji);

// Gamma-baked rgb15 -> rgb24 LUT (3 output bytes per 15-bit color), cached
// per gammaLUT instance. A gamma change builds a new gammaLUT array, which
// transparently keys a fresh entry here
const rgb15LUTCache = new WeakMap<Uint8Array, Uint8Array>();

const getRgb15ToRgb24LUT = (gammaLUT: Uint8Array): Uint8Array => {
  const cached = rgb15LUTCache.get(gammaLUT);
  if (cached !== undefined) {
    return cached;
  }
  const lut = new Uint8Array(RGB15_LUT_COLORS * RGB24_BYTES_PER_PIXEL);
  for (let color = 0; color < RGB15_LUT_COLORS; color++) {
    const [r, g, b] = rgb15ToRgb24(color);
    const idx = color * RGB24_BYTES_PER_PIXEL;
    lut[idx] = gammaLUT[r];
    lut[idx + 1] = gammaLUT[g];
    lut[idx + 2] = gammaLUT[b];
  }
  rgb15LUTCache.set(gammaLUT, lut);
  return lut;
};

/**
 * Convert a framebuffer (rgb15 or rgb24) to tightly packed rgb24 in dst,
 * applying gamma and optional grayscale. dst must hold width*height*3 bytes.
 * With a rect, only that region is converted; the rest of dst is untouched.
 */
export const convertFrameToRgb24 = (
  src: FrameBuffer,
  dst: Uint8Array,
  { colorSpace, width, height, gammaLUT, hasIdentityGamma, colorEnabled, rect }: FrameToRgb24Options,
): void => {
  const x0 = rect?.x ?? 0;
  const y0 = rect?.y ?? 0;
  const x1 = rect === undefined ? width : rect.x + rect.width;
  const y1 = rect === undefined ? height : rect.y + rect.height;

  // Fast path: rgb24 with identity gamma and color enabled is a plain copy
  if (colorSpace === 'rgb24' && src instanceof Uint8Array && colorEnabled && hasIdentityGamma) {
    if (x0 === 0 && y0 === 0 && x1 === width && y1 === height) {
      dst.set(src);
    } else {
      const rectRowBytes = (x1 - x0) * RGB24_BYTES_PER_PIXEL;
      for (let y = y0; y < y1; y++) {
        const rowStart = (y * width + x0) * RGB24_BYTES_PER_PIXEL;
        dst.set(src.subarray(rowStart, rowStart + rectRowBytes), rowStart);
      }
    }
    return;
  }

  if (isRgb15Buffer(colorSpace, src)) {
    const rgb15LUT = getRgb15ToRgb24LUT(gammaLUT);
    for (let y = y0; y < y1; y++) {
      const srcRowStart = y * width;
      const dstRowStart = y * width * RGB24_BYTES_PER_PIXEL;
      for (let x = x0; x < x1; x++) {
        const lutIdx = (src[srcRowStart + x] & RGB15_COLOR_MASK) * RGB24_BYTES_PER_PIXEL;
        const r = rgb15LUT[lutIdx];
        const g = rgb15LUT[lutIdx + 1];
        const b = rgb15LUT[lutIdx + 2];
        const dstIdx = dstRowStart + x * RGB24_BYTES_PER_PIXEL;
        if (colorEnabled) {
          dst[dstIdx] = r;
          dst[dstIdx + 1] = g;
          dst[dstIdx + 2] = b;
        } else {
          const gray = calculateLuminance8(r, g, b);
          dst[dstIdx] = gray;
          dst[dstIdx + 1] = gray;
          dst[dstIdx + 2] = gray;
        }
      }
    }
    return;
  }

  for (let y = y0; y < y1; y++) {
    const srcRowStart = y * width * RGB24_BYTES_PER_PIXEL;
    const dstRowStart = srcRowStart;
    for (let x = x0; x < x1; x++) {
      const srcIdx = srcRowStart + x * RGB24_BYTES_PER_PIXEL;
      const r = gammaLUT[src[srcIdx]];
      const g = gammaLUT[src[srcIdx + 1]];
      const b = gammaLUT[src[srcIdx + 2]];
      const dstIdx = dstRowStart + x * RGB24_BYTES_PER_PIXEL;
      if (colorEnabled) {
        dst[dstIdx] = r;
        dst[dstIdx + 1] = g;
        dst[dstIdx + 2] = b;
      } else {
        const gray = calculateLuminance8(r, g, b);
        dst[dstIdx] = gray;
        dst[dstIdx + 1] = gray;
        dst[dstIdx + 2] = gray;
      }
    }
  }
};
