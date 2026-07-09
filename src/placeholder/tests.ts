import { describe, expect, it } from 'vitest';

import {
  buildPlaceholderRows,
  encodeImageIdFg,
  isPlaceholderError,
  PLACEHOLDER_CHAR,
  ROWCOLUMN_DIACRITICS,
  SGR_FG_RESET,
} from './index.ts';

const countPlaceholders = (row: string): number =>
  [...row].filter((c) => c === PLACEHOLDER_CHAR).length;

describe('encodeImageIdFg', () => {
  it('encodes the low 24 bits as a truecolor foreground SGR', () => {
    expect(encodeImageIdFg(0x010203)).toBe('\x1b[38;2;1;2;3m');
  });

  it('ignores the most-significant byte of the id', () => {
    expect(encodeImageIdFg(42 + (2 << 24))).toBe('\x1b[38;2;0;0;42m');
  });
});

describe('buildPlaceholderRows', () => {
  it('returns one string per grid row', () => {
    expect(buildPlaceholderRows(1, 4, 3)).toHaveLength(3);
  });

  it('places exactly `cols` placeholder chars per row', () => {
    const rows = buildPlaceholderRows(1, 5, 2);
    for (const row of rows) {
      expect(countPlaceholders(row)).toBe(5);
    }
  });

  it('wraps each row in the id foreground and the foreground reset', () => {
    const imageId = 7;
    const rows = buildPlaceholderRows(imageId, 3, 2);
    for (const row of rows) {
      expect(row.startsWith(encodeImageIdFg(imageId))).toBe(true);
      expect(row.endsWith(SGR_FG_RESET)).toBe(true);
    }
  });

  it('carries the row diacritic and per-column diacritic on each cell', () => {
    const cols = 4;
    const rows = buildPlaceholderRows(1, cols, 3);
    rows.forEach((row, rr) => {
      // Strip the leading fg SGR and trailing reset, then walk the cells.
      const body = row.slice(encodeImageIdFg(1).length, row.length - SGR_FG_RESET.length);
      const codePoints = [...body];
      // Each cell is: placeholder char, row diacritic, column diacritic.
      for (let cc = 0; cc < cols; cc++) {
        const base = cc * 3;
        expect(codePoints[base]).toBe(PLACEHOLDER_CHAR);
        expect(codePoints[base + 1]).toBe(String.fromCodePoint(ROWCOLUMN_DIACRITICS[rr]));
        expect(codePoints[base + 2]).toBe(String.fromCodePoint(ROWCOLUMN_DIACRITICS[cc]));
      }
    });
  });

  it('first cell of row `rr` uses diacritic rr then column diacritic 0', () => {
    const rows = buildPlaceholderRows(1, 2, 3);
    rows.forEach((row, rr) => {
      const body = row.slice(encodeImageIdFg(1).length, row.length - SGR_FG_RESET.length);
      const codePoints = [...body];
      expect(codePoints[0]).toBe(PLACEHOLDER_CHAR);
      expect(codePoints[1]).toBe(String.fromCodePoint(ROWCOLUMN_DIACRITICS[rr]));
      expect(codePoints[2]).toBe(String.fromCodePoint(ROWCOLUMN_DIACRITICS[0]));
    });
  });

  it('appends the MSB diacritic and encodes the low bits when the MSB is nonzero', () => {
    const imageId = 42 + (2 << 24);
    const rows = buildPlaceholderRows(imageId, 2, 1);
    const row = rows[0];
    expect(row.startsWith('\x1b[38;2;0;0;42m')).toBe(true);
    // Each cell is 4 code points: char, row diacritic, col diacritic, msb diacritic.
    const body = row.slice('\x1b[38;2;0;0;42m'.length, row.length - SGR_FG_RESET.length);
    const codePoints = [...body];
    const msbDiacritic = String.fromCodePoint(ROWCOLUMN_DIACRITICS[2]);
    expect(codePoints[3]).toBe(msbDiacritic);
    expect(codePoints[7]).toBe(msbDiacritic);
    expect(codePoints).toHaveLength(8);
  });

  it('omits the third diacritic for ids with a zero MSB', () => {
    const rows = buildPlaceholderRows(1, 3, 1);
    const body = rows[0].slice(encodeImageIdFg(1).length, rows[0].length - SGR_FG_RESET.length);
    // 3 cells x 3 code points each (char, row, col), no MSB diacritic.
    expect([...body]).toHaveLength(9);
  });

  it('throws GRID_TOO_LARGE when cols exceed the diacritics table', () => {
    try {
      buildPlaceholderRows(1, ROWCOLUMN_DIACRITICS.length + 1, 1);
      expect.unreachable('expected buildPlaceholderRows to throw');
    } catch (error) {
      expect(isPlaceholderError(error)).toBe(true);
      if (isPlaceholderError(error)) {
        expect(error.code).toBe('GRID_TOO_LARGE');
      }
    }
  });

  it('throws GRID_TOO_LARGE when rows exceed the diacritics table', () => {
    try {
      buildPlaceholderRows(1, 1, ROWCOLUMN_DIACRITICS.length + 1);
      expect.unreachable('expected buildPlaceholderRows to throw');
    } catch (error) {
      expect(isPlaceholderError(error)).toBe(true);
      if (isPlaceholderError(error)) {
        expect(error.code).toBe('GRID_TOO_LARGE');
      }
    }
  });

  it('allows a grid exactly the size of the diacritics table', () => {
    const max = ROWCOLUMN_DIACRITICS.length;
    expect(() => buildPlaceholderRows(1, max, 1)).not.toThrow();
  });
});
