import { KittyRenderer, type KittyRendererOptions } from "../KittyRenderer";
import { OutputGate } from "../OutputGate";
import type { KittyScreenOptions, KittyScreenUpdatableOptions } from "./types";

export * from "./types";

/**
 * High-level push-frame API for motion rendering over the Kitty graphics
 * protocol. Owns a KittyRenderer (diff-skip, worker encode, aspect fit) and
 * an OutputGate (drop-on-backpressure) so hosts only push frames.
 */
export class KittyScreen {
  private renderer: KittyRenderer;
  private gate: OutputGate;
  private options: KittyScreenOptions;
  private isDisposed = false;

  constructor(options: KittyScreenOptions) {
    this.options = { ...options };
    this.gate = new OutputGate(options.output);
    this.renderer = this.createRenderer();
    this.gate.write(this.renderer.hideCursor() + this.renderer.clearScreen());
    this.renderer.setOutputSink((chunk) => this.gate.write(chunk));
  }

  private createRenderer(): KittyRenderer {
    const { output: _output, workerFactory, ...rest } = this.options;
    const rendererOptions: KittyRendererOptions = {
      ...rest,
      encodeWorkerFactory: workerFactory,
    };
    return new KittyRenderer(rendererOptions);
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

  // Recompute fit and centering after a terminal resize (host calls on SIGWINCH)
  handleResize(): void {
    this.renderer.setDimensions();
    this.gate.write(this.renderer.clearScreen());
  }

  // Recreate the internal renderer with merged options. Diff state resets,
  // so the next frame renders fully — the same behavior emoemu exhibits when
  // settings change mid-session.
  updateOptions(partial: Partial<KittyScreenUpdatableOptions>): void {
    this.options = { ...this.options, ...partial };
    const sink = (chunk: string): void => {
      this.gate.write(chunk);
    };
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

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.gate.write(this.renderer.clearScreen() + this.renderer.showCursor());
    this.renderer.destroy();
  }
}

export const createKittyScreen = (options: KittyScreenOptions): KittyScreen =>
  new KittyScreen(options);
