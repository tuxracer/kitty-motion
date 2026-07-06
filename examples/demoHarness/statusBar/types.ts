/** Everything formatStatusBar needs to render one status line */
export interface StatusBarState {
  /** Demo name shown at the left edge */
  demoName: string;
  /** Transmitted frames per second, already rounded */
  fps: number;
  /** When true, the fps field renders as "paused" */
  paused: boolean;
  /** Render mode label, e.g. "kitty" or "cell 256" */
  modeLabel: string;
  /** Active effect preset name, e.g. "none" */
  effectName: string;
}
