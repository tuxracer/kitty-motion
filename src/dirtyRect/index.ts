import { Buffer } from 'node:buffer';
import type { FrameBuffer } from '../types.ts';
import type { Rect } from './types.ts';

export * from './types.ts';

/** Rect covering the whole frame */
export const fullFrameRect = (width: number, height: number): Rect => ({
  x: 0,
  y: 0,
  width,
  height,
});

export const isFullFrameRect = (rect: Rect, width: number, height: number): boolean =>
  rect.x === 0 && rect.y === 0 && rect.width === width && rect.height === height;

/** Bounding box of two rects */
export const unionRects = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
};

// Zero-copy byte view over a frame buffer's memory. Buffer.compare is a
// native memcmp, an order of magnitude faster than an elementwise JS loop
// on the row scans, whose worst case (an unchanged frame) compares every
// element of the frame.
const toByteView = (buffer: FrameBuffer): Buffer =>
  Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);

const rangeDiffers = (a: FrameBuffer, b: FrameBuffer, start: number, end: number): boolean => {
  for (let i = start; i < end; i++) {
    if (a[i] !== b[i]) {
      return true;
    }
  }
  return false;
};

/**
 * Bounding box of all pixels that differ between two equally sized frame
 * buffers, or null when they are identical. unitsPerPixel is the number of
 * typed-array elements per pixel: 1 for rgb15 (Uint16Array), 3 for rgb24
 * (Uint8Array). Scans rows from both ends for the vertical band, then scans
 * columns inward only within that band, so mostly static frames stay cheap.
 */
export const computeDirtyRect = (
  current: FrameBuffer,
  previous: FrameBuffer,
  width: number,
  height: number,
  unitsPerPixel: number,
): Rect | null => {
  const rowUnits = width * unitsPerPixel;
  const rowBytes = rowUnits * current.BYTES_PER_ELEMENT;
  const currentBytes = toByteView(current);
  const previousBytes = toByteView(previous);
  const rowDiffers = (y: number): boolean =>
    currentBytes.compare(previousBytes, y * rowBytes, (y + 1) * rowBytes, y * rowBytes, (y + 1) * rowBytes) !== 0;

  let top = -1;
  for (let y = 0; y < height; y++) {
    if (rowDiffers(y)) {
      top = y;
      break;
    }
  }
  if (top === -1) {
    return null;
  }

  let bottom = top;
  for (let y = height - 1; y > top; y--) {
    if (rowDiffers(y)) {
      bottom = y;
      break;
    }
  }

  // The top row is known to differ, so left <= right is guaranteed
  let left = width;
  let right = -1;
  for (let y = top; y <= bottom; y++) {
    const rowStart = y * rowUnits;
    for (let x = 0; x < left; x++) {
      if (rangeDiffers(current, previous, rowStart + x * unitsPerPixel, rowStart + (x + 1) * unitsPerPixel)) {
        left = x;
        break;
      }
    }
    for (let x = width - 1; x > right; x--) {
      if (rangeDiffers(current, previous, rowStart + x * unitsPerPixel, rowStart + (x + 1) * unitsPerPixel)) {
        right = x;
        break;
      }
    }
  }

  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
};
