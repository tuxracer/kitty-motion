// Resolved against import.meta.url of the client module at runtime, so the
// worker is found next to dist/index.js under plain Node and modern bundlers.
export const KITTY_ENCODE_WORKER_FILENAME = './encode-worker.js';

/** Max recycled transfer buffers kept around (in-flight + pending + spares) */
export const TRANSFER_POOL_MAX = 4;
