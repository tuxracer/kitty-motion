import type { EffectOptions, PostProcessingPipeline } from '../postProcessing/index.ts';
import type { ColorSpace, FrameBuffer, ScreenRegion } from '../types.ts';

/** Options shared by KittyRendererOptions and CellRendererOptions */
export interface RendererOptionsBase extends EffectOptions {
  /** Source framebuffer width (default: 256) */
  sourceWidth?: number;
  /** Source framebuffer height (default: 240) */
  sourceHeight?: number;
  /** Color format (default: rgb24) */
  colorSpace?: ColorSpace;
  /** Pixel aspect ratio for correct display (default: 1.0) */
  pixelAspectRatio?: number;
  /** Enable diff-based rendering optimization (default: true) */
  enableDiffRendering?: boolean;
  /** When false, render in grayscale (default: true) */
  colorEnabled?: boolean;
  /** Rows to reserve outside the display area, e.g. for a status line (default: 0) */
  reservedRows?: number;
  /** Confine output to a fixed sub-region of the terminal (1-based cell coords) instead of centering on the whole terminal; enables embedding a panel in a host TUI (default: undefined, full terminal) */
  region?: ScreenRegion;
  /** Non-destructive output for sharing the terminal with a host TUI: skip the full-screen clear and global cursor toggles, and delete only this renderer's own images/cells (default: false) */
  embedded?: boolean;
  /** Optional sink for internal diagnostic messages */
  onDebug?: (message: string) => void;
}

/** Shared renderer state derived from RendererOptionsBase (see resolveRendererOptions) */
export interface ResolvedRendererOptions {
  sourceWidth: number;
  sourceHeight: number;
  colorSpace: ColorSpace;
  pixelAspectRatio: number;
  enableDiffRendering: boolean;
  colorEnabled: boolean;
  reservedRows: number;
  /** Confine output to a fixed sub-region of the terminal (1-based cell coords) instead of centering on the whole terminal; enables embedding a panel in a host TUI (default: undefined, full terminal) */
  region?: ScreenRegion;
  /** Non-destructive output for sharing the terminal with a host TUI: skip the full-screen clear and global cursor toggles, and delete only this renderer's own images/cells (default: false) */
  embedded: boolean;
  onDebug?: (message: string) => void;
  /** 256-entry gamma table for frame conversion */
  gammaLUT: Uint8Array;
  /** True when gamma is 1.0 and the LUT is an identity mapping */
  hasIdentityGamma: boolean;
  postProcessing: PostProcessingPipeline;
  /** Previous-frame diff state, sized for the color space */
  prevFrameBuffer: FrameBuffer;
  /** Native-resolution RGB working buffer for conversion and post-processing */
  nativeRgbBuffer: Uint8Array;
}
