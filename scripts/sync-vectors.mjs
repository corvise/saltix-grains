#!/usr/bin/env node
// In the SDK's public repository: copy the golden vectors its tests read from a checkout of corvise/saltix into
// vectors/, and record that checkout's commit and each file's git blob id in vectors/SOURCE. CI holds the copies to those
// ids byte for byte (scripts/check-vectors.mjs), so a vector edited here by hand fails. The files are the ones the tests
// read (scripts/vectors.mjs: vectorNames), taken from the commit itself, never from the checkout's working tree: what
// SOURCE names is what was copied, whatever is being edited there. A copy no test reads any more goes.
//
//   node scripts/sync-vectors.mjs <path to a checkout of corvise/saltix>
//   node scripts/sync-vectors.mjs --paths    the vectors the tests read as corvise/saltix's paths, one a line
//
// In corvise/saltix itself the tests read the repository's vectors in place: there is nothing to sync, and it says so.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VECTORS, SDK, inProtocolRepository, vectorNames } from "./vectors.mjs";

/** A vector may be megabytes of images. */
const MAX_BYTES = 256 * 1024 * 1024;

/**
 * Copy `names` as the checkout `source` has them at its HEAD into the directory `into`, write its SOURCE, and remove
 * the copies not among them. Nothing is written unless the commit has every one of them.
 */
export function syncVectors({ source, into, names }) {
  const git = (...a) => execFileSync("git", ["-C", source, ...a], { maxBuffer: MAX_BYTES, stdio: ["ignore", "pipe", "pipe"] });
  let commit;
  try {
    commit = git("rev-parse", "--verify", "HEAD^{commit}").toString().trim();
    git("cat-file", "-e", `${commit}:${PROTOCOL_VECTORS}`);
  } catch {
    throw new Error(`${source} is not a checkout of corvise/saltix (no git, or no ${PROTOCOL_VECTORS}/ at its HEAD)`);
  }
  if (names.length === 0) throw new Error("no test reads a vector: nothing to sync");
  const files = names.map((name) => {
    let id;
    try {
      id = git("rev-parse", "--verify", `${commit}:${PROTOCOL_VECTORS}/${name}`).toString().trim();
    } catch {
      throw new Error(`${name}: a test reads it, and corvise/saltix ${commit.slice(0, 12)} has no ${PROTOCOL_VECTORS}/${name}`);
    }
    return { name, id, bytes: git("cat-file", "blob", id) };
  });
  mkdirSync(into, { recursive: true });
  const removed = readdirSync(into).filter((f) => f.endsWith(".json") && !names.includes(f)).sort();
  for (const f of removed) rmSync(join(into, f));
  for (const f of files) writeFileSync(join(into, f.name), f.bytes);
  writeFileSync(join(into, "SOURCE"), [`corvise/saltix ${commit}`, ...files.map((f) => `${f.name} ${f.id}`)].join("\n") + "\n");
  return { commit, copied: names, removed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const [arg, ...rest] = process.argv.slice(2);
  if (arg === "--paths" && rest.length === 0) {
    for (const name of vectorNames()) console.log(`${PROTOCOL_VECTORS}/${name}`);
  } else if (arg === undefined || arg.startsWith("-") || rest.length > 0) {
    console.error("usage: scripts/sync-vectors.mjs <path to a checkout of corvise/saltix> | --paths");
    process.exit(2);
  } else {
    try {
      if (inProtocolRepository()) {
        throw new Error("this SDK stands in corvise/saltix, where its tests read the repository's vectors in place: nothing to " +
          "sync (the copies are the public repository's, made there)");
      }
      const { commit, copied, removed } = syncVectors({ source: arg, into: join(SDK, "vectors"), names: vectorNames() });
      for (const f of removed) console.log(`sync-vectors: ${f} removed: no test reads it`);
      console.log(`sync-vectors: ${copied.length} vectors from corvise/saltix ${commit.slice(0, 12)} in vectors/SOURCE`);
    } catch (e) {
      console.error(`sync-vectors: ${e.message}`);
      process.exit(1);
    }
  }
}
