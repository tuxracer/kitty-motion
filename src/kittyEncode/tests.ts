import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KittyFrameEncoder } from './index.ts';
import type { KittyFrameMeta } from './index.ts';
import { DEFAULT_PNG_COMPRESSION } from '../KittyRenderer/index.ts';

const RGB = 3;

const makeMeta = (overrides: Partial<KittyFrameMeta> = {}): KittyFrameMeta => {
  // Default to a full-frame dirty rect matching whatever source dimensions
  // this call ends up with, so overriding sourceWidth/sourceHeight alone
  // (without also overriding dirtyRect) still describes a full frame.
  const sourceWidth = overrides.sourceWidth ?? 4;
  const sourceHeight = overrides.sourceHeight ?? 4;
  return {
    sourceWidth,
    sourceHeight,
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
    transmit: 'full',
    dirtyRect: { x: 0, y: 0, width: sourceWidth, height: sourceHeight },
    medium: 'escape' as const,
    ...overrides,
  };
};

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

  it('transmits a virtual placement without a cursor move or delete for unicode placement', () => {
    const meta = makeMeta({
      placement: 'unicode',
      transmit: 'full',
      currentImageId: 7,
      deletePrevious: true,
      previousImageId: 9,
    });
    const payload = new KittyFrameEncoder().encode(makeFrame(), meta);

    const [first] = parseEscapes(payload);
    expect(first.control).toContain('U=1');
    expect(first.control).toContain('i=7');
    expect(first.control).toContain('c=40');
    expect(first.control).toContain('r=20');
    expect(payload).not.toContain('a=d'); // no delete of a previous double-buffer image
    expect(/\x1b\[\d+;\d+H/.test(payload)).toBe(false); // no cursor-position escape
  });

  it('re-transmits image data with a=t (not a=T,U=1) when createPlacement is false', () => {
    const meta = makeMeta({
      placement: 'unicode',
      transmit: 'full',
      createPlacement: false,
      currentImageId: 7,
    });
    const payload = new KittyFrameEncoder().encode(makeFrame(), meta);

    const [first] = parseEscapes(payload);
    expect(first.control).toContain('a=t,'); // data-only re-transmit to the same id
    expect(first.control).toContain('i=7');
    expect(first.control).not.toContain('U=1'); // does not recreate the placement
    expect(first.control).not.toContain('a=T');
    expect(payload).not.toContain('a=d');
    expect(/\x1b\[\d+;\d+H/.test(payload)).toBe(false); // no cursor-position escape
  });

  it('keeps the cursor move and delete for the default cursor placement', () => {
    const meta = makeMeta({
      placement: 'cursor',
      transmit: 'full',
      deletePrevious: true,
      previousImageId: 9,
    });
    const payload = new KittyFrameEncoder().encode(makeFrame(), meta);

    expect(payload.startsWith('\x1b[3;5H')).toBe(true); // moveCursor(offsetRow=3, offsetCol=5)
    expect(payload).toContain('\x1b_Ga=d,d=I,i=9,q=2\x1b\\');
    const [first] = parseEscapes(payload);
    expect(first.control).not.toContain('U=1');
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

  it('encodes only the dirty rect for a delta frame', () => {
    const frame = makeFrame(); // 4x4
    const meta = makeMeta({ transmit: 'delta', dirtyRect: { x: 1, y: 2, width: 2, height: 2 } });
    const payload = new KittyFrameEncoder().encode(frame, meta);

    const decoded = decodePng(extractPng(payload));
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const src = ((y + 2) * 4 + (x + 1)) * RGB;
        const dst = (y * 2 + x) * RGB;
        expect([...decoded.pixels.subarray(dst, dst + RGB)]).toEqual([...frame.subarray(src, src + RGB)]);
      }
    }
  });

  it('emits a frame-edit control string for delta frames', () => {
    const meta = makeMeta({
      transmit: 'delta',
      dirtyRect: { x: 1, y: 2, width: 2, height: 2 },
      currentImageId: 7,
      deletePrevious: true, // must still not emit a delete for deltas
    });
    const payload = new KittyFrameEncoder().encode(makeFrame(), meta);

    expect(payload.startsWith('\x1b_G')).toBe(true); // no cursor move prefix
    const [first] = parseEscapes(payload);
    expect(first.control).toContain('a=f');
    expect(first.control).toContain('i=7');
    expect(first.control).toContain('r=1');
    expect(first.control).toContain('x=1,y=2');
    expect(first.control).toContain('X=1');
    expect(first.control).not.toContain('a=T');
    expect(payload).not.toContain('a=d');
    expect(payload).not.toContain('\x1b['); // no ANSI cursor sequences at all
  });

  it('scales delta rect placement and dimensions by the integer scale', () => {
    const meta = makeMeta({
      transmit: 'delta',
      scale: 2,
      scaledWidth: 8,
      scaledHeight: 8,
      dirtyRect: { x: 1, y: 2, width: 2, height: 1 },
    });
    const payload = new KittyFrameEncoder().encode(makeFrame(), meta);

    const [first] = parseEscapes(payload);
    expect(first.control).toContain('x=2,y=4');
    const decoded = decodePng(extractPng(payload));
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(2);
  });

  it('treats a full-frame dirty rect on a delta like the whole image', () => {
    const frame = makeFrame();
    const meta = makeMeta({ transmit: 'delta', dirtyRect: { x: 0, y: 0, width: 4, height: 4 } });
    const decoded = decodePng(extractPng(new KittyFrameEncoder().encode(frame, meta)));
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);
    expect(decoded.pixels).toEqual(frame);
  });

  it('writes the PNG to the file and sends only the base64 path for the file medium', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kitty-encode-test-'));
    const filePath = join(dir, 'frame-1.png');
    try {
      const frame = makeFrame();
      const meta = makeMeta({ medium: 'file', filePath });
      const payload = new KittyFrameEncoder().encode(frame, meta);

      const [first] = parseEscapes(payload);
      expect(first.control).toContain('a=T');
      expect(first.control).toContain('t=t');
      expect(first.control).not.toContain('m=');
      expect(first.data).toBe(Buffer.from(filePath).toString('base64'));

      const decoded = decodePng(readFileSync(filePath));
      expect(decoded.pixels).toEqual(frame);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the cursor move and delete chunk for full file-medium frames', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kitty-encode-test-'));
    try {
      const meta = makeMeta({
        medium: 'file',
        filePath: join(dir, 'frame-2.png'),
        deletePrevious: true,
        previousImageId: 9,
      });
      const payload = new KittyFrameEncoder().encode(makeFrame(), meta);
      expect(payload.startsWith('\x1b[3;5H')).toBe(true); // moveCursor(3, 5)
      expect(payload).toContain('\x1b_Ga=d,d=I,i=9,q=2\x1b\\');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends delta frames over the file medium with the frame-edit control keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kitty-encode-test-'));
    const filePath = join(dir, 'delta-1.png');
    try {
      const meta = makeMeta({
        medium: 'file',
        filePath,
        transmit: 'delta',
        dirtyRect: { x: 1, y: 2, width: 2, height: 2 },
        currentImageId: 7,
      });
      const payload = new KittyFrameEncoder().encode(makeFrame(), meta);

      const [first] = parseEscapes(payload);
      expect(first.control).toContain('a=f');
      expect(first.control).toContain('i=7');
      expect(first.control).toContain('x=1,y=2');
      expect(first.control).toContain('t=t');
      expect(first.data).toBe(Buffer.from(filePath).toString('base64'));
      expect(payload).not.toContain('\x1b['); // no cursor sequences on deltas

      const decoded = decodePng(readFileSync(filePath));
      expect(decoded.width).toBe(2);
      expect(decoded.height).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the inline escape payload when the file write fails', () => {
    const frame = makeFrame();
    const meta = makeMeta({ medium: 'file', filePath: '/no/such/dir/frame.png' });
    const payload = new KittyFrameEncoder().encode(frame, meta);

    const [first] = parseEscapes(payload);
    expect(first.control).toContain('a=T');
    expect(first.control).toContain('m=0');
    expect(first.control).not.toContain('t=t');
    expect(decodePng(extractPng(payload)).pixels).toEqual(frame); // inline data, fully decodable
  });

  it('falls back to the inline escape payload when the target path already exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kitty-encode-test-'));
    const filePath = join(dir, 'preexisting.png');
    try {
      writeFileSync(filePath, 'not a real png'); // simulates a pre-existing file/symlink at the target path
      const frame = makeFrame();
      const meta = makeMeta({ medium: 'file', filePath });
      const payload = new KittyFrameEncoder().encode(frame, meta);

      const [first] = parseEscapes(payload);
      expect(first.control).toContain('m=0');
      expect(first.control).not.toContain('t=t');
      expect(decodePng(extractPng(payload)).pixels).toEqual(frame); // inline data, fully decodable
      expect(readFileSync(filePath, 'utf8')).toBe('not a real png'); // wx refused to overwrite it
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('produces byte-identical escape-medium output regardless of the new fields', () => {
    const frame = makeFrame();
    const viaDefault = new KittyFrameEncoder().encode(frame, makeMeta());
    const viaExplicit = new KittyFrameEncoder().encode(frame, makeMeta({ medium: 'escape' }));
    expect(viaExplicit).toBe(viaDefault);
    expect(viaDefault).toContain('m=0');
    expect(viaDefault).not.toContain('t=t');
  });

  it('samples fractional upscales with nearest-neighbor across the full canvas', () => {
    const frame = makeFrame(); // 4x4
    const meta = makeMeta({ scale: 1.25, scaledWidth: 5, scaledHeight: 5 });
    const decoded = decodePng(extractPng(new KittyFrameEncoder().encode(frame, meta)));
    expect(decoded.width).toBe(5);
    expect(decoded.height).toBe(5);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const srcX = Math.min(Math.floor(x / 1.25), 3);
        const srcY = Math.min(Math.floor(y / 1.25), 3);
        const src = (srcY * 4 + srcX) * RGB;
        const dst = (y * 5 + x) * RGB;
        expect([...decoded.pixels.subarray(dst, dst + RGB)]).toEqual([...frame.subarray(src, src + RGB)]);
      }
    }
  });

  it('leaves no stale pool bytes in fractional-upscale output on a reused encoder', () => {
    const encoder = new KittyFrameEncoder();
    // Prime the pooled buffers with a differently sized frame first
    const white = new Uint8Array(8 * 8 * RGB).fill(255);
    encoder.encode(white, makeMeta({ sourceWidth: 8, sourceHeight: 8, scaledWidth: 8, scaledHeight: 8 }));

    const frame = makeFrame(); // 4x4
    const meta = makeMeta({ scale: 1.25, scaledWidth: 5, scaledHeight: 5 });
    const decoded = decodePng(extractPng(encoder.encode(frame, meta)));
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const srcX = Math.min(Math.floor(x / 1.25), 3);
        const srcY = Math.min(Math.floor(y / 1.25), 3);
        const src = (srcY * 4 + srcX) * RGB;
        const dst = (y * 5 + x) * RGB;
        expect([...decoded.pixels.subarray(dst, dst + RGB)]).toEqual([...frame.subarray(src, src + RGB)]);
      }
    }
  });

  it('falls back to RGB and still samples correctly for fractional upscales above 256 colors', () => {
    const size = 32;
    const frame = new Uint8Array(size * size * RGB);
    for (let i = 0; i < size * size; i++) {
      frame[i * RGB] = i % 256;
      frame[i * RGB + 1] = Math.floor(i / 256) * 60;
      frame[i * RGB + 2] = 99;
    }
    const meta = makeMeta({
      sourceWidth: size,
      sourceHeight: size,
      scale: 1.25,
      scaledWidth: 40,
      scaledHeight: 40,
    });
    const decoded = decodePng(extractPng(new KittyFrameEncoder().encode(frame, meta)));
    expect(decoded.colorType).toBe(2);
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        const srcX = Math.min(Math.floor(x / 1.25), size - 1);
        const srcY = Math.min(Math.floor(y / 1.25), size - 1);
        const src = (srcY * size + srcX) * RGB;
        const dst = (y * 40 + x) * RGB;
        expect([...decoded.pixels.subarray(dst, dst + RGB)]).toEqual([...frame.subarray(src, src + RGB)]);
      }
    }
  });

  describe('encodeImage', () => {
    it('produces standalone PNG bytes with no Kitty escape wrapping', () => {
      const png = new KittyFrameEncoder().encodeImage(makeFrame(), 4, 4, DEFAULT_PNG_COMPRESSION);
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(Buffer.from(png).toString('binary')).not.toContain('\x1b_G'); // no APC introducer
    });

    it('round-trips a full-frame image at native resolution', () => {
      const frame = makeFrame();
      const decoded = decodePng(Buffer.from(new KittyFrameEncoder().encodeImage(frame, 4, 4, DEFAULT_PNG_COMPRESSION)));
      expect(decoded.width).toBe(4);
      expect(decoded.height).toBe(4);
      expect(decoded.pixels).toEqual(frame);
    });

    it('encodes RGB when the frame exceeds 256 colors', () => {
      const size = 32;
      const frame = new Uint8Array(size * size * RGB);
      for (let i = 0; i < size * size; i++) {
        frame[i * RGB] = i % 256;
        frame[i * RGB + 1] = Math.floor(i / 256) * 60;
        frame[i * RGB + 2] = 99;
      }
      const decoded = decodePng(Buffer.from(new KittyFrameEncoder().encodeImage(frame, size, size, DEFAULT_PNG_COMPRESSION)));
      expect(decoded.colorType).toBe(2);
      expect(decoded.pixels).toEqual(frame);
    });

    it('returns a fresh copy that survives later encode() calls', () => {
      const encoder = new KittyFrameEncoder();
      const png = encoder.encodeImage(makeFrame(), 4, 4, DEFAULT_PNG_COMPRESSION);
      const snapshot = Uint8Array.from(png);
      // Drive an unrelated encode that reuses the encoder's pooled buffers
      encoder.encode(new Uint8Array(8 * 8 * RGB).fill(123), makeMeta({ sourceWidth: 8, sourceHeight: 8, scaledWidth: 8, scaledHeight: 8 }));
      expect(png).toEqual(snapshot);
    });
  });
});
