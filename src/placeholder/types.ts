export type PlaceholderErrorCode = 'GRID_TOO_LARGE';

export class PlaceholderError extends Error {
  readonly code: PlaceholderErrorCode;
  constructor(code: PlaceholderErrorCode, message: string) {
    super(message);
    this.name = 'PlaceholderError';
    this.code = code;
  }
}

export const isPlaceholderError = (error: unknown): error is PlaceholderError =>
  error instanceof PlaceholderError;
