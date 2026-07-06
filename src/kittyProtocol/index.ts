/**
 * Kitty Graphics Protocol Utilities
 *
 * Builds Kitty graphics protocol escape sequences and probes the terminal
 * for capability support: the graphics protocol itself, animation frame
 * edits (dirty-rect deltas), and file-based transmission.
 */

export * from './consts.ts';

import { writeFileSync, unlinkSync } from 'node:fs';
import { APC, ST, moveCursor } from '../ansi/index.ts';
import { probeTerminal } from '../helpers/index.ts';
import { frameFilePath, newFrameFileSession } from '../frameFiles/index.ts';
import {
  KITTY_PROTOCOL_CHUNK_SIZE,
  KITTY_GRAPHICS_DETECT_TIMEOUT_MS,
  KITTY_GRAPHICS_RESPONSE_CLEAR_DELAY_MS,
  KITTY_GRAPHICS_QUERY,
  KITTY_ANIMATION_PROBE_IMAGE_ID,
  KITTY_ANIMATION_PROBE_TRANSMIT,
  KITTY_ANIMATION_PROBE_EDIT,
  KITTY_ANIMATION_PROBE_DELETE,
  KITTY_ANIMATION_DETECT_TIMEOUT_MS,
  KITTY_FILE_PROBE_IMAGE_ID,
  KITTY_FILE_PROBE_PIXEL,
  KITTY_FILE_TRANSFER_DETECT_TIMEOUT_MS,
} from './consts.ts';

// Cached detection result (null = not yet detected)
let kittyGraphicsSupportedCache: boolean | null = null;

/**
 * Detect if the terminal supports Kitty graphics protocol.
 *
 * Uses protocol query to detect support, with fast paths for Kitty terminal.
 * Results are cached for subsequent calls.
 */
export const detectKittyGraphicsSupport = async (): Promise<boolean> => {
  // Return cached result if available
  if (kittyGraphicsSupportedCache !== null) {
    return kittyGraphicsSupportedCache;
  }

  // Fast path: KITTY_WINDOW_ID is set by Kitty terminal (always supports its own protocol)
  if (process.env['KITTY_WINDOW_ID']) {
    kittyGraphicsSupportedCache = true;
    return true;
  }

  // Fast path: TERM=xterm-kitty indicates Kitty terminal
  if (process.env['TERM'] === 'xterm-kitty') {
    kittyGraphicsSupportedCache = true;
    return true;
  }

  // Only query if stdin is a TTY
  if (!process.stdin.isTTY) {
    kittyGraphicsSupportedCache = false;
    return false;
  }

  // Kitty graphics protocol responds with an APC ... ST sequence
  const supported = await probeTerminal<boolean>({
    query: KITTY_GRAPHICS_QUERY,
    parse: (response) => (response.includes(APC) && response.includes(ST) ? true : null),
    timeoutMs: KITTY_GRAPHICS_DETECT_TIMEOUT_MS,
    onTimeout: false,
  });
  if (supported) {
    // Give any additional response data time to clear before callers write
    await new Promise((resolveDelay) => setTimeout(resolveDelay, KITTY_GRAPHICS_RESPONSE_CLEAR_DELAY_MS));
  }
  kittyGraphicsSupportedCache = supported;
  return supported;
};

/**
 * Get the cached Kitty graphics support status.
 * Returns null if detection hasn't been run yet.
 */
export const getKittyGraphicsSupported = (): boolean | null => kittyGraphicsSupportedCache;

/**
 * Reset the cached Kitty graphics detection result.
 * Useful for testing or when terminal capabilities might have changed.
 */
export const resetKittyGraphicsDetection = (): void => {
  kittyGraphicsSupportedCache = null;
};

/**
 * Build the Kitty graphics escape sequence displaying a base64-encoded PNG
 * at the given size in cells, chunked per the protocol's payload limit.
 */
export const buildKittyImageSequence = (
  base64Data: string,
  cols: number,
  rows: number,
  imageId: number
): string => {
  const chunks: string[] = [];

  for (let i = 0; i < base64Data.length; i += KITTY_PROTOCOL_CHUNK_SIZE) {
    const chunk = base64Data.slice(i, i + KITTY_PROTOCOL_CHUNK_SIZE);
    const isFirst = i === 0;
    const isLast = i + KITTY_PROTOCOL_CHUNK_SIZE >= base64Data.length;

    let control: string;
    if (isFirst) {
      // a=T: transmit and display, f=100: PNG format, q=2: suppress response
      // c=cols, r=rows: display size in cells
      // C=1: do not move cursor
      control = `a=T,f=100,i=${imageId},q=2,c=${cols},r=${rows},C=1,m=${isLast ? 0 : 1}`;
    } else {
      control = `m=${isLast ? 0 : 1}`;
    }

    chunks.push(`${APC}${control};${chunk}${ST}`);
  }

  return chunks.join('');
};

/** Build the escape sequence deleting a Kitty image by id */
export const buildKittyDeleteSequence = (imageId: number): string =>
  `${APC}a=d,d=I,i=${imageId},q=2${ST}`;

/** Build the escape sequence positioning the cursor (1-indexed row and column) */
export const buildCursorPositionSequence = (row: number, col: number): string =>
  moveCursor(row, col);

/**
 * Parse terminal responses to a capability probe.
 * Returns true for an OK response addressed to the given image id, false for
 * an error response, and null while no complete response has arrived.
 */
export const parseKittyProbeResponse = (response: string, imageId: number): boolean | null => {
  // Responses look like: APC G <keys> ; <message> ST
  const matches = response.matchAll(/\x1b_G([^;\x1b]*);([^\x1b]*)\x1b\\/g);
  for (const match of matches) {
    const keys = match[1].split(',');
    if (keys.includes(`i=${imageId}`)) {
      return match[2] === 'OK';
    }
  }
  return null;
};

// Cached animation-support detection result (null = not yet detected)
let kittyAnimationSupportedCache: boolean | null = null;

/**
 * Detect whether the terminal supports Kitty animation-protocol frame edits
 * (a=f), which dirty-rect delta rendering requires. Transmits a hidden 1x1
 * probe image, attempts a frame edit on it, and waits for the terminal's
 * OK/error response. Results are cached for the process lifetime.
 *
 * Must run before other raw-mode input handlers take over stdin.
 */
export const detectKittyAnimationSupport = async (): Promise<boolean> => {
  if (kittyAnimationSupportedCache !== null) {
    return kittyAnimationSupportedCache;
  }

  // Fast path: a real kitty terminal supports its own animation protocol
  if (process.env['KITTY_WINDOW_ID'] || process.env['TERM'] === 'xterm-kitty') {
    kittyAnimationSupportedCache = true;
    return true;
  }

  if (!process.stdin.isTTY) {
    kittyAnimationSupportedCache = false;
    return false;
  }

  const supported = await probeTerminal<boolean>({
    query: KITTY_ANIMATION_PROBE_TRANSMIT + KITTY_ANIMATION_PROBE_EDIT,
    parse: (response) => parseKittyProbeResponse(response, KITTY_ANIMATION_PROBE_IMAGE_ID),
    timeoutMs: KITTY_ANIMATION_DETECT_TIMEOUT_MS,
    onTimeout: false,
    // Remove the probe image whether or not the terminal answered
    onFinish: () => process.stdout.write(KITTY_ANIMATION_PROBE_DELETE),
  });
  kittyAnimationSupportedCache = supported;
  return supported;
};

/**
 * Get the cached animation-support status.
 * Returns null if detection has not been run yet.
 */
export const getKittyAnimationSupported = (): boolean | null => kittyAnimationSupportedCache;

/** Reset the cached animation-support detection (tests, capability changes). */
export const resetKittyAnimationDetection = (): void => {
  kittyAnimationSupportedCache = null;
};

/** Build the a=q query asking the terminal to read a 1x1 RGB probe file */
export const buildKittyFileProbeQuery = (filePath: string): string =>
  `${APC}a=q,i=${KITTY_FILE_PROBE_IMAGE_ID},f=24,s=1,v=1,t=t;${Buffer.from(filePath).toString('base64')}${ST}`;

// Cached file-transfer detection result (null = not yet detected)
let kittyFileTransferSupportedCache: boolean | null = null;

/**
 * Detect whether the terminal can read files this process writes, which
 * file-based frame transmission (t=t) requires. Writes a 1x1 probe file to
 * the temp dir and asks the terminal to load it with a query action; only a
 * terminal sharing our filesystem answers OK. There is deliberately no
 * environment fast path: a local kitty reached over SSH must probe false.
 * Results are cached for the process lifetime.
 *
 * Must run before other raw-mode input handlers take over stdin, and not
 * concurrently with the other detectors (each reads raw-mode stdin).
 */
export const detectKittyFileTransferSupport = async (): Promise<boolean> => {
  if (kittyFileTransferSupportedCache !== null) {
    return kittyFileTransferSupportedCache;
  }

  if (!process.stdin.isTTY) {
    kittyFileTransferSupportedCache = false;
    return false;
  }

  const probePath = frameFilePath(newFrameFileSession(), 0);
  try {
    // wx: fail if the path already exists, refusing to follow a pre-existing
    // file or symlink planted by another user on a shared /tmp
    writeFileSync(probePath, KITTY_FILE_PROBE_PIXEL, { flag: 'wx' });
  } catch {
    // Cannot write temp files (or the path already existed): file transfer
    // cannot work at all
    kittyFileTransferSupportedCache = false;
    return false;
  }

  const supported = await probeTerminal<boolean>({
    query: buildKittyFileProbeQuery(probePath),
    parse: (response) => parseKittyProbeResponse(response, KITTY_FILE_PROBE_IMAGE_ID),
    timeoutMs: KITTY_FILE_TRANSFER_DETECT_TIMEOUT_MS,
    onTimeout: false,
    onFinish: (result) => {
      if (!result) {
        // On success the terminal deletes the t=t probe file itself
        try {
          unlinkSync(probePath);
        } catch {
          // Already gone: ignore
        }
      }
    },
  });
  kittyFileTransferSupportedCache = supported;
  return supported;
};

/**
 * Get the cached file-transfer support status.
 * Returns null if detection has not been run yet.
 */
export const getKittyFileTransferSupported = (): boolean | null => kittyFileTransferSupportedCache;

/** Reset the cached file-transfer detection (tests, capability changes). */
export const resetKittyFileTransferDetection = (): void => {
  kittyFileTransferSupportedCache = null;
};

