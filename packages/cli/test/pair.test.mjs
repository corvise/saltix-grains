// `grain pair`, `grain status` and `grain doctor` end to end against a registry the test changes (Saltix 24-app-studio
// §3a, version 2): the command's fields from the command line, the project or the registry; the key made here and kept
// owner-only; the offer shown (a terminal QR code, the link, a page, the code) with the key's proof for the app and its
// owner; the registry watched — no relay session — until it names the key, the offer renewed when it expires; then
// app.key and app.json; the refusals; never a secret printed or logged; and the state `status` reads at every stage.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { AppKey, PAIR_OFFER_LIFE_MS, accountId, encodeAddress, fromHex, keyFingerprint, parseOfferLink, toHex, verifyServerKeyProof } from "@saltix/grain-server";
import { ensureGitignore, nameForOffer, ownerAddressOf, pair, readPairState, terminalQr } from "../dist/pair.js";
import { doctor, keyState } from "../dist/status.js";
import { DevLog, reasonOf } from "../dist/devlog.js";
import { scratch } from "../../../scripts/scratch.mjs";

const GENESIS = "5a".repeat(32);
const GENESIS16 = GENESIS.slice(0, 16);
const OWNER_KEY = ed25519.getPublicKey(fromHex("41".repeat(32), 32));
const OWNER = toHex(accountId(OWNER_KEY));
const OWNER_ADDRESS = encodeAddress("devnet", accountId(OWNER_KEY));
const STRANGER = toHex(accountId(ed25519.getPublicKey(fromHex("43".repeat(32), 32))));
const STRANGER_ADDRESS = encodeAddress("devnet", fromHex(STRANGER, 32));

/** A node's wallet interface for one network: the registry holds `grains` (by slug), changed by the test; `down` makes
 *  it stop answering. Only reads: no relay, no mailbox. */
function fakeNode() {
  const grains = new Map();
  const node = {
    grains,
    down: false,
    reads: 0,
    async call(method, params = {}) {
      if (node.down) throw new Error("fetch failed");
      switch (method) {
        case "node_status":
          return { network: "devnet", genesis: GENESIS, slot: 1, beacon: { height: 1, hash: "01".padStart(64, "0") } };
        case "grain_get":
          node.reads++;
          return { grain: structuredClone(grains.get(params.slug) ?? null), deposit: "10000000000" };
        default:
          throw new Error(`the fake node does not answer ${method}`);
      }
    },
  };
  return node;
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
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** `pair` with its output kept. */
function run(dir, node, over = {}) {
  const lines = [];
  const log = new DevLog(dir, "pair", "test");
  const done = pair({ dir, node, flags: "", log, fresh: false, wait: true, tty: false, pollMs: 20, out: (l) => lines.push(l), ...over });
  return { lines, done };
}

const FIELDS = { app: "access", owner: OWNER_ADDRESS, genesis: GENESIS16 };
const linksIn = (lines) => lines.join("\n").match(/salt:grain-pair\?o=[A-Za-z0-9_-]+/g) ?? [];
const linkIn = (lines) => until("the offer's link", () => linksIn(lines)[0]);
const logOf = (dir) => readFileSync(join(dir, ".grain", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("the command's fields make the offer with the proof; the registry, watched, names the key; app.key and app.json follow, nothing secret shown", async () => {
  const node = fakeNode();
  const dir = project(null);
  const { lines, done } = run(dir, node, FIELDS);
  const link = await linkIn(lines);

  // The key waits owner-only in .grain/, and never appears: not in the output, the page or the state.
  const secretHex = readFileSync(join(dir, ".grain", "pair.key"), "utf8").trim();
  assert.match(secretHex, /^[0-9a-f]{64}$/);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, ".grain", "pair.key")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, ".grain")).mode & 0o777, 0o700);
  }
  const offer = parseOfferLink(link);
  assert.equal(offer.version, 2);
  assert.equal(offer.slug, "access");
  assert.equal(offer.owner, OWNER);
  assert.equal(offer.genesis, GENESIS16);
  assert.equal(offer.key, toHex(ed25519.getPublicKey(fromHex(secretHex, 32))));
  assert.ok(verifyServerKeyProof(offer.key, offer.proof, GENESIS, "access", OWNER), "the proof for this app and owner, over the full genesis hash");
  assert.ok(offer.name.length > 0 && offer.name.length <= 32, "named after the computer");
  const page = readFileSync(join(dir, ".grain", "pair.html"), "utf8");
  assert.ok(page.includes(link) && page.includes("<svg") && page.includes(OWNER_ADDRESS) && page.includes("<b>access</b>"), "the page has the link, its QR code, the app and the owner");
  assert.doesNotMatch(page, /<script/);
  const shown = lines.join("\n");
  assert.match(shown, /^ {2}app {10}access \(a new app: Saltix registers it when the owner confirms\)$/m);
  assert.match(shown, new RegExp(`^ {2}owner {8}${OWNER_ADDRESS}$`, "m"));
  assert.match(shown, new RegExp(`^ {2}server {7}.+ · key ${keyFingerprint(offer.key)} `, "m"));
  assert.match(shown, /^ {2}code {9}\d{3} \d{3} /m, "the code to compare");
  assert.match(shown, /compare the code, confirm with the PIN/);
  assert.doesNotMatch(shown, /relay|mailbox/i, "no relay session");
  // .gitignore keeps the keys and .grain/ out of git from the start.
  const ignore = readFileSync(join(dir, ".gitignore"), "utf8");
  for (const entry of ["app.key", "*.key", ".grain/"]) assert.ok(ignore.split("\n").includes(entry), entry);
  // The state: the fields and the offer, nothing else.
  assert.deepEqual(readPairState(dir), { version: 2, network: "devnet", genesis: GENESIS, target: { slug: "access", owner: OWNER_ADDRESS, genesis: GENESIS16 }, offer: readPairState(dir).offer });
  // Meanwhile status says waiting, for this app and owner.
  const waiting = await keyState(dir, node);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.slug, "access");
  assert.equal(waiting.owner, OWNER_ADDRESS);
  assert.match(waiting.detail, /not paired yet: an offer valid until .* for access \(owner dsalt1/);
  assert.equal(waiting.next, "grain pair (it shows the offer again and waits for the registry)");

  // The owner's transaction lands: the registry names the key, and the watch ends.
  const readsBefore = node.reads;
  node.grains.set("access", record("access", OWNER, [offer.key]));
  assert.equal(await done, 0);
  assert.ok(node.reads > readsBefore, "the registry was read again");
  const appKey = AppKey.parse(readFileSync(join(dir, "app.key"), "utf8"));
  assert.equal(appKey.slug, "access");
  assert.equal(appKey.publicKey, offer.key);
  assert.ok(appKey.isFor("devnet", GENESIS));
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "app.key")).mode & 0o777, 0o600);
  const app = JSON.parse(readFileSync(join(dir, "app.json"), "utf8"));
  assert.deepEqual({ ...app, paired_at: "" }, {
    slug: "access", network: "devnet", genesis: GENESIS16, owner: OWNER_ADDRESS, key: offer.key, fingerprint: keyFingerprint(offer.key), paired_at: "",
  });
  assert.ok(!existsSync(join(dir, ".grain", "pair.key")) && !existsSync(join(dir, ".grain", "pair.json")) && !existsSync(join(dir, ".grain", "pair.html")), "the pending key is app.key now");
  assert.ok(lines.some((l) => l === `Paired: key ${keyFingerprint(offer.key)} is named for access (owner ${OWNER_ADDRESS}) on devnet.`), lines.join("\n"));
  const output = lines.join("\n");
  assert.ok(!output.includes(secretHex), "the secret is never printed");
  assert.ok(!JSON.stringify(app).includes(secretHex));

  // The log: codes and timings only.
  const log = logOf(dir);
  assert.deepEqual(log.map((l) => l.step).filter((s) => ["key_made", "offer_made", "paired", "registry"].includes(s)), ["key_made", "offer_made", "paired"]);
  for (const line of log) {
    assert.deepEqual(Object.keys(line).filter((k) => !["at", "tool", "run", "command", "step", "outcome", "reason", "ms", "network"].includes(k)), []);
    for (const value of Object.values(line)) {
      assert.ok(!String(value).includes(secretHex) && !String(value).includes(offer.key) && !String(value).includes("access") && !String(value).includes(OWNER_ADDRESS));
    }
  }

  // Paired: status says so (paired here: no warning), and pairing again does nothing without --new.
  const state = await keyState(dir, node);
  assert.equal(state.status, "paired");
  assert.equal(state.next, null);
  assert.equal(state.warning, undefined);
  const again = run(dir, node);
  assert.equal(await again.done, 0);
  assert.match(again.lines.join("\n"), /paired with access .*nothing to do.*grain pair --new/s);
  assert.equal(readFileSync(join(dir, "app.key"), "utf8").trim(), appKey.reveal(), "app.key untouched");
  // Another app while the key serves this one: the registry names a key for one live app only (ServerKeyTaken).
  const other = run(dir, node, { app: "chess" });
  assert.equal(await other.done, 1);
  assert.match(other.lines.join("\n"), /paired with access .*one live app only.*grain pair --new --app chess/s);
  assert.ok(!existsSync(join(dir, ".grain", "pair.key")), "no key made");

  // The owner replaces the key: status says so and points at --new.
  node.grains.set("access", record("access", OWNER, ["77".repeat(32)]));
  const replaced = await keyState(dir, node);
  assert.equal(replaced.status, "replaced");
  assert.equal(replaced.next, "grain pair --new");
});

test("the fields fall back: the project's app.json, the offer shown, grain.json's slug with the owner from the registry; a new app needs --owner", async () => {
  const node = fakeNode();
  // grain.json names the app, the registry holds it: grain pair alone, the owner from the record.
  const dir = project();
  node.grains.set("access", record("access", OWNER, []));
  const plain = run(dir, node);
  const offer = parseOfferLink(await linkIn(plain.lines));
  assert.equal(offer.slug, "access");
  assert.equal(offer.owner, OWNER);
  assert.match(plain.lines.join("\n"), /^ {2}app {10}access$/m, "an app the registry holds");
  node.grains.set("access", record("access", OWNER, ["77".repeat(32), offer.key]));
  assert.equal(await plain.done, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, "app.json"), "utf8")).owner, OWNER_ADDRESS);
  // --new: the same app and owner from app.json, a new key; the old app.key kept aside.
  const rotate = run(dir, node, { fresh: true });
  const next = parseOfferLink(await linkIn(rotate.lines));
  assert.equal(next.slug, "access");
  assert.equal(next.owner, OWNER);
  assert.notEqual(next.key, offer.key, "a new key");
  node.grains.set("access", record("access", OWNER, [next.key, offer.key]));
  assert.equal(await rotate.done, 0);
  assert.equal(AppKey.parse(readFileSync(join(dir, "app.key"), "utf8")).publicKey, next.key);
  assert.equal(readdirSync(join(dir, ".grain")).filter((f) => f.startsWith(`replaced-${keyFingerprint(offer.key)}`)).length, 1, "the old key is kept aside, owner-only");

  // A new app: grain.json's slug is not in the registry, so the owner must be given.
  const fresh = project({ slug: "dice", name: { en: "Dice" } });
  await assert.rejects(run(fresh, node).done, /dice is not in the registry yet \(a new app\).*grain pair --app dice --owner <the owner's address> --genesis 5a5a5a5a5a5a5a5a/s);
  assert.deepEqual(logOf(fresh).filter((l) => l.step === "fields").map((l) => l.reason), ["no_owner"]);
  // No app at all.
  await assert.rejects(run(project(null), node).done, /which app\? grain pair --app <slug> --owner <address> --genesis <16 hex>.*app's page/s);
  // The fields out of form, or of another network: refused before anything is made or shown.
  const bad = project(null);
  await assert.rejects(run(bad, node, { ...FIELDS, genesis: "5b5b5b5b5b5b5b5b" }).done, /another network.*5b5b5b5b5b5b5b5b.*network answering is devnet 5a5a5a5a5a5a5a5a/s);
  await assert.rejects(run(bad, node, { ...FIELDS, genesis: "5A5A" }).done, /--genesis 5A5A: the first 8 bytes/);
  await assert.rejects(run(bad, node, { ...FIELDS, owner: encodeAddress("testnet", fromHex(OWNER, 32)) }).done, /owner's address tsalt1.* is of another network/);
  await assert.rejects(run(bad, node, { ...FIELDS, owner: "anna" }).done, /--owner anna: not an address of this network \(its prefix: dsalt1…\)/);
  await assert.rejects(run(bad, node, { ...FIELDS, app: "Dice" }).done, /--app Dice: a slug is/);
  assert.ok(!existsSync(join(bad, ".grain", "pair.key")), "no key made for a refused command");
  // --owner in upper case reads, and the offer names the account.
  const upper = run(bad, node, { ...FIELDS, app: "dice", owner: OWNER_ADDRESS.toUpperCase(), wait: false });
  assert.equal(await upper.done, 0);
  assert.equal(parseOfferLink(await linkIn(upper.lines)).owner, OWNER);
  assert.equal(readPairState(bad).target.owner, OWNER_ADDRESS, "kept canonical");
  // The offer shown is the project's word: grain pair alone, in a project whose grain.json says otherwise, shows it again.
  writeFileSync(join(bad, "grain.json"), JSON.stringify({ slug: "access" }));
  const same = run(bad, node, { wait: false });
  assert.equal(await same.done, 0);
  const shownAgain = parseOfferLink(await linkIn(same.lines));
  assert.equal(shownAgain.slug, "dice");
  assert.equal(shownAgain.nonce, parseOfferLink(await linkIn(upper.lines)).nonce, "the same offer while it lives");
  assert.deepEqual(logOf(bad).filter((l) => ["offer_made", "offer_shown_again"].includes(l.step)).map((l) => l.step), ["offer_made", "offer_shown_again"]);
  // --app names another app than the offer shown: a new offer, the same key, the owner read for that app.
  const switched = run(bad, node, { app: "access", wait: false });
  assert.equal(await switched.done, 0);
  const forAccess = parseOfferLink(await linkIn(switched.lines));
  assert.equal(forAccess.slug, "access");
  assert.equal(forAccess.key, shownAgain.key);
  assert.equal(await keyState(bad, node).then((s) => s.slug), "access");
  // --no-wait says what finishes; status names the next step with the fields when nothing is known.
  assert.match(switched.lines.join("\n"), /Run grain pair to wait: it watches the registry/);
  const empty = project(null);
  const none = await keyState(empty, node);
  assert.equal(none.status, "unpaired");
  assert.equal(none.next, "grain pair --app <slug> --owner <the owner's address> --genesis 5a5a5a5a5a5a5a5a (copy the command from the app's page in Saltix)");
  const known = await keyState(dir, node);
  assert.equal(known.status, "paired");
  writeFileSync(join(empty, "grain.json"), JSON.stringify({ slug: "access" }));
  assert.equal((await keyState(empty, node)).next, "grain pair (the app's owner is read from the registry)");
  writeFileSync(join(empty, "grain.json"), JSON.stringify({ slug: "dice" }));
  assert.equal((await keyState(empty, node)).next, "grain pair --app dice --owner <the owner's address> --genesis 5a5a5a5a5a5a5a5a (copy the command from the app's page in Saltix)");
});

test("the watch: the offer is renewed when it expires, the network's silence is waited out, a deadline ends it, and the registry's refusals stop it", async () => {
  const node = fakeNode();
  // A clock that runs, and jumps ahead when told.
  let skew = 0;
  const now = () => Date.now() + skew;
  const dir = project(null);
  const first = run(dir, node, { ...FIELDS, now });
  const link = await linkIn(first.lines);
  const offer = parseOfferLink(link);
  // Nobody scans: past its life, a new offer with the same key and a new nonce, said so.
  skew += PAIR_OFFER_LIFE_MS + 1;
  const renewed = await until("a renewed offer", () => linksIn(first.lines)[1]);
  const second = parseOfferLink(renewed);
  assert.equal(second.key, offer.key);
  assert.equal(second.slug, "access");
  assert.notEqual(second.nonce, offer.nonce);
  assert.ok(second.expiresAt > now() - 1000, "lives from now");
  assert.match(first.lines.join("\n"), /The offer expired with nobody having scanned it: a new one, the same key/);
  assert.equal(parseOfferLink("salt:grain-pair?o=" + Buffer.from(readPairState(dir).offer, "hex").toString("base64url")).nonce, second.nonce, "the state holds the new one");
  assert.ok(readFileSync(join(dir, ".grain", "pair.html"), "utf8").includes(renewed), "and so does the page");
  // The network falls silent: said once, then the watch goes on; the registry names the key once it answers again.
  node.down = true;
  await until("the silence said", () => first.lines.some((l) => /the network did not answer .*still waiting/.test(l)));
  node.down = false;
  node.grains.set("access", record("access", OWNER, [offer.key]));
  assert.equal(await first.done, 0);
  assert.deepEqual(logOf(dir).filter((l) => ["offer_renewed", "paired"].includes(l.step)).map((l) => l.step), ["offer_renewed", "paired"]);
  assert.ok(logOf(dir).some((l) => l.step === "registry" && l.reason === "network_unreachable"));

  // A deadline (--timeout) ends the wait, saying what finishes it; the next run shows the same key and offer.
  const bounded = project(null);
  const timed = run(bounded, node, { ...FIELDS, app: "chess", timeoutMs: 150 });
  assert.equal(await timed.done, 1);
  assert.match(timed.lines.join("\n"), /The registry does not name the key yet after 0:00.*grain pair again shows the offer \(the same key\) and waits/s);
  const key = readFileSync(join(bounded, ".grain", "pair.key"), "utf8");
  const shown = run(bounded, node, { wait: false });
  assert.equal(await shown.done, 0);
  assert.equal(await linkIn(shown.lines), await linkIn(timed.lines), "the same offer");
  assert.equal(readFileSync(join(bounded, ".grain", "pair.key"), "utf8"), key);
  // Named meanwhile (a managed owner's delay that passed): the next run only finishes, showing nothing.
  node.grains.set("chess", record("chess", OWNER, [parseOfferLink(await linkIn(timed.lines)).key]));
  const finishing = run(bounded, node);
  assert.equal(await finishing.done, 0);
  assert.equal(linksIn(finishing.lines).length, 0, "nothing to show");
  assert.match(finishing.lines.join("\n"), /^Paired: key/m);

  // The registry's word turns against the offer while it is shown: another account registered the slug, or it was retired.
  const taken = project(null);
  const watching = run(taken, node, { ...FIELDS, app: "dice" });
  await linkIn(watching.lines);
  node.grains.set("dice", record("dice", STRANGER, []));
  assert.equal(await watching.done, 1);
  assert.match(watching.lines.join("\n"), new RegExp(`dice belongs to another account now \\(${STRANGER_ADDRESS}\\): nothing is written`));
  assert.ok(!existsSync(join(taken, "app.key")));
  const retiring = project(null);
  node.grains.set("cards", record("cards", OWNER, []));
  const watched = run(retiring, node, { ...FIELDS, app: "cards" });
  await linkIn(watched.lines);
  node.grains.set("cards", record("cards", OWNER, [], { retired: 5 }));
  assert.equal(await watched.done, 1);
  assert.match(watched.lines.join("\n"), /cards was retired meanwhile: nothing is written/);
});

test("refused before anything is shown: another account's app, a retired one, a key the registry names for another app", async () => {
  const node = fakeNode();
  node.grains.set("access", record("access", STRANGER, []));
  node.grains.set("old", record("old", OWNER, [], { retired: 9 }));
  // Another account's app: the command on the page names the owner, so this one is wrong.
  const dir = project(null);
  const theirs = run(dir, node, FIELDS);
  assert.equal(await theirs.done, 1);
  assert.match(theirs.lines.join("\n"), new RegExp(`^access belongs to another account \\(${STRANGER_ADDRESS}\\), not ${OWNER_ADDRESS}: check the command`, "m"));
  assert.equal(linksIn(theirs.lines).length, 0, "nothing shown");
  assert.deepEqual(logOf(dir).filter((l) => l.step === "record").map((l) => l.reason), ["another_account"]);
  // Retired: never used again.
  const retired = run(dir, node, { ...FIELDS, app: "old" });
  assert.equal(await retired.done, 1);
  assert.match(retired.lines.join("\n"), /^old is retired, and a retired slug is never used again/m);
  // The same key, offered for one app and paired there by the owner, then asked for another: the registry names a key
  // for one live app only, so a key of its own is the way (--new).
  const chess = run(dir, node, { ...FIELDS, app: "chess", wait: false });
  assert.equal(await chess.done, 0);
  const chessKey = parseOfferLink(await linkIn(chess.lines)).key;
  node.grains.set("chess", record("chess", OWNER, [chessKey]));
  const dice = run(dir, node, { ...FIELDS, app: "dice" });
  assert.equal(await dice.done, 1);
  assert.match(dice.lines.join("\n"), /paired with chess already .*one live app only.*grain pair --new --app dice/s);
  // Another account's app that names this very key (paired for them before): --new is the way too.
  node.grains.set("access", record("access", STRANGER, [chessKey]));
  const named = run(dir, node, FIELDS);
  assert.equal(await named.done, 1);
  assert.match(named.lines.join("\n"), /names this server's key already: grain pair --new/);
  // --new: a new key, and the offer for dice.
  const anew = run(dir, node, { ...FIELDS, app: "dice", fresh: true, wait: false });
  assert.equal(await anew.done, 0);
  const diceOffer = parseOfferLink(await linkIn(anew.lines));
  assert.equal(diceOffer.slug, "dice");
  assert.notEqual(diceOffer.key, chessKey);
  // Status for the pending key: the registry names it for chess, which the offer no longer names.
  const state = await keyState(dir, node);
  assert.equal(state.status, "waiting");
  assert.equal(state.slug, "dice");
  // The offer shown names another account's app: status says so and names the command.
  writeFileSync(join(dir, ".grain", "pair.json"), readFileSync(join(dir, ".grain", "pair.json"), "utf8").replace('"slug": "dice"', '"slug": "access"'));
  const wrong = await keyState(dir, node);
  assert.equal(wrong.status, "waiting");
  assert.match(wrong.detail, /access belongs to another account/);
  assert.equal(wrong.next, "grain pair --app access --owner <the owner's address> --genesis 5a5a5a5a5a5a5a5a (copy the command from the app's page in Saltix)");
});

test("the server's name: --name, cut to what an offer takes, kept with the offer; the owner's address of a record", async () => {
  const node = fakeNode();
  const dir = project(null);
  const named = run(dir, node, { ...FIELDS, name: "Dice‮ roller " + "x".repeat(40), wait: false });
  assert.equal(await named.done, 0);
  const offer = parseOfferLink(await linkIn(named.lines));
  assert.equal(offer.name, ("Dice roller " + "x".repeat(40)).slice(0, 32).trim(), "without the characters an offer refuses, at most 32");
  assert.match(named.lines.join("\n"), new RegExp(`^ {2}server {7}${offer.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · key `, "m"));
  // Shown again without --name: the same name, the same offer.
  const again = run(dir, node, { wait: false });
  assert.equal(await again.done, 0);
  assert.equal(parseOfferLink(await linkIn(again.lines)).nonce, offer.nonce);
  // Another name: a new offer.
  const renamed = run(dir, node, { name: "", wait: false });
  assert.equal(await renamed.done, 0);
  const unnamed = parseOfferLink(await linkIn(renamed.lines));
  assert.equal(unnamed.name, "");
  assert.notEqual(unnamed.nonce, offer.nonce);
  assert.match(renamed.lines.join("\n"), /^ {2}server {7}\(unnamed\) · key /m);
  // A record's owner as an address: a plain account's by the manifest's key, a managed account's otherwise.
  assert.equal(ownerAddressOf("devnet", record("access", OWNER, [])), OWNER_ADDRESS);
  const manifest = { manifest: { owner: OWNER, owner_key: { ed25519: toHex(OWNER_KEY) } }, signature: "00".repeat(64) };
  assert.equal(ownerAddressOf("devnet", record("access", OWNER, [], { manifest })), OWNER_ADDRESS);
  const managedId = "55".repeat(32);
  const managed = { manifest: { owner: managedId, owner_key: { p256: "02" + "11".repeat(32) } }, signature: "00".repeat(64) };
  assert.equal(ownerAddressOf("devnet", record("club", managedId, [], { manifest: managed })), encodeAddress("devnet", fromHex(managedId, 32), 5));
  assert.equal(nameForOffer("x".repeat(40)).length, 32);
  assert.equal(nameForOffer("Keys\n​now"), "Keysnow");
});

test("doctor walks the path and stops at the first thing to do; a developer key in app.key works, with a warning to pair instead", async () => {
  const node = fakeNode();
  const dir = project({ slug: "access", version: 1, name: { en: "Access" }, entry: { chat: {} } });
  writeFileSync(join(dir, "chat.json"), JSON.stringify({ slug: "access", version: 1 }));
  const before = await doctor(dir, node);
  assert.equal(before.state.status, "unpaired");
  const firstFix = before.findings.find((f) => !f.ok);
  assert.equal(firstFix.what, "git");
  assert.ok(before.findings.some((f) => f.what === "key" && f.next === "grain pair --app access --owner <the owner's address> --genesis 5a5a5a5a5a5a5a5a (copy the command from the app's page in Saltix)"));
  assert.ok(before.findings.some((f) => f.what === "chat spec" && /raise/.test(f.next)));
  ensureGitignore(dir);
  const after = await doctor(dir, node);
  assert.equal(after.findings.find((f) => !f.ok).what, "key");
  assert.match(after.next, /^grain pair --app access/);
  // A key made elsewhere (a developer key made in Saltix, or by hand), written to app.key with no app.json: the registry
  // names it, so it is paired, and the finding says to pair a server in its place.
  const key = AppKey.of("devnet", GENESIS, "access", fromHex("5e".repeat(32), 32));
  writeFileSync(join(dir, "app.key"), key.reveal() + "\n", { mode: 0o600 });
  node.grains.set("access", record("access", OWNER, [key.publicKey]));
  const state = await keyState(dir, node);
  assert.equal(state.status, "paired");
  assert.equal(state.next, null);
  assert.match(state.warning, /developer key made in Saltix .*not one paired here.*grain pair --new/);
  const checked = await doctor(dir, node);
  const finding = checked.findings.find((f) => f.what === "key");
  assert.ok(finding.ok);
  assert.equal(finding.warning, state.warning);
  assert.ok(!JSON.stringify(checked).includes("5e".repeat(32)), "never the secret");
  // grain.json naming another app than the key's: the way is a new key for that app.
  writeFileSync(join(dir, "grain.json"), JSON.stringify({ slug: "dice", version: 1, name: { en: "Dice" }, entry: { chat: {} } }));
  const other = await doctor(dir, node);
  assert.equal(other.findings.find((f) => f.what === "app").next, "set grain.json's slug to access, or grain pair --new --app dice");
});

test("the terminal's QR code has no escape codes off a terminal, and the log takes codes only", async () => {
  const link = "salt:grain-pair?o=" + "A".repeat(200);
  const plain = await terminalQr(link, false);
  assert.doesNotMatch(plain, /\x1b/);
  const rows = plain.trimEnd().split("\n");
  assert.ok(rows.every((r) => [...r].length === [...rows[0]].length), "a square of half blocks");
  assert.ok(rows.every((r) => /^[█▀▄ ]+$/.test(r)));
  assert.match(await terminalQr(link, true), /\x1b\[47m/, "on a terminal, the colours set");
  assert.equal(reasonOf(Object.assign(new Error("x"), { name: "UsageError" })), "usage");
  assert.equal(reasonOf(new Error("relay_list: no relay answered")), "network_unreachable");
  // Whatever is not a code never reaches the log: a path, an address, a key.
  const dir = project();
  const log = new DevLog(dir, "pair", "test");
  log.step("record", "refused", `/home/someone/app ${"61".repeat(32)}`);
  log.step("a step with words", "ok");
  const lines = logOf(dir);
  assert.deepEqual(lines.map((l) => [l.step, l.reason]), [["record", "other"], ["other", undefined]]);
  assert.ok(!readFileSync(join(dir, ".grain", "log.jsonl"), "utf8").includes("6161"));
  // Off when asked.
  const quiet = project();
  new DevLog(quiet, "pair", "test", false).step("paired", "ok");
  assert.ok(!existsSync(join(quiet, ".grain", "log.jsonl")));
});
