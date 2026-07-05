import { parentPort } from 'worker_threads';
import { KittyFrameEncoder, isKittyEncodeRequest, type KittyEncodeResponse } from '../kittyEncode';

/**
 * Worker-thread entry point for Kitty frame encoding. Built as its own bundle
 * entry (dist/encode-worker.js) and spawned by KittyEncodeWorkerClient.
 *
 * Each message is a self-describing KittyEncodeRequest; the transferred RGB
 * buffer is transferred back with the response for recycling.
 */
export const handleKittyEncodeMessage = (
  msg: unknown,
  encoder: KittyFrameEncoder,
): KittyEncodeResponse | null => {
  if (!isKittyEncodeRequest(msg)) {
    return null;
  }
  const payload = encoder.encode(new Uint8Array(msg.rgb), msg.meta);
  return { type: 'encoded', payload, rgb: msg.rgb };
};

// Message loop (parentPort is null when loaded on the main thread, e.g. tests)
if (parentPort !== null) {
  const port = parentPort;
  const encoder = new KittyFrameEncoder();
  port.on('message', (msg: unknown) => {
    const response = handleKittyEncodeMessage(msg, encoder);
    if (response !== null) {
      port.postMessage(response, [response.rgb]);
    }
  });
}
