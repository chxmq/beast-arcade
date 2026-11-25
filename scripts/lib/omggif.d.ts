declare module 'omggif' {
  export interface GifFrameInfo {
    x: number;
    y: number;
    width: number;
    height: number;
    has_local_palette: boolean;
    palette_offset: number | null;
    palette_size: number | null;
    data_offset: number;
    data_length: number;
    transparent_index: number | null;
    interlaced: boolean;
    delay: number;
    disposal: number;
  }

  export interface GifWriterOptions {
    loop?: number;
    /** Array of 0xRRGGBB, length a power of two in [2, 256]. */
    palette?: number[];
    background?: number;
  }

  export interface GifFrameOptions {
    palette?: number[];
    delay?: number;
    disposal?: number;
    transparent?: number;
  }

  export class GifWriter {
    constructor(buf: Uint8Array, width: number, height: number, opts?: GifWriterOptions);
    addFrame(x: number, y: number, w: number, h: number, indexedPixels: ArrayLike<number>, opts?: GifFrameOptions): number;
    end(): number;
  }

  export class GifReader {
    constructor(buf: Uint8Array);
    width: number;
    height: number;
    numFrames(): number;
    loopCount(): number | null;
    frameInfo(frameNum: number): GifFrameInfo;
    decodeAndBlitFrameRGBA(frameNum: number, pixels: Uint8Array | Uint8ClampedArray): void;
    decodeAndBlitFrameBGRA(frameNum: number, pixels: Uint8Array | Uint8ClampedArray): void;
  }
}
