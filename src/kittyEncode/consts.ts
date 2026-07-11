/**
 * Whether delta frames (a=f frame edits) may use the file medium. The spec
 * permits file mediums for frame data but does not describe the combination
 * explicitly; flip this to false if live verification finds a terminal that
 * accepts the file probe but rejects file-medium frame edits (deltas then
 * stay on inline escape payloads while full frames keep using files).
 */
export const FILE_MEDIUM_FOR_DELTAS: boolean = true;

/** Chunk size for Kitty graphics protocol base64 transmission (256KB) */
export const KITTY_CHUNK_SIZE = 262_144;

/**
 * Deflate level for the 'zlib' payload format. It stays fixed and fast
 * because the format exists to cut file and PTY size while keeping the
 * terminal's decode down to an inflate, not to maximize compression.
 */
export const ZLIB_DEFLATE_LEVEL = 1;
