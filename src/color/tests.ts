import { describe, expect, it } from 'vitest';
import {
  buildAnsi16LUT,
  buildAnsi256LUT,
  buildGammaLUT,
  calculateLuminance8,
  convertFrameToRgb24,
  paletteLUTIndex,
  rgb15ToRgb24,
  rgbToAnsi256,
  rgbToAnsi16,
} from './index.ts';

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

describe('rgbToAnsi256', () => {
  it('maps pure cube corners exactly', () => {
    expect(rgbToAnsi256(0, 0, 0)).toBe(16); // cube black
    expect(rgbToAnsi256(255, 0, 0)).toBe(196); // cube pure red
    expect(rgbToAnsi256(0, 0, 255)).toBe(21); // cube pure blue
    expect(rgbToAnsi256(255, 255, 255)).toBe(231); // cube white
  });

  it('prefers the grayscale ramp for grays between cube levels', () => {
    // 128,128,128: nearest cube level is 135 (distance 147); gray ramp
    // entry 12 is exactly 8 + 12*10 = 128 (distance 0)
    expect(rgbToAnsi256(128, 128, 128)).toBe(232 + 12);
  });

  it('maps a mid color to the nearest cube entry', () => {
    // 95,135,175 sits exactly on cube levels 1,2,3
    expect(rgbToAnsi256(95, 135, 175)).toBe(16 + 36 * 1 + 6 * 2 + 3);
  });
});

describe('palette quantization LUTs', () => {
  // Expand a 5-bit channel to 8 bits the same way rgb15ToRgb24 does
  const expand5 = (v5: number): number => (v5 << 3) | (v5 >> 2);

  it('paletteLUTIndex ignores the low 3 bits of each channel', () => {
    expect(paletteLUTIndex(50, 50, 50)).toBe(paletteLUTIndex(55, 55, 55));
    expect(paletteLUTIndex(48, 48, 48)).not.toBe(paletteLUTIndex(56, 48, 48));
  });

  it('ansi256 LUT lookups match direct quantization for exact 5-bit colors', () => {
    const lut = buildAnsi256LUT();
    for (let r5 = 0; r5 < 32; r5++) {
      for (let g5 = 0; g5 < 32; g5++) {
        for (let b5 = 0; b5 < 32; b5++) {
          const r = expand5(r5);
          const g = expand5(g5);
          const b = expand5(b5);
          if (lut[paletteLUTIndex(r, g, b)] !== rgbToAnsi256(r, g, b)) {
            expect.fail(`mismatch at rgb(${r},${g},${b})`);
          }
        }
      }
    }
  });

  it('ansi16 LUT lookups match direct quantization for exact 5-bit colors', () => {
    const lut = buildAnsi16LUT();
    for (let r5 = 0; r5 < 32; r5++) {
      for (let g5 = 0; g5 < 32; g5++) {
        for (let b5 = 0; b5 < 32; b5++) {
          const r = expand5(r5);
          const g = expand5(g5);
          const b = expand5(b5);
          if (lut[paletteLUTIndex(r, g, b)] !== rgbToAnsi16(r, g, b)) {
            expect.fail(`mismatch at rgb(${r},${g},${b})`);
          }
        }
      }
    }
  });

  it('maps well-known colors through the LUT', () => {
    const lut256 = buildAnsi256LUT();
    expect(lut256[paletteLUTIndex(0, 0, 0)]).toBe(16);
    expect(lut256[paletteLUTIndex(255, 0, 0)]).toBe(196);
    expect(lut256[paletteLUTIndex(0, 0, 255)]).toBe(21);
    expect(lut256[paletteLUTIndex(255, 255, 255)]).toBe(231);

    const lut16 = buildAnsi16LUT();
    expect(lut16[paletteLUTIndex(0, 0, 0)]).toBe(0);
    expect(lut16[paletteLUTIndex(255, 0, 0)]).toBe(9);
    expect(lut16[paletteLUTIndex(255, 255, 255)]).toBe(15);
  });
});

describe('rgbToAnsi16', () => {
  it('maps exact palette colors to their index', () => {
    expect(rgbToAnsi16(0, 0, 0)).toBe(0);
    expect(rgbToAnsi16(205, 0, 0)).toBe(1);
    expect(rgbToAnsi16(255, 0, 0)).toBe(9);
    expect(rgbToAnsi16(255, 255, 255)).toBe(15);
  });

  it('maps nearby colors to the nearest palette entry', () => {
    expect(rgbToAnsi16(250, 10, 5)).toBe(9); // near bright red
    expect(rgbToAnsi16(10, 10, 10)).toBe(0); // near black
  });
});

describe('convertFrameToRgb24 with rect', () => {
  const W = 8;
  const H = 8;
  const RECT = { x: 2, y: 3, width: 4, height: 2 };
  const SENTINEL = 7;

  const makeRgb24Source = (): Uint8Array => {
    const src = new Uint8Array(W * H * 3);
    for (let i = 0; i < src.length; i++) {
      src[i] = (i * 41) % 256;
    }
    return src;
  };

  // Convert fully and partially, then check the rect matches the full
  // conversion and everything outside it kept the sentinel value
  const expectRectOnlyConversion = (src: Uint8Array | Uint16Array, gamma: number): void => {
    const colorSpace = src instanceof Uint16Array ? ('rgb15' as const) : ('rgb24' as const);
    const options = {
      colorSpace,
      width: W,
      height: H,
      gammaLUT: buildGammaLUT(gamma),
      hasIdentityGamma: gamma === 1.0,
      colorEnabled: true,
    };
    const full = new Uint8Array(W * H * 3);
    convertFrameToRgb24(src, full, options);
    const partial = new Uint8Array(W * H * 3).fill(SENTINEL);
    convertFrameToRgb24(src, partial, { ...options, rect: RECT });

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 3;
        const inRect =
          x >= RECT.x && x < RECT.x + RECT.width && y >= RECT.y && y < RECT.y + RECT.height;
        for (let c = 0; c < 3; c++) {
          expect(partial[idx + c]).toBe(inRect ? full[idx + c] : SENTINEL);
        }
      }
    }
  };

  it('converts only the rect on the gamma path', () => {
    expectRectOnlyConversion(makeRgb24Source(), 1.5);
  });

  it('converts only the rect on the identity-gamma copy fast path', () => {
    expectRectOnlyConversion(makeRgb24Source(), 1.0);
  });

  it('converts only the rect for rgb15 sources', () => {
    const src = new Uint16Array(W * H);
    for (let i = 0; i < src.length; i++) {
      src[i] = (i * 977) % 32_768;
    }
    expectRectOnlyConversion(src, 1.0);
  });
});

describe('convertFrameToRgb24 rgb15 sources', () => {
  const W = 4;
  const H = 2;

  const makeRgb15Source = (): Uint16Array => {
    const src = new Uint16Array(W * H);
    for (let i = 0; i < src.length; i++) {
      src[i] = (i * 4_099) % 32_768;
    }
    return src;
  };

  const convert = (gamma: number, colorEnabled: boolean): Uint8Array => {
    const dst = new Uint8Array(W * H * 3);
    convertFrameToRgb24(makeRgb15Source(), dst, {
      colorSpace: 'rgb15',
      width: W,
      height: H,
      gammaLUT: buildGammaLUT(gamma),
      hasIdentityGamma: gamma === 1.0,
      colorEnabled,
    });
    return dst;
  };

  it('expands each pixel through rgb15ToRgb24 and the gamma LUT', () => {
    const gammaLUT = buildGammaLUT(1.5);
    const src = makeRgb15Source();
    const dst = convert(1.5, true);
    for (let i = 0; i < src.length; i++) {
      const [r, g, b] = rgb15ToRgb24(src[i]);
      expect([dst[i * 3], dst[i * 3 + 1], dst[i * 3 + 2]]).toEqual([
        gammaLUT[r],
        gammaLUT[g],
        gammaLUT[b],
      ]);
    }
  });

  it('collapses to gamma-corrected luminance when color is disabled', () => {
    const gammaLUT = buildGammaLUT(1.5);
    const src = makeRgb15Source();
    const dst = convert(1.5, false);
    for (let i = 0; i < src.length; i++) {
      const [r, g, b] = rgb15ToRgb24(src[i]);
      const gray = calculateLuminance8(gammaLUT[r], gammaLUT[g], gammaLUT[b]);
      expect([dst[i * 3], dst[i * 3 + 1], dst[i * 3 + 2]]).toEqual([gray, gray, gray]);
    }
  });

  it('ignores the unused bit 15', () => {
    const src = new Uint16Array([0x7fff, 0xffff]); // same color with and without bit 15
    const dst = new Uint8Array(2 * 3);
    convertFrameToRgb24(src, dst, {
      colorSpace: 'rgb15',
      width: 2,
      height: 1,
      gammaLUT: buildGammaLUT(1.0),
      hasIdentityGamma: true,
      colorEnabled: true,
    });
    expect(Array.from(dst.subarray(0, 3))).toEqual(Array.from(dst.subarray(3, 6)));
  });
});
