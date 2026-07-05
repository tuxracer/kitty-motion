import { deflateSync } from 'zlib';
import { PNG_SIGNATURE, createPngChunk, rgbToIndexed, PNG_PALETTE_BUFFER_SIZE } from '../png';
import { APC, ST, moveCursor } from '../ansi';
import {
  KITTY_CHUNK_SIZE,
  PNG_BIT_DEPTH,
  PNG_COLOR_TYPE_INDEXED,
  PNG_COLOR_TYPE_RGB,
  PNG_IHDR_LENGTH,
  PNG_IHDR_HEIGHT_OFFSET,
  RGB24_BYTES_PER_PIXEL,
} from '../consts';
import type { KittyFrameMeta } from './types';

export * from './types';

/**
 * Encodes post-processed native-resolution RGB frames into complete Kitty
 * graphics protocol payloads (scale -> PNG -> base64 -> APC chunks).
 *
 * Pure CPU work with no terminal or renderer state, so it can run either on
 * the main thread (sync fallback) or inside a worker thread. Internal buffers
 * are pooled and reused across frames; every frame's metadata is
 * self-describing, so no configuration sync is ever needed.
 */
export class KittyFrameEncoder {
  private scaledRgbBuffer: Uint8Array = new Uint8Array(0);
  private scaledRowBuffer: Uint8Array = new Uint8Array(0);
  private indexedBuffer: Uint8Array = new Uint8Array(0);
  private indexedRowBuffer: Uint8Array = new Uint8Array(0);
  private paletteBuffer: Uint8Array = new Uint8Array(PNG_PALETTE_BUFFER_SIZE);
  private rawDataBuffer: Buffer = Buffer.alloc(0);

  encode(nativeRgb: Uint8Array, meta: KittyFrameMeta): string {
    return this.buildPayload(this.encodePng(nativeRgb, meta), meta);
  }

  private encodePng(nativeRgb: Uint8Array, meta: KittyFrameMeta): Buffer {
    // Upscaling duplicates pixels without adding colors, so quantize at
    // native resolution: the palette scan touches scale^2 fewer pixels and
    // scaling then moves 1-byte palette indices instead of 3-byte RGB
    if (meta.scale >= 1) {
      const indexedPng = this.encodePngIndexedFromNative(nativeRgb, meta);
      if (indexedPng !== null) {
        return indexedPng;
      }
      // >256 colors at native resolution implies >256 when scaled too,
      // so skip re-quantizing and encode RGB directly
      return this.encodePngRgb(this.scaleRgb(nativeRgb, meta), meta);
    }

    // Downscaling samples a pixel subset that may fit a palette even when
    // the native frame doesn't, so quantize the scaled buffer
    const scaled = this.scaleRgb(nativeRgb, meta);
    return this.encodePngFromScaled(scaled, meta);
  }

  // Scale RGB buffer from native to output resolution
  // Supports both upscaling (scale > 1) and downscaling (scale < 1)
  private scaleRgb(src: Uint8Array, meta: KittyFrameMeta): Uint8Array {
    const { scale, sourceWidth, sourceHeight, scaledWidth, scaledHeight } = meta;

    // No scaling needed: encode the native buffer directly
    if (scale === 1) {
      return src;
    }

    const dstSize = scaledWidth * scaledHeight * RGB24_BYTES_PER_PIXEL;
    if (this.scaledRgbBuffer.length !== dstSize) {
      this.scaledRgbBuffer = new Uint8Array(dstSize);
    }
    const dst = this.scaledRgbBuffer;

    if (scale >= 1) {
      // Upscaling: duplicate pixels (integer scale path)
      const intScale = Math.round(scale);
      const dstRowBytes = scaledWidth * RGB24_BYTES_PER_PIXEL;
      if (this.scaledRowBuffer.length !== dstRowBytes) {
        this.scaledRowBuffer = new Uint8Array(dstRowBytes);
      }
      const rowBuffer = this.scaledRowBuffer;

      for (let srcY = 0; srcY < sourceHeight; srcY++) {
        const srcRowStart = srcY * sourceWidth * RGB24_BYTES_PER_PIXEL;

        // Scale one source row horizontally into rowBuffer
        let rowIdx = 0;
        for (let srcX = 0; srcX < sourceWidth; srcX++) {
          const srcIdx = srcRowStart + srcX * RGB24_BYTES_PER_PIXEL;
          const r = src[srcIdx];
          const g = src[srcIdx + 1];
          const b = src[srcIdx + 2];

          for (let sx = 0; sx < intScale; sx++) {
            rowBuffer[rowIdx] = r;
            rowBuffer[rowIdx + 1] = g;
            rowBuffer[rowIdx + 2] = b;
            rowIdx += RGB24_BYTES_PER_PIXEL;
          }
        }

        // Copy the scaled row 'scale' times vertically
        const dstRowStart = srcY * intScale * dstRowBytes;
        for (let sy = 0; sy < intScale; sy++) {
          dst.set(rowBuffer, dstRowStart + sy * dstRowBytes);
        }
      }
    } else {
      // Downscaling: sample pixels using nearest-neighbor
      const invScale = 1 / scale;

      for (let dstY = 0; dstY < scaledHeight; dstY++) {
        const srcY = Math.min(Math.floor(dstY * invScale), sourceHeight - 1);
        const srcRowStart = srcY * sourceWidth * RGB24_BYTES_PER_PIXEL;
        const dstRowStart = dstY * scaledWidth * RGB24_BYTES_PER_PIXEL;

        for (let dstX = 0; dstX < scaledWidth; dstX++) {
          const srcX = Math.min(Math.floor(dstX * invScale), sourceWidth - 1);
          const srcIdx = srcRowStart + srcX * RGB24_BYTES_PER_PIXEL;
          const dstIdx = dstRowStart + dstX * RGB24_BYTES_PER_PIXEL;

          dst[dstIdx] = src[srcIdx];
          dst[dstIdx + 1] = src[srcIdx + 1];
          dst[dstIdx + 2] = src[srcIdx + 2];
        }
      }
    }

    return dst;
  }

  // Quantize at native resolution, then expand the 1-byte palette indices
  // straight into the PNG scanlines. Returns null above 256 unique colors.
  private encodePngIndexedFromNative(nativeRgb: Uint8Array, meta: KittyFrameMeta): Buffer | null {
    const { sourceWidth, sourceHeight, scale, scaledWidth, scaledHeight } = meta;
    const pixelCount = sourceWidth * sourceHeight;

    if (this.indexedBuffer.length !== pixelCount) {
      this.indexedBuffer = new Uint8Array(pixelCount);
    }

    const indexed = rgbToIndexed(nativeRgb, sourceWidth, sourceHeight, this.indexedBuffer, this.paletteBuffer);
    if (indexed === null) {
      return null;
    }

    // Build raw scanlines: 1 filter byte + 1 palette index per pixel per row
    const intScale = Math.round(scale);
    const rawDataSize = scaledHeight * (1 + scaledWidth);
    const rawData = this.getRawDataBuffer(rawDataSize);

    if (this.indexedRowBuffer.length !== scaledWidth) {
      this.indexedRowBuffer = new Uint8Array(scaledWidth);
    }
    const rowBuffer = this.indexedRowBuffer;

    for (let srcY = 0; srcY < sourceHeight; srcY++) {
      const srcRowStart = srcY * sourceWidth;

      // Expand one native row of indices horizontally
      let rowIdx = 0;
      for (let srcX = 0; srcX < sourceWidth; srcX++) {
        const index = this.indexedBuffer[srcRowStart + srcX];
        for (let sx = 0; sx < intScale; sx++) {
          rowBuffer[rowIdx++] = index;
        }
      }

      // Write the expanded row (with its filter byte) 'scale' times vertically
      for (let sy = 0; sy < intScale; sy++) {
        const rawRowStart = (srcY * intScale + sy) * (1 + scaledWidth);
        rawData[rawRowStart] = 0; // Filter type: none
        rawData.set(rowBuffer, rawRowStart + 1);
      }
    }

    return this.buildIndexedPng(rawData, Buffer.from(indexed.palette), meta);
  }

  // Encode an already-scaled RGB buffer to PNG (indexed with RGB fallback).
  // Used for the downscaling path, where quantization must see the sampled pixels.
  private encodePngFromScaled(rgbData: Uint8Array, meta: KittyFrameMeta): Buffer {
    const { scaledWidth: width, scaledHeight: height } = meta;
    const pixelCount = width * height;

    if (this.indexedBuffer.length !== pixelCount) {
      this.indexedBuffer = new Uint8Array(pixelCount);
    }

    const indexed = rgbToIndexed(rgbData, width, height, this.indexedBuffer, this.paletteBuffer);
    if (indexed === null) {
      // More than 256 colors - fall back to RGB encoding
      return this.encodePngRgb(rgbData, meta);
    }

    // Build raw scanlines: 1 filter byte + 1 palette index per pixel per row
    const rawDataSize = height * (1 + width);
    const rawData = this.getRawDataBuffer(rawDataSize);

    for (let y = 0; y < height; y++) {
      const rawRowStart = y * (1 + width);
      rawData[rawRowStart] = 0; // Filter type: none
      rawData.set(this.indexedBuffer.subarray(y * width, (y + 1) * width), rawRowStart + 1);
    }

    return this.buildIndexedPng(rawData, Buffer.from(indexed.palette), meta);
  }

  private buildIndexedPng(rawData: Buffer, palette: Buffer, meta: KittyFrameMeta): Buffer {
    const compressed = deflateSync(rawData, { level: meta.pngCompressionLevel });

    const ihdr = this.buildIhdr(meta.scaledWidth, meta.scaledHeight, PNG_COLOR_TYPE_INDEXED);
    const ihdrChunk = createPngChunk('IHDR', ihdr);
    const plteChunk = createPngChunk('PLTE', palette);
    const idatChunk = createPngChunk('IDAT', compressed);
    const iendChunk = createPngChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([PNG_SIGNATURE, ihdrChunk, plteChunk, idatChunk, iendChunk]);
  }

  // Fallback RGB encoding when palette exceeds 256 colors
  private encodePngRgb(rgbData: Uint8Array, meta: KittyFrameMeta): Buffer {
    const { scaledWidth: width, scaledHeight: height } = meta;

    const rowBytes = width * RGB24_BYTES_PER_PIXEL;
    const rawDataSize = height * (1 + rowBytes);
    const rawData = this.getRawDataBuffer(rawDataSize);

    for (let y = 0; y < height; y++) {
      const rawRowStart = y * (1 + rowBytes);
      rawData[rawRowStart] = 0; // Filter type: none
      rawData.set(rgbData.subarray(y * rowBytes, (y + 1) * rowBytes), rawRowStart + 1);
    }

    const compressed = deflateSync(rawData, { level: meta.pngCompressionLevel });

    const ihdr = this.buildIhdr(width, height, PNG_COLOR_TYPE_RGB);
    const ihdrChunk = createPngChunk('IHDR', ihdr);
    const idatChunk = createPngChunk('IDAT', compressed);
    const iendChunk = createPngChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([PNG_SIGNATURE, ihdrChunk, idatChunk, iendChunk]);
  }

  private buildIhdr(width: number, height: number, colorType: number): Buffer {
    const ihdr = Buffer.alloc(PNG_IHDR_LENGTH);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, PNG_IHDR_HEIGHT_OFFSET);
    ihdr[8] = PNG_BIT_DEPTH;
    ihdr[9] = colorType;
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    return ihdr;
  }

  // Reuse the raw scanline buffer across frames (deflateSync reads it synchronously)
  private getRawDataBuffer(size: number): Buffer {
    if (this.rawDataBuffer.length !== size) {
      this.rawDataBuffer = Buffer.alloc(size);
    }
    return this.rawDataBuffer;
  }

  // Build the terminal payload: cursor move + chunked Kitty APC transmission
  private buildPayload(png: Buffer, meta: KittyFrameMeta): string {
    const base64 = png.toString('base64');
    const chunks: string[] = [moveCursor(meta.offsetRow, meta.offsetCol)];

    for (let i = 0; i < base64.length; i += KITTY_CHUNK_SIZE) {
      const chunk = base64.slice(i, i + KITTY_CHUNK_SIZE);
      const isFirst = i === 0;
      const isLast = i + KITTY_CHUNK_SIZE >= base64.length;

      let control: string;
      if (isFirst) {
        // a=T: transmit and display, f=100: PNG, p=1: placement id,
        // q=2: suppress response, C=1: don't move cursor,
        // c/r: display size in cells, m: more chunks follow
        const displayParams = `,c=${meta.displayCols},r=${meta.displayRows}`;
        control = `a=T,f=100,i=${meta.currentImageId},p=1,q=2,C=1${displayParams},m=${isLast ? 0 : 1}`;
      } else {
        control = `m=${isLast ? 0 : 1}`;
      }

      chunks.push(`${APC}${control};${chunk}${ST}`);
    }

    // Delete the previous frame's image after displaying the new one
    if (meta.deletePrevious) {
      chunks.push(`${APC}a=d,d=I,i=${meta.previousImageId},q=2${ST}`);
    }

    return chunks.join('');
  }
}
