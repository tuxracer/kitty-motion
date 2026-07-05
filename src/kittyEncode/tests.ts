import { describe, it, expect } from 'vitest';
import { inflateSync } from 'zlib';
import { KittyFrameEncoder } from '.';
import type { KittyFrameMeta } from '.';
import { DEFAULT_PNG_COMPRESSION } from '../consts';

const RGB = 3;

const makeMeta = (overrides: Partial<KittyFrameMeta> = {}): KittyFrameMeta => ({
  sourceWidth: 4,
  sourceHeight: 4,
  scale: 1,
  scaledWidth: 4,
  scaledHeight: 4,
  pngCompressionLevel: DEFAULT_PNG_COMPRESSION,
  displayCols: 40,
  displayRows: 20,
  offsetRow: 3,
  offsetCol: 5,
  currentImageId: 1,
  previousImageId: 2,
  deletePrevious: false,
  ...overrides,
});

// Parse a payload into its APC escape sequences: [control, data][]
const parseEscapes = (payload: string): Array<{ control: string; data: string }> =>
  [...payload.matchAll(/\x1b_G([^;\x1b]*);?([^\x1b]*)\x1b\\/g)].map((m) => ({
    control: m[1],
    data: m[2],
  }));

// Extract and decode the PNG transmitted in a payload
const extractPng = (payload: string): Buffer => {
  const escapes = parseEscapes(payload).filter((e) => !e.control.includes('a=d'));
  return Buffer.from(escapes.map((e) => e.data).join(''), 'base64');
};

interface DecodedPng {
  width: number;
  height: number;
  colorType: number;
  pixels: Uint8Array; // RGB24, filter bytes stripped, palette resolved
}

const decodePng = (png: Buffer): DecodedPng => {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette: Buffer | null = null;
  const idatParts: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    }
    offset += 8 + length + 4; // length + type + data + crc
  }

  const raw = inflateSync(Buffer.concat(idatParts));
  const pixels = new Uint8Array(width * height * RGB);
  const INDEXED = 3;
  const rowStride = colorType === INDEXED ? width : width * RGB;

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + rowStride);
    expect(raw[rowStart]).toBe(0); // filter type: none
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * RGB;
      if (colorType === INDEXED) {
        const paletteIdx = raw[rowStart + 1 + x] * RGB;
        pixels[dst] = palette![paletteIdx];
        pixels[dst + 1] = palette![paletteIdx + 1];
        pixels[dst + 2] = palette![paletteIdx + 2];
      } else {
        pixels[dst] = raw[rowStart + 1 + x * RGB];
        pixels[dst + 1] = raw[rowStart + 1 + x * RGB + 1];
        pixels[dst + 2] = raw[rowStart + 1 + x * RGB + 2];
      }
    }
  }

  return { width, height, colorType, pixels };
};

// A 4x4 three-color test frame
const makeFrame = (): Uint8Array => {
  const frame = new Uint8Array(4 * 4 * RGB);
  for (let i = 0; i < 16; i++) {
    const colors = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ][i % 3];
    frame.set(colors, i * RGB);
  }
  return frame;
};

describe('KittyFrameEncoder', () => {
  it('encodes a frame into a PNG that round-trips to the source pixels', () => {
    const frame = makeFrame();
    const payload = new KittyFrameEncoder().encode(frame, makeMeta());

    const decoded = decodePng(extractPng(payload));
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);
    expect(decoded.colorType).toBe(3); // indexed
    expect(decoded.pixels).toEqual(frame);
  });

  it('duplicates pixels when upscaling', () => {
    const frame = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]); // 2x2
    const meta = makeMeta({ sourceWidth: 2, sourceHeight: 2, scale: 2, scaledWidth: 4, scaledHeight: 4 });
    const payload = new KittyFrameEncoder().encode(frame, meta);

    const decoded = decodePng(extractPng(payload));
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const src = (Math.floor(y / 2) * 2 + Math.floor(x / 2)) * RGB;
        const dst = (y * 4 + x) * RGB;
        expect([...decoded.pixels.subarray(dst, dst + RGB)]).toEqual([...frame.subarray(src, src + RGB)]);
      }
    }
  });

  it('falls back to RGB encoding above 256 unique colors', () => {
    // 32x32 = 1024 unique colors
    const size = 32;
    const frame = new Uint8Array(size * size * RGB);
    for (let i = 0; i < size * size; i++) {
      frame[i * RGB] = i % 256;
      frame[i * RGB + 1] = Math.floor(i / 256) * 60;
      frame[i * RGB + 2] = 99;
    }
    const meta = makeMeta({ sourceWidth: size, sourceHeight: size, scaledWidth: size, scaledHeight: size });
    const payload = new KittyFrameEncoder().encode(frame, meta);

    const decoded = decodePng(extractPng(payload));
    expect(decoded.colorType).toBe(2); // RGB
    expect(decoded.pixels).toEqual(frame);
  });

  it('places the image with the correct control data and cursor position', () => {
    const payload = new KittyFrameEncoder().encode(makeFrame(), makeMeta({ currentImageId: 7 }));

    expect(payload.startsWith('\x1b[3;5H')).toBe(true); // moveCursor(offsetRow=3, offsetCol=5)
    const [first] = parseEscapes(payload);
    expect(first.control).toContain('a=T');
    expect(first.control).toContain('f=100');
    expect(first.control).toContain('i=7');
    expect(first.control).toContain('c=40');
    expect(first.control).toContain('r=20');
    expect(first.control).toContain('m=0'); // single chunk for a tiny image
  });

  it('deletes the previous image only when requested', () => {
    const encoder = new KittyFrameEncoder();
    const withDelete = encoder.encode(makeFrame(), makeMeta({ deletePrevious: true, previousImageId: 9 }));
    const withoutDelete = encoder.encode(makeFrame(), makeMeta({ deletePrevious: false }));

    expect(withDelete).toContain('\x1b_Ga=d,d=I,i=9,q=2\x1b\\');
    expect(withoutDelete).not.toContain('a=d');
  });

  it('falls back to RGB encoding above 256 unique colors when upscaling', () => {
    const size = 32;
    const frame = new Uint8Array(size * size * RGB);
    for (let i = 0; i < size * size; i++) {
      frame[i * RGB] = i % 256;
      frame[i * RGB + 1] = Math.floor(i / 256) * 60;
      frame[i * RGB + 2] = 99;
    }
    const meta = makeMeta({ sourceWidth: size, sourceHeight: size, scale: 2, scaledWidth: size * 2, scaledHeight: size * 2 });
    const payload = new KittyFrameEncoder().encode(frame, meta);

    const decoded = decodePng(extractPng(payload));
    expect(decoded.colorType).toBe(2); // RGB
    for (let y = 0; y < size * 2; y++) {
      for (let x = 0; x < size * 2; x++) {
        const src = (Math.floor(y / 2) * size + Math.floor(x / 2)) * RGB;
        const dst = (y * size * 2 + x) * RGB;
        expect([...decoded.pixels.subarray(dst, dst + RGB)]).toEqual([...frame.subarray(src, src + RGB)]);
      }
    }
  });

  it('samples pixels when downscaling', () => {
    const frame = makeFrame(); // 4x4
    const meta = makeMeta({ scale: 0.5, scaledWidth: 2, scaledHeight: 2 });
    const payload = new KittyFrameEncoder().encode(frame, meta);

    const decoded = decodePng(extractPng(payload));
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const src = (y * 2 * 4 + x * 2) * RGB;
        const dst = (y * 2 + x) * RGB;
        expect([...decoded.pixels.subarray(dst, dst + RGB)]).toEqual([...frame.subarray(src, src + RGB)]);
      }
    }
  });

  it('handles alternating indexed and RGB-fallback frames on a reused encoder', () => {
    const encoder = new KittyFrameEncoder();
    const size = 32;
    const meta = makeMeta({ sourceWidth: size, sourceHeight: size, scale: 2, scaledWidth: size * 2, scaledHeight: size * 2 });

    const fewColors = new Uint8Array(size * size * RGB).fill(50);
    const manyColors = new Uint8Array(size * size * RGB);
    for (let i = 0; i < size * size; i++) {
      manyColors[i * RGB] = i % 256;
      manyColors[i * RGB + 1] = Math.floor(i / 256) * 60;
      manyColors[i * RGB + 2] = 99;
    }

    const indexedFirst = decodePng(extractPng(encoder.encode(fewColors, meta)));
    const rgbSecond = decodePng(extractPng(encoder.encode(manyColors, meta)));
    const indexedAgain = decodePng(extractPng(encoder.encode(fewColors, meta)));

    expect(indexedFirst.colorType).toBe(3);
    expect(rgbSecond.colorType).toBe(2);
    expect(indexedAgain.pixels).toEqual(indexedFirst.pixels);
    expect([...indexedFirst.pixels.subarray(0, RGB)]).toEqual([50, 50, 50]);
  });

  it('produces identical output when reusing an encoder across frames', () => {
    // Pooled internal buffers must not leak state between frames
    const reused = new KittyFrameEncoder();
    const meta = makeMeta();
    const frameA = makeFrame();
    const frameB = new Uint8Array(4 * 4 * RGB).fill(200);

    reused.encode(frameA, meta);
    expect(reused.encode(frameB, meta)).toBe(new KittyFrameEncoder().encode(frameB, meta));
    expect(reused.encode(frameA, meta)).toBe(new KittyFrameEncoder().encode(frameA, meta));
  });
});
