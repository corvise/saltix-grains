// `grain icon`: a mini-app's icon to Saltix's standard (32-images §3, docs/icons.md), made from any picture and checked.
//
// The master: 512 × 512, PNG, 8 bits, opaque and full bleed (the wallet cuts the rounded square, corners 0.26 of the side,
// never the developer), sRGB without a profile or gamma, no metadata, at most 64 KiB; the mark inside the keyline circle
// (5/12 of the side from the centre), the outer 1/16 of each side left to the ground. `makeIcon` makes one from any PNG
// or JPEG: the picture fitted (`crop`, `contain` or `mark`), transparency flattened onto a background, converted to sRGB,
// resampled with a Lanczos filter from the picture's own pixels, and written in true colour, or with a palette when that
// is what fits 64 KiB. `checkIcon` is §3.4's checks, `iconPreview` the icon as wallets draw it at 24, 40, 56 and 96 dp on
// a dark and a light theme, beside its zones.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { ICON_SIDE, LEGACY_ICON_SIDE, MAX_ICON_BYTES, NAMED_REASONS, checkImage, iconHash } from "@saltix/grain-server";
import { grainDir } from "./devlog.js";
import { type Mapping, type Rgba, decodePicture, over, resample } from "./image.js";
import { encodePng, fitPng } from "./png-write.js";
import { inkFor, monogramGround, monogramPixels, monogramText } from "./monogram.js";

/** Where a project keeps the icon its manifest names: beside `grain.json`, or with the page. */
export const ICON_FILES = ["icon.png", "public/icon.png"];

/** The mask's corner radius, as a fraction of the side (32-images §3.2). */
export const MASK_CORNER = 0.26;
/** The keyline circle's radius (§3.3), and the edge band's width, as fractions of the side. */
export const KEYLINE_RADIUS = 5 / 12;
export const EDGE_BAND = 1 / 16;
/** The sizes wallets draw icons at (§3.2), in dp. */
export const PREVIEW_SIZES = [24, 40, 56, 96] as const;

/** How a picture fills the square: `crop` covers it and cuts what overflows (full-bleed art, a photo); `contain` shows
 *  the whole picture with the background around it; `mark` fits the picture's mark (its pixels that are not background)
 *  inside the keyline circle (a logo). */
export type Fit = "crop" | "contain" | "mark";

export type Colour = readonly [number, number, number];

export const hexColour = (c: Colour) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

/** `#rrggbb` (or `rrggbb`, `#rgb`) as a colour, or null. */
export function parseColour(text: string): Colour | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(text.trim());
  if (!m) return null;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Colour;
}

/** A light and a dark ground for a mark on transparency: neither is the wallet's own white or black. */
const LIGHT_GROUND: Colour = [0xf2, 0xf4, 0xf7];
const DARK_GROUND: Colour = [0x10, 0x18, 0x20];

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
};

/** The four corners' squares of a picture (side `n`): their pixels' RGBA. */
function corners(img: Rgba, n: number): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  const size = Math.max(1, Math.min(n, img.width, img.height));
  for (const [cx, cy] of [[0, 0], [img.width - size, 0], [0, img.height - size], [img.width - size, img.height - size]] as const) {
    for (let y = cy; y < cy + size; y++) {
      for (let x = cx; x < cx + size; x++) {
        const p = (y * img.width + x) * 4;
        out.push([img.data[p]!, img.data[p + 1]!, img.data[p + 2]!, img.data[p + 3]!]);
      }
    }
  }
  return out;
}

/** What a picture's corners say: their median colour and alpha. */
function cornerColour(img: Rgba): { colour: Colour; alpha: number } {
  const px = corners(img, Math.max(1, Math.round(Math.min(img.width, img.height) / 32)));
  return { colour: [0, 1, 2].map((c) => median(px.map((p) => p[c]!))) as unknown as Colour, alpha: median(px.map((p) => p[3])) };
}

/** Whether a pixel is part of the mark: opaque enough and, on an opaque ground, apart from the ground's colour by more
 *  than 24 in a channel (§3.4). */
const inkOf = (img: Rgba, ground: Colour | null) => (p: number) => {
  const a = img.data[p + 3]!;
  if (a < 32) return false;
  if (ground === null) return true;
  return Math.abs(img.data[p]! - ground[0]) > 24 || Math.abs(img.data[p + 1]! - ground[1]) > 24 || Math.abs(img.data[p + 2]! - ground[2]) > 24;
};

/** The box of the mark's pixels and the farthest of them from the box's centre (in the picture's pixels); null when the
 *  picture is all ground. */
function markOf(img: Rgba, ground: Colour | null): { x0: number; y0: number; x1: number; y1: number; radius: number } | null {
  const ink = inkOf(img, ground);
  // Every pixel of a small picture, every n-th of a large one: the box is about the same.
  const step = Math.max(1, Math.floor(Math.max(img.width, img.height) / 1024));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const points: number[] = [];
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      if (!ink((y * img.width + x) * 4)) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
      points.push(x, y);
    }
  }
  if (points.length === 0) return null;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let radius = 0;
  for (let i = 0; i < points.length; i += 2) {
    // A pixel's farthest corner from the centre.
    const dx = Math.max(Math.abs(points[i]! - cx), Math.abs(points[i]! + step - cx));
    const dy = Math.max(Math.abs(points[i + 1]! - cy), Math.abs(points[i + 1]! + step - cy));
    radius = Math.max(radius, Math.hypot(dx, dy));
  }
  return { x0, y0, x1, y1, radius };
}

/** The background a picture is flattened onto: the one asked for; else its corners' colour when they are opaque; else
 *  a light ground for a dark mark and a dark one for a light mark. */
function groundFor(img: Rgba, asked: Colour | null): { colour: Colour; why: string } {
  if (asked) return { colour: asked, why: "as asked" };
  const c = cornerColour(img);
  if (c.alpha >= 250) return { colour: c.colour, why: "the picture's corners" };
  // The mark's mean luminance, weighted by its alpha.
  let sum = 0;
  let weight = 0;
  for (let p = 0; p < img.data.length; p += 4) {
    const a = img.data[p + 3]! / 255;
    if (a < 0.1) continue;
    sum += a * (0.2126 * img.data[p]! + 0.7152 * img.data[p + 1]! + 0.0722 * img.data[p + 2]!);
    weight += a;
  }
  const light = weight > 0 && sum / weight / 255 > 0.55;
  return { colour: light ? DARK_GROUND : LIGHT_GROUND, why: `transparent corners: a ${light ? "dark" : "light"} ground for a ${light ? "light" : "dark"} mark` };
}

export interface MadeIcon {
  png: Uint8Array;
  hash: string;
  fit: Fit;
  background: Colour;
  /** Why that background. */
  backgroundWhy: string;
  /** Colours of its palette, or null for true colour. */
  colours: number | null;
  /** What was done that the developer should know: a profile converted, an orientation applied, an upscale. */
  notes: string[];
}

/** An icon the image check refuses, or a picture `grain icon` could not make one of. */
export class IconError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = "IconError";
  }
}

/** A 512 × 512 icon to the standard from any PNG or JPEG's bytes. */
export function makeIcon(bytes: Uint8Array, options: { fit?: Fit; background?: Colour | null } = {}): MadeIcon {
  const { image: img, notes } = decodePicture(bytes);
  const transparent = cornerColour(img).alpha < 250;
  const fit: Fit = options.fit ?? (transparent ? "mark" : "crop");
  const ground = groundFor(img, options.background ?? null);
  const side = ICON_SIDE;
  let map: Mapping;
  let edge: "transparent" | "clamp" = "transparent";
  if (fit === "crop") {
    const s = Math.max(side / img.width, side / img.height);
    map = { x0: (img.width - side / s) / 2, y0: (img.height - side / s) / 2, sx: 1 / s, sy: 1 / s };
    edge = "clamp";
    if (img.width !== img.height) notes.push(`cropped to a square: ${Math.round((1 - Math.min(img.width, img.height) / Math.max(img.width, img.height)) * 100)}% of its ${img.width > img.height ? "width" : "height"} cut`);
  } else if (fit === "contain") {
    const s = Math.min(side / img.width, side / img.height);
    map = { x0: (img.width - side / s) / 2, y0: (img.height - side / s) / 2, sx: 1 / s, sy: 1 / s };
  } else {
    // The mark centred, its farthest pixel just inside the keyline circle (a hair inside, for the filter's edge).
    const mark = markOf(img, transparent ? null : cornerColour(img).colour);
    if (mark === null) throw new IconError("empty", "the picture has no mark: every pixel is its background (pass --fit crop for a picture that is all ground)");
    const s = (KEYLINE_RADIUS * side * 0.97) / mark.radius;
    const cx = (mark.x0 + mark.x1) / 2;
    const cy = (mark.y0 + mark.y1) / 2;
    map = { x0: cx - side / 2 / s, y0: cy - side / 2 / s, sx: 1 / s, sy: 1 / s };
  }
  const scale = 1 / map.sx;
  if (scale > 1.5) notes.push(`upscaled ${scale.toFixed(1)}×: a picture of at least ${Math.ceil(img.width * scale)} px across would be sharper`);
  const rgb = over(resample(img, map, side, side, edge), ground.colour);
  const fitted = fitPng(rgb, side, side, MAX_ICON_BYTES);
  if (fitted === null) {
    throw new IconError("size", "the picture is too detailed to fit 64 KiB even with 16 colours: simplify it (fewer textures, flat colours)");
  }
  const checked = checkImage("grain_icon", fitted.png);
  if (!checked.ok) throw new IconError(checked.reason, `the icon made fails the image check (${checked.reason}): a bug in grain icon, please report it`);
  if (fitted.colours !== null) notes.push(`reduced to a palette of ${fitted.colours} colours${fitted.dither ? ", dithered," : ""} to fit 64 KiB`);
  return { png: fitted.png, hash: iconHash(fitted.png), fit, background: ground.colour, backgroundWhy: ground.why, colours: fitted.colours, notes };
}

/** What §3.4 says of an icon: errors (every wallet refuses it) and warnings, and what it measured. */
export interface IconLint {
  errors: string[];
  warnings: string[];
  /** Its sides, the share of the keyline's ring that is not ground, and the mark's box as a share of the side. */
  width?: number;
  ring?: number;
  mark?: { width: number; height: number } | null;
}

/** §3.4's checks of an icon's bytes: the image check, the hash a manifest names it by (`expected`, unless zero), and
 *  the warnings: 256 × 256, the mark outside the keyline circle, a small mark, a ground that vanishes on a theme. */
export function checkIcon(bytes: Uint8Array, expected?: string): IconLint {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checked = checkImage("grain_icon", bytes);
  if (!checked.ok) {
    errors.push(`the image check: ${checked.reason} (${NAMED_REASONS[checked.reason]}); grain icon <picture> --out icon.png makes one that passes`);
    return { errors, warnings };
  }
  if (expected !== undefined && iconHash(bytes) !== expected) {
    errors.push(`its hash is ${iconHash(bytes)}, but grain.json's "icon" is ${expected}: set "icon" to it (grain icon prints it)`);
  }
  const side = checked.value.width;
  if (side === LEGACY_ICON_SIDE) warnings.push("256 × 256: wallets take it, soft on large screens; the standard is 512 × 512 (grain icon icon.png --out icon.png)");
  let img: Rgba;
  try {
    const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    img = { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  } catch (e) {
    errors.push(`it does not decode (${(e as Error).message})`);
    return { errors, warnings };
  }
  // The ground: the median colour of the four corners' squares (16 × 16 at 512).
  const ground = cornerColour({ ...img, data: img.data }).colour;
  const cornerPx = corners(img, side / 32);
  const ink = inkOf(img, ground);
  const centre = side / 2;
  const keyline = KEYLINE_RADIUS * side;
  const band = EDGE_BAND * side;
  let ringPixels = 0;
  let ringInk = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const p = (y * side + x) * 4;
      const isInk = ink(p);
      if (isInk) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
      const inBand = x < band || y < band || x >= side - band || y >= side - band;
      if (!inBand && Math.hypot(x + 0.5 - centre, y + 0.5 - centre) > keyline) {
        ringPixels++;
        if (isInk) ringInk++;
      }
    }
  }
  const ring = ringPixels > 0 ? ringInk / ringPixels : 0;
  if (ring > 0.02) {
    warnings.push(`the mark reaches outside the keyline circle: ${(ring * 100).toFixed(1)}% of the ring between it and the edge band is not ground (2% at most); wallets cut and light the edge there (grain icon <picture> --fit mark --out icon.png fits a mark inside)`);
  }
  const mark = x1 > x0 ? { width: (x1 - x0) / side, height: (y1 - y0) / side } : null;
  if (mark && mark.width < 0.5 && mark.height < 0.5) {
    warnings.push(`the mark is small: ${Math.round(mark.width * 100)}% × ${Math.round(mark.height * 100)}% of the side; it reads small at 24 dp (fill more of the keyline circle)`);
  }
  const uniform = cornerPx.every((p) => Math.abs(p[0] - ground[0]) <= 2 && Math.abs(p[1] - ground[1]) <= 2 && Math.abs(p[2] - ground[2]) <= 2);
  if (uniform && ground.every((c) => c >= 253)) warnings.push("the ground is pure white, the wallet's own on the light theme: the icon's edge vanishes there (pick a tint)");
  if (uniform && ground.every((c) => c <= 2)) warnings.push("the ground is pure black, the wallet's own on the dark theme: the icon's edge vanishes there (pick a tint)");
  return { errors, warnings, width: side, ring, mark };
}

/** Whether a point (in pixel units, side `s`) is inside the rounded square of corner radius `MASK_CORNER · s`. */
function inMask(x: number, y: number, s: number): boolean {
  const r = MASK_CORNER * s;
  const dx = Math.max(r - x, x - (s - r), 0);
  const dy = Math.max(r - y, y - (s - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/** The mask's coverage of each pixel of a side `s`, 4 × 4 samples a pixel. */
function maskCoverage(s: number): Float32Array {
  const out = new Float32Array(s * s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let n = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (inMask(x + (i + 0.5) / 4, y + (j + 0.5) / 4, s)) n++;
      out[y * s + x] = n / 16;
    }
  }
  return out;
}

/** Draw `icon` at side `s` through the mask onto `canvas` (8-bit RGB, `cw` wide) at (`ox`, `oy`). */
function drawMasked(canvas: Uint8Array, cw: number, icon: Rgba, s: number, ox: number, oy: number): void {
  const scaled = resample(icon, { x0: 0, y0: 0, sx: icon.width / s, sy: icon.height / s }, s, s, "clamp");
  const mask = maskCoverage(s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const m = mask[y * s + x]!;
      if (m === 0) continue;
      const q = ((oy + y) * cw + ox + x) * 3;
      const p = (y * s + x) * 4;
      for (let c = 0; c < 3; c++) canvas[q + c] = Math.round(canvas[q + c]! * (1 - m) + 255 * Math.min(1, scaled[p + c]!) * m);
    }
  }
}

/**
 * The icon as wallets draw it: in the rounded-square mask at 24, 40, 56 and 96 dp (drawn at 2×), on Saltix's dark and
 * light grounds, and its master at 256 px with the zones over it — the keyline circle the mark stays inside and the
 * edge band the lit edge runs in, the mask's corners dimmed. A PNG for people; not an icon itself.
 */
export function iconPreview(png: Uint8Array): Uint8Array {
  const decoded = PNG.sync.read(Buffer.from(png.buffer, png.byteOffset, png.length));
  const icon: Rgba = { width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.data) };
  const gap = 24;
  const sizes = PREVIEW_SIZES.map((dp) => 2 * dp);
  const rowHeight = Math.max(...sizes) + 2 * gap;
  const rowsWidth = gap + sizes.reduce((n, s) => n + s + gap, 0);
  const zones = 256;
  const width = rowsWidth + zones + gap;
  const height = 2 * rowHeight;
  const canvas = new Uint8Array(width * height * 3);
  const fill = (x0: number, y0: number, w: number, h: number, c: Colour) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) canvas.set(c, (y * width + x) * 3);
  };
  fill(0, 0, width, rowHeight, [0x12, 0x12, 0x12]);
  fill(0, rowHeight, width, rowHeight, [0xff, 0xff, 0xff]);
  for (const top of [0, rowHeight]) {
    let x = gap;
    for (const s of sizes) {
      drawMasked(canvas, width, icon, s, x, top + (rowHeight - s) / 2);
      x += s + gap;
    }
  }
  // The zones: the master at 256, the mask's outside dimmed, the keyline circle and the edge band's inner edge drawn.
  const zx = rowsWidth;
  const zy = (height - zones) / 2;
  const master = over(resample(icon, { x0: 0, y0: 0, sx: icon.width / zones, sy: icon.height / zones }, zones, zones, "clamp"), [0, 0, 0]);
  const mask = maskCoverage(zones);
  const keyline = KEYLINE_RADIUS * zones;
  const band = EDGE_BAND * zones;
  for (let y = 0; y < zones; y++) {
    for (let x = 0; x < zones; x++) {
      const q = ((zy + y) * width + zx + x) * 3;
      const p = (y * zones + x) * 3;
      const m = 0.35 + 0.65 * mask[y * zones + x]!;
      const base = [0x80, 0x80, 0x80];
      for (let c = 0; c < 3; c++) canvas[q + c] = Math.round(master[p + c]! * m + base[c]! * (1 - m));
      const d = Math.hypot(x + 0.5 - zones / 2, y + 0.5 - zones / 2);
      const onKeyline = Math.abs(d - keyline) < 0.75;
      const onBand = (Math.abs(x + 0.5 - band) < 0.75 || Math.abs(x + 0.5 - (zones - band)) < 0.75) && y >= band && y <= zones - band ||
        (Math.abs(y + 0.5 - band) < 0.75 || Math.abs(y + 0.5 - (zones - band)) < 0.75) && x >= band && x <= zones - band;
      if (onKeyline) canvas.set([0xff, 0x3b, 0x9a], q);
      else if (onBand && (x + y) % 6 < 3) canvas.set([0x00, 0xc2, 0xff], q);
    }
  }
  return encodePng({ width, height, rgb: canvas });
}

export interface IconRun {
  /** The picture, or the icon to check; unused with `monogram`. */
  input: string;
  /** Letters for an icon with no picture (`--monogram`): 1 or 2 of A–Z, 0–9. */
  monogram?: string;
  /** The ground's seed when no `background` is named: the slug. */
  seed?: string;
  /** Make an icon from `input` and write it here; without it, `input` is checked as it is. */
  out?: string;
  fit?: Fit;
  background?: Colour | null;
  /** Where the preview goes. */
  preview?: string;
  /** The project's directory and manifest: an icon written to its `icon.png` is named in its `grain.json`. */
  dir: string;
  manifestPath: string;
  print?: (line: string) => void;
}

/** `grain icon`: its exit status. The first line printed is the icon's hash, as before. */
export function runIcon(o: IconRun): number {
  const print = o.print ?? ((line: string) => console.log(line));
  const lines: string[] = [];
  if (o.monogram !== undefined) {
    const made = makeMonogram(o.monogram, o.background ?? null, o.seed ?? o.monogram);
    mkdirSync(dirname(resolve(o.out!)), { recursive: true });
    writeFileSync(o.out!, made.png);
    lines.push(`${o.out}: ${ICON_SIDE} × ${ICON_SIDE} PNG, ${made.colours === null ? "true colour" : `a palette of ${made.colours} colours`}, ${made.png.length} bytes (64 KiB at most), opaque, sRGB`);
    lines.push(`  the monogram ${made.text} in ${hexColour(made.ink)} on ${hexColour(made.background)}${o.background ? "" : " (the slug's colour; --background #rrggbb picks another)"}, inside the keyline circle`);
    return finishIcon(o, made.png, lines, print);
  }
  const bytes: Uint8Array = new Uint8Array(readFileSync(o.input));
  let png: Uint8Array = bytes;
  if (o.out !== undefined) {
    const made = makeIcon(bytes, { fit: o.fit, background: o.background ?? null });
    png = made.png;
    mkdirSync(dirname(resolve(o.out)), { recursive: true });
    writeFileSync(o.out, png);
    lines.push(`${o.out}: ${ICON_SIDE} × ${ICON_SIDE} PNG, ${made.colours === null ? "true colour" : `a palette of ${made.colours} colours`}, ${png.length} bytes (64 KiB at most), opaque, sRGB`);
    lines.push(`  fit ${made.fit}${made.fit === "mark" ? " (the mark inside the keyline circle)" : made.fit === "crop" ? " (covering the square)" : " (the whole picture)"}, ground ${hexColour(made.background)} (${made.backgroundWhy})`);
    for (const note of made.notes) lines.push(`  ${note}`);
  } else {
    const checked = checkImage("grain_icon", bytes);
    if (!checked.ok) {
      print(`${o.input} is not an icon wallets take: ${checked.reason} (${NAMED_REASONS[checked.reason]})`);
      print(`next: grain icon ${o.input} --out icon.png makes a ${ICON_SIDE} × ${ICON_SIDE} icon to the standard from it`);
      return 1;
    }
  }
  return finishIcon(o, png, lines, print);
}

/** An icon of `typed`'s letters (`monogramText`) on `background`, or on the colour `seed` picks: to the standard and
 *  checked as every icon `grain icon` makes. */
export function makeMonogram(typed: string, background: Colour | null, seed: string): { png: Uint8Array; text: string; background: Colour; ink: Colour; colours: number | null } {
  const text = monogramText(typed);
  if (text === null) throw new IconError("monogram", `--monogram ${typed}: one or two letters or digits, A–Z and 0–9`);
  const ground = background ?? monogramGround(seed);
  const ink = inkFor(ground);
  const fitted = fitPng(monogramPixels(text, ground, ink), ICON_SIDE, ICON_SIDE, MAX_ICON_BYTES);
  if (fitted === null) throw new IconError("size", "the monogram does not fit 64 KiB: a bug in grain icon, please report it");
  const checked = checkImage("grain_icon", fitted.png);
  if (!checked.ok) throw new IconError(checked.reason, `the monogram fails the image check (${checked.reason}): a bug in grain icon, please report it`);
  return { png: fitted.png, text, background: ground, ink, colours: fitted.colours };
}

/** What every icon `grain icon` makes or checks gets: its hash first, the lines about it, the checks, the preview, and
 *  its name in `grain.json` when it is the project's icon file. */
function finishIcon(o: IconRun, png: Uint8Array, lines: string[], print: (line: string) => void): number {
  const manifest = existsSync(o.manifestPath) ? (JSON.parse(readFileSync(o.manifestPath, "utf8")) as { icon?: string; manifest?: { icon?: string } }) : null;
  const hash = iconHash(png);
  // An icon written where the project keeps it is the one grain.json names from now on.
  let named = false;
  if (o.out !== undefined && manifest && !manifest.manifest && ICON_FILES.some((f) => resolve(o.dir, f) === resolve(o.out!))) {
    if (manifest.icon !== hash) {
      manifest.icon = hash;
      writeFileSync(o.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
    named = true;
  }
  // The project's own icon file is held to the hash grain.json names; any other picture is only checked.
  const projectIcon = ICON_FILES.some((f) => resolve(o.dir, f) === resolve(o.out ?? o.input));
  const lint = checkIcon(png, named || !projectIcon ? undefined : manifest?.manifest?.icon ?? manifest?.icon);
  print(hash);
  for (const line of lines) print(line);
  if (lint.mark !== undefined) {
    print(`  checks: the image check passes; ${lint.mark ? `the mark spans ${Math.round(lint.mark.width * 100)}% × ${Math.round(lint.mark.height * 100)}% of the side` : "no mark apart from the ground"}, ` +
      `${(lint.ring ?? 0) <= 0.02 ? "inside the keyline circle" : "reaching outside the keyline circle"}`);
  }
  for (const w of lint.warnings) print(`warning: ${w}`);
  for (const e of lint.errors) print(`error: ${e}`);
  const previewPath = o.preview ?? (existsSync(o.manifestPath) ? join(grainDir(o.dir), "icon-preview.png") : `${(o.out ?? o.input).replace(/\.png$/i, "")}.preview.png`);
  writeFileSync(previewPath, iconPreview(png));
  print(`  preview: ${previewPath} (the mask at ${PREVIEW_SIZES.join(", ")} dp on dark and light, and the zones)`);
  if (named) print(`  grain.json's "icon" names it: grain publish puts it into the network (the next version, if the app is published)`);
  else if (manifest && (manifest.manifest?.icon ?? manifest.icon) !== hash) print(`  grain.json's "icon" is another: set it to ${hash}`);
  return lint.errors.length === 0 ? 0 : 1;
}
