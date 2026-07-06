import { describe, expect, it } from 'vitest';
import { resolveRendererOptions } from './index.ts';

describe('resolveRendererOptions', () => {
  it('applies the documented defaults', () => {
    const resolved = resolveRendererOptions({});
    expect(resolved.sourceWidth).toBe(256);
    expect(resolved.sourceHeight).toBe(240);
    expect(resolved.colorSpace).toBe('rgb24');
    expect(resolved.pixelAspectRatio).toBe(1.0);
    expect(resolved.enableDiffRendering).toBe(true);
    expect(resolved.colorEnabled).toBe(true);
    expect(resolved.reservedRows).toBe(0);
    expect(resolved.onDebug).toBeUndefined();
  });

  it('sizes buffers for the color space', () => {
    const rgb24 = resolveRendererOptions({ sourceWidth: 4, sourceHeight: 2 });
    expect(rgb24.prevFrameBuffer).toBeInstanceOf(Uint8Array);
    expect(rgb24.prevFrameBuffer.length).toBe(4 * 2 * 3);
    expect(rgb24.nativeRgbBuffer.length).toBe(4 * 2 * 3);

    const rgb15 = resolveRendererOptions({ sourceWidth: 4, sourceHeight: 2, colorSpace: 'rgb15' });
    expect(rgb15.prevFrameBuffer).toBeInstanceOf(Uint16Array);
    expect(rgb15.prevFrameBuffer.length).toBe(4 * 2);
    expect(rgb15.nativeRgbBuffer.length).toBe(4 * 2 * 3);
  });

  it('marks identity gamma only at 1.0 and bakes gamma into the LUT otherwise', () => {
    const identity = resolveRendererOptions({});
    expect(identity.hasIdentityGamma).toBe(true);
    expect(identity.gammaLUT[128]).toBe(128);

    const dark = resolveRendererOptions({ gamma: 1.5 });
    expect(dark.hasIdentityGamma).toBe(false);
    expect(dark.gammaLUT[128]).toBeLessThan(128);
  });

  it('passes effect options through to the post-processing pipeline', () => {
    const withEffects = resolveRendererOptions({ bloom: 0.5 });
    expect(withEffects.postProcessing.hasNonLocalEffects()).toBe(true);
    const without = resolveRendererOptions({});
    expect(without.postProcessing.hasNonLocalEffects()).toBe(false);
  });
});
