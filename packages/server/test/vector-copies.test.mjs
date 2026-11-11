// The golden vectors stand in one of two places (scripts/vectors.mjs), and the SDK's public repository carries copies
// of the ones its tests read (scripts/sync-vectors.mjs makes them, scripts/check-vectors.mjs holds them to the
// protocol's bytes). What keeps the two repositories one SDK:
//   - one file names the protocol repository's directory, and every read of a vector names its file in full, so the
//     copies are exactly the files read: none missing there, none carried unread;
//   - in the protocol's repository the SDK carries no copy (a copy would be read in place of the vector it was made
//     from); in the public one the copies are the ones read, each the bytes SOURCE records;
//   - a sync takes the commit's bytes, never the working tree's, and writes nothing unless the commit has every file;
//     the check refuses a copy edited, one SOURCE does not name and one missing.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratch } from "../../../scripts/scratch.mjs";
import * as vectors from "../../../scripts/vectors.mjs";
import { syncVectors } from "../../../scripts/sync-vectors.mjs";
import { blobId, readSource, sourceAgainst, vectorProblems } from "../../../scripts/check-vectors.mjs";

const { PROTOCOL_VECTORS, SDK, codeFiles, inProtocolRepository, vectorNames, vectorsDir } = vectors;
const THIS = "packages/server/test/vector-copies.test.mjs";
/** The reader's name, never written here beside a file's: this file is code too, and reads no vector. */
const READER = "goldenVectors";
const reads = (name) => `${READER}("${name}")`;
const HERE = inProtocolRepository();

const hasGit = spawnSync("git", ["--version"]).status === 0;
const NO_GIT = !hasGit && "git is not installed";
/** Git in a scratch repository, whatever the machine's own configuration signs, hooks or names. */
const git = (dir, ...args) => execFileSync("git", [
  "-C", dir, "-c", "user.name=A test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
  "-c", "core.hooksPath=/dev/null", ...args,
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Write `files` (name → text, or null to remove) where the protocol's repository keeps its vectors. */
function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, ...PROTOCOL_VECTORS.split("/"), name);
    mkdirSync(dirname(path), { recursive: true });
    if (text === null) rmSync(path);
    else writeFileSync(path, text);
  }
}

/** Commit `files` in the scratch repository `dir`; the commit's id. */
function commit(dir, files) {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "vectors");
  return git(dir, "rev-parse", "HEAD");
}

/** A scratch repository shaped as the protocol's, with `files` committed, and the commit's id. */
function repository(files) {
  const dir = scratch("grain-vectors-repo-");
  git(dir, "init", "-q");
  return { dir, commit: commit(dir, files) };
}

/** What the SDK's vectors/ holds, a desktop's own files (.DS_Store) aside. */
const carried = () => readdirSync(join(SDK, "vectors")).filter((f) => !f.startsWith(".")).sort();

const A = '{"version":1,"a":[1,2,3]}\n';
const B = '{"version":1,"b":"é"}\n';
const C = '{"version":1,"c":null}\n';

test("one file names the protocol repository's directory", () => {
  const files = codeFiles();
  assert.ok(files.length > 100, `only ${files.length} files of code found`);
  assert.ok(files.includes(THIS) && !files.includes("scripts/vectors.mjs"));
  assert.ok(files.every((f) => !/(^|\/)(node_modules|dist)\//.test(f)), "no dependency and no build among the code");
  for (const f of files) {
    assert.ok(!readFileSync(join(SDK, f), "utf8").includes(PROTOCOL_VECTORS),
      `${f} names ${PROTOCOL_VECTORS}: the vectors are read by ${READER}("<name>.json") (scripts/vectors.mjs), which alone knows where they stand`);
  }
});

test("every read of a vector names its file in full, so the copies are the files read", () => {
  const importLine = new RegExp(`^import \\{ ${READER} \\} from "(\\.\\./)+scripts/vectors\\.mjs";$`, "m");
  const literal = new RegExp(`\\b${READER}\\("[a-z0-9-]+\\.json"\\)`, "g");
  const any = new RegExp(`\\b${READER}\\b`, "g");
  let readers = 0;
  for (const f of codeFiles()) {
    if (f === THIS) continue;
    const text = readFileSync(join(SDK, f), "utf8");
    const uses = (text.match(any) ?? []).length;
    if (uses === 0) continue;
    readers++;
    assert.ok(importLine.test(text), `${f}: imports it as \`import { ${READER} } from "…/scripts/vectors.mjs";\`, alone and under its own name`);
    assert.equal(uses, 1 + (text.match(literal) ?? []).length,
      `${f}: every use is ${READER}("<name>.json") with the name written out (a name in a variable is a copy the public repository would lack)`);
  }
  assert.ok(readers >= 20, `only ${readers} files read vectors`);
  const names = vectorNames();
  assert.ok(names.length >= 10 && names.includes("crypto-v1.json"), `the files read: ${names.join(", ")}`);
  assert.deepEqual(names, [...new Set(names)].sort(), "each once, in order");
  for (const name of names) assert.ok(existsSync(join(vectorsDir(), name)), `${name} is read and stands in ${vectorsDir()}`);
});

test("the reader takes a file's name and nothing else", () => {
  assert.equal(vectors[READER]("crypto-v1.json").version, 1);
  for (const name of ["../package.json", "crypto-v1", "Crypto-v1.json", "a/b.json", "", ".json", 7, undefined]) {
    assert.throws(() => vectors[READER](name), /names no file of vectors/, String(name));
  }
});

test("the files read are found in the code alone: no dependency, no build, no page, no copy", () => {
  const sdk = scratch("grain-vectors-sdk-");
  const put = (path, text) => {
    mkdirSync(dirname(join(sdk, path)), { recursive: true });
    writeFileSync(join(sdk, path), text);
  };
  put("packages/p/test/a.test.mjs", `const a = ${reads("b-v1.json")};\nconst b = ${reads("a-v1.json")}.x;\nconst c = ${reads("b-v1.json")};\n`);
  put("packages/p/src/x.ts", `// ${reads("in-a-comment-v1.json")} is a read all the same: the copy is carried\n`);
  put("simulator/s.ts", `${READER}(name); my${reads("not-the-reader.json")}; ${READER}("Upper.json"); ${READER}('quoted.json');\n`);
  put("packages/p/node_modules/dep/index.mjs", reads("of-a-dependency.json"));
  put("packages/p/dist/index.js", reads("of-a-build.json"));
  put("packages/p/.hidden/h.mjs", reads("hidden.json"));
  put("docs/page.md", reads("of-a-page.json"));
  put("vectors/SOURCE.mjs", reads("of-the-copies.json"));
  put("scripts/vectors.mjs", reads("of-the-resolver.json"));
  put("other/o.mjs", reads("outside-the-code.json"));
  assert.deepEqual(codeFiles(sdk), ["packages/p/src/x.ts", "packages/p/test/a.test.mjs", "simulator/s.ts"]);
  assert.deepEqual(vectorNames(sdk), ["a-v1.json", "b-v1.json", "in-a-comment-v1.json"]);
});

test("the vectors are read from the SDK's copies where it has them, else from the protocol's repository", () => {
  const root = scratch("grain-vectors-place-");
  const dir = (...parts) => {
    mkdirSync(join(root, ...parts), { recursive: true });
    return join(root, ...parts);
  };
  // The protocol's repository: the SDK is its mini-apps/, beside the vectors.
  const inRepo = dir("saltix", "mini-apps");
  const own = dir("saltix", ...PROTOCOL_VECTORS.split("/"));
  assert.equal(vectorsDir(inRepo), own);
  assert.equal(inProtocolRepository(inRepo), true);
  // The public repository: copies beside the packages, whatever stands next to the clone — a directory named as the
  // protocol's vectors are is not the protocol's repository.
  const clone = dir("saltix", "a-clone");
  assert.equal(inProtocolRepository(clone), false, "the SDK's directory there is mini-apps/");
  writeFileSync(join(dir("saltix", "a-clone", "vectors"), "SOURCE"), "");
  assert.equal(vectorsDir(clone), join(clone, "vectors"));
  // A copy wins wherever it is, which is why the protocol's repository carries none.
  writeFileSync(join(dir("saltix", "mini-apps", "vectors"), "SOURCE"), "");
  assert.equal(vectorsDir(inRepo), join(inRepo, "vectors"));
  // Neither: said, with both places.
  const alone = dir("elsewhere", "sdk");
  assert.equal(inProtocolRepository(alone), false);
  assert.throws(() => vectorsDir(alone), (e) => e.message.includes(join(alone, "vectors")) && e.message.includes(PROTOCOL_VECTORS));
  mkdirSync(join(alone, "vectors"));
  assert.throws(() => vectorsDir(alone), /no copies \(no SOURCE\)/, "a directory without SOURCE holds no copies");
});

test("in the protocol's repository the SDK carries the vectors' page and no copy", { skip: !HERE && "the SDK's public repository carries the copies" }, () => {
  assert.deepEqual(carried(), ["README.md"]);
  assert.equal(vectorsDir(), join(SDK, "..", ...PROTOCOL_VECTORS.split("/")));
  // The sync is the public repository's: here it refuses, whatever checkout it is given, and writes nothing.
  const run = spawnSync(process.execPath, [join(SDK, "scripts", "sync-vectors.mjs"), join(SDK, "..")], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^sync-vectors: this SDK stands in corvise\/saltix, .*nothing to sync/);
  assert.deepEqual(carried(), ["README.md"]);
});

test("in the public repository the copies are the files the tests read, each the bytes SOURCE records", { skip: HERE && "the protocol's repository: the vectors are read in place" }, () => {
  const dir = join(SDK, "vectors");
  assert.equal(vectorsDir(), dir);
  assert.deepEqual([...readSource(dir).ids.keys()].sort(), vectorNames(), "SOURCE names the files read: scripts/sync-vectors.mjs brings a new one");
  assert.deepEqual(vectorProblems(dir), []);
  assert.ok(existsSync(join(dir, "README.md")));
});

test("the sync's paths are the files read, as the protocol's repository names them", () => {
  const run = spawnSync(process.execPath, [join(SDK, "scripts", "sync-vectors.mjs"), "--paths"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trimEnd().split("\n"), vectorNames().map((name) => `${PROTOCOL_VECTORS}/${name}`));
  for (const args of [[], ["--paths", "more"], ["--other"], ["a", "b"]]) {
    const bad = spawnSync(process.execPath, [join(SDK, "scripts", "sync-vectors.mjs"), ...args], { encoding: "utf8" });
    assert.equal(bad.status, 2, args.join(" "));
    assert.match(bad.stderr, /^usage: /);
  }
});

test("a sync copies the commit's bytes, not the working tree's, records them, and removes a copy no test reads", { skip: NO_GIT }, () => {
  const repo = repository({ "a-v1.json": A, "b-v1.json": B, "c-v1.json": C });
  // Being edited in the checkout, and not committed: a changed vector, a new one, one removed.
  write(repo.dir, { "a-v1.json": '{"edited":true}\n', "d-v1.json": "{}\n", "b-v1.json": null });
  const into = join(scratch("grain-vectors-copies-"), "vectors");
  mkdirSync(into);
  writeFileSync(join(into, "README.md"), "the page\n");
  writeFileSync(join(into, "old-v1.json"), "{}\n");
  writeFileSync(join(into, "a-v1.json"), "stale\n");

  const done = syncVectors({ source: repo.dir, into, names: ["a-v1.json", "b-v1.json"] });
  assert.deepEqual(done, { commit: repo.commit, copied: ["a-v1.json", "b-v1.json"], removed: ["old-v1.json"] });
  assert.deepEqual(readdirSync(into).sort(), ["README.md", "SOURCE", "a-v1.json", "b-v1.json"]);
  assert.equal(readFileSync(join(into, "a-v1.json"), "utf8"), A);
  assert.equal(readFileSync(join(into, "b-v1.json"), "utf8"), B);
  assert.equal(readFileSync(join(into, "README.md"), "utf8"), "the page\n");
  assert.equal(readFileSync(join(into, "SOURCE"), "utf8"),
    `corvise/saltix ${repo.commit}\na-v1.json ${blobId(Buffer.from(A))}\nb-v1.json ${blobId(Buffer.from(B))}\n`);
  // The ids are git's own for those files at that commit.
  assert.equal(blobId(Buffer.from(A)), git(repo.dir, "rev-parse", `${repo.commit}:${PROTOCOL_VECTORS}/a-v1.json`));
  assert.deepEqual(vectorProblems(into), []);
  assert.deepEqual(sourceAgainst(into, repo.dir), { commit: repo.commit, problems: [], changed: [] });
  // From a directory inside the checkout too, and a second sync changes nothing.
  const before = readFileSync(join(into, "SOURCE"), "utf8");
  assert.deepEqual(syncVectors({ source: join(repo.dir, PROTOCOL_VECTORS.split("/")[0]), into, names: ["a-v1.json", "b-v1.json"] }).removed, []);
  assert.equal(readFileSync(join(into, "SOURCE"), "utf8"), before);
});

test("a sync writes nothing unless the commit has every vector a test reads", { skip: NO_GIT }, () => {
  const repo = repository({ "a-v1.json": A });
  write(repo.dir, { "d-v1.json": "{}\n" });
  const into = join(scratch("grain-vectors-copies-"), "vectors");
  mkdirSync(into);
  writeFileSync(join(into, "old-v1.json"), "{}\n");
  const untouched = () => assert.deepEqual(readdirSync(into), ["old-v1.json"]);

  assert.throws(() => syncVectors({ source: repo.dir, into, names: ["a-v1.json", "missing-v1.json"] }),
    new RegExp(`^Error: missing-v1\\.json: a test reads it, and corvise/saltix ${repo.commit.slice(0, 12)} has no ${PROTOCOL_VECTORS}/missing-v1\\.json$`));
  untouched();
  assert.throws(() => syncVectors({ source: repo.dir, into, names: ["a-v1.json", "d-v1.json"] }), /d-v1\.json: a test reads it/,
    "a file of the working tree alone is not the commit's");
  untouched();
  assert.throws(() => syncVectors({ source: repo.dir, into, names: [] }), /no test reads a vector/);
  untouched();
  // No checkout of the protocol's repository: a directory without git, and a repository without its vectors.
  const plain = scratch("grain-vectors-plain-");
  assert.throws(() => syncVectors({ source: plain, into, names: ["a-v1.json"] }), /is not a checkout of corvise\/saltix/);
  const other = scratch("grain-vectors-other-");
  git(other, "init", "-q");
  writeFileSync(join(other, "file"), "x\n");
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "another repository");
  assert.throws(() => syncVectors({ source: other, into, names: ["a-v1.json"] }), /is not a checkout of corvise\/saltix/);
  untouched();
  // A new directory is made only by a sync that succeeds.
  const fresh = join(scratch("grain-vectors-copies-"), "vectors");
  assert.throws(() => syncVectors({ source: repo.dir, into: fresh, names: ["missing-v1.json"] }), /a test reads it/);
  assert.ok(!existsSync(fresh));
  assert.deepEqual(syncVectors({ source: repo.dir, into: fresh, names: ["a-v1.json"] }).copied, ["a-v1.json"]);
  assert.deepEqual(readdirSync(fresh).sort(), ["SOURCE", "a-v1.json"]);
});

test("the check refuses a copy that is not the protocol's bytes, one SOURCE does not name and one missing", { skip: NO_GIT }, () => {
  const repo = repository({ "a-v1.json": A, "b-v1.json": B, "c-v1.json": C });
  const into = join(scratch("grain-vectors-copies-"), "vectors");
  const names = ["a-v1.json", "b-v1.json", "c-v1.json"];
  syncVectors({ source: repo.dir, into, names });
  const check = (...args) => spawnSync(process.execPath, [join(SDK, "scripts", "check-vectors.mjs"), into, ...args], { encoding: "utf8" });
  const ok = check();
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "vectors: the protocol's bytes (3 files)\n");

  // One byte, the same length: only the id tells.
  writeFileSync(join(into, "a-v1.json"), A.replace("3", "4"));
  writeFileSync(join(into, "x-v1.json"), "{}\n");
  rmSync(join(into, "b-v1.json"));
  assert.deepEqual(vectorProblems(into), [
    `a-v1.json: not the protocol's bytes (blob ${blobId(Buffer.from(A))}): never edit a vector by hand`,
    "x-v1.json: not in SOURCE (sync it with scripts/sync-vectors.mjs)",
    "b-v1.json: in SOURCE, missing here",
  ]);
  const bad = check();
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr.trimEnd().split("\n").length, 3);
  assert.equal(bad.stdout, "");
  // The sync puts it right.
  syncVectors({ source: repo.dir, into, names });
  assert.deepEqual(vectorProblems(into), []);

  // SOURCE is read strictly: a commit, then a file and its id a line.
  const source = readFileSync(join(into, "SOURCE"), "utf8");
  for (const [text, why] of [
    [source.replace("corvise/saltix ", "saltix "), /the first line is/],
    [source.replace(repo.commit, repo.commit.slice(0, 12)), /the first line is/],
    [`${source}d-v1.json abc\n`, /is not "<file> <blob id>"/],
    [`${source}../d.json ${"0".repeat(40)}\n`, /is not "<file> <blob id>"/],
    ["", /the first line is/],
  ]) {
    writeFileSync(join(into, "SOURCE"), text);
    assert.throws(() => vectorProblems(into), why, JSON.stringify(text.slice(0, 40)));
  }
});

test("SOURCE against the protocol's checkout: its ids are the commit's, and what changed since is named", { skip: NO_GIT }, () => {
  const repo = repository({ "a-v1.json": A, "b-v1.json": B, "c-v1.json": C });
  const into = join(scratch("grain-vectors-copies-"), "vectors");
  syncVectors({ source: repo.dir, into, names: ["a-v1.json", "b-v1.json", "c-v1.json"] });
  // The checkout goes on: a vector changed, one dropped, one as it was; a change not committed is not the checkout's HEAD.
  commit(repo.dir, { "a-v1.json": A.replace("3", "4"), "b-v1.json": null });
  write(repo.dir, { "c-v1.json": "{}\n" });
  assert.deepEqual(sourceAgainst(into, repo.dir), { commit: repo.commit, problems: [], changed: ["a-v1.json", "b-v1.json"] });
  const check = spawnSync(process.execPath, [join(SDK, "scripts", "check-vectors.mjs"), into, "--saltix", repo.dir], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, [
    `a-v1.json: changed in corvise/saltix since ${repo.commit.slice(0, 12)}: sync it`,
    `b-v1.json: changed in corvise/saltix since ${repo.commit.slice(0, 12)}: sync it`,
    "vectors: the protocol's bytes (3 files)\n",
  ].join("\n"));

  // An id that is not the file's at the commit SOURCE names, the copy edited to match it: only the checkout tells.
  const forged = A.replace("3", "5");
  writeFileSync(join(into, "a-v1.json"), forged);
  const source = readFileSync(join(into, "SOURCE"), "utf8");
  writeFileSync(join(into, "SOURCE"), source.replace(blobId(Buffer.from(A)), blobId(Buffer.from(forged))));
  assert.deepEqual(vectorProblems(into), [], "the copy is the bytes SOURCE names");
  assert.deepEqual(sourceAgainst(into, repo.dir).problems, [`a-v1.json: SOURCE's id is not the file at ${repo.commit}`]);
  // And a commit the checkout does not have.
  writeFileSync(join(into, "SOURCE"), source.replace(repo.commit, "1".repeat(40)));
  assert.equal(sourceAgainst(into, repo.dir).problems.length, 3);
});
