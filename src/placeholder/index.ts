import {
  BYTE_MASK,
  IMAGE_ID_GREEN_SHIFT,
  IMAGE_ID_MSB_SHIFT,
  IMAGE_ID_RED_SHIFT,
  PLACEHOLDER_CHAR,
  ROWCOLUMN_DIACRITICS,
  SGR_FG_RESET,
} from './consts.ts';
import { PlaceholderError } from './types.ts';

export * from './consts.ts';
export * from './types.ts';

/**
 * Foreground SGR carrying the low 24 bits of a Kitty image id, as a truecolor
 * color. Placeholder cells use this to say which image they belong to.
 */
export const encodeImageIdFg = (imageId: number): string => {
  const r = (imageId >> IMAGE_ID_RED_SHIFT) & BYTE_MASK;
  const g = (imageId >> IMAGE_ID_GREEN_SHIFT) & BYTE_MASK;
  const b = imageId & BYTE_MASK;
  return `\x1b[38;2;${r};${g};${b}m`;
};

/**
 * Build the placeholder text for a cols x rows grid displaying image `imageId`.
 * Returns one string per grid row, each `cols` cells wide (each cell measures
 * as one column: the placeholder char is width 1 and the diacritics are
 * zero-width combining marks). The host renders one row per line (e.g. one Ink
 * <Text> per string). Uses the fully-specified form: every cell carries its own
 * row and column diacritic (robust across terminals, no reliance on column
 * auto-increment). The image id's low 24 bits ride in the foreground color; its
 * most-significant byte, when nonzero, is appended as a third diacritic on each
 * cell. Throws PlaceholderError('GRID_TOO_LARGE') if cols or rows exceed the
 * diacritics table (297).
 */
export const buildPlaceholderRows = (imageId: number, cols: number, rows: number): string[] => {
  if (cols > ROWCOLUMN_DIACRITICS.length || rows > ROWCOLUMN_DIACRITICS.length) {
    throw new PlaceholderError(
      'GRID_TOO_LARGE',
      `Grid ${cols}x${rows} exceeds the ${ROWCOLUMN_DIACRITICS.length}-entry diacritics table`,
    );
  }

  const msbByte = (imageId >>> IMAGE_ID_MSB_SHIFT) & BYTE_MASK;
  const msbDiacritic = msbByte === 0 ? '' : String.fromCodePoint(ROWCOLUMN_DIACRITICS[msbByte]);
  const idFg = encodeImageIdFg(imageId);

  const result: string[] = [];
  for (let rr = 0; rr < rows; rr++) {
    const rowDiacritic = String.fromCodePoint(ROWCOLUMN_DIACRITICS[rr]);
    let row = idFg;
    for (let cc = 0; cc < cols; cc++) {
      row +=
        PLACEHOLDER_CHAR + rowDiacritic + String.fromCodePoint(ROWCOLUMN_DIACRITICS[cc]) + msbDiacritic;
    }
    row += SGR_FG_RESET;
    result.push(row);
  }
  return result;
};
