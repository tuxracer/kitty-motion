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
});
