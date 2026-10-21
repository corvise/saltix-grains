// `grain pair`, `grain status` and `grain doctor` end to end on a development relay and a registry the test changes: the
// key made here and kept owner-only, the offer shown (a terminal QR code, the link, a page, the code), Saltix's request
// answered with the key's proof (and refused for another app, or once the offer was used), the registry watched until it
// names the key, then app.key and app.json; the wait's deadline; never a secret printed or logged; and the state
// `status` reads at every stage.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import {
  AppKey, RelayClient, accountId, checkPairAnswer, decodePairFrame, encodePairFrame, fromHex, keyFingerprint, offerAddress,
  parseOfferLink, toHex,
} from "@saltix/grain-server";
import { createDevRelay } from "@saltix/grain-server/dev";
import { pair, terminalQr, ensureGitignore, nameForOffer } from "../dist/pair.js";
import { keyState, doctor } from "../dist/status.js";
import { DevLog, reasonOf } from "../dist/devlog.js";
import { scratch } from "../../../scripts/scratch.mjs";

const GENESIS = "5a".repeat(32);
const OWNER = toHex(accountId(ed25519.getPublicKey(fromHex("41".repeat(32), 32))));
const STRANGER = toHex(accountId(ed25519.getPublicKey(fromHex("43".repeat(32), 32))));

/** A node's wallet interface for one network: the registry holds `grains` (by slug), changed by the test. */
function fakeNode(relay) {
  const grains = new Map();
  let height = 1;
  return {
    grains,
    block() {
      height++;
    },
    async call(method, params = {}) {
      switch (method) {
        case "node_status":
          return { network: "devnet", genesis: GENESIS, slot: height, beacon: { height, hash: height.toString(16).padStart(64, "0") } };
        case "grain_get":
          return { grain: structuredClone(grains.get(params.slug) ?? null), deposit: "10000000000" };
        case "relay_list":
          return { relays: [{ endpoints: [relay.endpoint()] }] };
        default:
          throw new Error(`the fake node does not answer ${method}`);
      }
    },
  };
}

const record = (slug, owner, servers, over = {}) => ({
  slug, owner, version: 1, id: "00".repeat(32), registered: 1, updated: 1, retired: null, deposit: "10000000000", manifest: null,
  servers, category: 9, public: false, members: [], handles: [], ...over,
});

function project(manifest = { slug: "access", name: { en: "Access keys" } }) {
  const dir = scratch("grain-pair-");
  if (manifest) writeFileSync(join(dir, "grain.json"), JSON.stringify(manifest));
  return dir;
}

const until = async (what, check, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** The owner's Saltix: asks the computer of `link` from a grain alias of its own and returns the answer it took. */
async function wallet(relay, link, slug, owner = OWNER) {
  const offer = parseOfferLink(link);
  const alias = await RelayClient.connect({ endpoints: [relay.endpoint()], secret: randomBytes(32), network: "devnet" });
  const answers = [];
  alias.on("frame", (f) => {
    const frame = decodePairFrame(f.payload);
    if ("answer" in frame && f.from === offerAddress(offer)) answers.push(frame.answer);
  });
  const request = { offer: offer.nonce, slug, owner };
  await until("the computer's registration", () => relay.records.has(offerAddress(offer)));
  await alias.send(offerAddress(offer), encodePairFrame({ request }), { keep: true });
  const answer = await until("the computer's answer", () => answers[0]);
  alias.close();
  return { offer, request, answer, proof: checkPairAnswer(answer, GENESIS, offer, request) };
}

/** `pair` with its output kept. */
function run(dir, node, over = {}) {
  const lines = [];
  const log = new DevLog(dir, "pair", "test");
  const done = pair({
    dir, node, flags: "", log, fresh: false, wait: true, timeoutMs: 15_000, tty: false, pollMs: 50, out: (l) => lines.push(l), ...over,
  });
  return { lines, done };
}

/** The link of the offer `.grain/pair.json` keeps. */
const offerLinkFromState = (dir) => {
  const state = JSON.parse(readFileSync(join(dir, ".grain", "pair.json"), "utf8"));
  return "salt:grain-pair?o=" + Buffer.from(state.offer, "hex").toString("base64url");
};

const linkIn = (lines) => until("the offer's link", () => lines.join("\n").match(/salt:grain-pair\?o=[A-Za-z0-9_-]+/)?.[0]);

test("a computer pairs its own key: answered, named by the registry, app.key and app.json written, nothing secret shown", async (t) => {
  const relay = await createDevRelay();
  t.after(() => relay.close());
  const node = fakeNode(relay);
  const dir = project();
  const { lines, done } = run(dir, node);
  const link = await linkIn(lines);

  // The key waits owner-only in .grain/, and never appears: not in the output, the page or the state.
  const secretHex = readFileSync(join(dir, ".grain", "pair.key"), "utf8").trim();
  assert.match(secretHex, /^[0-9a-f]{64}$/);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, ".grain", "pair.key")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, ".grain")).mode & 0o777, 0o700);
  }
  const page = readFileSync(join(dir, ".grain", "pair.html"), "utf8");
  assert.ok(page.includes(link) && page.includes("<svg"), "the page has the link and its QR code");
  assert.doesNotMatch(page, /<script/);
  const offer = parseOfferLink(link);
  assert.equal(offer.slug, "access", "grain.json's slug");
  assert.equal(offer.name, "Access keys");
  assert.equal(offer.key, toHex(ed25519.getPublicKey(fromHex(secretHex, 32))));
  assert.ok(lines.some((l) => l.includes(keyFingerprint(offer.key))));
  assert.ok(lines.some((l) => /code\s+\d{3} \d{3}/.test(l)), "the code to compare");
  // .gitignore keeps the keys and .grain/ out of git from the start.
  const ignore = readFileSync(join(dir, ".gitignore"), "utf8");
  for (const entry of ["app.key", "*.key", ".grain/"]) assert.ok(ignore.split("\n").includes(entry), entry);

  // Saltix asks for another app first: this project is set up for access.
  const other = await wallet(relay, link, "chess");
  assert.equal(other.answer.result, "other_app");
  assert.equal(other.proof, null);
  // Then for access: the proof for access and its owner.
  const asked = await wallet(relay, link, "access");
  assert.equal(asked.answer.result, "accepted");
  assert.ok(asked.proof, "an accepted answer's proof checks");
  // Another owner, now the offer is answered: used.
  assert.equal((await wallet(relay, link, "access", STRANGER)).answer.result, "used");
  assert.equal((await keyState(dir, node)).status, "pairing");

  // The owner's transaction lands: the registry names the key first.
  node.grains.set("access", record("access", OWNER, [offer.key]));
  node.block();
  assert.equal(await done, 0);
  const appKey = AppKey.parse(readFileSync(join(dir, "app.key"), "utf8"));
  assert.equal(appKey.slug, "access");
  assert.equal(appKey.publicKey, offer.key);
  assert.ok(appKey.isFor("devnet", GENESIS));
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "app.key")).mode & 0o777, 0o600);
  const app = JSON.parse(readFileSync(join(dir, "app.json"), "utf8"));
  assert.deepEqual({ ...app, paired_at: "" }, {
    slug: "access", network: "devnet", genesis: GENESIS.slice(0, 16), key: offer.key, fingerprint: keyFingerprint(offer.key), paired_at: "",
  });
  assert.ok(!existsSync(join(dir, ".grain", "pair.key")), "the pending key is app.key now");
  assert.ok(lines.some((l) => /^Paired: this server speaks for access on devnet/.test(l)));
  const output = lines.join("\n");
  assert.ok(!output.includes(secretHex), "the secret is never printed");
  assert.ok(!JSON.stringify(app).includes(secretHex));

  // The log: codes and timings only.
  const log = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => l.step).filter((s) => ["key_made", "offer_made", "relay", "request", "paired"].includes(s)),
    ["key_made", "offer_made", "relay", "request", "request", "request", "paired"]);
  assert.deepEqual(log.filter((l) => l.step === "request").map((l) => l.reason), ["other_app", "accepted", "used"]);
  for (const line of log) {
    assert.deepEqual(Object.keys(line).filter((k) => !["at", "tool", "run", "command", "step", "outcome", "reason", "ms", "network"].includes(k)), []);
    for (const value of Object.values(line)) assert.ok(!String(value).includes(secretHex) && !String(value).includes(offer.key) && !String(value).includes("access"));
  }

  // Paired: status says so, and pairing again does nothing without --new.
  const state = await keyState(dir, node);
  assert.equal(state.status, "paired");
  assert.equal(state.next, null);
  const again = run(dir, node);
  assert.equal(await again.done, 0);
  assert.match(again.lines.join("\n"), /paired with access .*nothing to do.*grain pair --new/s);
  assert.equal(readFileSync(join(dir, "app.key"), "utf8").trim(), appKey.reveal(), "app.key untouched");

  // The owner replaces the key: status says so and points at --new.
  node.grains.set("access", record("access", OWNER, ["77".repeat(32)]));
  const replaced = await keyState(dir, node);
  assert.equal(replaced.status, "replaced");
  assert.equal(replaced.next, "grain pair --new");
});

test("the wait ends at its deadline, and the next run shows the same key and offer", async (t) => {
  const relay = await createDevRelay();
  t.after(() => relay.close());
  const node = fakeNode(relay);
  const dir = project();
  const first = run(dir, node, { timeoutMs: 300 });
  assert.equal(await first.done, 1);
  assert.match(first.lines.join("\n"), /Saltix did not ask in time/);
  // Answered for access and its owner, but the registry's access is another account's that names this key (a bare key
  // named first, as version 1 lets anyone do): this server does not serve a stranger's app.
  const answeredOnly = run(dir, node, { timeoutMs: 600 });
  const offer0 = parseOfferLink(await linkIn(answeredOnly.lines));
  await wallet(relay, offerLinkFromState(dir), "access");
  node.grains.set("access", record("access", STRANGER, [offer0.key]));
  assert.equal(await answeredOnly.done, 1);
  assert.match(answeredOnly.lines.join("\n"), /the registry does not name the key yet/);
  assert.ok(!existsSync(join(dir, "app.key")));
  node.grains.delete("access");
  const key = readFileSync(join(dir, ".grain", "pair.key"), "utf8");
  const link = await linkIn(first.lines);
  const state = await keyState(dir, node);
  assert.equal(state.status, "pairing");
  assert.equal(state.next, "grain pair");
  // --no-wait shows the offer again and returns at once: the same key, the same offer.
  const shown = run(dir, node, { wait: false });
  assert.equal(await shown.done, 0);
  assert.equal(await linkIn(shown.lines), link);
  assert.equal(readFileSync(join(dir, ".grain", "pair.key"), "utf8"), key);
  // Saltix's transaction named the key meanwhile (a managed owner's delay, say): the next run only finishes.
  const asked = run(dir, node, { timeoutMs: 10_000 });
  await wallet(relay, await linkIn(asked.lines), "access");
  node.grains.set("access", record("access", OWNER, [parseOfferLink(link).key]));
  assert.equal(await asked.done, 0);
  assert.equal(AppKey.parse(readFileSync(join(dir, "app.key"), "utf8")).publicKey, parseOfferLink(link).key);
});

test("--new pairs a new key for the same app and keeps the old app.key aside; an offer with no project names no app", async (t) => {
  const relay = await createDevRelay();
  t.after(() => relay.close());
  const node = fakeNode(relay);
  const dir = project(null);
  const first = run(dir, node, { name: "Dice‮ roller" });
  const link = await linkIn(first.lines);
  const offer = parseOfferLink(link);
  assert.equal(offer.slug, null, "no grain.json: any app, or a new one");
  assert.equal(offer.name, "Dice roller", "a name without the characters an offer refuses");
  await wallet(relay, link, "dice");
  node.grains.set("dice", record("dice", OWNER, [offer.key]));
  // An offer that names no app pairs nothing by itself: the developer confirms the app Saltix asked for.
  assert.equal(await first.done, 1);
  assert.match(first.lines.join("\n"), /Saltix asked to pair this server with dice.*grain pair --accept dice/s);
  assert.ok(!existsSync(join(dir, "app.key")));
  // The same offer (its name kept with it: --name need not be repeated), now for the app Saltix asked for.
  const accepted = run(dir, node, { accept: "dice" });
  assert.equal(await accepted.done, 0);
  const old = AppKey.parse(readFileSync(join(dir, "app.key"), "utf8"));
  assert.equal(old.slug, "dice");

  const rotate = run(dir, node, { fresh: true });
  const next = parseOfferLink(await linkIn(rotate.lines));
  assert.equal(next.slug, "dice", "the same app");
  assert.notEqual(next.key, old.publicKey, "a new key");
  await wallet(relay, await linkIn(rotate.lines), "dice");
  node.grains.set("dice", record("dice", OWNER, [next.key]));
  assert.equal(await rotate.done, 0);
  assert.equal(AppKey.parse(readFileSync(join(dir, "app.key"), "utf8")).publicKey, next.key);
  const kept = readdirSync(join(dir, ".grain")).filter((f) => f.startsWith(`replaced-${keyFingerprint(old.publicKey)}`));
  assert.equal(kept.length, 1, "the old key is kept aside, owner-only");
});


test("doctor walks the path and stops at the first thing to do", async (t) => {
  const relay = await createDevRelay();
  t.after(() => relay.close());
  const node = fakeNode(relay);
  const dir = project({ slug: "access", version: 1, name: { en: "Access" }, entry: { chat: {} } });
  writeFileSync(join(dir, "chat.json"), JSON.stringify({ slug: "access", version: 1 }));
  const before = await doctor(dir, node);
  assert.equal(before.state.status, "unpaired");
  const firstFix = before.findings.find((f) => !f.ok);
  assert.equal(firstFix.what, "git");
  assert.ok(before.findings.some((f) => f.what === "key" && f.next === "grain pair"));
  assert.ok(before.findings.some((f) => f.what === "chat spec" && /raise/.test(f.next)));
  ensureGitignore(dir);
  const after = await doctor(dir, node);
  assert.equal(after.findings.find((f) => !f.ok).what, "key");
});

test("the terminal's QR code has no escape codes off a terminal, and names are cut to what an offer takes", async () => {
  const link = "salt:grain-pair?o=" + "A".repeat(200);
  const plain = await terminalQr(link, false);
  assert.doesNotMatch(plain, /\x1b/);
  const rows = plain.trimEnd().split("\n");
  assert.ok(rows.every((r) => [...r].length === [...rows[0]].length), "a square of half blocks");
  assert.ok(rows.every((r) => /^[█▀▄ ]+$/.test(r)));
  assert.match(await terminalQr(link, true), /\x1b\[47m/, "on a terminal, the colours set");
  assert.equal(nameForOffer("x".repeat(40)).length, 32);
  assert.equal(nameForOffer("Keys\n​now"), "Keysnow");
  assert.equal(reasonOf(Object.assign(new Error("x"), { name: "UsageError" })), "usage");
  assert.equal(reasonOf(new Error("relay_list: no relay answered")), "network_unreachable");
  // Whatever is not a code never reaches the log: a path, an address, a key.
  const dir = project();
  const log = new DevLog(dir, "pair", "test");
  log.step("request", "refused", `/home/someone/app ${"61".repeat(32)}`);
  log.step("a step with words", "ok");
  const lines = readFileSync(join(dir, ".grain", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.step, l.reason]), [["request", "other"], ["other", undefined]]);
  assert.ok(!readFileSync(join(dir, ".grain", "log.jsonl"), "utf8").includes("6161"));
  // Off when asked.
  const quiet = project();
  new DevLog(quiet, "pair", "test", false).step("paired", "ok");
  assert.ok(!existsSync(join(quiet, ".grain", "log.jsonl")));
});
