/**
 * Utility for calculating display dimensions that fit within available
 * terminal space while maintaining a given aspect ratio.
 */

import { MIN_DISPLAY_COLS, MIN_DISPLAY_ROWS } from '../consts';

interface FitToTerminalOptions {
  availableCols: number;
  availableRows: number;
  aspectRatio: number;
  requestedWidth?: number;
  requestedHeight?: number;
}

interface DisplaySize {
  width: number;
  height: number;
}

/**
 * Calculate the largest display dimensions that fit within the available
 * terminal space while maintaining the given aspect ratio.
 *
 * When both requestedWidth and requestedHeight are provided, they are used as-is.
 * When only one is provided, the other is computed from the aspect ratio.
 * When neither is provided, the display auto-fits to fill available space.
 */
export const fitToTerminal = ({
  availableCols,
  availableRows,
  aspectRatio,
  requestedWidth,
  requestedHeight,
}: FitToTerminalOptions): DisplaySize => {
  let width: number;
  let height: number;

  if (requestedWidth !== undefined && requestedHeight !== undefined) {
    width = requestedWidth;
    height = requestedHeight;
  } else if (requestedWidth !== undefined) {
    width = Math.min(requestedWidth, availableCols);
    height = Math.floor(width / aspectRatio);
  } else if (requestedHeight !== undefined) {
    height = Math.min(requestedHeight, availableRows);
    width = Math.floor(height * aspectRatio);
  } else {
    // Auto-fit: start from available height, compute width
    height = availableRows;
    width = Math.floor(height * aspectRatio);

    // If computed width exceeds available cols, scale down from width
    if (width > availableCols) {
      width = availableCols;
      height = Math.floor(width / aspectRatio);
    }
  }

  // Clamp to min/max bounds
  width = Math.max(width, MIN_DISPLAY_COLS);
  height = Math.max(height, MIN_DISPLAY_ROWS);
  width = Math.min(width, availableCols);
  height = Math.min(height, availableRows);

  return { width, height };
};
