# kitty-motion

Render video and games in the terminal at 30-60fps. Full-quality pixels over the [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/), colored half-blocks everywhere else. Zero runtime dependencies.

The protocol was designed for static images. Sustaining motion means building frame diffing, delta encoding, and backpressure yourself. kitty-motion ships all of it, on by default and measured:

- Unchanged frames are skipped entirely
- Changed frames are sent as dirty-rect deltas on terminals with the [Kitty animation protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/#animation), 128x smaller payloads on game-like content (other terminals re-transmit the full frame)
- Payloads travel as temp files on local terminals (250x less pty traffic than inline escape sequences)
- PNG encoding runs on a worker thread, off the render loop
- Slow links drop frames instead of building latency
- Output is centered and aspect-corrected for the user's actual font

Every optimization is probed at runtime and falls back automatically, so the same code renders on any Kitty-graphics terminal, local or over SSH, with no configuration. Terminals without Kitty graphics (VS Code's terminal, tmux) fall back to colored half-blocks with the same cell-level diffing and auto-detected color depth (truecolor, 256, or 16). Every terminal shows motion instead of an error.

Optional post-processing covers color grading (gamma, saturation, brightness, contrast) and CRT-style effects (scanlines, bloom, vignette, curvature, chromatic aberration, NTSC artifacts), in both render paths. Pass them to `createScreen()` or change them mid-playback with `updateOptions()`.

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

// Probes the terminal, then picks the graphics renderer or block-glyph fallback
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

Resize and shutdown are handled for you. The screen recomputes layout on resize, and on exit or Ctrl-C it clears the image and restores the cursor (`autoResize` and `autoDispose`, both on by default).

Runnable demos live in [`examples/`](examples/). Run `node examples/bouncing-ball.ts` in any color terminal (Node 24 strips types natively, so there is no build step). Each demo prints its render config and throughput on exit. Set `DEMO_RENDER_MODE=cell` to preview the block-glyph fallback on a Kitty-capable terminal.

## Options

`createScreen()` accepts the options below. Everything except the creation-only group can also be changed mid-playback with `screen.updateOptions()`.

`createScreen()` runs the async capability probes (graphics support, dirty-rect, file transfer, cell pixel size) before construction. To control when the terminal handshake happens, run the exported `detect*` probes yourself first (their results are cached, so the probes inside `createScreen()` become free), or construct synchronously with `new Screen(options)`.

### Creation only

| Option          | Values               | Default     | Description                                         |
| --------------- | -------------------- | ----------- | --------------------------------------------------- |
| `sourceWidth`   | number               | required    | Width of the source framebuffer in pixels           |
| `sourceHeight`  | number               | required    | Height of the source framebuffer in pixels          |
| `output`        | writable stream      | required    | Sink for encoded frames, typically `process.stdout` |
| `colorSpace`    | `"rgb24"`, `"rgb15"` | `"rgb24"`   | Pixel format of frames passed to `pushFrame()`      |
| `autoResize`    | boolean              | `true`      | Recompute layout on terminal resize (SIGWINCH). Set `false` to call `handleResize()` yourself |
| `autoDispose`   | boolean              | `true`      | Dispose on process exit and SIGINT/SIGTERM/SIGHUP, restoring the terminal. Defers to the app's own signal handlers when present. Set `false` to call `dispose()` yourself |
| `region`        | `ScreenRegion`, undefined | undefined | Confine output to a fixed sub-rectangle (`offsetCol`, `offsetRow`, `cols`, `rows`, 1-based cells), aspect-fit and centered inside the box, instead of centering on the whole terminal. Overrides `reservedRows`. Reposition with `setRegion()` |
| `embedded`      | boolean              | `false`     | Share the terminal with a host TUI. Output is non-destructive (no full-screen clear, no global cursor hide/show, only this Screen's own images or cells removed). Defaults `autoResize` and `autoDispose` to `false` unless set |
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
| `enableDiffRendering` | boolean                                   | `true`  | Skip re-encoding frames pixel-identical to the previous frame                                                                                                                                                                                    |
| `dirtyRects`          | boolean, undefined                        | probe   | Dirty-rect delta frames. `undefined` follows `detectKittyAnimationSupport()`, `true`/`false` overrides. Deltas also require `enableDiffRendering` and an integer `scale` of 1 or more                                                            |
| `fileTransfer`        | boolean, undefined                        | probe   | File-based payload transmission. `undefined` follows `detectKittyFileTransferSupport()`, `true`/`false` forces                                                                                                                                   |
| `renderMode`          | `"kitty"`, `"half-block"`, `"cell-background"`, `"emoji"`, `"ascii"`, undefined | probe | `"kitty"` uses the graphics protocol. `"half-block"` and `"cell-background"` use the block-glyph renderer (2 pixels per cell via U+2580, or 1 via background-colored spaces). `"emoji"` picks one of nine emoji squares per cell by nearest color, `"ascii"` picks one printable character per cell by nearest shape colorized by average color (both opt-in). `undefined` follows the graphics probe, then auto-detects cell mode from `TERM_PROGRAM` (Terminal.app gets `"cell-background"`) |
| `limitColors`         | `0`, `16`, `256`, undefined               | auto    | Cell-mode color depth, `0` means truecolor. `undefined` auto-detects from `COLORTERM`/`TERM`                                                                                                                                                     |
| `cellSampling`        | `"box"`, `"nearest"`, undefined           | nearest | Cell-mode downsampling. `"nearest"` copies each cell's center pixel so hard edges stay solid, `"box"` averages the region in linear light for smoother gradients. In `"ascii"` mode `"nearest"` caps samples per cell so cost stays flat as source resolution grows, while `"box"` averages the full footprint. `undefined` defaults to `"nearest"` |
| `placement`           | `"cursor"`, `"unicode"`                    | `"cursor"` | `"cursor"` displays the image at a cursor position. `"unicode"` transmits a virtual placement and animates it via frame edits, so a host TUI owns layout and the video survives host redraws. Kitty and Ghostty only, ignored on the cell fallback. Pair with `getPlaceholderRows()` |

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

## Screenshots

Capture the current frame as an image. Both methods snapshot the last processed frame at source resolution with post-processing applied, and return the same pixels in every render mode (the raster the library draws from, not the on-screen glyph approximation).

```ts
import { writeFile } from "node:fs/promises";

screen.pushFrame(frame);

// Raw post-processed RGB24 pixels (a fresh copy, safe to keep)
const { data, width, height } = screen.captureRgb();

// Or standalone PNG bytes, ready to write anywhere
await writeFile("frame.png", screen.capturePng());
```

`capturePng()` always encodes at maximum deflate compression (level 9), ignoring `pngCompressionLevel`, since a screenshot is a one-off. Before the first `pushFrame()`, the snapshot is black.

## Embedding in a TUI

kitty-motion can render into a fixed rectangle and share the rest of the screen with a host TUI such as [Ink](https://github.com/vadimdemedes/ink). The host reserves a rectangle, passes it as `region` with `embedded: true`, and draws its own controls outside it. kitty-motion owns the video rectangle, the host owns everything else.

In embedded mode output is non-destructive (no full-screen clear, no global cursor hide or show, only this Screen's own images or cells removed on dispose). The host keeps stdout for its chrome, so it usually sets `autoResize: false` and `autoDispose: false` and drives resize and teardown itself. Embedded mode defaults both to `false` when you do not set them.

The host must not repaint the video rows, since each side owns a disjoint part of the screen. The Unicode placeholder mode below lifts this restriction.

```typescript
import { createScreen } from "kitty-motion";

const screen = await createScreen({
  output: process.stdout,
  sourceWidth,
  sourceHeight,
  embedded: true,
  region: { offsetCol, offsetRow, cols, rows },
  autoResize: false,
  autoDispose: false,
});

for (const frame of frames) {
  screen.pushFrame(frame);
  await nextFrame();
}

// When the host layout changes, move or resize the panel
screen.setRegion({ offsetCol, offsetRow, cols, rows });
```

See [`examples/embedded-panel.ts`](examples/embedded-panel.ts) for a full integration.

### Unicode placeholder mode

Unicode placement drops the single-compositor rule, so the host owns layout and the video survives the host's redraws. Pass `placement: 'unicode'` and the image is transmitted once as a Kitty virtual placement. Instead of positioning the image itself, kitty-motion hands you placeholder text through `getPlaceholderRows()`, one string per grid row, and your framework draws it wherever it places the panel (in Ink, one `<Text>` per line). The terminal fills those cells with the video, so a host redraw that reprints the text just re-anchors the video. Kitty and Ghostty only. On the block-glyph fallback the option is ignored and `getPlaceholderRows()` returns an empty array.

In unicode mode `region.cols`/`region.rows` set the grid and the offset is unused, since the host positions the text. Re-read `getPlaceholderRows()` after a resize or `setRegion()`, because the grid size can change.

```typescript
import { createScreen } from "kitty-motion";

const screen = await createScreen({
  output: process.stdout,
  sourceWidth,
  sourceHeight,
  placement: "unicode",
  embedded: true,
  region: { offsetCol, offsetRow, cols, rows },
  autoResize: false,
  autoDispose: false,
});

// Draw one text line per grid row wherever your framework lays out the panel.
// In Ink, render each string as its own <Text>.
const placeholderRows = screen.getPlaceholderRows();
drawPlaceholderText(placeholderRows);

for (const frame of frames) {
  screen.pushFrame(frame);
  await nextFrame();
}
```

See [`examples/ink-video-player/`](examples/ink-video-player/) for a full Ink integration (Ink controls around a kitty-motion video panel). Run it with `pnpm example:ink` on a Kitty or Ghostty terminal.

## Requirements

- Node.js >= 24
- A terminal that supports the Kitty graphics protocol (e.g. [Kitty](https://sw.kovidgoyal.net/kitty/), [Ghostty](https://ghostty.org/), [WezTerm](https://wezterm.org/)) for full-quality pixel rendering. Any color terminal works via the block-glyph fallback
- Run directly in the terminal, not under tmux or GNU screen. Multiplexers don't pass the graphics protocol through, which forces the block-glyph fallback, and they usually cap colors at 256 instead of truecolor
- macOS Terminal.app works but is not recommended. With no Kitty graphics support and font glyphs that leave seams in the half-block fallback, kitty-motion renders one background-colored pixel per cell there, avoiding the seams at half the vertical resolution

## License

MIT
