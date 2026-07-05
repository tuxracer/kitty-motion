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
