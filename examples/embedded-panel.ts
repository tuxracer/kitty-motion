/**
 * Embedded-panel demo: the single-compositor model. This script is the host
 * that owns the whole terminal. It draws its own chrome (a title line, a box
 * border, and a live footer clock) and hands kitty-motion a fixed `region` to
 * play video into. Because the Screen is created with `embedded: true`, the
 * library never clears the screen or toggles the global cursor, so the host
 * chrome coexists with the playing video and is never erased.
 *
 * The host draws controls OUTSIDE the video rectangle, kitty-motion owns the
 * rectangle. `setRegion` repositions the panel on a terminal resize.
 *
 * Run: node examples/embedded-panel.ts   (Ctrl-C to exit)
 *
 * A Kitty-graphics-capable terminal renders the video with the graphics
 * protocol; other terminals fall back to colored block glyphs. Set
 * EMBED_DEMO_FRAMES=<n> (or run without a TTY) to play only n frames and exit
 * cleanly, which keeps the example smoke-testable in CI.
 */
import {
  createScreen,
  getTerminalDimensions,
  buildCursorPositionSequence,
  type ScreenRegion,
} from "../src/index.ts";

// Source framebuffer the host renders into and pushes to the panel
const SOURCE_WIDTH = 160;
const SOURCE_HEIGHT = 120;

// Animation timing
const FPS = 30;
const FRAME_INTERVAL_MS = 1_000 / FPS;
const CLOCK_INTERVAL_MS = 1_000;

// Non-interactive smoke test: play this many frames then exit when stdout is
// not a TTY and EMBED_DEMO_FRAMES is unset
const DEFAULT_SMOKE_FRAMES = 60;

// Host chrome layout (all values in terminal cells)
const TITLE_ROW = 1;
// Rows reserved at the top before the border (title row plus one blank row)
const HEADER_ROWS = 2;
// Rows reserved at the bottom for the footer (label row plus clock row)
const FOOTER_ROWS = 2;
// Empty columns on each side of the border box
const SIDE_MARGIN_COLS = 4;
// Left padding for text on the title and footer lines
const TEXT_LEFT_COL = 3;

// Box-drawing characters for the border around the video region
const BORDER_TOP_LEFT = "┌";
const BORDER_TOP_RIGHT = "┐";
const BORDER_BOTTOM_LEFT = "└";
const BORDER_BOTTOM_RIGHT = "┘";
const BORDER_HORIZONTAL = "─";
const BORDER_VERTICAL = "│";

// Terminal control the host owns. The embedded Screen deliberately writes none
// of these, so the host is the only compositor touching global terminal state.
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_SCREEN = "\x1b[2J";
const ERASE_LINE = "\x1b[K";

const TITLE_TEXT = "kitty-motion · embedded panel demo";
const FOOTER_LABEL = "host chrome drawn by the example · kitty-motion owns the box above";
const QUIT_HINT = "Ctrl-C to quit";

// Bouncing-ball video content
const BALL_RADIUS = 14;
const BALL_SPEED_X = 2.1;
const BALL_SPEED_Y = 1.6;
const BACKGROUND_RGB = [12, 16, 40] as const;
const BALL_RGB = [80, 220, 255] as const;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const write = (text: string): void => {
  process.stdout.write(text);
};

// Position the cursor (1-based row and col) and write host chrome
const writeAt = (row: number, col: number, text: string): void => {
  write(buildCursorPositionSequence(row, col) + text);
};

const readSize = (): { cols: number; rows: number } => {
  const { width, height } = getTerminalDimensions();
  return { cols: width, rows: height };
};

// Center a video region inside the terminal, leaving room for the title, a
// one-cell border, and the footer. The border sits one cell outside the region.
const computeRegion = (cols: number, rows: number): ScreenRegion => {
  const borderTop = HEADER_ROWS + 1;
  const borderBottom = rows - FOOTER_ROWS;
  const borderLeft = SIDE_MARGIN_COLS + 1;
  const borderRight = cols - SIDE_MARGIN_COLS;
  return {
    offsetRow: borderTop + 1,
    offsetCol: borderLeft + 1,
    rows: Math.max(1, borderBottom - borderTop - 1),
    cols: Math.max(1, borderRight - borderLeft - 1),
  };
};

const drawBorder = (region: ScreenRegion): void => {
  const top = region.offsetRow - 1;
  const bottom = region.offsetRow + region.rows;
  const left = region.offsetCol - 1;
  const right = region.offsetCol + region.cols;
  const horizontal = BORDER_HORIZONTAL.repeat(Math.max(0, right - left - 1));
  writeAt(top, left, BORDER_TOP_LEFT + horizontal + BORDER_TOP_RIGHT);
  for (let row = top + 1; row < bottom; row++) {
    writeAt(row, left, BORDER_VERTICAL);
    writeAt(row, right, BORDER_VERTICAL);
  }
  writeAt(bottom, left, BORDER_BOTTOM_LEFT + horizontal + BORDER_BOTTOM_RIGHT);
};

// Redraw just the footer clock at its fixed row (erasing the old time first, so
// a shorter formatted time never leaves stale characters behind)
const drawFooter = (size: { cols: number; rows: number }): void => {
  const clock = timeFormatter.format(new Date());
  writeAt(size.rows, 1, ERASE_LINE);
  writeAt(size.rows, TEXT_LEFT_COL, `${clock}    ${QUIT_HINT}`);
};

// Full host chrome: clear the terminal, then draw the title, border, and footer
const drawChrome = (size: { cols: number; rows: number }, region: ScreenRegion): void => {
  write(CLEAR_SCREEN);
  writeAt(TITLE_ROW, TEXT_LEFT_COL, TITLE_TEXT);
  drawBorder(region);
  writeAt(size.rows - 1, TEXT_LEFT_COL, FOOTER_LABEL);
  drawFooter(size);
};

// Bouncing ball on a dark background, regenerated each frame
const videoFrame = new Uint8Array(SOURCE_WIDTH * SOURCE_HEIGHT * 3);
let ballX = SOURCE_WIDTH / 2;
let ballY = SOURCE_HEIGHT / 2;
let ballDX = BALL_SPEED_X;
let ballDY = BALL_SPEED_Y;

const renderVideoFrame = (): Uint8Array => {
  ballX += ballDX;
  ballY += ballDY;
  if (ballX < BALL_RADIUS || ballX > SOURCE_WIDTH - BALL_RADIUS) {
    ballDX = -ballDX;
  }
  if (ballY < BALL_RADIUS || ballY > SOURCE_HEIGHT - BALL_RADIUS) {
    ballDY = -ballDY;
  }
  for (let py = 0; py < SOURCE_HEIGHT; py++) {
    for (let px = 0; px < SOURCE_WIDTH; px++) {
      const i = (py * SOURCE_WIDTH + px) * 3;
      const inside = (px - ballX) ** 2 + (py - ballY) ** 2 <= BALL_RADIUS ** 2;
      const [r, g, b] = inside ? BALL_RGB : BACKGROUND_RGB;
      videoFrame[i] = r;
      videoFrame[i + 1] = g;
      videoFrame[i + 2] = b;
    }
  }
  return videoFrame;
};

// Frame cap: an explicit EMBED_DEMO_FRAMES wins, otherwise a non-TTY stdout
// (piped, as in CI) plays DEFAULT_SMOKE_FRAMES, and an interactive TTY runs
// until Ctrl-C
const parsedCap = process.env["EMBED_DEMO_FRAMES"]
  ? Number.parseInt(process.env["EMBED_DEMO_FRAMES"], 10)
  : Number.NaN;
let frameCap: number | undefined;
if (Number.isFinite(parsedCap) && parsedCap > 0) {
  frameCap = parsedCap;
} else if (!process.stdout.isTTY) {
  frameCap = DEFAULT_SMOKE_FRAMES;
} else {
  frameCap = undefined;
}

let terminalSize = readSize();
let region = computeRegion(terminalSize.cols, terminalSize.rows);

// The host sets up the terminal itself before creating the Screen: hide the
// cursor and clear once, then draw the chrome. The embedded Screen does none
// of this, which is what lets the chrome survive the playing video.
write(HIDE_CURSOR);
drawChrome(terminalSize, region);

const screen = await createScreen({
  output: process.stdout,
  sourceWidth: SOURCE_WIDTH,
  sourceHeight: SOURCE_HEIGHT,
  colorSpace: "rgb24",
  embedded: true,
  region,
  autoResize: false,
  autoDispose: false,
});

let stopped = false;
let frameCount = 0;

// Clean shutdown: stop the loops, remove the video non-destructively (deletes
// only this Screen's own cells), restore the cursor, and drop it below the UI
// so the shell prompt lands on a clean line. Referenced by the frame cap and
// by the SIGINT handler below; the interval it clears is assigned afterward,
// which is safe because shutdown only ever runs asynchronously.
const shutdown = (): void => {
  if (stopped) {
    return;
  }
  stopped = true;
  clearInterval(animationInterval);
  clearInterval(clockInterval);
  screen.dispose();
  write(SHOW_CURSOR);
  writeAt(terminalSize.rows, 1, "\n");
  process.exit(0);
};

const animationInterval = setInterval(() => {
  screen.pushFrame(renderVideoFrame());
  frameCount++;
  if (frameCap !== undefined && frameCount >= frameCap) {
    shutdown();
  }
}, FRAME_INTERVAL_MS);

// Prove the host chrome coexists with the video: refresh the clock once a
// second at its fixed footer row while the video keeps playing above it
const clockInterval = setInterval(() => {
  drawFooter(terminalSize);
}, CLOCK_INTERVAL_MS);

// Host owns resize: recompute the region, hand it to the Screen, and redraw the
// chrome so the border tracks the new panel size
process.on("SIGWINCH", () => {
  terminalSize = readSize();
  region = computeRegion(terminalSize.cols, terminalSize.rows);
  screen.setRegion(region);
  drawChrome(terminalSize, region);
});

process.on("SIGINT", shutdown);
