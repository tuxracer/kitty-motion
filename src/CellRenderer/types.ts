import type { CellRenderMode, CellSampling, ColorDepth } from '../types.ts';
import type { RendererOptionsBase } from '../rendererOptions/index.ts';

/**
 * Half-open cell-grid bounds of the region a frame's changes affect:
 * columns [cellX0, cellX1) and rows [cellY0, cellY1). Downsampling and cell
 * mapping only run inside these bounds.
 */
export interface CellBounds {
  cellX0: number;
  cellX1: number;
  cellY0: number;
  cellY1: number;
}

/** A fixed cell grid and 1-based screen offset (bypasses terminal auto-fit) */
export interface CellLayout {
  cols: number;
  rows: number;
  offsetCol: number;
  offsetRow: number;
}

export interface CellRendererOptions extends RendererOptionsBase {
  /** SGR color depth: 0 = truecolor, 256, or 16; undefined auto-detects from COLORTERM/TERM (default: undefined) */
  limitColors?: ColorDepth;
  /** Cell render mode. "half-block" packs 2 pixels per cell using U+2580 with fg+bg, "cell-background" packs 1 pixel per cell as a space with bg only (no seams on Terminal.app). undefined auto-detects from TERM_PROGRAM (default: undefined) */
  renderMode?: CellRenderMode;
  /** Cell downsampling strategy. "box" averages each cell's source region in linear light (smooth), "nearest" copies the region's center pixel so hard-edged content stays solid. undefined auto-detects from TERM_PROGRAM (default: undefined) */
  cellSampling?: CellSampling;
  /** Fixed grid and offset; undefined auto-fits to the terminal (default: undefined) */
  layout?: CellLayout;
}
