import { KittyRenderer, type KittyRendererOptions } from '../KittyRenderer/index.ts';
import { CellRenderer } from '../CellRenderer/index.ts';
import { KittyFrameEncoder } from '../kittyEncode/index.ts';
import { OutputGate } from '../OutputGate/index.ts';
import {
  detectKittyAnimationSupport,
  detectKittyFileTransferSupport,
  detectKittyGraphicsSupport,
  getKittyGraphicsSupported,
} from '../kittyProtocol/index.ts';
import { detectCellPixelSize, detectCellRenderMode } from '../terminal/index.ts';
import type { CapturedFrame, Renderer, RenderMode } from '../types.ts';
import { AUTO_DISPOSE_SIGNALS, SCREENSHOT_PNG_COMPRESSION } from './consts.ts';
import type { ScreenOptions, ScreenUpdatableOptions } from './types.ts';

export * from './consts.ts';
export * from './types.ts';

type AutoDisposeSignal = (typeof AUTO_DISPOSE_SIGNALS)[number];

// Process-wide teardown for screens with autoDispose. One shared set of
// process hooks serves every live screen: an 'exit' hook (process.exit()
// and natural exit) plus one handler per termination signal, since default
// signal handling kills the process without running 'exit' hooks. Hooks are
// registered when the first auto-dispose screen is constructed and removed
// when the last one is disposed.
const autoDisposeScreens = new Set<Screen>();
let autoDisposeExitHook: (() => void) | null = null;
const autoDisposeSignalHooks = new Map<AutoDisposeSignal, () => void>();

const disposeAllScreens = (): void => {
  // dispose() unregisters each screen, mutating the set, so iterate a copy
  for (const screen of [...autoDisposeScreens]) {
    screen.dispose();
  }
};

const registerAutoDispose = (screen: Screen): void => {
  autoDisposeScreens.add(screen);
  if (autoDisposeExitHook) {
    return;
  }
  autoDisposeExitHook = disposeAllScreens;
  process.on('exit', autoDisposeExitHook);
  for (const signal of AUTO_DISPOSE_SIGNALS) {
    const hook = (): void => {
      if (process.listenerCount(signal) > 1) {
        // The host has its own handler and owns shutdown; the 'exit' hook
        // disposes when it eventually exits
        return;
      }
      disposeAllScreens(); // empties the set, which removes every hook
      process.kill(process.pid, signal); // re-raise for the default 128+n exit
    };
    autoDisposeSignalHooks.set(signal, hook);
    process.on(signal, hook);
  }
};

const unregisterAutoDispose = (screen: Screen): void => {
  autoDisposeScreens.delete(screen);
  if (autoDisposeScreens.size > 0 || !autoDisposeExitHook) {
    return;
  }
  process.removeListener('exit', autoDisposeExitHook);
  autoDisposeExitHook = null;
  for (const [signal, hook] of autoDisposeSignalHooks) {
    process.removeListener(signal, hook);
  }
  autoDisposeSignalHooks.clear();
};

/**
 * High-level push-frame API for motion rendering. Owns a Renderer, either
 * KittyRenderer (diff-skip, worker-thread PNG encode, aspect fit) or, when
 * Kitty graphics is unsupported, CellRenderer (block-glyph rendering with
 * cell-level diffing, no worker), and an OutputGate (drop-on-backpressure)
 * so hosts only push frames.
 *
 * The constructor is synchronous and reads only cached capability probe
 * results. Construct through `createScreen()`, which runs the probes first,
 * unless you have already run the `detect*` probes yourself.
 */
export class Screen {
  private renderer: Renderer;
  private activeRenderMode: RenderMode = 'kitty';
  private gate: OutputGate;
  private options: ScreenOptions;
  private isDisposed = false;
  private resizeListener: (() => void) | null = null;
  // Lazily created on the first capturePng() call (both renderers share it)
  private captureEncoder: KittyFrameEncoder | null = null;

  constructor(options: ScreenOptions) {
    this.options = { ...options };
    this.gate = new OutputGate(options.output);
    this.renderer = this.createRenderer();
    this.gate.write(this.renderer.hideCursor() + this.renderer.clearScreen());
    this.renderer.setOutputSink((chunk) => this.gate.write(chunk));
    if (options.autoResize !== false) {
      this.resizeListener = () => this.handleResize();
      process.on('SIGWINCH', this.resizeListener);
    }
    if (options.autoDispose !== false) {
      registerAutoDispose(this);
    }
  }

  private createRenderer(): Renderer {
    const {
      output: _output,
      workerFactory,
      renderMode,
      limitColors,
      cellSampling,
      ...rest
    } = this.options;
    const mode: RenderMode =
      renderMode ?? (getKittyGraphicsSupported() === false ? detectCellRenderMode() : 'kitty');
    this.activeRenderMode = mode;
    if (mode === 'kitty') {
      const rendererOptions: KittyRendererOptions = {
        ...rest,
        encodeWorkerFactory: workerFactory,
      };
      return new KittyRenderer(rendererOptions);
    }
    const { scale, pngCompressionLevel, dirtyRects, fileTransfer, ...cellOptions } = rest;
    const kittyOnly: ReadonlyArray<[name: string, value: unknown]> = [
      ['scale', scale],
      ['pngCompressionLevel', pngCompressionLevel],
      ['dirtyRects', dirtyRects],
      ['fileTransfer', fileTransfer],
      ['workerFactory', workerFactory],
    ];
    const ignored = kittyOnly.filter(([, value]) => value !== undefined).map(([name]) => name);
    if (ignored.length > 0) {
      this.options.onDebug?.(`Cell mode: ignoring kitty-only options ${ignored.join(', ')}`);
    }
    return new CellRenderer({ ...cellOptions, limitColors, renderMode: mode, cellSampling });
  }

  /** Which rendering path is active: "kitty" (graphics protocol), "half-block", "cell-background" (block-glyph fallback), "emoji" (emoji squares), or "ascii" (one printable ASCII glyph per cell chosen by nearest shape) */
  getRenderMode(): RenderMode {
    return this.activeRenderMode;
  }

  // True when the underlying output stream can accept a frame right now.
  // Hosts can check this before doing expensive frame preparation.
  isWritable(): boolean {
    return !this.isDisposed && this.gate.isWritable();
  }

  pushFrame(frame: Uint8Array | Uint16Array): void {
    if (this.isDisposed || !this.gate.isWritable()) {
      return;
    }
    const payload =
      frame instanceof Uint16Array
        ? this.renderer.renderRgb15(frame)
        : this.renderer.renderRgb24(frame);
    if (payload.length > 0) {
      this.gate.write(payload);
    }
  }

  // Recompute fit and centering after a terminal resize. Called
  // automatically on SIGWINCH unless autoResize is false
  handleResize(): void {
    this.renderer.setDimensions();
    this.gate.write(this.renderer.clearScreen());
  }

  // Recreate the internal renderer with merged options. Diff state resets,
  // so the next frame renders fully.
  updateOptions(partial: Partial<ScreenUpdatableOptions>): void {
    this.options = { ...this.options, ...partial };
    const sink = (chunk: string): boolean => this.gate.write(chunk);
    this.gate.write(this.renderer.clearScreen());
    this.renderer.destroy();
    this.renderer = this.createRenderer();
    this.renderer.setOutputSink(sink);
  }

  getDisplaySize(): { cols: number; rows: number } {
    return this.renderer.getDisplaySize();
  }

  // First row below the image (for host status bars)
  getStatusRow(): number {
    return this.renderer.getStatusRow();
  }

  /**
   * Snapshot the last rendered frame as post-processed RGB24 pixels at source
   * resolution (gamma and CRT effects already applied). Works in every render
   * mode, since the snapshot is the raster both renderers draw from, not the
   * on-screen glyph approximation. The returned `data` is a fresh copy, safe
   * to retain. Before the first pushFrame the buffer is zero-filled (black).
   */
  captureRgb(): CapturedFrame {
    return this.renderer.captureRgb();
  }

  /**
   * Snapshot the last rendered frame as standalone PNG bytes at source
   * resolution. Encodes the same pixels as captureRgb(); the host writes the
   * result to disk (e.g. `fs.writeFile(path, screen.capturePng())`). Always
   * uses maximum deflate compression for the smallest file, ignoring the
   * render loop's `pngCompressionLevel`, since a screenshot is not time
   * sensitive.
   */
  capturePng(): Uint8Array {
    const frame = this.renderer.captureRgb();
    this.captureEncoder ??= new KittyFrameEncoder();
    return this.captureEncoder.encodeImage(
      frame.data,
      frame.width,
      frame.height,
      SCREENSHOT_PNG_COMPRESSION,
    );
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    if (this.resizeListener) {
      process.removeListener('SIGWINCH', this.resizeListener);
      this.resizeListener = null;
    }
    unregisterAutoDispose(this);
    this.gate.write(this.renderer.clearScreen() + this.renderer.showCursor());
    this.renderer.destroy();
  }

  // Enables `using screen = await createScreen(...)` (Node 24+)
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * Probe the terminal's capabilities, then construct a Screen.
 *
 * Runs the async capability probes that the synchronous Screen constructor
 * can only read from cache: Kitty graphics support (selects the renderer),
 * animation support (dirty-rect delta frames), file transfer support
 * (temp-file payloads), and the terminal's real cell pixel size (aspect
 * correction). Probes made irrelevant by an explicit option (`renderMode`,
 * `dirtyRects`, `fileTransfer`) are skipped. Probe results are cached
 * process-wide, so running the `detect*` functions yourself beforehand also
 * works and makes the corresponding probe here free.
 *
 * A forced `renderMode` skips the probes that only the other mode needs. If
 * you plan to switch modes later with `updateOptions()`, run the probes for
 * the other mode yourself first.
 */
export const createScreen = async (options: ScreenOptions): Promise<Screen> => {
  const graphicsSupported =
    options.renderMode === undefined
      ? await detectKittyGraphicsSupport()
      : options.renderMode === 'kitty';
  if (graphicsSupported) {
    // These probes write Kitty escape sequences, so only run them on
    // terminals that parse the protocol
    if (options.dirtyRects === undefined) {
      await detectKittyAnimationSupport();
    }
    if (options.fileTransfer === undefined) {
      await detectKittyFileTransferSupport();
    }
  }
  await detectCellPixelSize();
  return new Screen(options);
};
