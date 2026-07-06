/**
 * Side-scroller demo: generic platformer scenery with detailed dithered art,
 * parallax layers, a checkered scrolling ground, and a hopping runner. The
 * camera runs and pauses in a cycle like a real game session: while paused,
 * only the runner and drifting clouds dirty small rects over an expensive
 * static background (the best case for dirty-rect deltas); while scrolling,
 * deltas widen to most of the frame (the honest cost of a scroller).
 * Run: node examples/green-hill.ts
 */
import { runDemo } from "./demoHarness/index.ts";

const WIDTH = 320;
const HEIGHT = 224;
const HORIZON = 140;
const GRASS_H = 12;

// Camera cycle: scroll for 4s, stand still for 3s (at 60fps)
const RUN_TICKS = 240;
const IDLE_TICKS = 180;
const SCROLL_SPEED = 2;

type Rgb = readonly [number, number, number];

// Quantized shade ramps: dithering picks between neighbors, so frames stay
// on the indexed-PNG path (about 30 unique colors) while the per-pixel
// detail resists deflate the way real game art does
const SKY_SHADES: readonly Rgb[] = [
  [64, 128, 240],
  [96, 160, 248],
  [128, 184, 252],
  [160, 208, 255],
  [192, 224, 255],
];
const CLOUD: Rgb = [244, 244, 255];
const CLOUD_SHADE: Rgb = [212, 216, 236];
const HILL_SHADES: readonly Rgb[] = [
  [24, 112, 48],
  [32, 144, 64],
  [48, 160, 72],
];
const HILL_RIM: Rgb = [72, 184, 96];
const GRASS_SHADES: readonly Rgb[] = [
  [40, 152, 72],
  [48, 176, 80],
  [64, 192, 96],
];
const DIRT_A_SHADES: readonly Rgb[] = [
  [184, 128, 56],
  [200, 144, 64],
  [216, 160, 80],
];
const DIRT_B_SHADES: readonly Rgb[] = [
  [152, 100, 40],
  [168, 112, 48],
  [184, 128, 56],
];
const RUNNER: Rgb = [224, 48, 48];
const RUNNER_EYE: Rgb = [255, 255, 255];

// 4x4 ordered-dither thresholds (0..15) for the sky gradient
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

// Deterministic 2D hash for world-anchored texture noise: the pattern is a
// pure function of world coordinates, so it scrolls rigidly with its layer
const hash2 = (x: number, y: number): number => {
  let h = Math.imul(x, 374_761_393) + Math.imul(y, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return (h ^ (h >>> 16)) >>> 0;
};

// Hill silhouette heights per world column, built once (two octaves of sine)
const HILL_PERIOD = 512;
const hillHeight = new Int32Array(HILL_PERIOD);
for (let i = 0; i < HILL_PERIOD; i++) {
  const phase = (i / HILL_PERIOD) * Math.PI * 2;
  hillHeight[i] = Math.round(36 + 24 * Math.sin(phase) + 8 * Math.sin(phase * 3));
}

// Parabolic hop arc per tick within the jump cycle, built once
const JUMP_PERIOD = 180;
const JUMP_AIR = 48;
const JUMP_PEAK = 56;
const jumpHeight = new Int32Array(JUMP_PERIOD);
for (let i = 0; i < JUMP_AIR; i++) {
  const t = (2 * i) / JUMP_AIR - 1; // -1..1 across the airborne window
  jumpHeight[i] = Math.round(JUMP_PEAK * (1 - t * t));
}

// Clouds as ellipses in a wrapping world strip: [worldX, y, radiusX, radiusY]
const CLOUD_SPAN = 480;
const CLOUDS = [
  [60, 34, 26, 9],
  [200, 56, 34, 11],
  [360, 22, 22, 8],
] as const;

const RUNNER_X = 72;
const RUNNER_R = 12;

const frame = new Uint8Array(WIDTH * HEIGHT * 3);

const setPixel = (x: number, y: number, color: Rgb): void => {
  const i = (y * WIDTH + x) * 3;
  frame[i] = color[0];
  frame[i + 1] = color[1];
  frame[i + 2] = color[2];
};

let cameraX = 0;

await runDemo({
  name: "green-hill",
  screen: { sourceWidth: WIDTH, sourceHeight: HEIGHT, scale: 1 },
  renderFrame: (tick) => {
    const phase = tick % (RUN_TICKS + IDLE_TICKS);
    if (phase < RUN_TICKS) {
      cameraX += SCROLL_SPEED;
    }
    const groundScroll = cameraX; // fast foreground
    const hillScroll = cameraX >> 1; // half-speed parallax
    const cloudScroll = tick >> 3; // wind: clouds drift even when standing

    // Sky: dithered vertical gradient, static in screen space
    for (let y = 0; y < HORIZON; y++) {
      const level = (y / HORIZON) * (SKY_SHADES.length - 1);
      const base = Math.floor(level);
      const threshold = (level - base) * 16;
      for (let x = 0; x < WIDTH; x++) {
        const shade = threshold > BAYER4[y & 3][x & 3] ? base + 1 : base;
        setPixel(x, y, SKY_SHADES[shade]);
      }
    }

    // Clouds drift through a wrapping strip wider than the screen
    for (const [wx, cy, rx, ry] of CLOUDS) {
      const cx = ((wx - cloudScroll) % CLOUD_SPAN + CLOUD_SPAN) % CLOUD_SPAN - (CLOUD_SPAN - WIDTH) / 2;
      for (let y = Math.max(0, cy - ry); y <= Math.min(HORIZON - 1, cy + ry); y++) {
        const dy = (y - cy) / ry;
        for (let x = Math.max(0, cx - rx); x <= Math.min(WIDTH - 1, cx + rx); x++) {
          const dx = (x - cx) / rx;
          if (dx * dx + dy * dy <= 1) {
            setPixel(x, y, dy > 0.4 ? CLOUD_SHADE : CLOUD);
          }
        }
      }
    }

    // Far hill silhouettes: bright rim at the crest, noisy shading below
    for (let x = 0; x < WIDTH; x++) {
      const wx = x + hillScroll;
      const h = hillHeight[wx % HILL_PERIOD];
      const top = HORIZON - h;
      for (let y = top; y < HORIZON; y++) {
        if (y - top < 2) {
          setPixel(x, y, HILL_RIM);
        } else {
          setPixel(x, y, HILL_SHADES[hash2(wx, y) % HILL_SHADES.length]);
        }
      }
    }

    // Grass strip and checkered dirt with per-pixel texture noise, all
    // anchored to world coordinates so it scrolls at foreground speed
    for (let y = HORIZON; y < HEIGHT; y++) {
      const inGrass = y < HORIZON + GRASS_H;
      for (let x = 0; x < WIDTH; x++) {
        const wx = x + groundScroll;
        if (inGrass) {
          setPixel(x, y, GRASS_SHADES[hash2(wx, y) % GRASS_SHADES.length]);
        } else {
          const checker = ((wx >> 4) + (y >> 3)) & 1;
          const shades = checker ? DIRT_A_SHADES : DIRT_B_SHADES;
          setPixel(x, y, shades[hash2(wx, y) % shades.length]);
        }
      }
    }

    // Runner: red disc with an eye, bobbing while grounded, hopping on a cycle
    const hop = jumpHeight[tick % JUMP_PERIOD];
    const bob = hop === 0 ? (tick >> 2) & 1 : 0;
    const cy = HORIZON - RUNNER_R - 1 - hop - bob;
    for (let y = cy - RUNNER_R; y <= cy + RUNNER_R; y++) {
      for (let x = RUNNER_X - RUNNER_R; x <= RUNNER_X + RUNNER_R; x++) {
        const dx = x - RUNNER_X;
        const dy = y - cy;
        if (dx * dx + dy * dy <= RUNNER_R * RUNNER_R) {
          setPixel(x, y, RUNNER);
        }
      }
    }
    for (let y = cy - 6; y <= cy - 3; y++) {
      for (let x = RUNNER_X + 3; x <= RUNNER_X + 6; x++) {
        setPixel(x, y, RUNNER_EYE);
      }
    }

    return frame;
  },
});
