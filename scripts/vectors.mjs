// The golden vectors — the protocol's own bytes (vectors/README.md) — as this SDK's tests read them. They stand in one
// of two places, and this file alone knows which:
//   - in the SDK's public repository, copies in vectors/ beside the packages, each held byte for byte to the commit of
//     corvise/saltix that vectors/SOURCE names (scripts/sync-vectors.mjs makes them, scripts/check-vectors.mjs checks);
//   - in corvise/saltix itself, where the protocol is written, the repository's own, read in place.
// A test reads a file by its name written out, `goldenVectors("<name>.json")`: the names read that way are the copies
// the public repository carries (vectorNames), so a vector a test reads is never missing there and none is carried
// unread. Nothing else in the SDK's code names the repository's directory, so a move of it is a change of one line here
// (packages/server/test/vector-copies.test.mjs holds both rules).
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This SDK's directory. */
export const SDK = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Where corvise/saltix keeps the vectors, from its root (this SDK is its mini-apps/). */
export const PROTOCOL_VECTORS = "salarium/vectors";

const NAME = /^[a-z0-9-]+\.json$/;
/** The SDK's code: what reads vectors is among it. */
const CODE_DIRS = ["packages", "scripts", "simulator", "examples"];
const CODE = /\.(mjs|cjs|js|ts)$/;
const NOT_CODE = new Set(["node_modules", "dist", "vectors"]);

const ownVectors = (sdk) => join(sdk, "..", ...PROTOCOL_VECTORS.split("/"));

/**
 * Whether this SDK stands in corvise/saltix, as its mini-apps/ beside the protocol's vectors, and not in its public
 * repository. The directory's name is part of it: a clone of the public repository may stand beside any directory.
 */
export function inProtocolRepository(sdk = SDK) {
  return basename(realpathSync(sdk)) === "mini-apps" && existsSync(ownVectors(sdk));
}

/**
 * The directory the vectors are read from: the SDK's copies where it has them, else the repository's own. The copies
 * come first, so in corvise/saltix the SDK carries none (vector-copies.test.mjs): a copy there would be read in place
 * of the vector it was made from.
 */
export function vectorsDir(sdk = SDK) {
  const copies = join(sdk, "vectors");
  if (existsSync(join(copies, "SOURCE"))) return copies;
  const own = ownVectors(sdk);
  if (existsSync(own)) return own;
  throw new Error(`the golden vectors are not here: ${copies} holds no copies (no SOURCE), and no ${PROTOCOL_VECTORS}/ ` +
    `stands beside this SDK (it is neither its public repository nor corvise/saltix's mini-apps/)`);
}

/** A file of vectors, parsed. */
export function goldenVectors(name) {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error(`${JSON.stringify(name)} names no file of vectors (<name>.json)`);
  return JSON.parse(readFileSync(join(vectorsDir(), name), "utf8"));
}

/** Every file of the SDK's code, as paths from its directory with `/`, in order; this file, which reads none, left out. */
export function codeFiles(sdk = SDK) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith(".") || NOT_CODE.has(e.name)) continue;
      const at = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), at);
      else if (e.isFile() && CODE.test(e.name) && at !== "scripts/vectors.mjs") out.push(at);
    }
  };
  for (const d of CODE_DIRS) if (existsSync(join(sdk, d))) walk(join(sdk, d), d);
  return out;
}

/** The files of vectors the SDK's code reads, by name, in order: what the public repository carries copies of. */
export function vectorNames(sdk = SDK) {
  const names = new Set();
  for (const f of codeFiles(sdk)) {
    for (const m of readFileSync(join(sdk, f), "utf8").matchAll(/\bgoldenVectors\("([a-z0-9-]+\.json)"\)/g)) names.add(m[1]);
  }
  return [...names].sort();
}
