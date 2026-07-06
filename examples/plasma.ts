/**
 * Plasma-effect demo: every pixel changes every frame, the opposite workload
 * of bouncing-ball. Dirty rects degenerate to full-frame edits here, and the
 * smooth gradients exceed 256 colors, exercising the RGB (non-indexed) PNG
 * path. Useful for stress-testing throughput; compare its exit summary with
 * bouncing-ball's.
 * Run: node examples/plasma.ts
 */
import { runDemo } from "./demoHarness/index.ts";

const WIDTH = 128;
const HEIGHT = 96;
const FPS = 30;

const frame = new Uint8Array(WIDTH * HEIGHT * 3);

await runDemo({
  name: "plasma",
  fps: FPS,
  screen: { sourceWidth: WIDTH, sourceHeight: HEIGHT },
  renderFrame: (tick) => {
    const t = tick / 8;
    for (let py = 0; py < HEIGHT; py++) {
      for (let px = 0; px < WIDTH; px++) {
        const v =
          Math.sin(px / 12 + t) +
          Math.sin(py / 9 - t / 2) +
          Math.sin((px + py) / 16 + t / 3) +
          Math.sin(Math.hypot(px - WIDTH / 2, py - HEIGHT / 2) / 10 - t);
        const i = (py * WIDTH + px) * 3;
        frame[i] = (Math.sin(v * Math.PI / 2) * 127 + 128) | 0;
        frame[i + 1] = (Math.sin(v * Math.PI / 2 + 2) * 127 + 128) | 0;
        frame[i + 2] = (Math.sin(v * Math.PI / 2 + 4) * 127 + 128) | 0;
      }
    }
    return frame;
  },
});
