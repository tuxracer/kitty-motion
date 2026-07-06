import { ESC } from './consts.ts';

export * from './consts.ts';

export const moveCursor = (row: number, col: number): string => `${ESC}[${row};${col}H`;
export const clearScreen = (): string => `${ESC}[2J${ESC}[H`;
export const clearLine = (): string => `${ESC}[K`;
export const hideCursor = (): string => `${ESC}[?25l`;
export const showCursor = (): string => `${ESC}[?25h`;
