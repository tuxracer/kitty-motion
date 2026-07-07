# kitty-motion

Render video and games in the terminal at 30-60fps. Full-quality pixels over the [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/), colored half-blocks everywhere else. Zero runtime dependencies.

The protocol was designed for static images. Sustaining motion means building frame diffing, delta encoding, and backpressure yourself. kitty-motion ships all of it, on by default and measured:

- Unchanged frames are skipped entirely
- Changed frames are sent as dirty-rect deltas (128x smaller payloads on game-like content)
- Payloads travel as temp files on local terminals (250x less pty traffic than inline escape sequences)
- PNG encoding runs on a worker thread, off the render loop
- Slow links drop frames instead of building latency
- Output is centered and aspect-corrected for the user's actual font

Every optimization is probed at runtime and falls back automatically. The same code renders correctly on any Kitty-graphics terminal, local or over SSH, with zero configuration.

Terminals without Kitty graphics (VS Code's integrated terminal, tmux, CI logs) fall back to colored half-block characters with the same cell-level diffing and auto-detected color depth (truecolor, 256, or 16). Every terminal shows motion instead of an error.

Optional CRT-style post-processing covers gamma, saturation, brightness, and contrast, plus scanlines, bloom, vignette, screen curvature, chromatic aberration, and NTSC artifacts. Pass effects to `createScreen()` or change them mid-playback with `updateOptions()`. They apply in both render paths.

Full API reference, benchmarks, and design rationale: [docs/TRD.md](docs/TRD.md).

## Quick start

```sh
npm install kitty-motion
```

```typescript
import { createScreen } from "kitty-motion";

const WIDTH = 160;
const HEIGHT = 120;
const RADIUS = 10;
const FPS = 60;

// createScreen probes the terminal's capabilities, then picks the graphics
// renderer or the block-glyph fallback automatically
const screen = await createScreen({
  sourceWidth: WIDTH,
  sourceHeight: HEIGHT,
  output: process.stdout,
});

const frame = new Uint8Array(WIDTH * HEIGHT * 3);
let x = WIDTH / 2;
let y = HEIGHT / 2;
let dx = 1.7;
let dy = 1.1;

setInterval(() => {
  x += dx;
  y += dy;
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
}, 1000 / FPS);
```

Resize and shutdown are handled for you. The screen recomputes its layout on terminal resize, and on exit or Ctrl-C it clears the image and restores the cursor (`autoResize` and `autoDispose` options, both on by default).

Runnable demos live in [`examples/`](examples/). Run `node examples/bouncing-ball.ts` in any color terminal (Node 24 strips types natively, so there is no build step). Each demo prints its rendering configuration and throughput metrics on exit. Set `DEMO_RENDER_MODE=cell` to preview the block-glyph fallback on a Kitty-capable terminal.

## Options

`createScreen()` accepts the options below. Everything except the creation-only group can also be changed mid-playback with `screen.updateOptions()`.

`createScreen()` runs the async capability probes (graphics support, dirty-rect support, file transfer, cell pixel size) before construction. To control when the terminal handshake happens, run the exported `detect*` probes yourself first. Their results are cached, so the probes inside `createScreen()` become free, or construct synchronously with `new Screen(options)`.

### Creation only

| Option          | Values               | Default     | Description                                         |
| --------------- | -------------------- | ----------- | --------------------------------------------------- |
| `sourceWidth`   | number               | required    | Width of the source framebuffer in pixels           |
| `sourceHeight`  | number               | required    | Height of the source framebuffer in pixels          |
| `output`        | writable stream      | required    | Sink for encoded frames, typically `process.stdout` |
| `colorSpace`    | `"rgb24"`, `"rgb15"` | `"rgb24"`   | Pixel format of frames passed to `pushFrame()`      |
| `autoResize`    | boolean              | `true`      | Recompute layout on terminal resize (SIGWINCH). Set `false` to call `handleResize()` yourself |
| `autoDispose`   | boolean              | `true`      | Dispose on process exit and SIGINT/SIGTERM/SIGHUP, restoring the terminal. Defers to the app's own signal handlers when present. Set `false` to call `dispose()` yourself |
| `workerFactory` | function             | real worker | Override encode-worker creation (tests, embedding)  |
| `onDebug`       | function             | none        | Sink for internal diagnostic messages               |

### Rendering

| Option                | Values                                    | Default | Description                                                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scale`               | 0.25 to 4                                 | `2`     | Internal render scale. Higher values increase PNG quantization fidelity at the cost of CPU                                                                                                                                                       |
| `pixelAspectRatio`    | number                                    | `1.0`   | Source pixel aspect ratio, e.g. `8/7` for NES-style non-square pixels                                                                                                                                                                            |
| `reservedRows`        | integer >= 0                              | `0`     | Terminal rows excluded from the display area, e.g. for a status line                                                                                                                                                                             |
| `pngCompressionLevel` | 1 to 9                                    | `5`     | Deflate level for PNG encoding                                                                                                                                                                                                                   |
| `colorEnabled`        | boolean                                   | `true`  | When `false`, renders in grayscale                                                                                                                                                                                                               |
| `enableDiffRendering` | boolean                                   | `true`  | Skip re-encoding frames that are pixel-identical to the previous frame                                                                                                                                                                           |
| `dirtyRects`          | boolean, undefined                        | probe   | Dirty-rect delta frames. `undefined` follows `detectKittyAnimationSupport()`, `true`/`false` overrides. Deltas also require `enableDiffRendering` and an integer `scale` of 1 or more                                                            |
| `fileTransfer`        | boolean, undefined                        | probe   | File-based payload transmission. `undefined` follows `detectKittyFileTransferSupport()`, `true`/`false` forces                                                                                                                                   |
| `renderMode`          | `"kitty"`, `"half-block"`, `"cell-background"`, undefined | probe | Renderer selection. `"kitty"` uses the graphics protocol. `"half-block"` and `"cell-background"` use the block-glyph renderer (2 pixels per cell via U+2580, or 1 pixel per cell via background-colored spaces). `undefined` follows the graphics probe, then auto-detects the cell mode from `TERM_PROGRAM` (Terminal.app gets `"cell-background"`) |
| `limitColors`         | `0`, `16`, `256`, undefined               | auto    | Cell-mode color depth, `0` means truecolor. `undefined` auto-detects from `COLORTERM`/`TERM`                                                                                                                                                     |
| `cellSampling`        | `"box"`, `"nearest"`, undefined           | auto    | Cell-mode downsampling. `"box"` averages each cell's source region in linear light, `"nearest"` copies the region's center pixel so hard-edged content stays solid. `undefined` auto-detects from `TERM_PROGRAM` (Terminal.app gets `"nearest"`) |

### Post-processing effects

Adjustments default to `1.0` (no change) and effect intensities default to `0.0` (off).

| Option                | Values      | Default | Description                                   |
| --------------------- | ----------- | ------- | --------------------------------------------- |
| `gamma`               | number      | `1.0`   | Gamma correction, CRT-like is 1.1 to 1.4      |
| `saturation`          | number      | `1.0`   | Color saturation multiplier                   |
| `brightness`          | number      | `1.0`   | Brightness multiplier                         |
| `contrast`            | number      | `1.0`   | Contrast multiplier                           |
| `scanlines`           | 0.0 to 1.0  | `0.0`   | Scanline intensity                            |
| `vignette`            | number >= 0 | `0.0`   | Vignette intensity                            |
| `bloom`               | number >= 0 | `0.0`   | Bloom/glow intensity                          |
| `bloomThreshold`      | 0.0 to 1.0  | `0.6`   | Brightness threshold above which pixels bloom |
| `ntsc`                | number >= 0 | `0.0`   | NTSC artifact intensity                       |
| `curvature`           | number >= 0 | `0.0`   | CRT barrel curvature intensity                |
| `chromaticAberration` | number >= 0 | `0.0`   | Chromatic aberration intensity                |

## Requirements

- Node.js >= 24
- A terminal that supports the Kitty graphics protocol (e.g. [Kitty](https://sw.kovidgoyal.net/kitty/), [Ghostty](https://ghostty.org/), [WezTerm](https://wezterm.org/)) for full-quality pixel rendering. Any color terminal works via the block-glyph fallback
- Run directly in the terminal, not under tmux or GNU screen. Multiplexers don't pass the graphics protocol through, which forces the block-glyph fallback, and they usually cap colors at 256 instead of truecolor
- macOS Terminal.app works but is not recommended. It has no Kitty graphics support, and it draws block characters as ordinary font glyphs that don't tile the cell, so the half-block fallback shows seams there. kitty-motion detects Terminal.app and switches to one background-colored pixel per cell, which avoids the seams but halves the vertical resolution

## License

MIT
