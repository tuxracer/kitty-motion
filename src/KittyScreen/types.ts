import type { EffectOptions } from "../postProcessing";
import type { DrainableStream } from "../OutputGate";
import type { WorkerFactory } from "../kittyEncodeWorkerClient";
import type { ColorSpace } from "../types";

export interface KittyScreenUpdatableOptions extends EffectOptions {
  scale?: number;
  pixelAspectRatio?: number;
  reservedRows?: number;
  pngCompressionLevel?: number;
  colorEnabled?: boolean;
  enableDiffRendering?: boolean;
}

export interface KittyScreenOptions extends KittyScreenUpdatableOptions {
  sourceWidth: number;
  sourceHeight: number;
  output: DrainableStream;
  colorSpace?: ColorSpace;
  workerFactory?: WorkerFactory;
  onDebug?: (message: string) => void;
}
