// The part of pngjs (MIT) the command line uses: decoding any PNG to 8-bit RGBA.
declare module "pngjs" {
  export interface DecodedPng {
    width: number;
    height: number;
    /** RGBA, 8 bits a channel (16-bit images rescaled), straight alpha. */
    data: Buffer;
    interlace: boolean;
    colorType: number;
    depth: number;
  }
  export const PNG: {
    sync: {
      read(buffer: Buffer, options?: { skipRescale?: boolean; checkCRC?: boolean }): DecodedPng;
    };
  };
}
