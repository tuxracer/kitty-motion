/** PNG file signature (magic bytes) */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG chunk header size: length (4) + type (4) */
export const PNG_CHUNK_HEADER_SIZE = 8;

/** PNG chunk footer size: CRC32 (4) */
export const PNG_CHUNK_FOOTER_SIZE = 4;

/** PNG chunk overhead: header + footer */
export const PNG_CHUNK_OVERHEAD = PNG_CHUNK_HEADER_SIZE + PNG_CHUNK_FOOTER_SIZE;

/** Offset for chunk type in PNG chunk buffer */
export const PNG_CHUNK_TYPE_OFFSET = 4;

/** Offset for chunk data in PNG chunk buffer */
export const PNG_CHUNK_DATA_OFFSET = 8;

/** Size of chunk type field */
export const PNG_CHUNK_TYPE_SIZE = 4;

/** Maximum colors in indexed PNG palette */
export const PNG_MAX_PALETTE_COLORS = 256;

/** Size of RGB triplet in palette */
export const RGB_TRIPLET_SIZE = 3;

/** Maximum palette buffer size (256 colors * 3 bytes) */
export const PNG_PALETTE_BUFFER_SIZE = 768;

// Bit manipulation constants for byte operations

/** Bit shift for second byte (green channel in RGB24) */
export const BYTE_SHIFT_1 = 8;

/** Bit shift for third byte (red channel in RGB24) */
export const BYTE_SHIFT_2 = 16;

// PNG format fields (IHDR values and layout)

/** PNG bit depth (8 bits per channel) */
export const PNG_BIT_DEPTH = 8;

/** PNG color type for indexed palette */
export const PNG_COLOR_TYPE_INDEXED = 3;

/** PNG color type for RGB */
export const PNG_COLOR_TYPE_RGB = 2;

/** IHDR total length (13 bytes) */
export const PNG_IHDR_LENGTH = 13;

/** Offset for height field in IHDR (after 4-byte width) */
export const PNG_IHDR_HEIGHT_OFFSET = 4;

// Open-addressed hash for the palette scan, persistent across frames (a
// fresh Map per frame costs an allocation plus a hashed lookup per pixel)

/** Slots in the palette hash table (power of two, 4x the 256-color palette cap) */
export const PALETTE_HASH_SIZE = 1_024;

/** Mask wrapping a palette hash probe position into the table */
export const PALETTE_HASH_MASK = PALETTE_HASH_SIZE - 1;

/** Multiplicative constant for Fibonacci hashing (odd, golden-ratio derived) */
export const PALETTE_HASH_MULTIPLIER = 0x9e3779b1;

/** Right shift keeping the top 10 bits of the 32-bit hash product */
export const PALETTE_HASH_SHIFT = 22;

/** Sentinel marking an empty palette hash slot */
export const PALETTE_HASH_EMPTY = -1;

/**
 * Complete IEND chunk: zero-length data, so its 12 bytes (including the
 * CRC, asserted against createPngChunk in tests) never change
 */
export const PNG_IEND_CHUNK = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82, // eslint-disable-line @typescript-eslint/no-magic-numbers
]);
