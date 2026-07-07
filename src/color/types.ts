import type { Rect } from '../dirtyRect/index.ts';
import type { ColorSpace, FrameBuffer } from '../types.ts';

/** Narrows a framebuffer to Uint16Array when colorSpace is 'rgb15' */
export const isRgb15Buffer = (
  colorSpace: ColorSpace,
  _buffer: FrameBuffer,
): _buffer is Uint16Array => colorSpace === 'rgb15';

/** LUT pair for gamma-correct averaging (see getLinearLightLUTs) */
export interface LinearLightLUTs {
  /** sRGB byte to 16-bit linear light, one entry per byte value */
  toLinear: Uint16Array;
  /** 16-bit linear light back to an sRGB byte, one entry per linear value */
  toSrgb: Uint8Array;
}

/** Options for convertFrameToRgb24 */
export interface FrameToRgb24Options {
  /** Pixel format of the source framebuffer */
  colorSpace: ColorSpace;
  /** Source width in pixels */
  width: number;
  /** Source height in pixels */
  height: number;
  /** 256-entry gamma lookup table (see buildGammaLUT) */
  gammaLUT: Uint8Array;
  /** True when gammaLUT is an identity mapping, enabling the copy fast path */
  hasIdentityGamma: boolean;
  /** When false, output is grayscale */
  colorEnabled: boolean;
  /**
   * Region to convert (undefined = full frame). Pixels outside the rect are
   * left untouched in dst, so callers converting successive frames into the
   * same buffer keep earlier results for unchanged pixels.
   */
  rect?: Rect;
}

/** One entry in the emoji-square render palette: an emoji glyph and its RGB */
export interface EmojiColor {
  emoji: string;
  rgb: [number, number, number];
}
