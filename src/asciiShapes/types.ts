/** One printable ASCII glyph and its precomputed 6-region shape vector. */
export interface AsciiShape {
  /** The printable ASCII glyph this shape describes */
  char: string;
  /**
   * Per-region ink coverage in [0,1], length SHAPE_VECTOR_DIMS, region order
   * [r0c0, r0c1, r1c0, r1c1, r2c0, r2c1] (row-major over a 2-col x 3-row grid).
   */
  vector: readonly number[];
}

/** Nearest-character lookup backed by a quantization cache (see createAsciiLookup). */
export interface AsciiLookup {
  /**
   * Index into ASCII_SHAPES / ASCII_CHARS of the glyph whose shape vector is
   * nearest to the given 6D sample vector, memoized on the quantized vector.
   */
  lookup: (vector: readonly number[]) => number;
}
