import { describe, expect, it } from 'vitest';
import {
  parseKittyProbeResponse,
  buildKittyFileProbeQuery,
  detectKittyUnicodePlaceholderSupport,
  KITTY_ANIMATION_PROBE_IMAGE_ID,
  KITTY_FILE_PROBE_IMAGE_ID,
} from './index.ts';

const ID = KITTY_ANIMATION_PROBE_IMAGE_ID;

describe('parseKittyProbeResponse', () => {
  it('returns true for an OK response addressed to the requested image', () => {
    expect(parseKittyProbeResponse(`\x1b_Gi=${ID};OK\x1b\\`, ID)).toBe(true);
  });

  it('returns false for an error response addressed to the requested image', () => {
    expect(parseKittyProbeResponse(`\x1b_Gi=${ID};EINVAL:unknown action\x1b\\`, ID)).toBe(false);
  });

  it('returns true when the response carries extra keys', () => {
    expect(parseKittyProbeResponse(`\x1b_Gi=${ID},I=0;OK\x1b\\`, ID)).toBe(true);
  });

  it('returns null for empty or truncated input', () => {
    expect(parseKittyProbeResponse('', ID)).toBeNull();
    expect(parseKittyProbeResponse(`\x1b_Gi=${ID};OK`, ID)).toBeNull();
  });

  it('ignores responses for other image ids', () => {
    expect(parseKittyProbeResponse('\x1b_Gi=7;OK\x1b\\', ID)).toBeNull();
    expect(
      parseKittyProbeResponse(`\x1b_Gi=${KITTY_FILE_PROBE_IMAGE_ID};OK\x1b\\`, ID),
    ).toBeNull();
  });

  it('distinguishes the two probe ids in one stream', () => {
    const stream = `\x1b_Gi=${ID};OK\x1b\\\x1b_Gi=${KITTY_FILE_PROBE_IMAGE_ID};EBADF:err\x1b\\`;
    expect(parseKittyProbeResponse(stream, ID)).toBe(true);
    expect(parseKittyProbeResponse(stream, KITTY_FILE_PROBE_IMAGE_ID)).toBe(false);
  });
});

describe('detectKittyUnicodePlaceholderSupport', () => {
  it('returns true inside a kitty session', () => {
    expect(detectKittyUnicodePlaceholderSupport({ KITTY_WINDOW_ID: '1' })).toBe(true);
  });

  it('returns true for a ghostty terminal', () => {
    expect(detectKittyUnicodePlaceholderSupport({ TERM_PROGRAM: 'ghostty' })).toBe(true);
  });

  it('returns true when a GHOSTTY_ variable is present', () => {
    expect(detectKittyUnicodePlaceholderSupport({ GHOSTTY_RESOURCES_DIR: '/x' })).toBe(true);
  });

  it('returns false for other terminals and an empty env', () => {
    expect(detectKittyUnicodePlaceholderSupport({ TERM: 'xterm-256color' })).toBe(false);
    expect(detectKittyUnicodePlaceholderSupport({})).toBe(false);
  });
});

describe('buildKittyFileProbeQuery', () => {
  it('builds an a=q query carrying the base64 path over t=t', () => {
    const query = buildKittyFileProbeQuery('/tmp/probe.png');
    expect(query.startsWith('\x1b_G')).toBe(true);
    expect(query.endsWith('\x1b\\')).toBe(true);
    expect(query).toContain('a=q');
    expect(query).toContain(`i=${KITTY_FILE_PROBE_IMAGE_ID}`);
    expect(query).toContain('f=24');
    expect(query).toContain('s=1,v=1');
    expect(query).toContain('t=t');
    expect(query).toContain(Buffer.from('/tmp/probe.png').toString('base64'));
  });
});
