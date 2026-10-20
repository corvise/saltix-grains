// A test network's gate (Saltix 33-gate) as the reference makes it, byte for byte: the grants, the tokens a client shows
// and their proofs, the redemption's proof, a code's id, and every token a relay refuses with the word it says
// (vectors/gate-v1.json); the relay client showing a grant where a relay requires one and only there; a relay's
// refusal and the end of access; the gateways' writes with a token; and the gate's interface with its refusals.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import {
  ACCESS_REASONS, ACCESS_SKEW_MS, ATTESTATION, AccessKey, GRANT_MAX_MS, MAX_ACCESS_TOKEN, AccessRefused, GateRefused, RelayClient, RelayGateways, UNATTESTED_MAX_MS,
  accessCodeId, accessProofMessage, accessToken, canonicalAccessCode, checkAccessToken, decodeAccessToken, decodeSignedAccessGrant,
  delegationMessage, encodeAccessGrant, encodeAccessToken, encodeSignedAccessGrant, fromBase64Url, fromHex, grantSigner,
  grantSigningMessage, helloGates, redeemComputerAccess, redeemMessage, statusGates, toBase64Url, toHex, usableGate, verifyEd25519,
} from "../dist/index.js";
import { createDevGate, createDevRelay } from "../dist/dev.js";

const v = JSON.parse(readFileSync(new URL("../../../vectors/gate-v1.json", import.meta.url), "utf8"));
const NETWORK = fromHex(v.network, 32);
const RELAY = fromHex(v.relay, 32);
const NOW = Number(v.now);
const gateSecret = fromHex(v.keys.gate_secret, 32);
const gateKey = fromHex(v.keys.gate, 32);
const phone = AccessKey.fromSecret(fromHex(v.keys.phone_secret, 32));
const at = (over = {}) => ({ gates: [gateKey], network: NETWORK, relay: RELAY, now: NOW, ...over });
const grantOfVector = (g) => ({
  version: g.fields.version, network: fromHex(g.fields.network, 32), key: fromHex(g.fields.key, 33), attestation: g.fields.attestation,
  boot: g.fields.boot, code: fromHex(g.fields.code, 4), issuedAt: Number(g.fields.issued_at), notAfter: Number(g.fields.not_after),
});
const signedOf = (name) => decodeSignedAccessGrant(fromHex(v.grants.find((g) => g.name === name).signed));

test("grants are the gate's bytes: Borsh, the message it signs and its signature", () => {
  assert.equal(toHex(phone.publicKey), v.keys.phone);
  assert.equal(toHex(ed25519.getPublicKey(gateSecret)), v.keys.gate);
  assert.ok(v.grants.length >= 4);
  for (const g of v.grants) {
    const grant = grantOfVector(g);
    assert.equal(toHex(encodeAccessGrant(grant)), g.borsh, g.name);
    assert.equal(toHex(grantSigningMessage(grant)), g.signing_message, g.name);
    // Ed25519 is deterministic: the gate's key signs the same bytes again.
    assert.equal(toHex(ed25519.sign(grantSigningMessage(grant), gateSecret)), g.signature, g.name);
    const signed = { grant, signature: fromHex(g.signature, 64) };
    assert.equal(toHex(encodeSignedAccessGrant(signed)), g.signed, g.name);
    assert.deepEqual(decodeSignedAccessGrant(fromHex(g.signed)), signed);
    assert.ok(verifyEd25519(gateKey, fromHex(g.signing_message, 32), signed.signature));
    assert.deepEqual(grantSigner(signed, [new Uint8Array(32).fill(1), gateKey]), gateKey, "a second gate beside the first");
    assert.equal(grantSigner({ ...signed, grant: { ...grant, notAfter: grant.notAfter + 1 } }, [gateKey]), null, "changed after signing");
  }
  assert.throws(() => decodeSignedAccessGrant(fromHex(v.grants[0].signed + "00")), /left over/);
  assert.throws(() => decodeSignedAccessGrant(fromHex(v.grants[0].signed.slice(0, -2))), /short/);
});

test("a computer's token is the reference's, its proof by the access key to one relay at one moment", () => {
  const own = v.tokens.find((t) => t.name === "own");
  const token = accessToken({ grant: signedOf("tee_day"), key: phone }, RELAY, Number(own.at));
  // RFC 6979 makes the reference's P-256 proof again, byte for byte.
  assert.equal(toHex(token), own.token);
  assert.equal(toBase64Url(token), own.base64url);
  const decoded = decodeAccessToken(token);
  assert.equal(toHex(accessProofMessage(decoded.access, decoded.relay, decoded.at)), own.proof_message);
  assert.equal(toHex(decoded.proof), own.proof);
  assert.equal(toHex(encodeAccessToken(decoded)), own.token);
  assert.deepEqual(checkAccessToken(token, at()), { admitted: { until: Number(v.admitted.own_until), attestation: ATTESTATION.tee, delegated: false } });
  // A grant of another key is never shown with this one.
  const stranger = AccessKey.fromSecret(new Uint8Array(32).fill(0x52));
  assert.throws(() => accessToken({ grant: signedOf("tee_day"), key: stranger }, RELAY, NOW), /another key/);
  // The secret never shows.
  assert.doesNotMatch(String(phone) + JSON.stringify(phone), new RegExp(v.keys.phone_secret));
});

test("a browser's delegated token reads and checks as the relay's (a server never makes one)", () => {
  const d = v.delegation;
  const delegated = v.tokens.find((t) => t.name === "delegated");
  const token = decodeAccessToken(fromHex(delegated.token));
  assert.ok("delegated" in token.access);
  assert.equal(toHex(token.access.delegated.device), d.device);
  assert.equal(token.access.delegated.notAfter, Number(d.not_after));
  assert.equal(toHex(delegationMessage(token.access.delegated.grant, token.access.delegated.device, token.access.delegated.notAfter)), d.signing_message);
  assert.equal(toHex(token.access.delegated.signature), d.signature);
  assert.equal(toHex(accessProofMessage(token.access, token.relay, token.at)), delegated.proof_message);
  assert.equal(toHex(encodeAccessToken(token)), delegated.token);
  assert.deepEqual(checkAccessToken(fromHex(delegated.token), at()), { admitted: { until: Number(v.admitted.delegated_until), attestation: ATTESTATION.tee, delegated: true } });
  // A delegation another phone signed, shown by the browser it names with a proof of its own: the delegation is refused.
  const browser = fromHex(v.keys.browser_secret, 32);
  const stranger = AccessKey.fromSecret(new Uint8Array(32).fill(0x51));
  const d0 = token.access.delegated;
  const forged = { ...d0, signature: stranger.sign(delegationMessage(d0.grant, d0.device, d0.notAfter)) };
  const access = { delegated: forged };
  const proof = ed25519.sign(accessProofMessage(access, RELAY, NOW), browser);
  assert.deepEqual(checkAccessToken(encodeAccessToken({ access, relay: RELAY, at: NOW, proof }), at()), { refused: "delegation" });
  // The same with the phone's own signature passes: the refusal was the signature's.
  const honest = { delegated: d0 };
  const proof2 = ed25519.sign(accessProofMessage(honest, RELAY, NOW), browser);
  assert.ok("admitted" in checkAccessToken(encodeAccessToken({ access: honest, relay: RELAY, at: NOW, proof: proof2 }), at()));
});

test("every token a relay refuses is refused with its word", () => {
  assert.ok(v.refused.length >= 10);
  for (const r of v.refused) {
    assert.deepEqual(checkAccessToken(fromHex(r.token), at()), { refused: r.access }, r.name);
    assert.ok(ACCESS_REASONS[r.access], `${r.access} has words`);
  }
  const own = fromHex(v.tokens.find((t) => t.name === "own").token);
  // What the vectors leave to the relay's own state: its gates, its clock, its size limit.
  assert.deepEqual(checkAccessToken(own, at({ gates: [] })), { refused: "gate" }, "a relay that trusts no gate takes nothing");
  assert.deepEqual(checkAccessToken(own, at({ now: NOW + 10 * 60_000 + 1 })), { refused: "time" });
  assert.deepEqual(checkAccessToken(own, at({ now: Number(v.admitted.own_until) })), { refused: "time" }, "the proof's moment first");
  assert.deepEqual(checkAccessToken(new Uint8Array(1025), at()), { refused: "malformed" });
  assert.deepEqual(checkAccessToken(own, at({ network: new Uint8Array(32) })), { refused: "network" });
});

test("the redemption's proof and a code's id are the reference's", () => {
  const message = redeemMessage(fromHex(v.redeem.challenge, 32), NETWORK, phone.publicKey);
  assert.equal(toHex(message), v.redeem.message);
  assert.equal(toHex(phone.sign(message)), v.redeem.signature);
  assert.deepEqual(canonicalAccessCode(v.code.typed), { code: v.code.canonical });
  assert.deepEqual(canonicalAccessCode(` ${v.code.typed.toLowerCase()} `), { code: v.code.canonical });
  assert.equal(toHex(accessCodeId(v.code.canonical)), v.code.id);
  assert.deepEqual(canonicalAccessCode("7K3QX-M9TA"), { problem: "length" });
  assert.deepEqual(canonicalAccessCode("7K3QX-M9TABC"), { problem: "length" });
  assert.deepEqual(canonicalAccessCode("7K3QO-M9TAB"), { problem: "letters" }, "O is never in a code: a 0 misread");
  assert.deepEqual(canonicalAccessCode("7K3QX-M9TU!"), { problem: "letters" });
  assert.equal(Number(v.limits.unattested_max_ms), UNATTESTED_MAX_MS);
  assert.equal(Number(v.limits.grant_max_ms), GRANT_MAX_MS);
  assert.equal(Number(v.limits.access_skew_ms), ACCESS_SKEW_MS);
  assert.equal(Number(v.limits.max_access_token), MAX_ACCESS_TOKEN);
});

test("hello and node_status name the gates, or nothing", () => {
  assert.deepEqual(helloGates({ gates: [toBase64Url(gateKey)] }, fromBase64Url), [gateKey]);
  assert.equal(helloGates(undefined, fromBase64Url), null);
  assert.deepEqual(helloGates({ gates: ["!", 5, toBase64Url(new Uint8Array(3))] }, fromBase64Url), []);
  assert.deepEqual(statusGates({ gates: [v.keys.gate] }), [gateKey]);
  assert.equal(statusGates(null), null);
  assert.equal(statusGates({ gates: [] }), null);
  assert.equal(statusGates(undefined), null);
});

const genesis = "5a".repeat(32);
const secret = (n) => new Uint8Array(32).fill(n);

/** A fresh credential the development gate gives for `code`. */
async function credentialFrom(gate, code) {
  return redeemComputerAccess({ gate: gate.url, code, genesis, gates: [gate.key] });
}

test("a key the registry does not name registers with its grant where the relay requires access, and without where none", async (t) => {
  const gate = await createDevGate({ genesis, codes: { "7K3QX-M9TAB": "1d" } });
  t.after(() => gate.close());
  const credential = await credentialFrom(gate, "7k3qx-m9tab");
  const gated = await createDevRelay({ access: { gates: [gate.key], genesis } });
  t.after(() => gated.close());
  const events = [];
  const client = await RelayClient.connect({ endpoints: [gated.endpoint()], secret: secret(0x61), network: "devnet", access: credential, timeoutMs: 5_000, log: (l, e, m) => events.push([e, m]) });
  t.after(() => client.close());
  const register = gated.sent.find((f) => f.type === "register");
  assert.equal(typeof register.access, "string", "the token rides with the record");
  const token = decodeAccessToken(fromBase64Url(register.access));
  assert.equal(toHex(token.relay), toHex(new Uint8Array(32).fill(9)), "made for this relay");
  assert.deepEqual(toHex(encodeSignedAccessGrant(token.access.own)), toHex(encodeSignedAccessGrant(credential.grant)));
  assert.ok(events.some(([e, m]) => e === "relay_access" && m.shown === true));
  assert.doesNotMatch(JSON.stringify(events), /[0-9a-f]{64}/, "no key in the log");

  // A relay that requires nothing gets no token.
  const open = await createDevRelay();
  t.after(() => open.close());
  const plain = await RelayClient.connect({ endpoints: [open.endpoint()], secret: secret(0x62), network: "devnet", access: credential, timeoutMs: 5_000 });
  t.after(() => plain.close());
  assert.equal(open.sent.find((f) => f.type === "register").access, undefined);
});

test("a registered server key registers without a grant, and a key that needs one and has none hears why", async (t) => {
  const gate = await createDevGate({ genesis, codes: {} });
  t.after(() => gate.close());
  const server = toHex(ed25519.getPublicKey(secret(0x63)));
  const relay = await createDevRelay({ access: { gates: [gate.key], genesis, exempt: (key) => key === server } });
  t.after(() => relay.close());
  const registered = await RelayClient.connect({ endpoints: [relay.endpoint()], secret: secret(0x63), network: "devnet", timeoutMs: 5_000 });
  t.after(() => registered.close());
  assert.equal(relay.sent.find((f) => f.type === "register").access, undefined, "a paired key shows nothing");

  // Not registered, no grant: the relay's word, at once, not a timeout.
  const started = Date.now();
  await assert.rejects(
    RelayClient.connect({ endpoints: [relay.endpoint()], secret: secret(0x64), network: "devnet", timeoutMs: 10_000 }),
    (e) => e instanceof AccessRefused && e.reason === "required" && /none was shown/.test(e.message),
  );
  assert.ok(Date.now() - started < 5_000, "refused within the round, not at the deadline");
});

test("a relay's refusal of a grant, and the end of access, reach the client as events", async (t) => {
  const gate = await createDevGate({ genesis, codes: { "7K3QX-M9TAB": "1d", "AAAAA-BBBBB": "1d" } });
  t.after(() => gate.close());
  const credential = await credentialFrom(gate, "7K3QX-M9TAB");
  // A relay of a network that changed its gate.
  const other = await createDevRelay({ access: { gates: [secret(0x77)], genesis } });
  t.after(() => other.close());
  await assert.rejects(
    RelayClient.connect({ endpoints: [other.endpoint()], secret: secret(0x65), network: "devnet", access: credential, timeoutMs: 10_000 }),
    (e) => e instanceof AccessRefused && e.reason === "gate",
  );
  // Another network's relay.
  const elsewhere = await createDevRelay({ access: { gates: [gate.key], genesis: "6b".repeat(32) } });
  t.after(() => elsewhere.close());
  const client = await RelayClient.connect({ endpoints: [elsewhere.endpoint()], secret: secret(0x66), network: "devnet", access: credential, timeoutMs: 10_000 })
    .catch((e) => e);
  assert.ok(client instanceof AccessRefused && client.reason === "network");

  // The access ends: access_ended, the connection closes, and the next registration is refused.
  const relay = await createDevRelay({ access: { gates: [gate.key], genesis } });
  t.after(() => relay.close());
  const live = await RelayClient.connect({ endpoints: [relay.endpoint()], secret: secret(0x67), network: "devnet", access: credential, timeoutMs: 5_000 });
  t.after(() => live.close());
  const ended = new Promise((resolve) => live.once("accessEnded", resolve));
  assert.equal(live.accessLost, null);
  relay.endAccess(live.address);
  await ended;
  assert.equal(live.accessLost?.reason, "expired", "kept for a reader that comes after the event");
  // The grant still holds here, so the client is let in again: the relay decides, never the client.
  const deadline = Date.now() + 8_000;
  while (relay.sent.filter((f) => f.type === "register").length < 2 || live.accessLost !== null) {
    if (Date.now() > deadline) throw new Error("the client did not register again after its access ended at the relay");
    await new Promise((r) => setTimeout(r, 50));
  }
  await live.ready();
});

test("a relay ends a connection's access by itself when its grant ends", async (t) => {
  const gate = await createDevGate({ genesis, codes: { "7K3QX-M9TAB": 1_500 } });
  t.after(() => gate.close());
  const credential = await credentialFrom(gate, "7K3QX-M9TAB");
  assert.ok(credential.grant.grant.notAfter - credential.grant.grant.issuedAt <= 1_500);
  const relay = await createDevRelay({ access: { gates: [gate.key], genesis } });
  t.after(() => relay.close());
  const client = await RelayClient.connect({ endpoints: [relay.endpoint()], secret: secret(0x68), network: "devnet", access: credential, timeoutMs: 5_000 });
  t.after(() => client.close());
  const reasons = [];
  client.on("accessRefused", (e) => reasons.push(e.reason));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no access_ended within 5 s of a grant of 1.5 s")), 5_000);
    client.once("accessEnded", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  // Reconnecting with the ended grant: the relay says expired.
  const deadline = Date.now() + 8_000;
  while (!reasons.includes("expired")) {
    if (Date.now() > deadline) throw new Error(`no "expired" refusal after the access ended (saw ${reasons.join(", ") || "none"})`);
    await new Promise((r) => setTimeout(r, 50));
  }
});

/** A relay's wallet interface over `request`: `relay_list` names the relay's key, writes need a token for it. */
function gatedGateway({ key, gates, requireToken = true }) {
  const seen = [];
  const request = async (endpoint, method, path, headers, body) => {
    const call = JSON.parse(new TextDecoder().decode(body));
    seen.push({ method: call.method, access: headers["x-saltix-access"] ?? null });
    const reply = (status, json) => ({ status, body: new TextEncoder().encode(JSON.stringify(json)) });
    if (call.method === "relay_list") return reply(200, { jsonrpc: "2.0", id: 1, result: { relays: [{ key: toHex(key), endpoints: [endpoint] }] } });
    if (call.method === "node_status") return reply(200, { jsonrpc: "2.0", id: 1, result: { network: "devnet", genesis, access: { gates: gates.map(toHex) } } });
    if (requireToken && (call.method === "faucet_request" || call.method === "transaction_submit")) {
      const token = headers["x-saltix-access"];
      const verdict = token ? checkAccessToken(fromBase64Url(token), { gates, network: fromHex(genesis, 32), relay: key, now: Date.now() }) : { refused: "required" };
      if ("refused" in verdict) return reply(401, { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "access", data: { access: verdict.refused } } });
    }
    return reply(200, { jsonrpc: "2.0", id: 1, result: { id: "ab".repeat(32) } });
  };
  return { request, seen };
}

test("a write through the gateways shows a token once a relay asks for one; reads never do", async (t) => {
  const gate = await createDevGate({ genesis, codes: { "7K3QX-M9TAB": "1d" } });
  t.after(() => gate.close());
  const key = secret(0x33);
  const { request, seen } = gatedGateway({ key, gates: [gate.key] });
  let asked = 0;
  const gateways = new RelayGateways([{ url: "wss://198.51.100.7:30335/", cert_sha256: "aa".repeat(32) }], request)
    .useAccess(async () => {
      asked++;
      return credentialFrom(gate, "7K3QX-M9TAB");
    });
  assert.equal((await gateways.call("node_status")).network, "devnet");
  // Two writes at once ask for one credential, and each is sent with a token for this relay.
  const [a, b] = await Promise.all([gateways.call("faucet_request", { address: "x" }), gateways.call("transaction_submit", { transaction: "00" })]);
  assert.deepEqual([a.id, b.id], ["ab".repeat(32), "ab".repeat(32)]);
  assert.equal(asked, 1, "one code for both");
  const writes = seen.filter((s) => s.method === "faucet_request" || s.method === "transaction_submit");
  assert.ok(writes.filter((s) => s.access !== null).length === 2, "each write went again with a token");
  const token = decodeAccessToken(fromBase64Url(writes.find((s) => s.access).access));
  assert.equal(toHex(token.relay), toHex(key), "made for the relay relay_list names at that endpoint");
  // A later write shows the kept credential at once.
  seen.length = 0;
  await gateways.call("faucet_request", { address: "y" });
  assert.equal(seen.filter((s) => s.method === "faucet_request").length, 1);
  assert.notEqual(seen.find((s) => s.method === "faucet_request").access, null);
  // Reads carry nothing, a credential kept or not.
  await gateways.call("node_status");
  await gateways.call("grain_get", { slug: "x" });
  assert.ok(seen.filter((s) => s.method === "node_status" || s.method === "grain_get").length >= 2);
  assert.ok(seen.every((s) => s.method === "faucet_request" || s.access === null), "reads carry nothing");
});

test("a write refused for its access is an AccessRefused, with a token or without a way to get one", async (t) => {
  const gate = await createDevGate({ genesis, codes: { "7K3QX-M9TAB": "1d" } });
  t.after(() => gate.close());
  const key = secret(0x34);
  // No credential to give: the relay's word, never "no relay answered".
  const bare = new RelayGateways([{ url: "wss://198.51.100.8:30335/", cert_sha256: "bb".repeat(32) }], gatedGateway({ key, gates: [gate.key] }).request);
  await assert.rejects(bare.call("faucet_request", { address: "x" }), (e) => e instanceof AccessRefused && e.reason === "required");
  // A grant the relay's gates did not sign.
  const strangers = await createDevGate({ genesis, codes: { "7K3QX-M9TAB": "1d" } });
  t.after(() => strangers.close());
  const wrong = new RelayGateways([{ url: "wss://198.51.100.9:30335/", cert_sha256: "cc".repeat(32) }], gatedGateway({ key, gates: [gate.key] }).request)
    .useAccess(() => redeemComputerAccess({ gate: strangers.url, code: "7K3QX-M9TAB", genesis, gates: [strangers.key] }));
  await assert.rejects(wrong.call("transaction_submit", { transaction: "00" }), (e) => e instanceof AccessRefused && e.reason === "gate");
  // A network that requires nothing never asks for the credential.
  let asked = 0;
  const open = new RelayGateways([{ url: "wss://198.51.100.10:30335/", cert_sha256: "dd".repeat(32) }], gatedGateway({ key, gates: [], requireToken: false }).request)
    .useAccess(async () => {
      asked++;
      throw new Error("never asked");
    });
  await open.call("faucet_request", { address: "x" });
  assert.equal(asked, 0);
});

test("the gate's interface: a computer's unattested grant, checked before it is taken, and every refusal in words", async (t) => {
  let refusal;
  const gate = await createDevGate({ genesis, codes: { "7K3QX-M9TAB": "7d", "AAAAA-BBBBB": "10m", "CCCCC-DDDDD": "1d" }, refuse: () => refusal });
  t.after(() => gate.close());
  const now = Date.now();
  const got = await credentialFrom(gate, "7K3QX-M9TAB");
  const g = got.grant.grant;
  assert.equal(g.attestation, ATTESTATION.none);
  assert.ok(g.notAfter - g.issuedAt <= UNATTESTED_MAX_MS && g.notAfter > now, "a day at most of a 7-day code");
  assert.equal(got.access, "7d");
  assert.equal(toHex(g.key), toHex(got.key.publicKey));
  const body = gate.redemptions.at(-1).body;
  assert.equal(body.unattested, "computer");
  assert.equal(body.code, "7K3QXM9TAB", "the canonical form");
  assert.equal(body.network, genesis);
  assert.equal(body.chain, undefined);
  assert.equal(fromBase64Url(body.key).length, 33);

  // Spent: the same code again is rejected.
  await assert.rejects(credentialFrom(gate, "7K3QX-M9TAB"), (e) => e instanceof GateRefused && e.error === "rejected" && /used already/.test(e.message));
  // A grant signed by a gate the relays do not trust is not taken (the gate spent the code all the same).
  await assert.rejects(redeemComputerAccess({ gate: gate.url, code: "CCCCC-DDDDD", genesis, gates: [secret(5)] }), (e) => e instanceof GateRefused && /do not trust/.test(e.message));
  // Each refusal, in words, with its wait.
  for (const [r, words] of [
    [{ status: 429, error: "rate_limited", retry_after: 30 }, /too many attempts.*try again in 30 s/],
    [{ status: 429, error: "locked", retry_after: 600 }, /wrong codes.*600 s/],
    [{ status: 403, error: "unattested_off" }, /no access to computers/],
    [{ status: 503, error: "unavailable" }, /right now/],
    [{ status: 500, error: "storage" }, /internal error/],
    [{ status: 400, error: "malformed", detail: "key" }, /could not read the request.*\(key\)$/],
    [{ status: 418, error: "teapot" }, /not one the SDK reads/],
  ]) {
    refusal = r;
    await assert.rejects(credentialFrom(gate, "AAAAA-BBBBB"), (e) => e instanceof GateRefused && words.test(e.message), r.error);
  }
  refusal = undefined;
  // A gate of another network.
  await assert.rejects(redeemComputerAccess({ gate: gate.url, code: "AAAAA-BBBBB", genesis: "6b".repeat(32), gates: [gate.key] }), (e) => e instanceof GateRefused && e.error === "network");
  // A gate that does not answer.
  const closed = await createDevGate({ genesis, codes: {} });
  await closed.close();
  await assert.rejects(redeemComputerAccess({ gate: closed.url, code: "AAAAA-BBBBB", genesis, gates: [gate.key] }), (e) => e instanceof GateRefused && e.error === "unreachable");
  // Only https, or http on this computer.
  assert.ok(usableGate("https://api.saltix.io") && usableGate("http://127.0.0.1:9") && !usableGate("http://api.saltix.io"));
  await assert.rejects(redeemComputerAccess({ gate: "http://api.saltix.io", code: "AAAAA-BBBBB", genesis, gates: [] }), /https/);
  // The code that was never spent still opens one grant.
  assert.ok((await credentialFrom(gate, "AAAAA-BBBBB")).grant.grant.notAfter - Date.now() <= 10 * 60_000);
});

test("a gate's grant for another key or another network is never taken", async () => {
  // A gate that answers with the vectors' grant, whatever key asked: not this computer's.
  const answer = (grant) => async (url) => {
    const body = String(url).endsWith("/challenge") ? { challenge: toBase64Url(new Uint8Array(32).fill(1)), expires_at: NOW } : { grant, access: "1d" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const other = toBase64Url(fromHex(v.grants.find((g) => g.name === "tee_day").signed));
  await assert.rejects(
    redeemComputerAccess({ gate: "https://gate.test", code: "7K3QX-M9TAB", genesis: v.network, gates: [gateKey], fetch: answer(other), now: () => NOW }),
    (e) => e instanceof GateRefused && /another key/.test(e.message),
  );
  // Signed for this key, but of another network than the one asked for.
  let made;
  const forKey = async (url, init) => {
    if (String(url).endsWith("/challenge")) return new Response(JSON.stringify({ challenge: toBase64Url(new Uint8Array(32).fill(1)) }), { status: 200 });
    const sent = JSON.parse(init.body);
    const grant = { ...grantOfVector(v.grants[3]), key: fromBase64Url(sent.key), network: new Uint8Array(32).fill(0x6b) };
    made = { grant, signature: ed25519.sign(grantSigningMessage(grant), gateSecret) };
    return new Response(JSON.stringify({ grant: toBase64Url(encodeSignedAccessGrant(made)), access: "1d" }), { status: 200 });
  };
  await assert.rejects(
    redeemComputerAccess({ gate: "https://gate.test", code: "7K3QX-M9TAB", genesis: v.network, gates: [gateKey], fetch: forKey, now: () => NOW }),
    (e) => e instanceof GateRefused && e.error === "network" && /another network/.test(e.message),
  );
  assert.ok(made, "the gate was asked");
  // And one that has ended.
  const ended = async (url, init) => {
    if (String(url).endsWith("/challenge")) return new Response(JSON.stringify({ challenge: toBase64Url(new Uint8Array(32).fill(1)) }), { status: 200 });
    const grant = { ...grantOfVector(v.grants[3]), key: fromBase64Url(JSON.parse(init.body).key) };
    return new Response(JSON.stringify({ grant: toBase64Url(encodeSignedAccessGrant({ grant, signature: ed25519.sign(grantSigningMessage(grant), gateSecret) })) }), { status: 200 });
  };
  await assert.rejects(
    redeemComputerAccess({ gate: "https://gate.test", code: "7K3QX-M9TAB", genesis: v.network, gates: [gateKey], fetch: ended, now: () => Number(v.grants[3].fields.not_after) }),
    (e) => e instanceof GateRefused && /ended/.test(e.message),
  );
  assert.ok((await redeemComputerAccess({ gate: "https://gate.test", code: "7K3QX-M9TAB", genesis: v.network, gates: [gateKey], fetch: ended, now: () => NOW })).grant);
});

test("a spent challenge is asked again once; a key the gate cannot prove is refused", async (t) => {
  let first = true;
  const gate = await createDevGate({
    genesis, codes: { "7K3QX-M9TAB": "1h" },
    refuse: () => (first ? ((first = false), { status: 400, error: "challenge" }) : undefined),
  });
  t.after(() => gate.close());
  const got = await credentialFrom(gate, "7K3QX-M9TAB");
  assert.equal(gate.redemptions.length, 2);
  assert.equal(got.grant.grant.attestation, 0);
  // The development gate checks the proof as the reference does: another key's is refused.
  const res = await fetch(`${gate.url}/v1/access/challenge`, { method: "POST", body: "{}" });
  const { challenge } = await res.json();
  const key = AccessKey.generate();
  const other = AccessKey.generate();
  const proof = other.sign(redeemMessage(fromBase64Url(challenge), fromHex(genesis, 32), key.publicKey));
  const answer = await fetch(`${gate.url}/v1/access/redeem`, {
    method: "POST",
    body: JSON.stringify({ code: "7K3QXM9TAB", network: genesis, challenge, key: toBase64Url(key.publicKey), proof: toBase64Url(proof), unattested: "computer" }),
  });
  assert.equal(answer.status, 400);
  assert.deepEqual(await answer.json(), { error: "malformed", detail: "proof" });
});
