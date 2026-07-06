import { describe, expect, it } from 'vitest';
import { PNG_SIGNATURE, createPngChunk, writePngChunk, PNG_IEND_CHUNK, rgbToIndexed, PNG_PALETTE_BUFFER_SIZE } from './index.ts';

describe('createPngChunk', () => {
  it('produces length + type + data + crc layout', () => {
    const chunk = createPngChunk('IEND', Buffer.alloc(0));
    expect(chunk.length).toBe(12);
    expect(chunk.readUInt32BE(0)).toBe(0);
    expect(chunk.subarray(4, 8).toString('ascii')).toBe('IEND');
    expect(chunk.readUInt32BE(8)).toBe(0xae426082); // well-known IEND CRC
  });
});

describe('rgbToIndexed', () => {
  // rgbToIndexed requires caller-owned buffers (production callers pool them)
  const callRgbToIndexed = (rgb: Uint8Array, width: number, height: number) =>
    rgbToIndexed(rgb, width, height, new Uint8Array(width * height), new Uint8Array(PNG_PALETTE_BUFFER_SIZE));

  it('maps a two-color image to two palette entries', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 255]);
    const result = callRgbToIndexed(rgb, 2, 2);
    expect(result).not.toBeNull();
    expect(result?.colorCount).toBe(2);
    expect(Array.from(result?.indices ?? [])).toEqual([0, 1, 0, 1]);
  });

  it('returns null above 256 unique colors', () => {
    const pixels = 17 * 17; // 289 unique colors
    const rgb = new Uint8Array(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      rgb[i * 3] = i % 256;
      rgb[i * 3 + 1] = Math.floor(i / 256);
      rgb[i * 3 + 2] = 7;
    }
    expect(callRgbToIndexed(rgb, 17, 17)).toBeNull();
  });

  it('handles exactly 256 unique colors with a correct palette round-trip', () => {
    const pixels = 256; // 16x16 with odd multipliers (bijections mod 256), so all colors are unique
    const rgb = new Uint8Array(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      rgb[i * 3] = (i * 37) % 256;
      rgb[i * 3 + 1] = (i * 101) % 256;
      rgb[i * 3 + 2] = (i * 199) % 256;
    }
    const result = callRgbToIndexed(rgb, 16, 16);
    expect(result).not.toBeNull();
    if (result === null) {
      return;
    }
    expect(result.colorCount).toBe(256);
    for (let i = 0; i < pixels; i++) {
      const p = result.indices[i] * 3;
      expect([result.palette[p], result.palette[p + 1], result.palette[p + 2]]).toEqual([
        rgb[i * 3],
        rgb[i * 3 + 1],
        rgb[i * 3 + 2],
      ]);
    }
  });

  it('resets palette state between calls', () => {
    const first = new Uint8Array([255, 0, 0, 0, 0, 255]); // 2x1: red, blue
    const second = new Uint8Array([0, 255, 0, 255, 255, 255]); // 2x1: green, white
    callRgbToIndexed(first, 2, 1);
    const result = callRgbToIndexed(second, 2, 1);
    expect(result).not.toBeNull();
    if (result === null) {
      return;
    }
    expect(result.colorCount).toBe(2);
    expect(Array.from(result.indices.subarray(0, 2))).toEqual([0, 1]);
    expect(Array.from(result.palette)).toEqual([0, 255, 0, 255, 255, 255]);
  });
});

it('PNG_SIGNATURE is the 8-byte magic', () => {
  expect(Array.from(PNG_SIGNATURE)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

describe('writePngChunk', () => {
  it('writes the same bytes createPngChunk produces, at the given offset', () => {
    const data = Buffer.from([1, 2, 3, 4, 5]);
    const reference = createPngChunk('IDAT', data);
    const target = Buffer.alloc(3 + reference.length + 2).fill(0xaa);
    const end = writePngChunk(target, 3, 'IDAT', data);
    expect(end).toBe(3 + reference.length);
    expect(target.subarray(3, end)).toEqual(reference);
    expect(target[0]).toBe(0xaa); // untouched before the chunk
    expect(target[end]).toBe(0xaa); // untouched after the chunk
  });
});

it('PNG_IEND_CHUNK matches a freshly built IEND chunk', () => {
  expect(PNG_IEND_CHUNK).toEqual(createPngChunk('IEND', Buffer.alloc(0)));
});
