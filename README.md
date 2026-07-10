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

Optional post-processing covers color grading (gamma, saturation, brightness, and contrast) plus CRT-style effects (scanlines, bloom, vignette, screen curvature, chromatic aberration, and NTSC artifacts). Pass effects to `createScreen()` or change them mid-playback with `updateOptions()`. They apply in both render paths.

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
| `region`        | `ScreenRegion`, undefined | undefined | Confine output to a fixed sub-rectangle (`offsetCol`, `offsetRow`, `cols`, `rows`, 1-based cells) instead of centering on the whole terminal. The video is aspect-fit and centered inside the box. Overrides `reservedRows`. Reposition later with `setRegion()` |
| `embedded`      | boolean              | `false`     | Share the terminal with a host TUI. Output is non-destructive (no full-screen clear, no global cursor hide/show, only this Screen's own images or cells removed). Defaults `autoResize` and `autoDispose` to `false` unless you set them |
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
| `renderMode`          | `"kitty"`, `"half-block"`, `"cell-background"`, `"emoji"`, `"ascii"`, undefined | probe | Renderer selection. `"kitty"` uses the graphics protocol. `"half-block"` and `"cell-background"` use the block-glyph renderer (2 pixels per cell via U+2580, or 1 pixel per cell via background-colored spaces). `"emoji"` renders one of nine emoji squares per cell by nearest color (needs an emoji-capable terminal) and is opt-in only. `"ascii"` renders one printable ASCII character per cell chosen by nearest shape, colorized by the cell's average color, and is opt-in only. `undefined` follows the graphics probe, then auto-detects the cell mode from `TERM_PROGRAM` (Terminal.app gets `"cell-background"`) |
| `limitColors`         | `0`, `16`, `256`, undefined               | auto    | Cell-mode color depth, `0` means truecolor. `undefined` auto-detects from `COLORTERM`/`TERM`                                                                                                                                                     |
| `cellSampling`        | `"box"`, `"nearest"`, undefined           | nearest | Cell-mode downsampling. `"nearest"` copies each cell's source-region center pixel so hard-edged content stays solid, `"box"` averages the region in linear light for smoother gradients. In `"ascii"` mode `"nearest"` caps the samples per cell so cost stays flat as source resolution grows, while `"box"` averages the full footprint (the two match on small sources). `undefined` defaults to `"nearest"` |
| `placement`           | `"cursor"`, `"unicode"`                    | `"cursor"` | Kitty placement model. `"cursor"` displays the image at a cursor position. `"unicode"` transmits a virtual placement and animates it via frame edits, so a host TUI framework owns layout and the video survives the host's redraws. Kitty and Ghostty only, ignored on the cell-glyph fallback. Pair with `getPlaceholderRows()` |

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

Capture the current frame as an image. Both methods snapshot the last frame the renderer processed, at source resolution, with gamma and post-processing already applied. They return the same pixels in every render mode, since the snapshot is the raster the library draws from, not the on-screen glyph approximation.

```ts
import { writeFile } from "node:fs/promises";

screen.pushFrame(frame);

// Raw post-processed RGB24 pixels (a fresh copy, safe to keep)
const { data, width, height } = screen.captureRgb();

// Or standalone PNG bytes, ready to write anywhere
await writeFile("frame.png", screen.capturePng());
```

`capturePng()` always encodes at maximum deflate compression (level 9) for the smallest file, ignoring `pngCompressionLevel` (which only tunes the live render loop). A screenshot is a one-off, so it spends the extra CPU. Before the first `pushFrame()`, the snapshot is a zero-filled (black) image.

## Embedding in a TUI

kitty-motion can render into a fixed rectangle and share the rest of the screen with a host TUI such as [Ink](https://github.com/vadimdemedes/ink). The model is a single compositor. The host reserves a rectangle for the video, passes it as `region` with `embedded: true`, and draws its own controls in the rows outside that rectangle. kitty-motion owns the video rectangle and the host owns everything else.

In embedded mode the output is non-destructive. There is no full-screen clear and no global cursor hide or show, and only this Screen's own images or cells are removed on dispose. The host keeps ownership of stdout for its chrome, so it usually sets `autoResize: false` and `autoDispose: false` and drives resize and teardown itself. Embedded mode defaults both to `false` when you do not set them.

The host must not repaint the video rows. In this fixed-region model kitty-motion and the host each own a disjoint part of the screen, so a host redraw over the video rectangle fights the renderer. The Unicode placeholder mode below lifts this restriction, letting the host own layout and the video survive the host's redraws.

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

See [`examples/embedded-panel.ts`](examples/embedded-panel.ts) for a full host integration.

### Unicode placeholder mode

The fixed-region model above makes kitty-motion the single compositor, so the
host has to leave the video rows untouched. Unicode placement drops that rule.
The host owns layout and the video survives the host's redraws, so there is no
single-compositor restriction.

Pass `placement: 'unicode'` and the image is transmitted once as a Kitty
virtual placement. Instead of positioning the image itself, kitty-motion hands
you placeholder text through `getPlaceholderRows()`, one string per grid row,
and your framework draws that text wherever it places the panel (in Ink, one
`<Text>` per line). The terminal fills whatever cells hold the placeholder
characters with the video, so a host redraw that reprints the placeholder text
just re-anchors the video in place. This mode is Kitty and Ghostty only. On the
block-glyph fallback the option is ignored and `getPlaceholderRows()` returns an
empty array.

In unicode mode `region.cols`/`region.rows` set the grid and the offset is not
used for positioning, since the host positions the placeholder text itself.
Re-read `getPlaceholderRows()` after a resize or `setRegion()`, because the grid
size can change.

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

See [`examples/ink-video-player/`](examples/ink-video-player/) for a full Ink
integration (Ink controls around a kitty-motion video panel). Run it with
`pnpm example:ink` on a Kitty or Ghostty terminal.

## Requirements

- Node.js >= 24
- A terminal that supports the Kitty graphics protocol (e.g. [Kitty](https://sw.kovidgoyal.net/kitty/), [Ghostty](https://ghostty.org/), [WezTerm](https://wezterm.org/)) for full-quality pixel rendering. Any color terminal works via the block-glyph fallback
- Run directly in the terminal, not under tmux or GNU screen. Multiplexers don't pass the graphics protocol through, which forces the block-glyph fallback, and they usually cap colors at 256 instead of truecolor
- macOS Terminal.app works but is not recommended. It has no Kitty graphics support, and it draws block characters as ordinary font glyphs that don't tile the cell, so the half-block fallback shows seams there. kitty-motion detects Terminal.app and switches to one background-colored pixel per cell, which avoids the seams but halves the vertical resolution

## License

MIT
