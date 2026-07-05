/** PNG chunk header size: length (4) + type (4) */
export const PNG_CHUNK_HEADER_SIZE = 8;

/** PNG chunk footer size: CRC32 (4) */
export const PNG_CHUNK_FOOTER_SIZE = 4;

/** PNG chunk overhead: header + footer */
export const PNG_CHUNK_OVERHEAD = 12;

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
