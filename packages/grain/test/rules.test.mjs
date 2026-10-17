// The wallet's bridge rules as Saltix applies them (saltix-wallet GrainBridge.kt, GrainContainer.kt, GrainStorage.kt,
// SealedSite.kt), which the simulator plays by: a tap before a payment, the chat, the app's page and the first asks;
// the manifest's permissions; the team for the app's page; rate limits per known method only; 64 KiB per answer and
// event; storage's bounds; a sealed grain's origin and Content-Security-Policy.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_METHODS, BRIDGE_MESSAGE_MAX, BridgeLimiter, DEFAULT_BRIDGE_RATE, BRIDGE_RATES, USER_ACTIVATION_MS, STORAGE_MAX_GRAIN_BYTES,
  STORAGE_MAX_KEY_BYTES, STORAGE_MAX_VALUE_BYTES, bridgeAnswer, bridgeEvent, manageRule, permissionRule, sealedCsp, storageRule,
  tapRule,
} from "../dist/rules.js";
import { MAX_RELAY_PAYLOAD } from "../dist/index.js";

test("a payment, the chat and the app's page need a tap; the address and notifications ask only from one", () => {
  for (const method of ["grain_pay", "grain_chat_open", "grain_manage_open"]) {
    assert.deepEqual(tapRule(method, { tapped: true, consented: false }), { go: true, ask: false }, method);
    const refused = tapRule(method, { tapped: false, consented: true });
    assert.equal(refused.refuse, 4100, method);
    assert.match(refused.message, /tap of the user/);
  }
  assert.deepEqual(tapRule("grain_requestAddress", { tapped: false, consented: true }), { go: true, ask: false }, "shared on the sheet");
  assert.deepEqual(tapRule("grain_requestAddress", { tapped: true, consented: false }), { go: true, ask: true });
  assert.deepEqual(tapRule("grain_requestAddress", { tapped: false, consented: false }),
    { refuse: 4001, message: "the user has not shared the address: ask from a tap" });
  assert.deepEqual(tapRule("grain_notifications_allow", { tapped: false, consented: true }), { answer: { allowed: true } });
  assert.deepEqual(tapRule("grain_notifications_allow", { tapped: false, consented: false }), { answer: { allowed: false } }, "never asked without a tap");
  assert.deepEqual(tapRule("grain_notifications_allow", { tapped: true, consented: false }), { go: true, ask: true });
  assert.deepEqual(tapRule("grain_login", { tapped: false, consented: false }), { go: true, ask: true }, "a sign-in asks once, tap or not");
  assert.deepEqual(tapRule("grain_storage_get", { tapped: false, consented: false }), { go: true, ask: false });
  assert.equal(USER_ACTIVATION_MS, 5_000);
});

test("what the manifest does not ask for is refused, and the app's page is for its team", () => {
  assert.deepEqual(permissionRule("grain_storage_set", 0), { refuse: 4100, message: "the manifest does not ask for this" });
  assert.equal(permissionRule("grain_storage_set", 1), null);
  assert.equal(permissionRule("grain_relay_send", 1)?.refuse, 4100);
  assert.equal(permissionRule("grain_relay_send", 2), null);
  assert.equal(permissionRule("grain_notifications_allow", 3)?.refuse, 4100);
  assert.equal(permissionRule("grain_requestAddress", 63)?.message, "the manifest does not ask for the address");
  assert.equal(permissionRule("grain_requestAddress", 64), null);
  assert.equal(permissionRule("grain_info", 0), null);
  assert.equal(manageRule(true), null);
  assert.deepEqual(manageRule(false), { refuse: 4100, message: "the app's page is for its team" });
  assert.deepEqual(manageRule(null), { refuse: 5000, message: "the wallet cannot read the app's team now" });
});

test("rate limits keep a bucket per known method only, and refuse past the burst", () => {
  const limiter = new BridgeLimiter();
  for (let i = 0; i < 1000; i++) assert.equal(limiter.take(`grain_made_up_${i}`, 0), "unsupported");
  assert.equal(limiter.size, 0, "an arbitrary name makes no bucket");
  assert.deepEqual(BRIDGE_RATES.grain_pay, [0.5, 1]);
  assert.deepEqual(DEFAULT_BRIDGE_RATE, [20, 40]);
  assert.equal(limiter.take("grain_pay", 0), "ok");
  assert.equal(limiter.take("grain_pay", 1), "rate_limited");
  assert.equal(limiter.take("grain_pay", 2_001), "ok", "half a request a second");
  for (let i = 0; i < 40; i++) assert.equal(limiter.take("grain_info", 10), "ok");
  assert.equal(limiter.take("grain_info", 10), "rate_limited");
  assert.equal(limiter.size, 2);
  assert.ok(BRIDGE_METHODS.includes("grain_manage_open") && BRIDGE_METHODS.length === 24, String(BRIDGE_METHODS.length));
  for (const m of Object.keys(BRIDGE_RATES)) assert.ok(BRIDGE_METHODS.includes(m), m);
});

test("an answer or an event over 64 KiB is not the page's: the answer becomes an error, the event is dropped", () => {
  assert.equal(BRIDGE_MESSAGE_MAX, 65_536);
  const small = bridgeAnswer(7, { result: { value: "x" } });
  assert.deepEqual(JSON.parse(small), { result: { value: "x" }, id: 7 });
  // A stored value of 60 KiB of quotes is twice as long as JSON: Saltix cannot answer it.
  const big = JSON.parse(bridgeAnswer(8, { result: { value: '"'.repeat(STORAGE_MAX_VALUE_BYTES) } }));
  assert.deepEqual(big, { id: 8, error: { code: 5000, message: "the answer is over 64 KiB" } });
  // A relay frame of the most a page may send arrives as hex twice its size: over the limit, so dropped.
  assert.equal(bridgeEvent("relay", { from: "dsalt1q", payload: "ab".repeat(MAX_RELAY_PAYLOAD) }), null);
  assert.ok(bridgeEvent("relay", { from: "dsalt1q", payload: "ab".repeat(32_000) }));
  assert.equal(bridgeEvent("relay", { from: "dsalt1q", payload: "ab".repeat(33_000) }), null);
});

test("storage takes keys of 1 to 128 bytes without U+0000, values of at most 60 KiB, 1 MiB a grain", () => {
  assert.equal(STORAGE_MAX_KEY_BYTES, 128);
  assert.equal(STORAGE_MAX_GRAIN_BYTES, 1 << 20);
  const kept = new Map([["a", "b".repeat(1000)]]);
  assert.equal(storageRule("set", { key: "score", value: "12" }, kept), null);
  for (const key of ["", "k".repeat(129), "a\u0000b", 7, undefined]) {
    assert.equal(storageRule("get", { key }, kept)?.refuse, -32602, String(key));
  }
  assert.equal(storageRule("get", { key: "й".repeat(64) }, kept), null, "128 bytes of UTF-8");
  assert.equal(storageRule("set", { key: "k", value: 5 }, kept)?.refuse, -32602);
  assert.equal(storageRule("set", { key: "k", value: "v".repeat(STORAGE_MAX_VALUE_BYTES + 1) }, kept)?.refuse, -32602);
  const full = new Map(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v".repeat(STORAGE_MAX_VALUE_BYTES)]));
  assert.deepEqual(storageRule("set", { key: "more", value: "v".repeat(10_000) }, full), { refuse: 4100, message: "the grain's storage holds at most 1 MiB" });
  assert.equal(storageRule("set", { key: "k0", value: "short" }, full), null, "a smaller value under a key it holds");
});

test("a sealed grain's Content-Security-Policy, as Saltix serves it", () => {
  const csp = sealedCsp(["https://api.chess.example"]);
  assert.match(csp, /^default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:;/);
  assert.match(csp, /connect-src 'self' https:\/\/api\.chess\.example wss:\/\/api\.chess\.example;/);
  assert.match(csp, /frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'$/);
  assert.equal(sealedCsp([]).includes("connect-src 'self';"), true);
});
