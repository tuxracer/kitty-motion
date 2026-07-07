/**
 * ASCII shape matching: a precomputed table of per-glyph 6-region ink-coverage
 * vectors plus a nearest-neighbor lookup, the luminance-shape analog of what
 * src/color does for palettes.
 *
 * Polarity is brightness to ink with NO inversion. A bright image region maps
 * to a dense/inky glyph and a dark region maps to space, so callers sample cell
 * luminance directly into the query vector.
 */

export * from './consts.ts';
export * from './types.ts';

import {
  ASCII_SHAPES,
  SHAPE_VECTOR_DIMS,
  ASCII_CONTRAST_EXPONENT,
  ASCII_QUANT_BITS,
  ASCII_QUANT_LEVELS,
  ASCII_QUANT_MAX,
} from './consts.ts';
import type { AsciiLookup } from './types.ts';
import { clamp } from '../helpers/index.ts';

// Flat 95x6 shape table for the brute-force scan below. Laying every glyph's 6
// components out contiguously (row-major) keeps a candidate in one cache line,
// so the nearest-neighbor search reads sequential memory instead of
// dereferencing ASCII_SHAPES[i].vector per glyph. Built once from ASCII_SHAPES.
// The win lands only on cache misses (see createAsciiLookup), so it scales with
// how much the content varies (video and plasma miss often, static UI rarely).
const buildShapeTable = (): Float64Array => {
  const table = new Float64Array(ASCII_SHAPES.length * SHAPE_VECTOR_DIMS);
  for (let i = 0; i < ASCII_SHAPES.length; i++) {
    const vector = ASCII_SHAPES[i].vector;
    for (let d = 0; d < SHAPE_VECTOR_DIMS; d++) {
      table[i * SHAPE_VECTOR_DIMS + d] = vector[d];
    }
  }
  return table;
};

const SHAPE_TABLE = buildShapeTable();

/**
 * Index into ASCII_SHAPES of the glyph whose shape vector is nearest to the
 * given 6D sample vector by squared Euclidean distance. Brute force over all
 * ~95 glyphs (a handful of hundred multiplies, sub-millisecond); mirrors
 * rgbToEmoji in src/color. Scans the flat SHAPE_TABLE for cache locality.
 */
export const nearestAsciiChar = (vector: readonly number[]): number => {
  const table = SHAPE_TABLE;
  const count = ASCII_SHAPES.length;
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < count; i++) {
    const base = i * SHAPE_VECTOR_DIMS;
    let distance = 0;
    for (let d = 0; d < SHAPE_VECTOR_DIMS; d++) {
      const diff = vector[d] - table[base + d];
      distance += diff * diff;
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
};

/**
 * In-place contrast step from the article: normalize by the max component,
 * raise each to ASCII_CONTRAST_EXPONENT, then scale back. This leaves the max
 * component unchanged and shrinks the rest, sharpening the shape match.
 */
export const enhanceAsciiContrast = (vector: number[]): void => {
  let max = 0;
  for (let i = 0; i < vector.length; i++) {
    if (vector[i] > max) {
      max = vector[i];
    }
  }
  if (max <= 0) {
    return;
  }
  for (let i = 0; i < vector.length; i++) {
    vector[i] = (vector[i] / max) ** ASCII_CONTRAST_EXPONENT * max;
  }
};

/**
 * Lookup with a quantization cache. Each of the 6 components is quantized to
 * ASCII_QUANT_BITS bits and packed into a 30-bit key. A full lookup table would
 * be 2**30 entries, so a Map is populated lazily instead. Brute force plus this
 * cache beats a k-d tree here: n=95 makes each miss sub-millisecond, and the
 * cache collapses the repeated work of flat regions that quantize identically.
 */
export const createAsciiLookup = (): AsciiLookup => {
  const cache = new Map<number, number>();
  const lookup = (vector: readonly number[]): number => {
    let key = 0;
    for (let i = 0; i < SHAPE_VECTOR_DIMS; i++) {
      const q = Math.min(ASCII_QUANT_MAX, Math.floor(clamp(vector[i], 0, 1) * ASCII_QUANT_LEVELS));
      key = (key << ASCII_QUANT_BITS) | q;
    }
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const index = nearestAsciiChar(vector);
    cache.set(key, index);
    return index;
  };
  return { lookup };
};
