import { clamp } from '../helpers/index.ts';
import { KittyFrameEncoder, type KittyFrameMeta } from '../kittyEncode/index.ts';
import { KittyEncodeWorkerClient, type WorkerFactory } from '../kittyEncodeWorkerClient/index.ts';
import { allocateFrameBufferLike, convertFrameToRgb24, frameUnitsPerPixel } from '../color/index.ts';
import { APC, ST, clearScreen, hideCursor, showCursor } from '../ansi/index.ts';
import { computeDisplayLayout } from '../displayLayout/index.ts';
import type { ColorSpace, FrameBuffer } from '../types.ts';
import { computeDirtyRect, fullFrameRect, unionRects, type Rect } from '../dirtyRect/index.ts';
import { unlinkSync } from 'node:fs';
import { frameFilePath, newFrameFileSession, sweepStaleFrameFiles } from '../frameFiles/index.ts';
import { getKittyAnimationSupported, getKittyFileTransferSupported } from '../kittyProtocol/index.ts';
import { resolveRendererOptions } from '../rendererOptions/index.ts';
import type { PostProcessingPipeline } from '../postProcessing/index.ts';
import {
  INITIAL_FULL_RENDER_FRAMES,
  DEFAULT_PNG_COMPRESSION,
  DEFAULT_RENDER_SCALE,
  MIN_RENDER_SCALE,
  MAX_RENDER_SCALE,
} from './consts.ts';
import type { KittyRendererOptions } from './types.ts';

export * from './consts.ts';
export * from './types.ts';

// Kitty graphics protocol renderer
// https://sw.kovidgoyal.net/kitty/graphics-protocol/

export class KittyRenderer {
  private scale: number;  // Scale factor (0.25, 0.5, 1, 2, 3, etc.) - supports both up and downscaling
  private imageId: number = 1;
  private frameNumber: number = 0;
  private displayCols: number;
  private displayRows: number;
  private offsetCol: number = 1;  // Horizontal offset for centering
  private offsetRow: number = 1;  // Vertical offset for centering
  // Source framebuffer dimensions
  private sourceWidth: number;
  private sourceHeight: number;
  // Pixel aspect ratio for correct display (e.g., 8/7 for NES)
  private pixelAspectRatio: number;
  // Scaled image dimensions in pixels (integer multiple of source resolution)
  private scaledWidth: number;
  private scaledHeight: number;
  // Pre-allocated RGB buffer for native resolution (before scaling, for post-processing)
  private nativeRgbBuffer: Uint8Array;
  // Previous frame buffer for row-level memoization (skip unchanged rows)
  // For rgb15: Uint16Array (2 bytes per pixel)
  // For rgb24: Uint8Array (3 bytes per pixel)
  private prevFrameBuffer: Uint8Array | Uint16Array;
  // Scale + PNG + Kitty payload encoder (sync path; the worker has its own)
  private encoder = new KittyFrameEncoder();
  // Worker offload: encode off the main thread when an output sink is attached
  private workerClient: KittyEncodeWorkerClient | null = null;
  private outputSink: ((chunk: string) => boolean) | null = null;
  private encodeWorkerFactory?: WorkerFactory;
  // Color space for framebuffer interpretation
  private colorSpace: ColorSpace;
  // Diff-based rendering optimization
  private enableDiffRendering: boolean;
  // Color mode (true = full color, false = grayscale)
  private colorEnabled: boolean;
  // PNG compression level (1-9, higher = smaller but slower)
  private pngCompressionLevel: number;
  // Gamma lookup table for frame conversion
  private gammaLUT: Uint8Array;
  // True when gamma is 1.0 and the LUT is an identity mapping
  private hasIdentityGamma: boolean;
  // Post-processing effects pipeline
  private postProcessing: PostProcessingPipeline;
  // Rows to reserve outside the image display area (e.g. for a status line)
  private reservedRows: number;
  // Optional sink for internal diagnostic messages
  private onDebug?: (message: string) => void;
  // Dirty-rect override: undefined = follow the animation-support probe
  private dirtyRects?: boolean;
  // File-transfer override: undefined = follow the shared-filesystem probe
  private fileTransfer?: boolean;
  // Per-renderer token and counter for collision-free frame file names
  private fileSession: string = newFrameFileSession();
  private fileSeq: number = 0;
  // Damage from frames whose payload was dropped; folded into the next frame
  private pendingDirty: Rect | null = null;
  // Force the next frame to be a full a=T transmission
  private needsFullTransmit: boolean = true;
  // Image id of the last full transmission (deltas edit this image)
  private displayedImageId: number = 1;
  // Alternates full-frame image ids for flicker-free replacement
  private fullFrameParity: number = 0;

  constructor(options: KittyRendererOptions = {}) {
    const common = resolveRendererOptions(options);
    this.sourceWidth = common.sourceWidth;
    this.sourceHeight = common.sourceHeight;
    this.colorSpace = common.colorSpace;
    this.pixelAspectRatio = common.pixelAspectRatio;
    this.enableDiffRendering = common.enableDiffRendering;
    this.colorEnabled = common.colorEnabled;
    this.reservedRows = common.reservedRows;
    this.onDebug = common.onDebug;
    this.gammaLUT = common.gammaLUT;
    this.hasIdentityGamma = common.hasIdentityGamma;
    this.postProcessing = common.postProcessing;
    this.prevFrameBuffer = common.prevFrameBuffer;
    this.nativeRgbBuffer = common.nativeRgbBuffer;

    this.pngCompressionLevel = options.pngCompressionLevel ?? DEFAULT_PNG_COMPRESSION;
    this.encodeWorkerFactory = options.encodeWorkerFactory;
    this.dirtyRects = options.dirtyRects;
    this.fileTransfer = options.fileTransfer;
    if (options.fileTransfer !== false) {
      // Remove frame files leaked by crashed processes before creating new ones
      sweepStaleFrameFiles();
    }

    // Render scale controls internal buffer resolution (default: DEFAULT_RENDER_SCALE)
    // Display size always fills terminal, Kitty handles the final scaling
    // Integer upscales use the fast pixel-duplication path. Fractional
    // scales in either direction sample with nearest-neighbor
    const rawScale = options.scale ?? DEFAULT_RENDER_SCALE;
    this.scale = clamp(rawScale, MIN_RENDER_SCALE, MAX_RENDER_SCALE);

    // Calculate display size to fill terminal (Kitty will scale the image)
    const { cols, rows, offsetCol, offsetRow } = this.calculateDisplaySize();
    this.displayCols = cols;
    this.displayRows = rows;
    this.offsetCol = offsetCol;
    this.offsetRow = offsetRow;

    // Internal buffer uses render scale (round to ensure integer dimensions)
    this.scaledWidth = Math.max(1, Math.round(this.sourceWidth * this.scale));
    this.scaledHeight = Math.max(1, Math.round(this.sourceHeight * this.scale));

    this.onDebug?.(`Init: sourceSize=${this.sourceWidth}x${this.sourceHeight}, scale=${this.scale}, scaledSize=${this.scaledWidth}x${this.scaledHeight}`);
    this.onDebug?.(`Init: displayCols=${this.displayCols}, displayRows=${this.displayRows}, colorSpace=${this.colorSpace}`);
    this.onDebug?.(`Init: pngCompression=${this.pngCompressionLevel}, diffRendering=${this.enableDiffRendering}`);
  }

  // Cleanup: terminate the encode worker if one was started
  destroy(): void {
    this.onDebug?.(`Destroy: frameNumber=${this.frameNumber}`);
    this.workerClient?.destroy();
    this.workerClient = null;
  }

  /**
   * Attach a sink for asynchronously encoded frames. Once attached, frames
   * are encoded on a worker thread and delivered to the sink instead of being
   * returned from renderRgb15/renderRgb24 (which then return '').
   * Falls back to synchronous inline encoding if the worker is unavailable.
   */
  setOutputSink(sink: (chunk: string) => boolean): void {
    this.outputSink = sink;
    this.workerClient ??= new KittyEncodeWorkerClient(
      (payload) => this.outputSink?.(payload) ?? false,
      {
        workerFactory: this.encodeWorkerFactory,
        // A dying worker may lose in-flight frames while prevFrameBuffer
        // already recorded them as drawn. Restart the initial-frame window so
        // the next frames render fully via the sync path.
        onFailure: () => {
          this.frameNumber = 0;
          this.needsFullTransmit = true;
        },
        onPayloadDropped: (meta) => this.notePayloadDropped(meta),
      },
    );
  }

  // Calculate display size to fill terminal while maintaining aspect ratio
  // Kitty handles scaling from internal buffer to display size
  private calculateDisplaySize(): { cols: number; rows: number; offsetCol: number; offsetRow: number } {
    return computeDisplayLayout({
      sourceWidth: this.sourceWidth,
      sourceHeight: this.sourceHeight,
      pixelAspectRatio: this.pixelAspectRatio,
      reservedRows: this.reservedRows,
    });
  }

  // Get display dimensions
  getDisplaySize(): { cols: number; rows: number } {
    return { cols: this.displayCols, rows: this.displayRows };
  }

  // Update display dimensions (for terminal resize handling)
  // Internal buffer scale stays fixed, only display size changes
  setDimensions(): void {
    const { cols, rows, offsetCol, offsetRow } = this.calculateDisplaySize();
    this.displayCols = cols;
    this.displayRows = rows;
    this.offsetCol = offsetCol;
    this.offsetRow = offsetRow;

    // The host clears the screen (deleting all images) on resize, so the
    // next frame must retransmit fully
    this.needsFullTransmit = true;
  }

  // A payload was encoded but could not be written; remember its damage so
  // the region is re-sent with the next frame instead of staying stale.
  private notePayloadDropped(meta: KittyFrameMeta): void {
    // The escape never reached the terminal, so the t=t deletion will never
    // happen: remove the frame file ourselves (best effort, synchronous so
    // tests and dispose ordering stay deterministic; drops are rare)
    if (meta.filePath !== undefined) {
      try {
        unlinkSync(meta.filePath);
      } catch {
        // Encoder fell back inline (file never written) or already deleted
      }
    }
    if (meta.transmit === 'full') {
      this.needsFullTransmit = true;
      return;
    }
    this.pendingDirty =
      this.pendingDirty === null ? meta.dirtyRect : unionRects(this.pendingDirty, meta.dirtyRect);
  }

  // Delta frames require diff state, an exact integer mapping to scaled
  // coordinates, and a terminal that supports animation frame edits
  private canUseDelta(): boolean {
    if (!this.enableDiffRendering) {
      return false;
    }
    if (!Number.isInteger(this.scale) || this.scale < 1) {
      return false;
    }
    if (this.dirtyRects !== undefined) {
      return this.dirtyRects;
    }
    return getKittyAnimationSupported() === true;
  }

  // File medium requires a terminal that answered the shared-filesystem probe
  private canUseFileMedium(): boolean {
    if (this.fileTransfer !== undefined) {
      return this.fileTransfer;
    }
    return getKittyFileTransferSupported() === true;
  }

  // Convert frame to RGB at native resolution (no scaling), bounded to rect
  // Handles all color spaces: rgb15, rgb24
  private frameToRgbNative(frameBuffer: FrameBuffer, colorSpace: ColorSpace, rect: Rect): void {
    convertFrameToRgb24(frameBuffer, this.nativeRgbBuffer, {
      colorSpace,
      width: this.sourceWidth,
      height: this.sourceHeight,
      gammaLUT: this.gammaLUT,
      hasIdentityGamma: this.hasIdentityGamma,
      colorEnabled: this.colorEnabled,
      rect,
    });
  }

  // Build the per-frame metadata handed to the encoder (sync or worker).
  // Full frames alternate between two image ids for a double-buffering
  // effect; the previous image is deleted after the new one is displayed.
  // Delta frames edit the last fully transmitted image in place.
  private buildFrameMeta(transmit: 'full' | 'delta', dirtyRect: Rect): KittyFrameMeta {
    let currentImageId = this.displayedImageId;
    let previousImageId = this.displayedImageId;
    let deletePrevious = false;

    if (transmit === 'full') {
      currentImageId = this.imageId + this.fullFrameParity;
      previousImageId = this.imageId + (1 - this.fullFrameParity);
      deletePrevious = this.frameNumber > 0;
      this.fullFrameParity = 1 - this.fullFrameParity;
      this.displayedImageId = currentImageId;
    }

    const medium: 'escape' | 'file' = this.canUseFileMedium() ? 'file' : 'escape';
    const filePath = medium === 'file' ? frameFilePath(this.fileSession, this.fileSeq++) : undefined;

    return {
      sourceWidth: this.sourceWidth,
      sourceHeight: this.sourceHeight,
      scale: this.scale,
      scaledWidth: this.scaledWidth,
      scaledHeight: this.scaledHeight,
      pngCompressionLevel: this.pngCompressionLevel,
      displayCols: this.displayCols,
      displayRows: this.displayRows,
      offsetRow: this.offsetRow,
      offsetCol: this.offsetCol,
      currentImageId,
      previousImageId,
      deletePrevious,
      transmit,
      dirtyRect,
      medium,
      filePath,
    };
  }

  // Unified render method for all color spaces
  private renderInternal(
    frameBuffer: FrameBuffer,
    colorSpace: ColorSpace
  ): string {
    // Check if frame buffer size changed (can happen with SNES resolution changes)
    // If so, reallocate prevFrameBuffer to match
    if (frameBuffer.length !== this.prevFrameBuffer.length) {
      this.prevFrameBuffer = allocateFrameBufferLike(frameBuffer);
      this.needsFullTransmit = true;
    }

    // Force full rendering for initial frames to ensure display is populated
    const isInitialFrame = this.frameNumber < INITIAL_FULL_RENDER_FRAMES;

    const unitsPerPixel = frameUnitsPerPixel(colorSpace);
    const changed = this.enableDiffRendering
      ? computeDirtyRect(frameBuffer, this.prevFrameBuffer, this.sourceWidth, this.sourceHeight, unitsPerPixel)
      : fullFrameRect(this.sourceWidth, this.sourceHeight);

    // Skip entirely if the frame is unchanged and nothing forces a transmit
    if (changed === null && !isInitialFrame && !this.needsFullTransmit && this.pendingDirty === null) {
      this.onDebug?.(`Frame ${this.frameNumber}: SKIPPED (unchanged)`);
      return '';
    }

    // Decide full vs delta and the region to send
    const transmit: 'full' | 'delta' =
      isInitialFrame || this.needsFullTransmit || !this.canUseDelta() ? 'full' : 'delta';
    let dirtyRect = fullFrameRect(this.sourceWidth, this.sourceHeight);
    if (transmit === 'delta' && !this.postProcessing.hasNonLocalEffects()) {
      const damage =
        changed !== null && this.pendingDirty !== null
          ? unionRects(changed, this.pendingDirty)
          : (changed ?? this.pendingDirty);
      if (damage !== null) {
        dirtyRect = damage;
      }
    }

    // Convert and post-process only within the transmitted rect: pixels
    // outside it are unchanged since the last frame, so nativeRgbBuffer
    // already holds their processed values (full transmits, forced whenever
    // diff state resets or a non-local effect is active, cover the frame)
    this.frameToRgbNative(frameBuffer, colorSpace, dirtyRect);

    // Save current frame for next frame's diff check
    this.prevFrameBuffer.set(frameBuffer);

    // Apply post-processing effects at native resolution (much faster than scaled)
    this.postProcessing.apply(this.nativeRgbBuffer, this.sourceWidth, this.sourceHeight, dirtyRect);

    // Scale + PNG-encode + build the Kitty payload
    const meta = this.buildFrameMeta(transmit, dirtyRect);
    this.frameNumber++;
    this.onDebug?.(`Frame #${this.frameNumber - 1}: ${transmit}, medium=${meta.medium}, imageId=${meta.currentImageId}, rect=${dirtyRect.x},${dirtyRect.y} ${dirtyRect.width}x${dirtyRect.height}`);

    // The frame is now in flight; drops re-accumulate via notePayloadDropped
    this.pendingDirty = null;
    if (transmit === 'full') {
      this.needsFullTransmit = false;
    }

    // Worker offload: encode off the main thread, deliver via the sink
    if (this.outputSink !== null && this.workerClient?.isAvailable()) {
      this.workerClient.submit(this.nativeRgbBuffer, meta);
      return '';
    }

    return this.encoder.encode(this.nativeRgbBuffer, meta);
  }

  // Render RGB15 frame buffer to Kitty graphics
  renderRgb15(frameBuffer: Uint16Array): string {
    return this.renderInternal(frameBuffer, 'rgb15');
  }

  // Render RGB24 frame buffer to Kitty graphics
  renderRgb24(frameBuffer: Uint8Array): string {
    return this.renderInternal(frameBuffer, 'rgb24');
  }

  // Clear screen
  clearScreen(): string {
    // Delete all images and clear screen
    return `${APC}a=d,d=A,q=2${ST}${clearScreen()}`;
  }

  // Hide cursor
  hideCursor(): string {
    return hideCursor();
  }

  // Show cursor
  showCursor(): string {
    return showCursor();
  }

  // Get status row (below the image)
  getStatusRow(): number {
    // We know exactly how many rows the image uses from displayRows
    // Account for vertical centering offset
    return this.offsetRow + this.displayRows;
  }
}
