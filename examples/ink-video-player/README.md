# Ink video player

A terminal video player where [Ink](https://github.com/vadimdemedes/ink) (React
for the CLI) owns the layout and controls, and kitty-motion owns the video
panel. The panel is composited into Ink's output with Kitty Unicode
placeholders, so the video is just text cells that Ink lays out like any other
component. The picture survives Ink's redraws because those cells are ordinary
text, and kitty-motion updates the image they display out of band.

## Requirements

An interactive Kitty or Ghostty terminal (Unicode placeholder support). On other
terminals the example prints a short message and exits. Those terminals can
still play video through the non-placeholder API. See
[`../embedded-panel.ts`](../embedded-panel.ts) for the block-glyph fallback
path.

## Run

```
pnpm example:ink
```

## Controls

- `space` pause or resume
- `←` / `→` seek by 3 seconds
- `q` or `Ctrl-C` quit

The animation is a deterministic hue-cycling ball on a Lissajous path, drawn
purely from elapsed time, so seeking moves the picture even while paused.
