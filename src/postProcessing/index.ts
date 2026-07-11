/**
 * Post-processing effects pipeline for CRT simulation.
 *
 * Effects are applied in this order:
 * 1. Color adjustments (brightness, contrast, saturation)
 * 2. NTSC artifacts (chroma blur)
 * 3. Chromatic aberration (RGB color fringing)
 * 4. Curvature (barrel distortion) - optionally combines scanlines + vignette
 * 5. Scanlines (darken odd rows)
 * 6. Bloom (glow from bright areas) - optionally combines vignette
 * 7. Vignette (darken edges)
 *
 * NOTE: This file disables no-magic-numbers because the shader-like image
 * processing code contains many mathematical coefficients (color science values,
 * fixed-point arithmetic, bit shifts) that are standard constants in image
 * processing. Extracting each would significantly harm readability of the
 * pixel processing loops.
 *
 * Common values used:
 * - 3: RGB bytes per pixel
 * - 8: bit shift for fixed-point division (>> 8 = divide by 256)
 * - 256: fixed-point scale factor (2^8)
 * - 255: maximum 8-bit color channel value
 * - 128: midpoint for contrast calculations
 * - 0.299, 0.587, 0.114: ITU-R BT.601 luminance coefficients
 * - 77, 150, 29: fast integer luminance coefficients (≈ 0.299*256, etc.)
 * - YIQ conversion: NTSC color space coefficients
 */
/* eslint-disable @typescript-eslint/no-magic-numbers */

import { clamp } from '../helpers/index.ts';
import { dilateRect, type Rect } from '../dirtyRect/index.ts';
import {
  DEFAULT_BLOOM_THRESHOLD,
  LUMA_R_INT, LUMA_G_INT, LUMA_B_INT,
  CURVATURE_INTENSITY_SCALE,
  NTSC_CHROMA_BLUR_RADIUS,
  BLOOM_BLUR_RADIUS,
  CHROMATIC_ABERRATION_OFFSET_SCALE,
  NTSC_REACH_X,
  BLOOM_REACH,
  YIQ_I_R, YIQ_I_G, YIQ_I_B,
  YIQ_Q_R, YIQ_Q_G, YIQ_Q_B,
  YIQ_INV_R_I, YIQ_INV_R_Q,
  YIQ_INV_G_I, YIQ_INV_G_Q,
  YIQ_INV_B_I, YIQ_INV_B_Q,
} from './consts.ts';
import type { EffectOptions, ColorAdjustLUTs, EffectReach } from './types.ts';

export * from './consts.ts';
export * from './types.ts';

export class PostProcessingPipeline {
  // Options (gamma is applied by the renderers during frame conversion, not here)
  private scanlineIntensity: number;
  private saturation: number;
  private brightness: number;
  private contrast: number;
  private vignette: number;
  private bloom: number;
  private bloomThreshold: number;
  private ntsc: number;
  private curvature: number;
  private chromaticAberration: number;

  // Vignette map
  private vignetteMap: Uint16Array | null = null;
  private vignetteMapWidth: number = 0;
  private vignetteMapHeight: number = 0;
  private vignetteMapIntensity: number = 0;

  // Curvature map
  private curvatureMap: Int32Array | null = null;
  private curvatureMapWidth: number = 0;
  private curvatureMapHeight: number = 0;
  private curvatureMapIntensity: number = 0;

  // Reusable buffers
  private curvatureSrcBuffer: Uint8Array | null = null;
  private bloomBuffer: Uint8Array | null = null;
  private bloomTempRow: Uint8Array | null = null;
  private bloomTempCol: Uint8Array | null = null;
  private ntscChromaBuffer: Int32Array | null = null;
  private ntscTempRow: Int32Array | null = null;
  private chromaticAberrationSrcBuffer: Uint8Array | null = null;

  // Full-frame working buffer for applyToRect (pooled)
  private workBuffer: Uint8Array | null = null;

  // Chromatic aberration map (precomputed for performance)
  // Stores source pixel indices: [redSrcIdx, blueSrcIdx] pairs for each destination pixel
  private chromaticAberrationMap: Int32Array | null = null;
  private chromaticAberrationMapWidth: number = 0;
  private chromaticAberrationMapHeight: number = 0;
  private chromaticAberrationMapIntensity: number = 0;

  // Brightness/contrast LUTs: both adjustments are fixed affine maps per
  // channel value and the options never change after construction, so they
  // are precomputed once. clamped feeds the saturation-off fast path, and
  // raw holds the unclamped float values the saturation blend expects.
  private colorAdjustLUTs: ColorAdjustLUTs | null = null;

  // Flags to track which effects have already been applied (to avoid duplicate passes)
  private scanlinesApplied: boolean = false;
  private vignetteApplied: boolean = false;

  constructor(options: EffectOptions = {}) {
    this.scanlineIntensity = clamp(options.scanlines ?? 0, 0, 1);
    this.saturation = options.saturation ?? 1.0;
    this.brightness = options.brightness ?? 1.0;
    this.contrast = options.contrast ?? 1.0;
    this.vignette = Math.max(0, options.vignette ?? 0);
    this.bloom = Math.max(0, options.bloom ?? 0);
    this.bloomThreshold = clamp(options.bloomThreshold ?? DEFAULT_BLOOM_THRESHOLD, 0, 1);
    this.ntsc = Math.max(0, options.ntsc ?? 0);
    this.curvature = Math.max(0, options.curvature ?? 0);
    this.chromaticAberration = Math.max(0, options.chromaticAberration ?? 0);
  }

  /**
   * Check if any effects are enabled.
   */
  hasEffects(): boolean {
    return this.bloom > 0 ||
           this.vignette > 0 ||
           this.scanlineIntensity > 0 ||
           this.ntsc > 0 ||
           this.curvature > 0 ||
           this.chromaticAberration > 0 ||
           this.brightness !== 1.0 ||
           this.contrast !== 1.0 ||
           this.saturation !== 1.0;
  }

  /**
   * True when any enabled effect spreads a source pixel's influence to other
   * output pixels (blur, distortion, or resampling). Dirty-rect rendering
   * must widen to the full frame while these are active, because a diff of
   * the source buffer underestimates the damaged output region. Pointwise
   * effects (gamma, brightness, contrast, saturation, scanlines, vignette)
   * depend only on each pixel's own value and fixed position, so they keep
   * dirty rects valid.
   */
  hasNonLocalEffects(): boolean {
    return this.bloom > 0 || this.ntsc > 0 || this.curvature > 0 || this.chromaticAberration > 0;
  }

  /**
   * True when an enabled effect's influence has no useful bound. Curvature
   * remaps pixels across the whole frame, so dirty-rect rendering must stay
   * full-frame while it is active. The other spread effects (bloom, NTSC,
   * chromatic aberration) have bounded reaches, see effectReach().
   */
  hasUnboundedEffects(): boolean {
    return this.curvature > 0;
  }

  /**
   * Combined worst-case influence radius, in source pixels per axis, of the
   * enabled bounded spread effects. Zero when only pointwise effects are
   * enabled. Reaches add because each pass can spread the previous pass's
   * output. Meaningless while hasUnboundedEffects() is true.
   */
  effectReach(): EffectReach {
    let x = 0;
    let y = 0;
    if (this.ntsc > 0) {
      x += NTSC_REACH_X;
    }
    if (this.chromaticAberration > 0) {
      const offset = Math.ceil(this.chromaticAberration * CHROMATIC_ABERRATION_OFFSET_SCALE);
      x += offset;
      y += offset;
    }
    if (this.bloom > 0) {
      x += BLOOM_REACH;
      y += BLOOM_REACH;
    }
    return { x, y };
  }

  /**
   * Apply all post-processing effects to the RGB buffer.
   *
   * Effect combination strategy (to minimize full-image iterations):
   * - Vignette is combined with: bloom (if enabled) > curvature > scanlines > standalone
   * - Scanlines are combined with: curvature (if enabled) > standalone
   *
   * This means:
   * - If bloom is enabled: vignette is applied in bloom's final pass
   * - Else if curvature is enabled: scanlines + vignette are applied in curvature pass
   * - Else: scanlines + vignette can be combined in a single pass
   *
   * With a rect, pointwise passes only touch that region; pixels outside it
   * keep their values from earlier applies. Non-local effects (bloom, NTSC,
   * curvature, chromatic aberration) read outside any rect, so while one is
   * enabled the rect is widened to the full frame.
   */
  apply(buffer: Uint8Array, width: number, height: number, rect?: Rect): void {
    // Early bailout when no effects are enabled
    if (!this.hasEffects()) {
      return;
    }

    const bounds: Rect =
      rect !== undefined && !this.hasNonLocalEffects()
        ? rect
        : { x: 0, y: 0, width, height };

    // Reset flags - these track whether effects were combined into an earlier pass
    this.scanlinesApplied = false;
    this.vignetteApplied = false;

    // 1. Color adjustments (brightness, contrast, saturation)
    this.applyColorAdjustments(buffer, width, bounds);

    // 2. NTSC artifacts (chroma blur for color bleeding effect)
    this.applyNtscArtifacts(buffer, width, height, bounds);

    // 3. Chromatic aberration (RGB fringing toward edges)
    this.applyChromaticAberration(buffer, width, height, bounds);

    // 4. Spatial effects: curvature, scanlines, vignette
    // These are combined where possible to reduce iterations
    if (this.curvature > 0) {
      // Curvature pass combines: curvature + scanlines + vignette (if no bloom)
      this.applyCurvature(buffer, width, height);
    } else if (this.scanlineIntensity > 0 || (this.vignette > 0 && this.bloom <= 0)) {
      // No curvature: combine scanlines + vignette in single pass (if no bloom)
      this.applyScanlinesAndVignette(buffer, width, height, bounds);
    }

    // 5. Bloom (glow from bright areas) - combines vignette if enabled
    this.applyBloom(buffer, width, height, bounds);

    // 6. Apply any effects that weren't combined into earlier passes
    // (these methods check the flags internally and return early if already applied)
    this.applyScanlines(buffer, width, bounds);
    this.applyVignette(buffer, width, height, bounds);
  }

  // Copy a rect's rows between two full-frame RGB24 buffers of the same geometry
  private copyRect(src: Uint8Array, dst: Uint8Array, width: number, rect: Rect): void {
    const rowBytes = rect.width * 3;
    const yEnd = rect.y + rect.height;
    for (let y = rect.y; y < yEnd; y++) {
      const start = (y * width + rect.x) * 3;
      dst.set(src.subarray(start, start + rowBytes), start);
    }
  }

  /**
   * Rect-bounded processing for bounded spread effects (bloom, NTSC,
   * chromatic aberration), keeping dirty-rect deltas valid while they are
   * enabled. Reads pre-effect pixels from src, runs every enabled pass over
   * the damage rect dilated by twice the combined effect reach (so every
   * pass's input halo holds valid values), and writes final pixels into dst
   * over the damage rect dilated once, which is returned as the transmit
   * rect. dst is never touched outside the returned rect. src must hold
   * converted, pre-post-processing pixels for at least the double-dilated
   * region. Do not call while hasUnboundedEffects() is true (curvature has
   * no useful bound); callers keep full-frame apply() there.
   */
  applyToRect(src: Uint8Array, dst: Uint8Array, width: number, height: number, damage: Rect): Rect {
    const reach = this.effectReach();
    const outRect = dilateRect(damage, reach.x, reach.y, width, height);
    const workRect = dilateRect(outRect, reach.x, reach.y, width, height);

    const size = width * height * 3;
    if (this.workBuffer === null || this.workBuffer.length !== size) {
      this.workBuffer = new Uint8Array(size);
    }
    const work = this.workBuffer;
    this.copyRect(src, work, width, workRect);

    // Same pass order as apply(), minus curvature (excluded by contract)
    this.scanlinesApplied = false;
    this.vignetteApplied = false;
    this.applyColorAdjustments(work, width, workRect);
    this.applyNtscArtifacts(work, width, height, workRect);
    this.applyChromaticAberration(work, width, height, workRect);
    if (this.scanlineIntensity > 0 || (this.vignette > 0 && this.bloom <= 0)) {
      this.applyScanlinesAndVignette(work, width, height, workRect);
    }
    this.applyBloom(work, width, height, workRect);
    this.applyScanlines(work, width, workRect);
    this.applyVignette(work, width, height, workRect);

    this.copyRect(work, dst, width, outRect);
    return outRect;
  }

  /**
   * Combined brightness, contrast, and saturation adjustment.
   */
  private applyColorAdjustments(buffer: Uint8Array, width: number, bounds: Rect): void {
    const needsSaturation = this.saturation !== 1.0;
    if (this.brightness === 1.0 && this.contrast === 1.0 && !needsSaturation) {return;}

    const { clamped, raw } = this.ensureColorAdjustLUTs();
    const yEnd = bounds.y + bounds.height;
    const rectRowBytes = bounds.width * 3;

    if (!needsSaturation) {
      // Brightness/contrast only: three LUT reads per pixel
      for (let y = bounds.y; y < yEnd; y++) {
        const rowStart = (y * width + bounds.x) * 3;
        const rowEnd = rowStart + rectRowBytes;
        for (let i = rowStart; i < rowEnd; i += 3) {
          buffer[i] = clamped[buffer[i]];
          buffer[i + 1] = clamped[buffer[i + 1]];
          buffer[i + 2] = clamped[buffer[i + 2]];
        }
      }
      return;
    }

    const sat = this.saturation;
    for (let y = bounds.y; y < yEnd; y++) {
      const rowStart = (y * width + bounds.x) * 3;
      const rowEnd = rowStart + rectRowBytes;
      for (let i = rowStart; i < rowEnd; i += 3) {
        const r = raw[buffer[i]];
        const g = raw[buffer[i + 1]];
        const b = raw[buffer[i + 2]];
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        const rs = gray + (r - gray) * sat;
        const gs = gray + (g - gray) * sat;
        const bs = gray + (b - gray) * sat;
        buffer[i] = rs < 0 ? 0 : rs > 255 ? 255 : rs | 0;
        buffer[i + 1] = gs < 0 ? 0 : gs > 255 ? 255 : gs | 0;
        buffer[i + 2] = bs < 0 ? 0 : bs > 255 ? 255 : bs | 0;
      }
    }
  }

  /**
   * Build vignette lookup map.
   */
  private buildVignetteMap(width: number, height: number): void {
    this.vignetteMap = new Uint16Array(width * height);
    this.vignetteMapWidth = width;
    this.vignetteMapHeight = height;
    this.vignetteMapIntensity = this.vignette;

    const halfW = width / 2;
    const halfH = height / 2;
    const invMaxDistSq = 1 / (halfW * halfW + halfH * halfH);

    let idx = 0;
    for (let y = 0; y < height; y++) {
      const dy = y - halfH;
      const dySq = dy * dy;

      for (let x = 0; x < width; x++) {
        const dx = x - halfW;
        const normDistSq = (dx * dx + dySq) * invMaxDistSq;
        let factor = 1 - this.vignette * normDistSq;
        if (factor < 0) {factor = 0;}
        this.vignetteMap[idx++] = (factor * 256) | 0;
      }
    }
  }

  /**
   * Ensure vignette map exists and is up to date.
   * Call this before any method that needs to use the vignette map.
   */
  private ensureVignetteMap(width: number, height: number): void {
    if (!this.vignetteMap ||
        this.vignetteMapWidth !== width ||
        this.vignetteMapHeight !== height ||
        this.vignetteMapIntensity !== this.vignette) {
      this.buildVignetteMap(width, height);
    }
  }

  private ensureColorAdjustLUTs(): ColorAdjustLUTs {
    if (this.colorAdjustLUTs !== null) {
      return this.colorAdjustLUTs;
    }
    const clamped = new Uint8Array(256);
    const raw = new Float64Array(256);
    for (let value = 0; value < 256; value++) {
      // Mirror the original conditional structure exactly: (x - 128) * 1 + 128
      // is NOT an IEEE identity for non-integer x, so the contrast step must
      // be skipped when contrast is 1.0, as the old per-pixel code did
      let adjusted = value;
      if (this.brightness !== 1.0) {
        adjusted = adjusted * this.brightness;
      }
      if (this.contrast !== 1.0) {
        adjusted = (adjusted - 128) * this.contrast + 128;
      }
      raw[value] = adjusted;
      clamped[value] = adjusted < 0 ? 0 : adjusted > 255 ? 255 : adjusted | 0;
    }
    this.colorAdjustLUTs = { clamped, raw };
    return this.colorAdjustLUTs;
  }

  /**
   * Ensure curvature map exists and is up to date.
   */
  private ensureCurvatureMap(width: number, height: number): void {
    if (!this.curvatureMap ||
        this.curvatureMapWidth !== width ||
        this.curvatureMapHeight !== height ||
        this.curvatureMapIntensity !== this.curvature) {
      this.buildCurvatureMap(width, height);
    }
  }

  /**
   * Ensure chromatic aberration map exists and is up to date.
   */
  private ensureChromaticAberrationMap(width: number, height: number): void {
    if (!this.chromaticAberrationMap ||
        this.chromaticAberrationMapWidth !== width ||
        this.chromaticAberrationMapHeight !== height ||
        this.chromaticAberrationMapIntensity !== this.chromaticAberration) {
      this.buildChromaticAberrationMap(width, height);
    }
  }

  /**
   * Ensure a Uint8Array buffer exists with the required size.
   * Returns existing buffer if size matches, otherwise allocates new one.
   */
  private ensureUint8Buffer(current: Uint8Array | null, size: number): Uint8Array {
    if (!current || current.length !== size) {
      return new Uint8Array(size);
    }
    return current;
  }

  /**
   * Ensure an Int32Array buffer exists with the required size.
   * Returns existing buffer if size matches, otherwise allocates new one.
   */
  private ensureInt32Buffer(current: Int32Array | null, size: number): Int32Array {
    if (!current || current.length !== size) {
      return new Int32Array(size);
    }
    return current;
  }

  /**
   * Apply vignette effect (standalone pass).
   * Only runs if vignette wasn't already combined into an earlier pass.
   */
  private applyVignette(buffer: Uint8Array, width: number, height: number, bounds: Rect): void {
    if (this.vignette <= 0 || this.vignetteApplied) {return;}

    this.ensureVignetteMap(width, height);
    const map = this.vignetteMap!;
    const yEnd = bounds.y + bounds.height;

    for (let y = bounds.y; y < yEnd; y++) {
      const rowStart = y * width + bounds.x;
      const rowEnd = rowStart + bounds.width;
      for (let i = rowStart; i < rowEnd; i++) {
        const factor = map[i];
        const idx = i * 3;
        buffer[idx] = (buffer[idx] * factor) >> 8;
        buffer[idx + 1] = (buffer[idx + 1] * factor) >> 8;
        buffer[idx + 2] = (buffer[idx + 2] * factor) >> 8;
      }
    }
    this.vignetteApplied = true;
  }

  /**
   * Apply scanline effect (standalone pass).
   * Only runs if scanlines weren't already combined into an earlier pass.
   */
  private applyScanlines(buffer: Uint8Array, width: number, bounds: Rect): void {
    if (this.scanlineIntensity <= 0 || this.scanlinesApplied) {return;}

    const mult256 = ((1 - this.scanlineIntensity) * 256) | 0;
    const yEnd = bounds.y + bounds.height;
    const rectRowBytes = bounds.width * 3;

    // bounds.y | 1 is the first odd (darkened) row at or after bounds.y
    for (let y = bounds.y | 1; y < yEnd; y += 2) {
      const rowStart = (y * width + bounds.x) * 3;
      const rowEnd = rowStart + rectRowBytes;
      for (let i = rowStart; i < rowEnd; i++) {
        buffer[i] = (buffer[i] * mult256) >> 8;
      }
    }
    this.scanlinesApplied = true;
  }

  /**
   * Combined scanlines + vignette pass (when curvature is disabled).
   * Combines these effects into a single iteration when both are needed.
   * Vignette is only applied here if bloom is disabled (otherwise bloom handles it).
   */
  private applyScanlinesAndVignette(buffer: Uint8Array, width: number, height: number, bounds: Rect): void {
    const needsScanlines = this.scanlineIntensity > 0;
    const needsVignette = this.vignette > 0 && this.bloom <= 0; // Vignette goes in bloom if bloom is enabled

    if (needsScanlines && needsVignette) {
      // Combined pass: both scanlines and vignette
      this.ensureVignetteMap(width, height);
      const vmap = this.vignetteMap!;
      const scanlineMult256 = ((1 - this.scanlineIntensity) * 256) | 0;
      const yEnd = bounds.y + bounds.height;

      for (let y = bounds.y; y < yEnd; y++) {
        const rowStart = y * width + bounds.x;
        const rowEnd = rowStart + bounds.width;
        const rowMult = y & 1 ? scanlineMult256 : 256;

        for (let i = rowStart; i < rowEnd; i++) {
          const idx = i * 3;
          const combinedMult = (rowMult * vmap[i]) >> 8;
          buffer[idx] = (buffer[idx] * combinedMult) >> 8;
          buffer[idx + 1] = (buffer[idx + 1] * combinedMult) >> 8;
          buffer[idx + 2] = (buffer[idx + 2] * combinedMult) >> 8;
        }
      }
      this.scanlinesApplied = true;
      this.vignetteApplied = true;
    } else if (needsScanlines) {
      // Scanlines only (vignette will be in bloom or not needed)
      this.applyScanlines(buffer, width, bounds);
    } else if (needsVignette) {
      // Vignette only (no scanlines)
      this.applyVignette(buffer, width, height, bounds);
    }
  }

  /**
   * Build curvature distortion map.
   */
  private buildCurvatureMap(width: number, height: number): void {
    const k = this.curvature * CURVATURE_INTENSITY_SCALE;

    this.curvatureMap = new Int32Array(width * height);
    this.curvatureMapWidth = width;
    this.curvatureMapHeight = height;
    this.curvatureMapIntensity = this.curvature;

    const halfW = width / 2;
    const halfH = height / 2;
    const maxDim = Math.max(halfW, halfH);

    let idx = 0;
    for (let y = 0; y < height; y++) {
      const ny = (y - halfH) / maxDim;

      for (let x = 0; x < width; x++) {
        const nx = (x - halfW) / maxDim;
        const r2 = nx * nx + ny * ny;
        const factor = 1 + k * r2;
        const srcX = nx * factor * maxDim + halfW;
        const srcY = ny * factor * maxDim + halfH;
        const srcXi = Math.round(srcX);
        const srcYi = Math.round(srcY);

        if (srcXi >= 0 && srcXi < width && srcYi >= 0 && srcYi < height) {
          this.curvatureMap[idx] = srcYi * width + srcXi;
        } else {
          this.curvatureMap[idx] = -1;
        }
        idx++;
      }
    }
  }

  /**
   * Apply CRT curvature with optional scanlines and vignette.
   * Combines these effects into a single iteration to minimize passes.
   * Vignette is only combined here if bloom is disabled.
   */
  private applyCurvature(buffer: Uint8Array, width: number, height: number): void {
    if (this.curvature <= 0) {return;}

    const pixelCount = width * height;
    const bufferSize = pixelCount * 3;

    this.ensureCurvatureMap(width, height);
    this.curvatureSrcBuffer = this.ensureUint8Buffer(this.curvatureSrcBuffer, bufferSize);

    const src = this.curvatureSrcBuffer;
    const map = this.curvatureMap!;
    src.set(buffer);

    // Determine which effects to combine into this pass
    const combineScanlines = this.scanlineIntensity > 0;
    const combineVignette = this.vignette > 0 && this.bloom <= 0; // Vignette goes in bloom if enabled
    const scanlineMult256 = combineScanlines ? ((1 - this.scanlineIntensity) * 256) | 0 : 256;

    if (combineVignette) {
      this.ensureVignetteMap(width, height);
    }
    const vmap = this.vignetteMap;

    // Unified loop: multiplying by 256 then >> 8 is a no-op, so disabled effects have no cost
    for (let y = 0; y < height; y++) {
      const rowStart = y * width;
      const rowMult = combineScanlines && (y & 1) ? scanlineMult256 : 256;

      for (let x = 0; x < width; x++) {
        const i = rowStart + x;
        const srcIdx = map[i];
        const dstIdx = i * 3;

        if (srcIdx >= 0) {
          const srcOffset = srcIdx * 3;
          const vfactor = combineVignette ? vmap![i] : 256;
          const finalMult = (rowMult * vfactor) >> 8;
          buffer[dstIdx] = (src[srcOffset] * finalMult) >> 8;
          buffer[dstIdx + 1] = (src[srcOffset + 1] * finalMult) >> 8;
          buffer[dstIdx + 2] = (src[srcOffset + 2] * finalMult) >> 8;
        } else {
          buffer[dstIdx] = 0;
          buffer[dstIdx + 1] = 0;
          buffer[dstIdx + 2] = 0;
        }
      }
    }

    if (combineScanlines) {this.scanlinesApplied = true;}
    if (combineVignette) {this.vignetteApplied = true;}
  }

  /**
   * Apply bloom/glow effect.
   */
  private applyBloom(buffer: Uint8Array, width: number, height: number, bounds: Rect): void {
    if (this.bloom <= 0) {return;}

    const intensity256 = (this.bloom * 256) | 0;
    const threshold = (this.bloomThreshold * 255) | 0;
    const rowBytes = width * 3;

    const halfW = (width + 1) >> 1;
    const halfH = (height + 1) >> 1;
    const halfRowBytes = halfW * 3;
    const halfBufferSize = halfW * halfH * 3;

    const radius = BLOOM_BLUR_RADIUS;
    // Half-res processing window: the bounds' projection plus the blur
    // margin, clamped. With full-frame bounds this is the whole half grid.
    const hx0 = Math.max(0, (bounds.x >> 1) - radius - 1);
    const hx1 = Math.min(halfW, ((bounds.x + bounds.width + 1) >> 1) + radius + 1);
    const hy0 = Math.max(0, (bounds.y >> 1) - radius - 1);
    const hy1 = Math.min(halfH, ((bounds.y + bounds.height + 1) >> 1) + radius + 1);

    this.bloomBuffer = this.ensureUint8Buffer(this.bloomBuffer, halfBufferSize);
    this.bloomTempRow = this.ensureUint8Buffer(this.bloomTempRow, halfRowBytes);
    this.bloomTempCol = this.ensureUint8Buffer(this.bloomTempCol, halfH * 3);

    const bloom = this.bloomBuffer;
    const tempRow = this.bloomTempRow;
    const tempCol = this.bloomTempCol;

    // Downsample and extract bright pixels
    const thresholdRange = 255 - threshold || 1;
    for (let hy = hy0; hy < hy1; hy++) {
      const sy = hy * 2;
      const sy1 = Math.min(sy + 1, height - 1);
      for (let hx = hx0; hx < hx1; hx++) {
        const sx = hx * 2;
        const sx1 = Math.min(sx + 1, width - 1);

        const i00 = (sy * width + sx) * 3;
        const i10 = (sy * width + sx1) * 3;
        const i01 = (sy1 * width + sx) * 3;
        const i11 = (sy1 * width + sx1) * 3;

        const r = (buffer[i00] + buffer[i10] + buffer[i01] + buffer[i11]) >> 2;
        const g = (buffer[i00 + 1] + buffer[i10 + 1] + buffer[i01 + 1] + buffer[i11 + 1]) >> 2;
        const b = (buffer[i00 + 2] + buffer[i10 + 2] + buffer[i01 + 2] + buffer[i11 + 2]) >> 2;

        const lum = (LUMA_R_INT * r + LUMA_G_INT * g + LUMA_B_INT * b) >> 8;
        const outIdx = (hy * halfW + hx) * 3;

        if (lum > threshold) {
          const excess256 = ((lum - threshold) << 8) / thresholdRange;
          bloom[outIdx] = (r * excess256) >> 8;
          bloom[outIdx + 1] = (g * excess256) >> 8;
          bloom[outIdx + 2] = (b * excess256) >> 8;
        } else {
          bloom[outIdx] = 0;
          bloom[outIdx + 1] = 0;
          bloom[outIdx + 2] = 0;
        }
      }
    }

    // Horizontal blur
    for (let y = hy0; y < hy1; y++) {
      const rowStart = y * halfRowBytes;
      let sumR = 0, sumG = 0, sumB = 0;
      for (let dx = hx0; dx <= hx0 + radius && dx < hx1; dx++) {
        const idx = rowStart + dx * 3;
        sumR += bloom[idx];
        sumG += bloom[idx + 1];
        sumB += bloom[idx + 2];
      }
      let windowSize = Math.min(radius + 1, hx1 - hx0);

      for (let x = hx0; x < hx1; x++) {
        const outIdx = (x - hx0) * 3;
        tempRow[outIdx] = (sumR / windowSize) | 0;
        tempRow[outIdx + 1] = (sumG / windowSize) | 0;
        tempRow[outIdx + 2] = (sumB / windowSize) | 0;

        const leftX = x - radius;
        const rightX = x + radius + 1;
        if (leftX >= hx0) {
          const leftIdx = rowStart + leftX * 3;
          sumR -= bloom[leftIdx];
          sumG -= bloom[leftIdx + 1];
          sumB -= bloom[leftIdx + 2];
          windowSize--;
        }
        if (rightX < hx1) {
          const rightIdx = rowStart + rightX * 3;
          sumR += bloom[rightIdx];
          sumG += bloom[rightIdx + 1];
          sumB += bloom[rightIdx + 2];
          windowSize++;
        }
      }
      bloom.set(tempRow.subarray(0, (hx1 - hx0) * 3), rowStart + hx0 * 3);
    }

    // Vertical blur
    for (let x = hx0; x < hx1; x++) {
      const xOffset = x * 3;
      let sumR = 0, sumG = 0, sumB = 0;
      for (let dy = hy0; dy <= hy0 + radius && dy < hy1; dy++) {
        const idx = dy * halfRowBytes + xOffset;
        sumR += bloom[idx];
        sumG += bloom[idx + 1];
        sumB += bloom[idx + 2];
      }
      let windowSize = Math.min(radius + 1, hy1 - hy0);

      for (let y = hy0; y < hy1; y++) {
        const outIdx = (y - hy0) * 3;
        tempCol[outIdx] = (sumR / windowSize) | 0;
        tempCol[outIdx + 1] = (sumG / windowSize) | 0;
        tempCol[outIdx + 2] = (sumB / windowSize) | 0;

        const topY = y - radius;
        const bottomY = y + radius + 1;
        if (topY >= hy0) {
          const topIdx = topY * halfRowBytes + xOffset;
          sumR -= bloom[topIdx];
          sumG -= bloom[topIdx + 1];
          sumB -= bloom[topIdx + 2];
          windowSize--;
        }
        if (bottomY < hy1) {
          const bottomIdx = bottomY * halfRowBytes + xOffset;
          sumR += bloom[bottomIdx];
          sumG += bloom[bottomIdx + 1];
          sumB += bloom[bottomIdx + 2];
          windowSize++;
        }
      }

      for (let y = hy0; y < hy1; y++) {
        const srcIdx = (y - hy0) * 3;
        const dstIdx = y * halfRowBytes + xOffset;
        bloom[dstIdx] = tempCol[srcIdx];
        bloom[dstIdx + 1] = tempCol[srcIdx + 1];
        bloom[dstIdx + 2] = tempCol[srcIdx + 2];
      }
    }

    // Upsample and blend, combining with vignette if enabled
    const combineVignette = this.vignette > 0;

    if (combineVignette) {
      this.ensureVignetteMap(width, height);
      const vmap = this.vignetteMap!;

      const yEnd = bounds.y + bounds.height;
      const xEnd = bounds.x + bounds.width;
      for (let y = bounds.y; y < yEnd; y++) {
        const hy = y >> 1;
        const srcRowStart = hy * halfRowBytes;
        const dstRowStart = y * rowBytes;
        const vignetteRowStart = y * width;

        for (let x = bounds.x; x < xEnd; x++) {
          const hx = x >> 1;
          const bloomIdx = srcRowStart + hx * 3;
          const dstIdx = dstRowStart + x * 3;
          const vfactor = vmap[vignetteRowStart + x];

          const blendedR = buffer[dstIdx] + ((bloom[bloomIdx] * intensity256) >> 8);
          const blendedG = buffer[dstIdx + 1] + ((bloom[bloomIdx + 1] * intensity256) >> 8);
          const blendedB = buffer[dstIdx + 2] + ((bloom[bloomIdx + 2] * intensity256) >> 8);

          buffer[dstIdx] = ((blendedR > 255 ? 255 : blendedR) * vfactor) >> 8;
          buffer[dstIdx + 1] = ((blendedG > 255 ? 255 : blendedG) * vfactor) >> 8;
          buffer[dstIdx + 2] = ((blendedB > 255 ? 255 : blendedB) * vfactor) >> 8;
        }
      }
      this.vignetteApplied = true;
    } else {
      const yEnd = bounds.y + bounds.height;
      const xEnd = bounds.x + bounds.width;
      for (let y = bounds.y; y < yEnd; y++) {
        const hy = y >> 1;
        const srcRowStart = hy * halfRowBytes;
        const dstRowStart = y * rowBytes;

        for (let x = bounds.x; x < xEnd; x++) {
          const hx = x >> 1;
          const bloomIdx = srcRowStart + hx * 3;
          const dstIdx = dstRowStart + x * 3;

          const blendedR = buffer[dstIdx] + ((bloom[bloomIdx] * intensity256) >> 8);
          const blendedG = buffer[dstIdx + 1] + ((bloom[bloomIdx + 1] * intensity256) >> 8);
          const blendedB = buffer[dstIdx + 2] + ((bloom[bloomIdx + 2] * intensity256) >> 8);

          buffer[dstIdx] = blendedR > 255 ? 255 : blendedR;
          buffer[dstIdx + 1] = blendedG > 255 ? 255 : blendedG;
          buffer[dstIdx + 2] = blendedB > 255 ? 255 : blendedB;
        }
      }
    }
  }

  /**
   * Apply NTSC color artifact effect using fixed-point integer math.
   *
   * YIQ color space coefficients (scaled by 256 for fixed-point):
   * - RGB to I: 0.596, -0.274, -0.322 → 153, -70, -82
   * - RGB to Q: 0.211, -0.523, 0.312 → 54, -134, 80
   * - RGB to Y: 0.299, 0.587, 0.114 → 77, 150, 29
   * - I/Q to R: 0.956, 0.621 → 245, 159
   * - I/Q to G: -0.272, -0.647 → -70, -166
   * - I/Q to B: -1.106, 1.703 → -283, 436
   */
  private applyNtscArtifacts(buffer: Uint8Array, width: number, _height: number, bounds: Rect): void {
    if (this.ntsc <= 0) {return;}

    const rowBytes = width * 3;
    const halfW = (width + 1) >> 1;
    const rowChromaSize = halfW * 2;

    // Fixed-point intensity (scaled by 256)
    const int256 = (this.ntsc * 256) | 0;
    const oneMinusInt256 = 256 - int256;

    this.ntscChromaBuffer = this.ensureInt32Buffer(this.ntscChromaBuffer, rowChromaSize);
    this.ntscTempRow = this.ensureInt32Buffer(this.ntscTempRow, rowChromaSize);

    const chromaRow = this.ntscChromaBuffer;
    const blurredRow = this.ntscTempRow;
    const radius = NTSC_CHROMA_BLUR_RADIUS;
    const rowStep = this.scanlineIntensity > 0 ? 2 : 1;

    // First processed row: honor the scanline-skip parity (rowStep 2
    // processes even rows only) while starting inside the bounds
    const yEnd = bounds.y + bounds.height;
    let yStart = bounds.y;
    if (rowStep === 2 && (yStart & 1) === 1) {
      yStart++;
    }
    for (let y = yStart; y < yEnd; y += rowStep) {
      const rowStart = y * rowBytes;

      // Extract I and Q chroma components (scaled by 256)
      for (let hx = 0; hx < halfW; hx++) {
        const sx = hx * 2;
        const idx = rowStart + sx * 3;
        const r = buffer[idx];
        const g = buffer[idx + 1];
        const b = buffer[idx + 2];

        const chromaIdx = hx * 2;
        chromaRow[chromaIdx] = YIQ_I_R * r - YIQ_I_G * g - YIQ_I_B * b;         // I * 256
        chromaRow[chromaIdx + 1] = YIQ_Q_R * r - YIQ_Q_G * g + YIQ_Q_B * b;     // Q * 256
      }

      // Horizontal blur using sliding window
      let sumI = 0, sumQ = 0;
      for (let dx = 0; dx <= radius && dx < halfW; dx++) {
        const idx = dx * 2;
        sumI += chromaRow[idx];
        sumQ += chromaRow[idx + 1];
      }
      let windowSize = Math.min(radius + 1, halfW);

      for (let hx = 0; hx < halfW; hx++) {
        const outIdx = hx * 2;
        blurredRow[outIdx] = (sumI / windowSize) | 0;
        blurredRow[outIdx + 1] = (sumQ / windowSize) | 0;

        const leftX = hx - radius;
        const rightX = hx + radius + 1;

        if (leftX >= 0) {
          const leftIdx = leftX * 2;
          sumI -= chromaRow[leftIdx];
          sumQ -= chromaRow[leftIdx + 1];
          windowSize--;
        }
        if (rightX < halfW) {
          const rightIdx = rightX * 2;
          sumI += chromaRow[rightIdx];
          sumQ += chromaRow[rightIdx + 1];
          windowSize++;
        }
      }

      // Apply chroma blur and convert back to RGB
      for (let x = 0; x < width; x++) {
        const idx = rowStart + x * 3;
        const r = buffer[idx];
        const g = buffer[idx + 1];
        const b = buffer[idx + 2];

        // Luma (Y) - unscaled, 0-255 range
        const luma = (LUMA_R_INT * r + LUMA_G_INT * g + LUMA_B_INT * b) >> 8;

        // Original I and Q (scaled by 256)
        const iOrig = YIQ_I_R * r - YIQ_I_G * g - YIQ_I_B * b;
        const qOrig = YIQ_Q_R * r - YIQ_Q_G * g + YIQ_Q_B * b;

        // Blurred I and Q (already scaled by 256)
        const hx = x >> 1;
        const chromaIdx = hx * 2;
        const iBlur = blurredRow[chromaIdx];
        const qBlur = blurredRow[chromaIdx + 1];

        // Blend original and blurred chroma (result still scaled by 256)
        const iFinal = (iOrig * oneMinusInt256 + iBlur * int256) >> 8;
        const qFinal = (qOrig * oneMinusInt256 + qBlur * int256) >> 8;

        // Convert YIQ back to RGB
        // Coefficients scaled by 256, I/Q scaled by 256, so >> 16 total
        const newR = luma + ((YIQ_INV_R_I * iFinal + YIQ_INV_R_Q * qFinal) >> 16);
        const newG = luma + ((-YIQ_INV_G_I * iFinal - YIQ_INV_G_Q * qFinal) >> 16);
        const newB = luma + ((-YIQ_INV_B_I * iFinal + YIQ_INV_B_Q * qFinal) >> 16);

        buffer[idx] = newR < 0 ? 0 : newR > 255 ? 255 : newR;
        buffer[idx + 1] = newG < 0 ? 0 : newG > 255 ? 255 : newG;
        buffer[idx + 2] = newB < 0 ? 0 : newB > 255 ? 255 : newB;
      }
    }
  }

  /**
   * Build chromatic aberration lookup map.
   * Precomputes source pixel indices for red and blue channel sampling.
   */
  private buildChromaticAberrationMap(width: number, height: number): void {
    const intensity = this.chromaticAberration;
    const maxOffset = intensity * CHROMATIC_ABERRATION_OFFSET_SCALE;

    const centerX = width / 2;
    const centerY = height / 2;
    const maxDist = Math.sqrt(centerX * centerX + centerY * centerY);

    // Store 2 indices per pixel: [redSrcIdx, blueSrcIdx]
    this.chromaticAberrationMap = new Int32Array(width * height * 2);
    this.chromaticAberrationMapWidth = width;
    this.chromaticAberrationMapHeight = height;
    this.chromaticAberrationMapIntensity = intensity;

    let mapIdx = 0;
    for (let y = 0; y < height; y++) {
      const dy = y - centerY;

      for (let x = 0; x < width; x++) {
        const dx = x - centerX;
        const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;
        const distSq = dist * dist; // Quadratic falloff

        // Calculate direction from center (normalized)
        const dirX = dist > 0 ? dx / (dist * maxDist) : 0;
        const dirY = dist > 0 ? dy / (dist * maxDist) : 0;

        const offset = maxOffset * distSq;

        // Red channel: sample from position shifted outward
        let redX = Math.round(x + dirX * offset);
        let redY = Math.round(y + dirY * offset);
        // Clamp to bounds
        if (redX < 0) {redX = 0;} else if (redX >= width) {redX = width - 1;}
        if (redY < 0) {redY = 0;} else if (redY >= height) {redY = height - 1;}

        // Blue channel: sample from position shifted inward
        let blueX = Math.round(x - dirX * offset);
        let blueY = Math.round(y - dirY * offset);
        // Clamp to bounds
        if (blueX < 0) {blueX = 0;} else if (blueX >= width) {blueX = width - 1;}
        if (blueY < 0) {blueY = 0;} else if (blueY >= height) {blueY = height - 1;}

        // Store source pixel indices (byte offset / 3)
        this.chromaticAberrationMap[mapIdx++] = redY * width + redX;
        this.chromaticAberrationMap[mapIdx++] = blueY * width + blueX;
      }
    }
  }

  /**
   * Apply chromatic aberration effect (RGB color fringing).
   * Simulates CRT electron beam convergence errors and lens distortion
   * where different color channels separate toward screen edges.
   */
  private applyChromaticAberration(buffer: Uint8Array, width: number, height: number, bounds: Rect): void {
    if (this.chromaticAberration <= 0) {return;}

    this.ensureChromaticAberrationMap(width, height);

    const bufferSize = width * height * 3;
    this.chromaticAberrationSrcBuffer = this.ensureUint8Buffer(this.chromaticAberrationSrcBuffer, bufferSize);

    const source = this.chromaticAberrationSrcBuffer;
    // The map's offsets are bounded by the intensity-scaled max offset, so
    // only the bounds rows plus that vertical margin can be read
    const reachY = Math.ceil(this.chromaticAberration * CHROMATIC_ABERRATION_OFFSET_SCALE);
    const copyY0 = Math.max(0, bounds.y - reachY);
    const copyY1 = Math.min(height, bounds.y + bounds.height + reachY);
    const rowBytes = width * 3;
    source.set(buffer.subarray(copyY0 * rowBytes, copyY1 * rowBytes), copyY0 * rowBytes);

    const map = this.chromaticAberrationMap!;
    const yEnd = bounds.y + bounds.height;
    const xEnd = bounds.x + bounds.width;

    for (let y = bounds.y; y < yEnd; y++) {
      for (let x = bounds.x; x < xEnd; x++) {
        const i = y * width + x;
        const mapIdx = i * 2;
        const redSrcPixel = map[mapIdx];
        const blueSrcPixel = map[mapIdx + 1];
        const dstIdx = i * 3;

        buffer[dstIdx] = source[redSrcPixel * 3];
        buffer[dstIdx + 1] = source[dstIdx + 1];
        buffer[dstIdx + 2] = source[blueSrcPixel * 3 + 2];
      }
    }
  }
}
