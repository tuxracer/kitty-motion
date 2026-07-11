import type { EffectOptions } from '../postProcessing/index.ts';
import type { DrainableStream } from '../OutputGate/index.ts';
import type { WorkerFactory } from '../kittyEncodeWorkerClient/index.ts';
import type { CellSampling, ColorDepth, ColorSpace, KittyCompression, RenderMode, ScreenRegion } from '../types.ts';

export interface ScreenUpdatableOptions extends EffectOptions {
  /** Internal render scale (0.25-4x); higher values increase PNG quantization fidelity at the cost of CPU (default: `2`) */
  scale?: number;
  /** Source pixel aspect ratio (e.g. `8/7` for NES-style non-square pixels); combined with the terminal's real cell pixel size for font-independent aspect correction (default: `1.0`) */
  pixelAspectRatio?: number;
  /** Terminal rows to exclude from the display area (e.g. for a status line) (default: `0`) */
  reservedRows?: number;
  /** Deflate level (1-9), applied only when the resolved payload format is PNG (the inline default and the file-write fallback, or a forced compression: "png"). See docs/TRD.md Design notes for the benchmark behind this default (default: 5) */
  pngCompressionLevel?: number;
  /** When `false`, renders in grayscale (default: `true`) */
  colorEnabled?: boolean;
  /** Skip re-encoding frames that are pixel-identical to the previous frame (default: `true`) */
  enableDiffRendering?: boolean;
  /** Delta frames (a=f frame edits). undefined enables them only when detectKittyAnimationSupport() passed AND the file medium is unavailable (deltas save PTY bytes but cost kitty a full-frame disk round trip per edit, so they only pay off over SSH). true/false overrides. Deltas still require enableDiffRendering and an integer scale of 1 or more (default: undefined) */
  dirtyRects?: boolean;
  /** File-based transmission (t=t): undefined follows detectKittyFileTransferSupport(), true/false forces (default: undefined) */
  fileTransfer?: boolean;
  /** Kitty payload format override: "png" (f=100), "zlib" (deflate-compressed raw pixels, f=24 with o=z), or "none" (raw pixels, f=24). Applies on both mediums and in the file-write fallback. Undefined picks per medium: raw pixels on the file medium, PNG inline (default: undefined) */
  compression?: KittyCompression;
  /** Renderer selection. undefined follows the cached graphics probe (getKittyGraphicsSupported() === false auto-detects the cell mode from TERM_PROGRAM, true or null selects kitty). "kitty" forces the graphics protocol. "half-block" and "cell-background" force the block-glyph renderer (2 pixels per cell via U+2580, or 1 pixel per cell via background-colored spaces). "emoji" renders one emoji square per cell by nearest color. "ascii" renders one printable ASCII glyph per cell chosen by nearest shape (default: undefined) */
  renderMode?: RenderMode;
  /** Cell-mode SGR color depth: 0 = truecolor, 256, or 16; undefined auto-detects from COLORTERM/TERM (default: undefined) */
  limitColors?: ColorDepth;
  /** Cell-mode downsampling strategy. "box" averages each cell's source region in linear light (smooth), "nearest" copies the region's center pixel so hard-edged content stays solid. In ascii mode "nearest" caps the samples per cell so cost stays flat as source resolution grows, while "box" averages the full footprint (the two match on small sources). undefined defaults to "nearest" (default: undefined) */
  cellSampling?: CellSampling;
  /** Confine output to a fixed sub-region of the terminal (1-based cell coords) instead of centering on the whole terminal; pair with `embedded` to render a video panel inside a host TUI (default: undefined) */
  region?: ScreenRegion;
  /** Share the terminal with a host TUI: non-destructive output (no full-screen clear, no global cursor hide/show, deletes only this Screen's own images/cells) and, unless set explicitly, disables autoResize and autoDispose so the host owns resize and teardown (default: false) */
  embedded?: boolean;
  /** Kitty placement mode. "cursor" (default) displays the image at a cursor position. "unicode" transmits a virtual placement for host-rendered Unicode placeholder cells (Kitty/Ghostty), so a TUI framework like Ink owns layout; read the cells with getPlaceholderRows(). Ignored on the cell-glyph fallback (default: "cursor") */
  placement?: 'cursor' | 'unicode';
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
