// =============================================================================
// RGB24 Color Format Constants
// =============================================================================

/** Bytes per pixel in RGB24 format */
export const RGB24_BYTES_PER_PIXEL = 3;

// =============================================================================
// Kitty Graphics Protocol Constants
// =============================================================================

/** Default native width in pixels */
export const DEFAULT_NATIVE_WIDTH = 256;

/** Default native height in pixels */
export const DEFAULT_NATIVE_HEIGHT = 240;

/** Typical terminal cell width in pixels */
export const CELL_WIDTH_PX = 9;

/** Typical terminal cell height in pixels (roughly 2x width for most fonts) */
export const CELL_HEIGHT_PX = 18;

/** Number of initial frames to force full rendering (no diff optimization) */
export const INITIAL_FULL_RENDER_FRAMES = 5;

/** Minimum display columns for Kitty renderer */
export const MIN_DISPLAY_COLS = 32;

/** Minimum display rows for Kitty renderer */
export const MIN_DISPLAY_ROWS = 15;

/** Chunk size for Kitty graphics protocol base64 transmission (256KB) */
export const KITTY_CHUNK_SIZE = 262144;

/** PNG bit depth (8 bits per channel) */
export const PNG_BIT_DEPTH = 8;

/** PNG color type for indexed palette */
export const PNG_COLOR_TYPE_INDEXED = 3;

/** PNG color type for RGB */
export const PNG_COLOR_TYPE_RGB = 2;

/**
 * Default PNG compression level (1-9 scale).
 * Deflate runs on a worker thread, off the main render loop. Benchmarked on
 * real frames: level 5 roughly halves the payload vs level 1 for under 1ms
 * of worker CPU per frame; higher levels add little for several times the
 * cost. Pixel filtering was benchmarked too and rejected — it didn't reduce
 * output size enough to justify the extra CPU.
 */
export const DEFAULT_PNG_COMPRESSION = 5;

/** Minimum PNG compression level */
export const PNG_COMPRESSION_MIN = 1;

/** Maximum PNG compression level */
export const PNG_COMPRESSION_MAX = 9;

/** IHDR total length (13 bytes) */
export const PNG_IHDR_LENGTH = 13;

/** Offset for height field in IHDR (after 4-byte width) */
export const PNG_IHDR_HEIGHT_OFFSET = 4;

/** Default internal render scale factor */
export const DEFAULT_RENDER_SCALE = 2;

/** Minimum render scale (0.25x = quarter resolution) */
export const MIN_RENDER_SCALE = 0.25;

/** Maximum render scale (4x) */
export const MAX_RENDER_SCALE = 4;

// Post-processing effect default values
/** Default gamma value (no correction) */
export const DEFAULT_GAMMA = 1.0;

/** Default bloom brightness threshold */
export const DEFAULT_BLOOM_THRESHOLD = 0.6;
