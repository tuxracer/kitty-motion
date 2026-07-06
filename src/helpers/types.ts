/** One terminal-capability probe exchange (see probeTerminal) */
export interface TerminalProbeOptions<T> {
  /** Escape sequence written to stdout to trigger the terminal's response */
  query: string;
  /** Parse accumulated response data; null means keep waiting */
  parse: (response: string) => T | null;
  /** How long to wait for a complete response */
  timeoutMs: number;
  /** Value resolved when the timeout fires without a complete response */
  onTimeout: T;
  /** Cleanup that must run after settling but before stdin is restored */
  onFinish?: (result: T) => void;
}
