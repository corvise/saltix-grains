// A key event log checked offline (Saltix 13-accounts §7): the logs of vectors/connect-v1.json (a managed account, its
// payments, its phone removed, an upgrade from kind 0), and logs built here byte for byte as the node writes them, each
// broken in the ways a node or a relay could break it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { Writer, accountId, checkLog, concat, derive, fromHex, keySpeaksFor, deviceProblem, LogError, policyOf, rootDigest, toHex } from "../dist/index.js";

const v = JSON.parse(readFileSync(new URL("../../../vectors/connect-v1.json", import.meta.url), "utf8"));
const genesis = fromHex(v.chain.genesis_hash_hex, 32);
const policy = policyOf(v.chain.account_policy);
const managed = fromHex(v.accounts.managed_hex, 32);
const log = (name) => v.logs[name].map((e) => fromHex(e.event_hex));
const kinds = (checked) => checked.devices.map((d) => d.kind);

test("the vectors' logs prove the devices the grants rely on", () => {
  const phone = checkLog(managed, log("managed"), genesis, policy);
  assert.equal(phone.origin.kind, "root");
  assert.deepEqual(kinds(phone), ["phone", "browser"]);
  assert.deepEqual(kinds(checkLog(managed, log("managed-without-phone"), genesis, policy)), ["browser"]);
  // A registry call and a transfer the root signed: their actions passed over, their proofs checked.
  const payments = checkLog(managed, log("managed-payments"), genesis, policy);
  assert.deepEqual(kinds(payments), ["phone"]);
  assert.equal(payments.seq, 3);
  const upgraded = checkLog(fromHex(v.accounts.upgraded_hex, 32), log("upgraded"), genesis, policy);
  assert.equal(upgraded.origin.kind, "key");
  assert.deepEqual(kinds(upgraded), ["phone"]);
});

test("a log missing an event, out of order, on another chain, of another account or changed is refused", () => {
  const events = log("managed");
  assert.ok(events.length >= 2);
  const fails = (list, g = genesis, account = managed) => assert.throws(() => checkLog(account, list, g, policy), LogError);
  fails(events.slice(1));
  fails([events[1], events[0], ...events.slice(2)]);
  fails(events, new Uint8Array(32).fill(1));
  fails(events, genesis, new Uint8Array(32));
  // A byte of each event's last 64, its proof's signature or a matured event's id.
  for (let i = 0; i < events.length; i++) {
    const changed = events.map((e) => e.slice());
    changed[i][changed[i].length - 5] ^= 1;
    fails(changed);
  }
  const flip = (list, index, fromEnd) => {
    list[index][list[index].length - fromEnd] ^= 1;
    return list;
  };
  fails(flip(log("managed-payments").map((e) => e.slice()), 2, 5));
  fails(flip(log("managed-payments").map((e) => e.slice()), 1, 230), "a payment's action changed");
});

test("who speaks for an account: its own key while it has no log, a device of the log, never a guardian", () => {
  const plainKey = { ed25519: toHex(ed25519.getPublicKey(fromHex(v.plain_secret_hex, 32))) };
  const plain = fromHex(v.accounts.plain_hex, 32);
  assert.equal(keySpeaksFor(plainKey, plain, [], genesis, policy).problem, null);
  assert.equal(keySpeaksFor(plainKey, managed, [], genesis, policy).problem, "not_the_account");
  const devices = checkLog(managed, log("managed"), genesis, policy).devices;
  for (const d of devices) assert.equal(keySpeaksFor(d.key, managed, log("managed"), genesis, policy).problem, null);
  assert.equal(keySpeaksFor(plainKey, managed, log("managed"), genesis, policy).problem, "not_a_device");
  assert.equal(keySpeaksFor(devices[0].key, managed, log("managed").slice(1), genesis, policy).problem, "log");
  // The upgraded account's own kind 0 key speaks for nothing once it has a controller.
  const upgraded = fromHex(v.accounts.upgraded_hex, 32);
  const { origin } = checkLog(upgraded, log("upgraded"), genesis, policy);
  const birthKey = { ed25519: toHex(origin.key) };
  assert.equal(toHex(accountId(origin.key, 0)), v.accounts.upgraded_hex);
  assert.equal(keySpeaksFor(birthKey, upgraded, log("upgraded"), genesis, policy).problem, "upgraded");
  assert.equal(keySpeaksFor(birthKey, upgraded, [], genesis, policy).problem, null, "before the upgrade it did");
  // A guardian is someone else's key: listed, and still not the account's.
  const guardian = { devices: [{ key: devices[0].key, kind: "guardian" }] };
  assert.equal(deviceProblem(devices[0].key, false, guardian), "guardian");
});

test("a log made here: the root and a device, a root used again, a bad device signature, a matured event alone", () => {
  // A kind 5 account of random roots, events built byte for byte as the node writes them (13-accounts §6–§7).
  const G = new Uint8Array(32).fill(9);
  const roots = [1, 2, 3].map(() => crypto.getRandomValues(new Uint8Array(32)));
  const digests = roots.map((r) => rootDigest(ed25519.getPublicKey(r)));
  const account = accountId(digests[0], 5);
  const phone = crypto.getRandomValues(new Uint8Array(32));
  const phoneKey = ed25519.getPublicKey(phone);
  const pol = { delay: 600n, disputeTimeout: 3600n };
  const tx = (nonce, action, sender = account) => new Writer().u8(1).fixed(sender, 32).u64(BigInt(nonce)).u64(5000n).u64(90000n).raw(action).done();
  const addDevice = (key, kind = 0) => new Writer().u8(7).u8(0).u8(0).fixed(key, 32).u8(kind).u64(0n).u64(0n).done();
  const removeDevice = (key) => new Writer().u8(7).u8(1).u8(0).fixed(key, 32).done();
  const idOf = (t) => derive("Saltix transaction v3", G, t);
  const root = (t, r, next = digests[r + 1]) =>
    new Writer().u8(3).u8(0).fixed(ed25519.getPublicKey(roots[r]), 32).fixed(next, 32).fixed(ed25519.sign(derive("Saltix root use v1", idOf(t), next), roots[r]), 64).done();
  const device = (t, signature = ed25519.sign(idOf(t), phone)) => new Writer().u8(1).u8(0).fixed(signature, 64).done();
  const build = (bodies, who = account) => {
    const out = [];
    let prev = new Uint8Array(32);
    bodies.forEach(([slot, body], i) => {
      const w = new Writer().fixed(who, 32).u32(i + 1).fixed(prev, 32).u64(BigInt(slot));
      const e = "signed" in body ? w.u8(0).raw(body.signed).done() : w.u8(1).fixed(body.matured, 32).done();
      out.push(e);
      prev = derive("Saltix key event v1", e);
    });
    return out;
  };
  const first = tx(0, addDevice(phoneKey));
  const e1 = [10, { signed: concat(first, root(first, 0)) }];
  const remove = tx(1, removeDevice(phoneKey));
  assert.deepEqual(checkLog(account, build([e1, [20, { signed: concat(remove, device(remove)) }]]), G, pol).devices, []);
  assert.deepEqual(checkLog(account, build([e1]), G, pol).devices.map((d) => d.key.ed25519), [toHex(phoneKey)]);
  const again = tx(1, addDevice(ed25519.getPublicKey(new Uint8Array(32).fill(0x58))));
  assert.throws(() => checkLog(account, build([e1, [20, { signed: concat(again, root(again, 0)) }]]), G, pol), LogError, "a root used up");
  // The root alone registers a new device for later (13-accounts §6.3): it is not a device yet.
  assert.equal(checkLog(account, build([e1, [20, { signed: concat(again, root(again, 1)) }]]), G, pol).devices.length, 1);
  assert.throws(() => checkLog(account, build([e1, [20, { signed: concat(remove, device(remove, new Uint8Array(64).fill(1))) }]]), G, pol), LogError);
  assert.throws(() => checkLog(account, build([e1, [700, { matured: new Uint8Array(32).fill(4) }]]), G, pol), LogError);
  const events = build([e1, [20, { signed: concat(remove, device(remove)) }]]);
  const foreign = events.map((e) => e.slice());
  foreign[1][0] ^= 1;
  assert.throws(() => checkLog(account, foreign, G, pol), LogError, "an event of another account");
  const moved = events.map((e) => e.slice());
  moved[1][40] ^= 1;
  assert.throws(() => checkLog(account, moved, G, pol), LogError, "another previous event");
  assert.throws(() => checkLog(account, [], G, pol), LogError, "no events");
  // A device key of small order (the identity point here) is no device key, though it is 32 bytes.
  const identity = new Uint8Array(32);
  identity[0] = 1;
  const weak = tx(0, addDevice(identity));
  assert.throws(() => checkLog(account, build([[10, { signed: concat(weak, root(weak, 0)) }]]), G, pol), /not a valid device key/);
});

test("a quorum signed in either form proves, all its signers in one; a quorum cut to one signer of version 2 does not", () => {
  // From protocol version 2 a quorum's signers sign its quorum message, derive("Saltix quorum v1", id ‖ [tag] ‖
  // indexes), the root its use of it (13-accounts §6.1); before it, the id. A log takes either form (§7).
  const G = new Uint8Array(32).fill(7);
  const roots = [1, 2, 3, 4].map(() => crypto.getRandomValues(new Uint8Array(32)));
  const digests = roots.map((r) => rootDigest(ed25519.getPublicKey(r)));
  const account = accountId(digests[0], 5);
  const [phone, browser] = [1, 2].map(() => crypto.getRandomValues(new Uint8Array(32)));
  const [phoneKey, browserKey] = [phone, browser].map((k) => ed25519.getPublicKey(k));
  const pol = { delay: 1200n, disputeTimeout: 7200n };
  const tx = (nonce, action) => new Writer().u8(1).fixed(account, 32).u64(BigInt(nonce)).u64(5000n).u64(90000n).raw(action).done();
  const addDevice = (key, kind) => new Writer().u8(7).u8(0).u8(0).fixed(key, 32).u8(kind).u64(0n).u64(0n).done();
  // Weaker than the network's: only a quorum applies it at once; one signer registers it for later.
  const setPolicy = new Writer().u8(7).u8(4).u64(600n).u64(3600n).done();
  const idOf = (t) => derive("Saltix transaction v3", G, t);
  const quorum = (t, shape) => derive("Saltix quorum v1", idOf(t), Uint8Array.of(...shape));
  const rootUse = (r, message) =>
    new Writer().u8(0).fixed(ed25519.getPublicKey(roots[r]), 32).fixed(digests[r + 1], 32).fixed(ed25519.sign(derive("Saltix root use v1", message, digests[r + 1]), roots[r]), 64).done();
  const sig = (index, key, message) => new Writer().u8(index).fixed(ed25519.sign(message, key), 64).done();
  const build = (bodies) => {
    const out = [];
    let prev = new Uint8Array(32);
    bodies.forEach(([slot, signed], i) => {
      const e = new Writer().fixed(account, 32).u32(i + 1).fixed(prev, 32).u64(BigInt(slot)).u8(0).raw(signed).done();
      out.push(e);
      prev = derive("Saltix key event v1", e);
    });
    return out;
  };
  const first = tx(0, addDevice(phoneKey, 0));
  const e1 = [10, concat(first, Uint8Array.of(3), rootUse(0, idOf(first)))];
  const keys = (events) => checkLog(account, build(events), G, pol).devices.map((d) => d.key.ed25519);

  // The root and the phone add the browser: a quorum, at once, in either form.
  const add = tx(1, addDevice(browserKey, 1));
  const q = quorum(add, [4, 0]);
  const rootAndPhone = (rootMessage, phoneMessage) => concat(add, Uint8Array.of(4), rootUse(1, rootMessage), sig(0, phone, phoneMessage));
  for (const [form, signed] of [["v2", rootAndPhone(q, q)], ["v1", rootAndPhone(idOf(add), idOf(add))]]) {
    assert.deepEqual(keys([e1, [20, signed]]), [toHex(phoneKey), toHex(browserKey)], form);
  }
  // One form for every signer: the root's of one version and the phone's of the other prove nothing.
  for (const signed of [rootAndPhone(q, idOf(add)), rootAndPhone(idOf(add), q)]) {
    assert.throws(() => checkLog(account, build([e1, [20, signed]]), G, pol), LogError, "a quorum of two forms");
  }
  // Cut to its root alone: a version 2 quorum's root signed the quorum's message, not the id, so the cut proof fails;
  // a version 1 quorum's root signed the id, and alone it only registers the device for later (the attack version 2
  // ends).
  const rootOf = (rootMessage) => concat(add, Uint8Array.of(3), rootUse(1, rootMessage));
  assert.throws(() => checkLog(account, build([e1, [20, rootOf(q)]]), G, pol), LogError, "a version 2 quorum cut to its root");
  assert.deepEqual(keys([e1, [20, rootOf(idOf(add))]]), [toHex(phoneKey)], "a root alone registers, never adds at once");

  // Two devices weaken the policy: a quorum, at once, in either form; cut to one device of version 2, nothing.
  const e2 = [20, rootAndPhone(q, q)];
  const weaken = tx(2, setPolicy);
  const q2 = quorum(weaken, [2, 0, 1]);
  const both = (first, second) => concat(weaken, Uint8Array.of(2), sig(0, phone, first), sig(1, browser, second));
  const policyOf = (events) => checkLog(account, build(events), G, pol).policy;
  for (const [form, signed] of [["v2", both(q2, q2)], ["v1", both(idOf(weaken), idOf(weaken))]]) {
    assert.deepEqual(policyOf([e1, e2, [30, signed]]), { delay: 600n, disputeTimeout: 3600n }, form);
  }
  for (const signed of [both(q2, idOf(weaken)), both(idOf(weaken), q2)]) {
    assert.throws(() => checkLog(account, build([e1, e2, [30, signed]]), G, pol), LogError, "two devices of two forms");
  }
  const phoneAlone = (message) => concat(weaken, Uint8Array.of(1), sig(0, phone, message));
  assert.throws(() => checkLog(account, build([e1, e2, [30, phoneAlone(q2)]]), G, pol), LogError, "a version 2 quorum cut to one device");
  // A device alone signs the id in every version: it registers the weaker policy, which applies only when it matures.
  assert.deepEqual(policyOf([e1, e2, [30, phoneAlone(idOf(weaken))]]), pol);
  // Indexes are part of the message: the phone's and the browser's signatures of the shape [2, 1, 0] do not hold for
  // the proof [2, 0, 1].
  const swapped = quorum(weaken, [2, 1, 0]);
  assert.throws(() => checkLog(account, build([e1, e2, [30, both(swapped, swapped)]]), G, pol), LogError, "another shape");
});

test("the protocol's version 2 quorums prove the log's keys in place of version 1's; mixed or cut, nothing", () => {
  // vectors/accounts-v1.json: its log's events 2 and 3 are quorums signed in version 1's form (the id); `quorums_v2`
  // signs the same transactions in version 2's (13-accounts §6.1). The log rebuilt with them proves what the file says.
  const a = JSON.parse(readFileSync(new URL("../../../vectors/accounts-v1.json", import.meta.url), "utf8"));
  const G = fromHex(a.chain.genesis_hash_hex, 32);
  const pol = policyOf(a.chain.account_policy);
  const account = fromHex(a.account.account_hex, 32);
  const original = a.log.events.map((e) => fromHex(e.event_hex));
  const v1 = Object.fromEntries(a.transactions.map((t) => [t.name, t]));
  const proves = a.log.proves;
  for (const q of a.quorums_v2) {
    assert.equal(q.version, 2);
    assert.equal(q.id_hex, v1[q.name].id_hex, "the same transaction");
    assert.equal(q.transaction_hex, v1[q.name].transaction_hex);
    const id = fromHex(q.id_hex, 32);
    const proof = fromHex(q.proof_hex);
    const shape = proof[0] === 2 ? Uint8Array.of(2, proof[1], proof[66]) : Uint8Array.of(4, proof[130]);
    assert.equal(toHex(derive("Saltix quorum v1", id, shape)), q.quorum_message_hex, q.name);
  }
  // An event's signed transaction swapped for another form, the log re-linked as the node links it.
  const header = 32 + 4 + 32 + 8;
  const relink = (swaps) => {
    let prev = new Uint8Array(32);
    return original.map((e, i) => {
      // A signed event's body is tag 0 and the signed transaction; a matured one's (tag 1) stays as it is.
      const body = swaps.has(i) ? concat(Uint8Array.of(0), swaps.get(i)) : e.subarray(header);
      if (swaps.has(i)) assert.equal(e[header], 0, "a signed event");
      const out = concat(e.subarray(0, 36), prev, e.subarray(68, header), body);
      prev = derive("Saltix key event v1", out);
      return out;
    });
  };
  const at = (name) => original.findIndex((e) => toHex(e).includes(v1[name].signed_hex));
  const v2 = new Map(a.quorums_v2.map((q) => [at(q.name), fromHex(q.signed_hex)]));
  assert.deepEqual([...v2.keys()].sort(), [1, 2]);
  const checked = checkLog(account, relink(v2), G, pol);
  assert.deepEqual(checked.devices.map((d) => ("p256" in d.key ? `01${d.key.p256}` : `00${d.key.ed25519}`)), proves.devices);
  assert.equal(toHex(checked.rootDigest), proves.root_digest_hex);
  assert.deepEqual({ delay: Number(checked.policy.delay), dispute_timeout: Number(checked.policy.disputeTimeout) }, proves.policy);
  assert.equal(checked.seq, proves.seq);
  // The file's own log, in version 1's form, proves the same.
  assert.deepEqual(checkLog(account, original, G, pol).devices.map((d) => d.kind), checked.devices.map((d) => d.kind));
  // One quorum's root of version 2 with its device of version 1: two forms in one proof.
  const name = "root-and-phone-add-browser";
  const q = a.quorums_v2.find((x) => x.name === name);
  const body = fromHex(q.transaction_hex);
  const newProof = fromHex(q.proof_hex);
  const oldProof = fromHex(v1[name].signed_hex).subarray(body.length);
  assert.equal(oldProof.length, newProof.length);
  const rootPart = 1 + 129;
  const mixed = [concat(body, newProof.subarray(0, rootPart), oldProof.subarray(rootPart)), concat(body, oldProof.subarray(0, rootPart), newProof.subarray(rootPart))];
  for (const signed of mixed) {
    assert.throws(() => checkLog(account, relink(new Map([[at(name), signed]])), G, pol), LogError, "a quorum of two forms");
  }
  // Cut to its root: version 2's root signed its use of the quorum's message, not of the id.
  const cut = concat(body, Uint8Array.of(3), newProof.subarray(1, rootPart));
  assert.throws(() => checkLog(account, relink(new Map([[at(name), cut]])), G, pol), LogError, "a version 2 quorum cut to its root");
});

test("a P-256 device key in its compact form (05 ‖ x), which protocol versions 1 and 2 took, is one key with its compressed form and keeps signing", async () => {
  // vectors/accounts-v1.json `device_key_forms`: the same point in both forms; the compact form names the point of x
  // with the smaller y. A log check takes the forms every version took (the chain held each event to its block's).
  const { compressedP256, deviceKeyValid, sameDeviceKey, verifyByDeviceKey, readAccountAction, Reader } = await import("../dist/index.js");
  const { p256 } = await import("@noble/curves/p256");
  const { sha256 } = await import("@noble/hashes/sha256");
  const a = JSON.parse(readFileSync(new URL("../../../vectors/accounts-v1.json", import.meta.url), "utf8"));
  const forms = a.device_key_forms;
  const compressed = forms.keys.find((k) => k.name === "compressed").key_hex.slice(2);
  const compact = forms.keys.find((k) => k.name === "compact").key_hex.slice(2);
  assert.equal(compact.slice(0, 2), "05");
  for (const k of forms.keys) assert.equal(deviceKeyValid({ p256: k.key_hex.slice(2) }), k.valid["1"] && k.valid["2"], k.name);
  assert.equal(compressedP256(compact), compressed, "the compact form names the compressed point");
  assert.equal(compressedP256(compressed), compressed);
  assert.ok(sameDeviceKey({ p256: compact }, { p256: compressed }) && sameDeviceKey({ p256: compressed }, { p256: compact }));
  // The key's secret signs; the signature verifies under either form, and under no other point.
  const message = derive("Saltix key event v1", new Uint8Array([1, 2, 3]));
  const signature = toHex(p256.sign(sha256(message), fromHex(forms.secret_hex, 32), { prehash: false, lowS: true }).toCompactRawBytes());
  assert.equal(toHex(p256.getPublicKey(fromHex(forms.secret_hex, 32), true)), compressed, "the vector's secret is the key's");
  assert.ok(verifyByDeviceKey({ p256: compressed }, message, signature));
  assert.ok(verifyByDeviceKey({ p256: compact }, message, signature), "the compact form verifies the same signature");
  const other = (compressed.startsWith("02") ? "03" : "02") + compressed.slice(2);
  assert.ok(!verifyByDeviceKey({ p256: other }, message, signature), "the other point of x does not");
  // What is no point: refused in every form.
  for (const bad of ["04" + compressed.slice(2), "05" + "ff".repeat(32), "06" + compressed.slice(2), "00".repeat(33)]) {
    assert.equal(compressedP256(bad), null, bad.slice(0, 2));
    assert.equal(deviceKeyValid({ p256: bad }), false, bad.slice(0, 2));
  }
  // The vector's AddDevice of the compact key reads as an action a log replay takes (versions 1 and 2).
  const tx = fromHex(forms.add_device.transaction_hex);
  const r = new Reader(tx);
  r.u8(); r.fixed(32); r.u64(); r.u64(); r.u64();
  assert.equal(r.u8(), 7, "an account action");
  const action = readAccountAction(r);
  assert.equal(action.kind, "add_device");
  assert.equal(action.device.key.p256, compact);
  assert.ok(deviceKeyValid(action.device.key));
  assert.deepEqual(forms.add_device.taken_in, [1, 2]);
  assert.deepEqual(forms.add_device.refused_in, [3]);
});
