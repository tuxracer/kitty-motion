import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FRAME_FILE_PREFIX,
  newFrameFileSession,
  frameFilePath,
  sweepStaleFrameFiles,
} from './index.ts';

describe('frameFilePath', () => {
  it('builds a png path in the temp dir containing the t=t deletion marker', () => {
    const path = frameFilePath('abc', 7);
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(path).toContain('tty-graphics-protocol');
    expect(path).toContain('abc');
    expect(path.endsWith('-7.png')).toBe(true);
  });

  it('honors an explicit directory', () => {
    expect(frameFilePath('abc', 0, '/somewhere')).toBe(`/somewhere/${FRAME_FILE_PREFIX}abc-0.png`);
  });
});

describe('newFrameFileSession', () => {
  it('returns filename-safe tokens that differ between calls', () => {
    const a = newFrameFileSession();
    const b = newFrameFileSession();
    expect(a).toMatch(/^[a-z0-9-]+$/);
    expect(a).not.toBe(b);
  });
});

describe('sweepStaleFrameFiles', () => {
  it('removes only stale files carrying the frame-file prefix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'frame-files-test-'));
    try {
      const stale = join(dir, `${FRAME_FILE_PREFIX}dead-1.png`);
      const fresh = join(dir, `${FRAME_FILE_PREFIX}live-1.png`);
      const other = join(dir, 'unrelated-old-file.png');
      for (const path of [stale, fresh, other]) {
        writeFileSync(path, 'x');
      }
      const oldTime = (Date.now() - 3_600_000) / 1_000; // one hour ago, in seconds
      utimesSync(stale, oldTime, oldTime);
      utimesSync(other, oldTime, oldTime);

      sweepStaleFrameFiles(dir);

      expect(existsSync(stale)).toBe(false); // old and ours: removed
      expect(existsSync(fresh)).toBe(true); // ours but recent: kept
      expect(existsSync(other)).toBe(true); // old but not ours: kept
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a missing directory instead of throwing', () => {
    expect(() => sweepStaleFrameFiles('/no/such/dir/anywhere')).not.toThrow();
  });
});
