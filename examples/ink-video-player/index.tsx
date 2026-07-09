/**
 * Ink video player: Ink (React for the CLI) owns the layout and the controls,
 * kitty-motion owns a video panel composited into it with Kitty Unicode
 * placeholders. The panel is transmitted once as a virtual placement. Each
 * pushFrame updates the image the placeholder cells display, so the video
 * survives Ink's redraws because the placeholder cells are ordinary text that
 * Ink lays out like any other <Text>.
 *
 * Run: pnpm example:ink
 *
 * Needs an interactive Kitty or Ghostty terminal (Unicode placeholder support).
 * Other terminals can still play video through the non-placeholder API (see
 * examples/embedded-panel.ts for the block-glyph fallback path).
 *
 * Controls: space pauses/resumes, left/right arrows seek, q or Ctrl-C quits.
 *
 * Caveat: Ink measures each row with a string-width library to lay the box out.
 * Every placeholder cell is meant to count as width 1 (the placeholder char is
 * width 1 and the row/column diacritics are zero-width combining marks). If a
 * given Ink build's width table miscounts U+10EEEE the box may need an explicit
 * width. The final on-screen result is validated by running this in a real
 * Kitty or Ghostty terminal.
 */
import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import {
  createScreen,
  detectKittyUnicodePlaceholderSupport,
  type Screen,
} from "../../src/index.ts";

// Source framebuffer the animation is drawn into, then downscaled to the panel
const SOURCE_WIDTH = 240;
const SOURCE_HEIGHT = 140;

// Panel grid: leave a little horizontal margin, cap the width, fix the height
const MAX_PANEL_COLS = 100;
const PANEL_HORIZONTAL_MARGIN = 4;
const PANEL_ROWS = 18;

// Playback timing
const FPS = 30;
const FRAME_INTERVAL_MS = 1_000 / FPS;
const LOOP_MS = 20_000;
const SEEK_STEP_MS = 3_000;

// Lissajous ball path (different X/Y angular frequencies trace a moving figure)
const BALL_RADIUS = 16;
const BALL_MARGIN = 4;
const LISSAJOUS_A = 1.1;
const LISSAJOUS_B = 1.7;
const BACKGROUND_RGB: readonly [number, number, number] = [8, 10, 24];

// Text progress bar
const PROGRESS_BAR_WIDTH = 32;
const PROGRESS_FILLED_CHAR = "█";
const PROGRESS_EMPTY_CHAR = "░";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

// Full-saturation, full-value hue (0-1) to RGB, so the ball's color cycles once
// per loop. Kept a pure function of elapsed time so seeking is deterministic.
const hueToRgb = (hue: number): [number, number, number] => {
  const h = (((hue % 1) + 1) % 1) * 6;
  const x = 1 - Math.abs((h % 2) - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) {
    r = 1;
    g = x;
  } else if (h < 2) {
    r = x;
    g = 1;
  } else if (h < 3) {
    g = 1;
    b = x;
  } else if (h < 4) {
    g = x;
    b = 1;
  } else if (h < 5) {
    r = x;
    b = 1;
  } else {
    r = 1;
    b = x;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
};

// Reused across frames so the loop does not allocate 100KB every tick
const frameBuffer = new Uint8Array(SOURCE_WIDTH * SOURCE_HEIGHT * 3);

// Deterministic animation: a hue-cycling ball on a Lissajous path over a dark
// background, purely a function of elapsed time, so seeking visibly moves it.
const renderFrame = (elapsedMs: number): Uint8Array => {
  const t = elapsedMs / 1_000;
  const centerX = SOURCE_WIDTH / 2;
  const centerY = SOURCE_HEIGHT / 2;
  const ampX = SOURCE_WIDTH / 2 - BALL_RADIUS - BALL_MARGIN;
  const ampY = SOURCE_HEIGHT / 2 - BALL_RADIUS - BALL_MARGIN;
  const ballX = centerX + ampX * Math.sin(t * LISSAJOUS_A);
  const ballY = centerY + ampY * Math.sin(t * LISSAJOUS_B);
  const [ballR, ballG, ballB] = hueToRgb(elapsedMs / LOOP_MS);
  const radiusSquared = BALL_RADIUS * BALL_RADIUS;

  for (let py = 0; py < SOURCE_HEIGHT; py++) {
    for (let px = 0; px < SOURCE_WIDTH; px++) {
      const i = (py * SOURCE_WIDTH + px) * 3;
      const dx = px - ballX;
      const dy = py - ballY;
      const inside = dx * dx + dy * dy <= radiusSquared;
      frameBuffer[i] = inside ? ballR : BACKGROUND_RGB[0];
      frameBuffer[i + 1] = inside ? ballG : BACKGROUND_RGB[1];
      frameBuffer[i + 2] = inside ? ballB : BACKGROUND_RGB[2];
    }
  }
  return frameBuffer;
};

const formatTime = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const buildProgressBar = (fraction: number): string => {
  const filled = clamp(Math.round(fraction * PROGRESS_BAR_WIDTH), 0, PROGRESS_BAR_WIDTH);
  return (
    PROGRESS_FILLED_CHAR.repeat(filled) + PROGRESS_EMPTY_CHAR.repeat(PROGRESS_BAR_WIDTH - filled)
  );
};

// Guard first, before creating any Screen or rendering Ink, so the example
// exits cleanly (code 0) in a non-interactive or unsupported terminal (CI).
if (!process.stdout.isTTY || !detectKittyUnicodePlaceholderSupport()) {
  process.stderr.write(
    "ink-video-player needs an interactive Kitty or Ghostty terminal " +
      "(Unicode placeholder support).\n" +
      "Other terminals can still play video through the non-placeholder API: " +
      "see examples/embedded-panel.ts for the block-glyph fallback.\n",
  );
  process.exit(0);
}

const panelCols = Math.min((process.stdout.columns ?? MAX_PANEL_COLS) - PANEL_HORIZONTAL_MARGIN, MAX_PANEL_COLS);

// Create the Screen before rendering Ink: createScreen runs terminal probes
// that read stdin, and we want that done before Ink's useInput takes over stdin.
const screen: Screen = await createScreen({
  output: process.stdout,
  sourceWidth: SOURCE_WIDTH,
  sourceHeight: SOURCE_HEIGHT,
  colorSpace: "rgb24",
  placement: "unicode",
  embedded: true,
  region: { offsetCol: 1, offsetRow: 1, cols: panelCols, rows: PANEL_ROWS },
  autoResize: false,
  autoDispose: false,
});

const VideoPlayer = (): React.ReactElement => {
  const { exit } = useApp();
  const [playing, setPlaying] = useState(true);
  const [elapsedMs, setElapsedMs] = useState(0);

  // Placeholder rows are stable for a given grid size, so read them once.
  const [placeholderRows] = useState<string[]>(() => screen.getPlaceholderRows());

  // Refs let the once-per-frame interval read the latest state without being
  // torn down and recreated on every state change.
  const playingRef = useRef(playing);
  const elapsedRef = useRef(elapsedMs);
  playingRef.current = playing;
  elapsedRef.current = elapsedMs;

  // Push a frame for a given time and mirror the time into React state (the
  // only setState the frame path drives, so the progress bar can move).
  const showFrameAt = (nextMs: number): void => {
    elapsedRef.current = nextMs;
    screen.pushFrame(renderFrame(nextMs));
    setElapsedMs(nextMs);
  };

  // The playback loop lives in an effect, outside React's render path. It runs
  // once for the component's lifetime and clears the interval on unmount.
  useEffect(() => {
    screen.pushFrame(renderFrame(elapsedRef.current));
    const interval = setInterval(() => {
      if (!playingRef.current) {
        return;
      }
      const next = (elapsedRef.current + FRAME_INTERVAL_MS) % LOOP_MS;
      showFrameAt(next);
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      screen.dispose();
      exit();
      return;
    }
    if (input === " ") {
      setPlaying((value) => !value);
      return;
    }
    if (key.leftArrow) {
      showFrameAt(clamp(elapsedRef.current - SEEK_STEP_MS, 0, LOOP_MS));
      return;
    }
    if (key.rightArrow) {
      showFrameAt(clamp(elapsedRef.current + SEEK_STEP_MS, 0, LOOP_MS));
    }
  });

  const progress = buildProgressBar(elapsedMs / LOOP_MS);

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        kitty-motion · Ink video player
      </Text>
      <Box flexDirection="column">
        {placeholderRows.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Box>
        <Text color={playing ? "green" : "yellow"}>{playing ? "▶ playing" : "⏸ paused "}</Text>
        <Text> </Text>
        <Text>{progress}</Text>
        <Text>
          {" "}
          {formatTime(elapsedMs)} / {formatTime(LOOP_MS)}
        </Text>
      </Box>
      <Text dimColor>space pause · ←/→ seek · q quit</Text>
    </Box>
  );
};

// exitOnCtrlC: false so our useInput handler can dispose the Screen before
// Ink tears the render down.
render(<VideoPlayer />, { exitOnCtrlC: false });
