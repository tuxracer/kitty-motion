import { describe, expect, it } from 'vitest';
import { fitToTerminal } from './index.ts';

describe('fitToTerminal', () => {
  it('auto-fits height-first, then clamps to width', () => {
    const size = fitToTerminal({ availableCols: 80, availableRows: 24, aspectRatio: 2.438 });
    expect(size.height).toBe(24);
    expect(size.width).toBe(Math.floor(24 * 2.438));
  });

  it('scales down when width would overflow', () => {
    const size = fitToTerminal({ availableCols: 40, availableRows: 24, aspectRatio: 2.438 });
    expect(size.width).toBe(40);
    expect(size.height).toBe(Math.floor(40 / 2.438));
  });
});
