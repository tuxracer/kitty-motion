import { ASCII_SHAPES } from './shapeVectors.ts';

export { ASCII_SHAPES };

/**
 * Printable ASCII glyphs indexed by shape index. Derived from ASCII_SHAPES so
 * the glyph table has a single source of truth (the generated shape table).
 */
export const ASCII_CHARS: readonly string[] = ASCII_SHAPES.map((s) => s.char);

/** Columns in the cell partition grid used for shape vectors. */
export const SHAPE_REGION_COLS = 2;

/** Rows in the cell partition grid used for shape vectors. */
export const SHAPE_REGION_ROWS = 3;

/** Components in a shape vector (SHAPE_REGION_COLS * SHAPE_REGION_ROWS). */
export const SHAPE_VECTOR_DIMS = 6;

/**
 * Contrast exponent applied by enhanceAsciiContrast. Values above 1 pull the
 * non-max components toward zero (raising local contrast) while leaving the
 * max component fixed, matching the article's contrast step.
 */
export const ASCII_CONTRAST_EXPONENT = 1.5;

/** Bits each vector component is quantized to for the lookup cache key. */
export const ASCII_QUANT_BITS = 5;

/** Distinct quantization levels per component (2 ** ASCII_QUANT_BITS). */
export const ASCII_QUANT_LEVELS = 32;

/** Highest quantization level index (ASCII_QUANT_LEVELS - 1). */
export const ASCII_QUANT_MAX = 31;
