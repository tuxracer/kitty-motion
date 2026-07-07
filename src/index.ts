// High-level API: push frames, everything else is handled
export { Screen, createScreen } from './Screen/index.ts';
export type { ScreenOptions, ScreenUpdatableOptions } from './Screen/index.ts';

// Cross-module types
export * from './types.ts';

// Rendering
export { KittyRenderer } from './KittyRenderer/index.ts';
export type { KittyRendererOptions } from './KittyRenderer/index.ts';
export { CellRenderer } from './CellRenderer/index.ts';
export type { CellRendererOptions, CellLayout } from './CellRenderer/index.ts';
export { PostProcessingPipeline } from './postProcessing/index.ts';
export type { EffectOptions } from './postProcessing/index.ts';
export { computeDisplayLayout } from './displayLayout/index.ts';
export type { DisplayLayout, DisplayLayoutOptions } from './displayLayout/index.ts';
export { computeDirtyRect, unionRects, fullFrameRect, isFullFrameRect } from './dirtyRect/index.ts';
export type { Rect } from './dirtyRect/index.ts';

// Frame encoding
export {
  KittyFrameEncoder,
  isKittyEncodeRequest,
  isKittyEncodeResponse,
} from './kittyEncode/index.ts';
export type { KittyFrameMeta, KittyEncodeRequest, KittyEncodeResponse } from './kittyEncode/index.ts';
export { KittyEncodeWorkerClient } from './kittyEncodeWorkerClient/index.ts';
export type { WorkerFactory, WorkerLike } from './kittyEncodeWorkerClient/index.ts';
export {
  rgbToAnsi256,
  rgbToAnsi16,
  rgbToEmoji,
  buildEmojiLUT,
  EMOJI_COLORS,
  convertFrameToRgb24,
  isRgb15Buffer,
  buildGammaLUT,
  frameUnitsPerPixel,
  allocateFrameBuffer,
  allocateFrameBufferLike,
} from './color/index.ts';
export type { FrameToRgb24Options, EmojiColor } from './color/index.ts';

// Kitty graphics protocol and output
export {
  detectKittyGraphicsSupport,
  getKittyGraphicsSupported,
  resetKittyGraphicsDetection,
  detectKittyAnimationSupport,
  getKittyAnimationSupported,
  resetKittyAnimationDetection,
  detectKittyFileTransferSupport,
  getKittyFileTransferSupported,
  resetKittyFileTransferDetection,
  buildKittyImageSequence,
  buildKittyDeleteSequence,
  buildCursorPositionSequence,
} from './kittyProtocol/index.ts';
export { OutputGate } from './OutputGate/index.ts';
export type { DrainableStream } from './OutputGate/index.ts';

// Terminal detection and sizing
export {
  detectCellPixelSize,
  getCellPixelSize,
  resetCellPixelSizeDetection,
  getTerminalDimensions,
  isSSHSession,
  isMultiplexedSession,
  detectColorDepth,
  detectCellRenderMode,
  detectCellSampling,
} from './terminal/index.ts';
export type { CellPixelSize, SessionEnv } from './terminal/index.ts';
export { fitToTerminal } from './fitToTerminal/index.ts';
export type { FitToTerminalOptions, DisplaySize } from './fitToTerminal/index.ts';
export { kittyGridAspectRatio } from './aspect/index.ts';
