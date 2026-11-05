// How a server reaches its network with a developer key alone: the relays' gateways over their pinned certificates (or a
// public CA's), passed over when they fail or do not follow the account's shard, each named by fingerprint and never by
// address, a call going over the relays as they were when it began; and a view of the chain cached per tip.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CALL_TIMEOUT_MS, RelayGateways, ChainView, RpcError, usableEndpoint, publicGateways, nodeCall, grainGet, FAUCET, entryPoints, endpointOf,
  obfuscateEntries, revealEntries, relayFailure, withoutAddresses,
} from "../dist/index.js";
import { scratch } from "../../../scripts/scratch.mjs";

const relay = (n) => ({ url: `wss://10.0.0.${n}:30335/`, cert_sha256: String(n).repeat(64).slice(0, 64) });
const json = (value) => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });

test("the release's entry points are obfuscated pinned wss:// endpoints, the test network's for the devnet kind", () => {
  const entries = entryPoints("devnet");
  assert.equal(entries.length, 3);
  for (const text of entries) {
    const e = endpointOf(text);
    assert.ok(e && usableEndpoint(e) && e.url.startsWith("wss://") && /^[0-9a-f]{64}$/.test(e.cert_sha256), "an entry point is a pinned endpoint");
  }
  assert.deepEqual(entryPoints("mainnet"), []);
  assert.deepEqual(entryPoints("testnet"), []);
  // The blob is the lines XOR a SHAKE-256 stream of the network's name: no address reads in it, another network's stream
  // reads nothing.
  const lines = ["wss://192.0.2.1:30335/#" + "ab".repeat(32), "wss://192.0.2.2:30335/#" + "cd".repeat(32)];
  const blob = obfuscateEntries("devnet", lines);
  assert.ok(!/192\.0\.2|wss:/.test(Buffer.from(blob, "base64").toString("latin1")), "nothing readable in the blob");
  assert.deepEqual(revealEntries("devnet", blob), lines);
  assert.notDeepEqual(revealEntries("testnet", blob), lines);
  assert.equal(obfuscateEntries("devnet", []), "");
});

test("a call goes to the relay that answered last, past those that fail or do not follow the shard", async () => {
  const asked = [];
  const answers = new Map([
    [relay(1).url, () => { throw new Error("connect ECONNREFUSED"); }],
    [relay(2).url, () => ({ status: 429, body: Buffer.alloc(0) })],
    [relay(3).url, (method) => json(method === "account_get"
      ? { jsonrpc: "2.0", id: 1, error: { code: 1, message: "this node does not follow the account's shard" } }
      : { jsonrpc: "2.0", id: 1, result: { from: 3 } })],
    [relay(4).url, () => json({ jsonrpc: "2.0", id: 1, result: { from: 4 } })],
  ]);
  const request = async (endpoint, verb, path, headers, body) => {
    const method = JSON.parse(Buffer.from(body).toString()).method;
    asked.push(`${endpoint.url.slice(13, 14)}:${method}`);
    assert.equal(verb, "POST");
    assert.equal(path, "/rpc");
    return answers.get(endpoint.url)(method);
  };
  const g = new RelayGateways([relay(1), relay(2), relay(3), relay(4)], request);
  assert.deepEqual(await g.call("node_status"), { from: 3 });
  assert.deepEqual(asked, ["1:node_status", "2:node_status", "3:node_status"]);
  asked.length = 0;
  assert.deepEqual(await g.call("grain_get", { slug: "x" }), { from: 3 }, "the one that answered first");
  assert.deepEqual(asked, ["3:grain_get"]);
  asked.length = 0;
  assert.deepEqual(await g.call("account_get", { address: "aa" }), { from: 4 }, "another relay's node follows the shard");
  assert.deepEqual(asked, ["3:account_get", "4:account_get"]);
  // A node's own error is final: another relay's node would say the same.
  const refusing = new RelayGateways([relay(5), relay(6)], async (e) => (e.url === relay(5).url
    ? json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "slug: a grain's slug" } })
    : json({ jsonrpc: "2.0", id: 1, result: {} })));
  await assert.rejects(refusing.call("grain_get", { slug: "X" }), (e) => e instanceof RpcError && e.code === -32602);
  const none = new RelayGateways([relay(7)], async () => { throw new Error("timeout"); });
  await assert.rejects(none.call("node_status"), /no relay answered \(relay cert:77777777: no answer within 8 s\)/);
});

test("a call waits 8 s at most for a relay, and its error names each relay by fingerprint, never by address", async () => {
  assert.equal(CALL_TIMEOUT_MS, 8_000);
  const waits = [];
  const failing = new RelayGateways([relay(1), relay(2), { ...relay(3), key: "ab".repeat(32) }], async (endpoint, verb, path, headers, body, options) => {
    waits.push(options ?? {});
    if (endpoint.url === relay(1).url) throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:30335"), { code: "ECONNREFUSED" });
    if (endpoint.url === relay(2).url) throw new Error("write EPROTO 10.0.0.2:30335 [2001:db8::2]:30335 wss://10.0.0.2:30335/x");
    return json({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "this node at 10.0.0.3 does not follow the account's shard" } });
  });
  const error = await failing.call("account_get", { address: "aa" }).then(() => null, (e) => e);
  assert.deepEqual(waits.map((w) => w.timeoutMs), [8_000, 8_000, 8_000]);
  assert.ok(waits.every((w) => w.signal instanceof AbortSignal), "and a deadline for the whole answer, which destroys the request");
  assert.match(error.message, /^account_get: no relay answered \(relay cert:11111111: refused the connection; relay cert:22222222: write EPROTO <relay> <relay> <relay>; relay key:abababab: this node at <relay> does not follow/);
  assert.ok(!/10\.0\.0|2001:db8/.test(error.message), error.message);
  // The words for what the system says, an address taken out of anything else.
  assert.equal(relayFailure(Object.assign(new Error("x"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), 8_000),
    "its certificate is not one a public CA vouches for (a relay's own is pinned: wss://host:port/#<its SHA-256>)");
  assert.equal(withoutAddresses("connect ETIMEDOUT 2001:db8::7:30335 and fe80::1 at 12:30:05"), "connect ETIMEDOUT <relay> and <relay> at 12:30:05");
});

test("a call goes over the relays as they were when it began: finding them again meanwhile never moves it", async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const asked = [];
  const answer = async (endpoint) => {
    asked.push(endpoint.url.slice(13, 14));
    if (endpoint.url === relay(1).url) {
      await held;
      throw new Error("timeout");
    }
    return json({ jsonrpc: "2.0", id: 1, result: { from: endpoint.url.slice(13, 14) } });
  };
  // A finder whose next look finds other relays: relay 9 alone.
  let found = [relay(1), relay(2), relay(3)];
  const finder = { report: null, stale: false, find: async () => found, refresh: async () => found };
  const g = new RelayGateways([], answer, { finder });
  const call = g.call("node_status");
  await new Promise((r) => setImmediate(r));
  found = [relay(9)];
  assert.deepEqual((await g.refreshed()).map((e) => e.url), [relay(9).url], "the list replaced while the call waits on relay 1");
  release();
  assert.deepEqual(await call, { from: "2" }, "the call went on to relay 2 of its own list");
  assert.deepEqual(asked, ["1", "2"]);
  // The relay that answered last is kept by its URL and pin: a list without it starts at its first.
  found = [relay(2), relay(9)];
  await g.refreshed();
  asked.length = 0;
  assert.deepEqual(await g.call("node_status"), { from: "2" });
  found = [relay(9), relay(2)];
  await g.refreshed();
  asked.length = 0;
  assert.deepEqual(await g.call("node_status"), { from: "2" }, "wherever it stands in the list");
  assert.deepEqual(asked, ["2"]);
});

test("wss:// relays serve as gateways, pinned or behind a CA's certificate, each URL and pin once: a second pin never replaces the first", async () => {
  const g = new RelayGateways([
    { url: "ws://127.0.0.1:8090/relay", cert_sha256: null },
    { url: "wss://relay.example.net/", cert_sha256: null },
    { url: "wss://10.0.0.9:30335/", cert_sha256: "zz" },
    relay(1),
  ]);
  assert.deepEqual(g.endpoints, [{ url: "wss://relay.example.net/", cert_sha256: null }, relay(1)]);
  const moved = { ...relay(1), cert_sha256: "e".repeat(64) };
  assert.deepEqual(g.add([relay(1), relay(2), moved]), [relay(2), moved], "another pin for relay 1's URL: a relay of its own");
  assert.deepEqual(g.endpoints, [{ url: "wss://relay.example.net/", cert_sha256: null }, relay(1), relay(2), moved], "relay 1's pin stays");
  await assert.rejects(new RelayGateways([]).call("node_status"), /no relay to ask/);
});

test("the chain's view asks again only on a new tip", async () => {
  let t = 1_000_000;
  const status = { network: "devnet", genesis: "6c".repeat(32), slot: 1, beacon: { height: 1, hash: "b1" }, shards: [{ shard: "0", hash: "s1" }, { shard: "1", hash: "t1" }] };
  const calls = [];
  const node = {
    async call(method, params) {
      calls.push(method);
      if (method === "node_status") return structuredClone(status);
      if (method === "grain_get") return { grain: { slug: params.slug, servers: [] } };
      if (method === "account_get") return { shard: params.address.startsWith("a") ? "0" : "1", controller: null };
      throw new Error(method);
    },
  };
  const view = new ChainView(node, () => t);
  await view.grain("chess");
  await view.grain("chess");
  await view.controller("aa");
  await view.controller("aa");
  await view.controller("bb");
  assert.deepEqual(calls, ["node_status", "grain_get", "account_get", "account_get"], "the status for 2 seconds, each record once per tip");
  calls.length = 0;
  t += 2_000;
  status.shards[1].hash = "t2"; // a block on shard 1 only
  await view.grain("chess");
  await view.controller("aa");
  await view.controller("bb");
  assert.deepEqual(calls, ["node_status", "account_get"], "the beacon tip and shard 0's are the same");
  calls.length = 0;
  status.beacon.hash = "b2";
  await view.grain("chess");
  assert.deepEqual(calls, [], "the status is still fresh: the new block is seen within 2 seconds");
  await view.grain("chess", true);
  assert.deepEqual(calls, ["node_status", "grain_get"], "asked now");
});

test("gateways given relays call those alone: never relay_list, nor any list", async () => {
  const asked = [];
  const followsNone = json({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "this node does not follow the account's shard" } });
  const g = new RelayGateways([relay(1)], async (endpoint, verb, path, headers, body) => {
    asked.push(JSON.parse(Buffer.from(body).toString()).method);
    return followsNone;
  });
  await assert.rejects(g.call("account_get", { address: "aa" }), /no relay answered.*does not follow/);
  assert.deepEqual(asked, ["account_get"]);
});

test("a faucet's refusal is final, except a node that runs none: another relay's node may", async () => {
  const error = (message, data = null) => json({ jsonrpc: "2.0", id: 1, error: { code: FAUCET, message, data } });
  const order = [];
  const g = new RelayGateways([relay(1), relay(2), relay(3)], async (endpoint) => {
    order.push(endpoint.url.slice(13, 14));
    if (endpoint.url === relay(1).url) return error("no_faucet");
    if (endpoint.url === relay(2).url) return error("too_soon", { retry_after: 240 });
    return json({ jsonrpc: "2.0", id: 1, result: { id: "ab".repeat(32) } });
  });
  await assert.rejects(g.call("faucet_request", { address: "dsalt1x" }),
    (e) => e instanceof RpcError && e.code === FAUCET && e.reason === "too_soon" && e.data.retry_after === 240);
  assert.deepEqual(order, ["1", "2"], "the second's refusal ends it: every node counts the address the same way");
});

test("the network's relays are found when the first call is made: the test network's from its entry points, none known elsewhere", async () => {
  const devnet = publicGateways("devnet");
  assert.ok(devnet.finds);
  assert.deepEqual(devnet.endpoints, [], "nothing until a call looks");
  assert.equal(devnet.report, null);
  assert.throws(() => publicGateways("mainnet"), /no relay is known for mainnet/);
  assert.throws(() => publicGateways("testnet"), /no relay is known for testnet/);
  assert.ok(publicGateways("mainnet", undefined, { given: ["wss://192.0.2.1:30335/#" + "ab".repeat(32)] }).finds, "unless one is given");
  // The registry's reads take a node's URL or any wallet interface.
  const wallet = { call: async (method, params) => ({ grain: { slug: params.slug, via: method }, deposit: "5" }) };
  assert.deepEqual(await grainGet(wallet, "chess"), { slug: "chess", via: "grain_get" });
  assert.deepEqual(await nodeCall(wallet, "grain_get", { slug: "x" }), { grain: { slug: "x", via: "grain_get" }, deposit: "5" });
});

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

test("a gateway is trusted by its certificate's hash alone: another certificate is sent nothing", { skip: !hasOpenssl() && "no openssl" }, async () => {
  const dir = scratch("gateway-tls-");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=relay",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "pipe" });
  const pin = createHash("sha256").update(execFileSync("openssl", ["x509", "-in", join(dir, "cert.pem"), "-outform", "DER"])).digest("hex");
  const received = [];
  const https = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(`${req.method} ${req.url} ${JSON.parse(body).method}`);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { network: "devnet" } }));
    });
  });
  await new Promise((r) => https.listen(0, "127.0.0.1", r));
  const url = `wss://127.0.0.1:${https.address().port}/`;
  try {
    const wrong = new RelayGateways([{ url, cert_sha256: "ab".repeat(32) }]);
    await assert.rejects(wrong.call("node_status"), /relay cert:abababab: showed another certificate than its pin/);
    assert.deepEqual(received, [], "nothing reaches a relay that shows another certificate");
    const pinned = new RelayGateways([{ url, cert_sha256: pin.toUpperCase() }]);
    assert.deepEqual(await pinned.call("node_status"), { network: "devnet" });
    assert.deepEqual(received, ["POST /rpc node_status"]);
    // Without a pin, the CAs Node trusts judge the certificate: a self-signed one is refused, and sent nothing.
    received.length = 0;
    await assert.rejects(new RelayGateways([{ url, cert_sha256: null }]).call("node_status"), /relay ca: its certificate is not one a public CA vouches for/);
    assert.deepEqual(received, []);
  } finally {
    https.close();
  }
});


/** `promise`, or a failure naming `what` it waited for once `ms` pass. */
function within(ms, promise, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`waited ${ms} ms for ${what}`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A relay behind a self-signed certificate that `handle`s each request: its pinned endpoint and how many sockets it
 *  has open. */
async function tlsRelay(handle) {
  const dir = scratch("relay-tls-");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=relay",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "pipe" });
  const pin = createHash("sha256").update(execFileSync("openssl", ["x509", "-in", join(dir, "cert.pem"), "-outform", "DER"])).digest("hex");
  const https = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, handle);
  let open = 0;
  https.on("secureConnection", (socket) => { open++; socket.on("close", () => open--); });
  await new Promise((r) => https.listen(0, "127.0.0.1", r));
  return {
    endpoint: { url: `wss://127.0.0.1:${https.address().port}/`, cert_sha256: pin },
    open: () => open,
    close: () => { https.closeAllConnections?.(); https.close(); },
  };
}

test("a relay silent after the handshake is given up on the pinned socket too, and a request's signal destroys it at once", { skip: !hasOpenssl() && "no openssl", timeout: 10_000 }, async () => {
  const { relayRequest } = await import("../dist/index.js");
  const silent = await tlsRelay(() => {});
  try {
    const started = Date.now();
    const error = await within(3_000, relayRequest(silent.endpoint, "POST", "/rpc", {}, new TextEncoder().encode("{}"), { timeoutMs: 300 }),
      "the timer on the pinned socket to give the silent relay up").then(() => null, (e) => e);
    assert.equal(error?.code, "ETIMEDOUT", String(error));
    assert.ok(Date.now() - started < 2_000, "within its time, not forever");
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(Object.assign(new Error("the look is done"), { code: "ETIMEDOUT" })), 100);
    const cut = await within(3_000, relayRequest(silent.endpoint, "POST", "/rpc", {}, new TextEncoder().encode("{}"), { timeoutMs: 60_000, signal: deadline.signal }),
      "the request's signal to destroy it").then(() => null, (e) => e);
    assert.match(String(cut), /the look is done/);
    for (let i = 0; i < 40 && silent.open() > 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(silent.open(), 0, "every socket closed");
  } finally {
    silent.close();
  }
});

test("a relay that trickles its answer is cut at the request's deadline, its socket closed", { timeout: 10_000 }, async () => {
  const { createServer: httpServer } = await import("node:http");
  const { relayRequest } = await import("../dist/index.js");
  const timers = new Set();
  let closed = 0;
  const http = httpServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
    const t = setInterval(() => res.write(" "), 50);
    timers.add(t);
    res.on("close", () => { clearInterval(t); closed++; });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  try {
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(), 300);
    const started = Date.now();
    const error = await within(3_000, relayRequest({ url: `ws://127.0.0.1:${http.address().port}/`, cert_sha256: null }, "POST", "/rpc", {}, new TextEncoder().encode("{}"),
      { timeoutMs: 200, signal: deadline.signal }), "the request's deadline to cut the trickle").then(() => null, (e) => e);
    assert.equal(error?.code, "ETIMEDOUT", "its silences are short, its answer never ends: the deadline cuts it");
    assert.ok(Date.now() - started < 1_500);
    for (let i = 0; i < 40 && closed === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(closed, 1, "the relay saw the connection close");
  } finally {
    for (const t of timers) clearInterval(t);
    http.closeAllConnections?.();
    http.close();
  }
});

test("a one-shot look lets the process exit at once: probes it no longer waits for are given up", { timeout: 20_000 }, async () => {
  const { createServer: netServer } = await import("node:net");
  const { execFile } = await import("node:child_process");
  // Mute relays: they take the connection and never shake hands.
  const sockets = new Set();
  const mute = netServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((r) => mute.listen(0, "127.0.0.1", r));
  const index = new URL("../dist/index.js", import.meta.url).href;
  const port = mute.address().port;
  const script = `
    import { RelayFinder } from ${JSON.stringify(index)};
    const pin = "ab".repeat(32);
    const answering = async (e, verb, path, headers, body, options) => {
      if (e.url.includes(":${port}/")) return (await import(${JSON.stringify(index)})).relayRequest(e, verb, path, headers, body, options);
      return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { network: "devnet", genesis: "5a".repeat(32) } })) };
    };
    const entry = ["wss://192.0.2.1:30335/#" + pin, "wss://192.0.2.2:30335/#" + pin, "wss://192.0.2.3:30335/#" + pin,
      ...[0, 1, 2, 3].map((n) => "wss://127.0.0.1:${port}/" + n + "#" + pin)];
    const f = new RelayFinder({ network: "devnet", request: answering, probeMs: 4000, entry });
    const found = await f.find();
    console.log(found.length);
  `;
  try {
    const started = Date.now();
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, ["--input-type=module", "-e", script], { timeout: 15_000 }, (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
    });
    assert.equal(out.trim(), "3");
    assert.ok(Date.now() - started < 3_000, `exited ${Date.now() - started} ms after start, well before the mute relays' 4 s`);
  } finally {
    for (const s of sockets) s.destroy();
    mute.close();
  }
});

test("an answer from a node or a relay is read up to 4 MiB: a longer one is refused, not buffered", async () => {
  const { createServer: httpServer } = await import("node:http");
  const { MAX_ANSWER_BYTES, rpc, relayRequest } = await import("../dist/index.js");
  assert.equal(MAX_ANSWER_BYTES, 4 * 1024 * 1024);
  let huge = false;
  const http = httpServer((req, res) => {
    if (!huge) {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
      return;
    }
    // A chunked answer with no length: the cap is on the bytes read, not a header's word.
    res.writeHead(200, { "content-type": "application/json" });
    const chunk = Buffer.alloc(1 << 20, 0x20);
    for (let i = 0; i < 6; i++) res.write(chunk);
    res.end("{}");
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const port = http.address().port;
  try {
    assert.deepEqual(await rpc(`http://127.0.0.1:${port}/`, "node_status"), { ok: true });
    assert.equal((await relayRequest({ url: `ws://127.0.0.1:${port}/`, cert_sha256: null }, "GET", "/")).status, 200);
    huge = true;
    await assert.rejects(rpc(`http://127.0.0.1:${port}/`, "node_status"), /longer than 4194304 bytes/);
    await assert.rejects(relayRequest({ url: `ws://127.0.0.1:${port}/`, cert_sha256: null }, "GET", "/"), /longer than 4194304 bytes/);
  } finally {
    http.closeAllConnections?.();
    http.close();
  }
});
