import { describe, it, expect } from 'vitest';
import { handleKittyEncodeMessage } from '.';
import { KittyFrameEncoder, type KittyEncodeRequest, type KittyFrameMeta } from '../kittyEncode';

const meta: KittyFrameMeta = {
  sourceWidth: 2,
  sourceHeight: 2,
  scale: 2,
  scaledWidth: 4,
  scaledHeight: 4,
  pngCompressionLevel: 1,
  displayCols: 10,
  displayRows: 5,
  offsetRow: 1,
  offsetCol: 1,
  currentImageId: 1,
  previousImageId: 2,
  deletePrevious: true,
};

describe('handleKittyEncodeMessage', () => {
  it('encodes a request identically to a direct encoder call and returns the buffer', () => {
    const pixels = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const rgb = pixels.buffer.slice(0) as ArrayBuffer;
    const request: KittyEncodeRequest = { type: 'encode', meta, rgb };

    const response = handleKittyEncodeMessage(request, new KittyFrameEncoder());

    expect(response).not.toBeNull();
    expect(response!.type).toBe('encoded');
    expect(response!.rgb).toBe(rgb); // same buffer handed back for recycling
    expect(response!.payload).toBe(new KittyFrameEncoder().encode(pixels, meta));
  });

  it('ignores messages that are not encode requests', () => {
    const encoder = new KittyFrameEncoder();
    expect(handleKittyEncodeMessage(null, encoder)).toBeNull();
    expect(handleKittyEncodeMessage({ type: 'other' }, encoder)).toBeNull();
    expect(handleKittyEncodeMessage({ type: 'encode', meta }, encoder)).toBeNull(); // missing rgb
  });
});
