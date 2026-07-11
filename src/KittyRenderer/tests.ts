import { describe, expect, it, vi } from 'vitest';
import { KittyRenderer, IMAGE_ID_STRIDE } from './index.ts';
import { resetKittyAnimationDetection, resetKittyFileTransferDetection } from '../kittyProtocol/index.ts';
import { isKittyEncodeRequest, type KittyEncodeRequest } from '../kittyEncode/index.ts';
import { encodeImageIdFg } from '../placeholder/index.ts';
import { BLOOM_REACH } from '../postProcessing/index.ts';
import { FRAME_FILE_PREFIX } from '../frameFiles/index.ts';
import { existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rgbFrame = (w: number, h: number, fill: number): Uint8Array =>
  new Uint8Array(w * h * 3).fill(fill);

// Renders enough identical frames to exhaust INITIAL_FULL_RENDER_FRAMES
const warmup = (r: KittyRenderer, frame: Uint8Array): void => {
  for (let i = 0; i < 10; i++) {
    r.renderRgb24(frame);
  }
};

const withPixel = (frame: Uint8Array, width: number, x: number, y: number): Uint8Array => {
  const copy = Uint8Array.from(frame);
  copy.set([1, 2, 3], (y * width + x) * 3);
  return copy;
};

// Worker fake that records encode requests and can deliver responses
class FakeEncodeWorker {
  requests: KittyEncodeRequest[] = [];
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

  terminate(): void {}

  respond(payload: string): void {
    const request = this.requests[this.requests.length - 1];
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ type: 'encoded', payload, rgb: request.rgb });
    }
  }
}

// Renders a run of identical frames through a fake worker, responding to
// each actual submission so the client dispatches the next real frame
// instead of coalescing it. Frames past the initial window are skipped
// when content is unchanged, so not every call produces a request.
const warmupWithWorker = (r: KittyRenderer, worker: FakeEncodeWorker, frame: Uint8Array): void => {
  for (let i = 0; i < 10; i++) {
    const before = worker.requests.length;
    r.renderRgb24(frame);
    if (worker.requests.length > before) {
      worker.respond('warmup');
    }
  }
};

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
    r.setOutputSink((chunk) => {
      received.push(chunk);
      return true;
    });
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

describe('KittyRenderer dirty rects', () => {
  it('sends a delta frame edit for a small change after the initial window', () => {
    const r = new KittyRenderer({ sourceWidth: 8, sourceHeight: 8, scale: 1, dirtyRects: true });
    const base = rgbFrame(8, 8, 100);
    warmup(r, base);

    const payload = r.renderRgb24(withPixel(base, 8, 5, 3));
    expect(payload).toContain('a=f');
    expect(payload).toContain('x=5,y=3');
    expect(payload).not.toContain('a=T');
    expect(payload).not.toContain('a=d');
  });

  it('scales delta placement by the render scale', () => {
    const r = new KittyRenderer({ sourceWidth: 8, sourceHeight: 8, scale: 2, dirtyRects: true });
    const base = rgbFrame(8, 8, 100);
    warmup(r, base);

    const payload = r.renderRgb24(withPixel(base, 8, 5, 3));
    expect(payload).toContain('a=f');
    expect(payload).toContain('x=10,y=6');
  });

  it('computes delta rects for rgb15 frames', () => {
    const r = new KittyRenderer({ sourceWidth: 8, sourceHeight: 8, scale: 1, colorSpace: 'rgb15', dirtyRects: true });
    const base = new Uint16Array(8 * 8).fill(0x1234);
    for (let i = 0; i < 10; i++) {
      r.renderRgb15(base);
    }
    const changed = Uint16Array.from(base);
    changed[2 * 8 + 6] = 0x7fff; // pixel (6,2)
    const payload = r.renderRgb15(changed);
    expect(payload).toContain('a=f');
    expect(payload).toContain('x=6,y=2');
  });

  it('keeps full transmissions when dirty rects are off or support is unknown', () => {
    resetKittyAnimationDetection();
    for (const options of [{}, { dirtyRects: false }]) {
      const r = new KittyRenderer({ sourceWidth: 8, sourceHeight: 8, scale: 1, ...options });
      const base = rgbFrame(8, 8, 100);
      warmup(r, base);
      const payload = r.renderRgb24(withPixel(base, 8, 5, 3));
      expect(payload).toContain('a=T');
      expect(payload).not.toContain('a=f');
    }
  });

  it('keeps full transmissions for non-integer scales', () => {
    const r = new KittyRenderer({ sourceWidth: 8, sourceHeight: 8, scale: 0.5, dirtyRects: true });
    const base = rgbFrame(8, 8, 100);
    warmup(r, base);
    const payload = r.renderRgb24(withPixel(base, 8, 5, 3));
    expect(payload).toContain('a=T');
    expect(payload).not.toContain('a=f');
  });

  it('widens the delta to the full frame when non-local effects are enabled', () => {
    const r = new KittyRenderer({ sourceWidth: 8, sourceHeight: 8, scale: 1, dirtyRects: true, bloom: 0.4 });
    const base = rgbFrame(8, 8, 100);
    warmup(r, base);
    const payload = r.renderRgb24(withPixel(base, 8, 5, 3));
    expect(payload).toContain('a=f');
    expect(payload).toContain('x=0,y=0'); // full-frame rect, still an in-place edit
  });

  it('sends a full frame again after a resize', () => {
    const r = new KittyRenderer({ sourceWidth: 8, sourceHeight: 8, scale: 1, dirtyRects: true });
    const base = rgbFrame(8, 8, 100);
    warmup(r, base);
    expect(r.renderRgb24(withPixel(base, 8, 1, 1))).toContain('a=f'); // delta mode reached

    r.setDimensions(); // resize clears images; the next frame must retransmit
    const payload = r.renderRgb24(withPixel(base, 8, 2, 2));
    expect(payload).toContain('a=T');
  });

  it('renders a full frame after a resize even when pixels are unchanged', () => {
    const r = new KittyRenderer({ sourceWidth: 8, sourceHeight: 8, scale: 1, dirtyRects: true });
    const base = rgbFrame(8, 8, 100);
    warmup(r, base);

    r.setDimensions();
    const payload = r.renderRgb24(base); // identical pixels, but the screen was cleared
    expect(payload).toContain('a=T');
  });

  it('re-sends dropped delta damage with the next frame', () => {
    const worker = new FakeEncodeWorker();
    let accept = true;
    const r = new KittyRenderer({
      sourceWidth: 8,
      sourceHeight: 8,
      scale: 1,
      dirtyRects: true,
      encodeWorkerFactory: () => worker,
    });
    r.setOutputSink(() => accept);

    const base = rgbFrame(8, 8, 100);
    for (let i = 0; i < 10; i++) {
      const before = worker.requests.length;
      r.renderRgb24(base);
      if (worker.requests.length > before) {
        worker.respond('p'); // respond only when a frame was actually submitted
      }
    }

    accept = false;
    const changeA = withPixel(base, 8, 1, 1);
    r.renderRgb24(changeA);
    worker.respond('pA'); // delivery fails: damage at (1,1) must be remembered

    accept = true;
    const changeB = withPixel(changeA, 8, 5, 6);
    r.renderRgb24(changeB);
    const meta = worker.requests[worker.requests.length - 1].meta;
    expect(meta.transmit).toBe('delta');
    expect(meta.dirtyRect).toEqual({ x: 1, y: 1, width: 5, height: 6 }); // union of (1,1) and (5,6)
  });

  it('forces a full retransmit after a dropped full payload, then returns to delta', () => {
    const worker = new FakeEncodeWorker();
    let accept = true;
    const r = new KittyRenderer({
      sourceWidth: 8,
      sourceHeight: 8,
      scale: 1,
      dirtyRects: true,
      encodeWorkerFactory: () => worker,
    });
    r.setOutputSink(() => accept);

    const base = rgbFrame(8, 8, 100);
    warmupWithWorker(r, worker, base); // exhausts the initial full-render window

    // Force a full transmit outside the initial window (a resize clears
    // images) and drop it at the sink.
    r.setDimensions();
    accept = false;
    r.renderRgb24(base);
    worker.respond('p0');
    expect(worker.requests[worker.requests.length - 1].meta.transmit).toBe('full');

    // The drop must force the next frame to retransmit fully too, even
    // though its change is small enough for a delta.
    accept = true;
    const changeA = withPixel(base, 8, 5, 3);
    r.renderRgb24(changeA);
    worker.respond('p1');
    expect(worker.requests[worker.requests.length - 1].meta.transmit).toBe('full');

    // Once that full frame delivers, a later small change goes back to delta.
    const changeB = withPixel(changeA, 8, 2, 2);
    r.renderRgb24(changeB);
    expect(worker.requests[worker.requests.length - 1].meta.transmit).toBe('delta');
  });

  it('renders a repair delta for a pixel-identical frame when damage is pending', () => {
    const worker = new FakeEncodeWorker();
    let accept = true;
    const r = new KittyRenderer({
      sourceWidth: 8,
      sourceHeight: 8,
      scale: 1,
      dirtyRects: true,
      encodeWorkerFactory: () => worker,
    });
    r.setOutputSink(() => accept);

    const base = rgbFrame(8, 8, 100);
    warmupWithWorker(r, worker, base);

    accept = false;
    const changeA = withPixel(base, 8, 3, 4);
    r.renderRgb24(changeA);
    worker.respond('pA'); // delivery fails: damage at (3,4) must be remembered

    accept = true;
    const before = worker.requests.length;
    r.renderRgb24(changeA); // pixel-identical to the last render
    expect(worker.requests.length).toBeGreaterThan(before); // not skipped: damage is pending
    const meta = worker.requests[worker.requests.length - 1].meta;
    expect(meta.transmit).toBe('delta');
    expect(meta.dirtyRect).toEqual({ x: 3, y: 4, width: 1, height: 1 });
  });

  it('targets deltas at the image id of the last full transmission', () => {
    const worker = new FakeEncodeWorker();
    const r = new KittyRenderer({
      sourceWidth: 8,
      sourceHeight: 8,
      scale: 1,
      dirtyRects: true,
      encodeWorkerFactory: () => worker,
    });
    r.setOutputSink(() => true);

    const base = rgbFrame(8, 8, 100);
    warmupWithWorker(r, worker, base);

    // Force one more full transmission (a resize clears images) so the
    // "last full transmission" id isn't just the renderer's initial default,
    // which the warmup window's odd frame count would otherwise coincide with.
    r.setDimensions();
    r.renderRgb24(base);
    worker.respond('full-again');
    const fullMeta = worker.requests[worker.requests.length - 1].meta;
    expect(fullMeta.transmit).toBe('full');

    r.renderRgb24(withPixel(base, 8, 5, 3));
    const deltaMeta = worker.requests[worker.requests.length - 1].meta;
    expect(deltaMeta.transmit).toBe('delta');
    expect(deltaMeta.currentImageId).toBe(fullMeta.currentImageId);
    expect(deltaMeta.deletePrevious).toBe(false);
  });
});

describe('KittyRenderer file transfer', () => {
  it('uses the file medium with unique per-frame paths when forced on', () => {
    const worker = new FakeEncodeWorker();
    const r = new KittyRenderer({
      sourceWidth: 8,
      sourceHeight: 8,
      scale: 1,
      fileTransfer: true,
      encodeWorkerFactory: () => worker,
    });
    r.setOutputSink(() => true);

    r.renderRgb24(rgbFrame(8, 8, 10));
    worker.respond('p0');
    r.renderRgb24(rgbFrame(8, 8, 20));

    const [first, second] = worker.requests.map((request) => request.meta);
    expect(first.medium).toBe('file');
    expect(first.filePath).toContain(FRAME_FILE_PREFIX);
    expect(second.filePath).toContain(FRAME_FILE_PREFIX);
    expect(second.filePath).not.toBe(first.filePath);
    r.destroy();
  });

  it('stays on the escape medium when detection has not run or when forced off', () => {
    resetKittyFileTransferDetection();
    for (const options of [{}, { fileTransfer: false }]) {
      const r = new KittyRenderer({ sourceWidth: 8, sourceHeight: 8, scale: 1, ...options });
      const payload = r.renderRgb24(rgbFrame(8, 8, 10));
      expect(payload).toContain('a=T');
      expect(payload).not.toContain('t=t');
      r.destroy();
    }
  });

  it('unlinks the frame file when the payload is dropped at the sink', () => {
    const worker = new FakeEncodeWorker();
    const r = new KittyRenderer({
      sourceWidth: 8,
      sourceHeight: 8,
      scale: 1,
      fileTransfer: true,
      encodeWorkerFactory: () => worker,
    });
    r.setOutputSink(() => false); // gate rejects every write

    r.renderRgb24(rgbFrame(8, 8, 10));
    const { filePath } = worker.requests[0].meta;
    writeFileSync(filePath!, 'png-bytes'); // simulate the worker-side encoder write
    worker.respond('p0'); // delivery fails: renderer must clean the file up

    expect(existsSync(filePath!)).toBe(false);
    r.destroy();
  });

  it('sweeps stale frame files at construction when file transfer is possible', () => {
    const stale = join(tmpdir(), `${FRAME_FILE_PREFIX}stale-test-1.png`);
    writeFileSync(stale, 'x');
    const oldTime = (Date.now() - 3_600_000) / 1_000;
    utimesSync(stale, oldTime, oldTime);

    new KittyRenderer({ sourceWidth: 4, sourceHeight: 4, scale: 1, fileTransfer: true }).destroy();

    expect(existsSync(stale)).toBe(false);
  });
});

describe('KittyRenderer region and embedded', () => {
  // Parse the leading cursor-move (\x1b[<row>;<col>H) of a full-frame payload
  const cursorMove = (payload: string): { row: number; col: number } => {
    const match = /\x1b\[(\d+);(\d+)H/.exec(payload);
    if (match === null) {
      throw new Error('payload has no cursor-move sequence');
    }
    return { row: Number(match[1]), col: Number(match[2]) };
  };

  // Extract this instance's base image id from its first full-frame payload
  // (a=T control carries i=<id>). Must be called only once per renderer: a
  // later frame flips the double-buffer parity to imageId + 1.
  const imageIdOf = (r: KittyRenderer): number => {
    const match = /i=(\d+)/.exec(r.renderRgb24(rgbFrame(4, 4, 100)));
    if (match === null) {
      throw new Error('payload has no image id');
    }
    return Number(match[1]);
  };

  it('confines the full-frame cursor move and layout to the region box', () => {
    const region = { offsetCol: 10, offsetRow: 4, cols: 40, rows: 16 };
    const r = new KittyRenderer({ sourceWidth: 4, sourceHeight: 4, scale: 1, region, fileTransfer: false });
    const payload = r.renderRgb24(rgbFrame(4, 4, 100));
    expect(payload).toContain('a=T'); // first frame is a full transmit

    const { row, col } = cursorMove(payload);
    expect(row).toBeGreaterThanOrEqual(region.offsetRow);
    expect(col).toBeGreaterThanOrEqual(region.offsetCol);

    const { cols, rows } = r.getDisplaySize();
    expect(cols).toBeLessThanOrEqual(region.cols);
    expect(rows).toBeLessThanOrEqual(region.rows);
    // Origin plus extent stays inside the box on both axes
    expect(col + cols).toBeLessThanOrEqual(region.offsetCol + region.cols);
    expect(row + rows).toBeLessThanOrEqual(region.offsetRow + region.rows);
    expect(r.getStatusRow()).toBeLessThanOrEqual(region.offsetRow + region.rows);
  });

  it('deletes only its own images and skips the full clear when embedded', () => {
    const r = new KittyRenderer({ sourceWidth: 4, sourceHeight: 4, scale: 1, embedded: true, fileTransfer: false });
    const id = imageIdOf(r);
    const cleared = r.clearScreen();
    expect(cleared).toContain(`a=d,d=I,i=${id},`);
    expect(cleared).toContain(`a=d,d=I,i=${id + 1},`);
    expect(cleared).not.toContain('\x1b[2J'); // no full-screen wipe
    expect(cleared).not.toContain('d=A'); // no delete-all
  });

  it('deletes all images and clears the screen when not embedded', () => {
    const r = new KittyRenderer({ sourceWidth: 4, sourceHeight: 4, scale: 1 });
    const cleared = r.clearScreen();
    expect(cleared).toContain('d=A');
    expect(cleared).toContain('\x1b[2J');
  });

  it('gives each instance a distinct image-id base', () => {
    const r1 = new KittyRenderer({ sourceWidth: 4, sourceHeight: 4, scale: 1, embedded: true, fileTransfer: false });
    const r2 = new KittyRenderer({ sourceWidth: 4, sourceHeight: 4, scale: 1, embedded: true, fileTransfer: false });
    const id1 = imageIdOf(r1);
    const id2 = imageIdOf(r2);
    expect(id1).not.toBe(id2);
    // Constructed back to back, so r2's base is exactly one stride past r1's
    expect(id2).toBe(id1 + IMAGE_ID_STRIDE);
    // Embedded clears delete each instance's own ids, so they differ too
    expect(r1.clearScreen()).not.toBe(r2.clearScreen());
  });

  it('suppresses cursor toggles when embedded but not otherwise', () => {
    const embedded = new KittyRenderer({ sourceWidth: 4, sourceHeight: 4, scale: 1, embedded: true });
    expect(embedded.hideCursor()).toBe('');
    expect(embedded.showCursor()).toBe('');

    const owned = new KittyRenderer({ sourceWidth: 4, sourceHeight: 4, scale: 1 });
    expect(owned.hideCursor()).not.toBe('');
    expect(owned.showCursor()).not.toBe('');
  });
});

describe('KittyRenderer unicode placement', () => {
  const PLACEHOLDER = '\u{10EEEE}';
  const hasCursorMove = (payload: string): boolean => /\x1b\[\d+;\d+H/.test(payload);

  // Extract the image id from a full-frame payload's a=T control (i=<id>)
  const imageIdOf = (payload: string): number => {
    const match = /i=(\d+)/.exec(payload);
    if (match === null) {
      throw new Error('payload has no image id');
    }
    return Number(match[1]);
  };

  // Uses the default render scale (integer, so partial deltas are allowed) and
  // no file transfer, so payloads are inline escapes the assertions can read.
  const unicodeRenderer = (extra: Record<string, unknown> = {}): KittyRenderer =>
    new KittyRenderer({
      placement: 'unicode',
      region: { offsetCol: 1, offsetRow: 1, cols: 20, rows: 10 },
      sourceWidth: 8,
      sourceHeight: 8,
      fileTransfer: false,
      ...extra,
    });

  it('sends a virtual placement (U=1) with the cell grid and no cursor move on the first frame', () => {
    const r = unicodeRenderer();
    const { cols, rows } = r.getDisplaySize();
    const payload = r.renderRgb24(rgbFrame(8, 8, 100));

    expect(payload).toContain('a=T');
    expect(payload).toContain('U=1');
    expect(payload).toContain(`c=${cols}`);
    expect(payload).toContain(`r=${rows}`);
    expect(hasCursorMove(payload)).toBe(false); // host placeholder cells position it
  });

  it('edits pixels in place with a=f after the create when the terminal supports frame edits', () => {
    // dirtyRects: true forces frame-edit support on (the animation probe is
    // unresolved in tests, so it would otherwise be treated as unsupported).
    const r = unicodeRenderer({ dirtyRects: true });
    const base = rgbFrame(8, 8, 100);
    r.renderRgb24(base); // initial full create

    const payload = r.renderRgb24(withPixel(base, 8, 5, 3));
    expect(payload).toContain('a=f');
    expect(payload).not.toContain('U=1'); // a full re-transmit would delete the placement
    expect(payload).not.toContain('a=T');
    expect(hasCursorMove(payload)).toBe(false);
  });

  it('re-transmits with a=t (no a=f) after the create when frame edits are unsupported', () => {
    // dirtyRects: false models a terminal without the animation protocol
    // (Ghostty): every non-create frame re-transmits image data to the same id.
    const r = unicodeRenderer({ dirtyRects: false });
    const base = rgbFrame(8, 8, 100);
    r.renderRgb24(base); // initial full create (a=T,U=1)

    const payload = r.renderRgb24(withPixel(base, 8, 5, 3));
    expect(payload).toContain('a=t,'); // data re-transmit to the same id
    expect(payload).not.toContain('a=f'); // no animation frame edit
    expect(payload).not.toContain('U=1'); // not recreating the placement
    expect(payload).not.toContain('a=T'); // not a create-and-display
    expect(hasCursorMove(payload)).toBe(false);
  });

  it('builds one placeholder row per grid row, carrying the image id in the foreground color', () => {
    const r = unicodeRenderer();
    const { cols, rows } = r.getDisplaySize();
    const imageId = imageIdOf(r.renderRgb24(rgbFrame(8, 8, 100)));

    const placeholderRows = r.getPlaceholderRows();
    expect(placeholderRows).toHaveLength(rows);
    for (const row of placeholderRows) {
      // Count placeholder code points (each is a surrogate pair in a JS string)
      expect([...row].filter((ch) => ch === PLACEHOLDER)).toHaveLength(cols);
      expect(row).toContain(encodeImageIdFg(imageId));
    }
  });

  it('deletes only the single stable image id when embedded', () => {
    const r = unicodeRenderer({ embedded: true });
    const imageId = imageIdOf(r.renderRgb24(rgbFrame(8, 8, 100)));

    const cleared = r.clearScreen();
    const deletes = cleared.match(/a=d,d=I,i=\d+,/g) ?? [];
    expect(deletes).toHaveLength(1); // no double-buffer, so exactly one delete
    expect(cleared).toContain(`a=d,d=I,i=${imageId},`);
    expect(cleared).not.toContain('\x1b[2J'); // no full-screen wipe
  });

  it('returns no placeholder rows and keeps cursor placement in the default (cursor) mode', () => {
    const r = new KittyRenderer({ sourceWidth: 8, sourceHeight: 8, scale: 1, fileTransfer: false });
    expect(r.getPlaceholderRows()).toEqual([]);

    const payload = r.renderRgb24(rgbFrame(8, 8, 100));
    expect(hasCursorMove(payload)).toBe(true);
    expect(payload).toContain('a=T');
    expect(payload).not.toContain('U=1');
  });
});

describe('KittyRenderer bounded processing on full transmits', () => {
  it('narrows the processing rect to the damage while still transmitting fully', () => {
    const messages: string[] = [];
    const r = new KittyRenderer({
      sourceWidth: 8, sourceHeight: 8, scale: 1, dirtyRects: false,
      onDebug: (m) => messages.push(m),
    });
    const base = rgbFrame(8, 8, 100);
    warmup(r, base);
    const payload = r.renderRgb24(withPixel(base, 8, 5, 3));
    expect(payload).toContain('a=T'); // still a full transmit
    expect(messages.some((m) => m.includes('processRect=5,3 1x1'))).toBe(true);
  });

  it('produces the same processed pixels as full reprocessing', () => {
    const opts = {
      sourceWidth: 8, sourceHeight: 8, scale: 1, dirtyRects: false,
      gamma: 1.4, scanlines: 0.5, vignette: 0.3, brightness: 1.1,
    };
    const bounded = new KittyRenderer(opts);
    const control = new KittyRenderer({ ...opts, enableDiffRendering: false });
    const base = rgbFrame(8, 8, 100);
    const changed = withPixel(base, 8, 5, 3);
    warmup(bounded, base);
    warmup(control, base);
    bounded.renderRgb24(changed);
    control.renderRgb24(changed);
    expect(bounded.captureRgb().data).toEqual(control.captureRgb().data);
  });

  it('processes fully again after a diff state reset', () => {
    const messages: string[] = [];
    const r = new KittyRenderer({
      sourceWidth: 8, sourceHeight: 8, scale: 1, dirtyRects: false,
      onDebug: (m) => messages.push(m),
    });
    const base = rgbFrame(8, 8, 100);
    warmup(r, base);
    r.setDimensions(); // resize path sets needsFullTransmit
    messages.length = 0;
    r.renderRgb24(withPixel(base, 8, 2, 2));
    expect(messages.some((m) => m.includes('processRect=0,0 8x8'))).toBe(true);
  });
});

describe('KittyRenderer dilated deltas under bounded spread effects', () => {
  const randomFrame = (w: number, h: number, seed: number): Uint8Array => {
    const frame = new Uint8Array(w * h * 3);
    let s = seed;
    for (let i = 0; i < frame.length; i++) {
      s = (s * 1_103_515_245 + 12_345) & 0x7fffffff;
      frame[i] = (s >> 16) & 0xff;
    }
    return frame;
  };

  it('keeps delta frames and dilates the rect by the effect reach', () => {
    const r = new KittyRenderer({
      sourceWidth: 32, sourceHeight: 32, scale: 1, dirtyRects: true,
      fileTransfer: false, bloom: 0.5,
    });
    const base = rgbFrame(32, 32, 40);
    warmup(r, base);
    const payload = r.renderRgb24(withPixel(base, 32, 16, 16));
    expect(payload).toContain('a=f');
    // A 1x1 change at (16,16) dilates by BLOOM_REACH on each side
    expect(payload).toContain(`x=${16 - BLOOM_REACH},y=${16 - BLOOM_REACH}`);
  });

  it('matches full-frame processing pixel-for-pixel across a delta sequence', () => {
    const opts = {
      sourceWidth: 32, sourceHeight: 32, scale: 1, fileTransfer: false,
      bloom: 0.6, bloomThreshold: 0.2, ntsc: 0.5, chromaticAberration: 0.5,
      scanlines: 0.4, vignette: 0.3,
    };
    const bounded = new KittyRenderer({ ...opts, dirtyRects: true });
    const control = new KittyRenderer({ ...opts, enableDiffRendering: false, dirtyRects: false });
    const base = randomFrame(32, 32, 7);
    warmup(bounded, base);
    warmup(control, base);
    for (const [x, y] of [[20, 12], [3, 3], [30, 30]] as const) {
      const changed = withPixel(base, 32, x, y);
      bounded.renderRgb24(changed);
      control.renderRgb24(changed);
      expect(bounded.captureRgb().data).toEqual(control.captureRgb().data);
      bounded.renderRgb24(base);
      control.renderRgb24(base);
      expect(bounded.captureRgb().data).toEqual(control.captureRgb().data);
    }
  });

  it('keeps full-frame rects while curvature is enabled', () => {
    const r = new KittyRenderer({
      sourceWidth: 8, sourceHeight: 8, scale: 1, dirtyRects: true,
      fileTransfer: false, curvature: 0.3,
    });
    const base = rgbFrame(8, 8, 100);
    warmup(r, base);
    const payload = r.renderRgb24(withPixel(base, 8, 5, 3));
    expect(payload).toContain('a=f');
    expect(payload).toContain('x=0,y=0'); // full-frame edit, not a sub-rect
  });
});
