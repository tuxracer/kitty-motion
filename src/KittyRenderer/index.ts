import { clamp } from '../helpers/index.ts';
import { KittyFrameEncoder, type KittyFrameMeta } from '../kittyEncode/index.ts';
import { KittyEncodeWorkerClient, type WorkerFactory } from '../kittyEncodeWorkerClient/index.ts';
import { allocateFrameBufferLike, convertFrameToRgb24, frameUnitsPerPixel } from '../color/index.ts';
import { APC, ST, clearScreen, hideCursor, showCursor } from '../ansi/index.ts';
import { computeDisplayLayout } from '../displayLayout/index.ts';
import type { CapturedFrame, ColorSpace, FrameBuffer, ScreenRegion } from '../types.ts';
import { computeDirtyRect, fullFrameRect, unionRects, type Rect } from '../dirtyRect/index.ts';
import { unlinkSync } from 'node:fs';
import { frameFilePath, newFrameFileSession, sweepStaleFrameFiles } from '../frameFiles/index.ts';
import {
  buildKittyDeleteSequence,
  getKittyAnimationSupported,
  getKittyFileTransferSupported,
} from '../kittyProtocol/index.ts';
import { resolveRendererOptions } from '../rendererOptions/index.ts';
import { buildPlaceholderRows } from '../placeholder/index.ts';
import type { PostProcessingPipeline } from '../postProcessing/index.ts';
import {
  INITIAL_FULL_RENDER_FRAMES,
  DEFAULT_PNG_COMPRESSION,
  DEFAULT_RENDER_SCALE,
  MIN_RENDER_SCALE,
  MAX_RENDER_SCALE,
  IMAGE_ID_STRIDE,
} from './consts.ts';
import type { KittyRendererOptions } from './types.ts';

export * from './consts.ts';
export * from './types.ts';

// Kitty graphics protocol renderer
// https://sw.kovidgoyal.net/kitty/graphics-protocol/

// Next image-id base handed to a new KittyRenderer. Each instance owns
// IMAGE_ID_STRIDE consecutive ids (for the full-frame double-buffer parity),
// so multiple renderers or Screens in one process never collide. The probe
// image ids live at the top of the 32-bit id space (see
// KITTY_ANIMATION_PROBE_IMAGE_ID), so this range (starting at 1) never reaches
// them in practice, and a probe collision would be harmless anyway since those
// images are deleted during capability detection.
let nextImageIdBase = 1;

export class KittyRenderer {
  private scale: number;  // Scale factor (0.25, 0.5, 1, 2, 3, etc.) - supports both up and downscaling
  private imageId: number;
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
  // Pre-effect pixels for the bounded-spread path (null unless bloom, NTSC,
  // or chromatic aberration is enabled without curvature)
  private preEffectBuffer: Uint8Array | null;
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
  private displayedImageId: number;
  // Alternates full-frame image ids for flicker-free replacement
  private fullFrameParity: number = 0;
  // Optional sub-region of the terminal to confine output to (undefined = whole terminal)
  private region?: ScreenRegion;
  // Non-destructive output for sharing the terminal with a host TUI (skip
  // full-screen clear and global cursor toggles, delete only own images)
  private embedded: boolean;
  // Placement mode: "cursor" displays at a cursor position; "unicode" uses a
  // virtual placement (U=1) composited over host-rendered placeholder cells
  private placement: 'cursor' | 'unicode';

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
    this.preEffectBuffer = common.preEffectBuffer;
    this.region = common.region;
    this.embedded = common.embedded;

    // Claim a unique block of image ids so multiple renderers can coexist
    this.imageId = nextImageIdBase;
    this.displayedImageId = nextImageIdBase;
    nextImageIdBase += IMAGE_ID_STRIDE;

    this.pngCompressionLevel = options.pngCompressionLevel ?? DEFAULT_PNG_COMPRESSION;
    this.encodeWorkerFactory = options.encodeWorkerFactory;
    this.dirtyRects = options.dirtyRects;
    this.fileTransfer = options.fileTransfer;
    this.placement = options.placement ?? 'cursor';
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

    if (this.placement === 'unicode' && !(Number.isInteger(this.scale) && this.scale >= 1)) {
      this.onDebug?.('unicode placement: non-integer scale disables partial deltas, every frame re-sends the full image');
    }

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
      region: this.region,
    });
  }

  // Get display dimensions
  getDisplaySize(): { cols: number; rows: number } {
    return { cols: this.displayCols, rows: this.displayRows };
  }

  // Snapshot the last rendered frame as post-processed RGB24 at source
  // resolution. Returns a copy so the caller can retain it across frames.
  captureRgb(): CapturedFrame {
    return {
      data: new Uint8Array(this.nativeRgbBuffer),
      width: this.sourceWidth,
      height: this.sourceHeight,
    };
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

  // Whether the terminal applies a=f animation frame edits. Kitty does;
  // Ghostty has no animation protocol, so it must re-transmit the image
  // instead. The dirtyRects option overrides the probe result.
  private canEditFrames(): boolean {
    if (this.dirtyRects !== undefined) {
      return this.dirtyRects;
    }
    return getKittyAnimationSupported() === true;
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
    return this.canEditFrames();
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
  private frameToRgbNative(frameBuffer: FrameBuffer, colorSpace: ColorSpace, rect: Rect, target: Uint8Array = this.nativeRgbBuffer): void {
    convertFrameToRgb24(frameBuffer, target, {
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
    // For a unicode full frame: true creates the virtual placement (a=T,U=1),
    // false re-transmits image data to the existing placement (a=t, Ghostty).
    let createPlacement: boolean | undefined;

    if (transmit === 'full') {
      if (this.placement === 'unicode') {
        // Single stable id, no double-buffer. needsFullTransmit is still set
        // here (cleared after this call), so it marks the create vs re-transmit.
        currentImageId = this.imageId;
        this.displayedImageId = this.imageId;
        createPlacement = this.needsFullTransmit;
      } else {
        currentImageId = this.imageId + this.fullFrameParity;
        previousImageId = this.imageId + (1 - this.fullFrameParity);
        deletePrevious = this.frameNumber > 0;
        this.fullFrameParity = 1 - this.fullFrameParity;
        this.displayedImageId = currentImageId;
      }
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
      placement: this.placement,
      createPlacement,
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

    // Damage across this frame and any dropped predecessors (null = no change)
    const damage =
      changed !== null && this.pendingDirty !== null
        ? unionRects(changed, this.pendingDirty)
        : (changed ?? this.pendingDirty);

    // Decide full vs delta and the region to send. Unicode placement never
    // re-transmits except to (re)create the image: a full a=T to a live id
    // deletes its placements, so every non-recreate frame is an a=f edit.
    // Unicode placement (re)creates the virtual placement on a full transmit,
    // otherwise updates pixels. With a=f frame edits (Kitty) that update is a
    // delta; without them (Ghostty) canEditFrames() is false, so every non-
    // create frame stays 'full' and re-transmits the image (a=t) instead.
    const transmit: 'full' | 'delta' =
      this.placement === 'unicode'
        ? this.needsFullTransmit || !this.canEditFrames()
          ? 'full'
          : 'delta'
        : isInitialFrame || this.needsFullTransmit || !this.canUseDelta()
          ? 'full'
          : 'delta';
    // A partial (sub-rectangle) a=f edit only encodes correctly at an integer
    // scale >= 1 (the encoder scales the rect by Math.round(scale)). The cursor
    // path only reaches 'delta' when canUseDelta() guaranteed that, but the
    // unicode path forces delta regardless, so gate the sub-rect there.
    const partialDeltaOk =
      this.placement !== 'unicode' || (Number.isInteger(this.scale) && this.scale >= 1);

    // Processing can narrow to the damage whenever diff state is valid,
    // independent of the transmit mode: pixels outside the damage are
    // unchanged since the last frame, so nativeRgbBuffer already holds
    // their converted, post-processed values. needsFullTransmit marks every
    // diff state reset (first frame, resize, buffer realloc, worker
    // failure). Bounded spread effects (preEffectBuffer allocated) keep the
    // narrowing valid via reach dilation; unbounded ones (curvature) and
    // any other non-local case force full processing.
    const boundedRect =
      !this.needsFullTransmit &&
      (this.preEffectBuffer !== null || !this.postProcessing.hasNonLocalEffects())
        ? damage
        : null;
    const processRect = boundedRect ?? fullFrameRect(this.sourceWidth, this.sourceHeight);

    // The transmitted region: deltas send only the damage (dilated by the
    // effect reach when spread effects are on), full transmits re-encode
    // the whole (fully valid) buffer.
    let dirtyRect = fullFrameRect(this.sourceWidth, this.sourceHeight);
    const preEffect = this.preEffectBuffer;
    if (preEffect !== null) {
      // Bounded spread effects: convert into the pre-effect buffer (kept
      // current everywhere by the rect-bounded conversion), then run the
      // pipeline over the dilated damage, writing final pixels into
      // nativeRgbBuffer. The returned rect covers every output pixel the
      // damage can influence.
      this.frameToRgbNative(frameBuffer, colorSpace, processRect, preEffect);
      const processedRect = this.postProcessing.applyToRect(
        preEffect, this.nativeRgbBuffer, this.sourceWidth, this.sourceHeight, processRect);
      if (transmit === 'delta' && partialDeltaOk && boundedRect !== null) {
        dirtyRect = processedRect;
      }
    } else {
      this.frameToRgbNative(frameBuffer, colorSpace, processRect);
      this.postProcessing.apply(this.nativeRgbBuffer, this.sourceWidth, this.sourceHeight, processRect);
      if (transmit === 'delta' && partialDeltaOk && boundedRect !== null) {
        dirtyRect = boundedRect;
      }
    }

    // Save current frame for next frame's diff check
    this.prevFrameBuffer.set(frameBuffer);

    // Scale + PNG-encode + build the Kitty payload
    const meta = this.buildFrameMeta(transmit, dirtyRect);
    this.frameNumber++;
    this.onDebug?.(`Frame #${this.frameNumber - 1}: ${transmit}, medium=${meta.medium}, imageId=${meta.currentImageId}, rect=${dirtyRect.x},${dirtyRect.y} ${dirtyRect.width}x${dirtyRect.height}, processRect=${processRect.x},${processRect.y} ${processRect.width}x${processRect.height}`);

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

  /**
   * Placeholder text for host-rendered Unicode placement, one string per grid
   * row (each `displayCols` cells wide). Returns [] unless placement is
   * "unicode". Re-fetch when the grid size changes (after a resize).
   */
  getPlaceholderRows(): string[] {
    if (this.placement !== 'unicode') {
      return [];
    }
    return buildPlaceholderRows(this.imageId, this.displayCols, this.displayRows);
  }

  // Clear screen
  clearScreen(): string {
    // Embedded: delete only this instance's own images (leave sibling panels
    // and the rest of the terminal untouched)
    if (this.embedded) {
      // Unicode placement uses a single stable id (no double-buffer), so there
      // is only one image to delete.
      if (this.placement === 'unicode') {
        return buildKittyDeleteSequence(this.imageId);
      }
      return buildKittyDeleteSequence(this.imageId) + buildKittyDeleteSequence(this.imageId + 1);
    }
    // Owned terminal: delete all images and clear the screen
    return `${APC}a=d,d=A,q=2${ST}${clearScreen()}`;
  }

  // Hide cursor (no-op when embedded: the host owns the cursor)
  hideCursor(): string {
    return this.embedded ? '' : hideCursor();
  }

  // Show cursor (no-op when embedded: the host owns the cursor)
  showCursor(): string {
    return this.embedded ? '' : showCursor();
  }

  // Get status row (below the image)
  getStatusRow(): number {
    // We know exactly how many rows the image uses from displayRows
    // Account for vertical centering offset
    return this.offsetRow + this.displayRows;
  }
}
