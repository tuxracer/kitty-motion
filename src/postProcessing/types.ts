export interface EffectOptions {
  /** Gamma correction (default: 1.0, CRT-like: 1.1-1.4) */
  gamma?: number;
  /** Scanline intensity 0.0-1.0 (default: 0.0) */
  scanlines?: number;
  /** Color saturation multiplier (default: 1.0) */
  saturation?: number;
  /** Brightness multiplier (default: 1.0) */
  brightness?: number;
  /** Contrast multiplier (default: 1.0) */
  contrast?: number;
  /** Vignette intensity (default: 0.0) */
  vignette?: number;
  /** Bloom/glow intensity (default: 0.0) */
  bloom?: number;
  /** Bloom brightness threshold (default: 0.6) */
  bloomThreshold?: number;
  /** NTSC artifact intensity (default: 0.0) */
  ntsc?: number;
  /** CRT curvature intensity (default: 0.0) */
  curvature?: number;
  /** Chromatic aberration intensity (default: 0.0) */
  chromaticAberration?: number;
}

/** Precomputed brightness/contrast lookup tables (see ensureColorAdjustLUTs) */
export interface ColorAdjustLUTs {
  /** Clamped and truncated output bytes, for the saturation-off fast path */
  clamped: Uint8Array;
  /** Unclamped float values, feeding the saturation blend */
  raw: Float64Array;
}
