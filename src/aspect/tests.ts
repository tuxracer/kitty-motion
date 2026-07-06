import { describe, expect, it } from 'vitest';
import { kittyGridAspectRatio } from './index.ts';

describe('kittyGridAspectRatio', () => {
  it('matches the NES example from the docs (256x240, 8/7 PAR, 9x18 cell)', () => {
    expect(kittyGridAspectRatio(256, 240, 8 / 7, 9, 18)).toBeCloseTo(2.438, 3);
  });

  it('is independent of uniform cell scaling', () => {
    const a = kittyGridAspectRatio(240, 160, 1, 9, 18);
    const b = kittyGridAspectRatio(240, 160, 1, 18, 36);
    expect(a).toBeCloseTo(b, 10);
  });
});
