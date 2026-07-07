/** Color space of a decoded framebuffer */
export type ColorSpace = 'rgb15' | 'rgb24';

/** Type alias for framebuffer data */
export type FrameBuffer = Uint8Array | Uint16Array;

/** SGR color depth for cell-mode output: 0 = truecolor, 256 or 16 = palette */
export type ColorDepth = 0 | 16 | 256;

/** Cell-mode downsampling strategy: "box" averages each cell's source region in linear light, "nearest" copies the region's center pixel */
export type CellSampling = 'box' | 'nearest';

/** Which rendering path Screen uses: "kitty" (graphics protocol), "half-block" (2 pixels per cell via U+2580), "cell-background" (1 pixel per cell via background-colored spaces), "emoji" (one emoji square per cell by nearest color), or "ascii" (one printable ASCII glyph per cell by nearest shape) */
export type RenderMode = 'kitty' | 'half-block' | 'cell-background' | 'emoji' | 'ascii';

/** Render modes handled by CellRenderer (every RenderMode except "kitty") */
export type CellRenderMode = Exclude<RenderMode, 'kitty'>;

/**
 * Renderer surface Screen drives; implemented by KittyRenderer (Kitty
 * graphics protocol) and CellRenderer (block-glyph fallback).
 */
export interface Renderer {
  renderRgb15(frameBuffer: Uint16Array): string;
  renderRgb24(frameBuffer: Uint8Array): string;
  setOutputSink(sink: (chunk: string) => boolean): void;
  clearScreen(): string;
  hideCursor(): string;
  showCursor(): string;
  setDimensions(): void;
  getDisplaySize(): { cols: number; rows: number };
  getStatusRow(): number;
  destroy(): void;
}
