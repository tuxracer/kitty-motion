// Cross-module constants only. Constants used by a single module live in
// that module's consts.ts.

import packageJson from '../package.json' with { type: 'json' };

/** Library version, read from package.json (inlined into the bundle at build time) */
export const VERSION: string = packageJson.version;

/** Bytes per pixel in RGB24 format */
export const RGB24_BYTES_PER_PIXEL = 3;

/** Default native width in pixels */
export const DEFAULT_NATIVE_WIDTH = 256;

/** Default native height in pixels */
export const DEFAULT_NATIVE_HEIGHT = 240;

/** Default gamma value (no correction) */
export const DEFAULT_GAMMA = 1.0;
