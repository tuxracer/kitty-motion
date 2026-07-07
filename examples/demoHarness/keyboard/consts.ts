import type { KeyAction } from "./types.ts";

/** Byte raw-mode stdin delivers for Ctrl-C (raw mode swallows SIGINT) */
export const CTRL_C = "\x03";

/** Keypress dispatch table (input is lowercased before lookup) */
export const KEY_ACTIONS: Readonly<Record<string, KeyAction>> = {
  m: "cycleMode",
  e: "cycleEffect",
  p: "togglePause",
  q: "quit",
  [CTRL_C]: "quit",
};
