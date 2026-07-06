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
}: DisplayLayoutOptions): DisplayLayout => {
  const { width: termCols, height: termRows } = getTerminalDimensions();
  const availableRows = termRows - reservedRows;
  const availableCols = termCols;

  const measuredCell = getCellPixelSize();
  const cellWidthPx = measuredCell ? measuredCell.width : CELL_WIDTH_PX;
  const cellHeightPx = measuredCell ? measuredCell.height : CELL_HEIGHT_PX;

  const aspectRatio = kittyGridAspectRatio(
    sourceWidth,
    sourceHeight,
    pixelAspectRatio,
    cellWidthPx,
    cellHeightPx,
  );

  const { width: cols, height: rows } = fitToTerminal({
    availableCols,
    availableRows,
    aspectRatio,
  });

  const offsetCol = Math.max(1, Math.floor((termCols - cols) / 2) + 1);
  const offsetRow = Math.max(1, Math.floor((availableRows - rows) / 2) + 1);

  return { cols, rows, offsetCol, offsetRow };
};
