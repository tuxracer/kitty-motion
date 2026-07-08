import {
  allocateFrameBufferLike,
  buildAnsi16LUT,
  buildAnsi256LUT,
  buildEmojiLUT,
  calculateLuminance8,
  convertFrameToRgb24,
  EMOJI_GLYPHS,
  frameUnitsPerPixel,
  getLinearLightLUTs,
  MAX_8BIT,
  paletteLUTIndex,
} from '../color/index.ts';
import {
  ASCII_CHARS,
  createAsciiLookup,
  enhanceAsciiContrast,
  SHAPE_REGION_COLS,
  SHAPE_REGION_ROWS,
  SHAPE_VECTOR_DIMS,
  type AsciiLookup,
} from '../asciiShapes/index.ts';
import { clamp } from '../helpers/index.ts';
import { computeDisplayLayout } from '../displayLayout/index.ts';
import {
  detectCellRenderMode,
  detectColorDepth,
  COLOR_DEPTH_16,
  COLOR_DEPTH_256,
} from '../terminal/index.ts';
import type { PostProcessingPipeline } from '../postProcessing/index.ts';
import { clearScreen, hideCursor, moveCursor, showCursor } from '../ansi/index.ts';
import { computeDirtyRect, isFullFrameRect, type Rect } from '../dirtyRect/index.ts';
import type {
  CapturedFrame,
  CellRenderMode,
  CellSampling,
  ColorDepth,
  ColorSpace,
  FrameBuffer,
} from '../types.ts';
import { RGB24_BYTES_PER_PIXEL } from '../consts.ts';
import { resolveRendererOptions } from '../rendererOptions/index.ts';
import {
  HALF_BLOCK_GLYPH,
  CELL_PIXELS_Y,
  BACKGROUND_GLYPH,
  BACKGROUND_CELL_PIXELS_Y,
  EMOJI_COLUMNS_PER_CELL,
  DEFAULT_CELL_SAMPLING,
  ASCII_SAMPLE_MAX_COLS,
  ASCII_SAMPLE_MAX_ROWS,
  SAMPLE_CENTER_OFFSET,
  SGR_RESET,
  NO_ACTIVE_COLOR,
  COLOR_KEY_RED_SHIFT,
  COLOR_KEY_GREEN_SHIFT,
  BYTE_MASK,
  DECIMAL_BYTES,
  SGR_FG_TRUECOLOR_PREFIX,
  SGR_BG_TRUECOLOR_PREFIX,
  SGR_FG_256,
  SGR_BG_256,
  SGR_FG_16,
  SGR_BG_16,
} from './consts.ts';
import type { CellBounds, CellLayout, CellRendererOptions } from './types.ts';

export * from './consts.ts';
export * from './types.ts';

/**
 * Fallback renderer for terminals without the Kitty graphics protocol.
 * In half-block mode (the default), each cell renders as an upper half
 * block: the foreground color paints the cell's top pixel and the
 * background color its bottom pixel, giving 1x2 pixels per cell with exact
 * color. In background mode (auto-selected on Terminal.app, whose
 * font-drawn block glyphs do not tile the cell), each cell renders as a
 * space with only a background color, giving 1x1 pixels per cell. In ascii
 * mode, each cell is sampled into a 6-region luminance vector (2 cols x 3
 * rows) and drawn as the printable ASCII glyph whose shape best matches,
 * colorized by the cell's average color via an SGR foreground (no
 * background). Emission is diffed at the cell level: after the first paint
 * only changed cells
 * are re-sent, addressed by cursor moves, with redundant SGR color changes
 * elided. Output is plain SGR text, so it renders correctly on any color
 * terminal.
 */
export class CellRenderer {
  private sourceWidth: number;
  private sourceHeight: number;
  private pixelAspectRatio: number;
  private enableDiffRendering: boolean;
  private colorEnabled: boolean;
  private reservedRows: number;
  private onDebug?: (message: string) => void;
  private colorDepth: ColorDepth;
  private renderMode: CellRenderMode;
  // Derived from renderMode (vertical pixels per cell and the emitted glyph)
  private pixelsPerCell: number;
  private glyph: string;
  // Terminal columns each cell occupies (2 for double-wide emoji, else 1)
  private columnsPerCell: number;
  // Emoji glyphs indexed by palette index in emoji mode, null otherwise
  private emojiGlyphs: readonly string[] | null;
  // ASCII glyphs indexed by shape index in ascii mode, null otherwise
  private asciiChars: readonly string[] | null;
  // Nearest-shape lookup (quantization cache) in ascii mode, null otherwise
  private asciiLookup: AsciiLookup | null;
  private cellSampling: CellSampling;
  // Linear-light LUT pair for gamma-correct box averaging
  private toLinear: Uint16Array;
  private toSrgb: Uint8Array;
  private layoutOverride?: CellLayout;
  private frameNumber: number = 0;
  // Resolved layout
  private cols!: number;
  private rows!: number;
  private offsetCol!: number;
  private offsetRow!: number;
  // Target pixel grid (cols by rows * CELL_PIXELS_Y)
  private targetWidth!: number;
  private targetHeight!: number;
  // Buffers
  private nativeRgbBuffer: Uint8Array;
  private targetRgbBuffer!: Uint8Array;
  private cellFg!: Uint32Array;
  private cellBg!: Uint32Array;
  private prevFg!: Uint32Array;
  private prevBg!: Uint32Array;
  // Per-column source bounds for the box filter (depend only on the layout,
  // so they are precomputed here instead of per row inside downsample)
  private boxX0!: Int32Array;
  private boxX1!: Int32Array;
  // Per-column source center for nearest sampling, precomputed like boxX0
  private centerX!: Int32Array;
  private prevFrameBuffer: Uint8Array | Uint16Array;
  // Force the next frame to repaint every cell (first frame, resize)
  private needsFullPaint: boolean = true;
  // Cells emitted by the last paintDiff (diagnostics only)
  private diffCellCount: number = 0;
  // Frame conversion
  private gammaLUT: Uint8Array;
  private hasIdentityGamma: boolean;
  private postProcessing: PostProcessingPipeline;
  // Quantization LUT for 16/256-color modes (null in truecolor mode)
  private paletteLUT: Uint8Array | null;

  constructor(options: CellRendererOptions = {}) {
    const common = resolveRendererOptions(options);
    this.sourceWidth = common.sourceWidth;
    this.sourceHeight = common.sourceHeight;
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

    this.colorDepth = options.limitColors ?? detectColorDepth();
    this.renderMode = options.renderMode ?? detectCellRenderMode();
    this.pixelsPerCell =
      this.renderMode === 'half-block'
        ? CELL_PIXELS_Y
        : this.renderMode === 'ascii'
          ? SHAPE_REGION_ROWS
          : BACKGROUND_CELL_PIXELS_Y;
    this.glyph = this.renderMode === 'half-block' ? HALF_BLOCK_GLYPH : BACKGROUND_GLYPH;
    this.columnsPerCell = this.renderMode === 'emoji' ? EMOJI_COLUMNS_PER_CELL : 1;
    this.emojiGlyphs = this.renderMode === 'emoji' ? EMOJI_GLYPHS : null;
    this.asciiChars = this.renderMode === 'ascii' ? ASCII_CHARS : null;
    this.asciiLookup = this.renderMode === 'ascii' ? createAsciiLookup() : null;
    this.cellSampling = options.cellSampling ?? DEFAULT_CELL_SAMPLING;
    const linearLUTs = getLinearLightLUTs();
    this.toLinear = linearLUTs.toLinear;
    this.toSrgb = linearLUTs.toSrgb;
    this.layoutOverride = options.layout;

    if (this.renderMode === 'emoji') {
      this.paletteLUT = buildEmojiLUT(); // fixed emoji palette; limitColors is ignored
    } else if (this.colorDepth === COLOR_DEPTH_16) {
      this.paletteLUT = buildAnsi16LUT();
    } else if (this.colorDepth === COLOR_DEPTH_256) {
      this.paletteLUT = buildAnsi256LUT();
    } else {
      this.paletteLUT = null; // Truecolor (colorDepth === 0) packs exact rgb
    }

    this.allocateGrid();
    this.onDebug?.(
      `Init: renderMode=${this.renderMode}, colorDepth=${this.colorDepth === 0 ? 'truecolor' : this.colorDepth}, sampling=${this.cellSampling}, display=${this.cols}x${this.rows}`,
    );
  }

  // Resolve the layout and (re)allocate grid-sized buffers
  private allocateGrid(): void {
    const layout =
      this.layoutOverride ??
      computeDisplayLayout({
        sourceWidth: this.sourceWidth,
        sourceHeight: this.sourceHeight,
        pixelAspectRatio: this.pixelAspectRatio,
        reservedRows: this.reservedRows,
        columnsPerCell: this.columnsPerCell,
      });
    this.cols = layout.cols;
    this.rows = layout.rows;
    this.offsetCol = layout.offsetCol;
    this.offsetRow = layout.offsetRow;

    this.targetWidth = this.cols;
    this.targetHeight = this.rows * this.pixelsPerCell;
    this.targetRgbBuffer = new Uint8Array(this.targetWidth * this.targetHeight * RGB24_BYTES_PER_PIXEL);

    this.boxX0 = new Int32Array(this.targetWidth);
    this.boxX1 = new Int32Array(this.targetWidth);
    this.centerX = new Int32Array(this.targetWidth);
    for (let tx = 0; tx < this.targetWidth; tx++) {
      const x0 = Math.floor((tx * this.sourceWidth) / this.targetWidth);
      this.boxX0[tx] = x0;
      this.boxX1[tx] = Math.max(x0 + 1, Math.floor(((tx + 1) * this.sourceWidth) / this.targetWidth));
      this.centerX[tx] = Math.min(
        this.sourceWidth - 1,
        Math.floor(((tx + SAMPLE_CENTER_OFFSET) * this.sourceWidth) / this.targetWidth),
      );
    }

    const cellCount = this.cols * this.rows;
    this.cellFg = new Uint32Array(cellCount);
    this.cellBg = new Uint32Array(cellCount);
    this.prevFg = new Uint32Array(cellCount);
    this.prevBg = new Uint32Array(cellCount);
    this.needsFullPaint = true;
  }

  destroy(): void {
    this.onDebug?.(`Destroy: frameNumber=${this.frameNumber}`);
  }

  // No worker path: payloads are returned synchronously from render calls.
  // Present so Screen can drive either renderer through one interface.
  setOutputSink(_sink: (chunk: string) => boolean): void {}

  getDisplaySize(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  // Snapshot the last rendered frame as post-processed RGB24 at source
  // resolution (the same raster the glyph grid is sampled from, before
  // downsampling). Returns a copy so the caller can retain it across frames.
  captureRgb(): CapturedFrame {
    return {
      data: new Uint8Array(this.nativeRgbBuffer),
      width: this.sourceWidth,
      height: this.sourceHeight,
    };
  }

  getStatusRow(): number {
    return this.offsetRow + this.rows;
  }

  setDimensions(): void {
    this.allocateGrid();
  }

  clearScreen(): string {
    return SGR_RESET + clearScreen();
  }

  hideCursor(): string {
    return hideCursor();
  }

  showCursor(): string {
    return showCursor();
  }

  // Pack a color into a diff-comparable key: palette index (256/16 mode, via
  // a 5-bit-per-channel LUT) or packed 0xRRGGBB (truecolor). Diffing compares
  // emitted values, so two frames that quantize identically produce no output.
  private colorKey(r: number, g: number, b: number): number {
    if (this.paletteLUT === null) {
      return (r << COLOR_KEY_RED_SHIFT) | (g << COLOR_KEY_GREEN_SHIFT) | b;
    }
    return this.paletteLUT[paletteLUTIndex(r, g, b)];
  }

  // SGR escape switching fg/bg to the given keys, omitting unchanged parts.
  // Returns '' when both already match the active state. Parameters are
  // assembled from precomputed string tables (see consts) because this runs
  // once per changed cell.
  private sgrFor(fg: number, bg: number, activeFg: number, activeBg: number): string {
    // Emoji glyphs carry their own color, so emoji mode emits no SGR
    if (this.renderMode === 'emoji') {
      return '';
    }
    let params = '';
    // Half-block and ascii both carry the cell color in the foreground. (In
    // ascii mode cellBg holds a glyph index, not a color, so no bg is emitted.)
    if ((this.renderMode === 'half-block' || this.renderMode === 'ascii') && fg !== activeFg) {
      if (this.colorDepth === COLOR_DEPTH_16) {
        params = SGR_FG_16[fg];
      } else if (this.colorDepth === COLOR_DEPTH_256) {
        params = SGR_FG_256[fg];
      } else {
        params =
          SGR_FG_TRUECOLOR_PREFIX +
          DECIMAL_BYTES[(fg >> COLOR_KEY_RED_SHIFT) & BYTE_MASK] +
          ';' +
          DECIMAL_BYTES[(fg >> COLOR_KEY_GREEN_SHIFT) & BYTE_MASK] +
          ';' +
          DECIMAL_BYTES[fg & BYTE_MASK];
      }
    }
    if (this.renderMode !== 'ascii' && bg !== activeBg) {
      let bgParams: string;
      if (this.colorDepth === COLOR_DEPTH_16) {
        bgParams = SGR_BG_16[bg];
      } else if (this.colorDepth === COLOR_DEPTH_256) {
        bgParams = SGR_BG_256[bg];
      } else {
        bgParams =
          SGR_BG_TRUECOLOR_PREFIX +
          DECIMAL_BYTES[(bg >> COLOR_KEY_RED_SHIFT) & BYTE_MASK] +
          ';' +
          DECIMAL_BYTES[(bg >> COLOR_KEY_GREEN_SHIFT) & BYTE_MASK] +
          ';' +
          DECIMAL_BYTES[bg & BYTE_MASK];
      }
      params = params === '' ? bgParams : params + ';' + bgParams;
    }
    return params === '' ? '' : `\x1b[${params}m`;
  }

  // The whole grid, for full repaints and full-frame changes
  private fullCellBounds(): CellBounds {
    return { cellX0: 0, cellX1: this.cols, cellY0: 0, cellY1: this.rows };
  }

  // Cell-grid bounds covering every cell whose box-filter input intersects
  // the source-space dirty rect, padded by one unit against boundary
  // rounding. Over-covering is harmless: an unchanged cell re-maps to the
  // same key and the diff emits nothing for it.
  private cellBoundsFor(rect: Rect): CellBounds {
    const cellX0 = clamp(Math.floor((rect.x * this.cols) / this.sourceWidth) - 1, 0, this.cols);
    const cellX1 = clamp(Math.ceil(((rect.x + rect.width) * this.cols) / this.sourceWidth) + 1, 0, this.cols);
    const ty0 = Math.floor((rect.y * this.targetHeight) / this.sourceHeight) - 1;
    const ty1 = Math.ceil(((rect.y + rect.height) * this.targetHeight) / this.sourceHeight) + 1;
    const cellY0 = clamp(Math.floor(ty0 / this.pixelsPerCell), 0, this.rows);
    const cellY1 = clamp(Math.ceil(ty1 / this.pixelsPerCell), 0, this.rows);
    return { cellX0, cellX1, cellY0, cellY1 };
  }

  // Resample the native rgb24 buffer onto the target pixel grid, within the
  // given cell bounds. Box mode averages each target pixel's source region
  // in linear light (averaging sRGB bytes directly makes blends too dark);
  // nearest mode copies the region's center pixel so hard edges stay solid.
  private downsample(bounds: CellBounds): void {
    if (this.cellSampling === 'nearest') {
      this.downsampleNearest(bounds);
      return;
    }
    const src = this.nativeRgbBuffer;
    const dst = this.targetRgbBuffer;
    const sw = this.sourceWidth;
    const sh = this.sourceHeight;
    const tw = this.targetWidth;
    const th = this.targetHeight;
    const boxX0 = this.boxX0;
    const boxX1 = this.boxX1;
    const toLinear = this.toLinear;
    const toSrgb = this.toSrgb;
    const tyStart = bounds.cellY0 * this.pixelsPerCell;
    const tyEnd = bounds.cellY1 * this.pixelsPerCell;
    for (let ty = tyStart; ty < tyEnd; ty++) {
      const y0 = Math.floor((ty * sh) / th);
      const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * sh) / th));
      let di = (ty * tw + bounds.cellX0) * RGB24_BYTES_PER_PIXEL;
      for (let tx = bounds.cellX0; tx < bounds.cellX1; tx++) {
        const x0 = boxX0[tx];
        const x1 = boxX1[tx];
        let r = 0;
        let g = 0;
        let b = 0;
        const count = (x1 - x0) * (y1 - y0);
        for (let y = y0; y < y1; y++) {
          let si = (y * sw + x0) * RGB24_BYTES_PER_PIXEL;
          for (let x = x0; x < x1; x++) {
            r += toLinear[src[si]];
            g += toLinear[src[si + 1]];
            b += toLinear[src[si + 2]];
            si += RGB24_BYTES_PER_PIXEL;
          }
        }
        dst[di++] = toSrgb[Math.round(r / count)];
        dst[di++] = toSrgb[Math.round(g / count)];
        dst[di++] = toSrgb[Math.round(b / count)];
      }
    }
  }

  // Nearest sampling: each target pixel copies its source region's center
  // pixel, so solid shapes keep exact colors at the cost of jagged edges
  private downsampleNearest(bounds: CellBounds): void {
    const src = this.nativeRgbBuffer;
    const dst = this.targetRgbBuffer;
    const sw = this.sourceWidth;
    const sh = this.sourceHeight;
    const tw = this.targetWidth;
    const th = this.targetHeight;
    const centerX = this.centerX;
    const tyStart = bounds.cellY0 * this.pixelsPerCell;
    const tyEnd = bounds.cellY1 * this.pixelsPerCell;
    for (let ty = tyStart; ty < tyEnd; ty++) {
      const sy = Math.min(sh - 1, Math.floor(((ty + SAMPLE_CENTER_OFFSET) * sh) / th));
      const rowBase = sy * sw;
      let di = (ty * tw + bounds.cellX0) * RGB24_BYTES_PER_PIXEL;
      for (let tx = bounds.cellX0; tx < bounds.cellX1; tx++) {
        const si = (rowBase + centerX[tx]) * RGB24_BYTES_PER_PIXEL;
        dst[di++] = src[si];
        dst[di++] = src[si + 1];
        dst[di++] = src[si + 2];
      }
    }
  }

  // Fill cellFg/cellBg from the target pixel grid within the given bounds.
  // Half-block mode: foreground is the cell's top pixel, background the
  // bottom pixel. Background mode: the cell's single pixel is its background.
  private mapCells(bounds: CellBounds): void {
    const t = this.targetRgbBuffer;
    const tw = this.targetWidth;
    for (let cy = bounds.cellY0; cy < bounds.cellY1; cy++) {
      for (let cx = bounds.cellX0; cx < bounds.cellX1; cx++) {
        const ci = cy * this.cols + cx;
        if (this.renderMode === 'half-block') {
          const topIdx = (cy * CELL_PIXELS_Y * tw + cx) * RGB24_BYTES_PER_PIXEL;
          const botIdx = ((cy * CELL_PIXELS_Y + 1) * tw + cx) * RGB24_BYTES_PER_PIXEL;
          this.cellFg[ci] = this.colorKey(t[topIdx], t[topIdx + 1], t[topIdx + 2]);
          this.cellBg[ci] = this.colorKey(t[botIdx], t[botIdx + 1], t[botIdx + 2]);
        } else {
          const idx = (cy * tw + cx) * RGB24_BYTES_PER_PIXEL;
          this.cellBg[ci] = this.colorKey(t[idx], t[idx + 1], t[idx + 2]);
        }
      }
    }
  }

  // Fill the cell grid from the native rgb buffer within the given bounds.
  // Ascii mode samples luminance shape directly from nativeRgbBuffer, so it
  // bypasses the rgb downsample/targetRgbBuffer path the other modes share.
  private resample(bounds: CellBounds): void {
    if (this.renderMode === 'ascii') {
      this.mapCellsAscii(bounds);
      return;
    }
    this.downsample(bounds);
    this.mapCells(bounds);
  }

  // Fill cellBg (glyph index) and cellFg (fg color key) for ascii mode. Each
  // cell is sampled into a 6-region luminance vector (2 cols x 3 rows) and the
  // nearest-shape glyph is looked up. The region partition MUST match the
  // offline generator (scripts/generateAsciiShapes): a source pixel at local
  // (lx, ly) in a cellW x cellH footprint falls in
  // col = min(COLS-1, floor((lx+0.5)/cellW * COLS)) and
  // row = min(ROWS-1, floor((ly+0.5)/cellH * ROWS)), with no brightness
  // inversion. The fg color is a gamma-correct (linear-light) average of the
  // sampled pixels.
  //
  // Sampling honors cellSampling. "box" reads every footprint pixel (the mean
  // is exact but the cost is O(source pixels)). "nearest" (the default) strides
  // over the footprint so at most ASCII_SAMPLE_MAX_COLS x ASCII_SAMPLE_MAX_ROWS
  // pixels are read per cell, making the cost O(cells) regardless of source
  // resolution. Both stride into the same region-binning formula, and a
  // footprint smaller than the caps yields stride 1 (so small sources sample
  // every pixel and match "box" exactly).
  private mapCellsAscii(bounds: CellBounds): void {
    const lookup = this.asciiLookup;
    if (lookup === null) {
      return;
    }
    const src = this.nativeRgbBuffer;
    const sw = this.sourceWidth;
    const toLinear = this.toLinear;
    const toSrgb = this.toSrgb;
    const boxSampling = this.cellSampling === 'box';
    // Scratch accumulators reused across every cell (never allocated per cell)
    const lumSum = new Array<number>(SHAPE_VECTOR_DIMS).fill(0);
    const lumCount = new Array<number>(SHAPE_VECTOR_DIMS).fill(0);
    const vector = new Array<number>(SHAPE_VECTOR_DIMS).fill(0);
    for (let cy = bounds.cellY0; cy < bounds.cellY1; cy++) {
      const sy0 = Math.floor((cy * this.sourceHeight) / this.rows);
      const sy1 = Math.max(sy0 + 1, Math.floor(((cy + 1) * this.sourceHeight) / this.rows));
      const cellH = sy1 - sy0;
      const strideY = boxSampling ? 1 : Math.max(1, Math.ceil(cellH / ASCII_SAMPLE_MAX_ROWS));
      for (let cx = bounds.cellX0; cx < bounds.cellX1; cx++) {
        const sx0 = Math.floor((cx * sw) / this.cols);
        const sx1 = Math.max(sx0 + 1, Math.floor(((cx + 1) * sw) / this.cols));
        const cellW = sx1 - sx0;
        const strideX = boxSampling ? 1 : Math.max(1, Math.ceil(cellW / ASCII_SAMPLE_MAX_COLS));
        for (let k = 0; k < SHAPE_VECTOR_DIMS; k++) {
          lumSum[k] = 0;
          lumCount[k] = 0;
        }
        let rLinSum = 0;
        let gLinSum = 0;
        let bLinSum = 0;
        let pxCount = 0;
        for (let sy = sy0; sy < sy1; sy += strideY) {
          const ly = sy - sy0;
          const row = Math.min(
            SHAPE_REGION_ROWS - 1,
            Math.floor(((ly + SAMPLE_CENTER_OFFSET) / cellH) * SHAPE_REGION_ROWS),
          );
          const rowBase = sy * sw;
          for (let sx = sx0; sx < sx1; sx += strideX) {
            const si = (rowBase + sx) * RGB24_BYTES_PER_PIXEL;
            const r = src[si];
            const g = src[si + 1];
            const b = src[si + 2];
            const lx = sx - sx0;
            const col = Math.min(
              SHAPE_REGION_COLS - 1,
              Math.floor(((lx + SAMPLE_CENTER_OFFSET) / cellW) * SHAPE_REGION_COLS),
            );
            const region = row * SHAPE_REGION_COLS + col;
            lumSum[region] += calculateLuminance8(r, g, b);
            lumCount[region] += 1;
            rLinSum += toLinear[r];
            gLinSum += toLinear[g];
            bLinSum += toLinear[b];
            pxCount += 1;
          }
        }
        for (let k = 0; k < SHAPE_VECTOR_DIMS; k++) {
          vector[k] = lumCount[k] > 0 ? lumSum[k] / lumCount[k] / MAX_8BIT : 0;
        }
        enhanceAsciiContrast(vector);
        const charIndex = lookup.lookup(vector);
        const rSrgb = toSrgb[Math.round(rLinSum / pxCount)];
        const gSrgb = toSrgb[Math.round(gLinSum / pxCount)];
        const bSrgb = toSrgb[Math.round(bLinSum / pxCount)];
        const ci = cy * this.cols + cx;
        this.cellBg[ci] = charIndex;
        this.cellFg[ci] = this.colorKey(rSrgb, gSrgb, bSrgb);
      }
    }
  }

  // The glyph drawn for a cell: an emoji square (emoji mode), a shape-matched
  // ASCII char (ascii mode), or the fixed block/space glyph otherwise.
  private glyphFor(ci: number): string {
    if (this.emojiGlyphs !== null) {
      return this.emojiGlyphs[this.cellBg[ci]];
    }
    if (this.asciiChars !== null) {
      return this.asciiChars[this.cellBg[ci]];
    }
    return this.glyph;
  }

  private paintFull(): string {
    let out = '';
    let activeFg = NO_ACTIVE_COLOR;
    let activeBg = NO_ACTIVE_COLOR;
    for (let cy = 0; cy < this.rows; cy++) {
      out += moveCursor(this.offsetRow + cy, this.offsetCol);
      for (let cx = 0; cx < this.cols; cx++) {
        const ci = cy * this.cols + cx;
        out += this.sgrFor(this.cellFg[ci], this.cellBg[ci], activeFg, activeBg);
        activeFg = this.cellFg[ci];
        activeBg = this.cellBg[ci];
        out += this.glyphFor(ci);
      }
    }
    return out + SGR_RESET;
  }

  // Emit only cells that differ from the previously emitted grid, as runs of
  // consecutive changed cells each addressed by one cursor move. SGR state
  // persists across runs within a payload (cursor moves do not reset it).
  private paintDiff(): string {
    let out = '';
    let changedCells = 0;
    let activeFg = NO_ACTIVE_COLOR;
    let activeBg = NO_ACTIVE_COLOR;
    for (let cy = 0; cy < this.rows; cy++) {
      let cx = 0;
      while (cx < this.cols) {
        let ci = cy * this.cols + cx;
        if (this.cellFg[ci] === this.prevFg[ci] && this.cellBg[ci] === this.prevBg[ci]) {
          cx++;
          continue;
        }
        out += moveCursor(this.offsetRow + cy, this.offsetCol + cx * this.columnsPerCell);
        while (
          cx < this.cols &&
          (this.cellFg[ci] !== this.prevFg[ci] || this.cellBg[ci] !== this.prevBg[ci])
        ) {
          out += this.sgrFor(this.cellFg[ci], this.cellBg[ci], activeFg, activeBg);
          activeFg = this.cellFg[ci];
          activeBg = this.cellBg[ci];
          out += this.glyphFor(ci);
          changedCells++;
          cx++;
          ci++;
        }
      }
    }
    if (out === '') {
      return '';
    }
    this.diffCellCount = changedCells;
    return out + SGR_RESET;
  }

  // Move current cell state into prev (buffer swap, no copy)
  private commitCells(): void {
    [this.prevFg, this.cellFg] = [this.cellFg, this.prevFg];
    [this.prevBg, this.cellBg] = [this.cellBg, this.prevBg];
  }

  private renderInternal(frameBuffer: FrameBuffer, colorSpace: ColorSpace): string {
    // Source size changed (e.g. SNES resolution switch): resize diff state
    if (frameBuffer.length !== this.prevFrameBuffer.length) {
      this.prevFrameBuffer = allocateFrameBufferLike(frameBuffer);
      this.needsFullPaint = true;
    }

    // Pixel-identical frame: nothing to do (cell state is still current)
    const unitsPerPixel = frameUnitsPerPixel(colorSpace);
    let dirtyRect: Rect | null = null;
    if (this.enableDiffRendering && !this.needsFullPaint) {
      dirtyRect = computeDirtyRect(frameBuffer, this.prevFrameBuffer, this.sourceWidth, this.sourceHeight, unitsPerPixel);
      if (dirtyRect === null) {
        this.onDebug?.(`Frame ${this.frameNumber}: SKIPPED (unchanged)`);
        return '';
      }
    }

    // Convert and post-process only within the dirty rect when effects are
    // pointwise: pixels outside it are unchanged since the last frame, so
    // nativeRgbBuffer already holds their processed values (downsample's
    // padded bounds may re-read them, which is safe for the same reason)
    const processRect =
      dirtyRect !== null && !this.postProcessing.hasNonLocalEffects() ? dirtyRect : undefined;
    convertFrameToRgb24(frameBuffer, this.nativeRgbBuffer, {
      colorSpace,
      width: this.sourceWidth,
      height: this.sourceHeight,
      gammaLUT: this.gammaLUT,
      hasIdentityGamma: this.hasIdentityGamma,
      colorEnabled: this.colorEnabled,
      rect: processRect,
    });
    // Pixels outside the dirty rect are already equal in prevFrameBuffer,
    // so syncing it only needs the dirty row span
    if (dirtyRect === null) {
      this.prevFrameBuffer.set(frameBuffer);
    } else {
      const rowUnits = this.sourceWidth * unitsPerPixel;
      const dirtyStart = dirtyRect.y * rowUnits;
      const dirtyEnd = (dirtyRect.y + dirtyRect.height) * rowUnits;
      this.prevFrameBuffer.set(frameBuffer.subarray(dirtyStart, dirtyEnd), dirtyStart);
    }
    this.postProcessing.apply(this.nativeRgbBuffer, this.sourceWidth, this.sourceHeight, processRect);

    // With a dirty rect and only pointwise effects, cells outside the rect
    // cannot have changed: downsample and re-map only the affected region.
    // Effects that spread pixel influence (bloom, NTSC, curvature, chromatic
    // aberration) invalidate that assumption, so they force the full grid.
    const partialBounds =
      dirtyRect !== null &&
      !this.postProcessing.hasNonLocalEffects() &&
      !isFullFrameRect(dirtyRect, this.sourceWidth, this.sourceHeight)
        ? this.cellBoundsFor(dirtyRect)
        : null;
    if (partialBounds === null) {
      this.resample(this.fullCellBounds());
    } else {
      // After the last commit swap, cellFg/cellBg hold the grid from two
      // frames ago: refresh from prev so untouched cells diff as unchanged
      this.cellFg.set(this.prevFg);
      this.cellBg.set(this.prevBg);
      this.resample(partialBounds);
    }

    const payload = this.needsFullPaint ? this.paintFull() : this.paintDiff();
    this.commitCells();
    if (this.needsFullPaint) {
      this.onDebug?.(`Frame #${this.frameNumber}: full, cells=${this.cols * this.rows}`);
    } else if (payload === '') {
      this.onDebug?.(`Frame ${this.frameNumber}: SKIPPED (unchanged)`);
    } else {
      this.onDebug?.(`Frame #${this.frameNumber}: diff, cells=${this.diffCellCount}`);
    }
    this.needsFullPaint = false;
    this.frameNumber++;
    return payload;
  }

  renderRgb15(frameBuffer: Uint16Array): string {
    return this.renderInternal(frameBuffer, 'rgb15');
  }

  renderRgb24(frameBuffer: Uint8Array): string {
    return this.renderInternal(frameBuffer, 'rgb24');
  }
}
