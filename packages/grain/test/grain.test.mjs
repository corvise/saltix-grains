// The bridge as a wallet answers it: a fake `window.salarium` records what the SDK sends.
import test from "node:test";
import assert from "node:assert/strict";
import { grain, inWallet, walletLink, slugLink, GrainError, ErrorCode, MAX_RELAY_PAYLOAD, _reset } from "../dist/index.js";

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

test("relay frames go out as hex and come back as bytes; notifications are asked", async () => {
  const handlers = new Map();
  const sent = [];
  globalThis.salarium = {
    isGrain: true,
    request: async (args) => {
      sent.push(args);
      return { grain_relay_open: { address: "dsalt1qalias" }, grain_notifications_allow: { allowed: true } }[args.method] ?? null;
    },
    on: (e, h) => handlers.set(h, e),
    off: (e, h) => handlers.delete(h),
  };
  _reset();
  assert.equal(await grain.relay.open(), "dsalt1qalias");
  await grain.relay.open({ grant: "ABCD" });
  assert.deepEqual(sent.splice(0, 2).map((r) => r.params), [{}, { grant: "abcd" }]);
  await grain.relay.send("dsalt1qpeer", new Uint8Array([1, 2, 255]), { keep: true });
  await grain.relay.send("dsalt1qpeer", new Uint8Array(MAX_RELAY_PAYLOAD));
  assert.deepEqual(sent[0], { method: "grain_relay_send", params: { to: "dsalt1qpeer", payload: "0102ff", keep: true } });
  assert.equal(sent[1].params.keep, false, "live unless kept");
  for (const bad of [new Uint8Array(0), new Uint8Array(MAX_RELAY_PAYLOAD + 1)]) {
    await assert.rejects(grain.relay.send("dsalt1qpeer", bad), (e) => e.code === ErrorCode.InvalidParams);
  }
  assert.equal(sent.length, 2, "a refused frame is not sent");

  const frames = [];
  const stop = grain.relay.onFrame((from, payload) => frames.push([from, [...payload]]));
  const [[wrapped, event]] = handlers;
  assert.equal(event, "relay");
  wrapped({ from: "dsalt1qpeer", payload: "0aff" });
  assert.deepEqual(frames, [["dsalt1qpeer", [10, 255]]]);
  stop();
  assert.equal(handlers.size, 0, "stopped listening");

  assert.equal(await grain.notifications.allow(), true);
  await grain.relay.close();
  assert.deepEqual(sent.slice(2).map((r) => r.method), ["grain_notifications_allow", "grain_relay_close"]);
});
