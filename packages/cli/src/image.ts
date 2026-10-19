// Pictures for `grain icon` (Saltix 32-images §3): any PNG or JPEG decoded to 8-bit sRGB RGBA — its colour profile
// converted (ICC matrix-and-curves profiles: Display P3, Adobe RGB and the like; a PNG's gamma), a JPEG's EXIF orientation
// applied — and resampled with a Lanczos-3 filter, premultiplied, straight from the source's own pixels. What it writes is
// png-write.ts's.
import { inflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

/** A picture in memory: RGBA, 8 bits a channel, straight alpha, sRGB, rows top to bottom. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A picture `grain icon` cannot read, and why. */
export class PictureError extends Error {
  constructor(public readonly reason: "format" | "too_large" | "unreadable", message: string) {
    super(message);
    this.name = "PictureError";
  }
}

/** The largest picture decoded: 100 megapixels. */
const MAX_PIXELS = 100_000_000;

/** What decoding found besides the pixels: notes for the developer (a profile converted, an orientation applied). */
export interface Decoded {
  image: Rgba;
  format: "png" | "jpeg";
  notes: string[];
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** Decode a PNG or a JPEG; anything else is refused with what to do. */
export function decodePicture(bytes: Uint8Array): Decoded {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return decodePng(bytes);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return decodeJpeg(bytes);
  const what = ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP" ? "a WebP"
    : ascii(bytes, 0, 3) === "GIF" ? "a GIF"
    : ascii(bytes, 4, 4) === "ftyp" ? "a HEIC or AVIF"
    : /^\s*</.test(ascii(bytes, 0, 64)) ? "an SVG (a drawing, not pixels)" : "not a PNG or a JPEG";
  throw new PictureError("format", `${what}: grain icon reads PNG and JPEG pictures; export it as a PNG first (at 1024 × 1024 or more for a drawing)`);
}

// --- PNG ---

function decodePng(bytes: Uint8Array): Decoded {
  // The header first: a picture too large to hold is refused before a byte is inflated.
  const width = (bytes[16]! << 24 | bytes[17]! << 16 | bytes[18]! << 8 | bytes[19]!) >>> 0;
  const height = (bytes[20]! << 24 | bytes[21]! << 16 | bytes[22]! << 8 | bytes[23]!) >>> 0;
  if (ascii(bytes, 12, 4) !== "IHDR" || width === 0 || height === 0) throw new PictureError("unreadable", "a PNG without its header");
  if (width * height > MAX_PIXELS) throw new PictureError("too_large", `${width} × ${height}: at most ${MAX_PIXELS / 1e6} megapixels`);
  let png;
  try {
    png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  } catch (e) {
    throw new PictureError("unreadable", `the PNG does not decode (${(e as Error).message})`);
  }
  const image: Rgba = { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
  const notes: string[] = [];
  // Its colours: an ICC profile wins, then sRGB, then a gamma of its own.
  let icc: Uint8Array | null = null;
  let srgb = false;
  let gamma: number | null = null;
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = (bytes[at]! << 24 | bytes[at + 1]! << 16 | bytes[at + 2]! << 8 | bytes[at + 3]!) >>> 0;
    const type = ascii(bytes, at + 4, 4);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "iCCP") {
      const nul = data.indexOf(0);
      try {
        if (nul > 0 && data[nul + 1] === 0) icc = new Uint8Array(inflateSync(data.subarray(nul + 2)));
      } catch {
        notes.push("its colour profile does not read: its colours are taken as sRGB");
      }
    } else if (type === "sRGB") srgb = true;
    else if (type === "gAMA" && length === 4) gamma = ((data[0]! << 24 | data[1]! << 16 | data[2]! << 8 | data[3]!) >>> 0) / 100_000;
    else if (type === "IDAT" || type === "IEND") break;
    at += 12 + length;
  }
  if (icc) notes.push(...toSrgb(image, icc));
  else if (!srgb && gamma !== null && gamma > 0 && Math.abs(gamma - 1 / 2.2) > 0.005) {
    applyGamma(image, gamma);
    notes.push(`its gamma (${gamma.toFixed(3)}) converted to sRGB`);
  }
  return { image, format: "png", notes };
}

// --- JPEG ---

function decodeJpeg(bytes: Uint8Array): Decoded {
  // Its segments before the first scan: the frame's size, EXIF's orientation and an ICC profile (in APP2 pieces).
  let orientation = 1;
  const pieces: Array<{ n: number; data: Uint8Array }> = [];
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    const data = bytes.subarray(at + 4, at + 2 + length);
    if ((marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && data.length >= 5) {
      const h = (data[1]! << 8) | data[2]!;
      const w = (data[3]! << 8) | data[4]!;
      if (w * h > MAX_PIXELS) throw new PictureError("too_large", `${w} × ${h}: at most ${MAX_PIXELS / 1e6} megapixels`);
    }
    if (marker === 0xe1 && ascii(data, 0, 6) === "Exif\0\0") orientation = exifOrientation(data.subarray(6)) ?? 1;
    if (marker === 0xe2 && ascii(data, 0, 12) === "ICC_PROFILE\0") pieces.push({ n: data[12]!, data: data.subarray(14) });
    at += 2 + length;
  }
  let decoded;
  try {
    decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 2048 });
  } catch (e) {
    throw new PictureError("unreadable", `the JPEG does not decode (${(e as Error).message})`);
  }
  let image: Rgba = { width: decoded.width, height: decoded.height, data: decoded.data };
  const notes: string[] = [];
  if (pieces.length > 0) {
    pieces.sort((a, b) => a.n - b.n);
    const total = pieces.reduce((n, p) => n + p.data.length, 0);
    const icc = new Uint8Array(total);
    let at = 0;
    for (const p of pieces) {
      icc.set(p.data, at);
      at += p.data.length;
    }
    notes.push(...toSrgb(image, icc));
  }
  if (orientation !== 1) {
    image = orient(image, orientation);
    notes.push(`turned as its EXIF orientation (${orientation}) says`);
  }
  return { image, format: "jpeg", notes };
}

/** EXIF's orientation (tag 0x0112 of IFD0), 1–8, or null. */
function exifOrientation(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49;
  const u16 = (at: number) => (at + 2 <= tiff.length ? (little ? tiff[at]! | (tiff[at + 1]! << 8) : (tiff[at]! << 8) | tiff[at + 1]!) : 0);
  const u32 = (at: number) => (at + 4 <= tiff.length
    ? (little ? (tiff[at]! | (tiff[at + 1]! << 8) | (tiff[at + 2]! << 16) | (tiff[at + 3]! << 24)) : ((tiff[at]! << 24) | (tiff[at + 1]! << 16) | (tiff[at + 2]! << 8) | tiff[at + 3]!)) >>> 0
    : 0);
  const ifd = u32(4);
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + 12 * i;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** The picture as EXIF's orientation `o` (2–8) says it should be seen. */
export function orient(img: Rgba, o: number): Rgba {
  const swap = o >= 5;
  const width = swap ? img.height : img.width;
  const height = swap ? img.width : img.height;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Where the shown pixel (x, y) is in the stored picture.
      let sx: number, sy: number;
      switch (o) {
        case 2: sx = img.width - 1 - x; sy = y; break;
        case 3: sx = img.width - 1 - x; sy = img.height - 1 - y; break;
        case 4: sx = x; sy = img.height - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = img.height - 1 - x; break;
        case 7: sx = img.width - 1 - y; sy = img.height - 1 - x; break;
        case 8: sx = img.width - 1 - y; sy = x; break;
        default: sx = x; sy = y;
      }
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data: out };
}

// --- Colour ---

/** sRGB's transfer function, decoding and encoding (0–1). */
export const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** sRGB's primaries adapted to D50 (Bradford), the ICC's connection space, and back. */
const SRGB_TO_XYZ_D50 = [0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];
const XYZ_D50_TO_SRGB = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914, 1.4052427];

const LINEAR_STEPS = 4096;
/** Linear light (0–1) to an 8-bit sRGB value, by table. */
const ENCODE = (() => {
  const t = new Uint8Array(LINEAR_STEPS + 1);
  for (let i = 0; i <= LINEAR_STEPS; i++) t[i] = Math.round(255 * linearToSrgb(i / LINEAR_STEPS));
  return t;
})();
const encodeLinear = (v: number) => ENCODE[Math.round(Math.min(1, Math.max(0, v)) * LINEAR_STEPS)]!;

/** A PNG's own gamma (its encoding exponent) converted to sRGB's curve. */
function applyGamma(img: Rgba, gamma: number): void {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[i] = encodeLinear((i / 255) ** (1 / gamma));
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = table[img.data[i]!]!;
    img.data[i + 1] = table[img.data[i + 1]!]!;
    img.data[i + 2] = table[img.data[i + 2]!]!;
  }
}

/** A tone curve of an ICC profile (`curv` or `para`) as a table from 8-bit values to linear light; null for one this
 *  reader does not know. */
function toneCurve(icc: Uint8Array, at: number): Float64Array | null {
  const be16 = (o: number) => (icc[o]! << 8) | icc[o + 1]!;
  const s15 = (o: number) => (((icc[o]! << 24) | (icc[o + 1]! << 16) | (icc[o + 2]! << 8) | icc[o + 3]!) | 0) / 65536;
  const type = ascii(icc, at, 4);
  const table = new Float64Array(256);
  if (type === "curv") {
    const n = ((icc[at + 8]! << 24) | (icc[at + 9]! << 16) | (icc[at + 10]! << 8) | icc[at + 11]!) >>> 0;
    if (n === 0) for (let i = 0; i < 256; i++) table[i] = i / 255;
    else if (n === 1) {
      const g = be16(at + 12) / 256;
      for (let i = 0; i < 256; i++) table[i] = (i / 255) ** g;
    } else {
      if (at + 12 + 2 * n > icc.length) return null;
      for (let i = 0; i < 256; i++) {
        const p = (i / 255) * (n - 1);
        const lo = Math.floor(p);
        const hi = Math.min(n - 1, lo + 1);
        table[i] = (be16(at + 12 + 2 * lo) * (hi - p + (hi === lo ? 1 : 0)) + be16(at + 12 + 2 * hi) * (p - lo)) / 65535;
      }
    }
    return table;
  }
  if (type === "para") {
    const fn = be16(at + 8);
    const counts = [1, 3, 4, 5, 7];
    if (fn > 4) return null;
    const p = Array.from({ length: counts[fn]! }, (_, i) => s15(at + 12 + 4 * i));
    const [g, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = p as [number, ...number[]];
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let y: number;
      switch (fn) {
        case 0: y = x ** g; break;
        case 1: y = x >= -b / a ? (a * x + b) ** g : 0; break;
        case 2: y = x >= -b / a ? (a * x + b) ** g + c : c; break;
        case 3: y = x >= d ? (a * x + b) ** g : c * x; break;
        default: y = x >= d ? (a * x + b) ** g + e : c * x + f;
      }
      table[i] = Math.min(1, Math.max(0, y));
    }
    return table;
  }
  return null;
}

/**
 * Convert `img` in place from the colours of an ICC profile to sRGB: a matrix-and-curves RGB profile (what phones and
 * design tools write: Display P3, Adobe RGB, ProPhoto), through the D50 connection space. A profile that is sRGB's
 * already, a grey one, or one built of lookup tables is left as it is; the notes say what was done.
 */
export function toSrgb(img: Rgba, icc: Uint8Array): string[] {
  if (icc.length < 132 || ascii(icc, 36, 4) !== "acsp") return ["its colour profile does not read: its colours are taken as sRGB"];
  if (ascii(icc, 16, 4) !== "RGB ") return [];
  const count = ((icc[128]! << 24) | (icc[129]! << 16) | (icc[130]! << 8) | icc[131]!) >>> 0;
  const tags = new Map<string, number>();
  for (let i = 0; i < count && 132 + 12 * i + 12 <= icc.length; i++) {
    const at = 132 + 12 * i;
    const offset = ((icc[at + 4]! << 24) | (icc[at + 5]! << 16) | (icc[at + 6]! << 8) | icc[at + 7]!) >>> 0;
    if (offset < icc.length) tags.set(ascii(icc, at, 4), offset);
  }
  const xyz = (tag: string): number[] | null => {
    const at = tags.get(tag);
    if (at === undefined || ascii(icc, at, 4) !== "XYZ " || at + 20 > icc.length) return null;
    const s15 = (o: number) => (((icc[o]! << 24) | (icc[o + 1]! << 16) | (icc[o + 2]! << 8) | icc[o + 3]!) | 0) / 65536;
    return [s15(at + 8), s15(at + 12), s15(at + 16)];
  };
  const [r, g, b] = [xyz("rXYZ"), xyz("gXYZ"), xyz("bXYZ")];
  const curves = ["rTRC", "gTRC", "bTRC"].map((t) => (tags.has(t) ? toneCurve(icc, tags.get(t)!) : null));
  if (!r || !g || !b || curves.some((c) => c === null)) return ["its colour profile is built of lookup tables, which grain icon does not convert: its colours are taken as sRGB"];
  // The profile's matrix, columns its primaries in D50. sRGB's own primaries and curves: nothing to convert.
  const m = [r[0]!, g[0]!, b[0]!, r[1]!, g[1]!, b[1]!, r[2]!, g[2]!, b[2]!];
  const srgbCurve = (c: Float64Array) => c.every((v, i) => Math.abs(v - srgbToLinear(i / 255)) < 0.004);
  if (m.every((v, i) => Math.abs(v - SRGB_TO_XYZ_D50[i]!) < 0.003) && (curves as Float64Array[]).every(srgbCurve)) return [];
  // Source linear → XYZ D50 → sRGB linear, as one matrix.
  const t = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) t[3 * i + j]! += XYZ_D50_TO_SRGB[3 * i + k]! * m[3 * k + j]!;
  const [cr, cg, cb] = curves as [Float64Array, Float64Array, Float64Array];
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lr = cr[d[i]!]!;
    const lg = cg[d[i + 1]!]!;
    const lb = cb[d[i + 2]!]!;
    d[i] = encodeLinear(t[0]! * lr + t[1]! * lg + t[2]! * lb);
    d[i + 1] = encodeLinear(t[3]! * lr + t[4]! * lg + t[5]! * lb);
    d[i + 2] = encodeLinear(t[6]! * lr + t[7]! * lg + t[8]! * lb);
  }
  return ["its colour profile converted to sRGB"];
}

// --- Resampling ---

/** Lanczos-3. */
const lanczos = (x: number) => {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
};

/** How destination pixels map onto the source: pixel `u`'s centre falls at `x0 + (u + 0.5) * sx` (source pixels span
 *  [i, i + 1)), and likewise down. */
export interface Mapping {
  x0: number;
  y0: number;
  sx: number;
  sy: number;
}

/** One axis's filter: for each destination pixel, the source pixels and their weights. */
function weights(dst: number, start: number, scale: number): Array<{ first: number; w: Float64Array; total: number }> {
  const f = Math.max(scale, 1);
  const support = 3 * f;
  const out = [];
  for (let u = 0; u < dst; u++) {
    const centre = start + (u + 0.5) * scale;
    const first = Math.floor(centre - support);
    const last = Math.ceil(centre + support);
    const w = new Float64Array(last - first);
    let total = 0;
    for (let i = first; i < last; i++) {
      const v = lanczos((i + 0.5 - centre) / f);
      w[i - first] = v;
      total += v;
    }
    out.push({ first, w, total: total || 1 });
  }
  return out;
}

/**
 * Resample `img` to `width` × `height` by `map`: premultiplied RGBA in 0–1, sRGB values, as Float32 four to a pixel.
 * Outside the source is transparent (`edge: "transparent"`, a picture placed on a canvas) or its edge's pixels
 * (`"clamp"`, a picture that covers it).
 */
export function resample(img: Rgba, map: Mapping, width: number, height: number, edge: "transparent" | "clamp"): Float32Array {
  const xs = weights(width, map.x0, map.sx);
  const ys = weights(height, map.y0, map.sy);
  // The source rows the vertical pass needs.
  const top = Math.max(0, Math.min(...ys.map((y) => y.first)));
  const bottom = Math.min(img.height, Math.max(...ys.map((y) => y.first + y.w.length)));
  const rows = Math.max(0, bottom - top);
  // Horizontally first: each needed source row to `width` pixels.
  const mid = new Float32Array(rows * width * 4);
  const d = img.data;
  for (let r = 0; r < rows; r++) {
    const row = (top + r) * img.width * 4;
    for (let u = 0; u < width; u++) {
      const { first, w, total } = xs[u]!;
      let R = 0, G = 0, B = 0, A = 0;
      for (let k = 0; k < w.length; k++) {
        let i = first + k;
        if (i < 0 || i >= img.width) {
          if (edge === "transparent") continue;
          i = i < 0 ? 0 : img.width - 1;
        }
        const p = row + 4 * i;
        const a = d[p + 3]! / 255;
        const wk = w[k]! * a;
        R += wk * d[p]!;
        G += wk * d[p + 1]!;
        B += wk * d[p + 2]!;
        A += w[k]! * a;
      }
      const o = (r * width + u) * 4;
      mid[o] = R / 255 / total;
      mid[o + 1] = G / 255 / total;
      mid[o + 2] = B / 255 / total;
      mid[o + 3] = A / total;
    }
  }
  const out = new Float32Array(width * height * 4);
  for (let v = 0; v < height; v++) {
    const { first, w, total } = ys[v]!;
    for (let u = 0; u < width; u++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let k = 0; k < w.length; k++) {
        let j = first + k;
        if (j < 0 || j >= img.height) {
          if (edge === "transparent") continue;
          j = j < 0 ? 0 : img.height - 1;
        }
        const p = ((j - top) * width + u) * 4;
        R += w[k]! * mid[p]!;
        G += w[k]! * mid[p + 1]!;
        B += w[k]! * mid[p + 2]!;
        A += w[k]! * mid[p + 3]!;
      }
      const o = (v * width + u) * 4;
      // Lanczos rings a little past 0 and 1: clamp, keeping colour within alpha.
      const a = Math.min(1, Math.max(0, A / total));
      out[o] = Math.min(a, Math.max(0, R / total));
      out[o + 1] = Math.min(a, Math.max(0, G / total));
      out[o + 2] = Math.min(a, Math.max(0, B / total));
      out[o + 3] = a;
    }
  }
  return out;
}

/** A premultiplied picture over an opaque colour (0–255 each): 8-bit RGB. */
export function over(premultiplied: Float32Array, background: readonly [number, number, number]): Uint8Array {
  const n = premultiplied.length / 4;
  const out = new Uint8Array(n * 3);
  const [br, bg, bb] = background.map((c) => c / 255) as [number, number, number];
  for (let i = 0; i < n; i++) {
    const a = premultiplied[4 * i + 3]!;
    out[3 * i] = Math.round(255 * Math.min(1, premultiplied[4 * i]! + br * (1 - a)));
    out[3 * i + 1] = Math.round(255 * Math.min(1, premultiplied[4 * i + 1]! + bg * (1 - a)));
    out[3 * i + 2] = Math.round(255 * Math.min(1, premultiplied[4 * i + 2]! + bb * (1 - a)));
  }
  return out;
}

/** 8-bit RGB as RGBA, opaque. */
export function rgbToRgba(rgb: Uint8Array, width: number, height: number): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    data[j] = rgb[i]!;
    data[j + 1] = rgb[i + 1]!;
    data[j + 2] = rgb[i + 2]!;
    data[j + 3] = 255;
  }
  return { width, height, data };
}
