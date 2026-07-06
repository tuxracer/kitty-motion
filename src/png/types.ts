/**
 * Result of RGB to indexed color conversion
 */
export interface IndexedResult {
  /** One palette index per pixel */
  indices: Uint8Array;
  /** RGB triplets */
  palette: Uint8Array;
  /** Number of palette entries used */
  colorCount: number;
}
