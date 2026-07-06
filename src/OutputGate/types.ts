// Minimal writable-stream surface the gate needs (satisfied by process.stdout)
export interface DrainableStream {
  write(chunk: string): boolean;
  once(event: 'drain', listener: () => void): unknown;
}
