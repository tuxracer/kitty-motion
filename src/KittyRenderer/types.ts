import type { WorkerFactory } from '../kittyEncodeWorkerClient/index.ts';
import type { RendererOptionsBase } from '../rendererOptions/index.ts';

export interface KittyRendererOptions extends RendererOptionsBase {
  /** Scale factor controlling internal buffer resolution (default: DEFAULT_RENDER_SCALE, i.e. 2); display fit to the terminal is handled separately */
  scale?: number;
  /** PNG compression level 1-9 (default: DEFAULT_PNG_COMPRESSION, i.e. 5, higher = smaller but slower) */
  pngCompressionLevel?: number;
  /** Override encode-worker creation (tests, embedding) */
  encodeWorkerFactory?: WorkerFactory;
  /** Delta frames on terminals the probe rejected or never checked: undefined follows detectKittyAnimationSupport(), true/false overrides the probe; deltas still require enableDiffRendering and an integer scale of 1 or more (default: undefined) */
  dirtyRects?: boolean;
  /** File-based transmission (t=t): undefined follows detectKittyFileTransferSupport(), true/false forces (default: undefined). When using KittyRenderer directly without an output sink, the returned payload must be written to the terminal or the frame's temp file is orphaned until the next stale sweep. */
  fileTransfer?: boolean;
}
