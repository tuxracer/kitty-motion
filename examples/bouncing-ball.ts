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

const frame = new Uint8Array(WIDTH * HEIGHT * 3);
let x = WIDTH / 2, y = HEIGHT / 2, dx = 1.7, dy = 1.1;

await runDemo({
  name: "bouncing-ball",
  screen: { sourceWidth: WIDTH, sourceHeight: HEIGHT },
  renderFrame: () => {
    x += dx; y += dy;
    if (x < RADIUS || x > WIDTH - RADIUS) dx = -dx;
    if (y < RADIUS || y > HEIGHT - RADIUS) dy = -dy;
    for (let py = 0; py < HEIGHT; py++) {
      for (let px = 0; px < WIDTH; px++) {
        const i = (py * WIDTH + px) * 3;
        const inside = (px - x) ** 2 + (py - y) ** 2 <= RADIUS ** 2;
        frame[i] = inside ? 255 : 20;
        frame[i + 1] = inside ? 80 : 20;
        frame[i + 2] = inside ? 80 : 40;
      }
    }
    return frame;
  },
});
