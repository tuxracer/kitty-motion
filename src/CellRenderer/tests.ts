import { describe, expect, it } from 'vitest';
import { CellRenderer } from './index.ts';
import { EMOJI_COLORS } from '../color/index.ts';
import { ASCII_CHARS } from '../asciiShapes/index.ts';

// Glyph mode auto-detects from TERM_PROGRAM. Pin the environment so the
// half-block expectations hold regardless of which terminal runs the tests.
delete process.env['TERM_PROGRAM'];

const CSI = '\x1b[';
const RESET = `${CSI}0m`;

// rgb24 frame from a row-major array of [r,g,b] triples
const frameOf = (pixels: number[][], _width: number): Uint8Array => {
  const out = new Uint8Array(pixels.length * 3);
  pixels.forEach(([r, g, b], i) => out.set([r, g, b], i * 3));
  return out;
};

describe('CellRenderer full paint', () => {
  it('renders half-block cells with exact truecolor SGR', () => {
    // 2x2 source, halfBlock: 2 cols x 1 row, each cell = top/bottom pixel
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      limitColors: 0,
      layout: { cols: 2, rows: 1, offsetCol: 1, offsetRow: 1 },
    });
    const frame = frameOf(
      [
        [255, 0, 0], [0, 255, 0], // top row
        [0, 0, 255], [255, 255, 255], // bottom row
      ],
      2,
    );
    const payload = renderer.renderRgb24(frame);
    expect(payload).toBe(
      `${CSI}1;1H` +
        `${CSI}38;2;255;0;0;48;2;0;0;255m▀` +
        `${CSI}38;2;0;255;0;48;2;255;255;255m▀` +
        RESET,
    );
  });

  it('elides SGR for runs of identically colored cells', () => {
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      limitColors: 0,
      layout: { cols: 2, rows: 1, offsetCol: 1, offsetRow: 1 },
    });
    const frame = frameOf(
      [
        [10, 20, 30], [10, 20, 30],
        [40, 50, 60], [40, 50, 60],
      ],
      2,
    );
    const payload = renderer.renderRgb24(frame);
    // One SGR for the first cell, none for the second (same colors)
    expect(payload).toBe(
      `${CSI}1;1H${CSI}38;2;10;20;30;48;2;40;50;60m▀▀${RESET}`,
    );
  });

  it('emits 256-color SGR when limitColors is 256', () => {
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      limitColors: 256,
      layout: { cols: 2, rows: 1, offsetCol: 1, offsetRow: 1 },
    });
    const frame = frameOf(
      [
        [255, 0, 0], [255, 0, 0],
        [0, 0, 255], [0, 0, 255],
      ],
      2,
    );
    const payload = renderer.renderRgb24(frame);
    expect(payload).toContain('38;5;196'); // pure red cube entry
    expect(payload).toContain('48;5;21'); // pure blue cube entry
    expect(payload).not.toContain('38;2;');
  });

  it('emits basic SGR codes when limitColors is 16', () => {
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      limitColors: 16,
      layout: { cols: 2, rows: 1, offsetCol: 1, offsetRow: 1 },
    });
    const frame = frameOf(
      [
        [255, 0, 0], [255, 0, 0], // bright red -> index 9 -> fg 91
        [0, 0, 238], [0, 0, 238], // blue -> index 4 -> bg 44
      ],
      2,
    );
    const payload = renderer.renderRgb24(frame);
    expect(payload).toContain(`${CSI}91;44m`);
  });

  it('renders rgb15 frames', () => {
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      colorSpace: 'rgb15',
      limitColors: 0,
      layout: { cols: 2, rows: 1, offsetCol: 1, offsetRow: 1 },
    });
    // 0x001f = pure red in XBBBBBGGGGGRRRRR
    const frame = new Uint16Array([0x001f, 0x001f, 0x001f, 0x001f]);
    const payload = renderer.renderRgb15(frame);
    expect(payload).toContain('38;2;255;0;0');
  });

  it('box-filters when the source is larger than the target grid', () => {
    // 4x4 source onto 1 halfBlock cell (1x2 target pixels): each target
    // pixel averages a 4x2 source region
    const renderer = new CellRenderer({
      sourceWidth: 4,
      sourceHeight: 4,
      limitColors: 0,
      layout: { cols: 1, rows: 1, offsetCol: 1, offsetRow: 1 },
    });
    const pixels: number[][] = [];
    for (let i = 0; i < 8; i++) {
      pixels.push([100, 100, 100]); // top half
    }
    for (let i = 0; i < 8; i++) {
      pixels.push([200, 200, 200]); // bottom half
    }
    const payload = renderer.renderRgb24(frameOf(pixels, 4));
    expect(payload).toContain('38;2;100;100;100');
    expect(payload).toContain('48;2;200;200;200');
  });

  it('reports display size and status row from the layout', () => {
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      layout: { cols: 10, rows: 5, offsetCol: 3, offsetRow: 2 },
    });
    expect(renderer.getDisplaySize()).toEqual({ cols: 10, rows: 5 });
    expect(renderer.getStatusRow()).toBe(7); // offsetRow 2 + rows 5
  });

  it('clearScreen resets SGR state before clearing', () => {
    const renderer = new CellRenderer({ sourceWidth: 2, sourceHeight: 2 });
    expect(renderer.clearScreen().startsWith(RESET)).toBe(true);
    expect(renderer.clearScreen()).toContain(`${CSI}2J`);
  });
});

describe('CellRenderer diff emission', () => {
  const options = {
    sourceWidth: 4,
    sourceHeight: 2,
    limitColors: 0,
    layout: { cols: 4, rows: 1, offsetCol: 1, offsetRow: 1 },
  } as const;

  const flatFrame = (fill: number): Uint8Array => new Uint8Array(4 * 2 * 3).fill(fill);

  it('returns an empty payload for a pixel-identical frame', () => {
    const renderer = new CellRenderer({ ...options });
    expect(renderer.renderRgb24(flatFrame(50)).length).toBeGreaterThan(0);
    expect(renderer.renderRgb24(flatFrame(50))).toBe('');
  });

  it('re-emits only the changed cells', () => {
    const renderer = new CellRenderer({ ...options });
    renderer.renderRgb24(flatFrame(50));
    const changed = flatFrame(50);
    changed.set([255, 0, 0], (0 * 4 + 2) * 3); // top pixel of cell 3 (x=2)
    const payload = renderer.renderRgb24(changed);
    // One cursor move to row 1 col 3, one cell, reset. No other cells.
    expect(payload).toBe(
      `${CSI}1;3H${CSI}38;2;255;0;0;48;2;50;50;50m▀${RESET}`,
    );
  });

  it('coalesces adjacent changed cells into one run', () => {
    const renderer = new CellRenderer({ ...options });
    renderer.renderRgb24(flatFrame(50));
    const changed = flatFrame(50);
    changed.set([255, 0, 0], (0 * 4 + 1) * 3); // cell 2 top
    changed.set([255, 0, 0], (0 * 4 + 2) * 3); // cell 3 top
    const payload = renderer.renderRgb24(changed);
    const moves = payload.split(`${CSI}1;`).length - 1;
    expect(moves).toBe(1); // one cursor move for the two-cell run
    expect(payload.match(/▀/gu)?.length).toBe(2);
  });

  it('returns an empty payload when different pixels quantize to identical cells', () => {
    const renderer = new CellRenderer({ ...options, limitColors: 256 });
    renderer.renderRgb24(flatFrame(50));
    // 50 -> 51 changes pixels but not the quantized 256-color cell values
    expect(renderer.renderRgb24(flatFrame(51))).toBe('');
  });

  it('repaints fully after setDimensions', () => {
    const renderer = new CellRenderer({ ...options });
    renderer.renderRgb24(flatFrame(50));
    renderer.setDimensions();
    const payload = renderer.renderRgb24(flatFrame(50));
    expect(payload.match(/▀/gu)?.length).toBe(4); // all cells repainted
  });
});

// Simulated terminal cell grid: applies emitted payloads (cursor moves, SGR
// color changes, half-block glyphs) so tests can compare what is actually on
// screen, independent of how many cells each payload re-sent.
interface SimScreen {
  fg: Int32Array;
  bg: Int32Array;
}

const emptyScreen = (cols: number, rows: number): SimScreen => ({
  fg: new Int32Array(cols * rows).fill(-1),
  bg: new Int32Array(cols * rows).fill(-1),
});

const applyPayload = (screen: SimScreen, payload: string, cols: number): void => {
  const tokens = /\x1b\[([0-9;]*)([Hm])|▀/gu;
  let row = 1;
  let col = 1;
  let fg = -1;
  let bg = -1;
  for (const match of payload.matchAll(tokens)) {
    if (match[0] === '▀') {
      const idx = (row - 1) * cols + (col - 1);
      screen.fg[idx] = fg;
      screen.bg[idx] = bg;
      col++;
      continue;
    }
    const params = match[1].split(';').map(Number);
    if (match[2] === 'H') {
      [row, col] = params;
      continue;
    }
    // SGR: reset, 38;2;r;g;b / 48;2;r;g;b (truecolor), 38;5;n / 48;5;n (256)
    for (let i = 0; i < params.length; ) {
      if (params[i] === 0) {
        fg = -1;
        bg = -1;
        i++;
      } else if (params[i + 1] === 2) {
        const packed = (params[i + 2] << 16) | (params[i + 3] << 8) | params[i + 4];
        if (params[i] === 38) {
          fg = packed;
        } else {
          bg = packed;
        }
        i += 5;
      } else {
        if (params[i] === 38) {
          fg = params[i + 2];
        } else {
          bg = params[i + 2];
        }
        i += 3;
      }
    }
  }
};

describe('CellRenderer partial-update screen equivalence', () => {
  const WIDTH = 8;
  const HEIGHT = 6;
  const COLS = 4;
  const ROWS = 3;
  const options = {
    sourceWidth: WIDTH,
    sourceHeight: HEIGHT,
    limitColors: 0,
    layout: { cols: COLS, rows: ROWS, offsetCol: 1, offsetRow: 1 },
  } as const;

  // Deterministic PRNG so failures are reproducible
  const mulberry32 = (seed: number) => (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const gradientFrame = (): Uint8Array => {
    const frame = new Uint8Array(WIDTH * HEIGHT * 3);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = (y * WIDTH + x) * 3;
        frame[i] = x * 30;
        frame[i + 1] = y * 40;
        frame[i + 2] = 128;
      }
    }
    return frame;
  };

  // Screen produced by accumulating diff payloads must match a fresh
  // renderer's single full paint of the same final frame
  const expectScreenMatchesFullRender = (
    screen: SimScreen,
    frame: Uint8Array,
    limitColors: 0 | 16 | 256 = 0,
  ): void => {
    const fresh = new CellRenderer({ ...options, limitColors });
    const reference = emptyScreen(COLS, ROWS);
    applyPayload(reference, fresh.renderRgb24(frame), COLS);
    expect(Array.from(screen.fg)).toEqual(Array.from(reference.fg));
    expect(Array.from(screen.bg)).toEqual(Array.from(reference.bg));
  };

  it('a single changed source pixel yields the same screen as a full render', () => {
    const renderer = new CellRenderer({ ...options });
    const screen = emptyScreen(COLS, ROWS);
    const frame = gradientFrame();
    applyPayload(screen, renderer.renderRgb24(frame), COLS);

    frame.set([255, 0, 0], (2 * WIDTH + 5) * 3);
    applyPayload(screen, renderer.renderRgb24(frame), COLS);
    expectScreenMatchesFullRender(screen, frame);
  });

  it('a change spanning cell boundaries yields the same screen as a full render', () => {
    const renderer = new CellRenderer({ ...options });
    const screen = emptyScreen(COLS, ROWS);
    const frame = gradientFrame();
    applyPayload(screen, renderer.renderRgb24(frame), COLS);

    // 3x3 block at an odd offset: straddles cell columns and rows
    for (let y = 1; y <= 3; y++) {
      for (let x = 3; x <= 5; x++) {
        frame.set([0, 255, 255], (y * WIDTH + x) * 3);
      }
    }
    applyPayload(screen, renderer.renderRgb24(frame), COLS);
    expectScreenMatchesFullRender(screen, frame);
  });

  it('changes touching frame edges yield the same screen as a full render', () => {
    const renderer = new CellRenderer({ ...options });
    const screen = emptyScreen(COLS, ROWS);
    const frame = gradientFrame();
    applyPayload(screen, renderer.renderRgb24(frame), COLS);

    frame.set([255, 255, 0], 0); // top-left pixel
    applyPayload(screen, renderer.renderRgb24(frame), COLS);
    frame.set([0, 255, 0], (HEIGHT * WIDTH - 1) * 3); // bottom-right pixel
    applyPayload(screen, renderer.renderRgb24(frame), COLS);
    expectScreenMatchesFullRender(screen, frame);
  });

  it('random partial updates accumulate to the same screen as full renders', () => {
    const renderer = new CellRenderer({ ...options });
    const screen = emptyScreen(COLS, ROWS);
    const frame = gradientFrame();
    applyPayload(screen, renderer.renderRgb24(frame), COLS);

    const random = mulberry32(1234);
    for (let step = 0; step < 25; step++) {
      const writes = 1 + Math.floor(random() * 5);
      for (let w = 0; w < writes; w++) {
        const x = Math.floor(random() * WIDTH);
        const y = Math.floor(random() * HEIGHT);
        const color = [
          Math.floor(random() * 256),
          Math.floor(random() * 256),
          Math.floor(random() * 256),
        ];
        frame.set(color, (y * WIDTH + x) * 3);
      }
      applyPayload(screen, renderer.renderRgb24(frame), COLS);
      expectScreenMatchesFullRender(screen, frame);
    }
  });

  it('random partial updates match full renders in 256-color mode', () => {
    const renderer = new CellRenderer({ ...options, limitColors: 256 });
    const screen = emptyScreen(COLS, ROWS);
    const frame = gradientFrame();
    applyPayload(screen, renderer.renderRgb24(frame), COLS);

    const random = mulberry32(99);
    for (let step = 0; step < 15; step++) {
      const x = Math.floor(random() * WIDTH);
      const y = Math.floor(random() * HEIGHT);
      frame.set([Math.floor(random() * 256), 0, 255], (y * WIDTH + x) * 3);
      applyPayload(screen, renderer.renderRgb24(frame), COLS);
      expectScreenMatchesFullRender(screen, frame, 256);
    }
  });
});

describe('CellRenderer diff state across partial updates', () => {
  const makeRenderer = (): CellRenderer =>
    new CellRenderer({
      sourceWidth: 4,
      sourceHeight: 4,
      limitColors: 0,
      layout: { cols: 4, rows: 2, offsetCol: 1, offsetRow: 1 },
    });

  const solid = (r: number, g: number, b: number): Uint8Array => {
    const frame = new Uint8Array(4 * 4 * 3);
    for (let i = 0; i < 16; i++) {
      frame.set([r, g, b], i * 3);
    }
    return frame;
  };

  it('tracks the previous frame correctly through partial updates', () => {
    const renderer = makeRenderer();
    const frameA = solid(10, 20, 30);
    const frameB = solid(10, 20, 30);
    frameB.set([200, 100, 50], (3 * 4 + 3) * 3); // only the bottom-right pixel differs

    renderer.renderRgb24(frameA); // full paint
    expect(renderer.renderRgb24(frameB)).not.toBe(''); // partial update emitted
    expect(renderer.renderRgb24(frameB)).toBe(''); // identical resend detected after partial copy
    expect(renderer.renderRgb24(frameA)).not.toBe(''); // reverting the pixel is detected
    expect(renderer.renderRgb24(frameA)).toBe('');
  });

  it('tracks the previous frame correctly through partial updates for rgb15 sources', () => {
    const renderer = new CellRenderer({
      sourceWidth: 4,
      sourceHeight: 4,
      colorSpace: 'rgb15',
      limitColors: 0,
      layout: { cols: 4, rows: 2, offsetCol: 1, offsetRow: 1 },
    });
    const solid15 = (color: number): Uint16Array => new Uint16Array(16).fill(color);
    const frameA = solid15(0x1234);
    const frameB = solid15(0x1234);
    frameB[3 * 4 + 3] = 0x7fff; // only the bottom-right pixel differs

    renderer.renderRgb15(frameA); // full paint
    expect(renderer.renderRgb15(frameB)).not.toBe(''); // partial update emitted
    expect(renderer.renderRgb15(frameB)).toBe(''); // identical resend detected after partial copy
    expect(renderer.renderRgb15(frameA)).not.toBe(''); // reverting the pixel is detected
    expect(renderer.renderRgb15(frameA)).toBe('');
  });
});

// Run a block with TERM_PROGRAM set (or unset) and restore it afterwards
const withTermProgram = (value: string | undefined, run: () => void): void => {
  const saved = process.env['TERM_PROGRAM'];
  if (value === undefined) {
    delete process.env['TERM_PROGRAM'];
  } else {
    process.env['TERM_PROGRAM'] = value;
  }
  try {
    run();
  } finally {
    if (saved === undefined) {
      delete process.env['TERM_PROGRAM'];
    } else {
      process.env['TERM_PROGRAM'] = saved;
    }
  }
};

describe('CellRenderer background glyph mode', () => {
  it('renders one pixel per cell as spaces with background-only SGR', () => {
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      limitColors: 0,
      renderMode: 'cell-background',
      layout: { cols: 2, rows: 2, offsetCol: 1, offsetRow: 1 },
    });
    const frame = frameOf(
      [
        [255, 0, 0], [0, 255, 0],
        [0, 0, 255], [255, 255, 255],
      ],
      2,
    );
    const payload = renderer.renderRgb24(frame);
    expect(payload).toBe(
      `${CSI}1;1H` +
        `${CSI}48;2;255;0;0m ` +
        `${CSI}48;2;0;255;0m ` +
        `${CSI}2;1H` +
        `${CSI}48;2;0;0;255m ` +
        `${CSI}48;2;255;255;255m ` +
        RESET,
    );
  });

  it('never emits foreground parameters or half blocks', () => {
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      limitColors: 0,
      renderMode: 'cell-background',
      layout: { cols: 2, rows: 2, offsetCol: 1, offsetRow: 1 },
    });
    const payload = renderer.renderRgb24(
      frameOf(
        [
          [255, 0, 0], [0, 255, 0],
          [0, 0, 255], [255, 255, 255],
        ],
        2,
      ),
    );
    expect(payload).not.toContain('38;');
    expect(payload).not.toContain('▀');
  });

  it('box-filters both source rows into one cell row', () => {
    // 2x2 source into a 2x1 grid: each cell averages its column vertically
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      limitColors: 0,
      renderMode: 'cell-background',
      cellSampling: 'box',
      layout: { cols: 2, rows: 1, offsetCol: 1, offsetRow: 1 },
    });
    const payload = renderer.renderRgb24(
      frameOf(
        [
          [255, 0, 0], [0, 255, 0],
          [0, 0, 255], [255, 255, 255],
        ],
        2,
      ),
    );
    // Averaging happens in linear light, so a 50% blend of a full and an
    // empty channel lands at 186, not the too-dark sRGB midpoint 128
    // Column 0: (255,0,0)+(0,0,255) averages to (186,0,186)
    // Column 1: (0,255,0)+(255,255,255) averages to (186,255,186)
    expect(payload).toBe(
      `${CSI}1;1H${CSI}48;2;186;0;186m ${CSI}48;2;186;255;186m ${RESET}`,
    );
  });

  it('re-emits only changed cells on diff frames', () => {
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      limitColors: 0,
      renderMode: 'cell-background',
      layout: { cols: 2, rows: 2, offsetCol: 1, offsetRow: 1 },
    });
    renderer.renderRgb24(
      frameOf(
        [
          [10, 20, 30], [10, 20, 30],
          [10, 20, 30], [10, 20, 30],
        ],
        2,
      ),
    );
    const payload = renderer.renderRgb24(
      frameOf(
        [
          [10, 20, 30], [10, 20, 30],
          [10, 20, 30], [200, 100, 50],
        ],
        2,
      ),
    );
    expect(payload).toBe(`${CSI}2;2H${CSI}48;2;200;100;50m ${RESET}`);
  });

  it('emits 16-color background codes when limitColors is 16', () => {
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      limitColors: 16,
      renderMode: 'cell-background',
      layout: { cols: 2, rows: 2, offsetCol: 1, offsetRow: 1 },
    });
    const payload = renderer.renderRgb24(
      frameOf(
        [
          [255, 0, 0], [255, 0, 0],
          [255, 0, 0], [255, 0, 0],
        ],
        2,
      ),
    );
    // ANSI 16 background range only (40-47, 100-107), no fg codes, no palette selector
    expect(payload).toMatch(/\x1b\[(4|10)1m/);
    expect(payload).not.toContain('48;5;');
    expect(payload).not.toContain('38;');
  });

  it('auto-detects background mode from TERM_PROGRAM=Apple_Terminal', () => {
    withTermProgram('Apple_Terminal', () => {
      const renderer = new CellRenderer({
        sourceWidth: 2,
        sourceHeight: 2,
        limitColors: 0,
        layout: { cols: 2, rows: 2, offsetCol: 1, offsetRow: 1 },
      });
      const payload = renderer.renderRgb24(
        frameOf(
          [
            [255, 0, 0], [0, 255, 0],
            [0, 0, 255], [255, 255, 255],
          ],
          2,
        ),
      );
      expect(payload).not.toContain('▀');
      expect(payload).toContain('48;2;');
    });
  });

  it('an explicit half-block option overrides an Apple_Terminal environment', () => {
    withTermProgram('Apple_Terminal', () => {
      const renderer = new CellRenderer({
        sourceWidth: 2,
        sourceHeight: 2,
        limitColors: 0,
        renderMode: 'half-block',
        layout: { cols: 2, rows: 1, offsetCol: 1, offsetRow: 1 },
      });
      const payload = renderer.renderRgb24(
        frameOf(
          [
            [255, 0, 0], [0, 255, 0],
            [0, 0, 255], [255, 255, 255],
          ],
          2,
        ),
      );
      expect(payload).toContain('▀');
      expect(payload).toContain('38;2;');
    });
  });
});

describe('CellRenderer nearest sampling', () => {
  it('copies each cell region center pixel instead of averaging', () => {
    // 2x2 source into a 2x1 background grid: box mode blends each column,
    // nearest picks the bottom pixel (the vertical center of two rows)
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      limitColors: 0,
      renderMode: 'cell-background',
      cellSampling: 'nearest',
      layout: { cols: 2, rows: 1, offsetCol: 1, offsetRow: 1 },
    });
    const payload = renderer.renderRgb24(
      frameOf(
        [
          [255, 0, 0], [0, 255, 0],
          [0, 0, 255], [255, 255, 255],
        ],
        2,
      ),
    );
    expect(payload).toBe(`${CSI}1;1H${CSI}48;2;0;0;255m ${CSI}48;2;255;255;255m ${RESET}`);
  });

  it('keeps hard edges solid in half-block mode', () => {
    // 4x4 source onto one half-block cell: the top target pixel centers on
    // source row 1 (pure red), the bottom on row 3 (pure blue). Box mode
    // would average each 4x2 region, but the regions are uniform here, so
    // only exact colors prove the center-pixel path ran
    const renderer = new CellRenderer({
      sourceWidth: 4,
      sourceHeight: 4,
      limitColors: 0,
      renderMode: 'half-block',
      cellSampling: 'nearest',
      layout: { cols: 1, rows: 1, offsetCol: 1, offsetRow: 1 },
    });
    const pixels: number[][] = [];
    for (let i = 0; i < 8; i++) {
      pixels.push([255, 0, 0]);
    }
    for (let i = 0; i < 8; i++) {
      pixels.push([0, 0, 255]);
    }
    const payload = renderer.renderRgb24(frameOf(pixels, 4));
    expect(payload).toBe(`${CSI}1;1H${CSI}38;2;255;0;0;48;2;0;0;255m▀${RESET}`);
  });

  it('re-emits only changed cells on diff frames', () => {
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      limitColors: 0,
      renderMode: 'cell-background',
      cellSampling: 'nearest',
      layout: { cols: 2, rows: 2, offsetCol: 1, offsetRow: 1 },
    });
    renderer.renderRgb24(
      frameOf(
        [
          [10, 20, 30], [10, 20, 30],
          [10, 20, 30], [10, 20, 30],
        ],
        2,
      ),
    );
    const payload = renderer.renderRgb24(
      frameOf(
        [
          [10, 20, 30], [10, 20, 30],
          [10, 20, 30], [200, 100, 50],
        ],
        2,
      ),
    );
    expect(payload).toBe(`${CSI}2;2H${CSI}48;2;200;100;50m ${RESET}`);
  });

  it('uses nearest sampling by default when cellSampling is unspecified', () => {
    // No cellSampling option, so the default (nearest) applies. A 2x2 source
    // into a 2x1 background grid copies each column's bottom pixel instead of
    // box-blending the two rows
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      limitColors: 0,
      renderMode: 'cell-background',
      layout: { cols: 2, rows: 1, offsetCol: 1, offsetRow: 1 },
    });
    const payload = renderer.renderRgb24(
      frameOf(
        [
          [255, 0, 0], [0, 255, 0],
          [0, 0, 255], [255, 255, 255],
        ],
        2,
      ),
    );
    expect(payload).toBe(`${CSI}1;1H${CSI}48;2;0;0;255m ${CSI}48;2;255;255;255m ${RESET}`);
  });
});

describe('CellRenderer emoji mode', () => {
  it('renders one emoji per cell by nearest palette color, no SGR', () => {
    const renderer = new CellRenderer({
      sourceWidth: 2,
      sourceHeight: 2,
      renderMode: 'emoji',
      layout: { cols: 2, rows: 2, offsetCol: 1, offsetRow: 1 },
    });
    const payload = renderer.renderRgb24(
      frameOf(
        [
          [255, 0, 0], [50, 120, 220], // red -> 3, blue -> 6
          [50, 160, 30], [255, 255, 255], // green -> 5, white -> 0
        ],
        2,
      ),
    );
    expect(payload).toBe(
      `${CSI}1;1H${EMOJI_COLORS[3].emoji}${EMOJI_COLORS[6].emoji}` +
        `${CSI}2;1H${EMOJI_COLORS[5].emoji}${EMOJI_COLORS[0].emoji}` +
        RESET,
    );
    expect(payload).not.toContain('38;');
    expect(payload).not.toContain('48;');
    expect(payload).not.toContain('▀');
  });

  it('positions emoji diff runs at double-width columns', () => {
    const renderer = new CellRenderer({
      sourceWidth: 3,
      sourceHeight: 1,
      renderMode: 'emoji',
      layout: { cols: 3, rows: 1, offsetCol: 1, offsetRow: 1 },
    });
    renderer.renderRgb24(frameOf([[255, 255, 255], [255, 255, 255], [255, 255, 255]], 3));
    // Change only the middle cell (grid column 1) to red
    const payload = renderer.renderRgb24(
      frameOf([[255, 255, 255], [255, 0, 0], [255, 255, 255]], 3),
    );
    // Grid column 1 addresses terminal column offsetCol + 1*2 = 3
    expect(payload).toBe(`${CSI}1;3H${EMOJI_COLORS[3].emoji}${RESET}`);
  });
});

describe('CellRenderer ascii mode', () => {
  // Source and grid chosen so every cell footprint is 2 cols x 3 rows, one
  // source pixel per shape region (16/8 = 2 wide, 24/8 = 3 tall).
  const WIDTH = 16;
  const HEIGHT = 24;
  const asciiOptions = {
    sourceWidth: WIDTH,
    sourceHeight: HEIGHT,
    renderMode: 'ascii',
    limitColors: 0,
    layout: { cols: 8, rows: 8, offsetCol: 1, offsetRow: 1 },
  } as const;

  // rgb24 frame filled by a per-pixel color function
  const buildFrame = (color: (x: number, y: number) => [number, number, number]): Uint8Array => {
    const frame = new Uint8Array(WIDTH * HEIGHT * 3);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        frame.set(color(x, y), (y * WIDTH + x) * 3);
      }
    }
    return frame;
  };

  // Strip cursor moves and SGR sequences, leaving only the emitted glyphs
  const glyphsOf = (payload: string): string => payload.replace(/\x1b\[[0-9;]*[Hm]/gu, '');

  it('returns an empty payload for an identical second frame', () => {
    const renderer = new CellRenderer({ ...asciiOptions });
    const frame = buildFrame(() => [120, 60, 200]);
    expect(renderer.renderRgb24(frame).length).toBeGreaterThan(0);
    expect(renderer.renderRgb24(frame)).toBe('');
  });

  it('emits a foreground SGR and never a background SGR', () => {
    const renderer = new CellRenderer({ ...asciiOptions });
    const frame = buildFrame((_x, y) => (y < HEIGHT / 2 ? [200, 40, 40] : [40, 40, 200]));
    const payload = renderer.renderRgb24(frame);
    expect(payload).toContain('\x1b[38;');
    expect(payload).not.toContain('[48;');
  });

  it('emits grayscale foregrounds when colorEnabled is false', () => {
    const renderer = new CellRenderer({ ...asciiOptions, colorEnabled: false });
    const frame = buildFrame((x, y) => [(x * 16) % 256, (y * 10) % 256, 90]);
    const payload = renderer.renderRgb24(frame);
    const matches = [...payload.matchAll(/38;2;(\d+);(\d+);(\d+)/gu)];
    expect(matches.length).toBeGreaterThan(0);
    for (const [, r, g, b] of matches) {
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
  });

  it('produces different glyphs for top-heavy versus bottom-heavy cells', () => {
    // Each cell footprint is 3 source rows tall (one per shape region row).
    // Bright in the cell's top row vs its bottom row leaves the same average
    // color (2 white + 4 black pixels either way), so only the glyph shape
    // differs between the two payloads.
    const topHeavy = new CellRenderer({ ...asciiOptions });
    const bottomHeavy = new CellRenderer({ ...asciiOptions });
    const white: [number, number, number] = [255, 255, 255];
    const black: [number, number, number] = [0, 0, 0];
    const topPayload = topHeavy.renderRgb24(buildFrame((_x, y) => (y % 3 === 0 ? white : black)));
    const bottomPayload = bottomHeavy.renderRgb24(
      buildFrame((_x, y) => (y % 3 === 2 ? white : black)),
    );
    expect(glyphsOf(topPayload)).not.toBe(glyphsOf(bottomPayload));
  });

  it('emits only single-width printable ASCII glyphs', () => {
    const renderer = new CellRenderer({ ...asciiOptions });
    const frame = buildFrame((x, y) => [(x * 16) % 256, (y * 10) % 256, 128]);
    const glyphs = glyphsOf(renderer.renderRgb24(frame));
    expect(glyphs.length).toBeGreaterThan(0);
    for (const ch of glyphs) {
      expect(ASCII_CHARS).toContain(ch);
    }
  });

  it('samples identically to box mode when the footprint fits the sample caps', () => {
    // 16x24 over an 8x8 grid is a 2x3 footprint per cell, under the sample
    // caps, so nearest reads every pixel and must match box byte for byte.
    const nearest = new CellRenderer({ ...asciiOptions, cellSampling: 'nearest' });
    const box = new CellRenderer({ ...asciiOptions, cellSampling: 'box' });
    const frame = buildFrame((x, y) => [(x * 16) % 256, (y * 10) % 256, 128]);
    expect(nearest.renderRgb24(frame)).toBe(box.renderRgb24(frame));
  });

  it('preserves vertical shape discrimination on large footprints', () => {
    // A 200x120 source over a 20x8 grid gives a 10x15 footprint per cell, well
    // past the sample caps, so nearest subsamples. Bright in each cell's top
    // third vs its bottom third must still resolve to different glyphs.
    const W = 200;
    const H = 120;
    const layout = { cols: 20, rows: 8, offsetCol: 1, offsetRow: 1 };
    const cellH = H / layout.rows;
    const build = (topBright: boolean): Uint8Array => {
      const frame = new Uint8Array(W * H * 3);
      for (let y = 0; y < H; y++) {
        const inCell = y % cellH;
        const bright = topBright ? inCell < cellH / 3 : inCell >= (2 * cellH) / 3;
        const v = bright ? 255 : 0;
        for (let x = 0; x < W; x++) {
          frame.set([v, v, v], (y * W + x) * 3);
        }
      }
      return frame;
    };
    const top = new CellRenderer({ renderMode: 'ascii', sourceWidth: W, sourceHeight: H, limitColors: 0, layout });
    const bottom = new CellRenderer({ renderMode: 'ascii', sourceWidth: W, sourceHeight: H, limitColors: 0, layout });
    expect(glyphsOf(top.renderRgb24(build(true)))).not.toBe(glyphsOf(bottom.renderRgb24(build(false))));
  });
});

describe('CellRenderer region and embedded', () => {
  // Row and column of the first cursor move in a payload (the panel origin)
  const firstCursorMove = (payload: string): { row: number; col: number } => {
    const match = payload.match(/\x1b\[(\d+);(\d+)H/u);
    if (match === null) {
      throw new Error('payload has no cursor move');
    }
    return { row: Number(match[1]), col: Number(match[2]) };
  };

  it('fits and centers its grid inside a region', () => {
    const region = { offsetCol: 5, offsetRow: 3, cols: 24, rows: 12 };
    const renderer = new CellRenderer({
      sourceWidth: 16,
      sourceHeight: 24,
      limitColors: 0,
      renderMode: 'half-block',
      region,
    });
    const size = renderer.getDisplaySize();
    expect(size.cols).toBeGreaterThan(0);
    expect(size.rows).toBeGreaterThan(0);
    expect(size.cols).toBeLessThanOrEqual(region.cols);
    expect(size.rows).toBeLessThanOrEqual(region.rows);
    // The status row sits at or below the region's bottom edge
    expect(renderer.getStatusRow()).toBeLessThanOrEqual(region.offsetRow + region.rows);

    const payload = renderer.renderRgb24(new Uint8Array(16 * 24 * 3).fill(120));
    const origin = firstCursorMove(payload);
    // The grid origin lands at or after the region origin, and inside the box
    expect(origin.row).toBeGreaterThanOrEqual(region.offsetRow);
    expect(origin.col).toBeGreaterThanOrEqual(region.offsetCol);
    expect(origin.row + size.rows).toBeLessThanOrEqual(region.offsetRow + region.rows);
    expect(origin.col + size.cols).toBeLessThanOrEqual(region.offsetCol + region.cols);
  });

  it('lets an explicit layout override win over a region', () => {
    const renderer = new CellRenderer({
      sourceWidth: 16,
      sourceHeight: 24,
      limitColors: 0,
      renderMode: 'half-block',
      region: { offsetCol: 5, offsetRow: 3, cols: 24, rows: 12 },
      layout: { cols: 10, rows: 5, offsetCol: 3, offsetRow: 2 },
    });
    expect(renderer.getDisplaySize()).toEqual({ cols: 10, rows: 5 });
  });

  it('blanks only its own rows in embedded clearScreen (no full-screen clear)', () => {
    const renderer = new CellRenderer({
      sourceWidth: 4,
      sourceHeight: 3,
      limitColors: 0,
      renderMode: 'half-block',
      embedded: true,
      layout: { cols: 4, rows: 3, offsetCol: 5, offsetRow: 2 },
    });
    const cleared = renderer.clearScreen();
    expect(cleared.startsWith(RESET)).toBe(true);
    expect(cleared).not.toContain(`${CSI}2J`);
    // A cursor move to the panel origin followed by a run of blank spaces
    expect(cleared).toContain(`${CSI}2;5H    `);
    expect(cleared).toContain(`${CSI}3;5H    `);
    expect(cleared).toContain(`${CSI}4;5H    `);
  });

  it('keeps the full-screen clear when not embedded', () => {
    const renderer = new CellRenderer({
      sourceWidth: 4,
      sourceHeight: 3,
      limitColors: 0,
      renderMode: 'half-block',
      layout: { cols: 4, rows: 3, offsetCol: 5, offsetRow: 2 },
    });
    expect(renderer.clearScreen()).toContain(`${CSI}2J`);
  });

  it('yields the cursor to the host in embedded mode', () => {
    const renderer = new CellRenderer({
      sourceWidth: 4,
      sourceHeight: 3,
      renderMode: 'half-block',
      embedded: true,
      layout: { cols: 4, rows: 3, offsetCol: 5, offsetRow: 2 },
    });
    expect(renderer.hideCursor()).toBe('');
    expect(renderer.showCursor()).toBe('');
  });
});

describe('CellRenderer bounded spread effects', () => {
  const randomFrame = (w: number, h: number, seed: number): Uint8Array => {
    const frame = new Uint8Array(w * h * 3);
    let s = seed;
    for (let i = 0; i < frame.length; i++) {
      s = (s * 1_103_515_245 + 12_345) & 0x7fffffff;
      frame[i] = (s >> 16) & 0xff;
    }
    return frame;
  };

  const withPixel = (frame: Uint8Array, width: number, x: number, y: number): Uint8Array => {
    const copy = Uint8Array.from(frame);
    copy.set([255, 255, 255], (y * width + x) * 3);
    return copy;
  };

  it('matches unbounded processing under bounded spread effects', () => {
    const opts = {
      sourceWidth: 32, sourceHeight: 32,
      renderMode: 'half-block' as const, limitColors: 0 as const,
      layout: { cols: 16, rows: 8, offsetCol: 1, offsetRow: 1 },
      bloom: 0.6, bloomThreshold: 0.2, ntsc: 0.5, scanlines: 0.4,
    };
    const messages: string[] = [];
    const bounded = new CellRenderer({ ...opts, onDebug: (m) => messages.push(m) });
    const control = new CellRenderer({ ...opts, enableDiffRendering: false });
    const base = randomFrame(32, 32, 7);
    expect(bounded.renderRgb24(base)).toBe(control.renderRgb24(base));
    for (const [x, y] of [[20, 12], [0, 0], [31, 31]] as const) {
      expect(bounded.renderRgb24(withPixel(base, 32, x, y)))
        .toBe(control.renderRgb24(withPixel(base, 32, x, y)));
      expect(bounded.renderRgb24(base)).toBe(control.renderRgb24(base));
    }
    // The delta path stayed active under spread effects: single-pixel changes
    // produce diff paints re-mapping only a small cell region, not full paints
    const diffCounts = messages
      .map((m) => m.match(/diff, cells=(\d+)/u))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => Number(m[1]));
    expect(diffCounts.length).toBeGreaterThan(0);
    for (const count of diffCounts) {
      expect(count).toBeLessThan(16 * 8);
    }
  });

  it('still repaints the full grid under curvature', () => {
    const opts = {
      sourceWidth: 32, sourceHeight: 32,
      renderMode: 'half-block' as const, limitColors: 0 as const,
      layout: { cols: 16, rows: 8, offsetCol: 1, offsetRow: 1 },
      curvature: 0.3,
    };
    const bounded = new CellRenderer(opts);
    const control = new CellRenderer({ ...opts, enableDiffRendering: false });
    const base = randomFrame(32, 32, 7);
    expect(bounded.renderRgb24(base)).toBe(control.renderRgb24(base));
    expect(bounded.renderRgb24(withPixel(base, 32, 16, 16)))
      .toBe(control.renderRgb24(withPixel(base, 32, 16, 16)));
  });
});

describe('CellRenderer placeholder rows', () => {
  it('has no Unicode placeholders (cell mode draws no Kitty images)', () => {
    const renderer = new CellRenderer({ sourceWidth: 4, sourceHeight: 4, renderMode: 'half-block' });
    expect(renderer.getPlaceholderRows()).toEqual([]);
  });
});
