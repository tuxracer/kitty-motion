/**
 * Compute the terminal cell-grid aspect ratio (cols per row) needed to display
 * a source framebuffer at the correct on-screen aspect ratio.
 *
 * Kitty scales the image to exactly fill `cols x rows` cells, so the on-screen
 * aspect is (cols * cellWidthPx) / (rows * cellHeightPx). To make that equal the
 * source display aspect (sourceWidth * PAR / sourceHeight), we need:
 *   cols / rows = (sourceWidth * PAR / sourceHeight) * (cellHeightPx / cellWidthPx)
 *
 * Because the real cell pixel size is factored in, the resulting on-screen aspect
 * is independent of the user's font width.
 */
export const kittyGridAspectRatio = (
  sourceWidth: number,
  sourceHeight: number,
  pixelAspectRatio: number,
  cellWidthPx: number,
  cellHeightPx: number
): number => (sourceWidth * pixelAspectRatio * cellHeightPx) / (sourceHeight * cellWidthPx);
