import { describe, it, expect, vi } from 'vitest';
import { KittyEncodeWorkerClient } from './index.ts';
import type { WorkerLike } from './index.ts';
import { isKittyEncodeRequest, type KittyEncodeRequest, type KittyFrameMeta } from '../kittyEncode/index.ts';

const makeMeta = (overrides: Partial<KittyFrameMeta> = {}): KittyFrameMeta => ({
  sourceWidth: 2,
  sourceHeight: 2,
  scale: 1,
  scaledWidth: 2,
  scaledHeight: 2,
  pngCompressionLevel: 1,
  displayCols: 10,
  displayRows: 5,
  offsetRow: 1,
  offsetCol: 1,
  currentImageId: 1,
  previousImageId: 2,
  deletePrevious: false,
  transmit: 'full',
  dirtyRect: { x: 0, y: 0, width: 2, height: 2 },
  medium: 'escape' as const,
  ...overrides,
});

class FakeWorker implements WorkerLike {
  requests: KittyEncodeRequest[] = [];
  terminated = false;
  private listeners = new Map<string, Array<(arg?: unknown) => void>>();

  postMessage(value: unknown): void {
    if (isKittyEncodeRequest(value)) {
      this.requests.push(value);
    }
  }

  on(event: string, listener: (arg?: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(arg);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  // Simulate the worker finishing the oldest in-flight request
  respond(payload: string): void {
    const request = this.requests[this.requests.length - 1];
    this.emit('message', { type: 'encoded', payload, rgb: request.rgb });
  }
}

const makeClient = (
  options: { onFailure?: () => void; onPayloadDropped?: (meta: KittyFrameMeta) => void } = {},
): { client: KittyEncodeWorkerClient; worker: FakeWorker; sink: string[] } => {
  const worker = new FakeWorker();
  const sink: string[] = [];
  const client = new KittyEncodeWorkerClient(
    (payload) => {
      sink.push(payload);
      return true;
    },
    {
      workerFactory: () => worker,
      onFailure: options.onFailure,
      onPayloadDropped: options.onPayloadDropped,
    },
  );
  return { client, worker, sink };
};

const frame = (fill: number): Uint8Array => new Uint8Array(2 * 2 * 3).fill(fill);

describe('KittyEncodeWorkerClient', () => {
  it('submits the first frame to the worker immediately with its pixels copied', () => {
    const { client, worker } = makeClient();
    const meta = makeMeta({ currentImageId: 42 });

    client.submit(frame(7), meta);

    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0].meta.currentImageId).toBe(42);
    expect([...new Uint8Array(worker.requests[0].rgb)]).toEqual([...frame(7)]);
  });

  it('delivers encoded payloads to the sink', () => {
    const { client, worker, sink } = makeClient();

    client.submit(frame(1), makeMeta());
    worker.respond('payload-1');

    expect(sink).toEqual(['payload-1']);
  });

  it('coalesces frames latest-wins while one is in flight', () => {
    const { client, worker, sink } = makeClient();

    client.submit(frame(1), makeMeta({ currentImageId: 1 }));
    client.submit(frame(2), makeMeta({ currentImageId: 2 })); // dropped
    client.submit(frame(3), makeMeta({ currentImageId: 3 })); // latest pending

    expect(worker.requests).toHaveLength(1); // only frame 1 dispatched so far
    worker.respond('payload-1');

    expect(worker.requests).toHaveLength(2); // pending frame dispatched on completion
    expect(worker.requests[1].meta.currentImageId).toBe(3);
    expect([...new Uint8Array(worker.requests[1].rgb)]).toEqual([...frame(3)]);

    worker.respond('payload-3');
    expect(sink).toEqual(['payload-1', 'payload-3']);
  });

  it('recycles transfer buffers returned by the worker', () => {
    const { client, worker } = makeClient();

    client.submit(frame(1), makeMeta());
    const firstBuffer = worker.requests[0].rgb;
    worker.respond('p');

    client.submit(frame(2), makeMeta());
    expect(worker.requests[1].rgb).toBe(firstBuffer);
  });

  it('becomes unavailable and reports failure once when the worker errors', () => {
    const onFailure = vi.fn();
    const { client, worker } = makeClient({ onFailure });

    expect(client.isAvailable()).toBe(true);
    worker.emit('error', new Error('boom'));
    worker.emit('exit', 1);

    expect(client.isAvailable()).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('is unavailable and ignores submissions when the factory fails', () => {
    const sink: string[] = [];
    const client = new KittyEncodeWorkerClient(
      (payload) => {
        sink.push(payload);
        return true;
      },
      {
        workerFactory: () => null,
      },
    );

    expect(client.isAvailable()).toBe(false);
    client.submit(frame(1), makeMeta()); // must not throw
    expect(sink).toEqual([]);
  });

  it('terminates the worker when leaving a using scope', () => {
    const worker = new FakeWorker();
    {
      using client = new KittyEncodeWorkerClient(() => true, { workerFactory: () => worker });
      expect(client.isAvailable()).toBe(true);
    }
    expect(worker.terminated).toBe(true);
  });

  it('terminates the worker on destroy without reporting a failure', () => {
    const onFailure = vi.fn();
    const { client, worker } = makeClient({ onFailure });

    client.destroy();
    worker.emit('exit', 0);

    expect(worker.terminated).toBe(true);
    expect(client.isAvailable()).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('unions dirty rects when a pending delta replaces a dropped pending delta', () => {
    const { client, worker } = makeClient();

    client.submit(frame(1), makeMeta({ transmit: 'delta', dirtyRect: { x: 0, y: 0, width: 1, height: 1 } })); // in flight
    client.submit(frame(2), makeMeta({ transmit: 'delta', dirtyRect: { x: 1, y: 1, width: 1, height: 1 } })); // pending, will be dropped
    client.submit(frame(3), makeMeta({ transmit: 'delta', dirtyRect: { x: 0, y: 1, width: 1, height: 1 } })); // replaces pending

    worker.respond('p1');
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests[1].meta.transmit).toBe('delta');
    expect(worker.requests[1].meta.dirtyRect).toEqual({ x: 0, y: 1, width: 2, height: 1 });
  });

  it('promotes the replacement to full when a pending full frame is dropped', () => {
    const { client, worker } = makeClient();

    client.submit(frame(1), makeMeta({ transmit: 'delta', dirtyRect: { x: 0, y: 0, width: 1, height: 1 } })); // in flight
    client.submit(
      frame(2),
      makeMeta({
        transmit: 'full',
        dirtyRect: { x: 0, y: 0, width: 2, height: 2 },
        currentImageId: 5,
        previousImageId: 6,
        deletePrevious: true,
      }),
    ); // pending full, will be dropped
    client.submit(frame(3), makeMeta({ transmit: 'delta', dirtyRect: { x: 1, y: 0, width: 1, height: 1 } }));

    worker.respond('p1');
    const dispatched = worker.requests[1].meta;
    expect(dispatched.transmit).toBe('full');
    expect(dispatched.dirtyRect).toEqual({ x: 0, y: 0, width: 2, height: 2 });
    expect(dispatched.currentImageId).toBe(5);
    expect(dispatched.previousImageId).toBe(6);
    expect(dispatched.deletePrevious).toBe(true);
  });

  it('keeps the replacement as-is when it is already a full frame', () => {
    const { client, worker } = makeClient();

    client.submit(frame(1), makeMeta({ transmit: 'delta', dirtyRect: { x: 0, y: 0, width: 1, height: 1 } })); // in flight
    client.submit(frame(2), makeMeta({ transmit: 'delta', dirtyRect: { x: 1, y: 1, width: 1, height: 1 } })); // dropped
    client.submit(frame(3), makeMeta({ transmit: 'full', dirtyRect: { x: 0, y: 0, width: 2, height: 2 }, currentImageId: 9 }));

    worker.respond('p1');
    const dispatched = worker.requests[1].meta;
    expect(dispatched.transmit).toBe('full');
    expect(dispatched.currentImageId).toBe(9);
  });

  it('reports the dropped meta when the sink rejects a delivered payload', () => {
    const dropped: KittyFrameMeta[] = [];
    const worker = new FakeWorker();
    const client = new KittyEncodeWorkerClient(() => false, {
      workerFactory: () => worker,
      onPayloadDropped: (meta) => dropped.push(meta),
    });

    client.submit(frame(1), makeMeta({ transmit: 'delta', dirtyRect: { x: 1, y: 1, width: 1, height: 1 } }));
    worker.respond('p1');

    expect(dropped).toHaveLength(1);
    expect(dropped[0].dirtyRect).toEqual({ x: 1, y: 1, width: 1, height: 1 });
    expect(client.isAvailable()).toBe(true); // a dropped write is not a failure
  });

  it('keeps the replacement frame file path through coalescing promotion', () => {
    const { client, worker } = makeClient();

    client.submit(frame(1), makeMeta({ transmit: 'delta', dirtyRect: { x: 0, y: 0, width: 1, height: 1 } })); // in flight
    client.submit(
      frame(2),
      makeMeta({ transmit: 'full', dirtyRect: { x: 0, y: 0, width: 2, height: 2 }, medium: 'file', filePath: '/tmp/full-a.png' }),
    ); // pending full, will be dropped before encoding (no file written yet)
    client.submit(
      frame(3),
      makeMeta({ transmit: 'delta', dirtyRect: { x: 1, y: 0, width: 1, height: 1 }, medium: 'file', filePath: '/tmp/delta-b.png' }),
    );

    worker.respond('p1');
    const dispatched = worker.requests[1].meta;
    expect(dispatched.transmit).toBe('full'); // promotion still applies
    expect(dispatched.medium).toBe('file');
    expect(dispatched.filePath).toBe('/tmp/delta-b.png'); // the replacement's own path
  });

  it('reports the in-flight frame file as dropped when destroyed mid-flight', async () => {
    const dropped: KittyFrameMeta[] = [];
    const { client, worker } = makeClient({ onPayloadDropped: (meta) => dropped.push(meta) });
    const meta = makeMeta({ medium: 'file', filePath: '/tmp/in-flight-a.png' });

    client.submit(frame(1), meta);
    client.destroy();
    await Promise.resolve();
    await Promise.resolve();

    expect(dropped).toHaveLength(1);
    expect(dropped[0].filePath).toBe('/tmp/in-flight-a.png');

    // A late response arriving after destroy must not report the drop again
    worker.respond('too-late');
    expect(dropped).toHaveLength(1);
  });

  it('reports the in-flight frame file as dropped when the worker fails mid-flight', () => {
    const dropped: KittyFrameMeta[] = [];
    const onFailure = vi.fn();
    const { client, worker } = makeClient({ onFailure, onPayloadDropped: (meta) => dropped.push(meta) });
    const meta = makeMeta({ medium: 'file', filePath: '/tmp/in-flight-b.png' });

    client.submit(frame(1), meta);
    worker.emit('error', new Error('boom'));

    expect(dropped).toHaveLength(1);
    expect(dropped[0].filePath).toBe('/tmp/in-flight-b.png');
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
