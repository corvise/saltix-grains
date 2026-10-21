// grain bundle and grain dev for sealed grains: one ZIP for the same files, named by its hash in the manifest.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, bundleHash, checkBundle, fromHex, toHex, verifyManifest } from "@saltix/grain-server";
import { STORED, makeBundle, sealed } from "../dist/bundle.js";
import { serve, DEV_BUNDLE } from "../dist/dev.js";
import { scratch } from "../../../scripts/scratch.mjs";

function grainDir() {
  const dir = scratch("grain-bundle-");
  mkdirSync(join(dir, "public", "js"), { recursive: true });
  writeFileSync(join(dir, "public", "index.html"), "<h1>notes</h1>".repeat(50));
  writeFileSync(join(dir, "public", "js", "app.js"), "console.log(1)");
  writeFileSync(join(dir, "public", ".DS_Store"), "junk");
  return dir;
}

const secret = fromHex("61".repeat(32), 32);
const manifest = (entry) => ({
  slug: "notes", version: 1, owner: toHex(accountId(ed25519.getPublicKey(secret))),
  owner_key: { ed25519: toHex(ed25519.getPublicKey(secret)) }, name: { en: "Notes" }, description: {},
  icon: "11".repeat(32), entry, permissions: 1, sponsor: null, min_host: 1,
});

test("the same files make the same bundle, whatever their times", () => {
  const dir = grainDir();
  const a = makeBundle(join(dir, "public"));
  utimesSync(join(dir, "public", "index.html"), new Date(2030, 1, 1), new Date(2030, 1, 1));
  const b = makeBundle(join(dir, "public"));
  assert.equal(a.hash, b.hash);
  assert.equal(a.hash, bundleHash(a.zip));
  assert.deepEqual(a.files, ["index.html", "js/app.js"], "hidden files stay out, names sorted");
  writeFileSync(join(dir, "public", "js", "app.js"), "console.log(2)");
  assert.notEqual(makeBundle(join(dir, "public")).hash, a.hash);
  // Any unzip reads it back.
  writeFileSync(join(dir, "b.zip"), a.zip);
  const listing = execFileSync("unzip", ["-l", join(dir, "b.zip")]).toString();
  assert.match(listing, /index\.html/);
  assert.match(listing, /js\/app\.js/);
  assert.equal(execFileSync("unzip", ["-p", join(dir, "b.zip"), "index.html"]).toString(), "<h1>notes</h1>".repeat(50));
  // Past what wallets unpack: refused before anything is built.
  writeFileSync(join(dir, "public", "zeros.bin"), Buffer.alloc(64 * 1024 * 1024 + 1));
  assert.throws(() => makeBundle(join(dir, "public")), /unpacks to at most/);
  writeFileSync(join(dir, "public", "zeros.bin"), Buffer.alloc(1));
  mkdirSync(join(dir, "public", "bad"), { recursive: true });
  writeFileSync(join(dir, "public", "bad", "a\tb.js"), "");
  assert.throws(() => makeBundle(join(dir, "public")), /names use/);
});

/** A fixed tree: a page, a script in a folder, every byte value, a name with a space, and a hidden file left out. */
function fixedTree() {
  const dir = scratch("grain-fixed-");
  mkdirSync(join(dir, "js"));
  mkdirSync(join(dir, "img"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>\n<h1>Notes</h1>\n".repeat(40));
  writeFileSync(join(dir, "js", "app.js"), 'console.log("notes");\n');
  writeFileSync(join(dir, "img", "bytes.bin"), Uint8Array.from({ length: 256 }, (_, i) => i));
  writeFileSync(join(dir, "a b.txt"), "a name with a space\n");
  writeFileSync(join(dir, ".hidden"), "left out");
  return dir;
}

/** The ZIP's entries as its central directory names them: method, sizes, CRC, and the local header's agreeing. */
function entries(zip) {
  const b = Buffer.from(zip);
  const end = b.length - 22;
  assert.equal(b.readUInt32LE(end), 0x06054b50, "the end record, no comment");
  const count = b.readUInt16LE(end + 10);
  let at = b.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(b.readUInt32LE(at), 0x02014b50);
    const method = b.readUInt16LE(at + 10);
    const crc = b.readUInt32LE(at + 16);
    const packed = b.readUInt32LE(at + 20);
    const size = b.readUInt32LE(at + 24);
    const nameLength = b.readUInt16LE(at + 28);
    const local = b.readUInt32LE(at + 42);
    const name = b.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    assert.equal(b.readUInt32LE(local), 0x04034b50);
    assert.equal(b.readUInt16LE(local + 8), method, `${name}: the local header's method`);
    assert.equal(b.readUInt32LE(local + 18), packed, `${name}: the local header's size`);
    out.push({ name, method, crc, packed, size });
    at += 46 + nameLength;
  }
  return out;
}

// The bytes of a bundle are a constant of its files: this hash names the ZIP built on Node 22 and 24 and, byte for byte,
// one built by hand from the format with another language's CRC; CI builds it again on Node 20 and 24
// (.github/workflows/ci.yml). A change here changes the next hash of every published grain.
const FIXED_HASH = "9a2d268c1857a1fd9bd39338d65a7370d476b46c19849f608638d9917627d589";

test("a bundle's bytes depend on its files only: every entry stored, the same hash on any Node", () => {
  const dir = fixedTree();
  const a = makeBundle(dir);
  const b = makeBundle(dir);
  assert.deepEqual(b.zip, a.zip, "built twice, the same bytes");
  assert.deepEqual(a.files, ["a b.txt", "img/bytes.bin", "index.html", "js/app.js"]);
  const listed = entries(a.zip);
  assert.deepEqual(listed.map((e) => e.name), a.files);
  for (const e of listed) {
    assert.equal(e.method, STORED, `${e.name}: stored, not deflated (a deflater's output is its own)`);
    assert.equal(e.packed, e.size, `${e.name}: stored as it is`);
  }
  assert.ok(listed.find((e) => e.name === "index.html").size > 1000, "compressible, and still stored");
  const bytes = (name) => Buffer.byteLength(name);
  assert.equal(a.size, listed.reduce((n, e) => n + 30 + 46 + 2 * bytes(e.name) + e.size, 22), "headers, names and files: nothing else");
  assert.equal(a.hash, FIXED_HASH, `on ${process.version}`);
  writeFileSync(join(dir, "bundle.zip"), a.zip);
  assert.match(execFileSync("unzip", ["-t", join(dir, "bundle.zip")]).toString(), /No errors detected/);
  assert.deepEqual(execFileSync("unzip", ["-p", join(dir, "bundle.zip"), "img/bytes.bin"]), Buffer.from(Uint8Array.from({ length: 256 }, (_, i) => i)));
});

test("files past 20 MiB are refused, however well they would compress", () => {
  const dir = scratch("grain-large-");
  writeFileSync(join(dir, "zeros.bin"), Buffer.alloc(20 * 1024 * 1024 + 1));
  assert.throws(() => makeBundle(dir), /holds at most that \(20 MiB\)/);
  writeFileSync(join(dir, "zeros.bin"), Buffer.alloc(20 * 1024 * 1024 - 200));
  assert.ok(makeBundle(dir).size <= 20 * 1024 * 1024, "just under it fits, headers and all");
});

test("the manifest names the bundle, its sources, start and connect", () => {
  const dir = grainDir();
  const b = makeBundle(join(dir, "public"));
  const hosted = manifest({ hosted: { url: "https://notes.example/", origins: ["https://notes.example"] } });
  // No source: the network keeps the bundle (grain publish names relays' copies where the protocol needs one).
  assert.deepEqual(sealed(hosted, b, {}).entry.sealed.sources, []);
  assert.throws(() => sealed(hosted, b, { sources: Array.from({ length: 9 }, (_, i) => `https://cdn${i}.example/n.zip`) }), /at most 8/);
  assert.throws(() => sealed(hosted, b, { sources: ["https://cdn.example/n.zip"], start: "main.html" }), /not in the bundle/);
  const m = sealed(hosted, b, { sources: ["https://cdn.example/n.zip"], connect: ["https://api.notes.example"] });
  assert.deepEqual(m.entry, { sealed: { bundle: b.hash, size: b.size, sources: ["https://cdn.example/n.zip"], start: "index.html", connect: ["https://api.notes.example"] } });
  assert.deepEqual(sealed(m, b, {}).entry, m.entry, "a new bundle keeps the sealed entry's sources and connect");
});

test("grain dev serves a sealed grain's bundle where its manifest says", async () => {
  const dir = grainDir();
  const m = manifest({ sealed: { bundle: "00".repeat(32), size: 1, sources: ["https://cdn.example/n.zip"], start: "index.html", connect: [] } });
  const server = await serve(dir, () => m, secret, 0, "127.0.0.1");
  const port = server.address().port;
  const get = (path, host) => new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
  try {
    assert.equal((await get(DEV_BUNDLE, `10.0.2.2:${port}`)).status, 404, "no bundle before a manifest names one");
    const signed = JSON.parse((await get("/.well-known/saltix-grain", `10.0.2.2:${port}`)).body.toString());
    const e = signed.manifest.entry.sealed;
    assert.deepEqual(e.sources, [`http://10.0.2.2:${port}${DEV_BUNDLE}`]);
    assert.ok(verifyManifest(signed, true));
    const zip = (await get(DEV_BUNDLE, `10.0.2.2:${port}`)).body;
    assert.equal(zip.length, e.size);
    assert.equal(bundleHash(new Uint8Array(zip)), e.bundle);
  } finally {
    server.close();
  }
});

test("the agents' rules say how a bundle is checked: rebuilt in CI, grain.json unchanged", async () => {
  const { agentsMd } = await import("../dist/template.js");
  const root = readFileSync(new URL("../../../AGENTS.md", import.meta.url), "utf8");
  const guide = readFileSync(new URL("../../../docs/agents/app.md", import.meta.url), "utf8");
  for (const text of [agentsMd("notes", false), root, guide]) {
    assert.match(text, /rebuild it in CI and fail when `grain\.json` changes/i);
    assert.match(text, /never edit\s+`entry\.sealed` by hand/);
  }
});

test("grain bundle writes the protocol's bundle byte for byte, and the network's bundle check takes it (vectors/images-v1.json)", () => {
  const v = JSON.parse(readFileSync(new URL("../../../vectors/images-v1.json", import.meta.url), "utf8"));
  const dir = scratch("grain-vector-");
  for (const f of v.bundles.made_from) {
    mkdirSync(join(dir, ...f.name.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...f.name.split("/")), f.text);
  }
  const made = makeBundle(dir);
  const expected = v.bundles.made.find((b) => /grain bundle writes it/.test(b.name));
  assert.equal(Buffer.from(made.zip).toString("hex"), expected.hex);
  assert.equal(made.hash, expected.hash);
  assert.equal(made.size, expected.bytes);
  assert.deepEqual(checkBundle(made.zip), { ok: true, value: { files: expected.files, unpacked: expected.unpacked } });
});

test("a key file, a chat's store or app.json under public/ never goes into a bundle, grain dev never serves it, and grain lint says so first", async () => {
  const { refusedInBundle, secretsUnder } = await import("../dist/bundle.js");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { rmSync } = await import("node:fs");
  const dir = scratch("grain-bundle-secrets-");
  mkdirSync(join(dir, "public", "data"), { recursive: true });
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>x</title>");
  assert.ok(makeBundle(join(dir, "public")).files.includes("index.html"), "a clean public/ bundles");
  // A bundle is uploaded before the owner signs and served by its hash to anyone: these are refused, never skipped.
  for (const [name, what] of [["server.key", "a key file"], ["app.key", "a key file"], ["data/chat.store.json", "a chat's store"], ["app.json", "the server's app.json"]]) {
    writeFileSync(join(dir, "public", name), "61".repeat(32) + "\n");
    assert.throws(() => makeBundle(join(dir, "public")), new RegExp(`${name.replace(/\./g, "\\.")}: ${what}.*never goes into a bundle.*serves to anyone`), name);
    assert.deepEqual(secretsUnder(join(dir, "public")).map((s) => s.name), [name]);
    assert.equal(typeof refusedInBundle(name.split("/").at(-1)), "string");
    rmSync(join(dir, "public", name));
  }
  assert.equal(refusedInBundle("index.html"), null);
  assert.equal(refusedInBundle("keys.js"), null, "only the name's end counts");
  assert.deepEqual(secretsUnder(join(dir, "nowhere")), []);
  // grain dev: such a file is not served either, whatever its path.
  writeFileSync(join(dir, "public", "owner.key"), "61".repeat(32) + "\n");
  const server = await serve(dir, () => manifest({ hosted: { url: "http://localhost/index.html", origins: ["http://localhost"] } }), secret, 0);
  try {
    assert.equal(server.address().address, "127.0.0.1", "this computer only unless --host says otherwise");
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/owner.key`)).status, 404);
    assert.equal((await fetch(`${base}/index.html`)).status, 200);
  } finally {
    server.close();
  }
  // grain lint: an error naming the file, before grain bundle or grain publish would refuse it.
  writeFileSync(join(dir, "grain.json"), JSON.stringify(manifest({ hosted: { url: "https://notes.example/index.html", origins: ["https://notes.example"] } })));
  const lint = spawnSync("node", [fileURLToPath(new URL("../dist/main.js", import.meta.url)), "lint"], { cwd: dir, encoding: "utf8" });
  assert.equal(lint.status, 1);
  assert.match(lint.stderr, /error: public\/owner\.key: a key file \(\*\.key\) under public\/ would go into the bundle.*move it out/);
  rmSync(join(dir, "public", "owner.key"));
  const clean = spawnSync("node", [fileURLToPath(new URL("../dist/main.js", import.meta.url)), "lint"], { cwd: dir, encoding: "utf8" });
  assert.doesNotMatch(clean.stderr, /owner\.key|would go into the bundle/, "nothing left under public/ to report");
});
