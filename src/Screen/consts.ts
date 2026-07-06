/**
 * Termination signals that trigger automatic disposal. Each has a default
 * handler in Node that kills the process without running 'exit' hooks, so
 * cleanup needs an explicit listener.
 */
export const AUTO_DISPOSE_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
