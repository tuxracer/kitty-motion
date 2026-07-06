import { APC, ST } from '../ansi/index.ts';

// Kitty graphics protocol chunk size for base64 data (single-image transmission).
// Distinct from kittyEncode's `KITTY_CHUNK_SIZE` used for motion-frame encoding.
export const KITTY_PROTOCOL_CHUNK_SIZE = 4_096;

// Detection timeout in ms
export const KITTY_GRAPHICS_DETECT_TIMEOUT_MS = 100;
export const KITTY_GRAPHICS_RESPONSE_CLEAR_DELAY_MS = 10;

// Kitty graphics protocol query - request image ID support
export const KITTY_GRAPHICS_QUERY = `${APC}i=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}`;

// Animation-support probe: transmit a hidden 1x1 image, then attempt an a=f
// frame edit on it. The edit's OK/error response reveals whether the terminal
// supports the animation protocol (kitty does; ghostty and WezTerm
// historically do not).

/** Image id reserved for the animation-support probe (top of the 32-bit id space) */
export const KITTY_ANIMATION_PROBE_IMAGE_ID = 4_294_967_040;

/** Transmit (without displaying) a 1x1 probe image; q=1 sends only errors */
export const KITTY_ANIMATION_PROBE_TRANSMIT = `${APC}a=t,i=${KITTY_ANIMATION_PROBE_IMAGE_ID},s=1,v=1,t=d,f=24,q=1;AAAA${ST}`;

/** Edit the probe image's root frame; the terminal answers OK or an error */
export const KITTY_ANIMATION_PROBE_EDIT = `${APC}a=f,i=${KITTY_ANIMATION_PROBE_IMAGE_ID},r=1,x=0,y=0,s=1,v=1,t=d,f=24;AAAA${ST}`;

/** Delete the probe image's data; q=2 suppresses all responses */
export const KITTY_ANIMATION_PROBE_DELETE = `${APC}a=d,d=I,i=${KITTY_ANIMATION_PROBE_IMAGE_ID},q=2${ST}`;

/** Probe timeout in ms; silence means no animation support */
export const KITTY_ANIMATION_DETECT_TIMEOUT_MS = 100;

// File-transfer probe: write a real 1x1 RGB file to the temp dir, then ask
// the terminal to read it with a query action. Only a terminal sharing our
// filesystem can answer OK, so this detects SSH/container boundaries exactly.

/** Image id reserved for the file-transfer probe (adjacent to the animation probe id) */
export const KITTY_FILE_PROBE_IMAGE_ID = 4_294_967_041;

/** One black RGB pixel: the contents of the probe file */
export const KITTY_FILE_PROBE_PIXEL = Buffer.from([0, 0, 0]);

/** Probe timeout in ms; silence means no shared filesystem */
export const KITTY_FILE_TRANSFER_DETECT_TIMEOUT_MS = 100;
