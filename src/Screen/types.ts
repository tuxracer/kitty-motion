import type { EffectOptions } from '../postProcessing/index.ts';
import type { DrainableStream } from '../OutputGate/index.ts';
import type { WorkerFactory } from '../kittyEncodeWorkerClient/index.ts';
import type { CellSampling, ColorDepth, ColorSpace, RenderMode } from '../types.ts';

export interface ScreenUpdatableOptions extends EffectOptions {
  /** Internal render scale (0.25-4x); higher values increase PNG quantization fidelity at the cost of CPU (default: `2`) */
  scale?: number;
  /** Source pixel aspect ratio (e.g. `8/7` for NES-style non-square pixels); combined with the terminal's real cell pixel size for font-independent aspect correction (default: `1.0`) */
  pixelAspectRatio?: number;
  /** Terminal rows to exclude from the display area (e.g. for a status line) (default: `0`) */
  reservedRows?: number;
  /** Deflate level (1-9); see docs/TRD.md Design notes for the benchmark behind this default (default: `5`) */
  pngCompressionLevel?: number;
  /** When `false`, renders in grayscale (default: `true`) */
  colorEnabled?: boolean;
  /** Skip re-encoding frames that are pixel-identical to the previous frame (default: `true`) */
  enableDiffRendering?: boolean;
  /** Delta frames on terminals the probe rejected or never checked: undefined follows detectKittyAnimationSupport(), true/false overrides the probe; deltas still require enableDiffRendering and an integer scale of 1 or more (default: undefined) */
  dirtyRects?: boolean;
  /** File-based transmission (t=t): undefined follows detectKittyFileTransferSupport(), true/false forces (default: undefined) */
  fileTransfer?: boolean;
  /** Renderer selection. undefined follows the cached graphics probe (getKittyGraphicsSupported() === false auto-detects the cell mode from TERM_PROGRAM, true or null selects kitty). "kitty" forces the graphics protocol. "half-block" and "cell-background" force the block-glyph renderer (2 pixels per cell via U+2580, or 1 pixel per cell via background-colored spaces) (default: undefined) */
  renderMode?: RenderMode;
  /** Cell-mode SGR color depth: 0 = truecolor, 256, or 16; undefined auto-detects from COLORTERM/TERM (default: undefined) */
  limitColors?: ColorDepth;
  /** Cell-mode downsampling strategy. "box" averages each cell's source region in linear light (smooth), "nearest" copies the region's center pixel so hard-edged content stays solid. undefined auto-detects from TERM_PROGRAM (default: undefined) */
  cellSampling?: CellSampling;
}

export interface ScreenOptions extends ScreenUpdatableOptions {
  /** Width of the source framebuffer in pixels (required) */
  sourceWidth: number;
  /** Height of the source framebuffer in pixels (required) */
  sourceHeight: number;
  /** Writable sink for encoded frames, typically `process.stdout` (required) */
  output: DrainableStream;
  /** Pixel format of frames passed to `pushFrame` (default: `"rgb24"`) */
  colorSpace?: ColorSpace;
  /** Recompute display size and centering on terminal resize via a process SIGWINCH listener, removed on dispose(); set `false` to call handleResize() yourself (default: `true`) */
  autoResize?: boolean;
  /** Dispose on process exit and on SIGINT/SIGTERM/SIGHUP, restoring the cursor and clearing the image. When the process has its own handler for one of those signals, that handler keeps control and disposal happens via the exit hook instead. Set `false` to call dispose() yourself (default: `true`) */
  autoDispose?: boolean;
  /** Override worker creation (tests, embedding) (default: real worker) */
  workerFactory?: WorkerFactory;
  /** Optional sink for internal diagnostic messages (default: none) */
  onDebug?: (message: string) => void;
}
