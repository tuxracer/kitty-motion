/**
 * CRC32 Checksum Utilities
 *
 * General-purpose CRC32 calculation for buffers and files.
 * Uses the standard CRC32 polynomial (0xEDB88320).
 */

import { openSync, readSync, closeSync } from 'fs';

export * from './consts';

import {
  CRC32_POLYNOMIAL,
  CRC32_INITIAL,
  CRC32_BIT_COUNT,
  CRC32_TABLE_SIZE,
  BYTE_MASK,
  HEX_RADIX,
  CRC32_HEX_LENGTH,
  CHUNK_SIZE,
} from './consts';

// =============================================================================
// CRC32 Table Generation
// =============================================================================

const CRC32_TABLE = new Uint32Array(CRC32_TABLE_SIZE);
for (let i = 0; i < CRC32_TABLE_SIZE; i++) {
  let c = i;
  for (let j = 0; j < CRC32_BIT_COUNT; j++) {
    c = (c & 1) ? (CRC32_POLYNOMIAL ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c >>> 0;
}

// =============================================================================
// Functions
// =============================================================================

/**
 * Calculate CRC32 checksum for a buffer.
 * Returns the checksum as an unsigned 32-bit integer.
 */
export const crc32 = (data: Buffer): number => {
  let crc = CRC32_INITIAL;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & BYTE_MASK] ^ (crc >>> CRC32_BIT_COUNT);
  }
  return (crc ^ CRC32_INITIAL) >>> 0;
};

/**
 * Calculate CRC32 checksum of a file using streaming reads.
 * Uses a fixed 64KB buffer to minimize memory usage for large files.
 * Returns the 8-character uppercase hex string, or undefined if the file cannot be read.
 */
export const calculateFileCrc32 = (filePath: string): string | undefined => {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return undefined;
  }

  try {
    const buffer = Buffer.alloc(CHUNK_SIZE);
    let crc = CRC32_INITIAL;
    let bytesRead: number;

    while ((bytesRead = readSync(fd, buffer, 0, CHUNK_SIZE, null)) > 0) {
      for (let i = 0; i < bytesRead; i++) {
        crc = CRC32_TABLE[(crc ^ buffer[i]) & BYTE_MASK] ^ (crc >>> CRC32_BIT_COUNT);
      }
    }

    const checksum = (crc ^ CRC32_INITIAL) >>> 0;
    return checksum.toString(HEX_RADIX).toUpperCase().padStart(CRC32_HEX_LENGTH, '0');
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
};
