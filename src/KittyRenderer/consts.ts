/** Number of initial frames to force full rendering (no diff optimization) */
export const INITIAL_FULL_RENDER_FRAMES = 5;

/** Default internal render scale factor */
export const DEFAULT_RENDER_SCALE = 2;

/** Minimum render scale (0.25x = quarter resolution) */
export const MIN_RENDER_SCALE = 0.25;

/** Maximum render scale (4x) */
export const MAX_RENDER_SCALE = 4;

/**
 * Default PNG compression level (1-9 scale).
 * Deflate runs on a worker thread, off the main render loop. Benchmarked on
 * real frames: level 5 roughly halves the payload vs level 1 for under 1ms
 * of worker CPU per frame; higher levels add little for several times the
 * cost. Pixel filtering was benchmarked too and rejected; it didn't reduce
 * output size enough to justify the extra CPU.
 */
export const DEFAULT_PNG_COMPRESSION = 5;
