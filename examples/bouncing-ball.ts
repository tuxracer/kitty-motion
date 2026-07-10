/**
 * Minimal kitty-motion demo: a ball bouncing at 60fps. Mostly static frames
 * with a small moving region, the best case for dirty-rect delta rendering.
 * Run: node examples/bouncing-ball.ts
 *
 * Diagnostics stream to ./bouncing-ball.log; a config and metrics summary
 * prints to the console on Ctrl-C. See demoHarness/ for the shared plumbing.
 */
import { runDemo } from "./demoHarness/index.ts";

const WIDTH = 160;
const HEIGHT = 120;
const RADIUS = 10;
const HUE_STEP = 2; // degrees of hue advance per frame

const frame = new Uint8Array(WIDTH * HEIGHT * 3);
let x = WIDTH / 2, y = HEIGHT / 2, dx = 1.7, dy = 1.1;
let hue = 0;

/** Fully-saturated, full-value HSV to RGB (hue in degrees). */
const hueToRgb = (h: number): [number, number, number] => {
  const c = 1;
  const hp = (((h % 360) + 360) % 360) / 60;
  const xComp = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, xComp, 0]
    : hp < 2 ? [xComp, c, 0]
    : hp < 3 ? [0, c, xComp]
    : hp < 4 ? [0, xComp, c]
    : hp < 5 ? [xComp, 0, c]
    : [c, 0, xComp];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
};

await runDemo({
  name: "bouncing-ball",
  screen: { sourceWidth: WIDTH, sourceHeight: HEIGHT },
  renderFrame: () => {
    x += dx; y += dy;
    if (x < RADIUS || x > WIDTH - RADIUS) dx = -dx;
    if (y < RADIUS || y > HEIGHT - RADIUS) dy = -dy;
    hue += HUE_STEP;
    const [r, g, b] = hueToRgb(hue);
    for (let py = 0; py < HEIGHT; py++) {
      for (let px = 0; px < WIDTH; px++) {
        const i = (py * WIDTH + px) * 3;
        const inside = (px - x) ** 2 + (py - y) ** 2 <= RADIUS ** 2;
        frame[i] = inside ? r : 0;
        frame[i + 1] = inside ? g : 0;
        frame[i + 2] = inside ? b : 0;
      }
    }
    return frame;
  },
});
