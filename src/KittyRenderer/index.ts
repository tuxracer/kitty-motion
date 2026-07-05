import { clamp } from '../helpers';
import { PostProcessingPipeline, type EffectOptions } from '../postProcessing';
import { KittyFrameEncoder, type KittyFrameMeta } from '../kittyEncode';
import { KittyEncodeWorkerClient, type WorkerFactory } from '../kittyEncodeWorkerClient';
import { buildGammaLUT, rgb15ToRgb24, calculateLuminance8 } from '../color';
import { getTerminalDimensions, getCellPixelSize } from '../terminal';
import { APC, ST, clearScreen, clearLine, hideCursor, showCursor, moveCursor } from '../ansi';
import { fitToTerminal } from '../fitToTerminal';
import { kittyGridAspectRatio } from '../aspect';
import { isRgb15Buffer, type FrameBuffer } from '../types';
import {
  DEFAULT_NATIVE_WIDTH,
  DEFAULT_NATIVE_HEIGHT,
  CELL_WIDTH_PX,
  CELL_HEIGHT_PX,
  INITIAL_FULL_RENDER_FRAMES,
  DEFAULT_PNG_COMPRESSION,
  DEFAULT_RENDER_SCALE,
  MIN_RENDER_SCALE,
  MAX_RENDER_SCALE,
  DEFAULT_GAMMA,
  RGB24_BYTES_PER_PIXEL,
} from '../consts';

// Kitty graphics protocol renderer
// https://sw.kovidgoyal.net/kitty/graphics-protocol/

export interface KittyRendererOptions extends EffectOptions {
  scale?: number;  // Scale factor for the image (undefined = auto-fit to terminal)
  sourceWidth?: number;   // Source framebuffer width (default: 256)
  sourceHeight?: number;  // Source framebuffer height (default: 240)
  colorSpace?: 'rgb15' | 'rgb24';  // Color format (default: rgb24)
  pixelAspectRatio?: number;  // Pixel aspect ratio for correct display (default: 1.0)
  enableDiffRendering?: boolean;  // Enable diff-based rendering optimization (default: true)
  colorEnabled?: boolean;  // When false, render in grayscale (default: true)
  pngCompressionLevel?: number;  // PNG compression level 1-9 (default: 1, higher = smaller but slower)
  encodeWorkerFactory?: WorkerFactory;  // Override encode-worker creation (tests, embedding)
  reservedRows?: number;  // Rows to reserve outside the image display area, e.g. for a status line (default: 0)
  onDebug?: (message: string) => void;  // Optional sink for internal diagnostic messages
}

// Color space type for frame conversion
type ColorSpace = 'rgb15' | 'rgb24';

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
  private nativeRgbBuffer!: Uint8Array;
  // Previous frame buffer for row-level memoization (skip unchanged rows)
  // For rgb15: Uint16Array (2 bytes per pixel)
  // For rgb24: Uint8Array (3 bytes per pixel)
  private prevFrameBuffer: Uint8Array | Uint16Array;
  // Scale + PNG + Kitty payload encoder (sync path; the worker has its own)
  private encoder = new KittyFrameEncoder();
  // Worker offload: encode off the main thread when an output sink is attached
  private workerClient: KittyEncodeWorkerClient | null = null;
  private outputSink: ((chunk: string) => void) | null = null;
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

  constructor(options: KittyRendererOptions = {}) {
    this.sourceWidth = options.sourceWidth ?? DEFAULT_NATIVE_WIDTH;
    this.sourceHeight = options.sourceHeight ?? DEFAULT_NATIVE_HEIGHT;
    this.colorSpace = options.colorSpace ?? 'rgb24';
    this.pixelAspectRatio = options.pixelAspectRatio ?? 1.0;
    this.enableDiffRendering = options.enableDiffRendering ?? true;
    this.colorEnabled = options.colorEnabled ?? true;
    this.pngCompressionLevel = options.pngCompressionLevel ?? DEFAULT_PNG_COMPRESSION;
    this.encodeWorkerFactory = options.encodeWorkerFactory;
    this.reservedRows = options.reservedRows ?? 0;
    this.onDebug = options.onDebug;

    // Build gamma LUT for frame conversion (separate from post-processing)
    const gamma = options.gamma ?? DEFAULT_GAMMA;
    this.gammaLUT = buildGammaLUT(gamma);
    this.hasIdentityGamma = gamma === 1.0;

    // Create post-processing pipeline with effect options
    this.postProcessing = new PostProcessingPipeline({
      gamma,
      scanlines: options.scanlines,
      saturation: options.saturation,
      brightness: options.brightness,
      contrast: options.contrast,
      vignette: options.vignette,
      bloom: options.bloom,
      bloomThreshold: options.bloomThreshold,
      ntsc: options.ntsc,
      curvature: options.curvature,
      chromaticAberration: options.chromaticAberration,
    });

    // Allocate prevFrameBuffer based on color space
    const pixelCount = this.sourceWidth * this.sourceHeight;
    if (this.colorSpace === 'rgb15') {
      this.prevFrameBuffer = new Uint16Array(pixelCount);
    } else {
      this.prevFrameBuffer = new Uint8Array(pixelCount * RGB24_BYTES_PER_PIXEL);
    }

    // Render scale controls internal buffer resolution (default: DEFAULT_RENDER_SCALE)
    // Display size always fills terminal, Kitty handles the final scaling
    // Supports fractional scales (0.25, 0.5) for downscaling and integer scales (1, 2, 3, 4) for upscaling
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

    // Allocate native-resolution buffer for post-processing (the encoder owns scaled buffers)
    this.nativeRgbBuffer = new Uint8Array(this.sourceWidth * this.sourceHeight * RGB24_BYTES_PER_PIXEL);

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
  setOutputSink(sink: (chunk: string) => void): void {
    this.outputSink = sink;
    this.workerClient ??= new KittyEncodeWorkerClient(
      (payload) => this.outputSink?.(payload),
      {
        workerFactory: this.encodeWorkerFactory,
        // A dying worker may lose in-flight frames while prevFrameBuffer
        // already recorded them as drawn. Restart the initial-frame window so
        // the next frames render fully via the sync path.
        onFailure: () => {
          this.frameNumber = 0;
        },
      },
    );
  }

  // Calculate display size to fill terminal while maintaining aspect ratio
  // Kitty handles scaling from internal buffer to display size
  private calculateDisplaySize(): { cols: number; rows: number; offsetCol: number; offsetRow: number } {
    const { width: termCols, height: termRows } = getTerminalDimensions();

    const availableRows = termRows - this.reservedRows;
    const availableCols = termCols;

    // Kitty scales the image to exactly fill the requested cell grid, so the
    // on-screen aspect ratio is (cols * cellWidthPx) / (rows * cellHeightPx).
    // Use the terminal's *actual* cell pixel size (queried at startup) so the
    // display looks correct regardless of the user's font width. Fall back to
    // a typical cell ratio when the terminal doesn't report its cell size.
    const measuredCell = getCellPixelSize();
    const cellWidthPx = measuredCell ? measuredCell.width : CELL_WIDTH_PX;
    const cellHeightPx = measuredCell ? measuredCell.height : CELL_HEIGHT_PX;

    // For NES (256x240, 8:7 PAR) on a 9x18 cell: cols ≈ rows * 2.438
    // For GBC (160x144, 1:1 PAR) on a 9x18 cell: cols ≈ rows * 2.222
    const aspectRatio = kittyGridAspectRatio(
      this.sourceWidth,
      this.sourceHeight,
      this.pixelAspectRatio,
      cellWidthPx,
      cellHeightPx
    );

    const { width: displayCols, height: displayRows } = fitToTerminal({
      availableCols,
      availableRows,
      aspectRatio,
    });

    // Calculate centering offsets (1-based for ANSI escape sequences)
    const offsetCol = Math.max(1, Math.floor((termCols - displayCols) / 2) + 1);
    const offsetRow = Math.max(1, Math.floor((availableRows - displayRows) / 2) + 1);

    return { cols: displayCols, rows: displayRows, offsetCol, offsetRow };
  }

  // Get current scale (useful for display info)
  getScale(): number {
    return this.scale;
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
  }

  // Generic frame comparison - check if entire frame is unchanged
  private isFrameUnchanged(frameBuffer: Uint8Array | Uint16Array): boolean {
    const prev = this.prevFrameBuffer;
    const len = frameBuffer.length;
    for (let i = 0; i < len; i++) {
      if (frameBuffer[i] !== prev[i]) {return false;}
    }
    return true;
  }

  // Convert frame to RGB at native resolution (no scaling)
  // Handles all color spaces: rgb15, rgb24
  private frameToRgbNative(
    frameBuffer: FrameBuffer,
    colorSpace: ColorSpace
  ): void {
    const dst = this.nativeRgbBuffer;

    // Fast path: rgb24 with identity gamma and color enabled is a plain copy
    if (
      colorSpace === 'rgb24' &&
      frameBuffer instanceof Uint8Array &&
      this.colorEnabled &&
      this.hasIdentityGamma
    ) {
      dst.set(frameBuffer);
      return;
    }

    const gammaLUT = this.gammaLUT;
    const colorEnabled = this.colorEnabled;
    const width = this.sourceWidth;
    const height = this.sourceHeight;

    for (let y = 0; y < height; y++) {
      const srcRowStart = colorSpace === 'rgb24'
        ? y * width * RGB24_BYTES_PER_PIXEL
        : y * width;
      const dstRowStart = y * width * RGB24_BYTES_PER_PIXEL;

      for (let x = 0; x < width; x++) {
        let r: number, g: number, b: number;

        if (isRgb15Buffer(colorSpace, frameBuffer)) {
          // RGB15: XBBBBBGGGGGRRRRR (5 bits per channel)
          const color = frameBuffer[srcRowStart + x];
          const [r8, g8, b8] = rgb15ToRgb24(color);
          r = gammaLUT[r8];
          g = gammaLUT[g8];
          b = gammaLUT[b8];
        } else {
          // RGB24: direct 8-bit channels
          const srcIdx = srcRowStart + x * RGB24_BYTES_PER_PIXEL;
          r = gammaLUT[frameBuffer[srcIdx]];
          g = gammaLUT[frameBuffer[srcIdx + 1]];
          b = gammaLUT[frameBuffer[srcIdx + 2]];
        }

        // Convert to grayscale if color is disabled
        const dstIdx = dstRowStart + x * RGB24_BYTES_PER_PIXEL;
        if (!colorEnabled) {
          const gray = calculateLuminance8(r, g, b);
          dst[dstIdx] = gray;
          dst[dstIdx + 1] = gray;
          dst[dstIdx + 2] = gray;
        } else {
          dst[dstIdx] = r;
          dst[dstIdx + 1] = g;
          dst[dstIdx + 2] = b;
        }
      }
    }
  }

  // Build the per-frame metadata handed to the encoder (sync or worker).
  // Alternating image ids provide a double-buffering effect; the previous
  // frame's image is deleted after the new one is displayed.
  private buildFrameMeta(): KittyFrameMeta {
    const currentImageId = this.imageId + (this.frameNumber % 2);
    const previousImageId = this.imageId + ((this.frameNumber + 1) % 2);
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
      deletePrevious: this.frameNumber > 0,
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
      if (frameBuffer instanceof Uint16Array) {
        this.prevFrameBuffer = new Uint16Array(frameBuffer.length);
      } else {
        this.prevFrameBuffer = new Uint8Array(frameBuffer.length);
      }
    }

    // Force full rendering for initial frames to ensure display is populated
    const isInitialFrame = this.frameNumber < INITIAL_FULL_RENDER_FRAMES;

    // Skip entirely if frame unchanged (after initial frames)
    if (this.enableDiffRendering && !isInitialFrame && this.isFrameUnchanged(frameBuffer)) {
      this.onDebug?.(`Frame ${this.frameNumber}: SKIPPED (unchanged)`);
      return '';
    }

    // Convert frame to RGB at native resolution
    this.frameToRgbNative(frameBuffer, colorSpace);

    // Save current frame for next frame's diff check
    this.prevFrameBuffer.set(frameBuffer);

    // Apply post-processing effects at native resolution (much faster than scaled)
    this.postProcessing.apply(this.nativeRgbBuffer, this.sourceWidth, this.sourceHeight);

    // Scale + PNG-encode + build the Kitty payload (includes the cursor move)
    const meta = this.buildFrameMeta();
    this.frameNumber++;
    this.onDebug?.(`Frame #${this.frameNumber - 1}: imageId=${meta.currentImageId}, prevId=${meta.previousImageId}`);

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

  // Move cursor to status row
  moveCursorToRow(row: number): string {
    return moveCursor(row, 1) + clearLine();
  }
}
