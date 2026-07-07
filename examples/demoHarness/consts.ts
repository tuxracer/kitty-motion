import type { ScreenUpdatableOptions } from "../../src/index.ts";
import type { EffectPreset, ModeCycleEntry } from "./types.ts";

/** Tick rate when a demo does not specify fps */
export const DEFAULT_FPS = 60;

/** How often the status bar resamples the transmitted framerate */
export const FPS_SAMPLE_INTERVAL_MS = 500;

/** Status bar width when process.stdout.columns is unavailable */
export const FALLBACK_TERMINAL_COLS = 80;

/**
 * Every effect-related option at its library default. Presets are applied
 * over this so switching presets never leaves a previous preset's values
 * behind.
 */
export const EFFECT_RESET: Partial<ScreenUpdatableOptions> = {
  gamma: 1.0,
  scanlines: 0,
  saturation: 1.0,
  brightness: 1.0,
  contrast: 1.0,
  vignette: 0,
  bloom: 0,
  bloomThreshold: 0.6,
  ntsc: 0,
  curvature: 0,
  chromaticAberration: 0,
  colorEnabled: true,
};

/** Presets cycled by the "e" shortcut, in order */
export const EFFECT_PRESETS: readonly EffectPreset[] = [
  { name: "none", options: {} },
  { name: "scanlines", options: { scanlines: 0.35 } },
  {
    name: "crt",
    options: { scanlines: 0.3, curvature: 0.15, vignette: 0.25, bloom: 0.3, gamma: 1.2 },
  },
  { name: "ntsc", options: { ntsc: 0.7 } },
  { name: "grayscale", options: { colorEnabled: false } },
];

/** Display states cycled by the "m" shortcut, in order */
export const MODE_CYCLE: readonly ModeCycleEntry[] = [
  { label: "kitty", renderMode: "kitty", limitColors: 0 },
  { label: "half-block truecolor", renderMode: "half-block", limitColors: 0 },
  { label: "half-block 256", renderMode: "half-block", limitColors: 256 },
  { label: "half-block 16", renderMode: "half-block", limitColors: 16 },
  { label: "cell-background truecolor", renderMode: "cell-background", limitColors: 0 },
  { label: "cell-background 256", renderMode: "cell-background", limitColors: 256 },
  { label: "cell-background 16", renderMode: "cell-background", limitColors: 16 },
  { label: "emoji", renderMode: "emoji", limitColors: 0 },
  { label: "ascii", renderMode: "ascii", limitColors: 0 },
];
