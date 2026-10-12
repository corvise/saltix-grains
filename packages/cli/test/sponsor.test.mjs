// grain sponsor: the sponsor's channel through a node, refused here whenever the node would refuse it.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fromHex, toHex, accountId } from "@saltix/grain-server";
import { ed25519 } from "@noble/curves/ed25519";
import { channel, parseWork, sponsorStatus } from "../dist/sponsor.js";

const secret = fromHex("62".repeat(32), 32);
const me = toHex(accountId(ed25519.getPublicKey(secret)));
const city = "e1".repeat(32);

async function node(state) {
  const submitted = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      const result = {
        node_status: { genesis: "5a".repeat(32), slot: 1000, network: "devnet" },
        account_get: { nonce: 2, salt: state.salt ?? "1000000", work: state.work ?? "50000000", channels: state.channels ?? [] },
        exchange_list: { exchanges: state.exchanges ?? [{ city, operator: "aa".repeat(32), fee_bp: 50, bond: "1", closed: null, reachable: true }] },
        transaction_submit: { id: "cd".repeat(32) },
      }[method];
      if (method === "account_get") assert.equal(params.address, me);
      if (method === "transaction_submit") submitted.push(params.transaction);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, submitted, close: () => server.close() };
}
const s = (url) => ({ node: url, validFor: 600 });
// After sender (32), nonce, fee and valid_until_slot (8 each): the action's tag, then the exchange.
// Transaction v3: the sender's tag and key (33), nonce, fee, last slot (24), then the action's tag and exchange.
const action = (hex) => [fromHex(hex)[57], toHex(fromHex(hex).slice(58, 90))];

test("amounts of WORK are exact", () => {
  assert.equal(parseWork("2.5"), 2_500_000n);
  assert.equal(parseWork("10"), 10_000_000n);
  assert.equal(parseWork("0.000001"), 1n);
  for (const bad of ["0", "1.0000001", "-1", "1e3", "abc"]) assert.throws(() => parseWork(bad), bad);
});

test("a channel opens with a listed exchange, from what the account has", async () => {
  const ok = await node({});
  assert.equal((await sponsorStatus(ok.url, secret)).account, me);
  await channel({ open: { exchange: city, amount: 10_000_000n } }, secret, s(ok.url));
  assert.deepEqual(action(ok.submitted[0]), [2, city]);
  ok.close();

  const refusals = [
    [{ exchanges: [] }, { open: { exchange: city, amount: 1n } }, /no open exchange/],
    [{ work: "5" }, { open: { exchange: city, amount: 10n } }, /needs 10/],
    [{ salt: "0" }, { open: { exchange: city, amount: 1n } }, /fee/],
    [{ channels: [{ exchange: city, deposit: "1", closing_at: null }] }, { open: { exchange: city, amount: 1n } }, /open already/],
    [{ channels: [{ exchange: "01".repeat(32), deposit: "1", closing_at: null }, { exchange: "02".repeat(32), deposit: "1", closing_at: null }] },
      { open: { exchange: city, amount: 1n } }, /2 channels/],
    [{}, { topUp: { exchange: city, amount: 1n } }, /no open channel/],
    [{ channels: [{ exchange: city, deposit: "1", closing_at: 900 }] }, { close: { exchange: city } }, /no open channel/],
  ];
  for (const [state, call, why] of refusals) {
    const n = await node(state);
    await assert.rejects(channel(call, secret, s(n.url)), why);
    assert.equal(n.submitted.length, 0, `nothing submitted: ${why}`);
    n.close();
  }
  const open = await node({ channels: [{ exchange: city, deposit: "1", closing_at: null }] });
  await channel({ topUp: { exchange: city, amount: 1n } }, secret, s(open.url));
  await channel({ close: { exchange: city } }, secret, s(open.url));
  assert.deepEqual(open.submitted.map((t) => action(t)[0]), [3, 4]);
  open.close();
});
