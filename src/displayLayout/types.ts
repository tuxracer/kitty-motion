export interface DisplayLayoutOptions {
  /** Source framebuffer width in pixels */
  sourceWidth: number;
  /** Source framebuffer height in pixels */
  sourceHeight: number;
  /** Source pixel aspect ratio (e.g. 8/7 for NES) */
  pixelAspectRatio: number;
  /** Terminal rows excluded from the display area (e.g. a status line) */
  reservedRows: number;
  /** Terminal columns each cell occupies (1 normally, 2 for double-wide emoji cells) (default: 1) */
  columnsPerCell?: number;
}

/** A centered cell-grid placement; offsets are 1-based for ANSI sequences */
export interface DisplayLayout {
  cols: number;
  rows: number;
  offsetCol: number;
  offsetRow: number;
}
