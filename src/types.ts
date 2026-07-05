/** Color space of a decoded framebuffer */
export type ColorSpace = "rgb15" | "rgb24";

/** Type alias for framebuffer data */
export type FrameBuffer = Uint8Array | Uint16Array;

/** Narrows a framebuffer to Uint16Array when colorSpace is 'rgb15' */
export const isRgb15Buffer = (
  colorSpace: ColorSpace,
  _buffer: FrameBuffer,
): _buffer is Uint16Array => colorSpace === "rgb15";
