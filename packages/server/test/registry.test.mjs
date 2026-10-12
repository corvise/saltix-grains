// The owner's registry transactions of vectors/grains-v1.json, byte for byte (Saltix 12-grains §3).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeGrainTx, grainTxId, signGrainTx, minimumFee, fromHex, toHex, sameManifest } from "../dist/index.js";
import { ed25519 } from "@noble/curves/ed25519";

const v = JSON.parse(readFileSync(new URL("../../../vectors/grains-v1.json", import.meta.url), "utf8"));
const secret = fromHex(v.owner_secret, 32);
const callOf = (c) => c.call === "register_grain" ? { register: c.manifest } : c.call === "update_grain" ? { update: c.manifest } : { retire: c.slug };

test("registry transactions are the node's", () => {
  const r = v.registry;
  assert.equal(r.transactions.length, 3);
  for (const t of r.transactions) {
    const fields = { nonce: BigInt(t.nonce), fee: BigInt(t.fee), validUntilSlot: BigInt(t.valid_until_slot) };
    const call = callOf(t.call);
    const body = encodeGrainTx({ ...fields, sender: toHex(ed25519.getPublicKey(secret)) }, call);
    assert.equal(toHex(body), t.transaction_hex, t.name);
    assert.equal(grainTxId(body, r.genesis_hash), t.id_hex, t.name);
    const signed = signGrainTx(secret, fields, call, r.genesis_hash);
    assert.equal(signed.hex, t.signed_hex, t.name);
    assert.equal(signed.id, t.id_hex);
    assert.ok(minimumFee(call) >= BigInt(t.signed_hex.length / 2) * 10n);
  }
  assert.equal(r.deposit, "100000000000");
});

test("only the owner's manifest and a valid slug are signed", () => {
  const register = v.registry.transactions.find((t) => t.name === "register");
  const other = fromHex("62".repeat(32), 32);
  assert.throws(() => signGrainTx(other, { nonce: 0, fee: 0, validUntilSlot: 1 }, { register: register.call.manifest }, v.registry.genesis_hash), /owner_key/);
  assert.throws(() => signGrainTx(secret, { nonce: 0, fee: 0, validUntilSlot: 1 }, { retire: "Go" }, v.registry.genesis_hash), /slug/);
});

test("a wallet's manifest is the same but for its owner", () => {
  const m = v.manifests.find((c) => c.name === "hosted").json.manifest;
  assert.ok(sameManifest(m, { ...m, owner: "22".repeat(32), owner_key: { p256: "02" + "33".repeat(32) } }));
  assert.ok(!sameManifest(m, { ...m, version: m.version + 1 }));
});
