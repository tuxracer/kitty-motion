import { describe, expect, it } from "vitest";
import { PNG_SIGNATURE, createPngChunk, rgbToIndexed } from ".";

describe("createPngChunk", () => {
  it("produces length + type + data + crc layout", () => {
    const chunk = createPngChunk("IEND", Buffer.alloc(0));
    expect(chunk.length).toBe(12);
    expect(chunk.readUInt32BE(0)).toBe(0);
    expect(chunk.subarray(4, 8).toString("ascii")).toBe("IEND");
    expect(chunk.readUInt32BE(8)).toBe(0xae426082); // well-known IEND CRC
  });
});

describe("rgbToIndexed", () => {
  it("maps a two-color image to two palette entries", () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 255]);
    const result = rgbToIndexed(rgb, 2, 2);
    expect(result).not.toBeNull();
    expect(result?.colorCount).toBe(2);
    expect(Array.from(result?.indices ?? [])).toEqual([0, 1, 0, 1]);
  });

  it("returns null above 256 unique colors", () => {
    const pixels = 17 * 17; // 289 unique colors
    const rgb = new Uint8Array(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      rgb[i * 3] = i % 256;
      rgb[i * 3 + 1] = Math.floor(i / 256);
      rgb[i * 3 + 2] = 7;
    }
    expect(rgbToIndexed(rgb, 17, 17)).toBeNull();
  });
});

it("PNG_SIGNATURE is the 8-byte magic", () => {
  expect(Array.from(PNG_SIGNATURE)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});
