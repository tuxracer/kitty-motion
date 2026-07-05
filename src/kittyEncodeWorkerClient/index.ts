import { Worker } from 'worker_threads';
import { isKittyEncodeResponse, type KittyEncodeRequest, type KittyFrameMeta } from '../kittyEncode';
import { KITTY_ENCODE_WORKER_FILENAME, TRANSFER_POOL_MAX } from './consts';
import type { KittyEncodeWorkerClientOptions, WorkerLike } from './types';

export * from './consts';
export * from './types';

/**
 * Create the real encode worker. Resolves the worker bundle next to the main
 * bundle; in unbundled environments (tests, tsx) the file won't exist and the
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
 * Owns the Kitty encode worker: transfers frames to it, recycles transfer
 * buffers, and coalesces frames latest-wins so at most one frame is ever in
 * flight (intermediate frames are dropped, never queued).
 */
export class KittyEncodeWorkerClient {
  private worker: WorkerLike | null = null;
  private failed = false;
  private destroyed = false;
  private inFlight = false;
  private pendingRgb: ArrayBuffer | null = null;
  private pendingMeta: KittyFrameMeta | null = null;
  private pool: ArrayBuffer[] = [];
  private readonly sink: (payload: string) => void;
  private readonly onFailure?: () => void;

  constructor(sink: (payload: string) => void, options: KittyEncodeWorkerClientOptions = {}) {
    this.sink = sink;
    this.onFailure = options.onFailure;

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
      if (this.pendingRgb !== null) {
        this.recycle(this.pendingRgb);
      }
      this.pendingRgb = buffer;
      this.pendingMeta = meta;
      return;
    }

    this.dispatch(buffer, meta);
  }

  destroy(): void {
    this.destroyed = true;
    this.worker?.terminate();
    this.worker = null;
    this.pendingRgb = null;
    this.pendingMeta = null;
    this.pool = [];
  }

  private dispatch(rgb: ArrayBuffer, meta: KittyFrameMeta): void {
    this.inFlight = true;
    const request: KittyEncodeRequest = { type: 'encode', meta, rgb };
    this.worker!.postMessage(request, [rgb]);
  }

  private handleMessage(msg: unknown): void {
    if (!isKittyEncodeResponse(msg)) {
      return;
    }

    this.inFlight = false;
    this.recycle(msg.rgb);
    this.sink(msg.payload);

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
