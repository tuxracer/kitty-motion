/** Default terminal width in columns */
export const DEFAULT_TERMINAL_WIDTH = 80;

/** Default terminal height in rows */
export const DEFAULT_TERMINAL_HEIGHT = 24;

/**
 * Terminal query for the character cell size in pixels.
 * Sends CSI 16 t (report cell size directly) followed by CSI 14 t (report
 * text-area size in pixels). We parse whichever the terminal answers, so a
 * terminal that supports only one still works.
 */
export const CELL_SIZE_QUERY = '\x1b[16t\x1b[14t';

/** Timeout in milliseconds to wait for the cell-size query response */
export const CELL_SIZE_DETECT_TIMEOUT_MS = 100;

/** Lower/upper sanity bounds (px) for a reported terminal cell dimension */
export const MIN_SANE_CELL_PX = 1;
export const MAX_SANE_CELL_PX = 200;

/** Variables sshd sets in the environment of interactive sessions */
export const SSH_ENV_VARS = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'] as const;

/** Variables tmux (TMUX) and GNU screen (STY) set inside their sessions */
export const MULTIPLEXER_ENV_VARS = ['TMUX', 'STY'] as const;

/** TERM prefixes multiplexers advertise (tmux-256color, screen-256color) */
export const MULTIPLEXER_TERM_PREFIXES = ['tmux', 'screen'] as const;

/** SGR color depth: truecolor support */
export const COLOR_DEPTH_TRUECOLOR = 0;

/** SGR color depth: 256-color palette */
export const COLOR_DEPTH_256 = 256;

/** SGR color depth: basic 16-color palette */
export const COLOR_DEPTH_16 = 16;

/** TERM_PROGRAM value Terminal.app sets */
export const TERM_PROGRAM_APPLE_TERMINAL = 'Apple_Terminal';
