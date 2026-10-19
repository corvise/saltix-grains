// Pairing a server by QR code (Saltix 24-app-studio §3a) as the reference makes it, byte for byte: the offers, their
// links and codes, the frames, the proof, how the computer judges a request, and every refusal of
// vectors/server-pairing-v1.json; and where a server finds its key, refusing to start without one.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import {
  AppKey, AppKeyError, ChatSetupError, EXIT_CONFIG, PairingError, answerPair, appKeyFromEnvironment, checkPairAnswer, decodeOffer,
  decodePairFrame, encodeOffer, encodePairFrame, fromHex, judgePair, keyFingerprint, makeOffer, offerAddress, offerCode,
  offerCodeText, offerLink, offerProblem, parseOfferLink, serverKeyProofPayload, setupCannotWork, toHex, verifyServerKeyProof,
} from "../dist/index.js";
import { scratch } from "../../../scripts/scratch.mjs";

const v = JSON.parse(readFileSync(new URL("../../../vectors/server-pairing-v1.json", import.meta.url), "utf8"));
const chain = { network: v.chain.network, genesis: v.chain.genesis_hash_hex };
const now = Number(v.now_ms);
const secret = fromHex(v.server_key.secret_hex, 32);
const owner = v.accounts.owner_hex;
const hex = (bytes) => toHex(bytes);
const frameOf = (h) => decodePairFrame(fromHex(h));
const requestOf = (h) => {
  // A request's Borsh is the frame's body after its tag: read it as a frame.
  const f = frameOf(toHex(new TextEncoder().encode("SGP1")) + "00" + h);
  return f.request;
};
const answerOf = (h) => frameOf(toHex(new TextEncoder().encode("SGP1")) + "01" + h).answer;

test("the offers read from their links, with the reference's Borsh, code, address and fingerprint", () => {
  assert.equal(toHex(ed25519.getPublicKey(secret)), v.server_key.public_hex);
  for (const name of ["offer", "offer_any"]) {
    const f = v[name];
    const offer = parseOfferLink(f.link);
    assert.deepEqual(offer, {
      version: f.version, hrp: f.hrp, genesis: f.genesis_hex, key: f.key_hex, nonce: f.nonce_hex, slug: f.slug, name: f.name,
      createdAt: Number(f.created_at_ms), expiresAt: Number(f.expires_at_ms),
    });
    assert.equal(hex(encodeOffer(offer)), f.borsh_hex);
    assert.deepEqual(decodeOffer(fromHex(f.borsh_hex)), offer);
    assert.equal(offerLink(offer), f.link);
    assert.equal(parseOfferLink(`  ${f.link}\n`).nonce, offer.nonce, "white space around a link");
    assert.equal(offerCode(offer), f.code);
    assert.equal(offerCodeText(offer), f.code_text);
    assert.equal(offerAddress(offer), f.server_address);
    assert.equal(keyFingerprint(offer.key), f.fingerprint);
    assert.equal(offerProblem(offer, chain.network, chain.genesis, now), null);
    // makeOffer writes the same bytes from the same parts.
    const made = makeOffer({ network: chain.network, genesis: chain.genesis, key: f.key_hex, nonce: f.nonce_hex, slug: f.slug, name: f.name, createdAt: Number(f.created_at_ms) });
    assert.equal(offerLink(made), f.link);
  }
  assert.equal(Number(v.offer_life_ms), 30 * 60_000);
});

test("the request, every answer and the proof are the reference's", () => {
  const offer = parseOfferLink(v.offer.link);
  const request = { offer: offer.nonce, slug: v.request.slug, owner };
  assert.deepEqual(frameOf(v.request.plaintext_hex), { request });
  assert.equal(hex(encodePairFrame({ request })), v.request.plaintext_hex);
  assert.deepEqual(requestOf(v.request.borsh_hex), request);
  assert.equal(hex(serverKeyProofPayload(chain.genesis, "access", owner)), v.proof.signed_payload_hex);
  assert.ok(verifyServerKeyProof(offer.key, v.proof.proof_hex, chain.genesis, "access", owner));
  assert.deepEqual(v.answers.map((a) => a.name), ["accepted", "used", "expired", "unknown", "other_app", "not_owner"]);
  for (const a of v.answers) {
    const answer = answerPair(secret, chain.genesis, request, a.name);
    assert.equal(hex(encodePairFrame({ answer })), a.plaintext_hex, a.name);
    assert.deepEqual(frameOf(a.plaintext_hex), { answer }, a.name);
    assert.deepEqual(answerOf(a.borsh_hex), answer);
    assert.equal(answer.proof, a.proof_hex ?? null);
    assert.equal(checkPairAnswer(answer, chain.genesis, offer, request), a.name === "accepted" ? v.proof.proof_hex : null);
  }
});

test("the computer judges every request as the reference does", () => {
  for (const name of ["accepted", "used", "expired", "unknown", "other_app", "not_owner"]) {
    assert.ok(v.judged.some((j) => j.result_name === name), name);
  }
  for (const j of v.judged) {
    const offer = decodeOffer(fromHex(j.offer_borsh_hex));
    const answered = j.answered ? { slug: j.answered.slug, owner: j.answered.owner_hex } : null;
    const record = j.record ? { owner: j.record.owner_hex, retired: j.record.retired } : null;
    assert.equal(judgePair(offer, answered, record, requestOf(j.request_borsh_hex), Number(j.now_ms)), j.result_name, j.why);
  }
});

test("every refusal of the reference is refused for the same reason", () => {
  const offer = parseOfferLink(v.offer.link);
  const request = { offer: offer.nonce, slug: "access", owner };
  const reason = (fn) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof PairingError, String(e));
      return e.problem;
    }
    return null;
  };
  for (const what of ["link", "offer", "check", "frame", "answer"]) assert.ok(v.refused.some((r) => r.what === what), what);
  for (const r of v.refused) {
    const got = {
      link: () => reason(() => parseOfferLink(r.text)),
      offer: () => reason(() => decodeOffer(fromHex(r.borsh_hex))),
      check: () => offerProblem(decodeOffer(fromHex(r.offer_borsh_hex)), r.chain.network, r.chain.genesis_hash_hex, Number(r.now_ms)),
      frame: () => reason(() => decodePairFrame(fromHex(r.plaintext_hex))),
      answer: () => reason(() => checkPairAnswer(answerOf(r.answer_borsh_hex), chain.genesis, offer, request)),
    }[r.what]();
    assert.equal(got, r.error, `${r.what}: ${r.why}`);
  }
});

test("a server finds its key, or refuses to start and says to run grain pair", () => {
  const dir = scratch("grain-key-");
  // None at all: unpaired, exit 78, and the message says what to do.
  const unpaired = (e) => e instanceof ChatSetupError && e.code === "chat_unpaired" && e.exitCode === EXIT_CONFIG && setupCannotWork(e);
  assert.throws(() => appKeyFromEnvironment({ dir, env: {} }), (e) => unpaired(e) && /Run grain pair here/.test(e.message));
  // A key grain pair made, not paired yet.
  mkdirSync(join(dir, ".grain"));
  writeFileSync(join(dir, ".grain", "pair.key"), "61".repeat(32) + "\n", { mode: 0o600 });
  assert.throws(() => appKeyFromEnvironment({ dir, env: {} }), (e) => unpaired(e) && /not paired with an app yet/.test(e.message));
  // app.key, owner-only.
  const key = AppKey.of("devnet", "5a".repeat(32), "access", secret);
  writeFileSync(join(dir, "app.key"), key.reveal() + "\n", { mode: 0o600 });
  assert.equal(appKeyFromEnvironment({ dir, env: {} }).publicKey, key.publicKey);
  chmodSync(join(dir, "app.key"), 0o644);
  if (process.platform !== "win32") {
    assert.throws(() => appKeyFromEnvironment({ dir, env: {} }), (e) => e instanceof ChatSetupError && e.code === "chat_key_exposed" && !e.message.includes(v.server_key.secret_hex));
  }
  chmodSync(join(dir, "app.key"), 0o600);
  // The environment first: the key itself, then the file it names.
  const other = AppKey.of("devnet", "5a".repeat(32), "chess", fromHex("62".repeat(32), 32));
  assert.equal(appKeyFromEnvironment({ dir, env: { SALTIX_APP_KEY: other.reveal() } }).slug, "chess");
  writeFileSync(join(dir, "other.key"), other.reveal(), { mode: 0o600 });
  assert.equal(appKeyFromEnvironment({ dir, env: { SALTIX_APP_KEY_FILE: join(dir, "other.key") } }).slug, "chess");
  assert.throws(() => appKeyFromEnvironment({ dir, env: { SALTIX_APP_KEY_FILE: join(dir, "missing.key") } }), unpaired);
  assert.throws(() => appKeyFromEnvironment({ dir, env: { SALTIX_APP_KEY: "saltix-app:2:x" } }), AppKeyError);
});
