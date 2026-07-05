/** CRC32 polynomial (reversed) */
export const CRC32_POLYNOMIAL = 0xedb88320;

/** Initial CRC value */
export const CRC32_INITIAL = 0xffffffff;

/** Number of bits to process for table generation */
export const CRC32_BIT_COUNT = 8;

/** Size of the CRC32 lookup table */
export const CRC32_TABLE_SIZE = 256;

/** Byte mask for table lookup */
export const BYTE_MASK = 0xff;

/** Hexadecimal radix for Number.toString(radix) */
export const HEX_RADIX = 16;

/** CRC32 hex string length (8 characters) */
export const CRC32_HEX_LENGTH = 8;

/** Chunk size for streaming file reads (64KB) */
export const CHUNK_SIZE = 65536;
