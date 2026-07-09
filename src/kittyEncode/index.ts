import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import {
  PNG_SIGNATURE,
  writePngChunk,
  PNG_IEND_CHUNK,
  PNG_CHUNK_OVERHEAD,
  rgbToIndexed,
  PNG_PALETTE_BUFFER_SIZE,
  PNG_BIT_DEPTH,
  PNG_COLOR_TYPE_INDEXED,
  PNG_COLOR_TYPE_RGB,
  PNG_IHDR_LENGTH,
  PNG_IHDR_HEIGHT_OFFSET,
} from '../png/index.ts';
import { APC, ST, moveCursor } from '../ansi/index.ts';
import { buildKittyDeleteSequence } from '../kittyProtocol/index.ts';
import { isFullFrameRect } from '../dirtyRect/index.ts';
import { RGB24_BYTES_PER_PIXEL } from '../consts.ts';
import { FILE_MEDIUM_FOR_DELTAS, KITTY_CHUNK_SIZE } from './consts.ts';
import type { KittyFrameMeta, EncodeJob, PngEncodeParams } from './types.ts';

export * from './types.ts';
export * from './consts.ts';

/**
 * Encodes post-processed native-resolution RGB frames into complete Kitty
 * graphics protocol payloads (scale -> PNG -> base64 -> APC chunks).
 *
 * Pure CPU work plus, for the file medium, one temp-file write; no terminal
 * or renderer state, so it can run either on the main thread (sync fallback)
 * or inside a worker thread. Internal buffers
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
  private rectRgbBuffer: Uint8Array = new Uint8Array(0);
  private pngBuffer: Buffer = Buffer.alloc(0);
  private ihdrBuffer: Buffer = Buffer.alloc(PNG_IHDR_LENGTH);

  encode(nativeRgb: Uint8Array, meta: KittyFrameMeta): string {
    const job = this.buildJob(nativeRgb, meta);
    return this.buildPayload(this.encodePng(job, meta), meta, job);
  }

  /**
   * Encode a full-frame RGB24 buffer into a standalone PNG (no Kitty escape
   * wrapping), for screenshots. The pixels are encoded at their given
   * resolution with no scaling. Returns a fresh copy, not the pooled internal
   * buffer, so the result stays valid across later encode() calls.
   */
  encodeImage(
    rgb: Uint8Array,
    width: number,
    height: number,
    pngCompressionLevel: number
  ): Uint8Array {
    const job: EncodeJob = {
      rgb,
      sourceWidth: width,
      sourceHeight: height,
      scaledWidth: width,
      scaledHeight: height,
      scaledX: 0,
      scaledY: 0,
    };
    return new Uint8Array(this.encodePng(job, { scale: 1, pngCompressionLevel }));
  }

  // Resolve the frame's dirty rect into the pixels and dimensions to encode.
  // Full frames pass through untouched (including fractional/downscale
  // dimensions from meta); delta rects are cropped out of the native buffer
  // and scaled by the integer scale (the renderer only produces delta rects
  // at integer scales >= 1).
  private buildJob(nativeRgb: Uint8Array, meta: KittyFrameMeta): EncodeJob {
    const { dirtyRect, sourceWidth, sourceHeight } = meta;
    if (isFullFrameRect(dirtyRect, sourceWidth, sourceHeight)) {
      return {
        rgb: nativeRgb,
        sourceWidth,
        sourceHeight,
        scaledWidth: meta.scaledWidth,
        scaledHeight: meta.scaledHeight,
        scaledX: 0,
        scaledY: 0,
      };
    }

    const intScale = Math.round(meta.scale);
    return {
      rgb: this.extractRect(nativeRgb, meta),
      sourceWidth: dirtyRect.width,
      sourceHeight: dirtyRect.height,
      scaledWidth: dirtyRect.width * intScale,
      scaledHeight: dirtyRect.height * intScale,
      scaledX: dirtyRect.x * intScale,
      scaledY: dirtyRect.y * intScale,
    };
  }

  // Copy the dirty rect's rows out of the full native buffer (pooled)
  private extractRect(nativeRgb: Uint8Array, meta: KittyFrameMeta): Uint8Array {
    const { dirtyRect, sourceWidth } = meta;
    const rowBytes = dirtyRect.width * RGB24_BYTES_PER_PIXEL;
    const size = rowBytes * dirtyRect.height;
    if (this.rectRgbBuffer.length !== size) {
      this.rectRgbBuffer = new Uint8Array(size);
    }
    for (let y = 0; y < dirtyRect.height; y++) {
      const srcStart = ((dirtyRect.y + y) * sourceWidth + dirtyRect.x) * RGB24_BYTES_PER_PIXEL;
      this.rectRgbBuffer.set(nativeRgb.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
    }
    return this.rectRgbBuffer;
  }

  private encodePng(job: EncodeJob, params: PngEncodeParams): Buffer {
    // Upscaling duplicates pixels without adding colors, so quantize at
    // native resolution: the palette scan touches scale^2 fewer pixels and
    // scaling then moves 1-byte palette indices instead of 3-byte RGB.
    // Only integer upscales map native pixels 1:1 onto the scaled grid, so
    // fractional upscales fall through to the sampling path below
    const intScale = Math.round(params.scale);
    if (
      params.scale >= 1 &&
      job.scaledWidth === job.sourceWidth * intScale &&
      job.scaledHeight === job.sourceHeight * intScale
    ) {
      const indexedPng = this.encodePngIndexedFromNative(job, params);
      if (indexedPng !== null) {
        return indexedPng;
      }
      // >256 colors at native resolution implies >256 when scaled too,
      // so skip re-quantizing and encode RGB directly
      return this.encodePngRgb(this.scaleRgb(job, params.scale), job, params);
    }

    // Downscales and fractional upscales sample pixels one by one, and the
    // sampled subset may fit a palette even when the native frame doesn't,
    // so quantize the scaled buffer
    const scaled = this.scaleRgb(job, params.scale);
    return this.encodePngFromScaled(scaled, job, params);
  }

  // Scale RGB buffer from native to output resolution. Integer upscales
  // duplicate pixels row by row. Downscales and fractional upscales sample
  // with nearest-neighbor
  private scaleRgb(job: EncodeJob, scale: number): Uint8Array {
    const { rgb: src, sourceWidth, sourceHeight, scaledWidth, scaledHeight } = job;

    // No scaling needed: encode the native buffer directly
    if (scale === 1 && scaledWidth === sourceWidth && scaledHeight === sourceHeight) {
      return job.rgb;
    }

    const dstSize = scaledWidth * scaledHeight * RGB24_BYTES_PER_PIXEL;
    if (this.scaledRgbBuffer.length !== dstSize) {
      this.scaledRgbBuffer = new Uint8Array(dstSize);
    }
    const dst = this.scaledRgbBuffer;

    const intScale = Math.round(scale);
    if (scale >= 1 && scaledWidth === sourceWidth * intScale && scaledHeight === sourceHeight * intScale) {
      // Upscaling: duplicate pixels (integer scale path)
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
      // Downscaling or fractional upscaling: nearest-neighbor sampling
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
  private encodePngIndexedFromNative(job: EncodeJob, params: PngEncodeParams): Buffer | null {
    const { rgb: nativeRgb, sourceWidth, sourceHeight, scaledWidth, scaledHeight } = job;
    const pixelCount = sourceWidth * sourceHeight;

    if (this.indexedBuffer.length !== pixelCount) {
      this.indexedBuffer = new Uint8Array(pixelCount);
    }

    const indexed = rgbToIndexed(nativeRgb, sourceWidth, sourceHeight, this.indexedBuffer, this.paletteBuffer);
    if (indexed === null) {
      return null;
    }

    // Build raw scanlines: 1 filter byte + 1 palette index per pixel per row
    const intScale = Math.round(params.scale);
    const rawDataSize = scaledHeight * (1 + scaledWidth);
    const rawData = this.getRawDataBuffer(rawDataSize);

    // The dimension check (not just intScale) matters: a non-integer scale
    // like 1.2 rounds to 1 while scaledWidth differs from sourceWidth, and
    // that class must keep taking the expansion loop below
    if (intScale === 1 && scaledWidth === sourceWidth && scaledHeight === sourceHeight) {
      // No expansion: each scanline is a straight copy of a native index row
      for (let y = 0; y < sourceHeight; y++) {
        const rawRowStart = y * (1 + scaledWidth);
        rawData[rawRowStart] = 0; // Filter type: none
        rawData.set(this.indexedBuffer.subarray(y * sourceWidth, (y + 1) * sourceWidth), rawRowStart + 1);
      }
      return this.buildIndexedPng(rawData, indexed.palette, job, params);
    }

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

    return this.buildIndexedPng(rawData, indexed.palette, job, params);
  }

  // Encode an already-scaled RGB buffer to PNG (indexed with RGB fallback).
  // Used for the downscaling path, where quantization must see the sampled pixels.
  private encodePngFromScaled(rgbData: Uint8Array, job: EncodeJob, params: PngEncodeParams): Buffer {
    const { scaledWidth: width, scaledHeight: height } = job;
    const pixelCount = width * height;

    if (this.indexedBuffer.length !== pixelCount) {
      this.indexedBuffer = new Uint8Array(pixelCount);
    }

    const indexed = rgbToIndexed(rgbData, width, height, this.indexedBuffer, this.paletteBuffer);
    if (indexed === null) {
      // More than 256 colors - fall back to RGB encoding
      return this.encodePngRgb(rgbData, job, params);
    }

    // Build raw scanlines: 1 filter byte + 1 palette index per pixel per row
    const rawDataSize = height * (1 + width);
    const rawData = this.getRawDataBuffer(rawDataSize);

    for (let y = 0; y < height; y++) {
      const rawRowStart = y * (1 + width);
      rawData[rawRowStart] = 0; // Filter type: none
      rawData.set(this.indexedBuffer.subarray(y * width, (y + 1) * width), rawRowStart + 1);
    }

    return this.buildIndexedPng(rawData, indexed.palette, job, params);
  }

  private buildIndexedPng(
    rawData: Buffer,
    palette: Uint8Array,
    job: EncodeJob,
    params: PngEncodeParams
  ): Buffer {
    const compressed = deflateSync(rawData, { level: params.pngCompressionLevel });
    return this.assemblePng(PNG_COLOR_TYPE_INDEXED, job.scaledWidth, job.scaledHeight, compressed, palette);
  }

  // Fallback RGB encoding when palette exceeds 256 colors
  private encodePngRgb(rgbData: Uint8Array, job: EncodeJob, params: PngEncodeParams): Buffer {
    const { scaledWidth: width, scaledHeight: height } = job;

    const rowBytes = width * RGB24_BYTES_PER_PIXEL;
    const rawDataSize = height * (1 + rowBytes);
    const rawData = this.getRawDataBuffer(rawDataSize);

    for (let y = 0; y < height; y++) {
      const rawRowStart = y * (1 + rowBytes);
      rawData[rawRowStart] = 0; // Filter type: none
      rawData.set(rgbData.subarray(y * rowBytes, (y + 1) * rowBytes), rawRowStart + 1);
    }

    const compressed = deflateSync(rawData, { level: params.pngCompressionLevel });
    return this.assemblePng(PNG_COLOR_TYPE_RGB, width, height, compressed, null);
  }

  private buildIhdr(width: number, height: number, colorType: number): Buffer {
    const ihdr = this.ihdrBuffer;
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, PNG_IHDR_HEIGHT_OFFSET);
    ihdr[8] = PNG_BIT_DEPTH;
    ihdr[9] = colorType;
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    return ihdr;
  }

  // Assemble the complete PNG in one pooled buffer (signature + chunks),
  // avoiding the per-chunk buffers and the final concat copy. The returned
  // buffer is a view into the pool, valid until the next encode() call.
  // The pool only grows (compressed size varies frame to frame).
  private assemblePng(
    colorType: number,
    width: number,
    height: number,
    compressed: Buffer,
    palette: Uint8Array | null
  ): Buffer {
    const ihdr = this.buildIhdr(width, height, colorType);
    const totalSize =
      PNG_SIGNATURE.length +
      PNG_CHUNK_OVERHEAD + PNG_IHDR_LENGTH +
      (palette === null ? 0 : PNG_CHUNK_OVERHEAD + palette.length) +
      PNG_CHUNK_OVERHEAD + compressed.length +
      PNG_IEND_CHUNK.length;
    if (this.pngBuffer.length < totalSize) {
      this.pngBuffer = Buffer.alloc(totalSize);
    }
    const png = this.pngBuffer.subarray(0, totalSize);
    png.set(PNG_SIGNATURE, 0);
    let offset = PNG_SIGNATURE.length;
    offset = writePngChunk(png, offset, 'IHDR', ihdr);
    if (palette !== null) {
      offset = writePngChunk(png, offset, 'PLTE', palette);
    }
    offset = writePngChunk(png, offset, 'IDAT', compressed);
    png.set(PNG_IEND_CHUNK, offset);
    return png;
  }

  // Reuse the raw scanline buffer across frames (deflateSync reads it synchronously)
  private getRawDataBuffer(size: number): Buffer {
    if (this.rawDataBuffer.length !== size) {
      this.rawDataBuffer = Buffer.alloc(size);
    }
    return this.rawDataBuffer;
  }

  // a=T: transmit and display, f=100: PNG, p=1: placement id,
  // q=2: suppress response, C=1: don't move cursor,
  // c/r: display size in cells. The tail is the medium-specific key
  // (chunking m= for escapes, t=t for files)
  private buildFullControl(meta: KittyFrameMeta, tail: string): string {
    if (meta.placement === 'unicode') {
      // Virtual placement (U=1): the image is composited over host-rendered
      // placeholder cells, not displayed at the cursor. c/r give the cell grid.
      return `a=T,U=1,f=100,i=${meta.currentImageId},q=2,c=${meta.displayCols},r=${meta.displayRows},${tail}`;
    }
    return `a=T,f=100,i=${meta.currentImageId},p=1,q=2,C=1,c=${meta.displayCols},r=${meta.displayRows},${tail}`;
  }

  // a=f: frame data, r=1: edit the root frame (the displayed image),
  // x/y: placement of the rect in scaled pixels, X=1: replace pixels
  private buildDeltaControl(meta: KittyFrameMeta, job: EncodeJob, tail: string): string {
    return `a=f,f=100,i=${meta.currentImageId},r=1,x=${job.scaledX},y=${job.scaledY},X=1,q=2,${tail}`;
  }

  // Build the terminal payload. Full frames: cursor move + a=T transmit-and-
  // display + optional delete of the previous double-buffer image. Delta
  // frames: a single a=f root-frame edit composited in place (X=1 replaces
  // pixels), so no cursor move and no delete.
  private buildPayload(png: Buffer, meta: KittyFrameMeta, job: EncodeJob): string {
    if (
      meta.medium === 'file' &&
      meta.filePath !== undefined &&
      (meta.transmit === 'full' || FILE_MEDIUM_FOR_DELTAS)
    ) {
      try {
        // wx: fail if the path already exists, refusing to follow a
        // pre-existing file or symlink planted by another user on a shared /tmp
        writeFileSync(meta.filePath, png, { flag: 'wx' });
        return this.buildFilePayload(meta.filePath, meta, job);
      } catch {
        // Temp dir unavailable (full disk, removed dir), or the path already
        // existed (wx refused it): fall back to the inline escape payload for
        // this frame; output stays correct
      }
    }

    const base64 = png.toString('base64');
    const chunks: string[] =
      meta.transmit === 'full' && meta.placement !== 'unicode'
        ? [moveCursor(meta.offsetRow, meta.offsetCol)]
        : [];

    for (let i = 0; i < base64.length; i += KITTY_CHUNK_SIZE) {
      const chunk = base64.slice(i, i + KITTY_CHUNK_SIZE);
      const isFirst = i === 0;
      const isLast = i + KITTY_CHUNK_SIZE >= base64.length;
      const more = `m=${isLast ? 0 : 1}`;

      let control: string;
      if (!isFirst) {
        control = more;
      } else if (meta.transmit === 'full') {
        control = this.buildFullControl(meta, more);
      } else {
        control = this.buildDeltaControl(meta, job, more);
      }

      chunks.push(`${APC}${control};${chunk}${ST}`);
    }

    // Delete the previous frame's image after displaying the new one.
    // Unicode placement drives display from placeholder cells (no
    // double-buffer), so it never deletes a previous image.
    if (meta.transmit === 'full' && meta.placement !== 'unicode' && meta.deletePrevious) {
      chunks.push(buildKittyDeleteSequence(meta.previousImageId));
    }

    return chunks.join('');
  }

  // File-medium payload: the escape carries only the base64-encoded path
  // (t=t: the terminal reads and then deletes the file). Never chunked.
  private buildFilePayload(filePath: string, meta: KittyFrameMeta, job: EncodeJob): string {
    const encodedPath = Buffer.from(filePath).toString('base64');
    if (meta.transmit === 'full') {
      const control = this.buildFullControl(meta, 't=t');
      // Unicode placement drives display from placeholder cells: no cursor
      // move to position it and no previous-image delete (no double-buffer).
      const movePrefix =
        meta.placement === 'unicode' ? '' : moveCursor(meta.offsetRow, meta.offsetCol);
      const deleteChunk =
        meta.placement !== 'unicode' && meta.deletePrevious
          ? buildKittyDeleteSequence(meta.previousImageId)
          : '';
      return `${movePrefix}${APC}${control};${encodedPath}${ST}${deleteChunk}`;
    }
    const control = this.buildDeltaControl(meta, job, 't=t');
    return `${APC}${control};${encodedPath}${ST}`;
  }
}
