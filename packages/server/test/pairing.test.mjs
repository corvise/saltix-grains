// Pairing a server by QR code (Saltix 24-app-studio §3a, version 2) as the reference makes it, byte for byte: the
// command from the app's page, the offers with their links, codes and the proof, how the slug is judged, the owner's
// ConfigureGrain, and every refusal of vectors/server-pairing-v2.json; and where a server finds its key, refusing to
// start without one and warning of a developer key made elsewhere.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import {
  AppKey, AppKeyError, ChatSetupError, DEVELOPER_KEY_WARNING, EXIT_CONFIG, MAX_PAIR_NAME, PAIR_OFFER_LIFE_MS, PAIR_OFFER_VERSION, PAIR_SKEW_MS,
  PairingError, SERVER_KEY_DOMAIN, SLUG_VERDICTS, accountId, appKeyFromEnvironment, decodeOffer, encodeAddress, encodeOffer, fromHex, judgeSlug,
  keyFingerprint, keyPairedHere, makeOffer, offerAddress, offerCode, offerCodeText, offerLink, offerProblem, offerProof, pairCommand, pairTarget,
  parseOfferLink, parsePairCommand, serverKeyProofPayload, setupCannotWork, signGrainTx, signServerKeyProof, slugRecordOf, targetIsFor,
  targetNetwork, targetOwner, toHex, verdictPairs, verifyServerKeyProof, versionMessage,
} from "../dist/index.js";
import { scratch } from "../../../scripts/scratch.mjs";

const v = JSON.parse(readFileSync(new URL("../../../vectors/server-pairing-v2.json", import.meta.url), "utf8"));
const chain = { network: v.chain.network, genesis: v.chain.genesis_hash_hex };
const now = Number(v.now_ms);
const secret = fromHex(v.keys.server.secret_hex, 32);
const owner = v.keys.owner.account_hex;
const target = { slug: v.command.slug, owner: v.command.owner_address, genesis: v.command.genesis_hex };
const problemOf = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PairingError, String(e));
    return e.problem;
  }
  return null;
};

test("the constants are the reference's", () => {
  assert.equal(v.version, 2);
  assert.equal(v.offer_version, PAIR_OFFER_VERSION);
  assert.equal(Number(v.offer_life_ms), PAIR_OFFER_LIFE_MS);
  assert.equal(Number(v.skew_ms), PAIR_SKEW_MS);
  assert.equal(v.max_name, MAX_PAIR_NAME);
  assert.equal(v.proof.domain, SERVER_KEY_DOMAIN);
  assert.deepEqual([...SLUG_VERDICTS], ["free", "own", "paired_already", "another_account", "retired"]);
  assert.equal(toHex(ed25519.getPublicKey(secret)), v.keys.server.public_hex);
  assert.equal(toHex(accountId(ed25519.getPublicKey(fromHex(v.keys.owner.secret_hex, 32)))), owner);
  assert.equal(encodeAddress("devnet", fromHex(owner, 32)), v.keys.owner.address);
  assert.equal(keyFingerprint(v.keys.server.public_hex), v.keys.server.fingerprint);
});

test("the command from the app's page: its text, its parse in any order, and the target it names", () => {
  assert.equal(pairCommand(target), v.command.text);
  assert.deepEqual(parsePairCommand(v.command.text), target);
  assert.deepEqual(parsePairCommand(`  ${v.command.text}\n`), target, "white space around");
  assert.deepEqual(parsePairCommand(`grain pair --genesis ${target.genesis} --owner ${target.owner} --app ${target.slug}`), target, "any order");
  assert.deepEqual(parsePairCommand(v.command.text.replace(target.owner, target.owner.toUpperCase())), target, "an address in upper case, canonical again");
  assert.deepEqual(pairTarget(chain.network, chain.genesis, target.slug, target.owner), target);
  assert.equal(targetOwner(target), v.command.owner_hex);
  assert.equal(targetNetwork(target), "devnet");
  assert.ok(targetIsFor(target, "devnet", chain.genesis) && targetIsFor(target, "devnet", target.genesis));
  assert.ok(!targetIsFor(target, "testnet", chain.genesis));
  assert.ok(!targetIsFor(target, "devnet", "5b" + chain.genesis.slice(2)));
  // A target is of one chain: an address of another network, a slug out of form.
  const testnet = encodeAddress("testnet", fromHex(owner, 32));
  assert.equal(problemOf(() => pairTarget("devnet", chain.genesis, "access", testnet)), "other_network");
  assert.equal(problemOf(() => pairTarget("devnet", chain.genesis, "Access", target.owner)), "slug");
  assert.equal(problemOf(() => pairTarget("devnet", chain.genesis, "access", "not an address")), "malformed");
  assert.equal(problemOf(() => pairTarget("devnet", chain.genesis, "access", "xsalt1" + target.owner.slice(6))), "unknown_network");
  // A managed owner's address (kind 5) names its account as any other.
  const managed = encodeAddress("devnet", fromHex("55".repeat(32), 32), 5);
  assert.equal(targetOwner({ ...target, owner: managed }), "55".repeat(32));
  assert.deepEqual(parsePairCommand(pairCommand({ ...target, owner: managed })), { ...target, owner: managed });
});

test("the offers read from their links with the reference's Borsh, code, address and fingerprint, and are made again from the fixed key", () => {
  assert.deepEqual(v.offers.map((o) => o.case), ["english", "russian", "unnamed"]);
  for (const f of v.offers) {
    const offer = parseOfferLink(f.link);
    assert.deepEqual(offer, {
      version: f.version, hrp: f.hrp, genesis: f.genesis_hex, key: f.key_hex, nonce: f.nonce_hex, slug: f.slug, owner: f.owner_hex, proof: f.proof_hex,
      name: f.name, createdAt: Number(f.created_at_ms), expiresAt: Number(f.expires_at_ms),
    }, f.case);
    assert.equal(toHex(encodeOffer(offer)), f.borsh_hex, f.case);
    assert.deepEqual(decodeOffer(fromHex(f.borsh_hex)), offer);
    assert.equal(offerLink(offer), f.link);
    assert.equal(parseOfferLink(`  ${f.link}\n`).nonce, offer.nonce, "white space around a link");
    assert.equal(offerCode(offer), f.code, f.case);
    assert.equal(offerCodeText(offer), f.code_text);
    assert.equal(offerAddress(offer), f.server_address);
    assert.equal(keyFingerprint(offer.key), f.fingerprint);
    assert.equal(offerProblem(offer, chain.network, chain.genesis, owner, now), null, f.case);
    assert.deepEqual(offerProof(offer), { key: f.key_hex, proof: f.proof_hex });
    // The computer makes the same bytes from the key's secret and the command's fields: the proof is deterministic.
    const made = makeOffer({ network: chain.network, genesis: chain.genesis, secret, target, nonce: f.nonce_hex, name: f.name, createdAt: Number(f.created_at_ms) });
    assert.equal(offerLink(made), f.link, f.case);
    assert.equal(made.expiresAt, made.createdAt + PAIR_OFFER_LIFE_MS);
  }
  assert.equal(fromHex(v.offers[0].borsh_hex).length, 204, "about 200 bytes (§3a)");
  // The code changes with everything in the offer, the proof and the owner included.
  const [english] = v.offers;
  const offer = parseOfferLink(english.link);
  for (const change of [{ nonce: "a2".repeat(16) }, { name: "Other" }, { proof: "00" + offer.proof.slice(2) }, { owner: v.keys.stranger.account_hex }]) {
    assert.notEqual(offerCode({ ...offer, ...change }), offer.code, JSON.stringify(change));
  }
  // makeOffer refuses a target of another chain (the proof needs the full genesis hash), and an offer out of form.
  const make = (over) => makeOffer({ network: chain.network, genesis: chain.genesis, secret, target, nonce: "a1".repeat(16), name: "", createdAt: now, ...over });
  assert.equal(problemOf(() => make({ network: "testnet" })), "other_network");
  assert.equal(problemOf(() => make({ genesis: "5b" + chain.genesis.slice(2) })), "other_network");
  assert.equal(problemOf(() => make({ target: { ...target, owner: encodeAddress("testnet", fromHex(owner, 32)) } })), "other_network");
  assert.equal(problemOf(() => make({ name: "x".repeat(MAX_PAIR_NAME + 1) })), "name");
  assert.equal(problemOf(() => make({ name: "Keys\n" })), "name");
  assert.equal(make({ name: "я".repeat(MAX_PAIR_NAME) }).name.length, MAX_PAIR_NAME);
  assert.throws(() => make({ secret: secret.slice(0, 31) }), TypeError);
  assert.throws(() => make({ nonce: "a1" }), TypeError);
});

test("the proof is the server key's over the reference's message, and the owner's ConfigureGrain carries it as it is", () => {
  assert.equal(v.proof.key_hex, v.keys.server.public_hex);
  assert.equal(toHex(serverKeyProofPayload(chain.genesis, "access", owner)), v.proof.signed_payload_hex);
  assert.equal(signServerKeyProof(secret, chain.genesis, "access", owner), v.proof.proof_hex);
  assert.ok(verifyServerKeyProof(v.proof.key_hex, v.proof.proof_hex, chain.genesis, "access", owner));
  assert.ok(!verifyServerKeyProof(v.proof.key_hex, v.proof.proof_hex, chain.genesis, "access", v.keys.stranger.account_hex), "another owner");
  assert.ok(!verifyServerKeyProof(v.proof.key_hex, v.proof.proof_hex, chain.genesis, "chess", owner), "another app");
  assert.ok(!verifyServerKeyProof(v.keys.other_server.public_hex, v.proof.proof_hex, chain.genesis, "access", owner), "another key");
  assert.ok(!verifyServerKeyProof(v.proof.key_hex, v.proof.proof_hex, "5b" + chain.genesis.slice(2), "access", owner), "another genesis");
  // What the phone sends once it took the offer: ConfigureGrain (tag 39) with the offer's proof, signed by the owner.
  const c = v.configure_grain;
  assert.equal(c.call.tag, 39);
  assert.equal(c.call.call, "configure_grain");
  assert.equal(c.sender_hex, v.keys.owner.public_hex);
  assert.deepEqual(c.call.servers, [{ key_hex: v.offers[0].key_hex, proof_hex: v.offers[0].proof_hex }], "the proof as the offer carried it");
  const call = { configureProven: { slug: c.call.slug, servers: c.call.servers.map((s) => ({ key: s.key_hex, proof: s.proof_hex })), category: c.call.category } };
  const { hex, id } = signGrainTx(fromHex(v.keys.owner.secret_hex, 32), { nonce: c.nonce, fee: BigInt(c.fee), validUntilSlot: c.valid_until_slot }, call, chain.genesis);
  assert.equal(hex, c.signed_hex);
  assert.equal(id, c.id_hex);
  assert.ok(c.signed_hex.startsWith(c.transaction_hex), "the signed form is the transaction and its proof");
});

test("the slug is judged from the registry's record in the reference's order", () => {
  const offer = { key: v.keys.server.public_hex, owner };
  for (const verdict of SLUG_VERDICTS) assert.ok(v.slugs.some((s) => s.verdict === verdict), verdict);
  for (const s of v.slugs) {
    const record = s.record ? { owner: s.record.owner_hex, retired: s.record.retired, servers: s.record.servers_hex } : null;
    assert.equal(judgeSlug(offer, record), s.verdict, s.why);
    assert.equal(verdictPairs(s.verdict), s.pairs, s.why);
  }
  // The record as grain_get serves it: retired is a slot or null, servers may be absent on an older node.
  assert.equal(slugRecordOf(null), null);
  assert.deepEqual(slugRecordOf({ owner, retired: null, servers: ["aa".repeat(32)] }), { owner, retired: false, servers: ["aa".repeat(32)] });
  assert.deepEqual(slugRecordOf({ owner, retired: 1234 }), { owner, retired: true, servers: [] });
  assert.equal(judgeSlug(offer, slugRecordOf({ owner, retired: null, servers: [offer.key] })), "paired_already");
  // The registry's answers to the phone's call, for the record: the computer sends no call, and reads the record alone.
  assert.deepEqual(v.registry.cases.map((c) => c.expected), ["ok", "server_key_taken", "server_key_taken", "not_owner", "grain_retired", "unknown_grain"]);
});

test("every refusal of the reference is refused for the same reason, and an offer of another version says who updates", () => {
  for (const what of ["link", "offer", "check", "command"]) assert.ok(v.refused.some((r) => r.what === what), what);
  assert.equal(v.refused.length, 42);
  for (const r of v.refused) {
    const got = {
      link: () => problemOf(() => parseOfferLink(r.text)),
      offer: () => problemOf(() => decodeOffer(fromHex(r.borsh_hex))),
      check: () => offerProblem(decodeOffer(fromHex(r.offer_borsh_hex)), r.chain.network, r.chain.genesis_hash_hex, r.account_hex, Number(r.now_ms)),
      command: () => problemOf(() => parsePairCommand(r.text)),
    }[r.what]();
    assert.equal(got, r.error, `${r.what}: ${r.why}`);
  }
  // Version 1 (the SDK of 2026-10-19) is read for its version only: update the SDK; above 2: update Saltix.
  const older = v.refused.find((r) => r.what === "offer" && /older SDK/.test(r.why));
  assert.throws(() => decodeOffer(fromHex(older.borsh_hex)), (e) => e instanceof PairingError && e.problem === "version" && e.version === 1 && /older SDK.*grain pair/.test(e.message));
  const newer = v.refused.find((r) => r.what === "offer" && /newer SDK/.test(r.why));
  assert.throws(() => decodeOffer(fromHex(newer.borsh_hex)), (e) => e instanceof PairingError && e.problem === "version" && e.version === 3 && /update Saltix/.test(e.message));
  assert.match(versionMessage(1), /older SDK/);
  assert.match(versionMessage(3), /update Saltix/);
  // The checks come in the order §3a names: the network before the clock, the clock before the owner, the owner before the proof.
  const offer = parseOfferLink(v.offers[0].link);
  const ahead = { ...offer, createdAt: now + PAIR_SKEW_MS + 1, expiresAt: now + PAIR_SKEW_MS + 1 + PAIR_OFFER_LIFE_MS };
  assert.equal(offerProblem(ahead, "testnet", chain.genesis, v.keys.stranger.account_hex, now), "other_network");
  assert.equal(offerProblem(ahead, chain.network, chain.genesis, v.keys.stranger.account_hex, now), "ahead");
  // Just within the skew: taken; the proof covers no time, so the offer's times may be rewritten without touching it.
  assert.equal(offerProblem({ ...offer, createdAt: now + PAIR_SKEW_MS, expiresAt: now + PAIR_SKEW_MS + PAIR_OFFER_LIFE_MS }, chain.network, chain.genesis, owner, now), null);
  assert.equal(offerProblem(offer, chain.network, chain.genesis, owner, offer.expiresAt - 1), null);
  assert.equal(offerProblem(offer, chain.network, chain.genesis, owner, offer.expiresAt), "expired");
});

test("a server finds its key, or refuses to start and says to run grain pair; a key not paired here is taken with a warning", () => {
  const dir = scratch("grain-key-");
  const unpaired = (e) => e instanceof ChatSetupError && e.code === "chat_unpaired" && e.exitCode === EXIT_CONFIG && setupCannotWork(e);
  // None at all: unpaired, exit 78, and the message says what to do, with the command's fields.
  assert.throws(() => appKeyFromEnvironment({ dir, env: {} }), (e) => unpaired(e) && /Run grain pair here.*--app, --owner, --genesis/.test(e.message));
  // A key grain pair made, not paired yet.
  mkdirSync(join(dir, ".grain"));
  writeFileSync(join(dir, ".grain", "pair.key"), "61".repeat(32) + "\n", { mode: 0o600 });
  assert.throws(() => appKeyFromEnvironment({ dir, env: {} }), (e) => unpaired(e) && /not paired with an app yet/.test(e.message));
  // app.key alone, owner-only: a key made elsewhere (a developer key made in Saltix): taken, with the warning.
  const key = AppKey.of("devnet", "5a".repeat(32), "access", secret);
  writeFileSync(join(dir, "app.key"), key.reveal() + "\n", { mode: 0o600 });
  const warned = [];
  const warn = (message) => warned.push(message);
  assert.equal(appKeyFromEnvironment({ dir, env: {}, warn }).publicKey, key.publicKey);
  assert.deepEqual(warned, [DEVELOPER_KEY_WARNING]);
  assert.match(DEVELOPER_KEY_WARNING, /developer key made in Saltix.*grain pair --new/);
  assert.ok(!DEVELOPER_KEY_WARNING.includes("saltix-app:1"), "the warning never shows a key's form");
  assert.ok(!keyPairedHere(dir, key));
  // Beside app.json naming it: paired here, no warning.
  writeFileSync(join(dir, "app.json"), JSON.stringify({ slug: "access", network: "devnet", genesis: "5a".repeat(8), key: key.publicKey, fingerprint: keyFingerprint(key.publicKey), paired_at: "" }));
  warned.length = 0;
  assert.equal(appKeyFromEnvironment({ dir, env: {}, warn }).slug, "access");
  assert.deepEqual(warned, []);
  assert.ok(keyPairedHere(dir, key));
  assert.ok(!keyPairedHere(dir, AppKey.of("devnet", "5a".repeat(32), "access", fromHex("62".repeat(32), 32))), "another key");
  assert.ok(!keyPairedHere(dir, AppKey.of("devnet", "5a".repeat(32), "chess", secret)), "another app");
  chmodSync(join(dir, "app.key"), 0o644);
  if (process.platform !== "win32") {
    assert.throws(() => appKeyFromEnvironment({ dir, env: {} }), (e) => e instanceof ChatSetupError && e.code === "chat_key_exposed" && !e.message.includes(v.keys.server.secret_hex));
  }
  chmodSync(join(dir, "app.key"), 0o600);
  // The environment first: the key itself, then the file it names; each warned unless app.json names the key (a
  // systemd credential of the paired file).
  const other = AppKey.of("devnet", "5a".repeat(32), "chess", fromHex("62".repeat(32), 32));
  warned.length = 0;
  assert.equal(appKeyFromEnvironment({ dir, env: { SALTIX_APP_KEY: other.reveal() }, warn }).slug, "chess");
  assert.equal(warned.length, 1);
  writeFileSync(join(dir, "other.key"), other.reveal(), { mode: 0o600 });
  assert.equal(appKeyFromEnvironment({ dir, env: { SALTIX_APP_KEY_FILE: join(dir, "other.key") }, warn }).slug, "chess");
  assert.equal(warned.length, 2);
  warned.length = 0;
  assert.equal(appKeyFromEnvironment({ dir, env: { SALTIX_APP_KEY: key.reveal() }, warn }).slug, "access");
  assert.deepEqual(warned, [], "the paired key through the environment: no warning");
  assert.throws(() => appKeyFromEnvironment({ dir, env: { SALTIX_APP_KEY_FILE: join(dir, "missing.key") } }), unpaired);
  assert.throws(() => appKeyFromEnvironment({ dir, env: { SALTIX_APP_KEY: "saltix-app:2:x" } }), AppKeyError);
});
