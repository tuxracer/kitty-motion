import { describe, it, expect, vi } from 'vitest';
import { KittyEncodeWorkerClient } from '.';
import type { WorkerLike } from '.';
import { isKittyEncodeRequest, type KittyEncodeRequest, type KittyFrameMeta } from '../kittyEncode';

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

const makeClient = (options: { onFailure?: () => void } = {}): { client: KittyEncodeWorkerClient; worker: FakeWorker; sink: string[] } => {
  const worker = new FakeWorker();
  const sink: string[] = [];
  const client = new KittyEncodeWorkerClient((payload) => sink.push(payload), {
    workerFactory: () => worker,
    onFailure: options.onFailure,
  });
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
    const client = new KittyEncodeWorkerClient((payload) => sink.push(payload), {
      workerFactory: () => null,
    });

    expect(client.isAvailable()).toBe(false);
    client.submit(frame(1), makeMeta()); // must not throw
    expect(sink).toEqual([]);
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
});
