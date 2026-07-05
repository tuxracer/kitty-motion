// Minimal local helpers so the package has zero runtime dependencies.
export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;
