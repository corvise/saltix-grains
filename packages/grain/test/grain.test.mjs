// The bridge as a wallet answers it: a fake `window.salarium` records what the SDK sends.
import test from "node:test";
import assert from "node:assert/strict";
import { grain, inWallet, walletLink, slugLink, GrainError, ErrorCode, _reset } from "../dist/index.js";

function wallet(answer) {
  const sent = [];
  globalThis.salarium = {
    isGrain: true,
    request: async (args) => { sent.push(args); return answer(args); },
    on: (e, h) => sent.push({ on: e }),
  };
  _reset();
  return sent;
}

test("outside a wallet nothing is asked, and the link opens the grain in one", async () => {
  delete globalThis.salarium;
  _reset();
  assert.equal(inWallet(), false);
  await assert.rejects(grain.info(), (e) => e instanceof GrainError && e.code === ErrorCode.NoWallet);
  assert.equal(walletLink("https://chess.example/.well-known/salarium-grain", "room-7"),
    "salt:grain?manifest=https%3A%2F%2Fchess.example%2F.well-known%2Fsalarium-grain&start=room-7");
  assert.throws(() => walletLink("https://a.example/m", "a b"), GrainError);
  assert.equal(slugLink("chess"), "salt:grain/chess");
  assert.equal(slugLink("chess", "room-7"), "salt:grain/chess?start=room-7");
  for (const bad of ["Chess", "go", "-chess", "a".repeat(33)]) assert.throws(() => slugLink(bad), GrainError, bad);
  assert.throws(() => slugLink("chess", "a b"), GrainError);
});

test("methods and parameters are the wallet's", async () => {
  const sent = wallet(({ method }) => ({
    grain_login: { key: "aa", signature: "bb", at: 1, origin: "https://chess.example" },
    grain_storage_get: { value: "1640" },
    grain_storage_keys: { keys: ["rating"] },
    grain_requestAddress: { address: "dsalt1q..." },
    grain_scanQr: { text: "hello" },
  })[method] ?? null);
  assert.equal(inWallet(), true);
  await grain.login(new Uint8Array([10, 11, 255]));
  await grain.login("ABCD");
  assert.equal(await grain.storage.get("rating"), "1640");
  assert.deepEqual(await grain.storage.keys(), ["rating"]);
  assert.equal(await grain.requestAddress(), "dsalt1q...");
  assert.equal(await grain.scanQr(), "hello");
  await grain.pay({ invoice: "00ff" });
  await grain.setHeader("#112233");
  grain.on("theme", () => {});
  assert.deepEqual(sent.slice(0, 2), [
    { method: "grain_login", params: { challenge: "0a0bff" } },
    { method: "grain_login", params: { challenge: "abcd" } },
  ]);
  assert.deepEqual(sent[6], { method: "grain_pay", params: { invoice: "00ff" } });
  assert.deepEqual(sent[7], { method: "grain_setHeader", params: { color: "#112233" } });
  assert.deepEqual(sent[8], { on: "theme" });
});

test("the wallet's refusals arrive with their code", async () => {
  wallet(() => { const e = new Error("the user declined"); e.code = 4001; throw e; });
  await assert.rejects(grain.pay({ to: "dsalt1q", amount: "1" }), (e) => e instanceof GrainError && e.code === ErrorCode.UserRejected);
  wallet(() => { throw new Error("boom"); });
  await assert.rejects(grain.ready(), (e) => e.code === ErrorCode.Failed && e.message === "boom");
});
