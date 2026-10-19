// `grain publish` end to end (Saltix 12-grains §10, 32-images §7): a page made with `grain init` goes straight into the
// network — sealed, checked, uploaded in pieces on the paired key's statement before the owner signs, the publishing link
// for the owner's Saltix, the registry watched, the icon uploaded — against the development node, which takes blobs as a
// node does; a playing wallet signs what the link carries. Also: no paired key (the bundle after the owner signs), a
// network of protocol version 2 (no sources), --no-wait and a second run that finishes, refusals in words and in the log,
// the version raised, hosted and chat-only apps, the command line over HTTP, and `grain doctor` at every stage. No
// secret is ever printed, logged or written outside the key files.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { AppKey, RpcError, accountId, fromHex, namedHash, readPublishLink, signManifest, toHex } from "@saltix/grain-server";
import { createDevRegistry } from "@saltix/grain-server/dev";
import { DevLog, reasonOf } from "../dist/devlog.js";
import { BLOB_WORDS, PublishError, formOf, nodeNow, publishApp } from "../dist/publish-flow.js";
import { doctor } from "../dist/status.js";
import { isRelaySource } from "../dist/sources.js";

const vectors = JSON.parse(readFileSync(new URL("../../../vectors/images-v1.json", import.meta.url), "utf8"));
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const GENESIS = "5a".repeat(32);
const OWNER = fromHex("41".repeat(32), 32);
const SERVER = fromHex("42".repeat(32), 32);
const SERVER_KEY = toHex(ed25519.getPublicKey(SERVER));
const ICON = vectors.images.find((i) => i.kind === "grain_icon" && i.width === 512);
const SLUG = "space-game";

/** Relays of the network's list: four, on four networks, two offering space. */
const RELAYS = [1, 2, 3, 4].map((n) => ({
  key: toHex(ed25519.getPublicKey(fromHex(String(n).padStart(2, "0").repeat(32), 32))), store_gib: n % 2 === 0 ? 8 : null,
  endpoints: [{ url: `wss://10.${n}.0.1:30335/`, cert_sha256: "cd".repeat(32) }],
}));

/** A project as `grain init` makes one, with a game's page in public/ and the standard icon. */
function project({ version = 1, entry, paired = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "grain-publish-"));
  mkdirSync(join(dir, "public", "js"), { recursive: true });
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>Space</title><script src=\"js/game.js\"></script>");
  writeFileSync(join(dir, "public", "js", "game.js"), "addEventListener('load',()=>window.saltix?.grain_ready?.())");
  writeFileSync(join(dir, "icon.png"), Buffer.from(ICON.hex, "hex"));
  const key = toHex(ed25519.getPublicKey(fromHex("77".repeat(32), 32)));
  writeFileSync(join(dir, "grain.json"), JSON.stringify({
    slug: SLUG, version, owner: toHex(accountId(fromHex(key, 32))), owner_key: { ed25519: key }, name: { en: "Space", ru: "Космос" },
    description: { en: "A game" }, icon: ICON.hash,
    entry: entry ?? { hosted: { url: `https://${SLUG}.example/`, origins: [`https://${SLUG}.example`] } }, permissions: 0, sponsor: null, min_host: 1,
  }, null, 2));
  if (paired) writeFileSync(join(dir, "app.key"), AppKey.of("devnet", GENESIS, SLUG, SERVER).reveal() + "\n", { mode: 0o600 });
  return dir;
}

/** The development node: the app made in Saltix (a chat-only manifest at version 1, the paired key named). */
const node = (over = {}) => createDevRegistry({ slug: SLUG, ownerSecret: OWNER, servers: [SERVER_KEY], genesis: GENESIS, relays: RELAYS, ...over });

/** The owner's Saltix: the manifest the link carries, filled in with the owner and signed, published at a new block. */
function wallet(registry, link) {
  const m = readPublishLink(link);
  const owner = toHex(ed25519.getPublicKey(OWNER));
  const signed = signManifest({ ...m, owner: toHex(accountId(fromHex(owner, 32))), owner_key: { ed25519: owner } }, OWNER);
  registry.publish(signed);
  return signed;
}

const until = async (what, check, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const linkIn = (lines) => until("the publishing link", () => lines.join("\n").match(/salt:grain-publish\?m=[A-Za-z0-9_-]+/)?.[0]);

/** `publishApp` with its output kept. */
function run(dir, registry, over = {}) {
  const lines = [];
  const log = new DevLog(dir, "publish", "test");
  const done = publishApp({
    dir, manifestPath: join(dir, "grain.json"), node: registry, flags: "", log, hosted: false, wallet: false, keyPath: join(dir, "owner.key"),
    wait: true, timeoutMs: 15_000, out: join(dir, "signed.json"), signing: { node: registry, validFor: 600 }, tty: false,
    print: (l) => lines.push(l), pause: async () => {}, pollMs: 20, ...over,
  });
  return { lines, done };
}

const logOf = (dir) => readFileSync(join(dir, ".grain", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const steps = (dir) => logOf(dir).map((l) => `${l.step}:${l.outcome}${l.reason ? `:${l.reason}` : ""}`);

/** Nothing secret anywhere but the key files: the output, the log, the state, the page, signed.json, grain.json. */
function assertNoSecrets(dir, lines) {
  const secrets = [toHex(SERVER), toHex(OWNER), "77".repeat(32), AppKey.of("devnet", GENESIS, SLUG, SERVER).reveal()];
  const texts = [lines.join("\n")];
  for (const f of [".grain/log.jsonl", ".grain/publish.json", ".grain/publish.html", "signed.json", "grain.json"]) {
    if (existsSync(join(dir, f))) texts.push(readFileSync(join(dir, f), "utf8"));
  }
  for (const text of texts) for (const s of secrets) assert.ok(!text.includes(s), "a secret leaked");
  // The log holds codes and numbers only: never a slug, a hash, a path or a key.
  for (const line of logOf(dir)) {
    for (const value of Object.values(line)) {
      assert.ok(!String(value).includes(SLUG) && !/[0-9a-f]{32}/.test(String(value)) && !String(value).includes("/"), JSON.stringify(line));
    }
  }
}

test("a page goes into the network before the owner signs, on the paired key's word; the owner signs; the icon follows", async () => {
  const registry = node();
  const dir = project();
  const { lines, done } = run(dir, registry);
  const link = await linkIn(lines);
  // Before the owner signed: the bundle is held pending on the statement, and the link names it.
  const m = readPublishLink(link);
  assert.ok("sealed" in m.entry);
  const hash = m.entry.sealed.bundle;
  assert.ok(registry.blobs.get(hash), "the network holds the bundle");
  assert.ok(registry.blobs.get(hash).pendingUntil > Date.now());
  assert.equal(m.version, 2, "above the version the app made in Saltix holds");
  assert.equal(m.entry.sealed.sources.length, 3, "protocol version 1: copies at 3 relays of the network's own list");
  assert.ok(m.entry.sealed.sources.every((s) => isRelaySource(s) && s.endsWith(hash)));
  assert.ok(m.entry.sealed.sources.every((s) => RELAYS.some((r) => s.startsWith(r.endpoints[0].url.replace("wss:", "https:").replace(/\/$/, "")))));
  assert.match(lines.join("\n"), /the network holds the bundle, pending until/);
  assert.ok(!registry.blobs.has(ICON.hash), "no icon before the registry names it");
  wallet(registry, link);
  assert.equal(await done, 0, lines.join("\n"));
  // After: the registry holds it, the bundle is kept as a named one, the icon is in the network.
  assert.equal(registry.grain.version, 2);
  assert.equal(registry.blobs.get(hash).pendingUntil, null);
  assert.ok(registry.blobs.has(ICON.hash));
  assert.match(lines.at(-1), /space-game v2 is published, its bundle in the network/);
  // grain.json is what was published, sealed; bundle.zip is the bundle; signed.json the registry's.
  const written = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8"));
  assert.equal(written.version, 2);
  assert.equal(written.entry.sealed.bundle, hash);
  assert.equal(namedHash("grain_bundle", new Uint8Array(readFileSync(join(dir, "bundle.zip")))), hash);
  assert.equal(JSON.parse(readFileSync(join(dir, "signed.json"), "utf8")).manifest.entry.sealed.bundle, hash);
  const state = JSON.parse(readFileSync(join(dir, ".grain", "publish.json"), "utf8"));
  assert.ok(state.uploaded_at && state.pending_until && state.link_shown_at && state.published_at && state.icon_uploaded_at);
  assert.deepEqual(steps(dir), [
    "network:ok:protocol_1", "bundle:ok:built", "sources:ok:relays", "version:ok:raised", "upload:ok:pending", "link:waiting:shown",
    "registry:ok:published", "icon:ok:uploaded", "published:ok:sealed",
  ]);
  assertNoSecrets(dir, lines);
  // grain doctor: published, nothing left.
  const d = await doctor(dir, registry);
  assert.equal(d.publish, "published");
  assert.deepEqual(d.findings.filter((f) => !f.ok).map((f) => f.what), ["connect profile"]);
});

test("without a paired key the owner signs first, and the bundle goes up once the registry names it", async () => {
  const registry = node({ registered: false });
  const dir = project({ paired: false });
  const { lines, done } = run(dir, registry);
  const link = await linkIn(lines);
  assert.match(lines.join("\n"), /upload: once the registry names the bundle \(no server key here: grain pair lets the bundle go up before the owner signs\)/);
  assert.match(lines.join("\n"), /Registering space-game keeps a deposit of 10 SALT/);
  assert.equal(registry.blobs.size, 0, "nothing is in the network before the registry names it");
  assert.equal(readPublishLink(link).version, 1, "a new slug: grain.json's version");
  wallet(registry, link);
  assert.equal(await done, 0, lines.join("\n"));
  const hash = readPublishLink(link).entry.sealed.bundle;
  assert.equal(registry.blobs.get(hash).pendingUntil, null, "kept as named");
  assert.ok(registry.blobs.has(ICON.hash));
  assert.ok(steps(dir).includes("upload:waiting:after_registry_unpaired"));
  assert.ok(steps(dir).includes("upload:ok:named"));
  assertNoSecrets(dir, lines);
});

test("protocol version 2: the manifest names no source, the network is the bundle's source", async () => {
  const registry = node({ protocol: 2 });
  const dir = project();
  const { lines, done } = run(dir, registry);
  const link = await linkIn(lines);
  assert.deepEqual(readPublishLink(link).entry.sealed.sources, []);
  assert.match(lines.join("\n"), /sources: none: the network keeps the bundle \(protocol version 2\)/);
  wallet(registry, link);
  assert.equal(await done, 0);
  assert.ok(steps(dir).includes("sources:ok:network"));
});

test("--no-wait returns once the owner has the link; the next run finds the version published and finishes the icon", async () => {
  const registry = node();
  const dir = project();
  const first = run(dir, registry, { wait: false });
  assert.equal(await first.done, 0);
  assert.match(first.lines.join("\n"), /Once the owner confirmed, grain publish again finishes it\./);
  // grain doctor meanwhile: the bundle pending, the owner to sign.
  const waiting = await doctor(dir, registry);
  assert.equal(waiting.publish, "waiting_for_owner");
  assert.match(waiting.findings.find((f) => f.what === "upload").next, /the owner scans the QR code in Saltix/);
  wallet(registry, await linkIn(first.lines));
  assert.ok(!registry.blobs.has(ICON.hash));
  const second = run(dir, registry);
  assert.equal(await second.done, 0, second.lines.join("\n"));
  assert.match(second.lines.join("\n"), /space-game v2 is in the registry already: finishing its uploads/);
  assert.ok(registry.blobs.has(ICON.hash));
  assert.ok(!second.lines.join("\n").includes("salt:grain-publish"), "no link a second time");
  // A third run: nothing left to do, nothing uploaded again.
  const before = registry.calls.blob_put ?? 0;
  const third = run(dir, registry);
  assert.equal(await third.done, 0);
  assert.equal(registry.calls.blob_put ?? 0, before);
  assert.match(third.lines.join("\n"), /icon: the network holds it/);
});

test("a refusal ends the publish in words, with what to do, and in the log by its reason; busy is waited out", async () => {
  const registry = node();
  const dir = project();
  registry.blobPutHook = () => ({ reason: "pending" });
  const { lines, done } = run(dir, registry);
  await assert.rejects(done, (e) => e instanceof PublishError && e.step === "upload" && e.reason === "pending" &&
    /the bundle was refused: pending \(the node holds as many bundles pending as it takes.*\)\. Next: let the owner sign/.test(e.message));
  assert.equal(reasonOf(new PublishError("upload", "pending", "")), "upload_pending");
  assert.ok(steps(dir).includes("upload:refused:pending"));
  assert.ok(!lines.join("\n").includes("salt:grain-publish"), "no link for a bundle the network does not hold");
  // Busy twice, then it takes it.
  const busy = ["busy", "busy"];
  registry.blobPutHook = () => (busy.length > 0 ? { reason: busy.shift() } : undefined);
  const again = run(dir, registry);
  wallet(registry, await linkIn(again.lines));
  assert.equal(await again.done, 0);
  assert.equal(steps(dir).filter((s) => s === "upload:waiting:busy").length, 2);
  // Every reason the node gives has words and a next step.
  for (const reason of vectors.bundle_frames.blob_put_reasons) assert.ok(BLOB_WORDS[reason]?.words && BLOB_WORDS[reason]?.next, reason);
  for (const r of vectors.frames.blob_put.reasons) assert.ok(BLOB_WORDS[r], r);
});

test("the paired key vouches only for its own app on its own network; otherwise the bundle waits for the registry", async () => {
  // The registry names another key: the statement would be refused, so none is made.
  const registry = node({ servers: ["22".repeat(32)] });
  const dir = project();
  const { lines, done } = run(dir, registry);
  const link = await linkIn(lines);
  assert.match(lines.join("\n"), /the registry no longer names this computer's key: grain pair --new/);
  assert.equal(registry.blobs.size, 0);
  wallet(registry, link);
  assert.equal(await done, 0);
  // A developer key of another network: the same.
  const other = node();
  const dir2 = project({ paired: false });
  writeFileSync(join(dir2, "app.key"), AppKey.of("devnet", "6b".repeat(32), SLUG, SERVER).reveal() + "\n", { mode: 0o600 });
  const second = run(dir2, other);
  await linkIn(second.lines);
  assert.match(second.lines.join("\n"), /app\.key is for another network/);
  wallet(other, await linkIn(second.lines));
  assert.equal(await second.done, 0);
  // An app.key others may read is refused outright.
  const dir3 = project();
  chmodSync(join(dir3, "app.key"), 0o644);
  if (process.platform !== "win32") await assert.rejects(run(dir3, node()).done, (e) => e instanceof PublishError && e.reason === "key_file_mode" && /readable by others/.test(e.message));
});

test("which form: a page sealed by default, grain init's placeholder too; a real hosted page only with --hosted; chat-only as it is", async () => {
  const m = (entry) => ({ slug: SLUG, entry });
  assert.equal(formOf(m({ hosted: { url: "https://space-game.example/", origins: ["https://space-game.example"] } }), false), "sealed");
  assert.equal(formOf(m({ sealed: {} }), false), "sealed");
  assert.equal(formOf(m({ chat: {} }), false), "chat");
  assert.throws(() => formOf(m({ hosted: { url: "https://game.org/", origins: ["https://game.org"] } }), false), (e) => e.reason === "hosted_entry" && /--hosted/.test(e.message));
  assert.equal(formOf(m({ hosted: { url: "https://game.org/", origins: ["https://game.org"] } }), true), "hosted");
  assert.throws(() => formOf(m({ chat: {} }), true), (e) => e.reason === "chat_has_no_page");
  assert.throws(() => formOf(m({ hosted: { url: "https://space-game.example/", origins: ["https://space-game.example"] } }), true), (e) => e.reason === "hosted_without_origin");
  // --hosted publishes the page where it is: no bundle, no upload, the icon after.
  const registry = node();
  const dir = project({ entry: { hosted: { url: "https://game.org/", origins: ["https://game.org"] } } });
  const { lines, done } = run(dir, registry, { hosted: true });
  const link = await linkIn(lines);
  assert.deepEqual(readPublishLink(link).entry, { hosted: { url: "https://game.org/", origins: ["https://game.org"] } });
  wallet(registry, link);
  assert.equal(await done, 0);
  assert.ok(!existsSync(join(dir, "bundle.zip")));
  assert.deepEqual([...registry.blobs.keys()], [ICON.hash]);
  // The node's own clock dates a statement; this computer's only when the node says nothing of it.
  assert.equal(nodeNow({ genesis_time: 1_700_000_000, slot: 100 }, 5), 1_700_000_100_000);
  assert.equal(nodeNow({}, 5), 5);
});

test("the command line over HTTP: grain publish --no-wait, the owner signs, grain publish finishes, grain doctor says where it stands", async (t) => {
  const registry = node();
  // The development node's wallet interface over plain HTTP, as --node takes it.
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const { id, method, params } = JSON.parse(body);
      try {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: await registry.call(method, params) }));
      } catch (e) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: e instanceof RpcError ? e.code : -32000, message: e.reason ?? e.message, data: e.data ?? undefined } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const dir = project();
  const grain = (args) => new Promise((resolve) => {
    const child = spawn("node", [main, ...args, "--node", url], { cwd: dir, env: { ...process.env, SALTIX_APP_KEY: "" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (status) => resolve({ status, out, err }));
  });
  const first = await grain(["publish", "--no-wait"]);
  assert.equal(first.status, 0, first.err + first.out);
  assert.match(first.out, /bundle: 2 files/);
  assert.match(first.out, /uploaded 100%/);
  const link = first.out.match(/salt:grain-publish\?m=[A-Za-z0-9_-]+/)[0];
  const waiting = await grain(["doctor", "--json"]);
  assert.equal(JSON.parse(waiting.out).publish, "waiting_for_owner");
  wallet(registry, link);
  const second = await grain(["publish"]);
  assert.equal(second.status, 0, second.err + second.out);
  assert.match(second.out, /is published/);
  const done = await grain(["doctor", "--json"]);
  assert.equal(JSON.parse(done.out).publish, "published");
  // A mistyped flag is refused before anything happens.
  assert.equal((await grain(["publish", "--hostd"])).status, 2);
  assertNoSecrets(dir, [first.out, first.err, second.out, second.err]);
  assert.ok(readdirSync(join(dir, ".grain")).includes("publish.html"));
});

test("with owner.key on a test network: signed and sent here, the bundle and the icon once it landed; an app of the phone's goes to Saltix", async () => {
  const OWNER_FILE = fromHex("77".repeat(32), 32);
  const registry = node({ registered: false });
  // The node's ledger as far as the key file's call needs it: funds, the pool, and the block that takes the call.
  const submitted = [];
  const ledger = {
    async call(method, params) {
      if (method === "account_get") return { nonce: 0, salt: "200000000000" };
      if (method === "transaction_get") return { status: "included" };
      if (method === "transaction_submit") {
        submitted.push(params.transaction);
        // What the call carries is grain.json as published: the key file's own signature.
        const m = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8"));
        registry.publish(signManifest(m, OWNER_FILE));
        return { id: "ab".repeat(32) };
      }
      return registry.call(method, params);
    },
  };
  const dir = project({ paired: false });
  writeFileSync(join(dir, "owner.key"), "77".repeat(32) + "\n", { mode: 0o600 });
  const { lines, done } = run(dir, ledger, { signing: { node: ledger, validFor: 600 } });
  assert.equal(await done, 0, lines.join("\n"));
  assert.equal(submitted.length, 1);
  assert.match(lines.join("\n"), /register space-game v1: transaction (ab){32} \(fee \d+, deposit 10 SALT\)/);
  assert.equal(registry.grain.owner, toHex(accountId(ed25519.getPublicKey(OWNER_FILE))));
  const hash = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")).entry.sealed.bundle;
  assert.equal(registry.blobs.get(hash).pendingUntil, null);
  assert.ok(registry.blobs.has(ICON.hash));
  assert.ok(steps(dir).includes("sign:ok:key_file"));
  assertNoSecrets(dir, lines);
  // Without funds: what to do, in words.
  const dir2 = project({ paired: false, version: 1 });
  writeFileSync(join(dir2, "owner.key"), "77".repeat(32) + "\n", { mode: 0o600 });
  const fresh = node({ registered: false });
  const broke = { call: (m, p) => (m === "account_get" ? Promise.resolve({ nonce: 0, salt: "0" }) : fresh.call(m, p)) };
  await assert.rejects(run(dir2, broke, { signing: { node: broke, validFor: 600 } }).done,
    (e) => e instanceof PublishError && e.reason === "no_salt" && /grain faucet --wait.*or --wallet/.test(e.message));
  // An app made in Saltix is its owner's phone's: owner.key here cannot sign for it, so the owner's Saltix is asked.
  const phones = node();
  const dir3 = project();
  writeFileSync(join(dir3, "owner.key"), "77".repeat(32) + "\n", { mode: 0o600 });
  const third = run(dir3, phones);
  const link = await linkIn(third.lines);
  assert.match(third.lines.join("\n"), /registered to another account than .*owner\.key's \(an app made in Saltix is its owner's phone's\): asking the owner's Saltix/);
  wallet(phones, link);
  assert.equal(await third.done, 0);
});
