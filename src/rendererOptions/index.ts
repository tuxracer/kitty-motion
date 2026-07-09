import { allocateFrameBuffer, buildGammaLUT } from '../color/index.ts';
import { PostProcessingPipeline } from '../postProcessing/index.ts';
import {
  DEFAULT_NATIVE_WIDTH,
  DEFAULT_NATIVE_HEIGHT,
  DEFAULT_GAMMA,
  RGB24_BYTES_PER_PIXEL,
} from '../consts.ts';
import type { RendererOptionsBase, ResolvedRendererOptions } from './types.ts';

export * from './types.ts';

/**
 * Resolve the options and construct the derived state shared by both
 * renderers: defaulted option values, the gamma LUT, the post-processing
 * pipeline, and the frame buffers.
 */
export const resolveRendererOptions = (options: RendererOptionsBase): ResolvedRendererOptions => {
  const sourceWidth = options.sourceWidth ?? DEFAULT_NATIVE_WIDTH;
  const sourceHeight = options.sourceHeight ?? DEFAULT_NATIVE_HEIGHT;
  const colorSpace = options.colorSpace ?? 'rgb24';
  const gamma = options.gamma ?? DEFAULT_GAMMA;
  const pixelCount = sourceWidth * sourceHeight;
  return {
    sourceWidth,
    sourceHeight,
    colorSpace,
    pixelAspectRatio: options.pixelAspectRatio ?? 1.0,
    enableDiffRendering: options.enableDiffRendering ?? true,
    colorEnabled: options.colorEnabled ?? true,
    reservedRows: options.reservedRows ?? 0,
    region: options.region,
    embedded: options.embedded ?? false,
    onDebug: options.onDebug,
    gammaLUT: buildGammaLUT(gamma),
    hasIdentityGamma: gamma === DEFAULT_GAMMA,
    postProcessing: new PostProcessingPipeline(options),
    prevFrameBuffer: allocateFrameBuffer(colorSpace, pixelCount),
    nativeRgbBuffer: new Uint8Array(pixelCount * RGB24_BYTES_PER_PIXEL),
  };
};
