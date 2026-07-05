# kitty-motion

Motion video and game rendering for the [Kitty terminal graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/).

The Kitty graphics protocol was designed for displaying static images — drop a PNG on the screen once and leave it there. Pushing 30-60 frames per second through it is a different problem: naive re-encoding burns CPU on unchanged pixels, a slow terminal link backs up an unbounded write queue, and getting the aspect ratio right requires knowing the actual pixel size of a terminal cell, which varies by font. kitty-motion solves those problems — diff-skipped frames, worker-offloaded PNG encoding, backpressure-aware output, and font-independent aspect correction — so you can push raw pixel buffers and get smooth, correctly-proportioned motion on the terminal.

Extracted from the emoemu terminal emulator, where it drives real-time game video output.

Zero runtime dependencies.

## Which layer do I want?

Most users want `KittyScreen`. Reach for the low-level primitives only if you're building your own render loop or embedding pieces of this into a larger renderer.

| | `KittyScreen` | Low-level primitives |
|---|---|---|
| API surface | One class: `pushFrame()` | Encoder, worker client, protocol builders, terminal detection, etc. — compose them yourself |
| Backpressure handling | Built in (`OutputGate`) | Your responsibility |
| Diff-based skip of unchanged frames | Built in | Not provided — primitives always encode what you give them |
| Worker-thread PNG encoding | Built in, with automatic sync fallback | You wire up `KittyEncodeWorkerClient` yourself |
| Aspect-ratio correction | Built in (font-independent) | You call `kittyGridAspectRatio` / `fitToTerminal` yourself |
| When to use | Pushing frames from a game loop, emulator, or video source | Custom render pipelines, testing, partial reuse |

## Quick start

```typescript
import { createKittyScreen, detectKittyGraphicsSupport } from "kitty-motion";

const WIDTH = 160;
const HEIGHT = 120;
const RADIUS = 10;
const FPS = 60;

const main = async (): Promise<void> => {
  if (!(await detectKittyGraphicsSupport())) {
    console.error("This terminal does not support the Kitty graphics protocol.");
    process.exit(1);
  }

  const screen = createKittyScreen({
    sourceWidth: WIDTH,
    sourceHeight: HEIGHT,
    output: process.stdout,
  });
  process.on("SIGWINCH", () => screen.handleResize());

  const frame = new Uint8Array(WIDTH * HEIGHT * 3);
  let x = WIDTH / 2, y = HEIGHT / 2, dx = 1.7, dy = 1.1;

  const tick = (): void => {
    x += dx; y += dy;
    if (x < RADIUS || x > WIDTH - RADIUS) dx = -dx;
    if (y < RADIUS || y > HEIGHT - RADIUS) dy = -dy;
    for (let py = 0; py < HEIGHT; py++) {
      for (let px = 0; px < WIDTH; px++) {
        const i = (py * WIDTH + px) * 3;
        const inside = (px - x) ** 2 + (py - y) ** 2 <= RADIUS ** 2;
        frame[i] = inside ? 255 : 20;
        frame[i + 1] = inside ? 80 : 20;
        frame[i + 2] = inside ? 80 : 40;
      }
    }
    screen.pushFrame(frame);
  };

  const interval = setInterval(tick, 1000 / FPS);
  process.on("SIGINT", () => {
    clearInterval(interval);
    screen.dispose();
    process.exit(0);
  });
};

void main();
```

The same code lives in [`examples/bouncing-ball.ts`](examples/bouncing-ball.ts) — run it with `pnpm exec tsx examples/bouncing-ball.ts` in a Kitty-graphics-capable terminal.

## `KittyScreen` API reference

### `createKittyScreen(options): KittyScreen`

Constructs and returns a `KittyScreen`. Equivalent to `new KittyScreen(options)`.

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `sourceWidth` | `number` | — (required) | Width of the source framebuffer in pixels |
| `sourceHeight` | `number` | — (required) | Height of the source framebuffer in pixels |
| `output` | `DrainableStream` | — (required) | Writable sink for encoded frames, typically `process.stdout` |
| `colorSpace` | `"rgb15" \| "rgb24"` | `"rgb24"` | Pixel format of frames passed to `pushFrame` |
| `scale` | `number` | `2` | Internal render scale (0.25-4x); higher values increase PNG quantization fidelity at the cost of CPU |
| `pixelAspectRatio` | `number` | `1.0` | Source pixel aspect ratio (e.g. `8/7` for NES-style non-square pixels); combined with the terminal's real cell pixel size for font-independent aspect correction |
| `reservedRows` | `number` | `0` | Terminal rows to exclude from the display area (e.g. for a status line) |
| `pngCompressionLevel` | `number` | `5` | Deflate level (1-9); see [Design notes](#design-notes) for the benchmark behind this default |
| `colorEnabled` | `boolean` | `true` | When `false`, renders in grayscale |
| `enableDiffRendering` | `boolean` | `true` | Skip re-encoding frames that are pixel-identical to the previous frame |
| `workerFactory` | `WorkerFactory` | real worker | Override worker creation (tests, embedding) |
| `onDebug` | `(message: string) => void` | — | Optional sink for internal diagnostic messages |
| ...`EffectOptions` | | | `gamma`, `scanlines`, `saturation`, `brightness`, `contrast`, `vignette`, `bloom`, `bloomThreshold`, `ntsc`, `curvature`, `chromaticAberration` — CRT-style post-processing, all default off/neutral |

### Methods

| Method | Description |
|---|---|
| `pushFrame(frame: Uint8Array \| Uint16Array)` | Render and send one frame. No-ops if the previous write hasn't drained yet (frames drop, they never queue) |
| `handleResize()` | Recompute display size and centering after a terminal resize (call from a `SIGWINCH` handler) |
| `updateOptions(partial: Partial<KittyScreenUpdatableOptions>)` | Apply new option values at runtime. Resets diff state, so the next frame renders in full |
| `getDisplaySize(): { cols: number; rows: number }` | Current on-screen size in terminal cells |
| `getStatusRow(): number` | First terminal row below the image, for placing a status line |
| `dispose()` | Clear the image, restore the cursor, and terminate the encode worker |

## Low-level exports

For building a custom pipeline instead of using `KittyScreen`:

- `KittyFrameEncoder`, `KittyFrameMeta` — pure scale → PNG → base64 → APC-chunk encoder, usable synchronously or inside a worker
- `KittyEncodeWorkerClient`, `WorkerFactory`, `WorkerLike` — owns the encode worker, transfers frames, recycles buffers, coalesces latest-wins
- `kittyGridAspectRatio` — compute the terminal cell-grid aspect ratio needed to display a source framebuffer correctly
- `fitToTerminal` — fit a display size to available terminal space while preserving an aspect ratio
- `detectCellPixelSize`, `getCellPixelSize`, `parseCellPixelSize`, `resetCellPixelSizeDetection`, `getTerminalDimensions`, `CellPixelSize` — query and cache the terminal's real character-cell pixel size
- `detectKittyGraphicsSupport`, `getKittyGraphicsSupported`, `resetKittyGraphicsDetection`, `buildKittyImageSequence`, `buildKittyDeleteSequence`, `buildCursorPositionSequence` — Kitty graphics protocol detection and escape-sequence builders
- `OutputGate`, `DrainableStream` — backpressure-aware writable wrapper that drops frames instead of queueing them
- `PostProcessingPipeline`, `EffectOptions` — the CRT-style post-processing effects pipeline
- `rgbToIndexed`, `createPngChunk`, `PNG_SIGNATURE`, `crc32` — PNG encoding primitives
- `DEFAULT_PNG_COMPRESSION` — the default deflate level (`5`)
- `FrameBuffer`, `ColorSpace` — shared framebuffer type aliases

## Design notes

### Compression level

PNG deflate runs on a worker thread, off the render loop, so it isn't free but it also isn't blocking. Measured on 102 real GBA frames (240×160 source, scaled to 480×320 at 2x, indexed-color path):

| Config | Avg payload | Encode time |
|---|---|---|
| level 1 (old default) | 7.0 KB | 0.37 ms |
| level 3 | 5.1 KB | 0.36 ms |
| **level 5-6 (default)** | **~3.4 KB** | **~0.6 ms** |
| level 9 | 3.1 KB | 2.65 ms |

Level 5 roughly halves the payload versus level 1 for well under a millisecond of extra worker CPU per frame. Level 9 squeezes out another ~10% but costs 4-7x the encode time for it — not worth it when the encode is already off the critical path but still has to keep up with 60fps arrivals. `5` is the package default; raise it toward `9` if you're bandwidth-constrained (e.g. over SSH) and have CPU to spare, or drop it toward `1` if you're CPU-constrained and have bandwidth to spare.

### Why there's no PNG row filtering

Standard PNG encoders apply per-scanline filters (Sub, Up, Average, Paeth) before deflate, because they exploit numeric correlation between neighboring pixel values. kitty-motion's indexed-color path deflates palette indices, not raw color values — and palette index assignment is arbitrary (the Nth unique color encountered gets index N). Two adjacent pixels that are visually similar colors can land on palette indices 3 and 200, so filters that predict "this byte is close to its neighbor" have nothing meaningful to predict. Benchmarking confirmed this: adaptive min-SAD filtering at compression level 6 produced 3.9 KB average payloads — larger than the 3.4 KB with no filtering at all. Filtering was left out entirely rather than spending CPU on a transform that make output worse.

### Why frames drop instead of queueing

`OutputGate` checks the return value of `stream.write()`. When it's `false` (the OS write buffer is full — a slow terminal, an SSH link, a pipe with a slow reader), the gate marks itself blocked and drops every subsequent `pushFrame` call until a `drain` event fires. There is no queue and no buffering of pending frames. For motion video, a frame that's a few hundred milliseconds late is worse than no frame at all — an unbounded queue would only grow the latency between what's happening in your simulation and what's on screen. Dropping keeps the display honest: it always shows either the current state or nothing, never a backlog.

### Font-independent aspect correction

Kitty scales a transmitted image to exactly fill the requested `cols x rows` cell grid, so the on-screen aspect ratio is determined by `(cols * cellWidthPx) / (rows * cellHeightPx)`. Terminal fonts vary in cell pixel dimensions, so a display size computed from a fixed assumed cell ratio looks stretched or squashed depending on the user's font. kitty-motion queries the terminal directly for its real cell pixel size (via a CSI cell-size or text-area-size escape sequence, cached for the process lifetime — see `detectCellPixelSize`), then feeds that into `kittyGridAspectRatio` along with the source framebuffer's dimensions and pixel aspect ratio to compute the exact `cols`/`rows` needed for correct proportions. If the terminal doesn't answer the query, it falls back to a typical cell ratio.

## Requirements

- Node.js >= 20
- A terminal that supports the Kitty graphics protocol (e.g. [Kitty](https://sw.kovidgoyal.net/kitty/), [Ghostty](https://ghostty.org/), [WezTerm](https://wezterm.org/))

## License

MIT
