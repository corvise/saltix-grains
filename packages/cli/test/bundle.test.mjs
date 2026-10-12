// grain bundle and grain dev for sealed grains: one ZIP for the same files, named by its hash in the manifest.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, bundleHash, fromHex, toHex, verifyManifest } from "@saltix/grain-server";
import { makeBundle, sealed } from "../dist/bundle.js";
import { serve, DEV_BUNDLE } from "../dist/dev.js";

function grainDir() {
  const dir = mkdtempSync(join(tmpdir(), "grain-bundle-"));
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
  // Compressible past what wallets unpack: refused though the ZIP would be small.
  writeFileSync(join(dir, "public", "zeros.bin"), Buffer.alloc(64 * 1024 * 1024 + 1));
  assert.throws(() => makeBundle(join(dir, "public")), /unpacks to at most/);
  writeFileSync(join(dir, "public", "zeros.bin"), Buffer.alloc(1));
  mkdirSync(join(dir, "public", "bad"), { recursive: true });
  writeFileSync(join(dir, "public", "bad", "a\tb.js"), "");
  assert.throws(() => makeBundle(join(dir, "public")), /names use/);
});

test("the manifest names the bundle, its sources, start and connect", () => {
  const dir = grainDir();
  const b = makeBundle(join(dir, "public"));
  const hosted = manifest({ hosted: { url: "https://notes.example/", origins: ["https://notes.example"] } });
  assert.throws(() => sealed(hosted, b, {}), /--sources/);
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
