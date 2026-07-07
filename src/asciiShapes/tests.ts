import { describe, expect, it } from 'vitest';
import {
  ASCII_CHARS,
  ASCII_SHAPES,
  SHAPE_VECTOR_DIMS,
  createAsciiLookup,
  enhanceAsciiContrast,
  nearestAsciiChar,
} from './index.ts';

describe('ASCII_SHAPES table', () => {
  it('has 95 entries with matching ASCII_CHARS', () => {
    expect(ASCII_SHAPES.length).toBe(95);
    expect(ASCII_CHARS.length).toBe(95);
  });

  it('has a length-6 vector per entry with every component in [0,1]', () => {
    for (const shape of ASCII_SHAPES) {
      expect(shape.vector.length).toBe(SHAPE_VECTOR_DIMS);
      for (const component of shape.vector) {
        expect(component).toBeGreaterThanOrEqual(0);
        expect(component).toBeLessThanOrEqual(1);
      }
    }
  });

  it('includes an all-zero space entry', () => {
    const spaceIndex = ASCII_CHARS.indexOf(' ');
    expect(spaceIndex).toBeGreaterThanOrEqual(0);
    expect([...ASCII_SHAPES[spaceIndex].vector]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('nearestAsciiChar', () => {
  it('maps a fully dark cell to space', () => {
    const spaceIndex = ASCII_CHARS.indexOf(' ');
    expect(nearestAsciiChar([0, 0, 0, 0, 0, 0])).toBe(spaceIndex);
  });

  it('maps a bottom-heavy query to a bottom-weighted glyph', () => {
    const match = ASCII_SHAPES[nearestAsciiChar([0, 0, 0, 0, 1, 1])].vector;
    expect(match[4] + match[5]).toBeGreaterThan(match[0] + match[1]);
  });

  it('maps a top-heavy query to a top-weighted glyph', () => {
    const match = ASCII_SHAPES[nearestAsciiChar([1, 1, 0, 0, 0, 0])].vector;
    expect(match[0] + match[1]).toBeGreaterThan(match[4] + match[5]);
  });

  it('maps a forward-slash diagonal query to a matching diagonal glyph', () => {
    // top-right + bottom-left ink, like '/'
    const match = ASCII_SHAPES[nearestAsciiChar([0, 1, 0, 0, 1, 0])].vector;
    expect(match[1] + match[4]).toBeGreaterThan(match[0] + match[5]);
  });
});

describe('enhanceAsciiContrast', () => {
  it('preserves the max component, shrinks the rest, and keeps ordering', () => {
    const original = [0.2, 0.4, 0.8, 0.1, 0.3, 0.5];
    const vector = [...original];
    enhanceAsciiContrast(vector);

    const maxIndex = original.indexOf(Math.max(...original));
    expect(vector[maxIndex]).toBeCloseTo(original[maxIndex]);

    const epsilon = 1e-9;
    for (let i = 0; i < original.length; i++) {
      expect(vector[i]).toBeLessThanOrEqual(original[i] + epsilon);
    }

    // Monotonic transform, so the relative order of every pair is preserved.
    for (let i = 0; i < original.length; i++) {
      for (let j = 0; j < original.length; j++) {
        if (original[i] < original[j]) {
          expect(vector[i]).toBeLessThanOrEqual(vector[j] + epsilon);
        }
      }
    }
  });

  it('leaves an all-zero vector untouched', () => {
    const vector = [0, 0, 0, 0, 0, 0];
    enhanceAsciiContrast(vector);
    expect(vector).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('createAsciiLookup', () => {
  it('agrees with nearestAsciiChar for a deterministic set of vectors', () => {
    // Seeded LCG (numerical recipes constants) so the vectors are fixed.
    let state = 0x12345678;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };

    const { lookup } = createAsciiLookup();
    const SAMPLE_COUNT = 20;
    for (let n = 0; n < SAMPLE_COUNT; n++) {
      const vector = Array.from({ length: SHAPE_VECTOR_DIMS }, next);
      const expected = nearestAsciiChar(vector);
      // Call twice so both the cache-miss and cache-hit paths are covered.
      expect(lookup(vector)).toBe(expected);
      expect(lookup(vector)).toBe(expected);
    }
  });
});
