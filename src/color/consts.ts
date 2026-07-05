/** RGB15 format bit mask for 5-bit red channel (bits 0-4) */
export const RGB15_RED_MASK = 0x001f;

/** RGB15 format bit mask for 5-bit green channel (bits 5-9) */
export const RGB15_GREEN_MASK = 0x1f;

/** Bit shift for green channel in RGB15 format */
export const RGB15_GREEN_SHIFT = 5;

/** Bit shift for blue channel in RGB15 format */
export const RGB15_BLUE_SHIFT = 10;

/** Bit shift for expanding 5-bit to 8-bit (left shift) */
export const RGB5_TO_8_LEFT_SHIFT = 3;

/** Bit shift for expanding 5-bit to 8-bit (right shift for replication) */
export const RGB5_TO_8_RIGHT_SHIFT = 2;

/** Maximum 8-bit color value */
export const MAX_8BIT = 255;

/** LUT size for 8-bit color operations (256 entries) */
export const LUT_SIZE_8BIT = 256;

/** Default gamma correction value (no change) */
export const DEFAULT_GAMMA = 1.0;

// ITU-R BT.601 luminance coefficients

/** Red luminance coefficient for grayscale conversion */
export const LUMINANCE_R = 0.299;

/** Green luminance coefficient for grayscale conversion */
export const LUMINANCE_G = 0.587;

/** Blue luminance coefficient for grayscale conversion */
export const LUMINANCE_B = 0.114;
