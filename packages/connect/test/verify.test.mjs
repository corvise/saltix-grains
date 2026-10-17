// The chain's side of taking a grant (Saltix 19-connect §5), where the page's node is asked: its status (network,
// genesis, account policy) read with the log for each grant, and the node asked again only when it could not answer.
// This package is the reference for the page's check; the explorer's `explorer/src/connect/` follows it.
import test from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, toHex } from "@saltix/grain-server/web";
import { ConnectError, NodeError, NodeUnreachable, UncheckedError, encodeGrant, loginMessage, nodeCall, retryable, verifyGrant } from "../dist/index.js";

const GENESIS = "5a".repeat(32);
const ORIGIN = "https://dex.example";
const SECRET = new Uint8Array(32).fill(0x44);
const KEY = ed25519.getPublicKey(SECRET);
const STATUS = { network: "devnet", genesis: GENESIS, accounts: { policy: { delay: 600, dispute_timeout: 3600 } } };

const session = { network: Uint8Array.from(Buffer.from(GENESIS, "hex")), origin: ORIGIN, sid: new Uint8Array(32).fill(1), page: new Uint8Array(32).fill(2) };

function grant() {
  const login = { network: session.network, account: accountId(KEY), origin: ORIGIN, sid: session.sid, page: session.page, at: BigInt(Date.now()) };
  const g = { version: 1, login, signer: { ed25519: toHex(KEY) }, signature: ed25519.sign(loginMessage(login), SECRET) };
  return { g, bytes: encodeGrant(g) };
}

/** A node the test plays: `answers[method]` is a value, or a function of the call's number that returns or throws. */
function node(answers) {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push(method);
      const a = answers[method];
      if (a === undefined) throw new NodeError(method, -32601, "no such method");
      return typeof a === "function" ? a(calls.filter((m) => m === method).length, params) : a;
    },
  };
}

const deps = (n, over = {}) => ({ node: n, network: "devnet", genesis: GENESIS, retryMs: [0, 0], ...over });
const log = (events = []) => (_n, params) => ({ account: params.address, events });

const refusedFor = (reason) => (e) => e instanceof ConnectError && e.reason === reason;
const uncheckedFor = (kind) => (e) => e instanceof UncheckedError && e.kind === kind;

test("a plain account's grant is taken from a node on the page's network that keeps accounts", async () => {
  const { g, bytes } = grant();
  const n = node({ node_status: STATUS, account_log: log() });
  const c = await verifyGrant(g, bytes, session, deps(n));
  assert.equal(c.account, toHex(accountId(KEY)));
  assert.equal(c.managed, false);
  assert.equal(c.network, GENESIS);
  assert.deepEqual(n.calls, ["node_status", "account_log"], "the node's status is read with the log, for this grant");
});

test("a node on another chain or network refuses the grant, whatever its log says", async () => {
  const { g, bytes } = grant();
  for (const status of [{ ...STATUS, genesis: "66".repeat(32) }, { ...STATUS, network: "mainnet" }]) {
    const n = node({ node_status: status, account_log: log() });
    await assert.rejects(verifyGrant(g, bytes, session, deps(n)), refusedFor("network"));
    assert.deepEqual(n.calls, ["node_status"], "nothing else is asked of it");
  }
});

test("a node that names no account policy keeps no logs: even an empty log is unchecked, never taken", async () => {
  const { g, bytes } = grant();
  const n = node({ node_status: { network: "devnet", genesis: GENESIS }, account_log: log() });
  await assert.rejects(verifyGrant(g, bytes, session, deps(n)), uncheckedFor("no_policy"));
});

test("only a node that could not answer is asked again: unreachable, too slow or busy", async () => {
  const { g, bytes } = grant();
  // Busy once (the node's -32603), then the log.
  const busyOnce = node({ node_status: STATUS, account_log: (i, p) => {
    if (i === 1) throw new NodeError("account_log", -32603, "the node is busy");
    return log()(i, p);
  } });
  assert.equal((await verifyGrant(g, bytes, session, deps(busyOnce))).managed, false);
  assert.deepEqual(busyOnce.calls, ["node_status", "account_log", "account_log"]);
  // The status too.
  const statusOnce = node({ node_status: (i) => {
    if (i === 1) throw new NodeUnreachable("node_status", "timeout");
    return STATUS;
  }, account_log: log() });
  assert.equal((await verifyGrant(g, bytes, session, deps(statusOnce))).managed, false);
  // Never answering: asked once and twice again, then unchecked.
  const down = node({ node_status: STATUS, account_log: () => { throw new NodeUnreachable("account_log", "unreachable"); } });
  await assert.rejects(verifyGrant(g, bytes, session, deps(down)), uncheckedFor("unreachable"));
  assert.equal(down.calls.filter((m) => m === "account_log").length, 3);
  // An answer that is no answer, the node's own error, or anything else is not asked again.
  for (const [failure, kind] of [
    [new NodeUnreachable("account_log", "bad_answer"), "bad_answer"],
    [new NodeUnreachable("account_log", "http"), "http"],
    [new NodeError("account_log", -32602, "invalid params"), "node_error"],
    [new Error("a page's own transport failed"), "node_error"],
  ]) {
    const n = node({ node_status: STATUS, account_log: () => { throw failure; } });
    await assert.rejects(verifyGrant(g, bytes, session, deps(n)), uncheckedFor(kind));
    assert.equal(n.calls.filter((m) => m === "account_log").length, 1, kind);
  }
});

test("what may pass: the node unreachable, too slow, or busy by HTTP 429, 502, 503, 504 or its own -32603", async () => {
  const real = globalThis.fetch;
  const answer = (status, body) => async () => new Response(body, { status, headers: { "content-type": "application/json" } });
  const outcome = async (fetcher) => {
    globalThis.fetch = fetcher;
    try {
      await nodeCall("http://node.invalid/rpc", "account_log", {});
      return "answered";
    } catch (e) {
      return e;
    }
  };
  try {
    for (const status of [429, 502, 503, 504]) {
      const e = await outcome(answer(status, ""));
      assert.ok(e instanceof NodeUnreachable && e.kind === "busy" && retryable(e), String(status));
    }
    for (const status of [400, 401, 403, 404, 500, 501]) {
      const e = await outcome(answer(status, "<html>"));
      assert.ok(e instanceof NodeUnreachable && e.kind === "http" && !retryable(e), String(status));
    }
    const busy = await outcome(answer(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "the node is busy" } })));
    assert.ok(busy instanceof NodeError && busy.code === -32603 && retryable(busy));
    const refused = await outcome(answer(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 4, message: "not found" } })));
    assert.ok(refused instanceof NodeError && !retryable(refused));
    const garbled = await outcome(answer(200, "not json"));
    assert.ok(garbled instanceof NodeUnreachable && garbled.kind === "bad_answer" && !retryable(garbled));
    const gone = await outcome(async () => { throw new TypeError("fetch failed"); });
    assert.ok(gone instanceof NodeUnreachable && gone.kind === "unreachable" && retryable(gone));
    assert.equal(retryable(new NodeUnreachable("x", "timeout")), true);
    assert.equal(retryable(new Error("x")), false);
    assert.equal(retryable(null), false);
  } finally {
    globalThis.fetch = real;
  }
});
