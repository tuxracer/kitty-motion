// Minimal local helpers so the package has zero runtime dependencies.
import type { TerminalProbeOptions } from './types.ts';

export * from './types.ts';

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/**
 * Switch stdin into raw flowing mode so a terminal-capability probe can read
 * the response. Returns a restore function that puts raw mode and the paused
 * state back exactly as found.
 */
export const beginRawStdinProbe = (): (() => void) => {
  const wasRaw = process.stdin.isRaw;
  const wasPaused = process.stdin.isPaused();
  process.stdin.setRawMode(true);
  if (wasPaused) {
    process.stdin.resume();
  }
  return (): void => {
    process.stdin.setRawMode(wasRaw);
    if (wasPaused) {
      process.stdin.pause();
    }
  };
};

/**
 * Run one terminal-capability probe: write a query, accumulate the raw
 * stdin response until parse() produces a result, and time out otherwise.
 * Wraps the whole exchange in beginRawStdinProbe so raw mode and the
 * paused state are restored exactly as found.
 */
export const probeTerminal = <T>(options: TerminalProbeOptions<T>): Promise<T> => {
  const { promise, resolve } = Promise.withResolvers<T>();
  let settled = false;
  let responseData = '';

  const restoreStdin = beginRawStdinProbe();

  const finish = (result: T): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    process.stdin.removeListener('data', onData);
    options.onFinish?.(result);
    restoreStdin();
    resolve(result);
  };

  const onData = (data: Buffer): void => {
    responseData += data.toString();
    const parsed = options.parse(responseData);
    if (parsed !== null) {
      finish(parsed);
    }
  };

  process.stdin.on('data', onData);
  process.stdout.write(options.query);

  const timer = setTimeout(() => finish(options.onTimeout), options.timeoutMs);

  return promise;
};
