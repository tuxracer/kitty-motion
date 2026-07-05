import { describe, expect, it } from 'vitest';
import { buildGammaLUT, calculateLuminance8, rgb15ToRgb24 } from '.';

describe('buildGammaLUT', () => {
  it('is identity at gamma 1.0', () => {
    const lut = buildGammaLUT(1.0);
    expect(lut[0]).toBe(0);
    expect(lut[128]).toBe(128);
    expect(lut[255]).toBe(255);
  });

  it('darkens midtones for gamma > 1', () => {
    // buildGammaLUT computes pow(i / 255, gamma) * 255; for gamma > 1 that
    // pulls a fractional input toward 0, darkening midtones (CRT-like).
    const lut = buildGammaLUT(1.5);
    expect(lut[128]).toBeLessThan(128);
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
  });
});

describe('rgb15ToRgb24', () => {
  it('expands full-intensity channels to 255', () => {
    // XBBBBBGGGGGRRRRR with all channel bits set
    const [r, g, b] = rgb15ToRgb24(0x7fff);
    expect([r, g, b]).toEqual([255, 255, 255]);
  });

  it('expands zero to black', () => {
    expect(rgb15ToRgb24(0)).toEqual([0, 0, 0]);
  });
});

it('calculateLuminance8 weights green highest', () => {
  expect(calculateLuminance8(0, 255, 0)).toBeGreaterThan(calculateLuminance8(255, 0, 0));
  expect(calculateLuminance8(255, 0, 0)).toBeGreaterThan(calculateLuminance8(0, 0, 255));
});
