// `grain icon` (Saltix 32-images §3): an icon to the standard from any PNG or JPEG — 512 × 512, opaque, sRGB, no
// metadata, at most 64 KiB, passing the image check every wallet runs — for logos with transparency, photos, pictures
// turned by EXIF, with a colour profile or a gamma, tiny or large, flat or detailed; the checks of §3.4 (256 × 256 taken
// with a warning, a mark outside the keyline circle, a small mark, a ground the wallet's own); the preview; and the
// command, which names the icon in grain.json.
import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { checkImage, crc32, iconHash } from "@saltix/grain-server";
import { EDGE_BAND, KEYLINE_RADIUS, checkIcon, iconPreview, makeIcon, parseColour, runIcon } from "../dist/icon.js";
import { PictureError, decodePicture } from "../dist/image.js";
import { scratch } from "../../../scripts/scratch.mjs";

const vectors = JSON.parse(readFileSync(new URL("../../../vectors/images-v1.json", import.meta.url), "utf8"));
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/** A PNG built by hand: any colour type and depth, with chunks of our choosing before IDAT. */
function pngOf({ width, height, colour = 6, depth = 8, rows, extra = [], palette }) {
  const chunk = (type, data) => {
    const t = Buffer.from(type, "latin1");
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    t.copy(out, 4);
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc32(new Uint8Array(t), new Uint8Array(data)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([depth, colour, 0, 0, 0], 8);
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.of(0), Buffer.from(r)])));
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra.map(([t, d]) => chunk(t, d)),
    ...(palette ? [chunk("PLTE", palette)] : []), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

/** RGBA pixels from a function of (x, y) → [r, g, b, a], as a PNG (via pngjs) or a JPEG (via jpeg-js). */
function picture(width, height, at) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(at(x, y), (y * width + x) * 4);
  return data;
}
const asPng = (w, h, at) => {
  const png = new PNG({ width: w, height: h });
  picture(w, h, at).copy(png.data);
  return new Uint8Array(PNG.sync.write(png));
};
const asJpeg = (w, h, at, quality = 90) => new Uint8Array(jpeg.encode({ width: w, height: h, data: picture(w, h, at) }, quality).data);

/** Mulberry32: the same pictures on every run. */
let seed = 1;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A logo: a ring and a dot on transparency, its parts placed by `w`, `h`. */
const logo = (w, h, colour = [20, 120, 220]) => (x, y) => {
  const ring = Math.abs(Math.hypot(x - w * 0.6, y - h * 0.45) - Math.min(w, h) * 0.25) < Math.min(w, h) * 0.06;
  const dot = Math.hypot(x - w * 0.25, y - h * 0.7) < Math.min(w, h) * 0.08;
  return ring ? [...colour, 255] : dot ? [230, 60, 40, 255] : [0, 0, 0, 0];
};
/** Something like a photo: gradients, waves and noise. */
const photo = (w, h) => (x, y) => [
  (x / w) * 200 + rnd() * 40, (y / h) * 200 + rnd() * 40, 128 + 90 * Math.sin(x / 37) * Math.cos(y / 53), 255,
];

/** The icon's decoded pixels. */
const pixels = (png) => {
  const d = PNG.sync.read(Buffer.from(png));
  return { width: d.width, height: d.height, at: (x, y) => [...d.data.subarray((y * d.width + x) * 4, (y * d.width + x) * 4 + 4)] };
};

/** What every icon made must be: the standard's master, which every wallet takes. */
function assertStandard(made, what) {
  assert.ok(made.png.length <= 65_536, `${what}: ${made.png.length} bytes`);
  assert.deepEqual(checkImage("grain_icon", made.png), { ok: true, value: { width: 512, height: 512 } }, what);
  assert.equal(made.hash, iconHash(made.png));
  const p = pixels(made.png);
  for (const [x, y] of [[0, 0], [511, 0], [0, 511], [511, 511], [256, 256]]) assert.equal(p.at(x, y)[3], 255, `${what}: opaque`);
  return p;
}

test("icons from many pictures all pass the image check: logos, photos, odd shapes, tiny and large, PNG and JPEG", () => {
  const cases = [
    ["a wide logo on transparency", asPng(900, 600, logo(900, 600))],
    ["a tall logo on transparency", asPng(300, 800, logo(300, 800))],
    ["a square photo", asPng(1000, 1000, photo(1000, 1000))],
    ["a wide JPEG photo", asJpeg(1600, 900, photo(1600, 900))],
    ["a tall JPEG photo", asJpeg(700, 1300, photo(700, 1300))],
    ["a tiny logo", asPng(32, 32, logo(32, 32))],
    ["a flat square", asPng(400, 400, () => [30, 200, 120, 255])],
    ["a huge JPEG", asJpeg(2400, 1800, photo(2400, 1800), 85)],
    ["a 1 × 1 picture", asPng(1, 1, () => [200, 10, 10, 255])],
    ["a strip", asPng(2000, 20, (x) => [x % 255, 100, 200, 255])],
  ];
  // And a dozen random ones: sizes, aspects, transparency, colours.
  for (let i = 0; i < 12; i++) {
    const w = 8 + Math.floor(rnd() * 1400);
    const h = 8 + Math.floor(rnd() * 1400);
    const alpha = rnd() < 0.5;
    const base = [rnd() * 255, rnd() * 255, rnd() * 255];
    const at = (x, y) => {
      const inside = Math.hypot(x / w - 0.5, y / h - 0.5) < 0.35;
      return alpha && !inside ? [0, 0, 0, 0] : [(base[0] + x) % 256, (base[1] + y) % 256, base[2], alpha ? 255 : 255];
    };
    cases.push([`random ${i}: ${w} × ${h}${alpha ? ", transparent" : ""}`, i % 3 === 0 && !alpha ? asJpeg(w, h, at) : asPng(w, h, at)]);
  }
  for (const [what, bytes] of cases) assertStandard(makeIcon(bytes), what);
});

test("a logo with transparency: its mark inside the keyline circle, on a ground that is not the wallet's own", () => {
  const made = makeIcon(asPng(900, 600, logo(900, 600)));
  assert.equal(made.fit, "mark");
  assert.deepEqual([...made.background], [0xf2, 0xf4, 0xf7], "a light ground for a dark mark");
  const lint = checkIcon(made.png);
  assert.deepEqual(lint.errors, []);
  assert.deepEqual(lint.warnings, []);
  assert.ok(lint.ring <= 0.02, `the ring holds ${lint.ring}`);
  assert.ok(lint.mark.width >= 0.5, "the mark fills the keyline circle, not a corner of it");
  // A light mark gets a dark ground; --background wins.
  assert.deepEqual([...makeIcon(asPng(300, 300, logo(300, 300, [250, 250, 250]))).background], [0x10, 0x18, 0x20]);
  assert.deepEqual([...makeIcon(asPng(300, 300, logo(300, 300)), { background: parseColour("#123456") }).background], [0x12, 0x34, 0x56]);
  // Every pixel of the mark lies inside the keyline circle: outside it only ground.
  const p = pixels(made.png);
  const ground = p.at(0, 0);
  for (let y = 0; y < 512; y += 3) {
    for (let x = 0; x < 512; x += 3) {
      if (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) <= KEYLINE_RADIUS * 512) continue;
      const c = p.at(x, y);
      assert.ok(c.slice(0, 3).every((v, i) => Math.abs(v - ground[i]) <= 24), `(${x}, ${y}) is mark outside the keyline`);
    }
  }
});

test("a photo covers the square, cut to it; contain shows it whole on its corners' colour", () => {
  const wide = asJpeg(1600, 900, (x) => (x < 800 ? [220, 30, 30, 255] : [30, 30, 220, 255]));
  const crop = makeIcon(wide);
  assert.equal(crop.fit, "crop");
  assert.match(crop.notes.join("\n"), /cropped to a square: 44% of its width cut/);
  const c = pixels(crop.png);
  assert.ok(c.at(100, 256)[0] > 180 && c.at(400, 256)[2] > 180, "red on the left, blue on the right, the middle kept");
  const contain = makeIcon(wide, { fit: "contain" });
  const k = pixels(contain.png);
  // Above and below the picture: the ground, its corners' colour (red at the left corners, blue at the right: the median).
  assert.deepEqual(k.at(256, 5).slice(0, 3), [...contain.background]);
});

test("a JPEG turned by its EXIF orientation is drawn as it is seen", () => {
  // Stored 200 wide and 100 high, left red and right blue; orientation 6: seen turned a quarter clockwise, red on top.
  const stored = asJpeg(200, 100, (x) => (x < 100 ? [230, 20, 20, 255] : [20, 20, 230, 255]));
  const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, tiff.length + 8]), Buffer.from("Exif\0\0", "latin1"), tiff]);
  const turned = new Uint8Array(Buffer.concat([Buffer.from(stored.subarray(0, 2)), app1, Buffer.from(stored.subarray(2))]));
  const decoded = decodePicture(turned);
  assert.equal(decoded.image.width, 100);
  assert.equal(decoded.image.height, 200);
  assert.match(decoded.notes.join(" "), /EXIF orientation \(6\)/);
  const made = makeIcon(turned);
  const p = pixels(made.png);
  assert.ok(p.at(256, 60)[0] > 180 && p.at(256, 450)[2] > 180, "red on top, blue below");
});

test("colours: an ICC profile and a PNG's gamma are converted to sRGB; sRGB's own profile changes nothing", () => {
  // A profile of sRGB's primaries with a linear tone curve: 128 there is sRGB's 188.
  const icc = (gammaU8Fixed8) => {
    const tags = [["rXYZ", [0.4360747, 0.2225045, 0.0139322]], ["gXYZ", [0.3850649, 0.7168786, 0.0971045]], ["bXYZ", [0.1430804, 0.0606169, 0.7141733]]];
    const parts = [];
    const table = [];
    let offset = 128 + 4 + 12 * 6;
    for (const [sig, xyz] of tags) {
      const d = Buffer.alloc(20);
      d.write("XYZ ", 0, "latin1");
      xyz.forEach((v, i) => d.writeInt32BE(Math.round(v * 65536), 8 + 4 * i));
      table.push([sig, offset, 20]);
      parts.push(d);
      offset += 20;
    }
    const curv = Buffer.alloc(14);
    curv.write("curv", 0, "latin1");
    curv.writeUInt32BE(1, 8);
    curv.writeUInt16BE(gammaU8Fixed8, 12);
    for (const sig of ["rTRC", "gTRC", "bTRC"]) table.push([sig, offset, 14]);
    parts.push(curv);
    const head = Buffer.alloc(128);
    head.write("RGB ", 16, "latin1");
    head.write("XYZ ", 20, "latin1");
    head.write("acsp", 36, "latin1");
    const count = Buffer.alloc(4 + 12 * table.length);
    count.writeUInt32BE(table.length, 0);
    table.forEach(([sig, at, size], i) => {
      count.write(sig, 4 + 12 * i, "latin1");
      count.writeUInt32BE(at, 8 + 12 * i);
      count.writeUInt32BE(size, 12 + 12 * i);
    });
    const body = Buffer.concat([head, count, ...parts]);
    body.writeUInt32BE(body.length, 0);
    return body;
  };
  const grey = (extra) => pngOf({ width: 64, height: 64, colour: 2, rows: Array.from({ length: 64 }, () => Buffer.alloc(64 * 3, 128)), extra });
  const iccp = (profile) => Buffer.concat([Buffer.from("test\0\0", "latin1"), deflateSync(profile)]);
  const linear = decodePicture(grey([["iCCP", iccp(icc(256))]]));
  assert.match(linear.notes.join(" "), /colour profile converted/);
  assert.ok(Math.abs(linear.image.data[0] - 188) <= 1, `128 in linear light is sRGB's 188, not ${linear.image.data[0]}`);
  // A gamma of 1.0 says the same.
  const gamma = decodePicture(grey([["gAMA", Buffer.from([0, 1, 0x86, 0xa0])]]));
  assert.ok(Math.abs(gamma.image.data[0] - 188) <= 1, `${gamma.image.data[0]}`);
  // sRGB's own curve is a gamma of about 2.2: nothing to do, and nothing done.
  const srgbCurve = decodePicture(grey([["iCCP", iccp(icc(Math.round(2.2 * 256)))]]));
  assert.ok(Math.abs(srgbCurve.image.data[0] - 128) <= 3);
  assert.equal(decodePicture(grey([["sRGB", Buffer.of(0)], ["gAMA", Buffer.from([0, 0, 0xb1, 0x8f])]])).image.data[0], 128);
  // Whatever came in, what goes out has no profile and no gamma: the image check passes.
  assertStandard(makeIcon(grey([["iCCP", iccp(icc(256))]])), "from a profiled PNG");
});

test("every PNG form decodes: grey, grey with alpha, a palette with transparency, 16 bits", () => {
  const rows = (w, h, bytes) => Array.from({ length: h }, (_, y) => Buffer.from(Array.from({ length: w * bytes }, (_, i) => (i * 7 + y * 3) & 0xff)));
  const forms = [
    ["grey", pngOf({ width: 40, height: 30, colour: 0, rows: rows(40, 30, 1) })],
    ["grey with alpha", pngOf({ width: 40, height: 30, colour: 4, rows: rows(40, 30, 2) })],
    ["16-bit RGBA", pngOf({ width: 40, height: 30, colour: 6, depth: 16, rows: rows(40, 30, 8) })],
    ["a palette with tRNS", pngOf({ width: 40, height: 30, colour: 3, rows: Array.from({ length: 30 }, (_, y) => Buffer.from(Array.from({ length: 40 }, (_, x) => (x + y) % 4))),
      palette: Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]), extra: [] })],
  ];
  for (const [what, bytes] of forms) {
    const d = decodePicture(bytes);
    assert.equal(d.image.width, 40, what);
    assertStandard(makeIcon(bytes), what);
  }
});

test("pictures it cannot read are refused with what to do; a picture too detailed for 64 KiB says so", () => {
  const refused = [
    ["a WebP", Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), Buffer.alloc(40)]), /a WebP: grain icon reads PNG and JPEG pictures; export it as a PNG/],
    ["a GIF", Buffer.from("GIF89a" + "\0".repeat(40), "latin1"), /a GIF/],
    ["an SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), /an SVG/],
    ["noise", Buffer.from("not a picture at all"), /not a PNG or a JPEG/],
  ];
  for (const [what, bytes, message] of refused) {
    assert.throws(() => makeIcon(new Uint8Array(bytes)), (e) => e instanceof PictureError && e.reason === "format" && message.test(e.message), what);
  }
  // A PNG whose header claims more pixels than anyone needs: refused before a byte is inflated.
  const huge = pngOf({ width: 1, height: 1, colour: 2, rows: [Buffer.alloc(3)] });
  new DataView(huge.buffer).setUint32(16, 100_000);
  new DataView(huge.buffer).setUint32(20, 100_000);
  assert.throws(() => decodePicture(huge), (e) => e instanceof PictureError && e.reason === "too_large");
  // Pure noise has no 64 KiB form, even with 16 colours.
  const noise = asPng(512, 512, () => [rnd() * 255, rnd() * 255, rnd() * 255, 255]);
  assert.throws(() => makeIcon(noise), (e) => e.name === "IconError" && e.reason === "size" && /too detailed/.test(e.message));
  // A picture that is all ground has no mark to fit.
  assert.throws(() => makeIcon(asPng(50, 50, () => [0, 0, 0, 0]), { fit: "mark" }), (e) => e.reason === "empty");
});

test("a detailed picture is reduced to a palette to fit 64 KiB, and still passes", () => {
  const made = makeIcon(asJpeg(1200, 1200, photo(1200, 1200)));
  assert.ok(made.colours !== null && made.colours <= 256, `a palette (${made.colours})`);
  assert.match(made.notes.join(" "), /palette of \d+ colours/);
  assertStandard(made, "the photo");
});

test("§3.4's checks: 256 × 256 taken with a warning; a mark outside the keyline circle; a small mark; the wallet's own ground", () => {
  const legacy = Buffer.from(vectors.images.find((i) => i.kind === "grain_icon" && i.width === 256).hex, "hex");
  const old = checkIcon(new Uint8Array(legacy));
  assert.deepEqual(old.errors, []);
  assert.match(old.warnings.join("\n"), /256 × 256: wallets take it, soft on large screens; the standard is 512 × 512/);
  // A frame near the picture's edges, cropped to fill the square, reaches past the keyline circle.
  const frame = (x, y) => (Math.max(Math.abs(x - 300), Math.abs(y - 300)) > 230 && Math.max(Math.abs(x - 300), Math.abs(y - 300)) < 260 ? [20, 60, 200, 255] : [240, 240, 240, 255]);
  const edge = checkIcon(makeIcon(asPng(600, 600, frame), { fit: "crop" }).png);
  assert.match(edge.warnings.join("\n"), /the mark reaches outside the keyline circle/);
  // A dot in a large transparent picture, shown whole: a small mark.
  const dot = (x, y) => (Math.hypot(x - 500, y - 500) < 40 ? [200, 20, 20, 255] : [0, 0, 0, 0]);
  const small = checkIcon(makeIcon(asPng(1000, 1000, dot), { fit: "contain" }).png);
  assert.match(small.warnings.join("\n"), /the mark is small: \d+% × \d+% of the side/);
  // Fitted as a mark instead, the same dot fills the keyline circle: no warning.
  assert.deepEqual(checkIcon(makeIcon(asPng(1000, 1000, dot)).png).warnings, []);
  assert.match(checkIcon(makeIcon(asPng(300, 300, logo(300, 300)), { background: [255, 255, 255] }).png).warnings.join("\n"), /pure white/);
  assert.match(checkIcon(makeIcon(asPng(300, 300, logo(300, 300)), { background: [0, 0, 0] }).png).warnings.join("\n"), /pure black/);
  // The refused ones: the image check's reason in words, and a hash that is not the manifest's.
  for (const r of vectors.refused.filter((x) => x.kind === "grain_icon")) {
    assert.match(checkIcon(Buffer.from(r.hex, "hex")).errors[0], new RegExp(`the image check: ${r.reason}`), r.name);
  }
  const good = Buffer.from(vectors.images[0].hex, "hex");
  assert.match(checkIcon(good, "11".repeat(32)).errors[0], /its hash is [0-9a-f]{64}, but grain\.json's "icon" is 1{64}/);
  assert.deepEqual(checkIcon(good, vectors.images[0].hash).errors, []);
});

test("the preview: the icon in the rounded-square mask at 24, 40, 56 and 96 dp on dark and light, and its zones", () => {
  const made = makeIcon(asPng(400, 400, logo(400, 400)));
  const preview = PNG.sync.read(Buffer.from(iconPreview(made.png)));
  assert.equal(preview.width, 24 + (48 + 24) + (80 + 24) + (112 + 24) + (192 + 24) + 256 + 24);
  assert.equal(preview.height, 2 * (192 + 48));
  const at = (x, y) => [...preview.data.subarray((y * preview.width + x) * 4, (y * preview.width + x) * 4 + 3)];
  // The 96 dp tile on the dark row: its corner is cut (the theme's dark shows), its middle is the icon's ground.
  const tileX = 24 + 48 + 24 + 80 + 24 + 112 + 24;
  const tileY = 24;
  assert.deepEqual(at(tileX + 1, tileY + 1), [0x12, 0x12, 0x12], "the mask cuts the corner");
  assert.deepEqual(at(tileX + 96, tileY + 4), [...made.background], "the edge's middle is the icon's");
  assert.deepEqual(at(tileX + 1, 240 + tileY + 1), [0xff, 0xff, 0xff], "on the light row too");
  assert.ok(EDGE_BAND === 1 / 16 && KEYLINE_RADIUS === 5 / 12);
});

test("grain icon <picture> --out icon.png: written, named in grain.json, its hash first; grain icon <icon.png> checks it", () => {
  const dir = scratch("grain-icon-");
  writeFileSync(join(dir, "grain.json"), JSON.stringify({ slug: "space-game", version: 1, icon: "00".repeat(32) }, null, 2));
  writeFileSync(join(dir, "logo.png"), asPng(600, 400, logo(600, 400)));
  const lines = [];
  const status = runIcon({ input: join(dir, "logo.png"), out: join(dir, "icon.png"), dir, manifestPath: join(dir, "grain.json"), print: (l) => lines.push(l) });
  assert.equal(status, 0, lines.join("\n"));
  const icon = readFileSync(join(dir, "icon.png"));
  assert.equal(lines[0], iconHash(new Uint8Array(icon)), "the hash first, as before");
  assert.equal(JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")).icon, lines[0], "grain.json names it");
  assert.ok(existsSync(join(dir, ".grain", "icon-preview.png")));
  assert.match(lines.join("\n"), /fit mark/);
  // Checking it as it is: the hash again, and nothing to fix.
  const again = [];
  assert.equal(runIcon({ input: join(dir, "icon.png"), dir, manifestPath: join(dir, "grain.json"), print: (l) => again.push(l) }), 0);
  assert.equal(again[0], lines[0]);
  // A picture that is no icon: refused, with the command that makes one.
  const refused = [];
  assert.equal(runIcon({ input: join(dir, "logo.png"), dir, manifestPath: join(dir, "grain.json"), print: (l) => refused.push(l) }), 1);
  assert.match(refused.join("\n"), /not an icon wallets take: alpha .*\nnext: grain icon .*logo\.png --out icon\.png/);
  // The command line, end to end: --fix <in> <out> and the flags.
  const run = (args) => spawnSync("node", [main, ...args], { cwd: dir, encoding: "utf8" });
  const fixed = run(["icon", "--fix", "logo.png", "public-icon.png", "--fit", "contain", "--background", "#203040"]);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /^[0-9a-f]{64}\n/);
  assert.match(fixed.stdout, /ground #203040 \(as asked\)/);
  assert.equal(run(["icon", "logo.png", "--fit", "squash", "--out", "x.png"]).status, 2);
  assert.equal(run(["icon", "logo.png", "--background", "teal", "--out", "x.png"]).status, 2);
});

test("grain icon --monogram: an icon to the standard with no picture, every letter and digit inside the keyline circle", async () => {
  const { MONOGRAM_CHARACTERS, MONOGRAM_GROUNDS, inkFor, monogramGround, monogramText } = await import("../dist/monogram.js");
  const { makeMonogram } = await import("../dist/icon.js");
  assert.equal(MONOGRAM_CHARACTERS, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  // One letter, and pairs: each passes the image check every wallet runs, with no warning of §3.4 (inside the keyline
  // circle, not small, a ground that is the wallet's own on neither theme).
  const texts = [...MONOGRAM_CHARACTERS, "AB", "MW", "88", "QJ"];
  for (const text of texts) {
    const made = makeMonogram(text, null, "space-game");
    assert.ok(checkImage("grain_icon", made.png).ok, text);
    const lint = checkIcon(made.png);
    assert.deepEqual([lint.errors, lint.warnings], [[], []], text);
    assert.ok(lint.ring <= 0.02, `${text}: inside the keyline circle (${lint.ring})`);
    // The mark is the letters: some ink, centred.
    assert.ok(lint.mark && lint.mark.height > 0.3 && lint.mark.width > 0.05, `${text}: ${JSON.stringify(lint.mark)}`);
  }
  // The same letters on the same colour are the same bytes, on any computer; another letter is another icon.
  assert.equal(iconHash(makeMonogram("d", null, "space-game").png), iconHash(makeMonogram("D", null, "space-game").png));
  assert.notEqual(iconHash(makeMonogram("D", null, "space-game").png), iconHash(makeMonogram("E", null, "space-game").png));
  // The ground: as asked, else the slug's (always the same, never white or black); the ink white where it reads.
  assert.deepEqual(makeMonogram("D", [0x20, 0x30, 0x40], "x").background, [0x20, 0x30, 0x40]);
  assert.deepEqual(monogramGround("space-game"), monogramGround("space-game"));
  assert.ok(MONOGRAM_GROUNDS.some((g) => g.join() === monogramGround("space-game").join()));
  assert.deepEqual(inkFor([0x2f, 0x6b, 0xff]), [255, 255, 255]);
  assert.deepEqual(inkFor([0xf2, 0xe0, 0x60]), [0x0b, 0x10, 0x20], "a dark ink on a light ground");
  const px = PNG.sync.read(Buffer.from(makeMonogram("I", [0x20, 0x30, 0x40], "x").png));
  const at = (x, y) => [...px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 3)];
  assert.deepEqual(at(256, 256), [255, 255, 255], "the ink at the centre of an I");
  assert.deepEqual(at(20, 20), [0x20, 0x30, 0x40], "the ground at a corner");
  // What it takes: one or two of A–Z and 0–9.
  for (const bad of ["", "ABC", "Ж", "a-", "1 2"]) assert.equal(monogramText(bad), null, bad);
  assert.equal(monogramText(" q7 "), "Q7");
  // The command: written where the project keeps its icon unless --out says, named in grain.json, its hash first.
  const dir = scratch("grain-monogram-");
  writeFileSync(join(dir, "grain.json"), JSON.stringify({ slug: "space-game", version: 1, icon: "00".repeat(32) }, null, 2));
  const run = (args) => spawnSync("node", [main, ...args], { cwd: dir, encoding: "utf8" });
  const made = run(["icon", "--monogram", "S"]);
  assert.equal(made.status, 0, made.stderr);
  const icon = readFileSync(join(dir, "icon.png"));
  assert.equal(made.stdout.split("\n")[0], iconHash(new Uint8Array(icon)));
  assert.equal(JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")).icon, iconHash(new Uint8Array(icon)), "grain.json names it");
  assert.match(made.stdout, /the monogram S in #ffffff on #[0-9a-f]{6} \(the slug's colour; --background #rrggbb picks another\), inside the keyline circle/);
  assert.ok(existsSync(join(dir, ".grain", "icon-preview.png")));
  assert.equal(run(["icon", "--monogram", "S", "--background", "#203040", "--out", "other.png"]).status, 0);
  assert.ok(existsSync(join(dir, "other.png")));
  const refused = run(["icon", "--monogram", "ABC"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--monogram ABC: one or two letters or digits, A–Z and 0–9/);
  assert.equal(run(["icon", "logo.png", "--monogram", "S"]).status, 2, "a picture or letters, not both");
  assert.equal(run(["icon", "--monogram"]).status, 2);
  const log = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(log.some((l) => l.command === "icon" && l.step === "icon" && l.outcome === "ok" && l.reason === "monogram"));
});
