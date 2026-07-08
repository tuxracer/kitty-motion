/**
 * Termination signals that trigger automatic disposal. Each has a default
 * handler in Node that kills the process without running 'exit' hooks, so
 * cleanup needs an explicit listener.
 */
export const AUTO_DISPOSE_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Deflate level for screenshots (capturePng). Always the maximum (9) for the
 * smallest file, unlike the live render loop's `pngCompressionLevel`, which
 * trades compression for encode speed at 60fps. A screenshot is a one-off with
 * no frame budget, so it spends the extra CPU for a smaller PNG.
 */
export const SCREENSHOT_PNG_COMPRESSION = 9;
