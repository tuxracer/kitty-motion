/**
 * Minimal kitty-motion demo: a ball bouncing at 60fps.
 * Run: pnpm exec tsx examples/bouncing-ball.ts
 */
import { createKittyScreen, detectKittyGraphicsSupport } from "../src";

const WIDTH = 160;
const HEIGHT = 120;
const RADIUS = 10;
const FPS = 60;

const main = async (): Promise<void> => {
  if (!(await detectKittyGraphicsSupport())) {
    console.error("This terminal does not support the Kitty graphics protocol.");
    process.exit(1);
  }

  const screen = createKittyScreen({
    sourceWidth: WIDTH,
    sourceHeight: HEIGHT,
    output: process.stdout,
  });
  process.on("SIGWINCH", () => screen.handleResize());

  const frame = new Uint8Array(WIDTH * HEIGHT * 3);
  let x = WIDTH / 2, y = HEIGHT / 2, dx = 1.7, dy = 1.1;

  const tick = (): void => {
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
    screen.pushFrame(frame);
  };

  const interval = setInterval(tick, 1000 / FPS);
  process.on("SIGINT", () => {
    clearInterval(interval);
    screen.dispose();
    process.exit(0);
  });
};

void main();
