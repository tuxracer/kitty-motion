import type {
  ColorDepth,
  FrameBuffer,
  RenderMode,
  ScreenOptions,
  ScreenUpdatableOptions,
} from "../../src/index.ts";

/** Utilities the harness hands to a demo's renderFrame callback */
export interface DemoContext {
  /** Append a timestamped line to the demo's log file */
  log: (message: string) => void;
}

/** Per-demo configuration for runDemo */
export interface Demo {
  /** Names the log file (<name>.log) and the exit-summary headings */
  name: string;
  /** Tick rate in frames per second (default: 60) */
  fps?: number;
  /** Screen options; output and onDebug come from the harness, which also adds one reserved row for its status bar */
  screen: Omit<ScreenOptions, "output" | "onDebug">;
  /** Produce the frame for one tick; called only when the output can accept a frame */
  renderFrame: (tick: number, context: DemoContext) => FrameBuffer;
}

/** One entry in the render-mode cycle the "m" shortcut steps through */
export interface ModeCycleEntry {
  /** Status bar label: the library renderMode value plus color depth, e.g. "half-block 256" */
  label: string;
  /** The library renderMode this entry selects */
  renderMode: RenderMode;
  /** Cell-mode SGR depth (ignored by the kitty entry) */
  limitColors: ColorDepth;
}

/** A named bundle of effect options the "e" shortcut steps through */
export interface EffectPreset {
  /** Status bar label, e.g. "crt" */
  name: string;
  /** Options applied over EFFECT_RESET when the preset activates */
  options: Partial<ScreenUpdatableOptions>;
}
