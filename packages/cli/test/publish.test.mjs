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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { AppKey, RpcError, accountId, fromHex, namedHash, readPublishLink, signManifest, toHex } from "@saltix/grain-server";
import { createDevRegistry } from "@saltix/grain-server/dev";
import { DevLog, reasonOf } from "../dist/devlog.js";
import { BLOB_WORDS, PublishError, formOf, nodeNow, publishApp, readiness, sameContent } from "../dist/publish-flow.js";
import { doctor, keyState } from "../dist/status.js";
import { ensureGitignore } from "../dist/pair.js";
import { isRelaySource } from "../dist/sources.js";
import { connectJson } from "../dist/template.js";
import { scratch } from "../../../scripts/scratch.mjs";

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
  const dir = scratch("grain-publish-");
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

/** `publishApp` with its output kept, on a clock that a wait moves on at once: a wait for the network (a busy node, a
 *  node a block behind) takes no real time, and one that would last minutes ends as soon. */
function run(dir, registry, over = {}) {
  const lines = [];
  const log = new DevLog(dir, "publish", "test");
  let clock = Date.now();
  const done = publishApp({
    dir, manifestPath: join(dir, "grain.json"), node: registry, flags: "", log, hosted: false, wallet: false, keyPath: join(dir, "owner.key"), keyNamed: false,
    wait: true, timeoutMs: 15_000, out: join(dir, "signed.json"), signing: { node: registry, validFor: 600 }, tty: false,
    print: (l) => lines.push(l), pollMs: 20,
    now: () => (clock = Math.max(clock, Date.now())), pause: async (ms) => { clock = Math.max(clock, Date.now()) + ms; }, ...over,
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
    "network:ok:protocol_1", "bundle:ok:built", "sources:ok:relays", "version:ok:raised", "signer:ok:wallet_no_key", "upload:ok:pending", "link:waiting:shown",
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
  assert.match(second.lines.join("\n"), /space-game v2: the registry holds it as grain\.json describes it, so there is nothing to sign/);
  assert.match(second.lines.at(-1), /space-game v2 is published/, "the icon went up: something was done");
  assert.ok(registry.blobs.has(ICON.hash));
  assert.ok(!second.lines.join("\n").includes("salt:grain-publish"), "no link a second time");
  // A third run: nothing left to do, nothing uploaded again, and it says so.
  const before = registry.calls.blob_put ?? 0;
  const third = run(dir, registry);
  assert.equal(await third.done, 0);
  assert.equal(registry.calls.blob_put ?? 0, before);
  assert.match(third.lines.join("\n"), /icon: the network holds it/);
  assert.equal(third.lines.at(-1), "nothing to publish: the registry holds space-game v2 as grain.json describes it, and the network holds its bundle and its icon. A change to public/ or grain.json publishes v3.");
});

test("run again with nothing changed: nothing to publish, nothing signed or sent; a change raises the version", async () => {
  const registry = node();
  const dir = project();
  const first = run(dir, registry);
  wallet(registry, await linkIn(first.lines));
  assert.equal(await first.done, 0);
  // A node answers with its objects' keys sorted, so the manifest it holds reads as other JSON than grain.json, which
  // keeps the order it was written in: the comparison is the manifest's own bytes.
  const answer = await registry.call("grain_get", { slug: SLUG });
  const keys = Object.keys(answer.grain.manifest.manifest);
  assert.deepEqual(keys, [...keys].sort());
  assert.notDeepEqual(Object.keys(JSON.parse(readFileSync(join(dir, "grain.json"), "utf8"))), keys);
  const held = registry.grain.version;
  const puts = registry.calls.blob_put ?? 0;
  const again = run(dir, registry);
  assert.equal(await again.done, 0, again.lines.join("\n"));
  const said = again.lines.join("\n");
  assert.match(said, /^nothing to publish: the registry holds space-game v2 as grain\.json describes it/m);
  assert.doesNotMatch(said, /salt:grain-publish|^version:|^owner:/m, "no link, no version raised, no signer");
  assert.equal(registry.grain.version, held);
  assert.equal(registry.calls.blob_put ?? 0, puts, "nothing uploaded again");
  assert.equal(JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")).version, 2);
  assert.deepEqual(steps(dir).slice(-6), ["bundle:ok:built", "sources:ok:relays", "registry:ok:published_before", "upload:ok:held", "icon:ok:held", "published:ok:unchanged"]);
  // grain.json behind the registry (another computer published it), the same content: nothing to publish either, and
  // grain.json says the registry's version again.
  const behind = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8"));
  writeFileSync(join(dir, "grain.json"), JSON.stringify({ ...behind, version: 1 }, null, 2));
  const lagging = run(dir, registry);
  assert.equal(await lagging.done, 0);
  assert.match(lagging.lines.join("\n"), /^version: nothing changed since space-game v2 in the registry; grain\.json says v2 again$/m);
  assert.match(lagging.lines.at(-1), /^nothing to publish/);
  assert.equal(JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")).version, 2);
  // A change to the page is a new version: raised, signed, published.
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>Space 2</title>");
  const changed = run(dir, registry);
  const link = await linkIn(changed.lines);
  assert.equal(readPublishLink(link).version, 3);
  assert.match(changed.lines.join("\n"), /^version: the registry holds space-game v2; this one is v3/m);
  wallet(registry, link);
  assert.equal(await changed.done, 0);
  assert.equal(registry.grain.version, 3);
  // So does a change to grain.json alone (a name).
  writeFileSync(join(dir, "grain.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")), name: { en: "Space!", ru: "Космос" } }, null, 2));
  const renamed = run(dir, registry, { wait: false });
  assert.equal(readPublishLink(await linkIn(renamed.lines)).version, 4);
  assert.equal(await renamed.done, 0);
});

test("the same content, whatever its JSON: the owner, the version and the relays' copies aside, every field counts", () => {
  const owner = toHex(ed25519.getPublicKey(OWNER));
  const base = {
    slug: SLUG, version: 2, owner: toHex(accountId(fromHex(owner, 32))), owner_key: { ed25519: owner }, name: { en: "Space", ru: "Космос" },
    description: { en: "A game" }, icon: ICON.hash, permissions: 1, sponsor: null, min_host: 1,
    entry: { sealed: { bundle: "ab".repeat(32), size: 1000, sources: ["https://10.1.0.1:30335/_blob/grain_bundle/" + "ab".repeat(32)], start: "index.html", connect: [] } },
  };
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  assert.ok(sameContent(sorted(base), base), "the keys' order is not content");
  assert.ok(sameContent(base, { ...base, version: 7, owner: "00".repeat(32), owner_key: { ed25519: "00".repeat(32) } }), "the owner and the version are not");
  assert.ok(sameContent(base, { ...base, entry: { sealed: { ...base.entry.sealed, sources: [] } } }), "nor the relays' copies");
  for (const change of [
    { name: { en: "Space!", ru: "Космос" } }, { description: { en: "A game!" } }, { icon: "00".repeat(32) }, { permissions: 3 },
    { min_host: 2 }, { entry: { sealed: { ...base.entry.sealed, bundle: "cd".repeat(32) } } }, { entry: { sealed: { ...base.entry.sealed, start: "game.html" } } },
    { entry: { sealed: { ...base.entry.sealed, connect: ["https://api.space.example"] } } }, { entry: { chat: {} } },
  ]) {
    assert.ok(!sameContent(base, { ...base, ...change }), JSON.stringify(change));
  }
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
  // Every run bounded: a publish that waits for an owner nobody plays gives up in 15 s, and the process is killed at 30.
  const grain = (args) => new Promise((resolve) => {
    const bounded = args[0] === "publish" ? [...args, "--timeout", "15"] : args;
    const child = spawn("node", [main, ...bounded, "--node", url], { cwd: dir, env: { ...process.env, SALTIX_APP_KEY: "" }, timeout: 30_000 });
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

/**
 * A node's ledger as far as a key file's calls need it: funds (`salt`), the pool, and the block that takes each call —
 * a registration or an update publishes grain.json as the key file signed it, `SetGrainAccess` sets the access.
 */
function ledgerOf(registry, dir, secret, salt = "200000000000") {
  const submitted = [];
  return {
    submitted,
    async call(method, params) {
      if (method === "account_get") return { nonce: submitted.length, salt };
      if (method === "transaction_get") return { status: "included" };
      if (method === "transaction_submit") {
        // Transaction v3: the sender's tag and key (33), nonce, fee and last slot (24), the action's tag, the call's.
        const tag = fromHex(params.transaction)[58];
        submitted.push(tag);
        if (tag === 7 || tag === 8) registry.publish(signManifest(JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")), secret));
        else if (tag === 36) registry.setAccess(false, []);
        else throw new Error(`a call of tag ${tag}`);
        return { id: "ab".repeat(32) };
      }
      return registry.call(method, params);
    },
  };
}
const OWNER_FILE = fromHex("77".repeat(32), 32);
const ownerFileAccount = toHex(accountId(ed25519.getPublicKey(OWNER_FILE)));
const keyed = (dir) => writeFileSync(join(dir, "owner.key"), "77".repeat(32) + "\n", { mode: 0o600 });

test("owner.key signs only when --key names it: a free slug otherwise goes to the owner's Saltix, the owner said first", async () => {
  // grain init writes an owner.key into every project: a developer with a phone who runs grain publish gets the QR code
  // for their own Saltix, never an app registered to that key.
  const registry = node({ registered: false });
  const dir = project({ paired: false });
  keyed(dir);
  const ledger = ledgerOf(registry, dir, OWNER_FILE);
  const { lines, done } = run(dir, ledger, { signing: { node: ledger, validFor: 600 } });
  const link = await linkIn(lines);
  assert.ok(lines.includes("owner: the account of the Saltix that scans the QR code: a new app is registered to it (--key owner.key signs here instead, on the test network)"));
  assert.deepEqual(ledger.submitted, [], "nothing signed with owner.key");
  wallet(registry, link);
  assert.equal(await done, 0);
  assert.equal(registry.grain.owner, toHex(accountId(ed25519.getPublicKey(OWNER))), "the phone's account owns it");
  assert.match(lines.join("\n"), /space-game is public from its first version \(a publishing link registers it so\)/);
  assert.ok(steps(dir).includes("access:ok:public"));
});

test("--key owner.key on a test network: the owner said, signed and sent here, made private, the bundle and the icon once it landed", async () => {
  const registry = node({ registered: false });
  const dir = project({ paired: false });
  keyed(dir);
  const ledger = ledgerOf(registry, dir, OWNER_FILE);
  const { lines, done } = run(dir, ledger, { signing: { node: ledger, validFor: 600 }, keyNamed: true });
  assert.equal(await done, 0, lines.join("\n"));
  const said = lines.join("\n");
  assert.match(said, /^owner: dsalt1\S+, owner\.key's account on this computer \(--key names it\): the app is registered to it$/m);
  assert.ok(said.indexOf("owner: ") < said.indexOf("register space-game"), "the owner is said before anything is signed");
  assert.match(said, /upload: once the registry names the bundle \(no server key here: grain pair lets the bundle go up before the owner signs\); it goes up once the transaction lands, which this command waits for/);
  assert.doesNotMatch(said, /keep this command running until the owner has signed/, "no owner to wait for");
  assert.match(said, /register space-game v1: transaction (ab){32} \(fee 0\.\d+ SALT, deposit 10 SALT\)/);
  // A new app starts private, as one made in Saltix does: SetGrainAccess right after RegisterGrain.
  assert.deepEqual(ledger.submitted, [7, 36]);
  assert.equal(registry.grain.public, false);
  assert.deepEqual(registry.grain.members, []);
  assert.match(said, /space-game is private: only its owner's account and the members it names open it/);
  assert.match(said, /grain access --slug space-game --private --member <address>:user --key owner\.key adds someone; --public opens it to anyone/);
  assert.equal(registry.grain.owner, ownerFileAccount);
  const hash = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")).entry.sealed.bundle;
  assert.equal(registry.blobs.get(hash).pendingUntil, null);
  assert.ok(registry.blobs.has(ICON.hash));
  assert.ok(steps(dir).includes("sign:ok:key_file") && steps(dir).includes("access:ok:private"));
  assertNoSecrets(dir, lines);
  // The app is owner.key's now: its next version is signed by it without --key, an update that leaves the access be.
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>Space 2</title>");
  const next = run(dir, ledger, { signing: { node: ledger, validFor: 600 } });
  assert.equal(await next.done, 0, next.lines.join("\n"));
  assert.match(next.lines.join("\n"), /^owner: dsalt1\S+, owner\.key's account on this computer, which the registry names as the owner$/m);
  assert.deepEqual(ledger.submitted, [7, 36, 8]);
  assert.equal(registry.grain.version, 2);
  assert.ok(!next.lines.join("\n").includes("salt:grain-publish"));
  // Without funds: what to do, in words.
  const dir2 = project({ paired: false, version: 1 });
  keyed(dir2);
  const broke = ledgerOf(node({ registered: false }), dir2, OWNER_FILE, "0");
  await assert.rejects(run(dir2, broke, { signing: { node: broke, validFor: 600 }, keyNamed: true }).done,
    (e) => e instanceof PublishError && e.reason === "no_salt" && /grain faucet --wait --key .*owner\.key.*without --key, the owner's Saltix signs and pays/.test(e.message));
});

test("an app made in Saltix is its owner's phone's: owner.key here never signs for it, and --key naming it is refused", async () => {
  const phones = node();
  const dir = project();
  keyed(dir);
  const ledger = ledgerOf(phones, dir, OWNER_FILE);
  const asked = run(dir, ledger, { signing: { node: ledger, validFor: 600 } });
  const link = await linkIn(asked.lines);
  assert.match(asked.lines.join("\n"), /^owner: dsalt1\S+, as the registry names it: its Saltix signs \(owner\.key here is another account's\)$/m);
  wallet(phones, link);
  assert.equal(await asked.done, 0);
  assert.deepEqual(ledger.submitted, []);
  // --key names a key file that is not the owner: refused before anything is signed or uploaded.
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>Space 3</title>");
  const puts = phones.calls.blob_put ?? 0;
  await assert.rejects(run(dir, ledger, { signing: { node: ledger, validFor: 600 }, keyNamed: true }).done,
    /space-game: the registry names another owner \([0-9a-f]{64}\) than owner\.key's account: an app made in Saltix is its owner's phone's, so run it without --key/);
  assert.deepEqual(ledger.submitted, []);
  assert.equal(phones.calls.blob_put ?? 0, puts, "nothing uploaded on a refused key's word");
});

test("lint says what the last publish left: published as it is, changed since, or ready to publish", async () => {
  const registry = node();
  const dir = project();
  const manifest = () => JSON.parse(readFileSync(join(dir, "grain.json"), "utf8"));
  const state = () => JSON.parse(readFileSync(join(dir, ".grain", "publish.json"), "utf8"));
  assert.equal(readiness(manifest(), null, dir), "space-game v1: no errors; ready to publish (grain publish)");
  const first = run(dir, registry);
  wallet(registry, await linkIn(first.lines));
  assert.equal(await first.done, 0);
  assert.match(readiness(manifest(), state(), dir),
    /^space-game v2: no errors; published on devnet 5a5a5a5a5a5a5a5a as it is here \(the registry took it at \S+; grain doctor asks the registry now\)\. A change to public\/ or grain\.json: grain publish makes v3$/);
  // The page changed since: grain.json still names the bundle published, public/ makes another.
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>Space 2</title>");
  assert.equal(readiness(manifest(), state(), dir),
    "space-game v2: no errors; the registry took v2 on devnet 5a5a5a5a5a5a5a5a at the last grain publish, and this has changed since: grain publish makes the next version");
  // The command line says the same, for a project lint finds no error in.
  writeFileSync(join(dir, "connect.json"), connectJson(SLUG, "Space", false));
  const linted = spawnSync("node", [main, "lint"], { cwd: dir, encoding: "utf8" });
  assert.equal(linted.status, 0, linted.stderr);
  assert.match(linted.stdout, /space-game v2: no errors; the registry took v2/);
  assert.doesNotMatch(linted.stdout, /ready to register/);
});

test("a page alone: grain status says not_needed and exits 0 without the network; doctor's last line is a page's", async () => {
  const dir = project({ paired: false });
  const offline = { call: async () => { throw new Error("the network was asked"); } };
  const state = await keyState(dir, offline);
  assert.equal(state.status, "not_needed");
  assert.match(state.detail, /a page alone needs no server key: nothing to pair/);
  assert.equal(state.next, "grain doctor");
  const cli = spawnSync("node", [main, "status", "--node", "http://127.0.0.1:9"], { cwd: dir, encoding: "utf8", env: { ...process.env, SALTIX_APP_KEY: "" } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^status: not_needed$/m);
  assert.match(cli.stdout, /^next: grain doctor --node http:\/\/127\.0\.0\.1:9$/m);
  assert.ok(steps(dir).includes("status:ok:not_needed"));
  // A chat's project still pairs: unpaired, exit 1.
  writeFileSync(join(dir, "chat.json"), JSON.stringify({ slug: SLUG, version: 4 }));
  assert.equal((await keyState(dir, node())).status, "unpaired");
  rmSync(join(dir, "chat.json"));
  // A key a page was paired with is still checked: one the registry no longer names says so.
  writeFileSync(join(dir, "app.key"), AppKey.of("devnet", GENESIS, SLUG, SERVER).reveal() + "\n", { mode: 0o600 });
  assert.equal((await keyState(dir, node({ servers: ["22".repeat(32)] }))).status, "replaced");
  rmSync(join(dir, "app.key"));
  // Published, its profile set: nothing left, said as a page's.
  const registry = node();
  const first = run(dir, registry);
  wallet(registry, await linkIn(first.lines));
  assert.equal(await first.done, 0);
  registry.grain.profile = { profile: { revision: 1 } };
  const d = await doctor(dir, registry);
  assert.deepEqual(d.findings.filter((f) => !f.ok), []);
  assert.equal(d.findings.find((f) => f.what === "key").detail.split(":")[0], "not needed");
  assert.equal(d.next, "nothing: the page is published and the project is in order (a change to public/ or grain.json: grain publish makes the next version)");
});

test("doctor before a page's first publish: the deposit, the owner's Saltix, and on the test network the way without a phone", async () => {
  const dir = project({ paired: false });
  keyed(dir);
  ensureGitignore(dir);
  const free = node({ registered: false });
  const d = await doctor(dir, free);
  const registry = d.findings.find((f) => f.what === "registry");
  assert.equal(registry.ok, false);
  assert.equal(registry.detail, "space-game is free: its first grain publish registers it, keeping a deposit of 10 SALT until it retires; owner.key's account holds 0 SALT");
  assert.equal(registry.next, "grain publish: a QR code, and the owner's Saltix registers the app and pays the deposit; without a phone, on the test network: " +
    "grain faucet --wait, then grain publish --key owner.key (the app is then owner.key's account's)");
  assert.equal(d.findings.find((f) => !f.ok).what, "registry", "the first thing to do");
  assert.equal(d.next, registry.next);
  // With the deposit and the fees in owner.key's account, no faucet first.
  const funded = { call: (m, p) => (m === "account_get" ? Promise.resolve({ nonce: 0, salt: "10001000000" }) : free.call(m, p)) };
  assert.match((await doctor(dir, funded)).next, /without a phone, on the test network: grain publish --key owner\.key \(/);
  // Without an owner.key: the faucet, then --key, as the way to it; never a balance it cannot know.
  rmSync(join(dir, "owner.key"));
  const keyless = (await doctor(dir, free)).findings.find((f) => f.what === "registry");
  assert.doesNotMatch(keyless.detail, /holds/);
  assert.match(keyless.next, /grain faucet --wait, then grain publish --key owner\.key/);
});
