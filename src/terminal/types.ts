/** Environment shape accepted by the session detectors (process.env compatible) */
export type SessionEnv = Record<string, string | undefined>;

/** Pixel dimensions of a single terminal character cell */
export interface CellPixelSize {
  width: number;
  height: number;
}
