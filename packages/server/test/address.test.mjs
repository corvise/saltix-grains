// Address v1 as vectors/crypto-v1.json has it: the id of a key, and its address on each network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountId, encodeAddress, decodeAddress, toHex, fromHex } from "../dist/index.js";

const v = JSON.parse(readFileSync(new URL("../../../vectors/crypto-v1.json", import.meta.url), "utf8"));

test("addresses are the node's", () => {
  for (const c of v.vectors) {
    const id = accountId(fromHex(c.public_key_hex, 32));
    assert.equal(toHex(id), c.address_id_hex, c.name);
    assert.equal(encodeAddress("mainnet", id), c.address_mainnet);
    assert.equal(encodeAddress("testnet", id), c.address_testnet);
    assert.equal(encodeAddress("devnet", id), c.address_devnet);
    const back = decodeAddress(c.address_devnet);
    assert.equal(back.network, "devnet");
    assert.equal(back.kind, 0);
    assert.equal(toHex(back.id), c.address_id_hex);
  }
  const good = v.vectors[0].address_devnet;
  assert.equal(decodeAddress(good.slice(0, -1) + (good.endsWith("q") ? "p" : "q")), null, "a broken checksum");
  assert.equal(decodeAddress("btc1" + good.slice(6)), null, "another prefix");
});
