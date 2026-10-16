// How a server reaches its network with a developer key alone: the relays' gateways over their pinned certificates,
// passed over when they fail or do not follow the account's shard, and a view of the chain cached per tip.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RelayGateways, PUBLIC_RELAYS, ChainView, RpcError, relaysOf, usableEndpoint, publicGateways, nodeCall, grainGet, FAUCET,
} from "../dist/index.js";

const relay = (n) => ({ url: `wss://10.0.0.${n}:30335/`, cert_sha256: String(n).repeat(64).slice(0, 64) });
const json = (value) => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });

test("the public relays are pinned wss:// endpoints, the test network's for the devnet kind", () => {
  assert.equal(PUBLIC_RELAYS.devnet.length, 3);
  for (const e of PUBLIC_RELAYS.devnet) {
    assert.ok(usableEndpoint(e) && e.url.startsWith("wss://") && /^[0-9a-f]{64}$/.test(e.cert_sha256), e.url);
  }
  assert.deepEqual(PUBLIC_RELAYS.mainnet, []);
  assert.deepEqual(PUBLIC_RELAYS.testnet, []);
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
  await assert.rejects(none.call("node_status"), /no relay answered.*timeout/);
});

test("only pinned wss:// relays serve as gateways, each once, the latest pin winning", async () => {
  const g = new RelayGateways([
    { url: "ws://127.0.0.1:8090/relay", cert_sha256: null },
    { url: "wss://relay.example/", cert_sha256: null },
    { url: "wss://10.0.0.9:30335/", cert_sha256: "zz" },
    relay(1),
  ]);
  assert.deepEqual(g.endpoints, [relay(1)]);
  g.add([relay(1), relay(2)]);
  assert.deepEqual(g.endpoints.map((e) => e.url), [relay(1).url, relay(2).url]);
  await assert.rejects(new RelayGateways([]).call("node_status"), /no relay to ask/);
  const listed = { relays: [{ endpoints: [relay(3), { url: "http://x", cert_sha256: null }] }, { endpoints: [] }] };
  assert.deepEqual(await relaysOf({ call: async () => listed }), [relay(3)]);
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

test("past the relays it knows, a gateway asks relay_list once and tries the relays it names", async () => {
  const asked = [];
  const followsNone = json({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "this node does not follow the account's shard" } });
  const answers = new Map([
    [relay(1).url, (method) => method === "relay_list"
      ? json({ jsonrpc: "2.0", id: 1, result: { relays: [{ endpoints: [relay(2), { ...relay(1), cert_sha256: "e".repeat(64) }] }] } })
      : followsNone],
    [relay(2).url, () => json({ jsonrpc: "2.0", id: 1, result: { from: 2 } })],
  ]);
  const request = async (endpoint, verb, path, headers, body) => {
    const method = JSON.parse(Buffer.from(body).toString()).method;
    asked.push(`${endpoint.url.slice(13, 14)}:${method}`);
    return answers.get(endpoint.url)(method);
  };
  const plain = new RelayGateways([relay(1)], request);
  await assert.rejects(plain.call("account_get", { address: "aa" }), /no relay answered.*does not follow/);
  assert.deepEqual(asked, ["1:account_get"], "without discover, the relays given only");
  asked.length = 0;
  const g = new RelayGateways([relay(1)], request, { discover: true });
  assert.deepEqual(await g.call("account_get", { address: "aa" }), { from: 2 });
  assert.deepEqual(asked, ["1:account_get", "1:relay_list", "2:account_get"], "the relay it names answers");
  assert.deepEqual(g.endpoints, [{ ...relay(1), cert_sha256: "e".repeat(64) }, relay(2)]);
  asked.length = 0;
  assert.deepEqual(await g.call("node_status"), { from: 2 }, "the one that answered");
  answers.set(relay(2).url, () => followsNone);
  asked.length = 0;
  await assert.rejects(g.call("account_get", { address: "bb" }), /no relay answered/);
  assert.deepEqual(asked, ["2:account_get", "1:account_get"], "relay_list is asked once only");
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

test("the network's public relays: the test network's for devnet, none known elsewhere", async () => {
  assert.equal(publicGateways("devnet").endpoints.length, 3);
  assert.throws(() => publicGateways("mainnet"), /no public relays are known for mainnet/);
  assert.throws(() => publicGateways("testnet"), /no public relays are known for testnet/);
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
  const dir = mkdtempSync(join(tmpdir(), "gateway-tls-"));
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
    await assert.rejects(wrong.call("node_status"), /certificate does not match the relay record/);
    assert.deepEqual(received, [], "nothing reaches a relay that shows another certificate");
    const pinned = new RelayGateways([{ url, cert_sha256: pin.toUpperCase() }]);
    assert.deepEqual(await pinned.call("node_status"), { network: "devnet" });
    assert.deepEqual(received, ["POST /rpc node_status"]);
    assert.deepEqual(new RelayGateways([{ url, cert_sha256: null }]).endpoints, [], "and never one without a pin");
  } finally {
    https.close();
  }
});
