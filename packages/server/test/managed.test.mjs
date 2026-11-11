// A managed account's messaging key at relays (Saltix 09-relay §1.4): its record and binding byte for byte the node's
// (vectors/relay-v1.json), checked against its key event log (vectors/accounts-v1.json, vectors/connect-v1.json,
// vectors/new-phrase-v1.json) as the node's relay checks them — every refusal for its reason —, the current phrase's
// roots as the node keeps them, an empty log of a new address, and the log as relays carry it split back into its events.
import test from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import {
  LogError, Writer, accountId, checkLog, concat, decodeManagedRecord, derive, encodeAddress, encodeManagedRecord, fromHex, isPhraseRoot,
  logRulesOf, managedBindingMessage, managedLogOf, managedMessagingKey, managedMessagingKeyOf, managedRecordProblem,
  managedSignerIsCurrent, managedSignerVerifies, newRootProblem, policyOf, provesPhrase, rootDigest, signManagedBinding,
  signManagedRecord, splitLog, toBase64Url, fromBase64Url, toHex,
} from "../dist/index.js";
import { goldenVectors } from "../../../scripts/vectors.mjs";

const relay = goldenVectors("relay-v1.json").vectors;
const accounts = goldenVectors("accounts-v1.json");
const connect = goldenVectors("connect-v1.json");
const phrase = goldenVectors("new-phrase-v1.json");

const rules = { genesis: fromHex(accounts.chain.genesis_hash_hex, 32), policy: policyOf(accounts.chain.account_policy) };
const account = fromHex(accounts.account.account_hex, 20);
const address = accounts.account.address;
const events = (list) => list.map((e) => fromHex(e.event_hex ?? e.borsh_hex));
const mainLog = events(accounts.log.events);
const vector = (name) => relay.find((v) => v.name === name);
/** The log as relays carry it: the Borsh of the events, a count then each one. */
const carried = (list) => concat(new Writer().u32(list.length).done(), ...list);
const phone = { p256: fromHex(accounts.account.phone_secret_hex, 32) };
const browser = { ed25519: fromHex(accounts.account.browser_secret_hex, 32) };

test("managed bindings and records are the node's, and a device of the log signs them", () => {
  const b = vector("managed binding by the phone");
  for (const name of ["managed record of the phone", "managed record of the browser"]) {
    const v = vector(name);
    const record = decodeManagedRecord(fromBase64Url(v.record_b64));
    assert.equal(toHex(encodeManagedRecord(record)), v.encoded_hex, name);
    assert.equal(toHex(encodeManagedRecord(record)).slice(0, v.binding_hex.length), v.binding_hex, name);
    assert.equal(toHex(record.key.messagingKey), b.messaging_key_hex);
    assert.equal(record.key.seq, b.seq);
    assert.ok(managedSignerVerifies(record.key.signer, managedBindingMessage(record.key), record.key.signature), "the binding's signature");
    const log = checkLog(account, mainLog, rules.genesis, rules.policy);
    assert.equal(managedRecordProblem(record, log, v.issued_at), null, name);
    assert.deepEqual(managedLogOf(record, mainLog, rules), { log });
  }
  // The same signatures again, from the vectors' keys: P-256 (RFC 6979, a low s) for the phone, Ed25519 for the browser.
  const binding = signManagedBinding(phone, account, fromHex(b.messaging_key_hex, 32), b.key_epoch, b.issued_at, b.seq);
  assert.equal(toHex(binding.signature), b.signature_hex, "the phone's binding");
  const v = vector("managed record of the browser");
  const again = signManagedRecord(browser, binding, fromHex(v.relay_hex, 32), v.issued_at, fromHex(v.nonce_hex, 16));
  assert.equal(toHex(encodeManagedRecord(again)), v.encoded_hex, "the browser's record");
  const byPhone = vector("managed record of the phone");
  assert.equal(toHex(encodeManagedRecord(signManagedRecord(phone, binding, fromHex(byPhone.relay_hex, 32), byPhone.issued_at, fromHex(byPhone.nonce_hex, 16)))),
    byPhone.encoded_hex, "the phone's record");
});

test("a managed record is refused for its reason, as the node's relay refuses it", () => {
  const v = vector("managed record of the phone");
  const record = decodeManagedRecord(fromBase64Url(v.record_b64));
  const now = v.issued_at;
  const log = checkLog(account, mainLog, rules.genesis, rules.policy);
  // A signer the log no longer lists: the phone removed (connect-v1), or a new controller of the browser alone.
  for (const list of [events(connect.logs["managed-without-phone"]), events(accounts.controller_change.events)]) {
    const later = checkLog(account, list, rules.genesis, rules.policy);
    assert.equal(managedRecordProblem(record, later, now), "revoked");
  }
  // The log has not reached the binding's event.
  assert.equal(managedRecordProblem(record, checkLog(account, mainLog.slice(0, 3), rules.genesis, rules.policy), now), "log_behind");
  // A binding's or a record's signature off; another account's log; issued ahead of the clock.
  const flipped = (bytes, at) => { const out = bytes.slice(); out[at] ^= 1; return out; };
  const encoded = encodeManagedRecord(record);
  assert.equal(managedRecordProblem(decodeManagedRecord(flipped(encoded, 40)), log, now), "binding_signature", "its messaging key changed");
  assert.equal(managedRecordProblem(decodeManagedRecord(flipped(encoded, encoded.length - 3)), log, now), "signature");
  const upgraded = fromHex(connect.accounts.upgraded_hex, 20);
  assert.equal(managedRecordProblem(record, checkLog(upgraded, events(connect.logs.upgraded), rules.genesis, rules.policy), now), "mismatch");
  assert.equal(managedRecordProblem(record, log, record.issuedAt - 10 * 60_000 - 1), "future");
  assert.equal(managedRecordProblem(record, log, record.issuedAt - 10 * 60_000), null, "ten minutes ahead is not ahead");
  const early = { ...record, key: { ...record.key, issuedAt: record.issuedAt + 10 * 60_000 } };
  assert.equal(managedRecordProblem(early, log, record.issuedAt - 1), "binding_signature", "a binding's time is signed");
  // A binding the phone dated ahead, under a record of now.
  const ahead = signManagedBinding(phone, account, record.key.messagingKey, 0, now + 10 * 60_000 + 1, 5);
  assert.equal(managedRecordProblem(signManagedRecord(browser, ahead, record.relay, now, record.nonce), log, now), "future");
  // A record a stranger signed under the phone's good binding, and a binding a stranger signed: neither signer is the log's.
  const stranger = { ed25519: new Uint8Array(32).fill(0x66) };
  assert.equal(managedRecordProblem(signManagedRecord(stranger, record.key, record.relay, now, record.nonce), log, now), "revoked");
  const theirs = signManagedBinding(stranger, account, record.key.messagingKey, 0, now, 5);
  assert.equal(managedRecordProblem(signManagedRecord(browser, theirs, record.relay, now, record.nonce), log, now), "revoked");
  // A guardian is listed and signs nothing (13-accounts §10).
  const guarded = { ...log, devices: log.devices.map((d) => ("p256" in d.key ? { ...d, kind: "guardian" } : d)) };
  assert.equal(managedRecordProblem(record, guarded, now), "revoked");
  // A key named in another form is another key, as the node looks a device up.
  assert.ok(managedSignerIsCurrent(record.key.signer, log));
  assert.ok(!managedSignerIsCurrent({ device: { p256: "05" + record.key.signer.device.p256.slice(2) } }, log));
  // A log that does not check is no log of the account's.
  assert.deepEqual(Object.keys(managedLogOf(record, mainLog.slice(1), rules)).sort(), ["detail", "problem"]);
  assert.equal(managedLogOf(record, mainLog.slice(1), rules).problem, "log");
});

test("a messaging key is taken only from a record that checks against its log, of the address asked for", () => {
  const v = vector("managed record of the phone");
  const now = v.issued_at;
  const log = toBase64Url(carried(mainLog));
  assert.equal(toHex(managedMessagingKeyOf(address, v.record_b64, log, now, "devnet", rules)), "23".repeat(32));
  assert.equal(managedMessagingKeyOf(address, v.record_b64, log, now, "testnet", rules), null, "another network's address");
  assert.equal(managedMessagingKeyOf(address, v.record_b64, log, now, "devnet", { ...rules, genesis: new Uint8Array(32) }), null, "another chain");
  assert.equal(managedMessagingKeyOf(address, v.record_b64, log, now, "devnet", null), null, "no rules: no key");
  const other = encodeAddress("devnet", new Uint8Array(20).fill(5));
  assert.deepEqual(managedMessagingKey(other, v.record_b64, log, now, "devnet", rules), { problem: "record" });
  assert.equal(managedMessagingKey(address, v.record_b64, toBase64Url(carried(mainLog.slice(0, 3))), now, "devnet", rules).problem, "log_behind");
  assert.equal(managedMessagingKey(address, v.record_b64, "AAAA", now, "devnet", rules).problem, "log", "a log cut short");
  assert.equal(managedMessagingKey(address, "not base64!", log, now, "devnet", rules).problem, "record");
  assert.equal(managedMessagingKeyOf(address, v.record_b64, null, now, "devnet", rules), null);
  // The upgraded account's address is its kind 0 one: an id of either kind is looked up as the record names it.
  assert.equal(managedMessagingKey(encodeAddress("devnet", account, 0), v.record_b64, log, now, "devnet", rules).problem, undefined);
});

test("the log as relays carry it splits into its events, a payment's where the next begins", () => {
  for (const list of [mainLog, events(connect.logs["managed-payments"]), events(connect.logs.upgraded), events(phrase.log.events), []]) {
    assert.deepEqual(splitLog(carried(list)).map(toHex), list.map(toHex));
  }
  const payments = carried(events(connect.logs["managed-payments"]));
  // Cut short: a matured event's end (or an account action's) is read, so the log's end is missed; a payment last takes
  // what is left, which then does not check.
  assert.throws(() => splitLog(carried(mainLog).slice(0, -1)), TypeError, "cut short");
  assert.throws(() => checkLog(account, splitLog(payments.slice(0, -1)), rules.genesis, rules.policy), LogError, "a payment cut short");
  assert.throws(() => splitLog(concat(carried(mainLog), Uint8Array.of(0))), TypeError, "a byte left over");
  assert.throws(() => splitLog(new Writer().u32(513).done()), /at most 512 events/);
  assert.throws(() => splitLog(new Uint8Array(192 * 1024 + 1)), /192 KiB/);
  // A payment's event whose successor names another id ends nowhere: refused, not taken short.
  const list = events(connect.logs["managed-payments"]);
  const edited = list.map((e) => e.slice());
  edited[2][40] ^= 1;
  assert.throws(() => splitLog(carried(edited)), /does not end/);
});

test("the current phrase's roots are the node's: the vectors' logs, and a proven new phrase", () => {
  const hex = (log) => log.phraseRoots.map(toHex);
  assert.deepEqual(hex(checkLog(account, mainLog, rules.genesis, rules.policy)), accounts.log.proves.phrase_roots_hex);
  assert.deepEqual(hex(checkLog(account, events(accounts.controller_change.events), rules.genesis, rules.policy)),
    accounts.controller_change.proves.phrase_roots_hex);
  const chain = { genesis: fromHex(phrase.chain.genesis_hash_hex, 32), policy: policyOf(phrase.chain.account_policy) };
  const id = fromHex(phrase.account.id_hex, 20);
  for (const [name, want] of [["log", phrase.log], ["bare_log", phrase.bare_log]]) {
    const log = checkLog(id, events(want.events), chain.genesis, chain.policy);
    assert.deepEqual(hex(log), want.phrase_roots_hex, name);
    assert.equal(toHex(log.rootDigest), want.root_digest_hex, name);
    assert.equal(provesPhrase(log, fromHex(phrase.new_phrase.roots[0].digest_hex, 32)), want.proves_new_phrase, name);
    assert.equal(provesPhrase(log, fromHex(phrase.account.roots[0].digest_hex, 32)), want.proves_own_phrase, name);
  }
  // Once the new phrase is the account's, its roots sign for it and the old phrase's do not.
  const proven = checkLog(id, events(phrase.log.events), chain.genesis, chain.policy);
  for (const root of phrase.new_phrase.roots) assert.ok(isPhraseRoot(proven, fromHex(root.public_key_hex, 32)), `new root ${root.index}`);
  for (const root of phrase.account.roots) assert.ok(!isPhraseRoot(proven, fromHex(root.public_key_hex, 32)), `old root ${root.index}`);
  // A new phrase's first root proves it for one account on one network, and nothing else does.
  for (const c of phrase.refused) {
    const r = fromHex(c.new_root_borsh_hex);
    const newRoot = { scheme: r[0], publicKey: r.slice(1, 33), nextDigest: r.slice(33, 65), signature: r.slice(65, 129) };
    assert.equal(newRootProblem(newRoot, fromHex(c.genesis_hash_hex, 32), fromHex(c.account_hex, 20)), c.error, c.case);
  }
  const p = fromHex(phrase.proof.new_root_borsh_hex);
  assert.equal(newRootProblem({ scheme: p[0], publicKey: p.slice(1, 33), nextDigest: p.slice(33, 65), signature: p.slice(65, 129) }, chain.genesis, id), null);
});

test("a root of the current phrase signs until a new phrase replaces it; a new address's first root signs alone", () => {
  // A kind 5 account of roots made here, events written byte for byte as the node writes them (13-accounts §6–§7).
  const G = rules.genesis;
  const pol = rules.policy;
  const roots = [1, 2, 3, 4].map(() => crypto.getRandomValues(new Uint8Array(32)));
  const digests = roots.map((r) => rootDigest(ed25519.getPublicKey(r)));
  const id = accountId(digests[0], 5);
  const phoneSecret = crypto.getRandomValues(new Uint8Array(32));
  const phoneKey = ed25519.getPublicKey(phoneSecret);
  const tx = (nonce, action) => new Writer().u8(1).fixed(id, 20).u64(BigInt(nonce)).u64(5000n).u64(90000n).raw(action).done();
  const idOf = (t) => derive("Salarium transaction v3", G, t);
  const rootUse = (t, r) => new Writer().u8(3).u8(0).fixed(ed25519.getPublicKey(roots[r]), 32).fixed(digests[r + 1], 32)
    .fixed(ed25519.sign(derive("Salarium root use v1", idOf(t), digests[r + 1]), roots[r]), 64).done();
  const build = (bodies) => {
    const out = [];
    let prev = new Uint8Array(32);
    bodies.forEach(([slot, signed], i) => {
      const e = new Writer().fixed(id, 20).u32(i + 1).fixed(prev, 32).u64(BigInt(slot)).u8(0).raw(signed).done();
      out.push(e);
      prev = derive("Salarium key event v1", e);
    });
    return out;
  };
  const addPhone = tx(0, new Writer().u8(7).u8(0).u8(0).fixed(phoneKey, 32).u8(0).u64(0n).u64(0n).done());
  const first = build([[10, concat(addPhone, rootUse(addPhone, 0))]]);
  const key = (r) => ({ root: roots[r] });
  const NOW = 1_800_000_000_000;
  const recordBy = (signerKey, seq) => signManagedRecord(signerKey, signManagedBinding(signerKey, id, new Uint8Array(32).fill(7), 1, NOW, seq),
    new Uint8Array(32).fill(3), NOW, new Uint8Array(16).fill(4));
  const problem = (record, list) => {
    const known = managedLogOf(record, list, rules);
    return "problem" in known ? known.problem : managedRecordProblem(record, known.log, NOW);
  };

  // Before its first transaction: the address's first root signs; another root does not make the address; a device has no log.
  assert.equal(problem(recordBy(key(0), 0), []), null);
  assert.equal(problem(recordBy(key(1), 0), []), "revoked");
  assert.equal(problem(recordBy({ ed25519: phoneSecret }, 0), []), "log");
  // The first transaction used root 0 and moved on to root 1: both are the phrase's; root 2 is not yet.
  assert.deepEqual(checkLog(id, first, G, pol).phraseRoots.map(toHex), [digests[0], digests[1]].map(toHex));
  assert.equal(problem(recordBy(key(0), 1), first), null);
  assert.equal(problem(recordBy(key(1), 1), first), null);
  assert.equal(problem(recordBy(key(2), 1), first), "revoked");
  assert.equal(problem(recordBy({ ed25519: phoneSecret }, 1), first), null, "the phone it added");

  // A new phrase named by its digest (ReplaceRootV1), by the root and the phone at once: root 1's use moves on to root 2,
  // then the new phrase starts the roots over — no root of the old phrase signs any more.
  const bare = crypto.getRandomValues(new Uint8Array(32));
  const replaceV1 = tx(1, new Writer().u8(7).u8(3).fixed(rootDigest(ed25519.getPublicKey(bare)), 32).done());
  const quorum = (t, r) => {
    const message = derive("Salarium quorum v1", idOf(t), Uint8Array.of(4, 0));
    return new Writer().u8(4).u8(0).fixed(ed25519.getPublicKey(roots[r]), 32).fixed(digests[r + 1], 32)
      .fixed(ed25519.sign(derive("Salarium root use v1", message, digests[r + 1]), roots[r]), 64).u8(0).fixed(ed25519.sign(message, phoneSecret), 64).done();
  };
  const replacedV1 = build([[10, concat(addPhone, rootUse(addPhone, 0))], [20, concat(replaceV1, quorum(replaceV1, 1))]]);
  const afterV1 = checkLog(id, replacedV1, G, pol);
  assert.deepEqual(afterV1.phraseRoots.map(toHex), [toHex(rootDigest(ed25519.getPublicKey(bare)))]);
  assert.equal(afterV1.phraseProven, false, "a bare digest proves nothing");
  for (const r of [0, 1, 2]) assert.equal(problem(recordBy(key(r), 2), replacedV1), "revoked", `old root ${r}`);
  assert.equal(problem({ ...recordBy({ root: bare }, 2) }, replacedV1), null, "the new phrase's first root");

  // A new phrase its first root proves (ReplaceRoot, 13-accounts §6.6): its first and next roots are the phrase's.
  const [first0, next1] = [1, 2].map(() => crypto.getRandomValues(new Uint8Array(32)));
  const digest0 = rootDigest(ed25519.getPublicKey(first0));
  const nextDigest = rootDigest(ed25519.getPublicKey(next1));
  const proof = ed25519.sign(derive("Salarium new root v1", G, id, digest0, nextDigest), first0);
  const replace = tx(1, new Writer().u8(7).u8(7).u8(0).fixed(ed25519.getPublicKey(first0), 32).fixed(nextDigest, 32).fixed(proof, 64).done());
  const replaced = build([[10, concat(addPhone, rootUse(addPhone, 0))], [20, concat(replace, quorum(replace, 1))]]);
  const after = checkLog(id, replaced, G, pol);
  assert.deepEqual(after.phraseRoots.map(toHex), [digest0, nextDigest].map(toHex));
  assert.ok(after.phraseProven && provesPhrase(after, digest0));
  assert.equal(toHex(after.rootDigest), toHex(nextDigest), "the account moved on to the next root");
  assert.equal(problem(recordBy({ root: next1 }, 2), replaced), null);
  assert.equal(problem(recordBy({ root: first0 }, 2), replaced), null);
  assert.equal(problem(recordBy(key(1), 2), replaced), "revoked");
  // The new phrase's proof made for another account is refused with the event.
  const forged = tx(1, new Writer().u8(7).u8(7).u8(0).fixed(ed25519.getPublicKey(first0), 32).fixed(nextDigest, 32)
    .fixed(ed25519.sign(derive("Salarium new root v1", G, new Uint8Array(32).fill(9), digest0, nextDigest), first0), 64).done());
  assert.throws(() => checkLog(id, build([[10, concat(addPhone, rootUse(addPhone, 0))], [20, concat(forged, quorum(forged, 1))]]), G, pol),
    /did not sign it for this account and network/);
});

test("the rules a log is checked under come from the node's status, of its network alone", async () => {
  const status = (s) => ({ call: async (method) => (method === "node_status" ? s : null) });
  const ok = { network: "devnet", genesis: accounts.chain.genesis_hash_hex, accounts: { derivation: 2, policy: { delay: 600, dispute_timeout: 3600 } } };
  assert.deepEqual(await logRulesOf(status(ok), "devnet"), rules);
  await assert.rejects(logRulesOf(status(ok), "testnet"), /not testnet/);
  await assert.rejects(logRulesOf(status({ network: "devnet", genesis: ok.genesis, starting: {} }), "devnet"), /no genesis and account policy/);
});
