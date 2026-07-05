import { describe, expect, it } from "vitest";
import { createKittyScreen } from ".";
import type { DrainableStream } from "../OutputGate";

class FakeStream implements DrainableStream {
  chunks: string[] = [];
  blocked = false;
  private drainCb: (() => void) | null = null;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return !this.blocked;
  }
  once(_event: "drain", cb: () => void): void {
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
// asynchronously (an `error` event once module resolution fails) -- it never
// throws synchronously, even when the worker bundle doesn't exist (as here,
// running unbundled from src/). So a synchronous test that omits
// `workerFactory` does NOT get the sync encode path: `isAvailable()` reads
// true at pushFrame time, the frame is submitted into the worker, and it is
// permanently lost when the worker fails later (there's no replay-on-failure).
// Passing `workerFactory: () => null` makes KittyEncodeWorkerClient fail
// synchronously in its constructor, deterministically forcing the sync path.
const NO_WORKER = (): null => null;

describe("KittyScreen", () => {
  it("writes setup sequences on creation and a payload on pushFrame", () => {
    const stream = new FakeStream();
    const screen = createKittyScreen({
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
    expect(stream.chunks.join("")).toContain("\x1b_G"); // Kitty APC introducer
    screen.dispose();
  });

  it("drops frames while the stream is blocked and resumes after drain", () => {
    const stream = new FakeStream();
    const screen = createKittyScreen({
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

  it("restores the cursor on dispose", () => {
    const stream = new FakeStream();
    const screen = createKittyScreen({ sourceWidth: 4, sourceHeight: 4, output: stream, scale: 1, workerFactory: NO_WORKER });
    screen.dispose();
    expect(stream.chunks.join("")).toContain("\x1b[?25h"); // show cursor
  });

  it("updateOptions takes effect on subsequent frames", () => {
    const stream = new FakeStream();
    const screen = createKittyScreen({ sourceWidth: 4, sourceHeight: 4, output: stream, scale: 1, workerFactory: NO_WORKER });
    screen.pushFrame(frame(60));
    screen.updateOptions({ pngCompressionLevel: 9 });
    // Re-push the SAME frame: updateOptions resets diff state, so it renders again
    screen.pushFrame(frame(60));
    const apcCount = stream.chunks.filter((c) => c.includes("\x1b_G")).length;
    expect(apcCount).toBeGreaterThanOrEqual(2);
    screen.dispose();
  });
});
