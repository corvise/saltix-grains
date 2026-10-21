// `grain bundle`: a sealed grain's files as one ZIP (Saltix 12-grains §8), the same bytes for the same files — sorted
// names, no times, no extra fields, every file stored as it is — so its hash names exactly what the owner signed, on
// any computer and any Node. Nothing is compressed: a deflater's output is its own (Node's zlib changes between
// releases), so two builds of the same files could name two hashes. Wallets download a bundle once; the host may
// compress it on the wire (HTTP gzip) without touching its bytes. It is exactly the form the network keeps (the bundle
// check, 32-images §2a), which `grain publish` puts into the network itself.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES, MAX_BUNDLE_UNPACKED, type Manifest, bundleHash, checkBundle, crc32 } from "@saltix/grain-server";

/** A bundle is at most this large (12-grains §11), and unpacks to at most MAX_UNPACKED (§8: what every wallet takes). The
 *  network keeps one of at most 16 MiB (`MAX_NETWORK_BUNDLE_BYTES`); a larger one needs sources of its own. */
export const MAX_BUNDLE = MAX_BUNDLE_BYTES;
export const MAX_UNPACKED = MAX_BUNDLE_UNPACKED;
/** Names a bundle may hold: what a wallet unpacks (Saltix `GrainBundles`). */
const NAME = /^[A-Za-z0-9._ ~@+-]+(\/[A-Za-z0-9._ ~@+-]+)*$/;

export interface Bundle {
  zip: Uint8Array;
  /** Hex of `bundleHash(zip)`. */
  hash: string;
  size: number;
  files: string[];
}

/**
 * Names that never go into a bundle, whatever else `public/` holds: a bundle is uploaded into the network before the
 * owner signs and served by its hash to anyone (32-images §7.3), so a key file or a chat's store left there would be
 * public. The names `.gitignore` keeps out of git (`grain pair`'s `IGNORED`), a chat store, and anything hidden
 * (`.env`, `.git/`), which `filesUnder` passes over.
 */
export const REFUSED_IN_BUNDLE: ReadonlyArray<{ test: (name: string) => boolean; what: string }> = [
  { test: (name) => name.endsWith(".key"), what: "a key file (*.key)" },
  { test: (name) => name.endsWith(".store.json"), what: "a chat's store (*.store.json)" },
  { test: (name) => name === "app.json", what: "the server's app.json" },
];

/** Why `name` (a file's name, without its directories) is refused in a bundle, or null. */
export function refusedInBundle(name: string): string | null {
  return REFUSED_IN_BUNDLE.find((r) => r.test(name))?.what ?? null;
}

/** The files under `dir` (as bundle names, `/`-separated) that a bundle refuses, and why: for `grain lint`. */
export function secretsUnder(dir: string): Array<{ name: string; what: string }> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return filesUnder(dir, false).flatMap((name) => {
    const what = refusedInBundle(name.split("/").at(-1)!);
    return what ? [{ name, what }] : [];
  });
}

/** Every file under `dir` but hidden ones, as bundle names (`/`-separated), sorted; `refuse`: a key file or a store
 *  among them is an error, never a bundle's entry. */
function filesUnder(dir: string, refuse = true): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith(".")) continue;
      const path = join(d, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        const bundleName = relative(dir, path).split(sep).join("/");
        const what = refusedInBundle(name);
        if (what && refuse) {
          throw new Error(`${bundleName}: ${what} never goes into a bundle, which the network serves to anyone by its hash: move it out of ${dir}`);
        }
        out.push(bundleName);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** What every entry of a bundle is: stored (ZIP method 0), never deflated. */
export const STORED = 0;

/** The ZIP of `dir` (a grain's `public/`): deterministic, every file stored as it is. */
export function makeBundle(dir: string): Bundle {
  const files = filesUnder(dir);
  if (files.length === 0) throw new Error(`${dir}: no files to bundle`);
  if (files.length > MAX_BUNDLE_FILES) throw new Error(`${dir}: ${files.length} files; a bundle holds at most ${MAX_BUNDLE_FILES}`);
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
    if (unpacked > MAX_BUNDLE) {
      throw new Error(`the files come to more than ${MAX_BUNDLE} bytes; a bundle stores them as they are and holds at most that (20 MiB)`);
    }
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
      b.writeUInt16LE(STORED, at); at += 2;
      b.writeUInt16LE(0, at); at += 2;
      b.writeUInt16LE(0x0021, at); at += 2;
      b.writeUInt32LE(crc, at); at += 4;
      b.writeUInt32LE(data.length, at); at += 4; // compressed size: stored, the same
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
    const local = Buffer.concat([head(0x04034b50, false), nameBytes, data]);
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
  // What every node and wallet runs on it (32-images §2a): this writer's own output always passes.
  const checked = checkBundle(zip, MAX_BUNDLE);
  if (!checked.ok) throw new Error(`the bundle fails the bundle check (${checked.reason}): a bug in grain bundle, please report it`);
  return { zip, hash: bundleHash(zip), size: zip.length, files };
}

/** `m` with its entry sealed to `bundle`: sources, start and connect from `options`, else from its sealed entry. No
 *  sources: the network keeps the bundle (`grain publish` names relays' copies where the network's protocol needs one). */
export function sealed(m: Manifest, bundle: Bundle, options: { sources?: string[]; start?: string; connect?: string[] }): Manifest {
  const before = "sealed" in m.entry ? m.entry.sealed : null;
  const sources = options.sources ?? before?.sources ?? [];
  if (sources.length > 8) throw new Error("--sources: at most 8");
  const start = options.start ?? before?.start ?? "index.html";
  if (!bundle.files.includes(start)) throw new Error(`start: ${start} is not in the bundle`);
  return {
    ...m,
    entry: { sealed: { bundle: bundle.hash, size: bundle.size, sources, start, connect: options.connect ?? before?.connect ?? [] } },
  };
}
