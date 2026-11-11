// The simulator's own logic, without a browser. Its modules are a page's code (TypeScript, bundled by esbuild as the
// build bundles the whole simulator), so what in them touches no page is bundled here the same way and called as it is.
// The simulator in a real browser is check.test.mjs's, which runs only where a browser is: a rule held there alone is
// held on no computer without one.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { shortAddress } from "@saltix/grain";
import { ID_BYTES, encodeAddress, fromHex } from "@saltix/grain-server";

/** A module of the simulator, bundled for this process. */
async function simulatorModule(file) {
  const built = buildSync({
    entryPoints: [fileURLToPath(new URL(`../../../simulator/${file}`, import.meta.url))],
    bundle: true, format: "esm", write: false, logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
}

test("the Connect sheet names the owner by a short address of the network, never by hex", async () => {
  const { ownerWords } = await simulatorModule("connect-sheet.ts");
  const owner = "11f780e0338e43a929b1ecd5e59f3cbb5f6a6552";
  assert.equal(owner.length, 2 * ID_BYTES, "an account as a manifest names it");
  for (const [network, prefix] of [["devnet", "dsalt"], ["testnet", "tsalt"], ["mainnet", "salt"]]) {
    const words = ownerWords(owner, network);
    assert.equal(words, shortAddress(encodeAddress(network, fromHex(owner, ID_BYTES))), network);
    assert.match(words, new RegExp(`^${prefix}1q\\w{4}…\\w{6}$`), network);
    assert.ok(!words.includes(owner.slice(0, 8)), "no hex");
  }
  // A manifest loaded by hand may hold anything there: it is shown as written, and the sheet still draws. A key's 32
  // bytes are no account.
  for (const not of ["", "zz", owner.slice(2), `${owner}00`, owner.toUpperCase(), "0".repeat(64)]) {
    assert.equal(ownerWords(not, "devnet"), not, JSON.stringify(not));
  }
});
