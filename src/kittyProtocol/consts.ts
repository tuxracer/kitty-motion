import { APC, ST } from '../ansi';

// Kitty graphics protocol chunk size for base64 data (dialog image transmission).
// Distinct from the top-level `KITTY_CHUNK_SIZE` used for motion-frame encoding.
export const KITTY_PROTOCOL_CHUNK_SIZE = 4096;

// Detection timeout in ms
export const KITTY_GRAPHICS_DETECT_TIMEOUT_MS = 100;
export const KITTY_GRAPHICS_RESPONSE_CLEAR_DELAY_MS = 10;

// Kitty graphics protocol query - request image ID support
export const KITTY_GRAPHICS_QUERY = `${APC}i=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}`;
