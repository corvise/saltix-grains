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
