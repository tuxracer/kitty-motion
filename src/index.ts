// High-level API
export { KittyScreen, createKittyScreen } from "./KittyScreen";
export type { KittyScreenOptions, KittyScreenUpdatableOptions } from "./KittyScreen";

// Low-level primitives
export { KittyFrameEncoder } from "./kittyEncode";
export type { KittyFrameMeta } from "./kittyEncode";
export { KittyEncodeWorkerClient } from "./kittyEncodeWorkerClient";
export type { WorkerFactory, WorkerLike } from "./kittyEncodeWorkerClient";
export { kittyGridAspectRatio } from "./aspect";
export { fitToTerminal } from "./fitToTerminal";
export {
  detectCellPixelSize,
  getCellPixelSize,
  parseCellPixelSize,
  resetCellPixelSizeDetection,
  getTerminalDimensions,
} from "./terminal";
export type { CellPixelSize } from "./terminal";
export {
  detectKittyGraphicsSupport,
  getKittyGraphicsSupported,
  resetKittyGraphicsDetection,
  buildKittyImageSequence,
  buildKittyDeleteSequence,
  buildCursorPositionSequence,
} from "./kittyProtocol";
export { OutputGate } from "./OutputGate";
export type { DrainableStream } from "./OutputGate";
export { PostProcessingPipeline } from "./postProcessing";
export type { EffectOptions } from "./postProcessing";
export { rgbToIndexed, createPngChunk, PNG_SIGNATURE, crc32 } from "./png";
export { DEFAULT_PNG_COMPRESSION } from "./consts";
export type { FrameBuffer, ColorSpace } from "./types";
