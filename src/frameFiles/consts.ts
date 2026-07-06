/**
 * Filename prefix for per-frame temp files. Contains the string
 * tty-graphics-protocol because kitty's t=t rules only delete files whose
 * full path carries that marker (and that live in a known temp directory).
 */
export const FRAME_FILE_PREFIX = 'kitty-motion-tty-graphics-protocol-';

/** Frame files older than this were leaked by a dead process and are swept */
export const STALE_FRAME_FILE_AGE_MS = 300_000;

/** Radix for encoding the pid and random bytes in a session token */
export const SESSION_TOKEN_RADIX = 36;

/** Number of random bytes mixed into each session token to avoid collisions */
export const SESSION_TOKEN_RANDOM_BYTES = 6;
