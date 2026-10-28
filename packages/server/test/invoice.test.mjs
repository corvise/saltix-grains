// Payments in an app made in Saltix (12-grains §5.2): the server's registered key signs invoices to the grain's owner
// only, sends them in a card, and finds their payments on chain through the same node or relays it reads the registry
// from. A certified key keeps any payee.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatServer, ChatKeyNotRegistered, card, decodeInvoice, invoiceProblem, memoText, unitsOf, encodeAddress, fromHex,
  paysAsset,
} from "../dist/index.js";
import { createDevRelay } from "../../../scripts/dev-relay.mjs";
import { chain, ownerKey, quiet, spec, serverKey, appKey, fakeChain, wallet, serverOn } from "./chat-helpers.mjs";

/** `fake`'s wallet interface, which also answers `account_history` with `history`. */
function withHistory(fake, history) {
  return {
    async call(method, params = {}) {
      if (method === "account_history") return { entries: history.filter((e) => e.address === params.address).map(({ address, ...e }) => e) };
      return fake.wallet.call(method, params);
    },
  };
}

async function studio(fake, history = []) {
  const relay = await createDevRelay();
  const events = [];
  const log = (level, event, meta) => events.push({ level, event, meta });
  const server = await ChatServer.start({ appKey: appKey(), spec: spec(), wallet: withHistory(fake, history), endpoints: [relay.endpoint()], log });
  return { relay, server, events, close: async () => { server.close(); await relay.close(); } };
}

test("amounts: base units, or a decimal string in whole units of the asset", () => {
  assert.equal(unitsOf("2.5", "SALT"), 2_500_000_000n);
  assert.equal(unitsOf("0.000000001", "SALT"), 1n);
  assert.equal(unitsOf("1.25", "WORK"), 1_250_000n);
  assert.equal(unitsOf(7n, "WORK"), 7n);
  for (const bad of ["0.0000000001", "-1", "1e3", "", " 1", "1."]) assert.throws(() => unitsOf(bad, "SALT"), /decimal/, bad);
  assert.throws(() => unitsOf("0.0000001", "WORK"), /decimal/);
});

test("a developer key's invoice pays the grain's owner, in a card the wallet takes", async () => {
  const fake = fakeChain();
  const owner = fake.state.grain.owner;
  const { relay, server, events, close } = await studio(fake);
  const user = await wallet(relay, 0x61, server.address, [serverKey]);
  server.command("key", async () => {
    const signed = server.invoice({ amount: "2.5", memo: "Premium, 1 month" });
    return card().text("Premium for a month").invoice(signed);
  });
  try {
    const signed = server.invoice({ amount: 1_000n, asset: "WORK", memo: "One key" });
    assert.equal(signed.invoice.to, owner, "the owner the registry names");
    assert.equal(signed.invoice.slug, "access");
    assert.equal(signed.payee, encodeAddress("devnet", fromHex(owner, 32)));
    assert.match(signed.invoice.reference, /^[0-9a-f]{32}$/);
    const record = fake.state.grain;
    assert.equal(invoiceProblem(signed.hex, "access", ownerKey, chain.genesis, Date.now(), record), null, "a wallet of today takes it");
    assert.equal(invoiceProblem(signed.hex, "access", ownerKey, chain.genesis, Date.now()), "signature", "Saltix 0.1.53 and older refuse it");
    assert.equal(invoiceProblem(signed.hex, "access", ownerKey, chain.genesis, Date.now(), { ...record, servers: [] }), "signature",
      "nor once the owner revoked the key");
    assert.equal(decodeInvoice(signed.hex).cert, null);
    assert.ok(signed.invoice.expires_at > Date.now() + 29 * 60_000 && signed.invoice.expires_at <= Date.now() + 30 * 60_000);
    assert.equal(server.invoice({ amount: 1n, reference: "ab".repeat(16), expiresInMs: 60_000 }).invoice.reference, "ab".repeat(16));

    // Anyone else as the payee is refused before anything is signed: a wallet would refuse it (payee).
    assert.throws(() => server.invoice({ amount: 1n, to: "77".repeat(32) }), /owner only/);
    assert.equal(server.invoice({ amount: 1n, to: owner }).invoice.to, owner, "the owner, named, is fine");
    assert.throws(() => server.invoice({ amount: 0n }), /positive/);
    assert.throws(() => server.invoice({ amount: "1.0000000001" }), /decimal/);
    assert.throws(() => server.invoice({ amount: 1n, memo: "a".repeat(201) }), /memo/);

    // In a chat card: the user's wallet checks the invoice against the registry before its sheet opens.
    const request = user.request("key", [["duration", { duration: 600 }], ["site", { choice: "web" }]]);
    await user.send(request);
    await user.until(() => user.answers(request.request.id).length === 1);
    const [answer] = user.answers(request.request.id);
    assert.equal(user.problem(answer), null);
    const block = answer.message.blocks.find((b) => "invoice" in b);
    const hex = block.invoice.invoice;
    assert.equal(invoiceProblem(hex, "access", ownerKey, chain.genesis, Date.now(), record), null);
    const { invoice } = decodeInvoice(hex);
    assert.equal(invoice.amount, 2_500_000_000n);
    assert.equal(memoText(invoice), `${invoice.reference} Premium, 1 month`);
    assert.ok(!JSON.stringify(events).includes("31".repeat(32)) && !JSON.stringify(events).includes("32".repeat(32)), "no secret in the log");
    assert.ok(events.some((e) => e.event === "invoice_signed" && e.meta.registered === true));
  } finally {
    user.client.close();
    await close();
  }
});

test("the payment is found by its reference, of the invoice's asset and at least its amount", async () => {
  const fake = fakeChain();
  const owner = fake.state.grain.owner;
  const history = [];
  const { server, close } = await studio(fake, history);
  try {
    const signed = server.invoice({ amount: "2", memo: "Premium" });
    assert.equal(await server.paymentOf(signed), null, "not paid yet");
    const entry = (over) => ({
      address: signed.payee, kind: "received", tx: "aa".repeat(32), from: "dsalt1payer", asset: "salt", amount: "2000000000",
      height: 10, confirmations: 3, memo: { text: memoText(signed.invoice) }, ...over,
    });
    history.push(entry({ amount: "1999999999" }));
    assert.equal(await server.paymentOf(signed), null, "short of the amount");
    history.splice(0, 1, entry({ asset: "work" }));
    assert.equal(await server.paymentOf(signed), null, "another asset");
    history.splice(0, 1, entry({ memo: { text: "ab".repeat(16) } }));
    assert.equal(await server.paymentOf(signed), null, "another reference");
    history.splice(0, 1, entry());
    const paid = await server.paymentOf(signed);
    assert.equal(paid.tx, "aa".repeat(32));
    assert.equal(paid.confirmations, 3);
    assert.deepEqual(await server.paymentOf(signed.invoice), paid, "the invoice alone does too");
    assert.equal(signed.payee, encodeAddress("devnet", fromHex(owner, 32)));
  } finally {
    await close();
  }
});

test("a WORK invoice is paid in WORK or in SALT of the same integer, as it is on chain from protocol version 4", async () => {
  // Saltix 35-work-on-layer-2 §3.4: no account holds WORK on chain, so a WORK invoice is paid from the payer's book or
  // in SALT of the same integer, and the payee's history shows SALT. Before, `paymentOf` never found it.
  assert.equal(paysAsset("WORK", "salt"), true);
  assert.equal(paysAsset("WORK", "work"), true);
  assert.equal(paysAsset("SALT", "salt"), true);
  assert.equal(paysAsset("SALT", "work"), false, "a SALT invoice is paid in SALT only");
  const fake = fakeChain();
  const history = [];
  const { server, close } = await studio(fake, history);
  try {
    const signed = server.invoice({ amount: "2", asset: "WORK", memo: "Premium" });
    assert.equal(signed.invoice.amount, 2_000_000n, "µWORK, which are SALT's base units");
    const entry = (over) => ({
      address: signed.payee, kind: "received", tx: "bb".repeat(32), from: "dsalt1payer", asset: "salt", amount: "2000000",
      height: 10, confirmations: 1, memo: { text: memoText(signed.invoice) }, ...over,
    });
    history.push(entry({ amount: "1999999" }));
    assert.equal(await server.paymentOf(signed), null, "short of the amount");
    history.splice(0, 1, entry({ memo: { text: "ab".repeat(16) } }));
    assert.equal(await server.paymentOf(signed), null, "another reference");
    history.splice(0, 1, entry());
    const paid = await server.paymentOf(signed);
    assert.equal(paid?.tx, "bb".repeat(32), "SALT of the same integer");
    assert.equal(paid.asset, "salt");
    history.splice(0, 1, entry({ asset: "work", tx: "cc".repeat(32) }));
    assert.equal((await server.paymentOf(signed))?.tx, "cc".repeat(32), "WORK itself, as before version 4");
  } finally {
    await close();
  }
});

test("a retired grain's server signs no invoice, and a certified key names its payee", async () => {
  const fake = fakeChain();
  const { server, close } = await studio(fake);
  try {
    fake.state.grain = { ...fake.state.grain, retired: 99, servers: [] };
    fake.block();
    assert.equal(await server.checkRegistry(), "retired");
    assert.throws(() => server.invoice({ amount: 1n }), ChatKeyNotRegistered);
  } finally {
    await close();
  }
  // A certified key without a node: it knows no owner, so it names the payee, and any payee is the owner's choice.
  const { server: certified, close: closeCertified } = await serverOn({ log: quiet });
  try {
    assert.throws(() => certified.invoice({ amount: 1n }), /to/);
    const signed = certified.invoice({ amount: 1n, to: "77".repeat(32) });
    assert.notEqual(decodeInvoice(signed.hex).cert, null, "with its certificate");
    assert.equal(invoiceProblem(signed.hex, "access", ownerKey, chain.genesis, Date.now()), null);
    await assert.rejects(() => certified.paymentOf(signed), /no node/);
  } finally {
    await closeCertified();
  }
});
