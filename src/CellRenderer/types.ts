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
  /** Cell render mode. "half-block" packs 2 pixels per cell using U+2580 with fg+bg, "cell-background" packs 1 pixel per cell as a space with bg only, "emoji" packs 1 pixel per cell as the nearest of nine emoji squares (no SGR, double-wide), "ascii" draws each cell as the printable ASCII glyph whose shape best matches its 6-region luminance vector, colorized via an SGR foreground. undefined auto-detects from TERM_PROGRAM (default: undefined) */
  renderMode?: CellRenderMode;
  /** Cell downsampling strategy. "box" averages each cell's source region in linear light (smooth), "nearest" copies the region's center pixel so hard-edged content stays solid. In ascii mode "box" averages the full cell footprint per region while "nearest" caps the samples per region so cost stays flat as source resolution grows (a footprint smaller than the caps is read in full, so the two match on small sources). undefined defaults to "nearest" (default: undefined) */
  cellSampling?: CellSampling;
  /** Fixed grid and offset; undefined auto-fits to the terminal (default: undefined) */
  layout?: CellLayout;
}
