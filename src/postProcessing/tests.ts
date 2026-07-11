import { describe, expect, it } from 'vitest';
import { PostProcessingPipeline } from './index.ts';

const makeFrame = (w: number, h: number): Uint8Array => {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < rgb.length; i++) {rgb[i] = (i * 37) % 256;}
  return rgb;
};

describe('PostProcessingPipeline', () => {
  it('is a no-op when no effects are configured', () => {
    const rgb = makeFrame(16, 16);
    const before = new Uint8Array(rgb);
    new PostProcessingPipeline({}).apply(rgb, 16, 16);
    expect(rgb).toEqual(before);
  });

  it('scanlines darken alternating rows', () => {
    const w = 8, h = 8;
    const rgb = new Uint8Array(w * h * 3).fill(200);
    new PostProcessingPipeline({ scanlines: 0.5 }).apply(rgb, w, h);
    const row0 = rgb[0];
    const row1 = rgb[w * 3];
    expect(row0).not.toBe(row1); // one of the rows is darkened
    // Odd rows (y=1,3,5,...) are the ones darkened; even rows (including row 0)
    // are left untouched (the scanline loop runs `for (let y = 1; y < height; y += 2)`).
    expect(row0).toBe(200);
    expect(row1).toBe(100); // (200 * ((1 - 0.5) * 256 | 0)) >> 8 = (200 * 128) >> 8 = 100
  });

  it('is deterministic across two identical frames', () => {
    const pipeline = new PostProcessingPipeline({ vignette: 0.4, scanlines: 0.3 });
    const a = makeFrame(12, 12);
    const b = makeFrame(12, 12);
    pipeline.apply(a, 12, 12);
    pipeline.apply(b, 12, 12);
    expect(a).toEqual(b);
  });

  it('rect-bounded apply on a changed region matches a full-frame apply', () => {
    // Mirrors how the renderers use rects: keep a processed buffer across
    // frames, patch only the changed raw pixels, and re-apply within the rect
    const w = 16, h = 16;
    const options = { gamma: 1.3, scanlines: 0.3, vignette: 0.4, brightness: 1.1, saturation: 0.8 };
    const rect = { x: 5, y: 6, width: 4, height: 3 };

    const frame0 = makeFrame(w, h);
    const frame1 = new Uint8Array(frame0);
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const i = (y * w + x) * 3;
        frame1[i] = 250;
        frame1[i + 1] = 10;
        frame1[i + 2] = 123;
      }
    }

    const incremental = new Uint8Array(frame0);
    const pipeline = new PostProcessingPipeline(options);
    pipeline.apply(incremental, w, h);
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      const start = (y * w + rect.x) * 3;
      incremental.set(frame1.subarray(start, start + rect.width * 3), start);
    }
    pipeline.apply(incremental, w, h, rect);

    const reference = new Uint8Array(frame1);
    new PostProcessingPipeline(options).apply(reference, w, h);

    expect(incremental).toEqual(reference);
  });

  it('processes the full frame despite a rect while a non-local effect is enabled', () => {
    const w = 16, h = 16;
    const options = { bloom: 0.5, vignette: 0.3, scanlines: 0.2 };
    const withRect = makeFrame(w, h);
    const withoutRect = makeFrame(w, h);
    new PostProcessingPipeline(options).apply(withRect, w, h, { x: 2, y: 2, width: 3, height: 3 });
    new PostProcessingPipeline(options).apply(withoutRect, w, h);
    expect(withRect).toEqual(withoutRect);
  });

  it('reports non-local effects only for blur, distortion, and resampling effects', () => {
    // Pointwise effects keep dirty rects valid
    expect(new PostProcessingPipeline().hasNonLocalEffects()).toBe(false);
    expect(new PostProcessingPipeline({ scanlines: 0.5, vignette: 0.3, gamma: 1.2 }).hasNonLocalEffects()).toBe(false);
    expect(new PostProcessingPipeline({ brightness: 1.2, contrast: 1.1, saturation: 0.9 }).hasNonLocalEffects()).toBe(false);

    // Effects that spread a pixel's influence require full-frame damage
    expect(new PostProcessingPipeline({ bloom: 0.4 }).hasNonLocalEffects()).toBe(true);
    expect(new PostProcessingPipeline({ ntsc: 0.5 }).hasNonLocalEffects()).toBe(true);
    expect(new PostProcessingPipeline({ curvature: 0.2 }).hasNonLocalEffects()).toBe(true);
    expect(new PostProcessingPipeline({ chromaticAberration: 0.3 }).hasNonLocalEffects()).toBe(true);
  });

  describe('color adjustments', () => {
    const applyTo = (
      options: { brightness?: number; contrast?: number; saturation?: number },
      pixel: [number, number, number],
    ): number[] => {
      const rgb = new Uint8Array(pixel);
      new PostProcessingPipeline(options).apply(rgb, 1, 1);
      return Array.from(rgb);
    };

    it('scales channels by brightness and clamps at 255', () => {
      expect(applyTo({ brightness: 1.5 }, [100, 150, 200])).toEqual([150, 225, 255]);
    });

    it('stretches around the midpoint for contrast', () => {
      expect(applyTo({ contrast: 0.5 }, [100, 150, 200])).toEqual([114, 139, 164]);
      expect(applyTo({ contrast: 2.0 }, [100, 150, 200])).toEqual([72, 172, 255]);
    });

    it('desaturates to BT.601 luminance at saturation 0', () => {
      // gray = 0.299*100 + 0.587*150 + 0.114*200 = 140.75, truncated to 140
      expect(applyTo({ saturation: 0 }, [100, 150, 200])).toEqual([140, 140, 140]);
    });

    it('applies brightness, contrast, then saturation in order on unclamped values', () => {
      // [100,150,200] -> brightness 1.5 -> [150,225,300]
      // -> contrast 2 -> [172,322,472] (unclamped intermediates)
      // -> gray = 294.25, saturation 0.5 -> [233.125, 308.125, 383.125]
      // -> clamped and truncated -> [233, 255, 255]
      expect(
        applyTo({ brightness: 1.5, contrast: 2.0, saturation: 0.5 }, [100, 150, 200]),
      ).toEqual([233, 255, 255]);
    });
  });
});

describe('effect reach', () => {
  it('is zero for pointwise-only pipelines', () => {
    const p = new PostProcessingPipeline({ scanlines: 0.5, vignette: 0.3, brightness: 1.2, saturation: 0.9 });
    expect(p.effectReach()).toEqual({ x: 0, y: 0 });
    expect(p.hasUnboundedEffects()).toBe(false);
  });

  it('reports curvature as unbounded, other spread effects as bounded', () => {
    expect(new PostProcessingPipeline({ curvature: 0.2 }).hasUnboundedEffects()).toBe(true);
    expect(new PostProcessingPipeline({ bloom: 0.5 }).hasUnboundedEffects()).toBe(false);
    expect(new PostProcessingPipeline({ ntsc: 0.5 }).hasUnboundedEffects()).toBe(false);
    expect(new PostProcessingPipeline({ chromaticAberration: 0.5 }).hasUnboundedEffects()).toBe(false);
  });

  it('stacks reaches additively', () => {
    const solo = new PostProcessingPipeline({ bloom: 0.5 }).effectReach();
    const stacked = new PostProcessingPipeline({ bloom: 0.5, chromaticAberration: 1 }).effectReach();
    expect(stacked.x).toBeGreaterThan(solo.x);
    expect(stacked.y).toBeGreaterThan(solo.y);
  });
});

describe('applyToRect', () => {
  const W = 64;
  const H = 48;

  // Deterministic pseudo-random frame
  const randomFrame = (seed: number): Uint8Array => {
    const frame = new Uint8Array(W * H * 3);
    let s = seed;
    for (let i = 0; i < frame.length; i++) {
      s = (s * 1_103_515_245 + 12_345) & 0x7fffffff;
      frame[i] = (s >> 16) & 0xff;
    }
    return frame;
  };

  // frameB = frameA with pixels changed only inside damage
  const withDamage = (frame: Uint8Array, damage: { x: number; y: number; width: number; height: number }): Uint8Array => {
    const out = frame.slice();
    for (let y = damage.y; y < damage.y + damage.height; y++) {
      for (let x = damage.x; x < damage.x + damage.width; x++) {
        out[(y * W + x) * 3] ^= 0xa5;
        out[(y * W + x) * 3 + 2] ^= 0x3c;
      }
    }
    return out;
  };

  const CONFIGS = [
    { name: 'ntsc', options: { ntsc: 1 } },
    { name: 'chromatic aberration', options: { chromaticAberration: 1 } },
    { name: 'bloom', options: { bloom: 1, bloomThreshold: 0 } },
    {
      name: 'stacked with pointwise',
      options: {
        ntsc: 0.8, chromaticAberration: 1, bloom: 0.7, bloomThreshold: 0.2,
        scanlines: 0.5, vignette: 0.4, brightness: 1.2, saturation: 1.3, contrast: 1.1,
      },
    },
  ] as const;

  const DAMAGES = [
    { x: 28, y: 20, width: 4, height: 4 },   // interior
    { x: 0, y: 0, width: 3, height: 5 },     // corner (dilation clamps)
    { x: 0, y: 0, width: W, height: H },     // full frame
  ] as const;

  for (const config of CONFIGS) {
    for (const damage of DAMAGES) {
      it(`matches full-frame processing for ${config.name} with damage at ${damage.x},${damage.y}`, () => {
        const frameA = randomFrame(1);
        const frameB = withDamage(frameA, damage);

        // Reference: full-frame processing of both frames
        const processedA = frameA.slice();
        new PostProcessingPipeline(config.options).apply(processedA, W, H);
        const processedB = frameB.slice();
        new PostProcessingPipeline(config.options).apply(processedB, W, H);

        // Bounded: dst starts as processed frame A, applyToRect brings it to frame B
        const dst = processedA.slice();
        const pipeline = new PostProcessingPipeline(config.options);
        const outRect = pipeline.applyToRect(frameB.slice(), dst, W, H, damage);

        // Full equality proves both the in-rect math and that the reach
        // bound is sufficient (outside outRect, processedA must equal
        // processedB, and dst was never touched there)
        expect(dst).toEqual(processedB);
        expect(outRect.x).toBeLessThanOrEqual(damage.x);
        expect(outRect.y).toBeLessThanOrEqual(damage.y);
      });
    }
  }
});
