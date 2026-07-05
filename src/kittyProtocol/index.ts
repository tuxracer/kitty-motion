/**
 * Kitty Graphics Protocol Utilities
 *
 * Shared utilities for building Kitty graphics protocol escape sequences
 * for displaying images in terminal dialogs.
 */

export * from './consts';

import { ESC, APC, ST } from '../ansi';
import {
  KITTY_PROTOCOL_CHUNK_SIZE,
  KITTY_GRAPHICS_DETECT_TIMEOUT_MS,
  KITTY_GRAPHICS_RESPONSE_CLEAR_DELAY_MS,
  KITTY_GRAPHICS_QUERY,
} from './consts';

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

  // Query the terminal using Kitty graphics protocol
  // We need to temporarily configure stdin to receive the response
  return new Promise((resolve) => {
    let responded = false;
    let responseData = '';

    // Save current stdin state
    const wasRaw = process.stdin.isRaw;
    const wasPaused = process.stdin.isPaused();

    // Configure stdin to receive terminal response
    process.stdin.setRawMode(true);
    if (wasPaused) {
      process.stdin.resume();
    }

    // Restore stdin state helper
    const restoreStdin = () => {
      process.stdin.setRawMode(wasRaw);
      if (wasPaused) {
        process.stdin.pause();
      }
    };

    // Temporary handler to check for Kitty graphics response
    const checkResponse = (data: Buffer) => {
      const str = data.toString();
      responseData += str;

      // Kitty graphics protocol responds with: APC G ... ; ST
      // We look for the graphics response pattern
      if (responseData.includes(APC) && responseData.includes(ST)) {
        responded = true;
        process.stdin.removeListener('data', checkResponse);
        restoreStdin();

        // Give time for any additional response data to clear
        setTimeout(() => {
          kittyGraphicsSupportedCache = true;
          resolve(true);
        }, KITTY_GRAPHICS_RESPONSE_CLEAR_DELAY_MS);
      }
    };

    process.stdin.on('data', checkResponse);

    // Send graphics query
    process.stdout.write(KITTY_GRAPHICS_QUERY);

    // Timeout - no response means not supported
    setTimeout(() => {
      if (!responded) {
        process.stdin.removeListener('data', checkResponse);
        restoreStdin();
        kittyGraphicsSupportedCache = false;
        resolve(false);
      }
    }, KITTY_GRAPHICS_DETECT_TIMEOUT_MS);
  });
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
 * Build Kitty graphics protocol escape sequence for displaying an image.
 *
 * @param base64Data Base64-encoded PNG image data
 * @param cols Display width in terminal columns
 * @param rows Display height in terminal rows
 * @param imageId Unique image ID for cleanup
 * @returns Escape sequence string to write to stdout
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

/**
 * Build escape sequence to delete a Kitty image by ID.
 *
 * @param imageId The image ID to delete
 * @returns Escape sequence string to write to stdout
 */
export const buildKittyDeleteSequence = (imageId: number): string =>
  `${APC}a=d,d=I,i=${imageId},q=2${ST}`;

/**
 * Build escape sequence to position cursor for image rendering.
 *
 * @param row Terminal row (1-indexed)
 * @param col Terminal column (1-indexed)
 * @returns Escape sequence string to write to stdout
 */
export const buildCursorPositionSequence = (row: number, col: number): string =>
  `${ESC}[${row};${col}H`;

