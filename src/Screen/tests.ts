import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { AUTO_DISPOSE_SIGNALS, createScreen, Screen } from './index.ts';
import {
  detectKittyGraphicsSupport,
  getKittyAnimationSupported,
  getKittyFileTransferSupported,
  getKittyGraphicsSupported,
  resetKittyAnimationDetection,
  resetKittyFileTransferDetection,
  resetKittyGraphicsDetection,
} from '../kittyProtocol/index.ts';
import { resetCellPixelSizeDetection } from '../terminal/index.ts';
import { KittyFrameEncoder } from '../kittyEncode/index.ts';
import { EMOJI_COLORS } from '../color/index.ts';
import type { DrainableStream } from '../OutputGate/index.ts';

// Glyph mode auto-detects from TERM_PROGRAM. Pin the environment so cell-mode
// expectations hold regardless of which terminal runs the tests.
delete process.env['TERM_PROGRAM'];

class FakeStream implements DrainableStream {
  chunks: string[] = [];
  blocked = false;
  private drainCb: (() => void) | null = null;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.blocked;
  }
  once(_event: 'drain', cb: () => void): void {
    this.drainCb = cb;
  }
  drain(): void {
    this.blocked = false;
    this.drainCb?.();
  }
}

const frame = (fill: number): Uint8Array => new Uint8Array(4 * 4 * 3).fill(fill);

// KittyRenderer.setOutputSink() always spins up a KittyEncodeWorkerClient. Its
// default factory constructs a real Node `Worker` that only reports failure
// asynchronously (an `error` event once module resolution fails). It never
// throws synchronously, even when the worker bundle doesn't exist (as here,
// running unbundled from src/). So a synchronous test that omits
// `workerFactory` does NOT get the sync encode path: `isAvailable()` reads
// true at pushFrame time, the frame is submitted into the worker, and it is
// permanently lost when the worker fails later (there's no replay-on-failure).
// Passing `workerFactory: () => null` makes KittyEncodeWorkerClient fail
// synchronously in its constructor, deterministically forcing the sync path.
const NO_WORKER = (): null => null;

describe('Screen', () => {
  it('writes setup sequences on creation and a payload on pushFrame', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      scale: 1,
      workerFactory: NO_WORKER,
    });
    const setupChunks = stream.chunks.length;
    expect(setupChunks).toBeGreaterThan(0); // hide cursor + clear
    screen.pushFrame(frame(80));
    expect(stream.chunks.length).toBeGreaterThan(setupChunks);
    expect(stream.chunks.join('')).toContain('\x1b_G'); // Kitty APC introducer
    screen.dispose();
  });

  it('drops frames while the stream is blocked and resumes after drain', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      scale: 1,
      workerFactory: NO_WORKER,
    });
    screen.pushFrame(frame(10));
    stream.blocked = true;
    screen.pushFrame(frame(20)); // this write returns false -> gate blocks
    const during = stream.chunks.length;
    screen.pushFrame(frame(30)); // dropped entirely
    expect(stream.chunks.length).toBe(during);
    stream.drain();
    screen.pushFrame(frame(40));
    expect(stream.chunks.length).toBeGreaterThan(during);
    screen.dispose();
  });

  it('isWritable reflects gate state and disposal', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      scale: 1,
      workerFactory: NO_WORKER,
    });
    expect(screen.isWritable()).toBe(true);
    stream.blocked = true;
    screen.pushFrame(frame(10)); // this write returns false -> gate blocks
    expect(screen.isWritable()).toBe(false);
    stream.drain();
    expect(screen.isWritable()).toBe(true);
    screen.dispose();
    expect(screen.isWritable()).toBe(false);
  });

  it('recomputes layout on SIGWINCH by default', () => {
    const stream = new FakeStream();
    const screen = new Screen({ sourceWidth: 4, sourceHeight: 4, output: stream, scale: 1, workerFactory: NO_WORKER });
    const before = stream.chunks.length;
    process.emit('SIGWINCH');
    expect(stream.chunks.length).toBeGreaterThan(before); // clear-screen write from handleResize
    screen.dispose();
  });

  it('does not listen for SIGWINCH when autoResize is false', () => {
    const stream = new FakeStream();
    const listenersBefore = process.listenerCount('SIGWINCH');
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      scale: 1,
      workerFactory: NO_WORKER,
      autoResize: false,
    });
    expect(process.listenerCount('SIGWINCH')).toBe(listenersBefore);
    const before = stream.chunks.length;
    process.emit('SIGWINCH');
    expect(stream.chunks.length).toBe(before);
    screen.dispose();
  });

  it('removes the SIGWINCH listener on dispose', () => {
    const stream = new FakeStream();
    const listenersBefore = process.listenerCount('SIGWINCH');
    const screen = new Screen({ sourceWidth: 4, sourceHeight: 4, output: stream, scale: 1, workerFactory: NO_WORKER });
    expect(process.listenerCount('SIGWINCH')).toBe(listenersBefore + 1);
    screen.dispose();
    expect(process.listenerCount('SIGWINCH')).toBe(listenersBefore);
    const afterDispose = stream.chunks.length;
    process.emit('SIGWINCH');
    expect(stream.chunks.length).toBe(afterDispose);
  });

  it('restores the cursor on dispose', () => {
    const stream = new FakeStream();
    const screen = new Screen({ sourceWidth: 4, sourceHeight: 4, output: stream, scale: 1, workerFactory: NO_WORKER });
    screen.dispose();
    expect(stream.chunks.join('')).toContain('\x1b[?25h'); // show cursor
  });

  it('disposes when leaving a using scope', () => {
    const stream = new FakeStream();
    {
      using screen = new Screen({ sourceWidth: 4, sourceHeight: 4, output: stream, scale: 1, workerFactory: NO_WORKER });
      screen.pushFrame(frame(10));
      expect(stream.chunks.join('')).not.toContain('\x1b[?25h');
    }
    expect(stream.chunks.join('')).toContain('\x1b[?25h'); // cursor restored on scope exit
  });

  it('Symbol.dispose after dispose() is a no-op', () => {
    const stream = new FakeStream();
    const screen = new Screen({ sourceWidth: 4, sourceHeight: 4, output: stream, scale: 1, workerFactory: NO_WORKER });
    screen.dispose();
    const chunksAfterDispose = stream.chunks.length;
    screen[Symbol.dispose]();
    expect(stream.chunks.length).toBe(chunksAfterDispose); // no second teardown write
  });

  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  describe('capture', () => {
    const makeScreen = (renderMode?: 'half-block'): Screen =>
      new Screen({
        sourceWidth: 4,
        sourceHeight: 4,
        output: new FakeStream(),
        scale: 1,
        workerFactory: NO_WORKER,
        renderMode,
      });

    it('captureRgb returns the last frame as rgb at source resolution', () => {
      const screen = makeScreen();
      screen.pushFrame(frame(80));
      const shot = screen.captureRgb();
      expect(shot.width).toBe(4);
      expect(shot.height).toBe(4);
      expect([...shot.data]).toEqual(new Array(4 * 4 * 3).fill(80));
      screen.dispose();
    });

    it('captureRgb is a copy, not a live view of the render buffer', () => {
      const screen = makeScreen();
      screen.pushFrame(frame(10));
      const first = screen.captureRgb();
      screen.pushFrame(frame(20)); // re-render mutates the internal buffer
      expect(first.data.every((v) => v === 10)).toBe(true); // snapshot unchanged
      expect(screen.captureRgb().data.every((v) => v === 20)).toBe(true);
      screen.dispose();
    });

    it('captureRgb before the first frame is zero-filled', () => {
      const screen = makeScreen();
      expect(screen.captureRgb().data.every((v) => v === 0)).toBe(true);
      screen.dispose();
    });

    it('capturePng returns standalone PNG bytes', () => {
      const screen = makeScreen();
      screen.pushFrame(frame(80));
      const png = screen.capturePng();
      expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
      screen.dispose();
    });

    it('captures the underlying raster in cell render mode too', () => {
      const screen = makeScreen('half-block');
      expect(screen.getRenderMode()).toBe('half-block');
      screen.pushFrame(frame(80));
      expect([...screen.captureRgb().data]).toEqual(new Array(4 * 4 * 3).fill(80));
      expect([...screen.capturePng().subarray(0, 8)]).toEqual(PNG_SIGNATURE);
      screen.dispose();
    });

    it('capturePng uses max compression, ignoring pngCompressionLevel', () => {
      // A compression-sensitive raster (varied bytes, no Math.random so it
      // stays deterministic) so deflate level actually changes the output.
      const width = 48;
      const height = 48;
      const raster = new Uint8Array(width * height * 3);
      for (let i = 0; i < raster.length; i++) {
        raster[i] = (i * 37 + ((i * i) >> 3)) & 0xff;
      }

      // A screen configured for the fastest render-loop compression still
      // snapshots at max compression: its PNG equals a level-9 encode of the
      // captured raster, not the level-1 encode the option would imply.
      const screen = new Screen({
        sourceWidth: width,
        sourceHeight: height,
        output: new FakeStream(),
        scale: 1,
        workerFactory: NO_WORKER,
        pngCompressionLevel: 1,
      });
      screen.pushFrame(raster);
      const shot = screen.captureRgb();
      const png = screen.capturePng();
      screen.dispose();

      const encoder = new KittyFrameEncoder();
      const atLevel9 = encoder.encodeImage(shot.data, shot.width, shot.height, 9);
      const atLevel1 = encoder.encodeImage(shot.data, shot.width, shot.height, 1);
      // Sanity: the raster really is compression-sensitive, so equality below is meaningful
      expect([...atLevel9]).not.toEqual([...atLevel1]);
      expect([...png]).toEqual([...atLevel9]);
    });
  });

  it('updateOptions takes effect on subsequent frames', () => {
    const stream = new FakeStream();
    const screen = new Screen({ sourceWidth: 4, sourceHeight: 4, output: stream, scale: 1, workerFactory: NO_WORKER });
    screen.pushFrame(frame(60));
    screen.updateOptions({ pngCompressionLevel: 9 });
    // Re-push the SAME frame: updateOptions resets diff state, so it renders again
    screen.pushFrame(frame(60));
    const apcCount = stream.chunks.filter((c) => c.includes('\x1b_G')).length;
    expect(apcCount).toBeGreaterThanOrEqual(2);
    screen.dispose();
  });

  it('passes dirtyRects through to the renderer', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 8,
      sourceHeight: 8,
      scale: 1,
      output: stream,
      workerFactory: NO_WORKER,
      dirtyRects: true,
    });

    const base = new Uint8Array(8 * 8 * 3).fill(100);
    for (let i = 0; i < 10; i++) {
      screen.pushFrame(base);
    }
    const changed = Uint8Array.from(base);
    changed.set([1, 2, 3], (3 * 8 + 5) * 3);
    screen.pushFrame(changed);

    expect(stream.chunks.some((chunk) => chunk.includes('a=f'))).toBe(true);
    screen.dispose();
  });

  it('passes fileTransfer through to the renderer', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 8,
      sourceHeight: 8,
      scale: 1,
      output: stream,
      workerFactory: NO_WORKER,
      fileTransfer: true,
    });

    screen.pushFrame(new Uint8Array(8 * 8 * 3).fill(100));

    expect(stream.chunks.some((chunk) => chunk.includes('t=t'))).toBe(true);

    // The frame file is real (written to disk); nothing in this test drains
    // it via the terminal's t=t deletion, so clean it up ourselves.
    const fileChunk = stream.chunks.find((c) => c.includes('t=t'))!;
    const encodedPath = /;([A-Za-z0-9+/=]+)\x1b\\/.exec(fileChunk)![1];
    unlinkSync(Buffer.from(encodedPath, 'base64').toString());

    screen.dispose();
  });
});

describe('Screen cell render mode', () => {
  it('forces the cell renderer via renderMode and emits SGR, not APC', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
      workerFactory: NO_WORKER,
    });
    expect(screen.getRenderMode()).toBe('half-block');
    screen.pushFrame(frame(80));
    const output = stream.chunks.join('');
    expect(output).toContain('\x1b['); // SGR/cursor output
    expect(output).not.toContain('\x1b_G'); // no Kitty APC
    screen.dispose();
  });

  it('defaults to the kitty renderer when the graphics probe never ran', () => {
    resetKittyGraphicsDetection();
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      workerFactory: NO_WORKER,
    });
    expect(screen.getRenderMode()).toBe('kitty');
    screen.dispose();
  });

  it('passes limitColors through to the cell renderer', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
      limitColors: 256,
      workerFactory: NO_WORKER,
    });
    screen.pushFrame(frame(80));
    const output = stream.chunks.join('');
    expect(output).toContain('▀'); // half-block glyph
    expect(output).toContain('38;5;'); // 256-color SGR
    screen.dispose();
  });

  it('notes ignored kitty-only options through onDebug in cell mode', () => {
    const stream = new FakeStream();
    const messages: string[] = [];
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
      dirtyRects: true,
      pngCompressionLevel: 9,
      workerFactory: NO_WORKER,
      onDebug: (message) => messages.push(message),
    });
    expect(messages.some((m) => m.includes('ignoring') && m.includes('dirtyRects'))).toBe(true);
    screen.dispose();
  });

  it('updateOptions can switch render modes', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
      workerFactory: NO_WORKER,
    });
    screen.updateOptions({ renderMode: 'kitty' });
    expect(screen.getRenderMode()).toBe('kitty');
    screen.dispose();
  });

  it("clears the outgoing renderer's screen when switching from kitty to cell mode", () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'kitty',
      workerFactory: NO_WORKER,
    });
    const beforeSwitch = stream.chunks.length;
    screen.updateOptions({ renderMode: 'half-block' });
    const switchChunks = stream.chunks.slice(beforeSwitch);
    expect(switchChunks.some((chunk) => chunk.includes('a=d,d=A'))).toBe(true); // Kitty delete sequence
    screen.dispose();
  });

  it("clears the outgoing renderer's screen when switching from cell to kitty mode", () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
      workerFactory: NO_WORKER,
    });
    const beforeSwitch = stream.chunks.length;
    screen.updateOptions({ renderMode: 'kitty' });
    const switchChunks = stream.chunks.slice(beforeSwitch);
    // SGR reset immediately followed by the ANSI clear, in the same chunk
    expect(switchChunks.some((chunk) => chunk.includes('\x1b[0m\x1b[2J'))).toBe(true);
    screen.dispose();
  });

  it('renders cell-background mode when renderMode is cell-background', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'cell-background',
      limitColors: 0,
    });
    screen.pushFrame(frame(80));
    const out = stream.chunks.join('');
    expect(out).toContain('48;2;80;80;80');
    expect(out).not.toContain('▀');
    expect(out).not.toContain('38;2;');
    screen.dispose();
  });

  it('renders emoji glyphs when renderMode is emoji', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'emoji',
      workerFactory: NO_WORKER,
    });
    expect(screen.getRenderMode()).toBe('emoji');
    screen.pushFrame(frame(80));
    const out = stream.chunks.join('');
    expect(out).not.toContain('\x1b_G'); // no kitty APC
    expect(out).not.toContain('38;'); // no SGR fg
    expect(out).not.toContain('48;'); // no SGR bg
    expect(EMOJI_COLORS.some((c) => out.includes(c.emoji))).toBe(true);
    screen.dispose();
  });

  it('passes cellSampling through to the cell renderer', () => {
    const stream = new FakeStream();
    const debugLines: string[] = [];
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
      limitColors: 0,
      cellSampling: 'nearest',
      onDebug: (message) => {
        debugLines.push(message);
      },
    });
    expect(debugLines.some((line) => line.includes('sampling=nearest'))).toBe(true);
    screen.dispose();
  });
});

describe('Screen embedded and region', () => {
  const REGION = { offsetCol: 3, offsetRow: 2, cols: 20, rows: 12 };

  it('writes no destructive init sequence in embedded mode', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
      embedded: true,
      region: REGION,
    });
    const setup = stream.chunks.join('');
    expect(setup).not.toContain('\x1b[2J'); // no full-screen clear
    expect(setup).not.toContain('\x1b[?25l'); // no cursor hide
    screen.dispose();
  });

  it('writes the destructive init sequence when not embedded', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
    });
    const setup = stream.chunks.join('');
    expect(setup).toContain('\x1b[2J'); // full-screen clear
    expect(setup).toContain('\x1b[?25l'); // cursor hide
    screen.dispose();
  });

  it('adds no SIGWINCH listener in embedded mode by default', () => {
    const stream = new FakeStream();
    const before = process.listenerCount('SIGWINCH');
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
      embedded: true,
      region: REGION,
    });
    expect(process.listenerCount('SIGWINCH')).toBe(before);
    screen.dispose();
  });

  it('adds a SIGWINCH listener for a default non-embedded Screen', () => {
    const stream = new FakeStream();
    const before = process.listenerCount('SIGWINCH');
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
    });
    expect(process.listenerCount('SIGWINCH')).toBe(before + 1);
    screen.dispose();
  });

  it('writes no destructive teardown on embedded dispose', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
      embedded: true,
      region: REGION,
    });
    const beforeDispose = stream.chunks.length;
    screen.dispose();
    const teardown = stream.chunks.slice(beforeDispose).join('');
    expect(teardown).not.toContain('\x1b[2J'); // no full-screen clear
    expect(teardown).not.toContain('\x1b[?25h'); // no cursor show
  });

  it('restores the cursor on non-embedded dispose', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
    });
    const beforeDispose = stream.chunks.length;
    screen.dispose();
    expect(stream.chunks.slice(beforeDispose).join('')).toContain('\x1b[?25h'); // cursor show
  });

  it('honors explicit autoResize/autoDispose true in embedded mode', () => {
    const stream = new FakeStream();
    const winchBefore = process.listenerCount('SIGWINCH');
    const exitBefore = process.listenerCount('exit');
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'half-block',
      embedded: true,
      region: REGION,
      autoResize: true,
      autoDispose: true,
    });
    expect(process.listenerCount('SIGWINCH')).toBe(winchBefore + 1); // explicit autoResize wins
    expect(process.listenerCount('exit')).toBe(exitBefore + 1); // explicit autoDispose wins
    screen.dispose();
  });

  it('setRegion re-lays-out into the new region', () => {
    const stream = new FakeStream();
    const screen = new Screen({
      sourceWidth: 40,
      sourceHeight: 40,
      output: stream,
      renderMode: 'half-block',
      embedded: true,
      region: { offsetCol: 1, offsetRow: 1, cols: 6, rows: 6 },
    });
    const sizeBefore = screen.getDisplaySize();
    const statusBefore = screen.getStatusRow();
    screen.setRegion({ offsetCol: 20, offsetRow: 10, cols: 24, rows: 20 });
    expect(screen.getDisplaySize()).not.toEqual(sizeBefore); // fit grew with the region
    expect(screen.getStatusRow()).not.toBe(statusBefore); // panel moved down
    screen.dispose();
  });
});

describe('Screen auto-dispose', () => {
  const disposeListenerCounts = (): number[] =>
    ['exit', ...AUTO_DISPOSE_SIGNALS].map((event) => process.listenerCount(event));

  it('shares one set of process hooks across screens and removes them with the last dispose', () => {
    const baseline = disposeListenerCounts();
    const first = new Screen({ sourceWidth: 4, sourceHeight: 4, output: new FakeStream(), renderMode: 'half-block' });
    expect(disposeListenerCounts()).toEqual(baseline.map((n) => n + 1));
    const second = new Screen({ sourceWidth: 4, sourceHeight: 4, output: new FakeStream(), renderMode: 'half-block' });
    expect(disposeListenerCounts()).toEqual(baseline.map((n) => n + 1)); // still shared
    first.dispose();
    expect(disposeListenerCounts()).toEqual(baseline.map((n) => n + 1)); // second is still live
    second.dispose();
    expect(disposeListenerCounts()).toEqual(baseline);
  });

  it('registers no process hooks when autoDispose is false', () => {
    const baseline = disposeListenerCounts();
    const screen = new Screen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: new FakeStream(),
      renderMode: 'half-block',
      autoDispose: false,
    });
    expect(disposeListenerCounts()).toEqual(baseline);
    screen.dispose();
  });

  // The signal paths cannot run in-process (emitting SIGINT would invoke the
  // test runner's own handlers), so they run in child processes. The child's
  // output sink uses writeSync so cleanup sequences survive termination even
  // though stdout is a pipe.
  const runScreenChild = (
    tail: string,
    onReady?: (child: ReturnType<typeof spawn>) => void,
  ): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      const modulePath = new URL('./index.ts', import.meta.url).pathname;
      const source = `
import { writeSync } from 'node:fs';
import { Screen } from ${JSON.stringify(modulePath)};
const screen = new Screen({
  sourceWidth: 4,
  sourceHeight: 4,
  renderMode: 'half-block',
  output: { write: (chunk) => { writeSync(1, chunk); return true; }, once: () => {} },
});
${tail}
`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr!.on('data', (data: Buffer) => {
        stderr += data.toString();
        if (stderr.includes('ready')) {
          onReady?.(child);
        }
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });

  const SHOW_CURSOR = '\x1b[?25h';

  it('disposes on process.exit without an explicit dispose call', async () => {
    const result = await runScreenChild('process.exit(7);');
    expect(result.code).toBe(7);
    expect(result.stdout).toContain(SHOW_CURSOR);
  });

  it('disposes on SIGINT and re-raises for the conventional exit status', async () => {
    const result = await runScreenChild(
      'writeSync(2, \'ready\');\nsetInterval(() => {}, 1_000);',
      (child) => child.kill('SIGINT'),
    );
    expect(result.signal).toBe('SIGINT'); // default termination re-raised
    expect(result.stdout).toContain(SHOW_CURSOR);
  });

  it("leaves shutdown to the host's own signal handler and disposes via the exit hook", async () => {
    const result = await runScreenChild(
      `process.on('SIGINT', () => { writeSync(2, 'host-handler'); process.exit(3); });
writeSync(2, 'ready');
setInterval(() => {}, 1_000);`,
      (child) => child.kill('SIGINT'),
    );
    expect(result.code).toBe(3); // the host handler chose the exit
    expect(result.stderr).toContain('host-handler');
    expect(result.stdout).toContain(SHOW_CURSOR);
  });
});

describe('createScreen', () => {
  // In vitest stdin is not a TTY, so every probe resolves quickly with
  // "unsupported". Pin the env so the graphics probe's Kitty fast paths
  // (KITTY_WINDOW_ID, TERM=xterm-kitty) don't fire when the test suite
  // itself runs inside a Kitty terminal.
  const savedKittyWindowId = process.env['KITTY_WINDOW_ID'];
  const savedTerm = process.env['TERM'];

  const resetDetectionCaches = (): void => {
    resetKittyGraphicsDetection();
    resetKittyAnimationDetection();
    resetKittyFileTransferDetection();
    resetCellPixelSizeDetection();
  };

  beforeEach(() => {
    delete process.env['KITTY_WINDOW_ID'];
    process.env['TERM'] = 'xterm-256color';
    resetDetectionCaches();
  });

  afterEach(() => {
    if (savedKittyWindowId === undefined) {
      delete process.env['KITTY_WINDOW_ID'];
    } else {
      process.env['KITTY_WINDOW_ID'] = savedKittyWindowId;
    }
    if (savedTerm === undefined) {
      delete process.env['TERM'];
    } else {
      process.env['TERM'] = savedTerm;
    }
    resetDetectionCaches();
  });

  it('probes graphics support and falls back to cell mode without one', async () => {
    const stream = new FakeStream();
    const screen = await createScreen({ sourceWidth: 4, sourceHeight: 4, output: stream });
    expect(getKittyGraphicsSupported()).toBe(false); // probe ran
    expect(screen.getRenderMode()).not.toBe('kitty');
    screen.pushFrame(frame(80));
    expect(stream.chunks.join('')).not.toContain('\x1b_G'); // no Kitty APC
    screen.dispose();
  });

  it('skips the kitty-only probes when graphics is unsupported', async () => {
    const stream = new FakeStream();
    const screen = await createScreen({ sourceWidth: 4, sourceHeight: 4, output: stream });
    expect(getKittyAnimationSupported()).toBe(null);
    expect(getKittyFileTransferSupported()).toBe(null);
    screen.dispose();
  });

  it('skips the graphics probe when renderMode is forced', async () => {
    const stream = new FakeStream();
    const screen = await createScreen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'kitty',
      workerFactory: NO_WORKER,
    });
    expect(getKittyGraphicsSupported()).toBe(null); // never probed
    expect(screen.getRenderMode()).toBe('kitty');
    screen.dispose();
  });

  it('runs the animation and file probes for a forced kitty mode', async () => {
    const stream = new FakeStream();
    const screen = await createScreen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'kitty',
      workerFactory: NO_WORKER,
    });
    expect(getKittyAnimationSupported()).toBe(false); // probed (non-TTY -> false)
    expect(getKittyFileTransferSupported()).toBe(false);
    screen.dispose();
  });

  it('skips probes whose result an explicit option overrides', async () => {
    const stream = new FakeStream();
    const screen = await createScreen({
      sourceWidth: 4,
      sourceHeight: 4,
      output: stream,
      renderMode: 'kitty',
      dirtyRects: false,
      fileTransfer: false,
      workerFactory: NO_WORKER,
    });
    expect(getKittyAnimationSupported()).toBe(null);
    expect(getKittyFileTransferSupported()).toBe(null);
    screen.dispose();
  });

  it('respects a manual probe run beforehand', async () => {
    await detectKittyGraphicsSupport(); // caches false in the test env
    const stream = new FakeStream();
    const screen = await createScreen({ sourceWidth: 4, sourceHeight: 4, output: stream });
    expect(screen.getRenderMode()).not.toBe('kitty');
    screen.dispose();
  });
});
