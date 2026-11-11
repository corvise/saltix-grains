#!/usr/bin/env node
// In the SDK's public repository: the golden vectors are the protocol's, byte for byte. Each file in vectors/ has the
// git blob id that vectors/SOURCE records for it at the corvise/saltix commit it names (scripts/sync-vectors.mjs writes
// both), and SOURCE names every file. CI runs it; a vector edited here by hand, or a file synced without its id, fails.
//
//   node scripts/check-vectors.mjs [vectors dir] [--saltix <checkout>]
//
// With a checkout of corvise/saltix it also checks the ids against the commit SOURCE names, and says which files its
// HEAD has changed since: time to sync.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VECTORS, SDK } from "./vectors.mjs";

/** Git's id of a file's bytes: SHA-1 of "blob <length>\0" and the bytes. */
export const blobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** What SOURCE says: the commit and each file's blob id. */
export function readSource(dir) {
  const lines = readFileSync(join(dir, "SOURCE"), "utf8").split("\n").filter((l) => l.trim() !== "");
  const head = /^corvise\/saltix ([0-9a-f]{40})$/.exec(lines[0] ?? "");
  if (!head) throw new Error("SOURCE: the first line is `corvise/saltix <commit>`");
  const ids = new Map();
  for (const line of lines.slice(1)) {
    const m = /^([a-z0-9-]+\.json) ([0-9a-f]{40})$/.exec(line);
    if (!m) throw new Error(`SOURCE: "${line}" is not "<file> <blob id>"`);
    ids.set(m[1], m[2]);
  }
  return { commit: head[1], ids };
}

/** Why the vectors in `dir` are not the ones SOURCE names, one line each; empty when they are. */
export function vectorProblems(dir) {
  const { ids } = readSource(dir);
  const problems = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    const want = ids.get(f);
    if (want === undefined) problems.push(`${f}: not in SOURCE (sync it with scripts/sync-vectors.mjs)`);
    else if (blobId(readFileSync(join(dir, f))) !== want) problems.push(`${f}: not the protocol's bytes (blob ${want}): never edit a vector by hand`);
  }
  for (const f of ids.keys()) if (!files.includes(f)) problems.push(`${f}: in SOURCE, missing here`);
  return problems;
}

/**
 * SOURCE in `dir` against a checkout of corvise/saltix: `problems`, the ids that are not the files' at the commit it
 * names; `changed`, the files the checkout's HEAD has changed, or dropped, since.
 */
export function sourceAgainst(dir, checkout) {
  const { commit, ids } = readSource(dir);
  const idAt = (rev, f) => {
    try {
      return execFileSync("git", ["-C", checkout, "rev-parse", "--verify", `${rev}:${PROTOCOL_VECTORS}/${f}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      return null;
    }
  };
  const problems = [];
  const changed = [];
  for (const [f, id] of ids) {
    if (idAt(commit, f) !== id) problems.push(`${f}: SOURCE's id is not the file at ${commit}`);
    if (idAt("HEAD", f) !== id) changed.push(f);
  }
  return { commit, problems, changed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--saltix");
  const saltix = at >= 0 ? args.splice(at, 2)[1] : null;
  const dir = args[0] ?? join(SDK, "vectors");
  const problems = vectorProblems(dir);
  if (saltix) {
    const against = sourceAgainst(dir, saltix);
    problems.push(...against.problems);
    for (const f of against.changed) console.log(`${f}: changed in corvise/saltix since ${against.commit.slice(0, 12)}: sync it`);
  }
  for (const p of problems) console.error(p);
  if (problems.length > 0) process.exit(1);
  console.log(`vectors: the protocol's bytes (${readSource(dir).ids.size} files)`);
}
