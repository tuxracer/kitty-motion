import type { DrainableStream } from './types.ts';

export * from './types.ts';

// Backpressure-aware wrapper around a writable stream (process.stdout).
// When a write overflows the stream's buffer, the gate reports unwritable
// and drops further writes until the stream drains: on a slow terminal,
// SSH link, or pipe, frames are dropped instead of queueing unboundedly.
export class OutputGate {
  private isBlocked = false;
  private readonly stream: DrainableStream;

  constructor(stream: DrainableStream) {
    this.stream = stream;
  }

  isWritable(): boolean {
    return !this.isBlocked;
  }

  // Returns true if the chunk was handed to the stream, false if dropped.
  write(chunk: string): boolean {
    if (this.isBlocked) {
      return false;
    }
    if (chunk.length === 0) {
      return true;
    }
    if (!this.stream.write(chunk)) {
      this.isBlocked = true;
      this.stream.once('drain', () => {
        this.isBlocked = false;
      });
    }
    return true;
  }
}
