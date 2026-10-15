// How a server reaches its network with a developer key alone: the relays' gateways over their pinned certificates,
// passed over when they fail or do not follow the account's shard, and a view of the chain cached per tip.
import test from "node:test";
import assert from "node:assert/strict";
import { RelayGateways, PUBLIC_RELAYS, ChainView, RpcError, relaysOf, usableEndpoint } from "../dist/index.js";

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
