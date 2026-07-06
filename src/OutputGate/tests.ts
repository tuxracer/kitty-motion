import { describe, it, expect } from 'vitest';
import { OutputGate } from './index.ts';
import type { DrainableStream } from './index.ts';

class FakeStream implements DrainableStream {
  written: string[] = [];
  acceptWrites = true;
  private drainListeners: Array<() => void> = [];

  write(chunk: string): boolean {
    this.written.push(chunk);
    return this.acceptWrites;
  }

  once(_event: 'drain', listener: () => void): this {
    this.drainListeners.push(listener);
    return this;
  }

  emitDrain(): void {
    const listeners = this.drainListeners;
    this.drainListeners = [];
    for (const listener of listeners) {
      listener();
    }
  }

  get drainListenerCount(): number {
    return this.drainListeners.length;
  }
}

describe('OutputGate', () => {
  it('should pass writes through while the stream accepts them', () => {
    const stream = new FakeStream();
    const gate = new OutputGate(stream);

    expect(gate.write('frame1')).toBe(true);
    expect(gate.write('frame2')).toBe(true);
    expect(stream.written).toEqual(['frame1', 'frame2']);
    expect(gate.isWritable()).toBe(true);
  });

  it('should drop writes after the stream signals backpressure', () => {
    const stream = new FakeStream();
    const gate = new OutputGate(stream);

    stream.acceptWrites = false;
    expect(gate.write('slow frame')).toBe(true); // still written, buffer now full
    expect(gate.isWritable()).toBe(false);

    expect(gate.write('dropped frame')).toBe(false);
    expect(stream.written).toEqual(['slow frame']);
  });

  it('should resume writes after the stream drains', () => {
    const stream = new FakeStream();
    const gate = new OutputGate(stream);

    stream.acceptWrites = false;
    gate.write('slow frame');
    expect(gate.isWritable()).toBe(false);

    stream.acceptWrites = true;
    stream.emitDrain();
    expect(gate.isWritable()).toBe(true);
    expect(gate.write('next frame')).toBe(true);
    expect(stream.written).toEqual(['slow frame', 'next frame']);
  });

  it('should re-block if the buffer fills again after draining', () => {
    const stream = new FakeStream();
    const gate = new OutputGate(stream);

    stream.acceptWrites = false;
    gate.write('a');
    stream.emitDrain(); // still not accepting
    gate.write('b');
    expect(gate.isWritable()).toBe(false);
    expect(gate.write('c')).toBe(false);
    expect(stream.written).toEqual(['a', 'b']);
  });

  it('should register only one drain listener per blocked period', () => {
    const stream = new FakeStream();
    const gate = new OutputGate(stream);

    stream.acceptWrites = false;
    gate.write('a');
    gate.write('b'); // dropped, must not add another listener
    gate.write('c'); // dropped
    expect(stream.drainListenerCount).toBe(1);
  });

  it('should ignore empty chunks without touching the stream', () => {
    const stream = new FakeStream();
    const gate = new OutputGate(stream);

    expect(gate.write('')).toBe(true);
    expect(stream.written).toEqual([]);
    expect(gate.isWritable()).toBe(true);
  });
});
