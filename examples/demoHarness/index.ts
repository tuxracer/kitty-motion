/**
 * Shared harness for kitty-motion demos: terminal capability detection,
 * a timestamped debug log (<name>.log with renderer diagnostics and
 * per-write payload sizes), byte counting on stdout, resize handling, an
 * interactive status bar (transmitted fps, render mode, effect preset,
 * with "m"/"g"/"e"/"p" shortcuts to cycle render modes, toggle the cell
 * glyph strategy, cycle effect presets, and toggle pause, and "q" or
 * Ctrl-C to quit), and a config plus metrics summary printed to the
 * console on exit.
 *
 * A demo supplies its name, screen options, and a renderFrame callback;
 * see bouncing-ball.ts for the smallest complete example. Effect options
 * a demo passes in its screen config apply until the user first presses
 * "e", after which the harness preset list takes over.
 */
import { createWriteStream } from "node:fs";
import {
  Screen,
  detectKittyGraphicsSupport,
  detectKittyAnimationSupport,
  detectKittyFileTransferSupport,
  detectCellPixelSize,
  detectCellGlyphMode,
  detectCellSampling,
  isSSHSession,
  isMultiplexedSession,
  type CellGlyphMode,
  type CellSampling,
  type ColorDepth,
  type DrainableStream,
  type RenderMode,
} from "../../src/index.ts";
import { formatStatusBar, drawStatusBar } from "./statusBar/index.ts";
import { attachKeyboard } from "./keyboard/index.ts";
import {
  DEFAULT_FPS,
  EFFECT_PRESETS,
  EFFECT_RESET,
  FALLBACK_TERMINAL_COLS,
  FPS_SAMPLE_INTERVAL_MS,
  MODE_CYCLE,
} from "./consts.ts";
import type { Demo, DemoContext } from "./types.ts";

export * from "./consts.ts";
export * from "./types.ts";

// DEMO_* boolean overrides: "0" and "false" disable, any other value enables
const envFlagEnabled = (value: string): boolean => value !== "0" && value !== "false";

export const runDemo = async (demo: Demo): Promise<void> => {
  // DEMO_RENDER_MODE=cell forces the block-glyph fallback (even on Kitty
  // terminals), DEMO_RENDER_MODE=kitty forces the graphics protocol; unset
  // follows the graphics probe. Other values are ignored
  const renderModeEnv = process.env["DEMO_RENDER_MODE"];
  const renderModeOverride: { renderMode?: RenderMode } =
    renderModeEnv === "kitty" || renderModeEnv === "cell" ? { renderMode: renderModeEnv } : {};

  // Startup queries (sequential: each reads raw-mode stdin). On terminals
  // without Kitty graphics, Screen falls back to the block-glyph cell
  // renderer, and the animation and file probes are skipped because they
  // would write Kitty escapes the terminal cannot parse. They still run when
  // DEMO_RENDER_MODE=cell forces a cell-mode start, because the "m" shortcut
  // can cycle the render mode into kitty at runtime, and the cached probe
  // results need to already be populated when that happens.
  const graphicsSupported = await detectKittyGraphicsSupport();
  const animationSupported = graphicsSupported ? await detectKittyAnimationSupport() : false;
  const cellPixelSize = await detectCellPixelSize();
  const fileTransferSupported = graphicsSupported ? await detectKittyFileTransferSupport() : false;

  const startedAt = performance.now();
  const logFile = `${demo.name}.log`;
  const log = createWriteStream(logFile);
  const logLine = (message: string): void => {
    const elapsedMs = (performance.now() - startedAt).toFixed(1).padStart(9);
    log.write(`[+${elapsedMs}ms] ${message}\n`);
  };

  const stats = {
    ticks: 0,
    stalls: 0,
    writes: 0,
    bytes: 0,
    fullFrames: 0,
    deltaFrames: 0,
    skippedFrames: 0,
    modeSwitches: 0,
    glyphSwitches: 0,
    effectSwitches: 0,
  };

  // Wrap stdout to measure exactly what goes down the pty. Payloads are
  // escape sequences and base64, all ASCII, so string length equals bytes.
  // Status bar writes bypass this wrapper on purpose (see statusBar/)
  const countingStdout: DrainableStream = {
    write: (chunk: string): boolean => {
      stats.writes++;
      stats.bytes += chunk.length;
      logLine(`write ${chunk.length} bytes`);
      return process.stdout.write(chunk);
    },
    once: (event: "drain", listener: () => void): void => {
      process.stdout.once(event, listener);
    },
  };

  // The renderer reports its effective settings (scale, scaled size, display
  // grid, color space, compression, diff rendering) through Init: lines;
  // keep them for the exit summary instead of duplicating library defaults
  const rendererInitLines: string[] = [];

  // DEMO_DIRTY_RECTS=0 (or false) force-disables dirty-rect deltas for any
  // demo, DEMO_DIRTY_RECTS=1 forces them on; unset leaves the demo's own
  // setting (or the probe) in charge. Useful for A/B throughput comparisons
  const dirtyRectsEnv = process.env["DEMO_DIRTY_RECTS"];
  const dirtyRectsOverride =
    dirtyRectsEnv === undefined ? {} : { dirtyRects: envFlagEnabled(dirtyRectsEnv) };

  // DEMO_FILE_TRANSFER=0 (or false) force-disables file-based transmission,
  // DEMO_FILE_TRANSFER=1 forces it on; unset follows the probe
  const fileTransferEnv = process.env["DEMO_FILE_TRANSFER"];
  const fileTransferOverride =
    fileTransferEnv === undefined ? {} : { fileTransfer: envFlagEnabled(fileTransferEnv) };

  // DEMO_LIMIT_COLORS=0 (truecolor), 256, or 16 pins the cell-mode SGR color
  // depth; unset auto-detects from COLORTERM/TERM. Ignored in kitty mode
  const limitColorsEnv = process.env["DEMO_LIMIT_COLORS"];
  const limitColorsOverride: { limitColors?: ColorDepth } =
    limitColorsEnv === "0"
      ? { limitColors: 0 }
      : limitColorsEnv === "16"
        ? { limitColors: 16 }
        : limitColorsEnv === "256"
          ? { limitColors: 256 }
          : {};

  // DEMO_CELL_GLYPH=half-block or background pins the cell glyph strategy.
  // Unset auto-detects from TERM_PROGRAM (Terminal.app gets background,
  // because its font-drawn block glyphs do not tile the cell). Ignored in
  // kitty mode
  const cellGlyphEnv = process.env["DEMO_CELL_GLYPH"];
  const cellGlyphOverride: { cellGlyphMode?: CellGlyphMode } =
    cellGlyphEnv === "half-block" || cellGlyphEnv === "background"
      ? { cellGlyphMode: cellGlyphEnv }
      : {};
  let glyphMode: CellGlyphMode = cellGlyphOverride.cellGlyphMode ?? detectCellGlyphMode();

  // DEMO_CELL_SAMPLING=box or nearest pins the cell downsampling strategy.
  // Unset auto-detects from TERM_PROGRAM (Terminal.app gets nearest, keeping
  // hard edges solid at its one pixel per cell). Ignored in kitty mode
  const cellSamplingEnv = process.env["DEMO_CELL_SAMPLING"];
  const cellSamplingOverride: { cellSampling?: CellSampling } =
    cellSamplingEnv === "box" || cellSamplingEnv === "nearest"
      ? { cellSampling: cellSamplingEnv }
      : {};

  const screen = new Screen({
    ...demo.screen,
    // One extra row below the image stays free for the harness status bar
    reservedRows: (demo.screen.reservedRows ?? 0) + 1,
    ...dirtyRectsOverride,
    ...fileTransferOverride,
    ...renderModeOverride,
    ...limitColorsOverride,
    ...cellGlyphOverride,
    ...cellSamplingOverride,
    output: countingStdout,
    // Tally frame outcomes from the renderer's own diagnostics
    onDebug: (message) => {
      logLine(message);
      if (message.startsWith("Init:")) {
        rendererInitLines.push(message.slice("Init: ".length));
      } else if (message.includes(": full,")) {
        stats.fullFrames++;
      } else if (message.includes(": delta,") || message.includes(": diff,")) {
        stats.deltaFrames++;
      } else if (message.includes("SKIPPED")) {
        stats.skippedFrames++;
      }
    },
  });

  // One stack owns every teardown, so shutdown is a single dispose() call and
  // each resource registers its cleanup at the site where it is created
  // (disposed LIFO). screen already implements [Symbol.dispose], so use() it.
  const cleanup = new DisposableStack();
  cleanup.use(screen);

  const sessionStatus = isSSHSession() ? "ssh (SSH_* variables set)" : "local (no SSH_* variables)";

  // A multiplexer intercepts graphics escapes (tmux needs allow-passthrough)
  // while the KITTY_WINDOW_ID fast path still reports graphics support, so
  // name the multiplexer when one is detected
  const multiplexerStatus = !isMultiplexedSession()
    ? "none (running directly)"
    : process.env["TMUX"]
      ? "tmux (TMUX set)"
      : process.env["STY"]
        ? "screen (STY set)"
        : `possibly present (TERM=${process.env["TERM"] ?? ""}, variables absent)`;

  const dirtyRectsStatus =
    dirtyRectsEnv !== undefined
      ? `forced ${envFlagEnabled(dirtyRectsEnv) ? "on" : "off"} (DEMO_DIRTY_RECTS=${dirtyRectsEnv})`
      : animationSupported
        ? "enabled (animation probe: supported)"
        : "disabled (animation probe: unsupported), sending full frames";
  const fileTransferStatus =
    fileTransferEnv !== undefined
      ? `forced ${envFlagEnabled(fileTransferEnv) ? "on" : "off"} (DEMO_FILE_TRANSFER=${fileTransferEnv})`
      : fileTransferSupported
        ? "enabled (file probe: shared filesystem)"
        : "disabled (file probe: unsupported), streaming escapes";
  const cellGlyphStatus =
    cellGlyphOverride.cellGlyphMode !== undefined
      ? `forced ${cellGlyphOverride.cellGlyphMode} (DEMO_CELL_GLYPH=${cellGlyphEnv})`
      : `${glyphMode} (auto-detected from TERM_PROGRAM)`;
  const cellSamplingStatus =
    cellSamplingOverride.cellSampling !== undefined
      ? `forced ${cellSamplingOverride.cellSampling} (DEMO_CELL_SAMPLING=${cellSamplingEnv})`
      : `${detectCellSampling()} (auto-detected from TERM_PROGRAM)`;
  const { cols, rows } = screen.getDisplaySize();

  const renderModeForced = renderModeEnv === "kitty" || renderModeEnv === "cell";
  const renderModeStatus =
    screen.getRenderMode() === "kitty"
      ? `kitty (graphics protocol${renderModeForced ? `, forced by DEMO_RENDER_MODE=${renderModeEnv}` : ""})`
      : `cell (block-glyph fallback, ${renderModeForced ? `forced by DEMO_RENDER_MODE=${renderModeEnv}` : "no Kitty graphics support"})`;

  // Startup configuration block, for the log and the exit summary
  logLine(`env TERM=${process.env["TERM"] ?? "(unset)"} KITTY_WINDOW_ID=${process.env["KITTY_WINDOW_ID"] ? "set" : "unset"}`);
  logLine(`session ${sessionStatus}`);
  logLine(`multiplexer ${multiplexerStatus}`);
  logLine(`render mode ${renderModeStatus}`);
  logLine(`probe animationSupport=${String(animationSupported)}`);
  logLine(`probe cellPixelSize=${cellPixelSize ? `${cellPixelSize.width}x${cellPixelSize.height}px` : "not reported, using fallback ratio"}`);
  logLine(`options ${JSON.stringify(demo.screen)} fps=${demo.fps ?? DEFAULT_FPS} (unset options: library defaults)`);
  logLine(`dirty rects ${dirtyRectsStatus}`);
  logLine(`file transfer ${fileTransferStatus}`);
  logLine(`cell glyph ${cellGlyphStatus}`);
  logLine(`cell sampling ${cellSamplingStatus}`);
  logLine(`display ${cols}x${rows} cells, status row ${screen.getStatusRow()}`);

  // Mode cycle: drop the kitty entry when the terminal cannot parse kitty
  // graphics escapes, unless DEMO_RENDER_MODE forced kitty anyway
  const kittyAvailable = graphicsSupported || renderModeEnv === "kitty";
  const modeCycle = kittyAvailable
    ? MODE_CYCLE
    : MODE_CYCLE.filter((entry) => entry.renderMode !== "kitty");

  const initialDepth = limitColorsOverride.limitColors ?? 0;
  const initialModeIndex = modeCycle.findIndex((entry) =>
    screen.getRenderMode() === "kitty"
      ? entry.renderMode === "kitty"
      : entry.renderMode === "cell" && entry.limitColors === initialDepth,
  );
  let modeIndex = initialModeIndex === -1 ? 0 : initialModeIndex;
  // Auto-detected cell depth occupies the truecolor slot but keeps a
  // distinct label until the first cycle pins an explicit depth
  let modeLabel =
    screen.getRenderMode() === "cell" && limitColorsOverride.limitColors === undefined
      ? "cell (auto)"
      : modeCycle[modeIndex].label;

  let effectIndex = 0;
  let fps = 0;
  let paused = false;
  let lastStatusText = "";
  const redrawStatusBar = (force: boolean): void => {
    const text = formatStatusBar(
      {
        demoName: demo.name,
        fps,
        paused,
        modeLabel: screen.getRenderMode() === "cell" ? `${modeLabel} · ${glyphMode === "background" ? "bg" : "half"}` : modeLabel,
        effectName: EFFECT_PRESETS[effectIndex].name,
      },
      process.stdout.columns ?? FALLBACK_TERMINAL_COLS,
    );
    if (!force && text === lastStatusText) {
      return;
    }
    lastStatusText = text;
    drawStatusBar(screen.getStatusRow(), text);
  };

  const cycleMode = (): void => {
    modeIndex = (modeIndex + 1) % modeCycle.length;
    const entry = modeCycle[modeIndex];
    modeLabel = entry.label;
    stats.modeSwitches++;
    screen.updateOptions({ renderMode: entry.renderMode, limitColors: entry.limitColors });
    logLine(`mode switch -> ${entry.label}`);
    redrawStatusBar(true);
  };

  const cycleEffect = (): void => {
    effectIndex = (effectIndex + 1) % EFFECT_PRESETS.length;
    const preset = EFFECT_PRESETS[effectIndex];
    stats.effectSwitches++;
    screen.updateOptions({ ...EFFECT_RESET, ...preset.options });
    logLine(`effect switch -> ${preset.name}`);
    redrawStatusBar(true);
  };

  const toggleGlyphMode = (): void => {
    // cellGlyphMode only affects the cell renderer (no rebuild needed in kitty mode)
    if (screen.getRenderMode() !== "cell") {
      logLine("glyph toggle ignored (kitty mode)");
      return;
    }
    glyphMode = glyphMode === "half-block" ? "background" : "half-block";
    stats.glyphSwitches++;
    screen.updateOptions({ cellGlyphMode: glyphMode });
    logLine(`glyph switch -> ${glyphMode}`);
    redrawStatusBar(true);
  };

  const togglePause = (): void => {
    paused = !paused;
    logLine(`pause -> ${paused ? "on" : "off"}`);
    redrawStatusBar(true);
  };

  const context: DemoContext = { log: logLine };

  // Paused ticks do nothing at all (no tick count, no stall count), so the
  // animation resumes exactly where it left off
  const tick = (): void => {
    if (paused) {
      return;
    }
    stats.ticks++;
    if (!screen.isWritable()) {
      stats.stalls++;
      return;
    }
    screen.pushFrame(demo.renderFrame(stats.ticks - 1, context));
  };

  const printSummary = (): void => {
    const seconds = (performance.now() - startedAt) / 1_000;
    const transmits = stats.fullFrames + stats.deltaFrames;
    const count = new Intl.NumberFormat("en-US");
    const kb = (bytes: number): string => count.format(Math.round(bytes / 1_024));
    console.log(`${demo.name} demo config`);
    console.log(`  session        ${sessionStatus}`);
    console.log(`  multiplexer    ${multiplexerStatus}`);
    console.log(`  render mode    ${renderModeStatus}`);
    console.log(`  dirty rects    ${dirtyRectsStatus}`);
    console.log(`  file transfer  ${fileTransferStatus}`);
    console.log(`  cell glyph     ${cellGlyphStatus}`);
    console.log(`  cell sampling  ${cellSamplingStatus}`);
    console.log(`  cell size      ${cellPixelSize ? `${cellPixelSize.width}x${cellPixelSize.height}px (terminal-reported)` : "not reported, fallback ratio used"}`);
    console.log(`  display        ${cols}x${rows} cells`);
    for (const line of rendererInitLines) {
      console.log(`  renderer       ${line}`);
    }
    console.log(`${demo.name} demo stats`);
    console.log(`  runtime        ${seconds.toFixed(1)}s`);
    console.log(`  ticks          ${count.format(stats.ticks)} (${(stats.ticks / seconds).toFixed(1)}/s)`);
    console.log(`  transmits      ${count.format(transmits)} (${stats.fullFrames} full, ${stats.deltaFrames} delta/diff)`);
    console.log(`  skipped        ${count.format(stats.skippedFrames)} identical frames`);
    console.log(`  stalls         ${count.format(stats.stalls)} ticks dropped to backpressure`);
    console.log(`  bytes written  ${count.format(stats.bytes)} across ${count.format(stats.writes)} writes`);
    if (transmits > 0) {
      console.log(`  throughput     ${kb(stats.bytes / transmits)} KB/transmit avg, ${kb(stats.bytes / seconds)} KB/s`);
    }
    console.log(`  mode switches  ${count.format(stats.modeSwitches)} (final mode: ${modeLabel})`);
    console.log(`  glyph switches ${count.format(stats.glyphSwitches)} (final glyph: ${glyphMode})`);
    console.log(`  effects        ${count.format(stats.effectSwitches)} switches (final preset: ${EFFECT_PRESETS[effectIndex].name})`);
    console.log(`  log            ./${logFile}`);
  };

  const interval = setInterval(tick, 1_000 / (demo.fps ?? DEFAULT_FPS));
  cleanup.defer(() => clearInterval(interval));

  // Transmitted fps: frames actually written (full + delta), excluding
  // backpressure stalls and skipped identical frames
  let lastSampleAt = performance.now();
  let lastTransmits = 0;
  const fpsSampler = setInterval(() => {
    const now = performance.now();
    const transmits = stats.fullFrames + stats.deltaFrames;
    const elapsedSeconds = (now - lastSampleAt) / 1_000;
    fps = Math.round((transmits - lastTransmits) / elapsedSeconds);
    lastSampleAt = now;
    lastTransmits = transmits;
    redrawStatusBar(false);
  }, FPS_SAMPLE_INTERVAL_MS);
  cleanup.defer(() => clearInterval(fpsSampler));

  // Reads the latest detachKeyboard on dispose (it is reassigned below)
  let detachKeyboard: () => void = () => {};
  cleanup.defer(() => detachKeyboard());
  const shutdown = (): void => {
    cleanup.dispose();
    logLine("shutdown");
    log.end(() => {
      printSummary();
      process.exit(0);
    });
  };

  // Attach after the probes above: they read raw-mode stdin themselves
  detachKeyboard = attachKeyboard((action) => {
    if (action === "cycleMode") {
      cycleMode();
    } else if (action === "cycleGlyph") {
      toggleGlyphMode();
    } else if (action === "cycleEffect") {
      cycleEffect();
    } else if (action === "togglePause") {
      togglePause();
    } else {
      shutdown();
    }
  });
  process.on("SIGINT", shutdown);
  // The screen recomputes its own layout on SIGWINCH (its listener was
  // registered first, at construction), so by the time this runs
  // getStatusRow() reflects the new size
  process.on("SIGWINCH", () => {
    redrawStatusBar(true);
  });
  redrawStatusBar(true);
};
