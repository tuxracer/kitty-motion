import type { KittyCompression } from '../types.ts';
import type { WorkerFactory } from '../kittyEncodeWorkerClient/index.ts';
import type { RendererOptionsBase } from '../rendererOptions/index.ts';

export interface KittyRendererOptions extends RendererOptionsBase {
  /** Scale factor controlling internal buffer resolution (default: DEFAULT_RENDER_SCALE, i.e. 2); display fit to the terminal is handled separately */
  scale?: number;
  /** PNG compression level 1-9 (default: DEFAULT_PNG_COMPRESSION, i.e. 5, higher = smaller but slower) */
  pngCompressionLevel?: number;
  /** Override encode-worker creation (tests, embedding) */
  encodeWorkerFactory?: WorkerFactory;
  /** Delta frames (a=f frame edits). undefined enables them only when detectKittyAnimationSupport() passed AND the file medium is unavailable (deltas save PTY bytes but cost kitty a full-frame disk round trip per edit, so they only pay off over SSH). true/false overrides. Deltas still require enableDiffRendering and an integer scale of 1 or more (default: undefined) */
  dirtyRects?: boolean;
  /** File-based transmission (t=t): undefined follows detectKittyFileTransferSupport(), true/false forces (default: undefined). When using KittyRenderer directly without an output sink, the returned payload must be written to the terminal or the frame's temp file is orphaned until the next stale sweep. */
  fileTransfer?: boolean;
  /** Kitty payload format override: "png" (f=100), "zlib" (deflate-compressed raw pixels, f=24 with o=z), or "none" (raw pixels, f=24). Applies on both mediums and in the file-write fallback. Undefined picks per medium: raw pixels on the file medium, PNG inline (default: undefined) */
  compression?: KittyCompression;
  /** Placement mode. "cursor" (default) positions the image at a cursor location and displays it directly. "unicode" transmits a virtual placement (U=1) for host-rendered Unicode placeholder cells (Kitty/Ghostty), so a TUI framework owns layout; pair with getPlaceholderRows() (default: "cursor") */
  placement?: 'cursor' | 'unicode';
}
