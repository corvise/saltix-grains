// `grain bundle`: a sealed grain's files as one ZIP (Saltix 12-grains §8), the same bytes for the same files — sorted
// names, no times, no extra fields — so its hash names exactly what the owner signed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import { bundleHash, type Manifest } from "@saltix/grain-server";

/** A bundle is at most this large (12-grains §11), and unpacks to at most MAX_UNPACKED (§8: what every wallet takes). */
export const MAX_BUNDLE = 20 * 1024 * 1024;
export const MAX_UNPACKED = 64 * 1024 * 1024;
/** Names a bundle may hold: what a wallet unpacks (Saltix `GrainBundles`). */
const NAME = /^[A-Za-z0-9._ ~@+-]+(\/[A-Za-z0-9._ ~@+-]+)*$/;

export interface Bundle {
  zip: Uint8Array;
  /** Hex of `bundleHash(zip)`. */
  hash: string;
  size: number;
  files: string[];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Every file under `dir` but hidden ones, as bundle names (`/`-separated), sorted. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith(".")) continue;
      const path = join(d, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) out.push(relative(dir, path).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** The ZIP of `dir` (a grain's `public/`): deterministic, deflated where that is smaller. */
export function makeBundle(dir: string): Bundle {
  const files = filesUnder(dir);
  if (files.length === 0) throw new Error(`${dir}: no files to bundle`);
  if (files.length > 4096) throw new Error(`${dir}: ${files.length} files; a bundle holds at most 4096`);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  let unpacked = 0;
  for (const name of files) {
    if (!NAME.test(name) || name.split("/").some((p) => p === "." || p === "..")) {
      throw new Error(`${name}: a bundle's names use [A-Za-z0-9._ ~@+-] and /`);
    }
    const data = new Uint8Array(readFileSync(join(dir, ...name.split("/"))));
    unpacked += data.length;
    if (unpacked > MAX_UNPACKED) throw new Error(`the files come to more than ${MAX_UNPACKED} bytes; a bundle unpacks to at most that`);
    const deflated = new Uint8Array(deflateRawSync(data, { level: 9 }));
    const [method, body] = deflated.length < data.length ? [8, deflated] : [0, data];
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    // Version 2.0, UTF-8 names (bit 11), no time (1980-01-01 00:00).
    const head = (sig: number, central: boolean) => {
      const b = Buffer.alloc(central ? 46 : 30);
      let at = 0;
      b.writeUInt32LE(sig, at); at += 4;
      if (central) { b.writeUInt16LE(20, at); at += 2; }
      b.writeUInt16LE(20, at); at += 2;
      b.writeUInt16LE(0x0800, at); at += 2;
      b.writeUInt16LE(method, at); at += 2;
      b.writeUInt16LE(0, at); at += 2;
      b.writeUInt16LE(0x0021, at); at += 2;
      b.writeUInt32LE(crc, at); at += 4;
      b.writeUInt32LE(body.length, at); at += 4;
      b.writeUInt32LE(data.length, at); at += 4;
      b.writeUInt16LE(nameBytes.length, at); at += 2;
      b.writeUInt16LE(0, at); at += 2;
      if (central) {
        b.writeUInt16LE(0, at); at += 2; // comment
        b.writeUInt16LE(0, at); at += 2; // disk
        b.writeUInt16LE(0, at); at += 2; // internal attributes
        b.writeUInt32LE(0, at); at += 4; // external attributes
        b.writeUInt32LE(offset, at); at += 4;
      }
      return new Uint8Array(b);
    };
    const local = Buffer.concat([head(0x04034b50, false), nameBytes, body]);
    centrals.push(new Uint8Array(Buffer.concat([head(0x02014b50, true), nameBytes])));
    locals.push(new Uint8Array(local));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  const zip = new Uint8Array(Buffer.concat([...locals, central, end]));
  if (zip.length > MAX_BUNDLE) throw new Error(`the bundle is ${zip.length} bytes; at most ${MAX_BUNDLE}`);
  return { zip, hash: bundleHash(zip), size: zip.length, files };
}

/** `m` with its entry sealed to `bundle`: sources, start and connect from `options`, else from its sealed entry. */
export function sealed(m: Manifest, bundle: Bundle, options: { sources?: string[]; start?: string; connect?: string[] }): Manifest {
  const before = "sealed" in m.entry ? m.entry.sealed : null;
  const sources = options.sources ?? before?.sources ?? [];
  if (sources.length === 0) throw new Error("--sources: the https URLs the bundle is served at (upload bundle.zip there)");
  const start = options.start ?? before?.start ?? "index.html";
  if (!bundle.files.includes(start)) throw new Error(`start: ${start} is not in the bundle`);
  return {
    ...m,
    entry: { sealed: { bundle: bundle.hash, size: bundle.size, sources, start, connect: options.connect ?? before?.connect ?? [] } },
  };
}
