// The grain command line: projects, checks, the dev server and the registry calls against a fake node.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, mkdirSync, statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, toHex, fromHex, verifyManifest } from "@salarium/grain-server";
import { lint, sign, forOrigin, readKey, signedFor } from "../dist/project.js";
import { publish, retire, walletLink, waitForPublished } from "../dist/registry.js";
import { serve } from "../dist/dev.js";
import { publishLink, publishLinkManifest } from "../dist/publish.js";
import { encodeManifest } from "@salarium/grain-server";

const secret = fromHex("61".repeat(32), 32);
const owner = toHex(ed25519.getPublicKey(secret));
const ownerId = toHex(accountId(fromHex(owner, 32)));
const manifest = (over = {}) => ({
  slug: "chess", version: 1, owner_key: owner, name: { en: "Chess", ru: "Шахматы" }, description: {},
  icon: "11".repeat(32), entry: { hosted: { url: "https://chess.example/", origins: ["https://chess.example"] } },
  permissions: 1, sponsor: null, min_host: 1, ...over,
});

test("lint says what stops a registration", () => {
  assert.deepEqual(lint(manifest(), owner), { errors: [], warnings: [] });
  const dev = lint(manifest({ entry: { hosted: { url: "http://10.0.2.2:8090/", origins: ["http://10.0.2.2:8090"] } } }));
  assert.match(dev.errors[0], /developer origins/);
  assert.match(lint(manifest({ slug: "Chess" })).errors[0], /^slug/);
  assert.match(lint(manifest(), "22".repeat(32)).errors[0], /owner_key/);
  const languages = ["en", "ru", "de", "fr", "es", "it", "pt", "pl", "uk", "kk", "tr", "ja", "zh", "ko", "ar", "hi"];
  // Every text at its longest, in four-byte characters, and a long URL: in bounds, but too large to register.
  const texts = (n) => Object.fromEntries(languages.map((l) => [l, "\u{1F600}".repeat(n)]));
  const url = "https://chess.example/" + "a".repeat(2000);
  const huge = manifest({ name: texts(32), description: texts(200), entry: { hosted: { url, origins: ["https://chess.example"] } } });
  assert.match(lint(huge).errors[0], /^size/, "a manifest too large for a transaction");
  assert.equal(lint(manifest({ icon: "00".repeat(32), name: { en: "Chess" } })).warnings.length, 2);
});

test("a manifest is signed for its owner, and for a developer's origin", () => {
  const signed = sign(manifest(), secret);
  assert.ok(verifyManifest(signed));
  const local = forOrigin(manifest(), "http://10.0.2.2:8090");
  assert.deepEqual(local.entry, { hosted: { url: "http://10.0.2.2:8090/", origins: ["http://10.0.2.2:8090"] } });
  assert.ok(verifyManifest(sign(local, secret, true), true));
  assert.throws(() => sign(manifest({ owner_key: "22".repeat(32) }), secret), /owner_key/);
});

/** A node that answers the wallet interface from `state` and records what was submitted. */
async function fakeNode(state) {
  const submitted = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      const result = {
        node_status: { genesis: "5a".repeat(32), slot: 1000, network: "devnet" },
        account_get: { nonce: 4, salt: state.salt ?? "200000000000" },
        grain_get: { grain: state.grain ?? null },
        transaction_submit: { id: "ab".repeat(32) },
      }[method];
      if (method === "transaction_submit") submitted.push(params.transaction);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, submitted, close: () => server.close() };
}

const signing = (node) => ({ node, validFor: 600 });
// After sender (32), nonce, fee and valid_until_slot (8 each): Action::Registry (1), then the call's tag.
const callTag = (hex) => fromHex(hex)[57];

test("publish registers a new slug and updates the owner's", async () => {
  const fresh = await fakeNode({});
  const sent = await publish(sign(manifest(), secret), secret, signing(fresh.url));
  assert.equal(sent.call, "register");
  assert.equal(callTag(fresh.submitted[0]), 7);
  fresh.close();

  const grain = (over) => ({ slug: "chess", owner: ownerId, version: 1, retired: null, ...over });
  const mine = await fakeNode({ grain: grain() });
  assert.equal((await publish(sign(manifest({ version: 2 }), secret), secret, signing(mine.url))).call, "update");
  assert.equal(callTag(mine.submitted[0]), 8);
  await assert.rejects(publish(sign(manifest(), secret), secret, signing(mine.url)), /raise "version"/);
  mine.close();

  const theirs = await fakeNode({ grain: grain({ owner: "99".repeat(32) }) });
  await assert.rejects(publish(sign(manifest({ version: 2 }), secret), secret, signing(theirs.url)), /another owner/);
  theirs.close();
  const retired = await fakeNode({ grain: grain({ retired: 5 }) });
  await assert.rejects(publish(sign(manifest({ version: 2 }), secret), secret, signing(retired.url)), /never used again/);
  await assert.rejects(retire("chess", secret, signing(retired.url)), /retired already/);
  retired.close();
  const poor = await fakeNode({ salt: "99000000000" });
  await assert.rejects(publish(sign(manifest(), secret), secret, signing(poor.url)), /needs/);
  assert.equal(poor.submitted.length, 0);
  poor.close();
  const other = await fakeNode({});
  await assert.rejects(publish(sign(manifest(), secret), secret, { ...signing(other.url), genesis: "00".repeat(32) }), /genesis/);
  assert.equal(other.submitted.length, 0);
  other.close();
});

test("retire closes the owner's slug", async () => {
  const node = await fakeNode({ grain: { slug: "chess", owner: ownerId, version: 1, retired: null } });
  assert.equal((await retire("chess", secret, signing(node.url))).call, "retire");
  assert.equal(callTag(node.submitted[0]), 9);
  node.close();
});

test("grain dev serves public/ and the manifest for the asking origin only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grain-dev-"));
  mkdirSync(join(dir, "public"));
  writeFileSync(join(dir, "public", "index.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, "secret.txt"), "no");
  const server = await serve(dir, () => manifest(), secret, 0, "127.0.0.1");
  const port = server.address().port;
  // fetch() keeps its own Host header: a plain request names the one a phone would send.
  const get = (path, host = `127.0.0.1:${port}`) => new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject).end();
  });
  try {
    assert.equal((await get("/")).body, "<h1>hi</h1>");
    const signed = JSON.parse((await get("/.well-known/salarium-grain", `10.0.2.2:${port}`)).body);
    assert.equal(signed.manifest.entry.hosted.origins[0], `http://10.0.2.2:${port}`);
    assert.ok(verifyManifest(signed, true));
    assert.equal((await get("/.well-known/salarium-grain", "evil.example")).status, 400);
    assert.equal((await get("/%2e%2e/secret.txt")).status, 404);
    assert.equal((await get("/../secret.txt")).status, 404);
  } finally {
    server.close();
  }
});

test("init makes a project the owner alone can sign for", () => {
  const dir = mkdtempSync(join(tmpdir(), "grain-init-"));
  const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
  execFileSync("node", [main, "init", join(dir, "dice"), "--name", "Dice"], { stdio: "pipe" });
  for (const f of ["grain.json", "owner.key", "public/index.html", "public/app.js", "public/grain.js", ".gitignore"]) {
    assert.ok(existsSync(join(dir, "dice", f)), f);
  }
  assert.equal(statSync(join(dir, "dice", "owner.key")).mode & 0o777, 0o600);
  const m = JSON.parse(readFileSync(join(dir, "dice", "grain.json"), "utf8"));
  assert.equal(m.slug, "dice");
  const key = readKey(join(dir, "dice", "owner.key"));
  assert.equal(m.owner_key, toHex(ed25519.getPublicKey(key)));
  assert.ok(verifyManifest(signedFor(join(dir, "dice", "grain.json"), key)));
  assert.throws(() => execFileSync("node", [main, "init", join(dir, "dice")], { stdio: "pipe" }), "not over an existing grain");
});

test("the wallet's way: a link first, the signed manifest from the registry after", async () => {
  const before = await fakeNode({});
  const link = await walletLink(manifest(), before.url);
  assert.ok(link.startsWith("salt:grain-publish?m="));
  before.close();
  const registered = { slug: "chess", owner: "77".repeat(32), version: 1, retired: null };
  const stale = await fakeNode({ grain: registered });
  await assert.rejects(walletLink(manifest(), stale.url), /raise "version"/);
  stale.close();
  const gone = await fakeNode({ grain: { ...registered, retired: 9 } });
  await assert.rejects(walletLink(manifest({ version: 2 }), gone.url), /never used again/);
  gone.close();
  // The wallet's key in the registry's manifest: the same grain but for its owner.
  const walletKey = "33".repeat(32);
  const published = { manifest: { ...manifest(), owner_key: walletKey }, signature: "44".repeat(64) };
  const after = await fakeNode({ grain: { ...registered, owner: "88".repeat(32), manifest: published } });
  assert.deepEqual(await waitForPublished(after.url, manifest(), 1000), published);
  assert.equal(await waitForPublished(after.url, manifest({ version: 2 }), 100), null, "another version is not it");
  after.close();
});

test("a publish link carries the manifest without its owner", () => {
  const m = manifest();
  const link = publishLink(m);
  assert.ok(link.startsWith("salt:grain-publish?m=") && link.length < 500, link);
  assert.equal(toHex(publishLinkManifest(link)), toHex(encodeManifest({ ...m, owner_key: "00".repeat(32) })));
  // Text that does not compress: eight descriptions of 200 scattered CJK characters.
  const scattered = (seed) => Array.from({ length: 200 }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7919 + seed * 104729) % 20000))).join("");
  const huge = manifest({ description: Object.fromEntries(["en", "ru", "de", "fr", "es", "it", "pt", "pl"].map((l, k) => [l, scattered(k)])) });
  assert.throws(() => publishLink(huge), /key file/);
  assert.equal(publishLinkManifest("salt:grain/chess"), null);
});
