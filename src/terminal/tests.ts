import { describe, it, expect } from 'vitest';
import {
  parseCellPixelSize,
  isSSHSession,
  isMultiplexedSession,
  detectColorDepth,
  detectCellRenderMode,
  detectCellSampling,
} from './index.ts';

const grid = { cols: 80, rows: 24 };

describe('parseCellPixelSize', () => {
  it('parses a CSI 16 t reply (cell size in pixels) directly', () => {
    // Response format: ESC [ 6 ; height ; width t
    expect(parseCellPixelSize('\x1b[6;18;7t', grid)).toEqual({ width: 7, height: 18 });
  });

  it('parses a CSI 16 t reply for a normal-width font', () => {
    expect(parseCellPixelSize('\x1b[6;18;9t', grid)).toEqual({ width: 9, height: 18 });
  });

  it('derives cell size from a CSI 14 t reply (text-area pixels / grid)', () => {
    // Response format: ESC [ 4 ; heightPx ; widthPx t
    // 80 cols x 24 rows over 560x432 px => 7 x 18 per cell
    expect(parseCellPixelSize('\x1b[4;432;560t', grid)).toEqual({ width: 7, height: 18 });
  });

  it('prefers the direct cell-size (code 6) reply when both are present', () => {
    const both = '\x1b[6;18;7t\x1b[4;432;560t';
    expect(parseCellPixelSize(both, grid)).toEqual({ width: 7, height: 18 });
  });

  it('returns null for an unrelated response', () => {
    expect(parseCellPixelSize('\x1b[?62;c', grid)).toBeNull();
  });

  it('returns null for zero or malformed dimensions', () => {
    expect(parseCellPixelSize('\x1b[6;0;0t', grid)).toBeNull();
    expect(parseCellPixelSize('', grid)).toBeNull();
  });
});

describe('isSSHSession', () => {
  it('detects each variable sshd sets for interactive sessions', () => {
    expect(isSSHSession({ SSH_CONNECTION: '10.0.0.5 52422 10.0.0.1 22' })).toBe(true);
    expect(isSSHSession({ SSH_CLIENT: '10.0.0.5 52422 22' })).toBe(true);
    expect(isSSHSession({ SSH_TTY: '/dev/pts/3' })).toBe(true);
  });

  it('returns false without SSH variables or with empty values', () => {
    expect(isSSHSession({})).toBe(false);
    expect(isSSHSession({ TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' })).toBe(false);
    expect(isSSHSession({ SSH_TTY: '' })).toBe(false);
  });
});

describe('isMultiplexedSession', () => {
  it('detects tmux via TMUX and screen via STY', () => {
    expect(isMultiplexedSession({ TMUX: '/tmp/tmux-501/default,1234,0' })).toBe(true);
    expect(isMultiplexedSession({ STY: '1234.pts-0.host' })).toBe(true);
  });

  it('falls back to the TERM prefix, which survives ssh from inside a multiplexer', () => {
    expect(isMultiplexedSession({ TERM: 'tmux-256color' })).toBe(true);
    expect(isMultiplexedSession({ TERM: 'screen-256color' })).toBe(true);
    expect(isMultiplexedSession({ TERM: 'screen' })).toBe(true);
  });

  it('returns false for direct sessions', () => {
    expect(isMultiplexedSession({})).toBe(false);
    expect(isMultiplexedSession({ TERM: 'xterm-kitty' })).toBe(false);
    expect(isMultiplexedSession({ TERM: 'xterm-256color', SSH_TTY: '/dev/pts/1' })).toBe(false);
    expect(isMultiplexedSession({ TMUX: '' })).toBe(false);
  });
});

describe('detectColorDepth', () => {
  it('returns 0 (truecolor) when COLORTERM advertises it', () => {
    expect(detectColorDepth({ COLORTERM: 'truecolor' })).toBe(0);
    expect(detectColorDepth({ COLORTERM: '24bit', TERM: 'xterm-256color' })).toBe(0);
  });

  it('returns 256 when TERM contains 256color without COLORTERM', () => {
    expect(detectColorDepth({ TERM: 'xterm-256color' })).toBe(256);
    expect(detectColorDepth({ TERM: 'screen-256color' })).toBe(256);
  });

  it('returns 16 otherwise', () => {
    expect(detectColorDepth({ TERM: 'xterm' })).toBe(16);
    expect(detectColorDepth({})).toBe(16);
  });
});

describe('detectCellRenderMode', () => {
  it('selects cell-background mode for Terminal.app', () => {
    expect(detectCellRenderMode({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('cell-background');
  });

  it('selects half-block mode for other terminals', () => {
    expect(detectCellRenderMode({ TERM_PROGRAM: 'ghostty' })).toBe('half-block');
    expect(detectCellRenderMode({ TERM_PROGRAM: 'iTerm.app' })).toBe('half-block');
  });

  it('selects half-block mode when TERM_PROGRAM is unset', () => {
    expect(detectCellRenderMode({})).toBe('half-block');
  });
});

describe('detectCellSampling', () => {
  it('selects nearest sampling for Terminal.app', () => {
    expect(detectCellSampling({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('nearest');
  });

  it('selects box sampling for other terminals', () => {
    expect(detectCellSampling({ TERM_PROGRAM: 'ghostty' })).toBe('box');
  });

  it('selects box sampling when TERM_PROGRAM is unset', () => {
    expect(detectCellSampling({})).toBe('box');
  });
});
