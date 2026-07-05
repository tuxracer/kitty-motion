import { describe, it, expect } from 'vitest';
import { parseCellPixelSize } from '.';

const grid = { cols: 80, rows: 24 };

describe('parseCellPixelSize', () => {
  it('parses a CSI 16 t reply (cell size in pixels) directly', () => {
    // Response format: ESC [ 6 ; height ; width t
    expect(parseCellPixelSize('\x1b[6;18;7t', grid)).toEqual({ width: 7, height: 18 });
  });

  it('parses a CSI 16 t reply for a normal-width font', () => {
    expect(parseCellPixelSize('\x1b[6;18;9t', grid)).toEqual({ width: 9, height: 18 });
  });

  it('derives cell size from a CSI 14 t reply (text-area pixels / grid)', () => {
    // Response format: ESC [ 4 ; heightPx ; widthPx t
    // 80 cols x 24 rows over 560x432 px => 7 x 18 per cell
    expect(parseCellPixelSize('\x1b[4;432;560t', grid)).toEqual({ width: 7, height: 18 });
  });

  it('prefers the direct cell-size (code 6) reply when both are present', () => {
    const both = '\x1b[6;18;7t\x1b[4;432;560t';
    expect(parseCellPixelSize(both, grid)).toEqual({ width: 7, height: 18 });
  });

  it('returns null for an unrelated response', () => {
    expect(parseCellPixelSize('\x1b[?62;c', grid)).toBeNull();
  });

  it('returns null for zero or malformed dimensions', () => {
    expect(parseCellPixelSize('\x1b[6;0;0t', grid)).toBeNull();
    expect(parseCellPixelSize('', grid)).toBeNull();
  });
});
