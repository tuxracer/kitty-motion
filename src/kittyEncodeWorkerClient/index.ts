import { Worker } from 'node:worker_threads';
import { isKittyEncodeResponse, type KittyEncodeRequest, type KittyFrameMeta } from '../kittyEncode/index.ts';
import { fullFrameRect, unionRects } from '../dirtyRect/index.ts';
import { KITTY_ENCODE_WORKER_FILENAME, TRANSFER_POOL_MAX } from './consts.ts';
import type { KittyEncodeWorkerClientOptions, WorkerLike } from './types.ts';

export * from './consts.ts';
export * from './types.ts';

/**
 * Create the real encode worker. Resolves the worker bundle next to the main
 * bundle; in unbundled environments (tests, running .ts directly) it won't exist and the
 * worker's error event triggers the sync fallback.
 */
const createKittyEncodeWorker = (): WorkerLike | null => {
  try {
    return new Worker(new URL(KITTY_ENCODE_WORKER_FILENAME, import.meta.url));
  } catch {
    return null;
  }
};

/**
 * Merge the meta of a coalesced-away (dropped) frame into its replacement so
 * the terminal still receives every changed pixel. Two deltas union their
 * rects (valid against the older displayed base: pixels differing between
 * frames N-1 and N+1 are a subset of the two per-step diffs). A dropped full
 * frame promotes the replacement to full, reusing the dropped frame's image
 * ids, which the renderer already recorded as displayed.
 */
export const mergeCoalescedMeta = (dropped: KittyFrameMeta, next: KittyFrameMeta): KittyFrameMeta => {
  if (next.transmit === 'full') {
    return next;
  }
  if (dropped.transmit === 'full') {
    return {
      ...next,
      transmit: 'full',
      dirtyRect: fullFrameRect(next.sourceWidth, next.sourceHeight),
      currentImageId: dropped.currentImageId,
      previousImageId: dropped.previousImageId,
      deletePrevious: dropped.deletePrevious,
    };
  }
  return { ...next, dirtyRect: unionRects(dropped.dirtyRect, next.dirtyRect) };
};

/**
 * Owns the Kitty encode worker: transfers frames to it, recycles transfer
 * buffers, and coalesces frames latest-wins so at most one frame is ever in
 * flight (intermediate frames are dropped, never queued).
 */
export class KittyEncodeWorkerClient {
  private worker: WorkerLike | null = null;
  private failed = false;
  private destroyed = false;
  private inFlight = false;
  private inFlightMeta: KittyFrameMeta | null = null;
  private pendingRgb: ArrayBuffer | null = null;
  private pendingMeta: KittyFrameMeta | null = null;
  private pool: ArrayBuffer[] = [];
  private readonly sink: (payload: string) => boolean;
  private readonly onFailure?: () => void;
  private readonly onPayloadDropped?: (meta: KittyFrameMeta) => void;

  constructor(sink: (payload: string) => boolean, options: KittyEncodeWorkerClientOptions = {}) {
    this.sink = sink;
    this.onFailure = options.onFailure;
    this.onPayloadDropped = options.onPayloadDropped;

    const factory = options.workerFactory ?? createKittyEncodeWorker;
    try {
      this.worker = factory();
    } catch {
      this.worker = null;
    }
    if (this.worker === null) {
      this.failed = true;
      return;
    }

    this.worker.on('message', (msg) => this.handleMessage(msg));
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => this.fail());
    // Never keep the process alive just for the encode worker
    this.worker.unref?.();
  }

  isAvailable(): boolean {
    return this.worker !== null && !this.failed && !this.destroyed;
  }

  /**
   * Submit a frame for encoding. Pixels are copied into a pooled transfer
   * buffer, so the caller can keep reusing its own buffer. If a frame is
   * already in flight, this frame replaces any pending one (latest wins).
   */
  submit(rgb: Uint8Array, meta: KittyFrameMeta): void {
    if (!this.isAvailable()) {
      return;
    }

    const buffer = this.takeBuffer(rgb.byteLength);
    new Uint8Array(buffer).set(rgb);

    if (this.inFlight) {
      if (this.pendingRgb !== null && this.pendingMeta !== null) {
        this.recycle(this.pendingRgb);
        this.pendingRgb = buffer;
        this.pendingMeta = mergeCoalescedMeta(this.pendingMeta, meta);
      } else {
        this.pendingRgb = buffer;
        this.pendingMeta = meta;
      }
      return;
    }

    this.dispatch(buffer, meta);
  }

  destroy(): void {
    this.destroyed = true;
    const meta = this.inFlightMeta;
    this.inFlightMeta = null;
    // worker_threads' terminate() returns a promise that resolves once the
    // worker has actually stopped; until then it may still be writing the
    // frame's temp file, so wait before reporting the drop (and thus the
    // unlink). WorkerLike types this `unknown` since test fakes return void;
    // Promise.resolve() on a non-promise resolves on the next microtask.
    const result = this.worker?.terminate();
    this.worker = null;
    this.pendingRgb = null;
    this.pendingMeta = null;
    this.pool = [];
    if (meta !== null) {
      void Promise.resolve(result).then(() => {
        this.onPayloadDropped?.(meta);
      });
    }
  }

  // Enables `using client = new KittyEncodeWorkerClient(...)` (Node 24+)
  [Symbol.dispose](): void {
    this.destroy();
  }

  private dispatch(rgb: ArrayBuffer, meta: KittyFrameMeta): void {
    this.inFlight = true;
    this.inFlightMeta = meta;
    const request: KittyEncodeRequest = { type: 'encode', meta, rgb };
    this.worker!.postMessage(request, [rgb]);
  }

  private handleMessage(msg: unknown): void {
    if (this.destroyed) {
      return;
    }
    if (!isKittyEncodeResponse(msg)) {
      return;
    }

    this.inFlight = false;
    const deliveredMeta = this.inFlightMeta;
    this.inFlightMeta = null;
    this.recycle(msg.rgb);
    if (!this.sink(msg.payload) && deliveredMeta !== null) {
      this.onPayloadDropped?.(deliveredMeta);
    }

    if (this.pendingRgb !== null && this.pendingMeta !== null) {
      const rgb = this.pendingRgb;
      const meta = this.pendingMeta;
      this.pendingRgb = null;
      this.pendingMeta = null;
      this.dispatch(rgb, meta);
    }
  }

  private fail(): void {
    if (this.failed || this.destroyed) {
      return;
    }
    this.failed = true;
    this.onFailure?.();

    // The worker is dead, so it can't still be writing the in-flight frame's
    // temp file: safe to report the drop (and thus the unlink) immediately.
    this.inFlight = false;
    const meta = this.inFlightMeta;
    this.inFlightMeta = null;
    if (meta !== null) {
      this.onPayloadDropped?.(meta);
    }
  }

  private takeBuffer(size: number): ArrayBuffer {
    for (let i = this.pool.length - 1; i >= 0; i--) {
      if (this.pool[i].byteLength === size) {
        return this.pool.splice(i, 1)[0];
      }
    }
    return new ArrayBuffer(size);
  }

  private recycle(buffer: ArrayBuffer): void {
    if (this.pool.length < TRANSFER_POOL_MAX) {
      this.pool.push(buffer);
    }
  }
}
