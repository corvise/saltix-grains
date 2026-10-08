// A grain's sponsor as vectors/access-v1.json has it: the certificate for a user's key and the channel's transactions,
// byte for byte the node's; and what a wallet checks of a grant.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  fromHex, toHex, issueSponsorCert, decodeSponsorCert, sponsorCertMessage, sponsorCertProblem, signChannelTx, channelTxFee,
  grantFor, SERVICE, MIN_FEE_PER_BYTE,
} from "../dist/index.js";

const v = JSON.parse(readFileSync(new URL("../../../vectors/access-v1.json", import.meta.url), "utf8"));
const genesis = v.chain.genesis_hash_hex;
const payer = fromHex(v.keys.payer_private_hex, 32);

test("a sponsor's certificate is the node's", () => {
  const g = v.grant;
  const cert = { user_key: v.keys.device_public_hex, per_day: BigInt(g.per_day), services: g.services, issued: Number(g.issued), expires: Number(g.expires) };
  const hex = issueSponsorCert(payer, cert, genesis);
  assert.equal(hex, g.certificate_hex + g.signature_hex);
  const decoded = decodeSponsorCert(hex);
  assert.equal(decoded.cert.sponsor, v.keys.payer_public_hex);
  assert.equal(toHex(sponsorCertMessage(decoded.cert, genesis)), g.message_hex);
  assert.equal(sponsorCertProblem(hex, v.keys.payer_account_hex, genesis), null);
  assert.equal(sponsorCertProblem(hex, "00".repeat(32), genesis), "sponsor", "another grain's sponsor");
  assert.equal(sponsorCertProblem(hex, v.keys.payer_account_hex, "00".repeat(32)), "signature", "another network");
  assert.equal(sponsorCertProblem(issueSponsorCert(payer, { ...cert, services: SERVICE.turn }, genesis), v.keys.payer_account_hex, genesis), "services");
  assert.equal(sponsorCertProblem(hex.slice(0, -2), v.keys.payer_account_hex, genesis), "malformed");
  // A managed account's phone grants with its P-256 key (tag 1); a grain's sponsor grants with its own Ed25519 key.
  const phone = v.phone_grant.certificate_hex + v.phone_grant.signature_hex;
  assert.equal(sponsorCertProblem(phone, v.keys.payer_account_hex, genesis), "malformed");
  assert.throws(() => issueSponsorCert(payer, { ...cert, expires: cert.issued + 2_592_001 }, genesis), /30 days/);
});

test("the channel's transactions are the node's", () => {
  const calls = {
    "open-channel": (a) => ({ open: { exchange: a.exchange_hex, amount: BigInt(a.amount) } }),
    "top-up-channel": (a) => ({ topUp: { exchange: a.exchange_hex, amount: BigInt(a.amount) } }),
    "close-channel": (a) => ({ close: { exchange: a.exchange_hex } }),
  };
  for (const t of v.transactions.filter((t) => t.name in calls)) {
    const call = calls[t.name](t.action);
    const signed = signChannelTx(payer, { nonce: BigInt(t.nonce), fee: BigInt(t.fee), validUntilSlot: BigInt(t.valid_until_slot) }, call, genesis);
    assert.equal(signed.hex, t.signed_hex, t.name);
    assert.equal(signed.id, t.id_hex, t.name);
    assert.equal(channelTxFee(call), BigInt(t.signed_hex.length / 2) * MIN_FEE_PER_BYTE);
  }
});

test("a grant at login runs from the node's slot", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { slot: 5000, genesis, network: "testnet" } })));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const hex = await grantFor(`http://127.0.0.1:${server.address().port}`, payer, v.keys.device_public_hex, { perDay: 500_000n, days: 3 });
    const { cert } = decodeSponsorCert(hex);
    assert.deepEqual([cert.issued, cert.expires, cert.services, cert.per_day], [5000, 5000 + 3 * 86_400, SERVICE.messages, 500_000n]);
    assert.equal(sponsorCertProblem(hex, v.keys.payer_account_hex, genesis), null);
  } finally {
    server.close();
  }
});
