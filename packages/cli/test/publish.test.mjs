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
import { BLOB_WORDS, PublishError, accessDecided, formOf, nodeNow, publishApp, readiness, sameContent, whoOpens } from "../dist/publish-flow.js";
import { doctor, firstPublishFees, keyState } from "../dist/status.js";
import { salt } from "../dist/registry.js";
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
  assert.match(lines.at(-2), /space-game v2 is published, its bundle in the network/);
  // Who opens it: anyone, as the registry holds it public.
  assert.match(lines.at(-1), /^Anyone opens it in Saltix: the Apps section, or salt:grain\/space-game\. Without a phone, grain dev runs this page sealed/);
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
  assert.match(second.lines.at(-2), /space-game v2 is published/, "the icon went up: something was done");
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
  // Nothing left (its profile set): exit 0, and the log says so by a code, never an empty reason.
  registry.grain.profile = { profile: { revision: 1 } };
  const clean = await grain(["doctor"]);
  assert.equal(clean.status, 0, clean.out);
  assert.match(clean.out, /^next: nothing: the page is published/m);
  assert.deepEqual(steps(dir).slice(-3), ["doctor:ok:done", "doctor_publish:ok:published", "end:ok"]);
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
  const nonces = [];
  return {
    submitted,
    nonces,
    async call(method, params) {
      if (method === "account_get") return { nonce: submitted.length, salt };
      if (method === "transaction_get") return { status: "included" };
      if (method === "transaction_submit") {
        // Transaction v3: the sender's tag and key (33), nonce, fee and last slot (24), the action's tag, the call's.
        const tag = fromHex(params.transaction)[58];
        submitted.push(tag);
        nonces.push(nonceOf(params.transaction));
        if (tag === 7 || tag === 8) registry.publish(signManifest(JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")), secret));
        else if (tag === 36) registry.setAccess(false, []);
        else throw new Error(`a call of tag ${tag}`);
        return { id: "ab".repeat(32) };
      }
      return registry.call(method, params);
    },
  };
}
/** A signed transaction's nonce: after the sender's tag and key (33 bytes), little-endian. */
function nonceOf(hex) {
  const b = fromHex(hex);
  return Number(new DataView(b.buffer, b.byteOffset + 33, 8).getBigUint64(0, true));
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
  assert.match(said, /^upload: once the registry names the bundle, after the transaction lands; this command waits for it$/m);
  // No phone and no owner to wait for: nothing about pairing a server, which would change only the order of the upload.
  assert.doesNotMatch(said, /keep this command running until the owner has signed|grain pair/, "no owner to wait for");
  assert.match(said, /register space-game v1: transaction (ab){32} \(fee 0\.\d+ SALT, deposit 10 SALT\)/);
  assert.match(said, /^waiting for it to land: usually 1\.5 to 2\.5 minutes on the test network/m);
  // A new app starts private, as one made in Saltix does: SetGrainAccess right behind RegisterGrain, with the next nonce.
  assert.deepEqual(ledger.submitted, [7, 36]);
  assert.deepEqual(ledger.nonces, [0, 1]);
  assert.match(said, /^access space-game: private, sent right behind it with the next nonce/m);
  assert.equal(registry.grain.public, false);
  assert.deepEqual(registry.grain.members, []);
  assert.match(said, /space-game is private: only its owner's account and the members it names open it/);
  assert.match(said, /grain access --slug space-game --private --member <address>:user --key owner\.key adds someone; --public opens it to anyone/);
  // Nobody holds the owner's key on a phone: who can open it, and how to try it without one.
  assert.equal(lines.at(-1), "It is private, and its owner is owner.key's account, which no phone holds: nobody opens it in Saltix yet. " +
    "To open it in your own Saltix: grain access --slug space-game --private --member <your Saltix address>:user --key owner.key " +
    "(the address: Saltix → Receive), or --public for anyone. Without a phone, grain dev runs this page sealed in the simulator, " +
    "as Saltix will (grain dev --check tries it headless).");
  assert.doesNotMatch(said, /Saltix opens it from the Apps section/);
  assert.equal(registry.grain.owner, ownerFileAccount);
  const hash = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")).entry.sealed.bundle;
  assert.equal(registry.blobs.get(hash).pendingUntil, null);
  assert.ok(registry.blobs.has(ICON.hash));
  assert.ok(steps(dir).includes("sign:ok:key_file") && steps(dir).includes("access:waiting:sent") && steps(dir).includes("access:ok:private"));
  const settled = JSON.parse(readFileSync(join(dir, ".grain", "publish.json"), "utf8"));
  assert.deepEqual([settled.sent, settled.private_pending], [[], false], "nothing left on its way");
  assertNoSecrets(dir, lines);
  // The app is owner.key's now: its next version is signed by it without --key, an update that leaves the access be.
  writeFileSync(join(dir, "public", "index.html"), "<!doctype html><title>Space 2</title>");
  const next = run(dir, ledger, { signing: { node: ledger, validFor: 600 } });
  assert.equal(await next.done, 0, next.lines.join("\n"));
  assert.match(next.lines.join("\n"), /^owner: dsalt1\S+, owner\.key's account on this computer, which the registry names as the owner$/m);
  assert.deepEqual(ledger.submitted, [7, 36, 8], "an update leaves the access be");
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
  assert.match(registry.detail, /^space-game is free: its first grain publish registers it, keeping a deposit of 10 SALT until it retires, and fees of about 0\.0000\d+ SALT \(registering, then making it private\); owner\.key's account holds 0 SALT$/);
  // The fees said are what the two transactions take at the pool's floor.
  const fees = firstPublishFees(JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")), 10_000_000_000n);
  assert.ok(fees > 0n && fees < 1_000_000n, String(fees));
  assert.ok(registry.detail.includes(`fees of about ${salt(fees)} SALT`));
  assert.equal(firstPublishFees("not a manifest", 1n), null);
  assert.equal(registry.next, "grain publish: a QR code, and the owner's Saltix registers the app and pays the deposit; without a phone, on the test network: " +
    "grain faucet --wait, then grain publish --key owner.key (the app is then owner.key's account's)");
  assert.equal(d.findings.find((f) => !f.ok).what, "registry", "the first thing to do");
  assert.equal(d.next, registry.next);
  // With the deposit and the fees in owner.key's account, no faucet first.
  const funded = { call: (m, p) => (m === "account_get" ? Promise.resolve({ nonce: 0, salt: "10001000000" }) : free.call(m, p)) };
  assert.match((await doctor(dir, funded)).next, /without a phone, on the test network: grain publish --key owner\.key \(/);
  // The Connect profile, before the registry can hold one: connect.json checked here, the template's words said.
  assert.match(d.findings.find((f) => f.what === "connect profile").detail, /^no connect\.json/);
  writeFileSync(join(dir, "connect.json"), connectJson(SLUG, "Space", false));
  const template = (await doctor(dir, free)).findings.find((f) => f.what === "connect profile");
  assert.equal(template.ok, false);
  assert.match(template.detail, /^connect\.json is grain init's template \(texts\.en: tagline, about, highlights and privacy are grain init's words/);
  const own = JSON.parse(connectJson(SLUG, "Space", false));
  own.texts = { en: { tagline: "A space game", about: "Fly.", highlights: [], privacy: "Keeps your best score in your Saltix vault." } };
  writeFileSync(join(dir, "connect.json"), JSON.stringify(own));
  const checked = (await doctor(dir, free)).findings.find((f) => f.what === "connect profile");
  assert.deepEqual([checked.ok, checked.detail], [true, "connect.json checks; the registry takes it once the app is registered (grain profile)"]);
  // Without an owner.key: the faucet, then --key, as the way to it; never a balance it cannot know.
  rmSync(join(dir, "owner.key"));
  const keyless = (await doctor(dir, free)).findings.find((f) => f.what === "registry");
  assert.doesNotMatch(keyless.detail, /holds/);
  assert.match(keyless.next, /grain faucet --wait, then grain publish --key owner\.key/);
});

/**
 * A node's pool and ledger as the network keeps them for a key file's calls. Its clock is the reads of a transaction's
 * status or the registry while anything is on its way: a transaction waits in the pool for `polls` of them from when it
 * was sent, then lands in the block that takes
 * every one of the account's due by then, in nonce order and never across a gap (two sent together land together); the
 * pool takes a nonce ahead of the account's and refuses one used already or pending. Each registry call then applies in
 * that order, `lag` reads after its block (the beacon chain's):
 * a registration publishes grain.json as the key file signed it, `SetGrainAccess` sets the access — and fails, changing
 * nothing, for an app the registry does not hold yet. `seen` records the registry's access after every block; `sent`
 * each transaction's call tag, nonce and whether the registry held the app when it was sent. `drop(tag)` loses a
 * transaction of that tag (the node never knows it); `failures` submissions fail before reaching the pool.
 */
function poolOf(registry, dir, secret, { polls = 2, lag = 0, drop = () => false, failures = 0, salt = "200000000000" } = {}) {
  const pool = { nonce: 0, clock: 0, pending: [], included: [], sent: [], seen: [], failures, txs: new Map() };
  const holds = async () => (await registry.call("grain_get", { slug: SLUG })).grain !== null;
  const block = async () => {
    for (;;) {
      const next = pool.pending.find((p) => p.nonce === pool.nonce && p.due <= pool.clock);
      if (!next) break;
      pool.pending.splice(pool.pending.indexOf(next), 1);
      pool.nonce++;
      next.status = "included";
      next.applies = pool.clock + lag;
      pool.included.push(next);
    }
    while (pool.included.length > 0 && pool.included[0].applies <= pool.clock) {
      const call = pool.included.shift();
      if (call.tag === 7 || call.tag === 8) registry.publish(signManifest(JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")), secret));
      else if (call.tag === 36 && (await holds())) registry.setAccess(false, []);
    }
    const g = (await registry.call("grain_get", { slug: SLUG })).grain;
    pool.seen.push(g === null ? "free" : g.public === false ? "private" : "public");
  };
  return {
    pool,
    async call(method, params) {
      if (method === "account_get") return { nonce: pool.nonce, salt };
      if ((method === "transaction_get" || method === "grain_get") && (pool.pending.length > 0 || pool.included.length > 0)) {
        pool.clock++;
        await block();
      }
      if (method === "transaction_get") {
        const tx = pool.txs.get(params.id);
        return { status: !tx || tx.status === "dropped" ? "unknown" : tx.status };
      }
      if (method === "transaction_submit") {
        if (pool.failures-- > 0) throw new Error("fetch failed");
        const nonce = nonceOf(params.transaction);
        const tag = fromHex(params.transaction)[58];
        if (nonce < pool.nonce) throw new RpcError(method, 2, `nonce ${nonce} is used already; the account is at ${pool.nonce}`);
        if (pool.pending.some((p) => p.nonce === nonce)) throw new RpcError(method, 2, "a replacement must pay more per byte");
        const id = toHex(crypto.getRandomValues(new Uint8Array(32)));
        const tx = { id, nonce, tag, due: pool.clock + polls, status: drop(tag) ? "dropped" : "pending" };
        pool.txs.set(id, tx);
        if (tx.status === "pending") pool.pending.push(tx);
        pool.sent.push({ tag, nonce, held: await holds(), fee: new DataView(fromHex(params.transaction).buffer).getBigUint64(41, true) });
        return { id };
      }
      return registry.call(method, params);
    },
  };
}

/** `run` with a key file signing on `ledger`, its waits short. */
const keyRun = (dir, ledger, over = {}) => run(dir, ledger, { signing: { node: ledger, validFor: 600 }, keyNamed: true, settleMs: 3_000, ...over });

test("a key file's registration and the call that makes it private go together: the second sent before the first lands, the app never public", async () => {
  const registry = node({ registered: false });
  const dir = project({ paired: false });
  keyed(dir);
  const ledger = poolOf(registry, dir, OWNER_FILE, { polls: 3, lag: 2 });
  const { lines, done } = keyRun(dir, ledger);
  assert.equal(await done, 0, lines.join("\n"));
  // SetGrainAccess went into the pool right behind RegisterGrain, with the next nonce, while the registry did not hold
  // the app yet; the chain applied the two in order, so no block ever showed it public.
  assert.deepEqual(ledger.pool.sent.map(({ tag, nonce, held }) => ({ tag, nonce, held })), [{ tag: 7, nonce: 0, held: false }, { tag: 36, nonce: 1, held: false }]);
  assert.ok(!ledger.pool.seen.includes("public"), ledger.pool.seen.join(" "));
  assert.equal(ledger.pool.seen.at(-1), "private");
  assert.equal(registry.grain.public, false);
  assert.deepEqual(steps(dir).filter((s) => s.startsWith("access:")), ["access:waiting:sent", "access:ok:private"]);
  assert.equal(JSON.parse(readFileSync(join(dir, ".grain", "publish.json"), "utf8")).private_pending, false);
  // The wait is said as it goes, off a terminal a line when its stage changes: in the pool, then on its way.
  const said = lines.join("\n");
  assert.match(said, /^ {2}register space-game v1: in the pool, waiting for a shard block \(\d+:\d\d\)$/m);
  assert.match(said, /^ {2}register space-game v1: in a shard block, on its way to the registry \(the beacon chain\) \(\d+:\d\d\)$/m);
});

test("a pool that will not take the access call ahead: it goes once the registration landed, and the app is private in the end", async () => {
  // An older pool that takes no nonce ahead of the account's: the call is sent again once the registration landed.
  const registry = node({ registered: false });
  const dir = project({ paired: false });
  keyed(dir);
  const ledger = poolOf(registry, dir, OWNER_FILE, { polls: 1 });
  const strict = {
    pool: ledger.pool,
    call: (method, params) => method === "transaction_submit" && nonceOf(params.transaction) > ledger.pool.nonce
      ? Promise.reject(new RpcError(method, 2, `nonce ${nonceOf(params.transaction)} is too far ahead of the account's ${ledger.pool.nonce}`))
      : ledger.call(method, params),
  };
  const { lines, done } = keyRun(dir, strict);
  assert.equal(await done, 0, lines.join("\n"));
  assert.match(lines.join("\n"), /^access space-game: private once the registration landed \(the pool did not take it ahead of it: /m);
  assert.deepEqual(ledger.pool.sent.map((t) => [t.tag, t.nonce, t.held]), [[7, 0, false], [36, 1, true]]);
  assert.equal(registry.grain.public, false);
  assert.ok(steps(dir).includes("access:waiting:after_registry") && steps(dir).includes("access:ok:private"));
});

test("--no-wait with a key file returns once the pool took both; doctor says they are on their way; the next run waits, never sends again", async () => {
  const registry = node({ registered: false });
  const dir = project({ paired: false });
  keyed(dir);
  ensureGitignore(dir);
  const ledger = poolOf(registry, dir, OWNER_FILE, { polls: 4 });
  const first = keyRun(dir, ledger, { wait: false });
  assert.equal(await first.done, 0, first.lines.join("\n"));
  assert.match(first.lines.join("\n"), /^sent: it lands in the registry in a few minutes \(usually 1\.5 to 2\.5 minutes on the test network\)\. grain doctor says when/m);
  assert.deepEqual(ledger.pool.sent.map((t) => t.tag), [7, 36]);
  const state = JSON.parse(readFileSync(join(dir, ".grain", "publish.json"), "utf8"));
  assert.deepEqual(state.sent.map((t) => [t.call, t.nonce]), [["register", 0], ["access", 1]]);
  assert.equal(state.private_pending, true);
  assert.ok(steps(dir).includes("registry:waiting:no_wait"));
  // grain doctor meanwhile: on its way, never to be sent again; not the deposit to pay.
  const d = await doctor(dir, ledger);
  const way = d.findings.find((f) => f.what === "registry");
  assert.equal(way.ok, false);
  assert.match(way.detail, /^the registration of space-game was sent at \S+ \(transaction [0-9a-f]{64}\) and has not landed yet: a registry call takes usually 1\.5 to 2\.5 minutes/);
  assert.match(way.next, /grain publish waits for it \(never sending it again\)/);
  assert.doesNotMatch(d.findings.map((f) => f.detail).join("\n"), /is free/);
  // The next run, without --key: it waits for that registration, sends nothing again, and finishes the bundle and icon.
  const second = run(dir, ledger, { signing: { node: ledger, validFor: 600 }, settleMs: 3_000 });
  assert.equal(await second.done, 0, second.lines.join("\n"));
  assert.match(second.lines.join("\n"), /^register space-game v1: an earlier grain publish sent it at \S+ \(transaction [0-9a-f]{64}\), and the registry does not hold it yet: waiting for it rather than sending it again/m);
  assert.deepEqual(ledger.pool.sent.map((t) => t.tag), [7, 36], "nothing sent a second time");
  assert.doesNotMatch(second.lines.join("\n"), /salt:grain-publish/, "never a QR code for an app the key file is registering");
  assert.equal(registry.grain.public, false);
  const hash = JSON.parse(readFileSync(join(dir, "grain.json"), "utf8")).entry.sealed.bundle;
  assert.ok(registry.blobs.has(hash) && registry.blobs.has(ICON.hash));
  assert.ok(steps(dir).includes("registry:waiting:earlier"));
  const after = JSON.parse(readFileSync(join(dir, ".grain", "publish.json"), "utf8"));
  assert.deepEqual([after.sent, after.private_pending], [[], false]);
  assertNoSecrets(dir, [...first.lines, ...second.lines]);
});

test("the call that makes it private does not land: doctor says public, should be private; the next run sends it again until it lands", async () => {
  const registry = node({ registered: false });
  const dir = project({ paired: false });
  keyed(dir);
  ensureGitignore(dir);
  // The access call is lost: the registration lands and the app stays public.
  const lossy = poolOf(registry, dir, OWNER_FILE, { polls: 1, drop: (tag) => tag === 36 });
  const first = keyRun(dir, lossy, { settleMs: 400 });
  assert.equal(await first.done, 1, first.lines.join("\n"));
  assert.match(first.lines.join("\n"), /^space-game is registered but still public: the call that makes it private has not landed yet\. grain doctor says when it has; grain publish again sends it again if it is needed \(or: grain access --slug space-game --private --key owner\.key\)$/m);
  assert.equal(registry.grain.public, true);
  assert.ok(steps(dir).includes("access:timeout:not_landed"));
  assert.equal(JSON.parse(readFileSync(join(dir, ".grain", "publish.json"), "utf8")).private_pending, true);
  // grain doctor: public, but should be private, and the fix.
  const d = await doctor(dir, lossy);
  const access = d.findings.find((f) => f.what === "access");
  assert.equal(access.ok, false);
  assert.match(access.detail, /^public, but should be private: owner\.key registered it here, and the call that makes it private has not landed/);
  assert.equal(access.next, "grain access --slug space-game --private --key owner.key (or grain publish, which sends it again)");
  // The next run: nothing new to publish, the call sent again (with the account's nonce now), the first submission
  // failing on the way and tried again; it lands, and the app is private.
  const sound = poolOf(registry, dir, OWNER_FILE, { polls: 1, failures: 1 });
  sound.pool.nonce = lossy.pool.nonce;
  const second = run(dir, sound, { signing: { node: sound, validFor: 600 }, settleMs: 3_000 });
  assert.equal(await second.done, 0, second.lines.join("\n"));
  assert.deepEqual(sound.pool.sent.map((t) => [t.tag, t.nonce]), [[36, 1]]);
  assert.equal(registry.grain.public, false);
  assert.match(second.lines.join("\n"), /^access space-game: private \(transaction [0-9a-f]{64}, fee /m);
  assert.match(second.lines.join("\n"), /^ {2}access space-game: private: not sent \(fetch failed\): trying again/m);
  assert.equal(JSON.parse(readFileSync(join(dir, ".grain", "publish.json"), "utf8")).private_pending, false);
  assert.equal((await doctor(dir, sound)).findings.find((f) => f.what === "access").detail, "private: its owner alone open it");
  // An owner who decides with grain access in the project: the pending "make it private" is theirs no more.
  writeFileSync(join(dir, ".grain", "publish.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, ".grain", "publish.json"), "utf8")), private_pending: true }));
  accessDecided(dir, SLUG);
  assert.equal(JSON.parse(readFileSync(join(dir, ".grain", "publish.json"), "utf8")).private_pending, false);
});

test("an earlier run's registration that never reached the network is forgotten once its last slot passed, and sent anew", async () => {
  const registry = node({ registered: false });
  const dir = project({ paired: false });
  keyed(dir);
  // Valid until slot 0, and the node is past it: that transaction can never land.
  const gone = { call: "register", id: "cd".repeat(32), nonce: 0, valid_until: 0, version: 1, at: new Date(0).toISOString() };
  assert.ok((await registry.call("node_status", {})).slot > 0);
  const genesis = (await registry.call("node_status", {})).genesis.slice(0, 16);
  mkdirSync(join(dir, ".grain"), { recursive: true });
  writeFileSync(join(dir, ".grain", "publish.json"), JSON.stringify({ network: "devnet", genesis, slug: SLUG, version: 1, sent: [gone], private_pending: true }));
  const ledger = poolOf(registry, dir, OWNER_FILE, { polls: 1 });
  const { lines, done } = keyRun(dir, ledger);
  assert.equal(await done, 0, lines.join("\n"));
  assert.doesNotMatch(lines.join("\n"), /an earlier grain publish sent it/);
  assert.deepEqual(ledger.pool.sent.map((t) => t.tag), [7, 36]);
  assert.equal(registry.grain.public, false);
});

test("who opens the app, said once it is published: anyone, its owner and members in Saltix, or nobody until a key file names one", () => {
  const dir = project({ paired: false });
  keyed(dir);
  const keyPath = join(dir, "owner.key");
  const grain = (over) => ({ slug: SLUG, owner: ownerFileAccount, version: 1, retired: null, public: false, members: [], ...over });
  assert.match(whoOpens(SLUG, grain({ public: true }), keyPath, "", "sealed"), /^Anyone opens it in Saltix: the Apps section, or salt:grain\/space-game\. Without a phone, grain dev runs this page sealed/);
  assert.equal(whoOpens(SLUG, grain({ public: true }), keyPath, "", "chat"), "Anyone opens it in Saltix: the Apps section, or salt:grain/space-game.", "no page, no simulator");
  // A phone's app: its owner (and members) in Saltix.
  const phones = grain({ owner: "77".repeat(32) });
  assert.match(whoOpens(SLUG, phones, keyPath, "", "chat"), /^It is private: its owner alone opens it in Saltix \(My apps → space-game, or salt:grain\/space-game\); My apps → space-game → Access adds members/);
  assert.match(whoOpens(SLUG, { ...phones, members: [{ account: "88".repeat(32), roles: 1 }] }, keyPath, "", "chat"), /^It is private: its owner and its 1 member open it in Saltix/);
  // owner.key's app: no phone holds the owner's key, so nobody opens it until a member is named.
  const said = whoOpens(SLUG, grain({}), keyPath, " --network devnet", "sealed");
  assert.match(said, /^It is private, and its owner is owner\.key's account, which no phone holds: nobody opens it in Saltix yet\. To open it in your own Saltix: grain access --slug space-game --private --member <your Saltix address>:user --key owner\.key --network devnet/);
  assert.match(whoOpens(SLUG, grain({ members: [{ account: "88".repeat(32), roles: 1 }, { account: "99".repeat(32), roles: 1 }] }), keyPath, "", "sealed"), /its 2 members open it in Saltix \(salt:grain\/space-game\)/);
});

test("a registration needs the deposit and both fees in the account: refused before anything is sent when the second's is short", async () => {
  // The two transactions' fees, as a first publish sends them.
  const dir = project({ paired: false });
  keyed(dir);
  const sent = poolOf(node({ registered: false }), dir, OWNER_FILE);
  assert.equal(await keyRun(dir, sent, { wait: false }).done, 0);
  const [register, access] = sent.pool.sent.map((t) => t.fee);
  assert.ok(register > 0n && access > 0n);
  const needs = 10_000_000_000n + register + access;
  // One base unit short of the deposit and both fees: SetGrainAccess right behind the registration could not be paid,
  // and the app would stay public. Nothing is sent; the faucet is the next step.
  const shortDir = project({ paired: false });
  keyed(shortDir);
  const shortRegistry = node({ registered: false });
  const short = poolOf(shortRegistry, shortDir, OWNER_FILE, { salt: String(needs - 1n) });
  await assert.rejects(keyRun(shortDir, short).done, (e) => e instanceof PublishError && e.reason === "no_salt" && /grain faucet --wait/.test(e.message));
  assert.deepEqual(short.pool.sent, [], "nothing sent");
  assert.equal((await shortRegistry.call("grain_get", { slug: SLUG })).grain, null, "nothing registered");
  // Exactly enough: both go.
  const exactDir = project({ paired: false });
  keyed(exactDir);
  const exact = poolOf(node({ registered: false }), exactDir, OWNER_FILE, { salt: String(needs) });
  assert.equal(await keyRun(exactDir, exact, { wait: false }).done, 0);
  assert.deepEqual(exact.pool.sent.map((t) => t.tag), [7, 36]);
});
