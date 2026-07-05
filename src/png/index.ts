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
  PNG_MAX_PALETTE_COLORS,
  RGB_TRIPLET_SIZE,
  PNG_PALETTE_BUFFER_SIZE,
  BYTE_SHIFT_1,
  BYTE_SHIFT_2,
} from './consts';

export * from './consts';

import { crc32 } from '../crc32';

// Re-export crc32 for backwards compatibility
export { crc32 };

/* eslint-disable @typescript-eslint/no-magic-numbers */
// PNG file signature (magic bytes)
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Create a PNG chunk with the given type and data.
 * PNG chunks have the format: length (4) + type (4) + data + crc32 (4)
 */
export const createPngChunk = (type: string, data: Buffer): Buffer => {
  const chunk = Buffer.alloc(PNG_CHUNK_OVERHEAD + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, PNG_CHUNK_TYPE_OFFSET, PNG_CHUNK_TYPE_SIZE, 'ascii');
  data.copy(chunk, PNG_CHUNK_DATA_OFFSET);
  const crcData = Buffer.alloc(PNG_CHUNK_TYPE_SIZE + data.length);
  crcData.write(type, 0, PNG_CHUNK_TYPE_SIZE, 'ascii');
  data.copy(crcData, PNG_CHUNK_TYPE_SIZE);
  chunk.writeUInt32BE(crc32(crcData), PNG_CHUNK_DATA_OFFSET + data.length);
  return chunk;
};

/**
 * Result of RGB to indexed color conversion
 */
export interface IndexedResult {
  indices: Uint8Array;
  palette: Uint8Array;  // RGB triplets
  colorCount: number;
}

// Internal buffers for worker-style buffer management
let internalIndexedBuffer: Uint8Array | null = null;
let internalPaletteBuffer: Uint8Array | null = null;

/**
 * Convert RGB buffer to indexed format (max 256 colors).
 * Returns null if more than 256 unique colors.
 *
 * @param rgb RGB pixel data (3 bytes per pixel)
 * @param width Image width
 * @param height Image height
 * @param indexedBuffer Optional pre-allocated buffer for indices (will allocate if not provided)
 * @param paletteBuffer Optional pre-allocated buffer for palette (will allocate if not provided)
 */
export const rgbToIndexed = (
  rgb: Uint8Array,
  width: number,
  height: number,
  indexedBuffer?: Uint8Array,
  paletteBuffer?: Uint8Array
): IndexedResult | null => {
  const pixelCount = width * height;

  // Use provided buffers or manage internal ones
  let indices: Uint8Array;
  let palette: Uint8Array;

  if (indexedBuffer && paletteBuffer) {
    indices = indexedBuffer;
    palette = paletteBuffer;
  } else {
    // Reuse internal buffers (worker-style)
    if (!internalIndexedBuffer || internalIndexedBuffer.length < pixelCount) {
      internalIndexedBuffer = new Uint8Array(pixelCount);
    }
    if (!internalPaletteBuffer || internalPaletteBuffer.length < PNG_PALETTE_BUFFER_SIZE) {
      internalPaletteBuffer = new Uint8Array(PNG_PALETTE_BUFFER_SIZE);
    }
    indices = internalIndexedBuffer;
    palette = internalPaletteBuffer;
  }

  // Map RGB color (as 24-bit int) to palette index
  const colorMap = new Map<number, number>();
  let colorCount = 0;

  for (let i = 0; i < pixelCount; i++) {
    const rgbIdx = i * RGB_TRIPLET_SIZE;
    const r = rgb[rgbIdx];
    const g = rgb[rgbIdx + 1];
    const b = rgb[rgbIdx + 2];
    const colorKey = (r << BYTE_SHIFT_2) | (g << BYTE_SHIFT_1) | b;

    let paletteIdx = colorMap.get(colorKey);
    if (paletteIdx === undefined) {
      if (colorCount >= PNG_MAX_PALETTE_COLORS) {
        // Too many colors, fall back to RGB
        return null;
      }
      paletteIdx = colorCount;
      colorMap.set(colorKey, paletteIdx);
      palette[colorCount * RGB_TRIPLET_SIZE] = r;
      palette[colorCount * RGB_TRIPLET_SIZE + 1] = g;
      palette[colorCount * RGB_TRIPLET_SIZE + 2] = b;
      colorCount++;
    }

    indices[i] = paletteIdx;
  }

  return {
    indices,
    palette: palette.subarray(0, colorCount * RGB_TRIPLET_SIZE),
    colorCount,
  };
};
