/**
 * Status bar for the demo harness: a pure formatter plus a draw call that
 * writes one dim line at a given terminal row. Writes go straight
 * to process.stdout, bypassing the harness's byte-counting wrapper, so
 * status bar chrome never pollutes the frame throughput metrics.
 */
import { styleText } from "node:util";
import { buildCursorPositionSequence } from "../../../src/index.ts";
import { CLEAR_LINE, FIELD_SEPARATOR, SHORTCUT_HINTS } from "./consts.ts";
import type { StatusBarState } from "./types.ts";

export * from "./consts.ts";
export * from "./types.ts";

/** Build the single-line status bar text, truncated to maxWidth cells */
export const formatStatusBar = (state: StatusBarState, maxWidth: number): string => {
  const text = [
    state.demoName,
    state.paused ? "paused" : `${state.fps} fps`,
    state.modeLabel,
    `fx: ${state.effectName}`,
    SHORTCUT_HINTS,
  ].join(FIELD_SEPARATOR);
  return text.length > maxWidth ? text.slice(0, maxWidth) : text;
};

/**
 * Draw the status bar text in dim text at the given 1-based row. styleText
 * emits the dim attribute (and its reset) only when stdout supports color,
 * so piped output and NO_COLOR get plain text automatically.
 */
export const drawStatusBar = (row: number, text: string): void => {
  process.stdout.write(buildCursorPositionSequence(row, 1) + CLEAR_LINE + styleText("dim", text));
};
