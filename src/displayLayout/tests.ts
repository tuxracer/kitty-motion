import { describe, expect, it } from 'vitest';
import { computeDisplayLayout } from './index.ts';

describe('computeDisplayLayout', () => {
  it('returns a positive grid with 1-based offsets', () => {
    const layout = computeDisplayLayout({
      sourceWidth: 256,
      sourceHeight: 240,
      pixelAspectRatio: 1.0,
      reservedRows: 0,
    });
    expect(layout.cols).toBeGreaterThan(0);
    expect(layout.rows).toBeGreaterThan(0);
    expect(layout.offsetCol).toBeGreaterThanOrEqual(1);
    expect(layout.offsetRow).toBeGreaterThanOrEqual(1);
  });

  it('reserving rows never enlarges the grid', () => {
    const base = computeDisplayLayout({ sourceWidth: 256, sourceHeight: 240, pixelAspectRatio: 1.0, reservedRows: 0 });
    const reserved = computeDisplayLayout({ sourceWidth: 256, sourceHeight: 240, pixelAspectRatio: 1.0, reservedRows: 4 });
    expect(reserved.rows).toBeLessThanOrEqual(base.rows);
  });

  it('keeps a columnsPerCell=2 grid inside the terminal and matches default at 1', () => {
    const opts = { sourceWidth: 256, sourceHeight: 240, pixelAspectRatio: 1.0, reservedRows: 0 };
    const base = computeDisplayLayout(opts);
    const one = computeDisplayLayout({ ...opts, columnsPerCell: 1 });
    const wide = computeDisplayLayout({ ...opts, columnsPerCell: 2 });

    // columnsPerCell=1 is identical to omitting it
    expect(one).toEqual(base);
    // The double-wide grid spans cols*2 columns and must fit an 80-col terminal
    expect(wide.cols * 2).toBeLessThanOrEqual(80);
    // Fewer, wider cells than the 1-column layout
    expect(wide.cols).toBeLessThan(base.cols);
    expect(wide.offsetCol).toBeGreaterThanOrEqual(1);
    expect(wide.rows).toBeGreaterThan(0);
  });

  describe('region', () => {
    const source = { sourceWidth: 256, sourceHeight: 240, pixelAspectRatio: 1.0, reservedRows: 0 };
    const region = { offsetCol: 10, offsetRow: 5, cols: 40, rows: 12 };

    it('fits the grid inside the region and places it at or past the region origin', () => {
      const layout = computeDisplayLayout({ ...source, region });

      expect(layout.cols).toBeGreaterThan(0);
      expect(layout.rows).toBeGreaterThan(0);
      // Grid stays within the region box on both axes.
      expect(layout.cols).toBeLessThanOrEqual(region.cols);
      expect(layout.rows).toBeLessThanOrEqual(region.rows);
      // Placement starts at or after the region origin, never at the terminal's.
      expect(layout.offsetCol).toBeGreaterThanOrEqual(region.offsetCol);
      expect(layout.offsetRow).toBeGreaterThanOrEqual(region.offsetRow);
      // The whole grid stays inside the region's right and bottom edges.
      expect(layout.offsetCol + layout.cols).toBeLessThanOrEqual(region.offsetCol + region.cols);
      expect(layout.offsetRow + layout.rows).toBeLessThanOrEqual(region.offsetRow + region.rows);
    });

    it('centers within the region so its origin is the base, not 1', () => {
      const atOrigin = computeDisplayLayout({
        ...source,
        region: { offsetCol: 1, offsetRow: 1, cols: region.cols, rows: region.rows },
      });
      const shifted = computeDisplayLayout({ ...source, region });

      // Same-sized region, so the same grid, just translated by the origin delta.
      expect(shifted.cols).toBe(atOrigin.cols);
      expect(shifted.rows).toBe(atOrigin.rows);
      expect(shifted.offsetCol - atOrigin.offsetCol).toBe(region.offsetCol - 1);
      expect(shifted.offsetRow - atOrigin.offsetRow).toBe(region.offsetRow - 1);
    });

    it('ignores reservedRows inside a region', () => {
      const noReserve = computeDisplayLayout({ ...source, region });
      const reserved = computeDisplayLayout({ ...source, reservedRows: 6, region });
      expect(reserved).toEqual(noReserve);
    });

    it('keeps a columnsPerCell=2 grid within the region columns', () => {
      const wide = computeDisplayLayout({ ...source, columnsPerCell: 2, region });
      expect(wide.cols).toBeGreaterThan(0);
      expect(wide.cols * 2).toBeLessThanOrEqual(region.cols);
      expect(wide.offsetCol).toBeGreaterThanOrEqual(region.offsetCol);
      expect(wide.offsetCol + wide.cols * 2).toBeLessThanOrEqual(region.offsetCol + region.cols);
    });
  });
});
