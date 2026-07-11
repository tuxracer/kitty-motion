import { describe, expect, it } from 'vitest';
import { computeDirtyRect, unionRects, fullFrameRect, isFullFrameRect } from './index.ts';

const RGB = 3;

// 4x4 rgb24 frame filled with a constant value
const rgb24Frame = (fill: number): Uint8Array => new Uint8Array(4 * 4 * RGB).fill(fill);

describe('computeDirtyRect', () => {
  it('returns null for identical rgb24 buffers', () => {
    expect(computeDirtyRect(rgb24Frame(9), rgb24Frame(9), 4, 4, RGB)).toBeNull();
  });

  it('returns a 1x1 rect for a single changed rgb24 pixel', () => {
    const prev = rgb24Frame(9);
    const curr = rgb24Frame(9);
    curr[(2 * 4 + 1) * RGB + 1] = 200; // pixel (1,2), green channel
    expect(computeDirtyRect(curr, prev, 4, 4, RGB)).toEqual({ x: 1, y: 2, width: 1, height: 1 });
  });

  it('returns the bounding box of two changed rgb24 pixels', () => {
    const prev = rgb24Frame(9);
    const curr = rgb24Frame(9);
    curr[(0 * 4 + 3) * RGB] = 200; // pixel (3,0)
    curr[(3 * 4 + 0) * RGB] = 200; // pixel (0,3)
    expect(computeDirtyRect(curr, prev, 4, 4, RGB)).toEqual({ x: 0, y: 0, width: 4, height: 4 });
  });

  it('returns the full frame when everything changed', () => {
    expect(computeDirtyRect(rgb24Frame(1), rgb24Frame(2), 4, 4, RGB)).toEqual({ x: 0, y: 0, width: 4, height: 4 });
  });

  it('handles corner pixels', () => {
    const prev = rgb24Frame(9);
    const curr = rgb24Frame(9);
    curr[(3 * 4 + 3) * RGB + 2] = 1; // pixel (3,3), bottom-right corner
    expect(computeDirtyRect(curr, prev, 4, 4, RGB)).toEqual({ x: 3, y: 3, width: 1, height: 1 });
  });

  it('computes rects for rgb15 buffers with unitsPerPixel 1', () => {
    const prev = new Uint16Array(4 * 4).fill(0x1234);
    const curr = Uint16Array.from(prev);
    curr[1 * 4 + 2] = 0x7fff; // pixel (2,1)
    expect(computeDirtyRect(curr, prev, 4, 4, 1)).toEqual({ x: 2, y: 1, width: 1, height: 1 });
    expect(computeDirtyRect(Uint16Array.from(prev), prev, 4, 4, 1)).toBeNull();
  });

  it('handles rgb24 subarray views with a nonzero byteOffset', () => {
    const OFFSET = 7;
    const backingA = new Uint8Array(4 * 4 * RGB + OFFSET).fill(9);
    const backingB = new Uint8Array(4 * 4 * RGB + OFFSET).fill(9);
    const a = backingA.subarray(OFFSET);
    const b = backingB.subarray(OFFSET);
    expect(computeDirtyRect(a, b, 4, 4, RGB)).toBeNull();
    a[(2 * 4 + 1) * RGB] = 200; // pixel (1,2)
    expect(computeDirtyRect(a, b, 4, 4, RGB)).toEqual({ x: 1, y: 2, width: 1, height: 1 });
  });

  it('handles rgb15 subarray views with a nonzero byteOffset', () => {
    const OFFSET = 3;
    const backingA = new Uint16Array(4 * 4 + OFFSET).fill(0x1234);
    const backingB = new Uint16Array(4 * 4 + OFFSET).fill(0x1234);
    const a = backingA.subarray(OFFSET);
    const b = backingB.subarray(OFFSET);
    expect(computeDirtyRect(a, b, 4, 4, 1)).toBeNull();
    a[3 * 4 + 0] = 0x7fff; // pixel (0,3)
    expect(computeDirtyRect(a, b, 4, 4, 1)).toEqual({ x: 0, y: 3, width: 1, height: 1 });
  });

  it('matches an elementwise reference on a larger frame', () => {
    const W = 64;
    const H = 48;
    const prev = new Uint8Array(W * H * RGB);
    for (let i = 0; i < prev.length; i++) {
      prev[i] = (i * 31 + 7) & 0xff;
    }
    const curr = prev.slice();
    // Change a known region plus two stray pixels
    for (let y = 10; y < 14; y++) {
      for (let x = 20; x < 33; x++) {
        curr[(y * W + x) * RGB + 1] ^= 0x55;
      }
    }
    curr[(40 * W + 5) * RGB] ^= 0xff;
    curr[(41 * W + 60) * RGB + 2] ^= 0xff;
    expect(computeDirtyRect(curr, prev, W, H, RGB)).toEqual({ x: 5, y: 10, width: 56, height: 32 });
  });
});

describe('unionRects', () => {
  it('returns the bounding box of two disjoint rects', () => {
    expect(unionRects({ x: 1, y: 1, width: 1, height: 1 }, { x: 5, y: 6, width: 2, height: 1 }))
      .toEqual({ x: 1, y: 1, width: 6, height: 6 });
  });

  it('returns the outer rect when one contains the other', () => {
    const outer = { x: 0, y: 0, width: 8, height: 8 };
    expect(unionRects(outer, { x: 2, y: 2, width: 1, height: 1 })).toEqual(outer);
  });
});

describe('fullFrameRect and isFullFrameRect', () => {
  it('builds and recognizes a full-frame rect', () => {
    const rect = fullFrameRect(8, 4);
    expect(rect).toEqual({ x: 0, y: 0, width: 8, height: 4 });
    expect(isFullFrameRect(rect, 8, 4)).toBe(true);
    expect(isFullFrameRect({ x: 0, y: 0, width: 8, height: 3 }, 8, 4)).toBe(false);
    expect(isFullFrameRect({ x: 1, y: 0, width: 8, height: 4 }, 8, 4)).toBe(false);
  });
});
