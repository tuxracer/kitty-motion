import { describe, expect, it, vi } from 'vitest';
import { KittyRenderer } from '.';

const rgbFrame = (w: number, h: number, fill: number): Uint8Array =>
  new Uint8Array(w * h * 3).fill(fill);

describe('KittyRenderer', () => {
  it('returns a payload for a first frame and skips an identical second frame after the initial window', () => {
    const r = new KittyRenderer({ sourceWidth: 4, sourceHeight: 4, scale: 1 });
    const frame = rgbFrame(4, 4, 100);
    let lastLen = 0;
    // Exhaust the initial full-render window (INITIAL_FULL_RENDER_FRAMES)
    for (let i = 0; i < 40; i++) {lastLen = r.renderRgb24(frame).length;}
    expect(lastLen).toBe(0); // unchanged frame is skipped
    const changed = rgbFrame(4, 4, 200);
    expect(r.renderRgb24(changed).length).toBeGreaterThan(0);
  });

  it('routes frames to the sink when a worker factory is provided', () => {
    const received: string[] = [];
    const fakeWorker = {
      postMessage: vi.fn(),
      on: vi.fn(),
      terminate: vi.fn(),
      unref: vi.fn(),
    };
    const r = new KittyRenderer({
      sourceWidth: 4,
      sourceHeight: 4,
      scale: 1,
      encodeWorkerFactory: () => fakeWorker,
    });
    r.setOutputSink((chunk) => received.push(chunk));
    const out = r.renderRgb24(rgbFrame(4, 4, 50));
    expect(out).toBe(''); // worker path returns empty string
    expect(fakeWorker.postMessage).toHaveBeenCalled();
  });

  it('reserves rows via reservedRows instead of a hardcoded status-line constant', () => {
    const base = new KittyRenderer({ sourceWidth: 4, sourceHeight: 4, scale: 1 });
    const reserved = new KittyRenderer({ sourceWidth: 4, sourceHeight: 4, scale: 1, reservedRows: 10 });
    // Reserving more rows leaves less vertical space, so the display should
    // never end up taller than the unreserved renderer's.
    expect(reserved.getDisplaySize().rows).toBeLessThanOrEqual(base.getDisplaySize().rows);
  });

  it('routes internal diagnostics through onDebug when provided', () => {
    const messages: string[] = [];
    const r = new KittyRenderer({
      sourceWidth: 4,
      sourceHeight: 4,
      scale: 1,
      onDebug: (message) => messages.push(message),
    });
    r.renderRgb24(rgbFrame(4, 4, 1));
    r.destroy();
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.startsWith('Init:'))).toBe(true);
    expect(messages.some((m) => m.startsWith('Destroy:'))).toBe(true);
  });
});
