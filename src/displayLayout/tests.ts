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
});
