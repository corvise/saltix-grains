// The golden vectors are the protocol's bytes: each has the blob id vectors/SOURCE records for it at the corvise/saltix
// commit it names (scripts/sync-vectors.sh), and scripts/check-vectors.mjs, which CI runs, refuses anything else.
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blobId, readSource, vectorProblems } from "../../../scripts/check-vectors.mjs";
import { scratch } from "../../../scripts/scratch.mjs";

const vectors = fileURLToPath(new URL("../../../vectors/", import.meta.url));

test("every vector here is the file SOURCE names at its commit, and SOURCE names every one", () => {
  const { commit, ids } = readSource(vectors);
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.ok(ids.size >= 8);
  assert.deepEqual(vectorProblems(vectors), []);
  // Git's own id of the bytes: "blob <length>\0" and the bytes under SHA-1.
  assert.equal(blobId(new TextEncoder().encode("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("a vector edited by hand, one SOURCE does not name, or one missing, is refused", () => {
  const dir = scratch("vectors-");
  cpSync(vectors, dir, { recursive: true });
  const file = join(dir, "grains-v1.json");
  const bytes = readFileSync(file);
  bytes[bytes.length - 2] ^= 1;
  writeFileSync(file, bytes);
  writeFileSync(join(dir, "extra-v1.json"), "{}");
  rmSync(join(dir, "handles-v1.json"));
  const problems = vectorProblems(dir);
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.match(problems.join("\n"), /grains-v1\.json: not the protocol's bytes/);
  assert.match(problems.join("\n"), /extra-v1\.json: not in SOURCE/);
  assert.match(problems.join("\n"), /handles-v1\.json: in SOURCE, missing here/);
});
