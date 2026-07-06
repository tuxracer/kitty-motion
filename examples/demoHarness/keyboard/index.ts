/**
 * Raw-mode keyboard handling for the demo harness. attachKeyboard must be
 * called only after the startup capability probes finish, because the
 * probes read raw-mode stdin themselves.
 */
import { KEY_ACTIONS } from "./consts.ts";
import type { KeyAction } from "./types.ts";

export * from "./consts.ts";
export * from "./types.ts";

/** Map one raw stdin chunk to an action, or undefined for unknown keys */
export const actionForKey = (input: string): KeyAction | undefined =>
  KEY_ACTIONS[input.toLowerCase()];

/**
 * Put stdin in raw mode and dispatch keypresses to onAction. Returns a
 * detach function that restores stdin. When stdin is not a TTY (piped
 * input) no listener attaches and the returned function is a no-op.
 */
export const attachKeyboard = (onAction: (action: KeyAction) => void): (() => void) => {
  if (!process.stdin.isTTY) {
    return () => {};
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const listener = (chunk: Buffer | string): void => {
    const action = actionForKey(chunk.toString());
    if (action !== undefined) {
      onAction(action);
    }
  };
  process.stdin.on("data", listener);
  return () => {
    process.stdin.off("data", listener);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };
};
