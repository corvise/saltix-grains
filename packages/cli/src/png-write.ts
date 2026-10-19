// Writing PNGs the image check takes (Saltix 32-images §2): 8 bits, true colour or a palette, not interlaced, and only
// IHDR, sRGB, PLTE, IDAT and IEND, so no colour profile, gamma, text or time ever reaches an icon. Each row's filter is
// chosen as libpng does (the smallest sum of its bytes as signed values), and the smaller of that and no filter at all
// is kept. A palette comes from median cut refined by k-means, with Floyd–Steinberg dithering when asked.
import { deflateSync } from "node:zlib";
import { crc32 } from "@saltix/grain-server";

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(typeBytes, data));
  return out;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** The rows of `pixels` (`bpp` bytes a pixel), each after its filter byte: adaptive (libpng's heuristic) or none. */
function filtered(pixels: Uint8Array, width: number, height: number, bpp: number, adaptive: boolean): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    if (adaptive) {
      let bestSum = Infinity;
      for (let f = 0; f < 5; f++) {
        const c = candidates[f]!;
        let sum = 0;
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? row[i - bpp]! : 0;
          const b = up ? up[i]! : 0;
          const cc = up && i >= bpp ? up[i - bpp]! : 0;
          const x = row[i]!;
          const v = f === 0 ? x : f === 1 ? x - a : f === 2 ? x - b : f === 3 ? x - ((a + b) >> 1) : x - paeth(a, b, cc);
          c[i] = v & 0xff;
          sum += c[i]! < 128 ? c[i]! : 256 - c[i]!;
        }
        if (sum < bestSum) {
          bestSum = sum;
          best = f;
        }
      }
      out[y * (stride + 1)] = best;
      out.set(candidates[best]!, y * (stride + 1) + 1);
    } else {
      out[y * (stride + 1)] = 0;
      out.set(row, y * (stride + 1) + 1);
    }
  }
  return out;
}

/** A PNG of 8-bit true colour (`rgb`, 3 bytes a pixel) or of a palette's indices (`indices` and `palette`, RGB triples),
 *  marked sRGB. */
export function encodePng(o: { width: number; height: number; rgb?: Uint8Array; indices?: Uint8Array; palette?: Uint8Array }): Uint8Array {
  const palette = o.indices !== undefined;
  const pixels = palette ? o.indices! : o.rgb!;
  const bpp = palette ? 1 : 3;
  if (pixels.length !== o.width * o.height * bpp) throw new RangeError("the pixels are not width × height");
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, o.width);
  view.setUint32(4, o.height);
  header.set([8, palette ? 3 : 2, 0, 0, 0], 8);
  // The smaller of an adaptive filter and none.
  let idat: Uint8Array | null = null;
  for (const adaptive of [true, false]) {
    const z = new Uint8Array(deflateSync(filtered(pixels, o.width, o.height, bpp, adaptive), { level: 9, memLevel: 9 }));
    if (idat === null || z.length < idat.length) idat = z;
  }
  const parts = [SIGNATURE, chunk("IHDR", header), chunk("sRGB", Uint8Array.of(0))];
  if (palette) parts.push(chunk("PLTE", o.palette!));
  parts.push(chunk("IDAT", idat!), chunk("IEND", new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Colour distance, weighted roughly as the eye weighs red, green and blue. */
const distance = (r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) =>
  2 * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + 3 * (b1 - b2) ** 2;

interface Bucket {
  r: number;
  g: number;
  b: number;
  n: number;
}

/** The nearest of `palette`'s colours (RGB triples) to one colour. */
function nearest(palette: Float64Array, count: number, r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < count; i++) {
    const d = distance(r, g, b, palette[3 * i]!, palette[3 * i + 1]!, palette[3 * i + 2]!);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * 8-bit RGB as at most `colours` (2–256) colours: its own colours when it has that few, else median cut over a histogram
 * of 6 bits a channel refined by k-means; `dither` diffuses each pixel's error (Floyd–Steinberg, serpentine).
 */
export function quantize(rgb: Uint8Array, width: number, height: number, colours: number, dither: boolean): { palette: Uint8Array; indices: Uint8Array } {
  const n = width * height;
  // Few colours: exactly them.
  const exact = new Map<number, number>();
  for (let i = 0; i < n && exact.size <= colours; i++) {
    const key = (rgb[3 * i]! << 16) | (rgb[3 * i + 1]! << 8) | rgb[3 * i + 2]!;
    if (!exact.has(key)) exact.set(key, exact.size);
  }
  if (exact.size <= colours) {
    const palette = new Uint8Array(exact.size * 3);
    for (const [key, i] of exact) palette.set([key >> 16, (key >> 8) & 0xff, key & 0xff], 3 * i);
    const indices = new Uint8Array(n);
    for (let i = 0; i < n; i++) indices[i] = exact.get((rgb[3 * i]! << 16) | (rgb[3 * i + 1]! << 8) | rgb[3 * i + 2]!)!;
    return { palette, indices };
  }
  // The histogram: 6 bits a channel, each bucket's mean colour and count.
  const count = new Uint32Array(1 << 18);
  const sums = new Float64Array(3 << 18);
  for (let i = 0; i < n; i++) {
    const key = ((rgb[3 * i]! >> 2) << 12) | ((rgb[3 * i + 1]! >> 2) << 6) | (rgb[3 * i + 2]! >> 2);
    count[key]!++;
    sums[3 * key]! += rgb[3 * i]!;
    sums[3 * key + 1]! += rgb[3 * i + 1]!;
    sums[3 * key + 2]! += rgb[3 * i + 2]!;
  }
  const buckets: Bucket[] = [];
  for (let k = 0; k < count.length; k++) {
    const c = count[k]!;
    if (c > 0) buckets.push({ r: sums[3 * k]! / c, g: sums[3 * k + 1]! / c, b: sums[3 * k + 2]! / c, n: c });
  }
  // Median cut: split the box whose widest channel, by its pixels, spreads most, at its weighted median.
  type Box = { items: Bucket[]; spread: number; channel: "r" | "g" | "b" };
  const boxOf = (items: Bucket[]): Box => {
    let best: Box = { items, spread: -1, channel: "r" };
    const total = items.reduce((s, b) => s + b.n, 0);
    for (const ch of ["r", "g", "b"] as const) {
      let lo = Infinity, hi = -Infinity;
      for (const b of items) {
        lo = Math.min(lo, b[ch]);
        hi = Math.max(hi, b[ch]);
      }
      const spread = items.length > 1 ? (hi - lo) * Math.sqrt(total) : -1;
      if (spread > best.spread) best = { items, spread, channel: ch };
    }
    return best;
  };
  const boxes: Box[] = [boxOf(buckets)];
  while (boxes.length < colours) {
    let at = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i]!.spread > 0 && (at < 0 || boxes[i]!.spread > boxes[at]!.spread)) at = i;
    if (at < 0) break;
    const box = boxes[at]!;
    const ch = box.channel;
    const sorted = [...box.items].sort((a, b) => a[ch] - b[ch]);
    const half = sorted.reduce((s, b) => s + b.n, 0) / 2;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += sorted[i]!.n;
      if (acc >= half) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    boxes.splice(at, 1, boxOf(sorted.slice(0, cut)), boxOf(sorted.slice(cut)));
  }
  let k = boxes.length;
  const palette = new Float64Array(3 * k);
  boxes.forEach((box, i) => {
    const total = box.items.reduce((s, b) => s + b.n, 0);
    palette[3 * i] = box.items.reduce((s, b) => s + b.r * b.n, 0) / total;
    palette[3 * i + 1] = box.items.reduce((s, b) => s + b.g * b.n, 0) / total;
    palette[3 * i + 2] = box.items.reduce((s, b) => s + b.b * b.n, 0) / total;
  });
  // K-means: a few rounds of moving each colour to the mean of the buckets nearest it.
  for (let round = 0; round < 3; round++) {
    const acc = new Float64Array(4 * k);
    for (const b of buckets) {
      const i = nearest(palette, k, b.r, b.g, b.b);
      acc[4 * i]! += b.r * b.n;
      acc[4 * i + 1]! += b.g * b.n;
      acc[4 * i + 2]! += b.b * b.n;
      acc[4 * i + 3]! += b.n;
    }
    for (let i = 0; i < k; i++) {
      const w = acc[4 * i + 3]!;
      if (w > 0) palette.set([acc[4 * i]! / w, acc[4 * i + 1]! / w, acc[4 * i + 2]! / w], 3 * i);
    }
  }
  const rounded = new Uint8Array(3 * k);
  for (let i = 0; i < 3 * k; i++) rounded[i] = Math.round(palette[i]!);
  for (let i = 0; i < 3 * k; i++) palette[i] = rounded[i]!;
  // Each pixel to its nearest colour, by a cache over the histogram's cells.
  const cache = new Int16Array(1 << 18).fill(-1);
  const index = (r: number, g: number, b: number) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let i = cache[key]!;
    if (i < 0) cache[key] = i = nearest(palette, k, r, g, b);
    return i;
  };
  const indices = new Uint8Array(n);
  if (!dither) {
    for (let i = 0; i < n; i++) indices[i] = index(rgb[3 * i]!, rgb[3 * i + 1]!, rgb[3 * i + 2]!);
  } else {
    const err = new Float32Array((width + 2) * 2 * 3);
    for (let y = 0; y < height; y++) {
      const ltr = y % 2 === 0;
      const cur = (y % 2) * (width + 2) * 3;
      const next = ((y + 1) % 2) * (width + 2) * 3;
      err.fill(0, next, next + (width + 2) * 3);
      for (let s = 0; s < width; s++) {
        const x = ltr ? s : width - 1 - s;
        const p = y * width + x;
        const e = cur + (x + 1) * 3;
        const r = Math.min(255, Math.max(0, rgb[3 * p]! + err[e]!));
        const g = Math.min(255, Math.max(0, rgb[3 * p + 1]! + err[e + 1]!));
        const b = Math.min(255, Math.max(0, rgb[3 * p + 2]! + err[e + 2]!));
        const i = index(Math.round(r), Math.round(g), Math.round(b));
        indices[p] = i;
        const dr = r - rounded[3 * i]!;
        const dg = g - rounded[3 * i + 1]!;
        const db = b - rounded[3 * i + 2]!;
        const dir = ltr ? 1 : -1;
        const spread = (at: number, f: number) => {
          err[at] = err[at]! + dr * f;
          err[at + 1] = err[at + 1]! + dg * f;
          err[at + 2] = err[at + 2]! + db * f;
        };
        spread(cur + (x + 1 + dir) * 3, 7 / 16);
        spread(next + (x + 1 - dir) * 3, 3 / 16);
        spread(next + (x + 1) * 3, 5 / 16);
        spread(next + (x + 1 + dir) * 3, 1 / 16);
      }
    }
  }
  k = rounded.length / 3;
  return { palette: rounded.subarray(0, 3 * k), indices };
}

/** The palettes tried, in order, when true colour is over the size: more colours and dithering first. */
export const PALETTE_STEPS: ReadonlyArray<{ colours: number; dither: boolean }> = [
  { colours: 256, dither: true }, { colours: 256, dither: false }, { colours: 128, dither: false }, { colours: 64, dither: false },
  { colours: 32, dither: false }, { colours: 16, dither: false },
];

/** 8-bit RGB as the smallest-colour-loss PNG of at most `maxBytes`: true colour when it fits, else the first palette of
 *  `PALETTE_STEPS` that does. Null when none does. */
export function fitPng(rgb: Uint8Array, width: number, height: number, maxBytes: number): { png: Uint8Array; colours: number | null; dither: boolean } | null {
  const truecolour = encodePng({ width, height, rgb });
  if (truecolour.length <= maxBytes) return { png: truecolour, colours: null, dither: false };
  for (const step of PALETTE_STEPS) {
    const { palette, indices } = quantize(rgb, width, height, step.colours, step.dither);
    const png = encodePng({ width, height, indices, palette });
    if (png.length <= maxBytes) return { png, colours: palette.length / 3, dither: step.dither };
  }
  return null;
}
