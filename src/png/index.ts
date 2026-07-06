/**
 * PNG Encoding Utilities
 *
 * Shared utilities for PNG chunk creation and color indexing,
 * used by both the main Kitty renderer and the worker thread.
 */

import {
  PNG_CHUNK_OVERHEAD,
  PNG_CHUNK_TYPE_OFFSET,
  PNG_CHUNK_DATA_OFFSET,
  PNG_CHUNK_TYPE_SIZE,
  PNG_CHUNK_FOOTER_SIZE,
  PNG_MAX_PALETTE_COLORS,
  RGB_TRIPLET_SIZE,
  BYTE_SHIFT_1,
  BYTE_SHIFT_2,
  PALETTE_HASH_SIZE,
  PALETTE_HASH_MASK,
  PALETTE_HASH_MULTIPLIER,
  PALETTE_HASH_SHIFT,
  PALETTE_HASH_EMPTY,
} from './consts.ts';
import type { IndexedResult } from './types.ts';

export * from './consts.ts';
export * from './types.ts';

import { crc32 } from 'node:zlib';

/**
 * Write a PNG chunk into target at offset, returning the offset just past
 * it. Layout: length (4) + type (4) + data + crc32 (4).
 */
export const writePngChunk = (
  target: Buffer,
  offset: number,
  type: string,
  data: Uint8Array
): number => {
  target.writeUInt32BE(data.length, offset);
  target.write(type, offset + PNG_CHUNK_TYPE_OFFSET, PNG_CHUNK_TYPE_SIZE, 'ascii');
  target.set(data, offset + PNG_CHUNK_DATA_OFFSET);
  // The CRC covers type + data, which sit contiguously in the target
  const crcEnd = offset + PNG_CHUNK_DATA_OFFSET + data.length;
  const crc = crc32(target.subarray(offset + PNG_CHUNK_TYPE_OFFSET, crcEnd));
  target.writeUInt32BE(crc, crcEnd);
  return crcEnd + PNG_CHUNK_FOOTER_SIZE;
};

/**
 * Create a standalone PNG chunk with the given type and data.
 */
export const createPngChunk = (type: string, data: Buffer): Buffer => {
  const chunk = Buffer.alloc(PNG_CHUNK_OVERHEAD + data.length);
  writePngChunk(chunk, 0, type, data);
  return chunk;
};

// Persistent open-addressed hash mapping 24-bit color keys to palette
// indices. Module state so the scan allocates nothing per frame. Reset by
// refilling the keys with the empty sentinel at the start of each call.
const hashKeys = new Int32Array(PALETTE_HASH_SIZE);
const hashIndices = new Uint8Array(PALETTE_HASH_SIZE);

/**
 * Convert an RGB buffer (3 bytes per pixel) to indexed format (max 256
 * colors). Returns null if there are more than 256 unique colors. Callers
 * own the index and palette buffers (production callers pool them across
 * frames).
 */
export const rgbToIndexed = (
  rgb: Uint8Array,
  width: number,
  height: number,
  indices: Uint8Array,
  palette: Uint8Array
): IndexedResult | null => {
  const pixelCount = width * height;

  hashKeys.fill(PALETTE_HASH_EMPTY);
  let colorCount = 0;

  for (let i = 0; i < pixelCount; i++) {
    const rgbIdx = i * RGB_TRIPLET_SIZE;
    const r = rgb[rgbIdx];
    const g = rgb[rgbIdx + 1];
    const b = rgb[rgbIdx + 2];
    const colorKey = (r << BYTE_SHIFT_2) | (g << BYTE_SHIFT_1) | b;

    // Fibonacci-hash to a starting slot, then linear-probe. At most 256
    // entries ever occupy the 1024 slots, so probe chains stay short.
    let slot = Math.imul(colorKey, PALETTE_HASH_MULTIPLIER) >>> PALETTE_HASH_SHIFT;
    while (hashKeys[slot] !== colorKey) {
      if (hashKeys[slot] === PALETTE_HASH_EMPTY) {
        if (colorCount >= PNG_MAX_PALETTE_COLORS) {
          // Too many colors, fall back to RGB
          return null;
        }
        hashKeys[slot] = colorKey;
        hashIndices[slot] = colorCount;
        palette[colorCount * RGB_TRIPLET_SIZE] = r;
        palette[colorCount * RGB_TRIPLET_SIZE + 1] = g;
        palette[colorCount * RGB_TRIPLET_SIZE + 2] = b;
        colorCount++;
        break;
      }
      slot = (slot + 1) & PALETTE_HASH_MASK;
    }
    indices[i] = hashIndices[slot];
  }

  return {
    indices,
    palette: palette.subarray(0, colorCount * RGB_TRIPLET_SIZE),
    colorCount,
  };
};
