import { getTerminalDimensions, getCellPixelSize } from '../terminal/index.ts';
import { kittyGridAspectRatio } from '../aspect/index.ts';
import { fitToTerminal } from '../fitToTerminal/index.ts';
import { CELL_WIDTH_PX, CELL_HEIGHT_PX } from './consts.ts';
import type { DisplayLayout, DisplayLayoutOptions } from './types.ts';

export * from './consts.ts';
export * from './types.ts';

/**
 * Compute the centered cell grid that displays a source framebuffer at the
 * correct on-screen aspect ratio. Uses the terminal's measured cell pixel
 * size when available (font-independent aspect correction), falling back to
 * a typical cell ratio.
 */
export const computeDisplayLayout = ({
  sourceWidth,
  sourceHeight,
  pixelAspectRatio,
  reservedRows,
  columnsPerCell = 1,
  region,
}: DisplayLayoutOptions): DisplayLayout => {
  const { width: termCols, height: termRows } = getTerminalDimensions();
  // Region confines output to a sub-rectangle; otherwise use the whole terminal
  // (minus reserved rows). reservedRows is ignored inside a region because the
  // host already carved out the box.
  const areaCols = region ? region.cols : termCols;
  const areaRows = region ? region.rows : termRows - reservedRows;
  const baseCol = region ? region.offsetCol : 1;
  const baseRow = region ? region.offsetRow : 1;

  const measuredCell = getCellPixelSize();
  const cellWidthPx = measuredCell ? measuredCell.width : CELL_WIDTH_PX;
  const cellHeightPx = measuredCell ? measuredCell.height : CELL_HEIGHT_PX;

  // Each cell occupies columnsPerCell terminal columns, so it is that many
  // times wider on screen. Widen the aspect cell width to match and cap the
  // fit to how many such cells fit across the area.
  const availableCellCols = Math.floor(areaCols / columnsPerCell);
  const aspectRatio = kittyGridAspectRatio(
    sourceWidth,
    sourceHeight,
    pixelAspectRatio,
    cellWidthPx * columnsPerCell,
    cellHeightPx,
  );

  const { width: cols, height: rows } = fitToTerminal({
    availableCols: availableCellCols,
    availableRows: areaRows,
    aspectRatio,
  });

  const offsetCol = baseCol + Math.max(0, Math.floor((areaCols - cols * columnsPerCell) / 2));
  const offsetRow = baseRow + Math.max(0, Math.floor((areaRows - rows) / 2));

  return { cols, rows, offsetCol, offsetRow };
};
