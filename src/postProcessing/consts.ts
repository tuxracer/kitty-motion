// Post-processing pipeline constants

// Integer BT.601 luminance coefficients (≈ 0.299*256, 0.587*256, 0.114*256)
// Used with >> 8 for fast integer luminance calculation
export const LUMA_R_INT = 77;
export const LUMA_G_INT = 150;
export const LUMA_B_INT = 29;

// NTSC YIQ color space conversion coefficients (scaled by 256 for fixed-point)
// RGB → I chroma: I = 0.596*R - 0.274*G - 0.322*B (×256)
export const YIQ_I_R = 153;
export const YIQ_I_G = 70;
export const YIQ_I_B = 82;
// RGB → Q chroma: Q = 0.211*R - 0.523*G + 0.312*B (×256)
export const YIQ_Q_R = 54;
export const YIQ_Q_G = 134;
export const YIQ_Q_B = 80;
// IQ → RGB inverse (×256): R = Y + 0.956*I + 0.621*Q, G = Y - 0.272*I - 0.647*Q, B = Y - 1.106*I + 1.703*Q
export const YIQ_INV_R_I = 245;
export const YIQ_INV_R_Q = 159;
export const YIQ_INV_G_I = 70;
export const YIQ_INV_G_Q = 166;
export const YIQ_INV_B_I = 283;
export const YIQ_INV_B_Q = 436;

// Effect tuning parameters

/** Default bloom brightness threshold */
export const DEFAULT_BLOOM_THRESHOLD = 0.6;

/** Scales user-facing curvature value to barrel distortion coefficient */
export const CURVATURE_INTENSITY_SCALE = 0.25;

/** Horizontal blur radius for NTSC chroma bleeding effect */
export const NTSC_CHROMA_BLUR_RADIUS = 5;

/** Blur kernel radius for bloom glow effect */
export const BLOOM_BLUR_RADIUS = 2;

/** Scales chromatic aberration intensity to max pixel offset at corners */
export const CHROMATIC_ABERRATION_OFFSET_SCALE = 3;
