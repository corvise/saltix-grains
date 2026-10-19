// `grain icon --monogram`: an app's icon to Saltix's standard (32-images §3) with no picture at all, for an app that has
// none yet: one or two letters or digits drawn bold, centred inside the keyline circle, on a colour of its own. The
// letters are a stroke font of this module's own (A–Z, 0–9 as centre lines on a unit height, drawn with round ends at
// one width), so the icon is the same on any computer, needs no font installed and no package that draws text. Each
// pixel's ink is its distance to the nearest stroke, anti-aliased over one pixel; the ink is white on a dark ground and
// a dark blue on a light one.
import { ICON_SIDE } from "@saltix/grain-server";
import { type Colour } from "./icon.js";

/** A glyph: its advance width (the height is 1) and its strokes, each a polyline of points (x right, y down). */
interface Glyph {
  width: number;
  strokes: Array<Array<[number, number]>>;
}

/** Points along an ellipse of centre (`cx`, `cy`) and radii `rx`, `ry`, from angle `from` to `to` in degrees (0 is to
 *  the right, 90 below: y grows downwards), either way round. */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Array<[number, number]> {
  const steps = Math.max(8, Math.ceil(Math.abs(to - from) / 6));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as [number, number];
  });
}

const line = (...points: Array<[number, number]>) => points;

/** The font: upper-case Latin letters and digits. */
const GLYPHS: Readonly<Record<string, Glyph>> = {
  A: { width: 0.76, strokes: [line([0, 1], [0.38, 0], [0.76, 1]), line([0.14, 0.64], [0.62, 0.64])] },
  B: {
    width: 0.62,
    strokes: [line([0, 0], [0, 1]), [[0, 0], [0.32, 0], ...arc(0.32, 0.24, 0.24, 0.24, -90, 90), [0, 0.48]], [[0, 0.48], [0.36, 0.48], ...arc(0.36, 0.74, 0.26, 0.26, -90, 90), [0, 1]]],
  },
  C: { width: 0.74, strokes: [arc(0.4, 0.5, 0.4, 0.5, -45, -315)] },
  D: { width: 0.7, strokes: [[[0, 0], [0.26, 0], ...arc(0.26, 0.5, 0.44, 0.5, -90, 90), [0, 1], [0, 0]]] },
  E: { width: 0.6, strokes: [line([0.6, 0], [0, 0], [0, 1], [0.6, 1]), line([0, 0.5], [0.5, 0.5])] },
  F: { width: 0.6, strokes: [line([0.6, 0], [0, 0], [0, 1]), line([0, 0.5], [0.5, 0.5])] },
  G: { width: 0.78, strokes: [[...arc(0.4, 0.5, 0.4, 0.5, -45, -350), [0.8, 0.56], [0.46, 0.56]]] },
  H: { width: 0.66, strokes: [line([0, 0], [0, 1]), line([0.66, 0], [0.66, 1]), line([0, 0.5], [0.66, 0.5])] },
  I: { width: 0.36, strokes: [line([0, 0], [0.36, 0]), line([0.18, 0], [0.18, 1]), line([0, 1], [0.36, 1])] },
  J: { width: 0.54, strokes: [[[0.54, 0], [0.54, 0.7], ...arc(0.27, 0.7, 0.27, 0.3, 0, 180)]] },
  K: { width: 0.66, strokes: [line([0, 0], [0, 1]), line([0.64, 0], [0, 0.6]), line([0.22, 0.4], [0.66, 1])] },
  L: { width: 0.56, strokes: [line([0, 0], [0, 1], [0.56, 1])] },
  M: { width: 0.84, strokes: [line([0, 1], [0, 0], [0.42, 0.64], [0.84, 0], [0.84, 1])] },
  N: { width: 0.68, strokes: [line([0, 1], [0, 0], [0.68, 1], [0.68, 0])] },
  O: { width: 0.8, strokes: [arc(0.4, 0.5, 0.4, 0.5, 0, 360)] },
  P: { width: 0.62, strokes: [[[0, 1], [0, 0], [0.32, 0], ...arc(0.32, 0.26, 0.28, 0.26, -90, 90), [0, 0.52]]] },
  Q: { width: 0.82, strokes: [arc(0.4, 0.5, 0.4, 0.5, 0, 360), line([0.5, 0.72], [0.84, 1.04])] },
  R: { width: 0.66, strokes: [[[0, 1], [0, 0], [0.32, 0], ...arc(0.32, 0.26, 0.28, 0.26, -90, 90), [0, 0.52]], line([0.3, 0.52], [0.66, 1])] },
  S: { width: 0.62, strokes: [[...arc(0.31, 0.25, 0.29, 0.25, -25, -270), ...arc(0.31, 0.75, 0.31, 0.25, -90, 155)]] },
  T: { width: 0.7, strokes: [line([0, 0], [0.7, 0]), line([0.35, 0], [0.35, 1])] },
  U: { width: 0.68, strokes: [[[0, 0], [0, 0.66], ...arc(0.34, 0.66, 0.34, 0.34, 180, 0), [0.68, 0]]] },
  V: { width: 0.74, strokes: [line([0, 0], [0.37, 1], [0.74, 0])] },
  W: { width: 0.96, strokes: [line([0, 0], [0.22, 1], [0.48, 0.3], [0.74, 1], [0.96, 0])] },
  X: { width: 0.68, strokes: [line([0, 0], [0.68, 1]), line([0.68, 0], [0, 1])] },
  Y: { width: 0.7, strokes: [line([0, 0], [0.35, 0.52], [0.7, 0]), line([0.35, 0.52], [0.35, 1])] },
  Z: { width: 0.64, strokes: [line([0, 0], [0.64, 0], [0, 1], [0.64, 1])] },
  "0": { width: 0.64, strokes: [arc(0.32, 0.5, 0.32, 0.5, 0, 360)] },
  "1": { width: 0.42, strokes: [line([0.04, 0.2], [0.3, 0], [0.3, 1])] },
  "2": { width: 0.62, strokes: [[...arc(0.31, 0.28, 0.29, 0.28, 195, 380), [0, 1], [0.62, 1]]] },
  "3": { width: 0.62, strokes: [[...arc(0.3, 0.25, 0.28, 0.25, 205, 450)], [...arc(0.3, 0.74, 0.32, 0.26, -90, 160)]] },
  "4": { width: 0.68, strokes: [line([0.5, 1], [0.5, 0], [0, 0.68], [0.68, 0.68])] },
  "5": { width: 0.62, strokes: [[[0.58, 0], [0.08, 0], [0.04, 0.46], ...arc(0.3, 0.7, 0.31, 0.3, 225, 520)]] },
  "6": { width: 0.64, strokes: [arc(0.36, 0.62, 0.36, 0.62, 180, 290), arc(0.32, 0.69, 0.32, 0.31, 0, 360)] },
  "7": { width: 0.62, strokes: [line([0, 0], [0.62, 0], [0.18, 1])] },
  "8": { width: 0.62, strokes: [arc(0.31, 0.25, 0.27, 0.25, 0, 360), arc(0.31, 0.74, 0.31, 0.26, 0, 360)] },
  "9": { width: 0.64, strokes: [arc(0.32, 0.31, 0.32, 0.31, 0, 360), arc(0.28, 0.38, 0.36, 0.62, 0, 110)] },
};

/** The characters a monogram takes. */
export const MONOGRAM_CHARACTERS = Object.keys(GLYPHS).sort().join("");

/** The text of a monogram from what was typed: 1 or 2 of A–Z and 0–9, upper case; null for anything else. */
export function monogramText(typed: string): string | null {
  const text = typed.trim().toUpperCase();
  return /^[A-Z0-9]{1,2}$/.test(text) ? text : null;
}

/** Grounds a monogram takes when none is named: tints, never the wallet's own white or black, picked by the slug. */
export const MONOGRAM_GROUNDS: readonly Colour[] = [
  [0x2f, 0x6b, 0xff], [0x6d, 0x4a, 0xe8], [0xd8, 0x3f, 0x6a], [0xe8, 0x7a, 0x1e],
  [0x16, 0x9a, 0x73], [0x0e, 0x86, 0xb8], [0xb4, 0x45, 0x18], [0x3d, 0x4a, 0x63],
];

/** The ground for `seed` (the slug): the same one every time. */
export function monogramGround(seed: string): Colour {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0;
  return MONOGRAM_GROUNDS[h % MONOGRAM_GROUNDS.length]!;
}

/** An sRGB channel (0–255) in linear light, and back. */
const toLinear = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));

/** sRGB's relative luminance of a colour (WCAG), 0 to 1. */
export const luminance = (c: Colour) => 0.2126 * toLinear(c[0]) + 0.7152 * toLinear(c[1]) + 0.0722 * toLinear(c[2]);

/** WCAG's contrast ratio of two relative luminances, 1 to 21. */
export const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The ink on `ground`: white wherever it reads (a contrast of 3 at least, WCAG's for large marks), else a dark blue. */
export function inkFor(ground: Colour): Colour {
  const contrast = (luminance([255, 255, 255]) + 0.05) / (luminance(ground) + 0.05);
  return contrast >= 3 ? [255, 255, 255] : [0x0b, 0x10, 0x20];
}

/** The stroke's width, as a share of the letters' height: bold, so that a letter still reads at 24 dp. */
export const STROKE = 0.24;
/** The space between two letters' centre lines, as a share of their height: a tenth of it clear between their strokes. */
const GAP = STROKE + 0.1;
/** How far from the centre the letters reach at most, as a share of the side: inside the keyline circle (5/12) with room. */
const REACH = (5 / 12) * 0.88;

/**
 * The monogram's pixels, 512 × 512, 8-bit RGB: `text`'s letters (from `monogramText`) centred on `ground` in `ink`, each
 * corner of their box inside the keyline circle.
 */
export function monogramPixels(text: string, ground: Colour, ink: Colour = inkFor(ground)): Uint8Array {
  const side = ICON_SIDE;
  const glyphs = [...text].map((c) => {
    const g = GLYPHS[c];
    if (!g) throw new Error(`no glyph for ${c}`);
    return g;
  });
  const width = glyphs.reduce((n, g) => n + g.width, 0) + GAP * (glyphs.length - 1);
  // The box of the strokes' outer edges, centred; its half-diagonal reaches REACH of the side.
  const half = Math.hypot((width + STROKE) / 2, (1 + STROKE) / 2);
  const scale = (REACH * side) / half;
  const left = side / 2 - (width * scale) / 2;
  const top = side / 2 - scale / 2;
  const segments: number[] = [];
  let x = 0;
  for (const g of glyphs) {
    for (const stroke of g.strokes) {
      for (let i = 1; i < stroke.length; i++) {
        const [ax, ay] = stroke[i - 1]!;
        const [bx, by] = stroke[i]!;
        segments.push(left + (x + ax) * scale, top + ay * scale, left + (x + bx) * scale, top + by * scale);
      }
    }
    x += g.width + GAP;
  }
  const radius = (STROKE * scale) / 2;
  const groundLinear = ground.map(toLinear);
  const inkLinear = ink.map(toLinear);
  const out = new Uint8Array(side * side * 3);
  for (let py = 0; py < side; py++) {
    for (let px = 0; px < side; px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      let d = Infinity;
      for (let s = 0; s < segments.length; s += 4) {
        const ax = segments[s]!, ay = segments[s + 1]!, bx = segments[s + 2]!, by = segments[s + 3]!;
        const dx = bx - ax, dy = by - ay;
        const len = dx * dx + dy * dy;
        const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / len));
        const ex = ax + t * dx - cx, ey = ay + t * dy - cy;
        const e = ex * ex + ey * ey;
        if (e < d) d = e;
      }
      const cover = Math.max(0, Math.min(1, radius - Math.sqrt(d) + 0.5));
      const p = (py * side + px) * 3;
      for (let c = 0; c < 3; c++) {
        // Blended in linear light, as light adds up: no dark fringe around a white letter.
        out[p + c] = cover === 0 ? ground[c]! : cover === 1 ? ink[c]! : toSrgb(groundLinear[c]! * (1 - cover) + inkLinear[c]! * cover);
      }
    }
  }
  return out;
}
