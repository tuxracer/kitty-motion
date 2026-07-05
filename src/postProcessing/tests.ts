import { describe, expect, it } from 'vitest';
import { PostProcessingPipeline } from '.';

const makeFrame = (w: number, h: number): Uint8Array => {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < rgb.length; i++) {rgb[i] = (i * 37) % 256;}
  return rgb;
};

describe('PostProcessingPipeline', () => {
  it('is a no-op when no effects are configured', () => {
    const rgb = makeFrame(16, 16);
    const before = new Uint8Array(rgb);
    new PostProcessingPipeline({}).apply(rgb, 16, 16);
    expect(rgb).toEqual(before);
  });

  it('scanlines darken alternating rows', () => {
    const w = 8, h = 8;
    const rgb = new Uint8Array(w * h * 3).fill(200);
    new PostProcessingPipeline({ scanlines: 0.5 }).apply(rgb, w, h);
    const row0 = rgb[0];
    const row1 = rgb[w * 3];
    expect(row0).not.toBe(row1); // one of the rows is darkened
    // Odd rows (y=1,3,5,...) are the ones darkened; even rows (including row 0)
    // are left untouched. Verified against emoemu's applyScanlines/
    // applyScanlinesAndVignette, which loop `for (let y = 1; y < height; y += 2)`.
    expect(row0).toBe(200);
    expect(row1).toBe(100); // (200 * ((1 - 0.5) * 256 | 0)) >> 8 = (200 * 128) >> 8 = 100
  });

  it('is deterministic across two identical frames', () => {
    const pipeline = new PostProcessingPipeline({ vignette: 0.4, scanlines: 0.3 });
    const a = makeFrame(12, 12);
    const b = makeFrame(12, 12);
    pipeline.apply(a, 12, 12);
    pipeline.apply(b, 12, 12);
    expect(a).toEqual(b);
  });
});
