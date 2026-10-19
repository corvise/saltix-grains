// Private grains, the numbers an app reports and the developer key (Saltix 24-app-studio §2a, §3, §6a): the reference's
// own cases (crates/saltix-types/src/grain/chat/tests.rs, app_key.rs), the negative ones included, and the window the
// numbers are counted in.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import {
  fromHex, toHex, accountId, ROLES, admits, needsController, keyStandsFor, memberProofProblem, signMemberProof, memberProofToSign,
  signGrainStats, grainStatsToSign, grainStatsProblem, STATS_MAX_AGE_MS, MEMBER_PROOF_LIFE_MS, UsageWindow, USAGE_WINDOW_MS,
  memoryChatStore, fileChatStore, AppKey, AppKeyError, MEMBER_PROOF_AHEAD_MS, MESSAGE_AHEAD_MS, memberProofTimely,
} from "../dist/index.js";
import { scratch } from "../../../scripts/scratch.mjs";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const genesis = "6c".repeat(32);
const key = (byte) => fromHex(byte.toString(16).padStart(2, "0").repeat(32), 32);
const pub = (secret) => toHex(ed25519.getPublicKey(secret));
const account = (secret) => toHex(accountId(ed25519.getPublicKey(secret)));
const OWNER = key(0x31);
const SERVER = key(0x32);
const USER = key(0x33);
const MEMBER = key(0x50);

const access = (roles) => ({ owner: account(OWNER), public: false, members: [{ account: "09".repeat(32), roles: ROLES.user }, { account: account(MEMBER), roles }] });
const proof = (expires_at, over = {}) => ({ slug: "access", account: account(MEMBER), grain_key: pub(USER), expires_at, ...over });
const check = (p, a, controller = null, now = NOW) => admits(a, { genesis, slug: "access", requestKey: pub(USER), proof: p, controller, now });

test("a private grain admits its members only", () => {
  const day = NOW + DAY;
  const good = signMemberProof(proof(day), MEMBER, genesis);
  assert.equal(check(good, access(ROLES.user)), null);
  assert.equal(check(good, access(ROLES.developer)), null);
  assert.equal(check(good, access(ROLES.viewer)), "not_member", "a viewer reads the page, it does not use the app");
  const stranger = { ...access(ROLES.user), members: [{ account: "09".repeat(32), roles: ROLES.user }] };
  assert.equal(check(good, stranger), "not_member", "removed from the members");
  assert.equal(check(null, { ...stranger, public: true }), null, "a public grain takes anyone");
  assert.equal(check(signMemberProof(proof(NOW), MEMBER, genesis), { ...stranger, public: true }), null, "and reads no proof");
  assert.equal(check(null, access(ROLES.user)), "missing");
  const owners = signMemberProof(proof(day, { account: account(OWNER) }), OWNER, genesis);
  assert.equal(check(owners, stranger), null, "the owner uses its own grain");

  const refused = (p) => check(p, access(ROLES.user));
  assert.equal(refused(signMemberProof(proof(day, { grain_key: pub(key(0x51)) }), MEMBER, genesis)), "mismatch", "a proof for another grain key: lent");
  assert.equal(refused(signMemberProof(proof(day, { slug: "other" }), MEMBER, genesis)), "mismatch");
  assert.equal(refused(signMemberProof(proof(NOW), MEMBER, genesis)), "expired");
  // 30 days ahead, with the 5 minutes a clock ahead of the server's may give (MESSAGE_AHEAD_MS): a wallet mints its proof
  // by its own clock, so a server whose clock lags must not call a fresh 30-day proof "expired".
  assert.equal(MEMBER_PROOF_AHEAD_MS, MESSAGE_AHEAD_MS);
  assert.equal(refused(signMemberProof(proof(NOW + MEMBER_PROOF_LIFE_MS + MEMBER_PROOF_AHEAD_MS + 1), MEMBER, genesis)), "expired", "longer than 30 days");
  assert.equal(refused(signMemberProof(proof(NOW + MEMBER_PROOF_LIFE_MS + MEMBER_PROOF_AHEAD_MS), MEMBER, genesis)), null, "30 days by a clock 5 minutes ahead");
  assert.equal(refused(signMemberProof(proof(NOW + MEMBER_PROOF_LIFE_MS), MEMBER, genesis)), null, "30 days exactly");
  for (const [at, ok] of [[NOW, false], [NOW + 1, true], [NOW + MEMBER_PROOF_LIFE_MS + MEMBER_PROOF_AHEAD_MS, true], [NOW + MEMBER_PROOF_LIFE_MS + MEMBER_PROOF_AHEAD_MS + 1, false]]) {
    assert.equal(memberProofTimely(at, NOW), ok, String(at - NOW));
  }
  assert.equal(refused(signMemberProof(proof(day), key(0x51), genesis)), "signer", "signed by a key that does not speak for the account");
  const forged = signMemberProof(proof(day), MEMBER, genesis);
  forged.proof.expires_at -= 1;
  assert.equal(refused(forged), "signature");
  assert.equal(refused(signMemberProof(proof(day), MEMBER, "6d".repeat(32))), "signature", "a proof of another network");
});

test("a managed account's proof is signed by one of its devices, never a guardian or its old key", () => {
  const day = NOW + DAY;
  const phone = key(0x52);
  const controller = { devices: [{ key: { ed25519: pub(phone) }, kind: "phone" }, { key: { ed25519: pub(key(0x53)) }, kind: "guardian" }] };
  const byPhone = signMemberProof(proof(day), phone, genesis);
  assert.equal(check(byPhone, access(ROLES.user), controller), null);
  assert.equal(check(byPhone, access(ROLES.user), null), "signer", "the device of an account the server thinks plain");
  assert.equal(check(signMemberProof(proof(day), key(0x53), genesis), access(ROLES.user), controller), "signer", "a guardian is not yet usable");
  assert.equal(check(signMemberProof(proof(day), MEMBER, genesis), access(ROLES.user), controller), "signer",
    "the key it had before its upgrade no longer speaks for it");
  const dropped = { devices: [{ key: { ed25519: pub(key(0x54)) }, kind: "phone" }] };
  assert.equal(check(byPhone, access(ROLES.user), dropped), "signer", "a device the account removed");
  assert.ok(keyStandsFor(null, account(MEMBER), { ed25519: pub(MEMBER) }));
  assert.ok(!keyStandsFor(null, account(MEMBER), { p256: "02" + "33".repeat(32) }));
  // A phone's P-256 key signs the proof's message itself.
  const secret = p256.utils.randomPrivateKey();
  const p256Key = { p256: toHex(p256.getPublicKey(secret, true)) };
  const message = memberProofToSign(proof(day), genesis);
  const signature = toHex(p256.sign(sha256(message), secret, { lowS: true, prehash: false }).toCompactRawBytes());
  const byP256 = { proof: proof(day), key: p256Key, signature };
  assert.equal(check(byP256, access(ROLES.user), { devices: [{ key: p256Key, kind: "phone" }] }), null);
});

test("a server asks the node for an account's keys only when the answer could admit it", () => {
  const day = NOW + DAY;
  const good = signMemberProof(proof(day), MEMBER, genesis);
  const asks = (p, a = access(ROLES.user)) => needsController(a, { genesis, slug: "access", requestKey: pub(USER), proof: p, now: NOW });
  assert.equal(asks(good), true);
  assert.equal(asks(good, { ...access(ROLES.user), public: true }), false, "a public grain");
  assert.equal(asks(null), false, "no proof");
  assert.equal(asks(good, access(ROLES.viewer)), false, "an account that may not use it, whatever its keys");
  assert.equal(asks(signMemberProof(proof(NOW), MEMBER, genesis)), false, "expired");
  assert.equal(asks(signMemberProof(proof(day, { grain_key: pub(key(0x51)) }), MEMBER, genesis)), false, "another grain key");
  const forged = signMemberProof(proof(day), MEMBER, genesis);
  forged.proof.expires_at -= 1;
  assert.equal(asks(forged), false, "a signature that does not hold");
  // Whenever it does not ask, the proof is refused with no controller at all and with any controller.
  for (const p of [null, signMemberProof(proof(NOW), MEMBER, genesis), forged]) {
    assert.notEqual(check(p, access(ROLES.user), null), null);
    assert.notEqual(check(p, access(ROLES.user), { devices: [{ key: p?.key ?? { ed25519: pub(MEMBER) }, kind: "phone" }] }), null);
  }
  assert.equal(memberProofProblem(good, { genesis, slug: "access", grainKey: pub(USER), controller: null, now: NOW }), null);
});

test("reported numbers are a registered key's and recent", () => {
  const registered = [pub(key(0x40)), pub(SERVER)];
  const numbers = { slug: "access", at: NOW, users_1d: 12, users_30d: 40, requests_30d: 410 };
  const signed = signGrainStats(numbers, SERVER, genesis);
  const shown = (s, over = {}) => grainStatsProblem(s, { genesis, slug: "access", servers: registered, now: NOW, ...over });
  assert.equal(shown(signed), null);
  assert.equal(shown(signed, { servers: [pub(key(0x40))] }), "key", "a key the registry no longer names");
  assert.equal(shown(signed, { slug: "other" }), "grain");
  assert.equal(shown(signed, { now: NOW + STATS_MAX_AGE_MS + 1 }), "time", "older than 2 days");
  assert.equal(shown(signed, { now: NOW + STATS_MAX_AGE_MS }), null);
  assert.equal(shown(signGrainStats({ ...numbers, at: NOW + 5 * 60_000 + 1 }, SERVER, genesis)), "time", "dated ahead");
  const signRaw = (n) => ({ stats: n, key: pub(SERVER), signature: toHex(ed25519.sign(grainStatsToSign(n, genesis), SERVER)) });
  for (const inconsistent of [{ ...numbers, users_1d: 41 }, { ...numbers, requests_30d: 39 }]) {
    assert.equal(shown(signRaw(inconsistent)), "inconsistent");
    assert.throws(() => signGrainStats(inconsistent, SERVER, genesis), /users_1d/, "the SDK never signs them");
  }
  const forged = structuredClone(signed);
  forged.stats.users_30d += 1;
  assert.equal(shown(forged), "signature");
  assert.equal(shown(signed, { genesis: "6d".repeat(32) }), "signature", "another network's");
});

test("the numbers keep no user beyond the 30-day window", () => {
  const HOUR = 3_600_000;
  const w = new UsageWindow();
  const t = NOW + 600_000; // not on an hour's edge
  w.seen("alice", t);
  w.seen("alice", t + 1_000);
  assert.deepEqual(w.usage(t + 1_000 + DAY - 1), { users_1d: 1, users_30d: 1, requests_30d: 2 }, "alice within a day of her last request");
  assert.deepEqual(w.usage(t + 1_000 + DAY), { users_1d: 0, users_30d: 1, requests_30d: 2 }, "a day later: this month only");
  w.seen("bob", t + 2 * DAY);
  assert.deepEqual(w.usage(t + 2 * DAY), { users_1d: 1, users_30d: 2, requests_30d: 3 }, "bob today, alice this month, twice");
  w.seen("carol", t + 10 * DAY);
  assert.deepEqual(w.usage(t + 10 * DAY), { users_1d: 1, users_30d: 3, requests_30d: 4 });
  // Alice's last request leaves the window: she is forgotten, not merely uncounted.
  const edge = t + 1_000 + USAGE_WINDOW_MS;
  assert.equal(w.usage(edge - 1).users_30d, 3);
  assert.ok("alice" in w.state.users);
  assert.equal(w.usage(edge).users_30d, 2);
  assert.ok(!("alice" in w.state.users), "nothing kept about alice");
  assert.deepEqual(Object.keys(w.state.users).sort(), ["bob", "carol"]);
  // Requests are counted by the hour, with no one's name on them: an hour leaves the count once it is wholly older than
  // 30 days.
  assert.equal(w.usage(edge).requests_30d, 4, "alice's hour is not wholly out yet");
  assert.equal(w.usage(Math.ceil(t / HOUR) * HOUR + USAGE_WINDOW_MS).requests_30d, 2);
  const late = t + 10 * DAY + USAGE_WINDOW_MS + HOUR;
  assert.deepEqual(w.usage(late), { users_1d: 0, users_30d: 0, requests_30d: 0 });
  assert.deepEqual(w.state, { users: {}, hours: {} }, "the window emptied: no user, no hour");
  // users_1d ≤ users_30d ≤ requests_30d always: a user's request is in an hour still counted.
  const w2 = new UsageWindow();
  let at = t;
  for (let i = 0; i < 400; i++) {
    at += (i * 7919) % 9_000_000;
    w2.seen(`u${i % 13}`, at);
    const u = w2.usage(at + (i % 5) * 4_000_000);
    assert.ok(u.users_1d <= u.users_30d && u.users_30d <= u.requests_30d, JSON.stringify(u));
  }
});

test("the numbers never contradict each other, even from a store that lost its hours", () => {
  // A store edited by hand, or written by an older version: users remembered, their hours gone. The numbers a wallet
  // would refuse as inconsistent are never signed.
  const w = new UsageWindow({ users: { alice: NOW, bob: NOW - DAY / 2 }, hours: {} });
  const u = w.usage(NOW);
  assert.deepEqual(u, { users_1d: 2, users_30d: 2, requests_30d: 2 });
  const signed = signGrainStats({ slug: "access", at: NOW, ...u }, SERVER, genesis);
  assert.equal(grainStatsProblem(signed, { genesis, slug: "access", servers: [pub(SERVER)], now: NOW }), null);
});

test("a store keeps the numbers' window, and forgets it as it goes", async () => {
  const store = memoryChatStore();
  store.seen("alice", NOW);
  store.seen("bob", NOW + DAY);
  assert.deepEqual(store.usage(NOW + DAY), { users_1d: 1, users_30d: 2, requests_30d: 2 });
  assert.deepEqual(store.usage(NOW + USAGE_WINDOW_MS + 3_600_000), { users_1d: 0, users_30d: 1, requests_30d: 1 });
  const { join } = await import("node:path");
  const path = join(scratch("usage-"), "chat.store.json");
  const file = fileChatStore(path);
  file.seen("alice", NOW);
  file.seen("bob", NOW + 2 * DAY);
  assert.deepEqual(fileChatStore(path).usage(NOW + 2 * DAY), { users_1d: 1, users_30d: 2, requests_30d: 2 }, "kept across a restart");
  fileChatStore(path).usage(NOW + USAGE_WINDOW_MS + 1);
  assert.deepEqual(fileChatStore(path).usage(NOW + USAGE_WINDOW_MS + 1).users_30d, 1);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(saved.usage.users), ["bob"], "the file forgets alice too");
});

const grains = JSON.parse(readFileSync(new URL("../../../vectors/grains-v1.json", import.meta.url), "utf8"));

test("the developer key is the vectors', and reads back", () => {
  const v = grains.app_key;
  const k = AppKey.of("testnet", grains.registry.genesis_hash, v.slug, fromHex(v.server_secret, 32));
  assert.equal(k.reveal(), v.code);
  const read = AppKey.parse(v.code);
  assert.equal(read.publicKey, v.server_public);
  assert.equal(read.slug, "chess");
  assert.equal(read.network, "testnet");
  assert.equal(read.hrp, "tsalt");
  assert.equal(read.genesis, "5a".repeat(8));
  assert.deepEqual(read.secret(), fromHex(v.server_secret, 32));
  assert.equal(AppKey.parse(` ${v.code}\n`).publicKey, v.server_public, "white space around it");
  assert.ok(read.isFor("testnet", grains.registry.genesis_hash));
  assert.ok(!read.isFor("mainnet", grains.registry.genesis_hash));
  assert.ok(!read.isFor("testnet", "5a".repeat(7) + "00" + "5a".repeat(24)));
  // Never printed: not by String, JSON, console.log or an error.
  for (const shown of [String(read), JSON.stringify(read), inspect(read), JSON.stringify(read.describe())]) {
    assert.ok(!shown.includes(v.server_secret), shown);
  }
  assert.ok(String(read).includes("chess"));
  assert.ok(Object.isFrozen(read));
});

test("anything else is refused, and the refusal never quotes it", () => {
  const code = grains.app_key.code;
  const refused = (text) => {
    try {
      AppKey.parse(text);
    } catch (e) {
      assert.ok(e instanceof AppKeyError);
      assert.ok(!e.message.includes(grains.app_key.server_secret), "the secret is not in the message");
      return e.problem;
    }
    return null;
  };
  assert.equal(refused(code), null);
  assert.equal(refused("access"), "not_app_key");
  assert.equal(refused(code.replace("saltix-app:1:", "saltix-app:2:")), "not_app_key");
  assert.equal(refused(code.replace("saltix-app:1:", "saltix-node:1:")), "not_app_key");
  assert.equal(refused(code.replace("saltix-app:1:", "SALTIX-APP:1:")), "not_app_key");
  assert.equal(refused(code.replace(":tsalt:", ":xsalt:")), "unknown_network");
  assert.equal(refused(`${code}:00`), "malformed");
  assert.equal(refused(code.replace(":chess:", ":")), "malformed", "no slug");
  assert.equal(refused(code.replace(":chess:", ":Chess:")), "bad_slug");
  assert.equal(refused(code.replace(":chess:", ":ab:")), "bad_slug");
  assert.equal(refused(code.replace(":chess:", ":-chess:")), "bad_slug");
  assert.equal(refused(code.slice(0, -2)), "malformed");
  assert.equal(refused(`${code.slice(0, -2)}AB`), "malformed", "upper case");
  assert.equal(refused(`${code.slice(0, -2)}zz`), "malformed");
  assert.equal(refused(`${code}00`), "malformed", "a long secret");
  assert.equal(refused(code.replace("5a5a5a5a5a5a5a5a", "5a5a5a5a5a5a5a")), "malformed", "a short genesis");
  assert.equal(refused(code.replace("5a5a5a5a5a5a5a5a", "5A5A5A5A5A5A5A5A")), "malformed");
  assert.equal(refused(`a${code}`), "not_app_key", "nothing before it");
  assert.equal(refused(code.replace(":chess:", ": chess:")), "bad_slug", "no white space inside");
  assert.equal(refused(`﻿${code}`), "not_app_key", "a byte-order mark is not white space");
  assert.equal(refused(` ${code} `), null, "Unicode white space around it is");
});
