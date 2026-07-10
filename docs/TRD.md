# kitty-motion Technical Reference

API reference, architecture rationale, and the benchmarks behind the defaults.
For an introduction and quick start, see the [README](../README.md).

## Why not write the escape codes yourself?

Emitting an `a=T` escape gets an image on screen. The cost of sustaining
motion is what this library exists to remove. Each optimization below is on by
default, detected by a runtime probe, and measured (benchmarks in
[Design notes](#design-notes) and the `examples/` demos, which print these
numbers on exit):

| Optimization | Measured effect |
|---|---|
| Diff skip: pixel-identical frames are never re-encoded | an idle frame costs one buffer compare and zero output |
| Dirty-rect deltas: after the first frames, only the changed bounding rectangle is re-encoded and transmitted as an in-place frame edit | on game-like content (detailed 256x240 background, 16x16 moving sprite), 14x less encode CPU and 128x smaller payloads (89 KB full frame vs 700 byte delta) |
| File-based transmission: frames travel as terminal-deleted temp files, the escape carries only the file path | pty traffic in the full-frame stress demo drops from 1,326 KB/s to 5 KB/s, and the 33 percent base64 inflation disappears |
| Worker-thread PNG encoding | roughly 0.6 ms of deflate per frame runs off your game loop's thread, with automatic synchronous fallback |
| Backpressure-aware output | on a slow terminal or SSH link, frames drop instead of queueing, so on-screen latency never grows |
| Font-independent aspect correction | the terminal's real cell pixel size is queried at startup, so proportions are correct on any font |

The probes compose per terminal with no configuration. A local kitty passes
the animation and shared-filesystem probes and gets deltas delivered as
files. Kitty over SSH keeps deltas but streams them inline, exactly where
small payloads matter most. A terminal with neither capability gets plain
streamed full frames. Every combination renders correctly, and every probe can be
overridden per option (`dirtyRects`, `fileTransfer`).

## Which layer do I want?

Most users want `Screen`. Reach for the low-level primitives only if
you're building your own render loop or embedding pieces of this into a larger
renderer.

| | `Screen` | Low-level primitives |
|---|---|---|
| API surface | One class: `pushFrame()` | Encoder, worker client, protocol builders, terminal detection, etc. You compose them yourself |
| Backpressure handling | Built in (`OutputGate`) | Your responsibility |
| Diff-based skip of unchanged frames | Built in | Not provided. Primitives always encode what you give them |
| Dirty-rect delta frames | Built in (probed, with damage tracking across dropped frames) | You compute rects with `computeDirtyRect` and manage image ids yourself |
| File-based transmission | Built in (probed, with file lifecycle management) | You write files and build `t=t` payloads yourself |
| Worker-thread PNG encoding | Built in, with automatic sync fallback | You wire up `KittyEncodeWorkerClient` yourself |
| Aspect-ratio correction | Built in (font-independent) | You call `kittyGridAspectRatio` / `fitToTerminal` yourself |
| When to use | Pushing frames from a game loop, emulator, or video source | Custom render pipelines, testing, partial reuse |

## `Screen` API reference

### `createScreen(options): Promise<Screen>`

Probes the terminal's capabilities, then constructs and returns a `Screen`.
The probes it runs are the ones whose results the synchronous `Screen`
constructor reads from cache: `detectKittyGraphicsSupport()` (renderer
selection), `detectKittyAnimationSupport()` (dirty-rect delta frames),
`detectKittyFileTransferSupport()` (temp-file payloads), and
`detectCellPixelSize()` (font-independent aspect correction). Probes made
irrelevant by an explicit option are skipped: a forced `renderMode` skips the
graphics probe, an explicit `dirtyRects` or `fileTransfer` skips that probe,
and the kitty-only probes never run when graphics support is absent (they
write Kitty escape sequences).

### `new Screen(options): Screen`

Synchronous construction for hosts that manage probing themselves. Reads
only cached probe results, so run the `detect*` functions you need first.
Probe results are cached process-wide, which also means running them before
`createScreen()` makes its internal probes free. An unprobed graphics cache
selects the kitty renderer.

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `sourceWidth` | `number` | (required) | Width of the source framebuffer in pixels |
| `sourceHeight` | `number` | (required) | Height of the source framebuffer in pixels |
| `output` | `DrainableStream` | (required) | Writable sink for encoded frames, typically `process.stdout` |
| `colorSpace` | `"rgb15" \| "rgb24"` | `"rgb24"` | Pixel format of frames passed to `pushFrame` |
| `autoResize` | `boolean` | `true` | Recompute display size and centering on terminal resize via a process `SIGWINCH` listener, removed on `dispose()`. Set `false` to call `handleResize()` yourself (e.g. to sequence your own redraw work around it) |
| `autoDispose` | `boolean` | `true` | Dispose on process exit and on `SIGINT`/`SIGTERM`/`SIGHUP`, restoring the cursor and clearing the image. The process hooks are shared across screens and removed when the last auto-dispose screen is disposed. When the process has its own handler for one of those signals, that handler keeps control of shutdown and disposal happens through the exit hook instead. When the screen's handler is the only one, it disposes and re-raises the signal so the process still terminates with the conventional `128+n` status. Set `false` to call `dispose()` yourself |
| `region` | `ScreenRegion` | `undefined` | Confine output to a fixed sub-rectangle (`offsetCol`, `offsetRow`, `cols`, `rows`, 1-based cell coordinates) instead of centering on the whole terminal. The video is aspect-fit and centered inside the box. When set, `reservedRows` is ignored. Reposition or resize with `setRegion()` |
| `embedded` | `boolean` | `false` | Share the terminal with a host TUI. Output is non-destructive (no full-screen clear, no global cursor hide/show, only this Screen's own images or cells removed). When `true`, `autoResize` and `autoDispose` default to `false` unless set explicitly |
| `scale` | `number` | `2` | Internal render scale (0.25-4x). Higher values increase PNG quantization fidelity at the cost of CPU |
| `pixelAspectRatio` | `number` | `1.0` | Source pixel aspect ratio (e.g. `8/7` for NES-style non-square pixels). Combined with the terminal's real cell pixel size for font-independent aspect correction |
| `reservedRows` | `number` | `0` | Terminal rows to exclude from the display area (e.g. for a status line) |
| `pngCompressionLevel` | `number` | `5` | Deflate level (1-9). See [Design notes](#compression-level) for the benchmark behind this default |
| `colorEnabled` | `boolean` | `true` | When `false`, renders in grayscale |
| `enableDiffRendering` | `boolean` | `true` | Skip re-encoding frames that are pixel-identical to the previous frame |
| `dirtyRects` | `boolean` | `undefined` | `undefined` follows `detectKittyAnimationSupport()`, `true` enables delta frames on terminals the probe rejected or never checked, and `false` disables them. Deltas still require `enableDiffRendering` and an integer `scale` of 1 or more |
| `fileTransfer` | `boolean` | `undefined` | Deliver frames as temp files instead of base64 escape payloads. `undefined` follows `detectKittyFileTransferSupport()`, and `true`/`false` overrides the probe |
| `renderMode` | `"kitty" \| "half-block" \| "cell-background" \| "emoji" \| "ascii"` | `undefined` | Renderer selection. `undefined` follows the cached graphics probe (`getKittyGraphicsSupported() === false` auto-detects the cell mode from `TERM_PROGRAM`, `true` or `null` selects kitty). `"kitty"` forces the graphics protocol, `"half-block"` and `"cell-background"` force the block-glyph fallback, and `"emoji"` (opt-in only) renders one emoji square per cell by nearest color, and `"ascii"` (opt-in only) renders one printable ASCII character per cell by nearest shape |
| `limitColors` | `0 \| 16 \| 256` | `undefined` | Cell mode only. SGR color depth. When `undefined`, a `COLORTERM` of `truecolor`/`24bit` selects truecolor (`0`), a `TERM` containing `256color` selects 256, and anything else selects 16 |
| `placement` | `"cursor" \| "unicode"` | `"cursor"` | Kitty placement model. `"cursor"` displays the image at a cursor position. `"unicode"` transmits a virtual placement (`U=1`) and animates it via frame edits, so a host TUI owns layout and the video survives host redraws. Kitty and Ghostty only, ignored on the cell-glyph fallback. Pair with `getPlaceholderRows()` |
| `workerFactory` | `WorkerFactory` | real worker | Override worker creation (tests, embedding) |
| `onDebug` | `(message: string) => void` | (none) | Optional sink for internal diagnostic messages |
| ...`EffectOptions` | | | Color grading (`gamma`, `saturation`, `brightness`, `contrast`) and CRT-style effects (`scanlines`, `vignette`, `bloom`, `bloomThreshold`, `ntsc`, `curvature`, `chromaticAberration`), all default off/neutral |

### Methods

| Method | Description |
|---|---|
| `pushFrame(frame: Uint8Array \| Uint16Array)` | Render and send one frame. No-ops if the previous write hasn't drained yet (frames drop, they never queue) |
| `isWritable(): boolean` | Whether the output stream can accept a frame right now. Check before expensive frame preparation |
| `handleResize()` | Recompute display size and centering after a terminal resize. Called automatically on `SIGWINCH` unless `autoResize: false` |
| `setRegion(region: ScreenRegion)` | Move or resize the panel's fixed sub-rectangle. Clears the old region non-destructively, re-runs layout, and paints the new location on the next `pushFrame` |
| `updateOptions(partial: Partial<ScreenUpdatableOptions>)` | Apply new option values at runtime. Resets diff state, so the next frame renders in full |
| `getDisplaySize(): { cols: number; rows: number }` | Current on-screen size in terminal cells |
| `getStatusRow(): number` | First terminal row below the image, for placing a status line |
| `getPlaceholderRows(): string[]` | Placeholder text for host-rendered Kitty Unicode placement, one string per grid row, for the host to draw as text (e.g. one Ink `<Text>` per line). Empty unless the Screen was created with `placement: "unicode"` on a Kitty graphics terminal. Re-read after a resize or `setRegion()`, since the grid size can change |
| `getRenderMode(): "kitty" \| "half-block" \| "cell-background" \| "emoji" \| "ascii"` | Which rendering path is active, the Kitty graphics protocol, one of the two block-glyph cell modes, emoji, or ascii |
| `captureRgb(): CapturedFrame` | Snapshot the last rendered frame as post-processed RGB24 pixels at source resolution (a fresh copy). Same in every render mode. Zero-filled before the first `pushFrame` |
| `capturePng(): Uint8Array` | Snapshot the last rendered frame as standalone PNG bytes at source resolution, always at maximum deflate compression (level 9, not the render loop's `pngCompressionLevel`) since a screenshot is not time sensitive. Write them yourself, e.g. `fs.writeFile(path, screen.capturePng())` |
| `dispose()` | Clear the image, restore the cursor, and terminate the encode worker. Called automatically on process exit and termination signals unless `autoDispose: false` |

## Low-level exports

For building a custom pipeline instead of using `Screen`:

- `KittyRenderer`, `KittyRendererOptions`: the full graphics-path pipeline (scaling, color, post-processing, diffing, worker-based encoding) without `Screen`'s layout, resize, and probe orchestration
- `CellRenderer`, `CellRendererOptions`, `CellLayout`: cell fallback renderer for terminals without Kitty graphics (half blocks, or background-colored spaces on Terminal.app)
- `KittyFrameEncoder`, `KittyFrameMeta`, `PngEncodeParams`: pure scale → PNG → base64 → APC-chunk encoder, usable synchronously or inside a worker. `encodeImage(rgb, width, height, compression)` produces a standalone PNG (no escape wrapping) for screenshots
- `KittyEncodeWorkerClient`, `WorkerFactory`, `WorkerLike`: owns the encode worker, transfers frames, recycles buffers, coalesces latest-wins
- `KittyEncodeRequest`, `KittyEncodeResponse`, `isKittyEncodeRequest`, `isKittyEncodeResponse`: the message contract a custom `workerFactory` worker must speak
- `kittyGridAspectRatio`: compute the terminal cell-grid aspect ratio needed to display a source framebuffer correctly
- `fitToTerminal`, `FitToTerminalOptions`, `DisplaySize`: fit a display size to available terminal space while preserving an aspect ratio
- `detectCellPixelSize`, `getCellPixelSize`, `resetCellPixelSizeDetection`, `getTerminalDimensions`, `CellPixelSize`: query and cache the terminal's real character-cell pixel size
- `isSSHSession`, `isMultiplexedSession`, `SessionEnv`: environment-based detection of SSH sessions and terminal multiplexers (tmux, GNU screen). Both accept an optional env object for testing
- `detectKittyGraphicsSupport`, `getKittyGraphicsSupported`, `resetKittyGraphicsDetection`, `buildKittyImageSequence`, `buildKittyDeleteSequence`, `buildCursorPositionSequence`: Kitty graphics protocol detection and escape-sequence builders
- `detectKittyAnimationSupport`, `getKittyAnimationSupported`, `resetKittyAnimationDetection`: Kitty animation-protocol (frame edit) support detection, required for dirty-rect delta frames
- `detectKittyFileTransferSupport`, `getKittyFileTransferSupported`, `resetKittyFileTransferDetection`: shared-filesystem detection for file-based frame transmission
- `detectKittyUnicodePlaceholderSupport`: env-based, advisory check for Kitty Unicode placeholder placement (Kitty and Ghostty). Opting into `placement: "unicode"` is the real gate
- `buildPlaceholderRows`, `encodeImageIdFg`, `PLACEHOLDER_CHAR`, `PlaceholderError`, `isPlaceholderError`, `PlaceholderErrorCode`: build the `U+10EEEE` placeholder cells for Kitty Unicode placement (one string per grid row, image id encoded in the foreground color) and the typed error they can throw
- `computeDirtyRect`, `unionRects`, `fullFrameRect`, `isFullFrameRect`, `Rect`: changed-region bounding-box helpers behind dirty-rect delta rendering
- `OutputGate`, `DrainableStream`: backpressure-aware writable wrapper that drops frames instead of queueing them
- `PostProcessingPipeline`, `EffectOptions`: the post-processing effects pipeline (color grading plus CRT-style effects)
- `detectColorDepth`, `ColorDepth`: environment-based SGR color depth detection
- `detectCellRenderMode`, `CellRenderMode`: environment-based cell render-mode detection (Terminal.app gets `cell-background` because its font-drawn block glyphs do not tile the cell)
- `rgbToEmoji`, `buildEmojiLUT`, `EMOJI_COLORS`, `EmojiColor`: the fixed nine-color emoji palette and its nearest-color quantizer, used by the opt-in `emoji` render mode
- `ASCII_SHAPES`, `ASCII_CHARS`, `nearestAsciiChar`, `createAsciiLookup`, `enhanceAsciiContrast`, `SHAPE_REGION_COLS`, `SHAPE_REGION_ROWS`, `SHAPE_VECTOR_DIMS`, `AsciiShape`, `AsciiLookup`: the font-generated per-character shape-vector table and the nearest-shape lookup used by the opt-in `ascii` render mode
- `computeDisplayLayout`, `DisplayLayout`, `DisplayLayoutOptions`: centered, aspect-correct cell-grid placement (shared by both renderers)
- `rgbToAnsi256`, `rgbToAnsi16`, `convertFrameToRgb24`, `FrameToRgb24Options`, `buildGammaLUT`, `frameUnitsPerPixel`, `allocateFrameBuffer`, `allocateFrameBufferLike`, `isRgb15Buffer`: color quantization, gamma tables, framebuffer conversion, and framebuffer allocation primitives
- `FrameBuffer`, `ColorSpace`, `Renderer`, `RenderMode`, `CapturedFrame`: shared framebuffer types, the renderer contract both renderers implement, and the RGB snapshot `captureRgb` returns

## Design notes

### Compression level

PNG deflate runs on a worker thread, off the render loop, so it isn't free but it also isn't blocking. Measured on 102 real GBA frames (240×160 source, scaled to 480×320 at 2x, indexed-color path):

| Config | Avg payload | Encode time |
|---|---|---|
| level 1 (old default) | 7.0 KB | 0.37 ms |
| level 3 | 5.1 KB | 0.36 ms |
| **level 5-6 (default)** | **~3.4 KB** | **~0.6 ms** |
| level 9 | 3.1 KB | 2.65 ms |

Level 5 roughly halves the payload versus level 1 for well under a millisecond of extra worker CPU per frame. Level 9 squeezes out another ~10% but costs 4-7x the encode time for it, which is not worth it when the encode is already off the critical path but still has to keep up with 60fps arrivals. `5` is the package default. Raise it toward `9` if you're bandwidth-constrained (e.g. over SSH) and have CPU to spare, or drop it toward `1` if you're CPU-constrained and have bandwidth to spare.

### Why there's no PNG row filtering

Standard PNG encoders apply per-scanline filters (Sub, Up, Average, Paeth) before deflate, because they exploit numeric correlation between neighboring pixel values. kitty-motion's indexed-color path deflates palette indices, not raw color values, and palette index assignment is arbitrary (the Nth unique color encountered gets index N). Two adjacent pixels that are visually similar colors can land on palette indices 3 and 200, so filters that predict "this byte is close to its neighbor" have nothing meaningful to predict. Benchmarking confirmed this. Adaptive min-SAD filtering at compression level 6 produced 3.9 KB average payloads, larger than the 3.4 KB with no filtering at all. Filtering was left out entirely rather than spending CPU on a transform that makes output worse.

### Why frames drop instead of queueing

`OutputGate` checks the return value of `stream.write()`. When it's `false` (the OS write buffer is full, typically a slow terminal, an SSH link, or a pipe with a slow reader), the gate marks itself blocked and drops every subsequent `pushFrame` call until a `drain` event fires. There is no queue and no buffering of pending frames. For motion video, a frame that's a few hundred milliseconds late is worse than no frame at all. An unbounded queue would only grow the latency between what's happening in your simulation and what's on screen. Dropping keeps the display honest. It always shows either the current state or nothing, never a backlog.

### Font-independent aspect correction

Kitty scales a transmitted image to exactly fill the requested `cols x rows` cell grid, so the on-screen aspect ratio is determined by `(cols * cellWidthPx) / (rows * cellHeightPx)`. Terminal fonts vary in cell pixel dimensions, so a display size computed from a fixed assumed cell ratio looks stretched or squashed depending on the user's font. kitty-motion queries the terminal directly for its real cell pixel size (via a CSI cell-size or text-area-size escape sequence, cached for the process lifetime, see `detectCellPixelSize`), then feeds that into `kittyGridAspectRatio` along with the source framebuffer's dimensions and pixel aspect ratio to compute the exact `cols`/`rows` needed for correct proportions. If the terminal doesn't answer the query, it falls back to a typical cell ratio.

### Dirty-rect deltas

After the first frames, only the changed bounding rectangle is re-encoded and transmitted, as a Kitty animation-protocol frame edit composited into the displayed image. Payload scales with the changed area instead of the frame size. Measured on game-like content (a detailed dithered 256x240 background with a 16x16 moving sprite, the kind of frame an emulator produces), a full frame costs 2.67 ms to encode and 89 KB to send, and the delta costs 0.19 ms and 700 bytes. When every pixel changes (scrolling, video), the delta degenerates to a full-frame edit and costs the same as before, so the worst case is never a regression.

The rect bounds more than the encode. Color conversion and pointwise post-processing also run only within the transmitted rectangle. Pixels outside it are unchanged since the previous frame, so the renderer's RGB working buffer already holds their converted, processed values. Measured on the sprite scenario above with gamma, scanlines, and vignette enabled, the per-frame render cost drops from 0.50 ms to 0.20 ms. Effects that spread a pixel's influence (bloom, NTSC, curvature, chromatic aberration) already force full-frame transmits, so they never see a partial rect. (Replacing the blur loops' per-pixel `sum / windowSize` divisions with exact fixed-point reciprocal multiplies was tried and reverted: it measured 6 to 10 percent slower on an Apple M-series laptop, where the integer divide beats the extra branch and multiply.) Frames dropped by backpressure or coalescing have their damage rectangles unioned into the next frame, so no screen region can go stale. Requires terminal support, detected at startup by `detectKittyAnimationSupport()`. Terminals without it (or hosts setting `dirtyRects: false`) keep receiving full frames. Setting `dirtyRects: true` enables delta frames on terminals the probe rejected or never checked. It still requires `enableDiffRendering` and an integer `scale` of 1 or more, since fractional scales cannot map pixel-precise dirty rects onto the encoded output.

### File-based transmission

On terminals that share a filesystem with the process, each frame is written to a fresh temp file and the escape sequence carries only the base64-encoded path (about 100 bytes), removing the 33 percent base64 inflation and the terminal-side cost of parsing large escape payloads. Measured on the plasma demo (128x96 truecolor, every pixel changes every frame at 30fps), escape traffic through the pty drops from 1,326 KB/s to 5 KB/s with identical frame counts. Files use the Kitty `t=t` medium. They live in the OS temp directory with the string `tty-graphics-protocol` in their names, which the terminal deletes after reading. Support is detected at startup by `detectKittyFileTransferSupport()`, which asks the terminal to read a real probe file, so SSH sessions and containers correctly fall back to streaming escapes. If a frame's file write fails, that frame falls back to an inline escape payload. Frames dropped by backpressure have their files removed by the renderer. Setting `fileTransfer: true` forces file delivery on terminals the probe rejected or never checked.

### Cell-renderer fallback

On terminals without Kitty graphics support, `Screen` renders frames as
colored half-block characters instead of failing. Each cell is the upper
half block. The foreground color paints the cell's top pixel and the
background color its bottom pixel, giving 1x2 pixels per cell with exact
color. (A quadrant-glyph mode with 2x2 pixels per cell and per-cell
two-color reduction was tried and removed. The luminance split looks
distorted on real content, so exact color at half the resolution wins.)
Output is
diffed at the cell level against the previously emitted grid. After the first
paint, each frame re-sends only runs of changed cells, addressed by one
cursor-move escape per run, with SGR color changes elided when consecutive
cells share colors. A frame whose cell grid is unchanged emits nothing, which
catches more than the pixel-level skip. Two frames that downsample and
quantize to identical cells cost zero output. Backpressure needs no damage
bookkeeping (unlike kitty deltas) because a blocked `pushFrame` returns
before rendering, so the stored grid always matches what the terminal
received. Color depth follows `COLORTERM`/`TERM` (truecolor, 256, or 16,
override with `limitColors`). Scanline-style post-processing effects are
mostly invisible at cell resolution, though gamma, saturation, brightness,
and contrast carry over.

Two measured optimizations keep per-frame CPU low (numbers from a 384x224
source onto a 240x67 grid on an Apple M-series laptop). First, palette
quantization in 16 and 256 color modes runs through a 32,768-entry lookup
table indexed by the top 5 bits of each channel (built once in the
constructor), replacing per-pixel nearest-entry searches. Cell mapping drops
from about 1.2 ms to 0.15 ms on a full-frame change, roughly halving total
frame cost in those modes. Second, the dirty rect computed for the
unchanged-frame skip also bounds color conversion, pointwise post-processing,
downsampling, and cell re-mapping, so a frame that changes a small region only
reprocesses that region plus the cells whose box-filter input intersects it
(padded one cell against boundary rounding). A small moving
sprite drops from about 0.9 ms to 0.3 ms per frame. Effects that spread a
pixel's influence (bloom, NTSC, curvature, chromatic aberration) disable the
bounded path via `hasNonLocalEffects()`, because a source-space diff
underestimates the damaged output region. Pointwise effects keep it valid.
A full-frame truecolor change (about 3 ms CPU, roughly 530 KB of SGR output
per frame) is bounded by terminal-side escape parsing rather than renderer
CPU, so its remaining cost is left alone.

### Embedding in a TUI

A `region` confines the panel to a fixed sub-rectangle instead of centering on
the whole terminal. The region flows through `computeDisplayLayout`, which fits
the source framebuffer inside the region's `cols x rows` box (aspect-correct)
and centers it there, so one layout function serves both full-screen and
confined placement. When a region is set, `reservedRows` is ignored, because the
region already fixes the panel's bounds.

`embedded: true` makes the renderers' terminal control non-destructive. Both
renderers' `clearScreen()` removes only this Screen's own output (`KittyRenderer`
deletes only its own image ids, `CellRenderer` blanks only its own rows) instead
of writing `\x1b[2J`, and `hideCursor()`/`showCursor()` become no-ops so the
global cursor state stays with the host. `Screen` also skips the destructive
constructor init (no full clear, no cursor hide) and defaults `autoResize` and
`autoDispose` to `false`, so the host owns resize and process teardown unless the
caller sets those options. `setRegion(region)` clears the old rectangle
non-destructively, re-runs `computeDisplayLayout`, and repaints at the new
location on the next `pushFrame`.

Each `KittyRenderer` (and so each `Screen`) claims a unique image-id range, so
several panels can coexist in one process without deleting each other's images.
Because the host draws its own chrome, the reliable pattern is the single
compositor. kitty-motion owns the video rectangle and the host draws its
controls in other rows, and the host must not repaint the video rows.

`placement: "unicode"` removes the single-compositor restriction by handing
layout to the host. The image is transmitted once as a virtual placement
(`a=T,U=1` with `c`/`r` from the region grid and no cursor move), then only
pixels update. How they update depends on the terminal. Kitty supports the
animation protocol, so updates go through the existing dirty-rect `a=f` frame
edits (a full `a=T` re-transmit to the same id would delete its placements, so
the renderer never uses one to update on Kitty). Ghostty has no animation
protocol, so `detectKittyAnimationSupport()` returns false and the renderer
instead re-transmits the whole image to the same id with `a=t`, which Ghostty
composites into the existing placement in place (no delete, so no flicker).
Either way it uses a single stable image id (no double-buffer). The host renders
the placeholder cells returned by
`getPlaceholderRows()` as ordinary text, and the terminal fills whichever cells
carry them with the video, so a host redraw that reprints the text re-anchors
the placement. Each placeholder cell is `U+10EEEE` plus row and column
combining diacritics, with the image id carried in the cell's foreground color.
Support is Kitty and Ghostty only. `detectKittyUnicodePlaceholderSupport()` is
an env-based, advisory check (Kitty via `KITTY_WINDOW_ID`/`TERM`, Ghostty via
`TERM_PROGRAM`/`GHOSTTY_*`). Opting into `placement: "unicode"` is the real
gate. On the cell-glyph fallback the option is ignored and
`getPlaceholderRows()` returns an empty array.
