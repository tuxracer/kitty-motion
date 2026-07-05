/**
 * Per-frame metadata for encoding one frame into a Kitty graphics payload.
 *
 * Every frame is fully self-describing so the encoder (and the worker thread
 * wrapping it) never needs configuration sync when settings change at runtime.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';

export interface KittyFrameMeta {
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  scaledWidth: number;
  scaledHeight: number;
  pngCompressionLevel: number;
  // Kitty placement: display size in terminal cells and cursor position
  displayCols: number;
  displayRows: number;
  offsetRow: number;
  offsetCol: number;
  // Alternating image ids provide a double-buffering effect
  currentImageId: number;
  previousImageId: number;
  deletePrevious: boolean;
}

/**
 * Worker protocol: the main thread transfers the frame's RGB pixels to the
 * worker; the worker transfers the same ArrayBuffer back with the encoded
 * payload so the main thread can recycle it (zero steady-state allocation).
 */
export interface KittyEncodeRequest {
  type: 'encode';
  meta: KittyFrameMeta;
  rgb: ArrayBuffer;
}

export interface KittyEncodeResponse {
  type: 'encoded';
  payload: string;
  rgb: ArrayBuffer;
}

export const isKittyEncodeRequest = (value: unknown): value is KittyEncodeRequest =>
  isPlainObject(value) &&
  value.type === 'encode' &&
  isPlainObject(value.meta) &&
  value.rgb instanceof ArrayBuffer;

export const isKittyEncodeResponse = (value: unknown): value is KittyEncodeResponse =>
  isPlainObject(value) &&
  value.type === 'encoded' &&
  isString(value.payload) &&
  value.rgb instanceof ArrayBuffer;
