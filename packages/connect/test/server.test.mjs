// `@saltix/connect/server`, the site's server in the server-held mode (Saltix 19-connect §15): an offer whose keys it
// keeps, the wallet's notice and reply, a grant checked in §15.2's order and taken once (`sid` spent), every refusal
// that spends nothing, the confirmation sealed for the page, the offers' life and bound, and the vectors' grants
// through this path byte for byte.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { accountId, encodeAddress, fromHex, toHex } from "@saltix/grain-server/web";
import {
  NodeUnreachable, b64url, checkConfirm, decodeConfirm, decodePayload, encodeGrant, encodeReply, encodeSeen, fromB64url, loginMessage, openLinkPayload,
  sealLinkPayload,
} from "../dist/index.js";
import { MAX_PAYLOAD_BYTES, OFFER_LIFE_MS, createServerConnect, makeServerKeys } from "../dist/server.js";

const GENESIS = "5a".repeat(32);
const ORIGIN = "https://shop.example";
const SECRET = new Uint8Array(32).fill(0x44);
const KEY = ed25519.getPublicKey(SECRET);
const ADDRESS = encodeAddress("devnet", accountId(KEY), 0);
const STATUS = { network: "devnet", genesis: GENESIS, accounts: { policy: { delay: 600, dispute_timeout: 3600 } } };
const REPLY_RELAY = new Uint8Array(32).fill(0x36);
const REPLY_SID = new Uint8Array(32).fill(0x55);
const REPLY_SECRET = new Uint8Array(32).fill(0x56);

/** A node the test plays: `over[method]` answers or throws in place of the plain account's empty log. */
function stubNode(over = {}) {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push(method);
      if (method in over) return over[method](params, calls);
      if (method === "node_status") return STATUS;
      if (method === "account_log") return { account: params.address, events: [] };
      throw new Error(method);
    },
  };
}

function site(over = {}) {
  const clock = { now: 1_700_000_000_000 };
  const events = [];
  const node = over.node ?? stubNode();
  const connect = createServerConnect({
    node, network: "devnet", genesis: GENESIS, origin: ORIGIN, name: "Example shop", retryMs: [0, 0], now: () => clock.now,
    telemetry: (event, meta) => events.push({ event, meta }), ...over.options,
  });
  return { connect, clock, events, node };
}

const keysOf = (offer) => ({ sid: fromB64url(offer.sid), boxKey: fromB64url(offer.boxKey), page: fromB64url(offer.page) });

/** KEY's account's grant for `offer` at `at`, `change` on its login, signed by `secret`. */
function grantFor(offer, at, change = {}, secret = SECRET) {
  const k = keysOf(offer);
  const login = { network: fromHex(GENESIS, 32), account: accountId(KEY), origin: offer.origin, sid: k.sid, page: k.page, at: BigInt(at), ...change };
  return encodeGrant({ version: 1, login, signer: { ed25519: toHex(KEY) }, signature: ed25519.sign(loginMessage(login), secret) });
}
const sealedTo = (offer, bytes) => {
  const k = keysOf(offer);
  return b64url(sealLinkPayload(k.boxKey, k.sid, k.page, bytes));
};
const forwarded = (offer, bytes) => ({ sid: offer.sid, payload: sealedTo(offer, bytes) });
const replyFor = (grant) => encodeReply({ relay: REPLY_RELAY, sid: REPLY_SID, key: x25519.getPublicKey(REPLY_SECRET), login: loginMessage(decodePayload(grant).grant.login) });

test("an offer hands the page nothing secret; the notice, the reply and the grant: connected once, then spent", async () => {
  const t = site();
  const offer = await t.connect.offer();
  assert.deepEqual(Object.keys(offer).sort(), ["boxKey", "name", "origin", "page", "sid"]);
  for (const k of ["sid", "boxKey", "page"]) assert.equal(fromB64url(offer[k])?.length, 32, k);
  assert.equal(offer.origin, ORIGIN);
  assert.equal(offer.name, "Example shop");
  assert.equal(t.connect.size, 1);
  assert.deepEqual(await t.connect.take(forwarded(offer, encodeSeen(1n))), { outcome: "seen" });
  const grant = grantFor(offer, t.clock.now);
  assert.deepEqual(await t.connect.take(forwarded(offer, replyFor(grant))), { outcome: "reply" });
  assert.equal(await t.connect.confirm(offer.sid), null, "no grant taken yet");
  const taken = await t.connect.take(forwarded(offer, grant));
  assert.equal(taken.outcome, "connected", JSON.stringify(taken));
  assert.deepEqual(Object.keys(taken.connection).sort(), ["account", "address", "managed", "network", "signer", "since"]);
  assert.equal(taken.connection.account, toHex(accountId(KEY)));
  assert.equal(taken.connection.address, ADDRESS);
  assert.equal(taken.connection.network, GENESIS);
  assert.equal(taken.connection.signer, "ed25519");
  assert.equal(taken.connection.managed, false);
  assert.equal(taken.connection.since, t.clock.now);
  assert.ok(!("grant" in taken.connection), "the login's bytes never leave the server");
  assert.deepEqual(t.node.calls, ["node_status", "account_log"], "the node's status is read with the log, for this grant");
  // The confirmation (§15.3): sealed to the reply's key, for the reply slot and this offer's P, naming the login taken.
  const c = taken.confirm;
  assert.equal(c.relay, b64url(REPLY_RELAY));
  assert.equal(c.sid, b64url(REPLY_SID));
  const plain = openLinkPayload(REPLY_SECRET, REPLY_SID, keysOf(offer).page, fromB64url(c.payload));
  assert.ok(plain, "sealed to the reply's key");
  const confirm = decodeConfirm(plain);
  assert.deepEqual(confirm.login, loginMessage(decodePayload(grant).grant.login));
  assert.equal(confirm.at, BigInt(t.clock.now));
  checkConfirm(confirm, confirm.login, t.clock.now);
  assert.equal(openLinkPayload(REPLY_SECRET, keysOf(offer).sid, keysOf(offer).page, fromB64url(c.payload)), null, "not for the page's own slot");
  // Sealed again for a server that answers in two steps; then the offer is spent, for a copy, a new grant, a notice.
  assert.ok(await t.connect.confirm(offer.sid));
  assert.deepEqual(await t.connect.take(forwarded(offer, grant)), { outcome: "refused", reason: "spent" });
  assert.deepEqual(await t.connect.take(forwarded(offer, grantFor(offer, t.clock.now))), { outcome: "refused", reason: "spent" });
  assert.deepEqual(await t.connect.take(forwarded(offer, encodeSeen(2n))), { outcome: "refused", reason: "spent" });
  assert.equal(t.connect.size, 1, "a spent offer is held until its time, so its slot stays spent");
  assert.deepEqual(
    t.events.filter((e) => e.event === "connect_server_take").map((e) => e.meta.outcome),
    ["seen", "reply", "connected", "refused", "refused", "refused"],
  );
  for (const { meta } of t.events) for (const v of Object.values(meta ?? {})) assert.ok(String(v).length < 20, `telemetry names no key, slot or account: ${v}`);
});

test("a login for another slot or key, a stale time, a wrong signature, another origin or network: refused, and the offer stays live", async () => {
  const t = site();
  const offer = await t.connect.offer();
  const other = await t.connect.offer();
  const at = t.clock.now;
  const cases = [
    ["slot", grantFor(offer, at, { sid: keysOf(other).sid })],
    ["page", grantFor(offer, at, { page: keysOf(other).page })],
    ["time", grantFor(offer, at - 10 * 60_000 - 1)],
    ["time", grantFor(offer, at + 10 * 60_000 + 1)],
    ["signature", grantFor(offer, at, {}, new Uint8Array(32).fill(0x45))],
    ["origin", grantFor(offer, at, { origin: "https://evil.example" })],
    ["network", grantFor(offer, at, { network: new Uint8Array(32).fill(0x66) })],
  ];
  for (const [reason, bytes] of cases) assert.deepEqual(await t.connect.take(forwarded(offer, bytes)), { outcome: "refused", reason }, reason);
  assert.deepEqual(t.node.calls, [], "nothing of a refused login reaches the node");
  // An offer the server never made; a payload sealed to another offer's keys, junk, one too long, a request that is
  // none, and a payload of a kind nobody knows: nobody's.
  assert.deepEqual(await t.connect.take({ sid: b64url(new Uint8Array(32).fill(9)), payload: sealedTo(offer, grantFor(offer, at)) }), { outcome: "refused", reason: "offer" });
  for (const payload of [sealedTo(other, grantFor(offer, at)), b64url(new Uint8Array(80)), b64url(new Uint8Array(MAX_PAYLOAD_BYTES + 1)), "", sealedTo(offer, new Uint8Array([7, 1, 2]))]) {
    assert.deepEqual(await t.connect.take({ sid: offer.sid, payload }), { outcome: "ignored" });
  }
  assert.deepEqual(await t.connect.take({ sid: "not base64!", payload: "AA" }), { outcome: "ignored" });
  assert.deepEqual(await t.connect.take({}), { outcome: "ignored" });
  assert.deepEqual(await t.connect.take(null), { outcome: "ignored" });
  // None of it spent the offer: the person it was shown to still signs in (§15.2 step 7).
  assert.equal((await t.connect.take(forwarded(offer, grantFor(offer, at)))).outcome, "connected");
  assert.deepEqual(t.node.calls, ["node_status", "account_log"]);
  // Ten minutes is within; the node on another chain refuses whatever its log says.
  const edge = await t.connect.offer();
  const stale = site({ node: stubNode({ node_status: () => ({ ...STATUS, genesis: "66".repeat(32) }) }) });
  const o2 = await stale.connect.offer();
  assert.deepEqual(await stale.connect.take(forwarded(o2, grantFor(o2, stale.clock.now))), { outcome: "refused", reason: "network" });
  assert.equal((await t.connect.take(forwarded(edge, grantFor(edge, at - 10 * 60_000)))).outcome, "connected");
});

test("a node that cannot answer leaves the grant unchecked, the site's own rule refuses, and neither spends the offer", async () => {
  let down = true;
  const node = stubNode({
    account_log: (params) => {
      if (down) throw new NodeUnreachable("account_log", "unreachable");
      return { account: params.address, events: [] };
    },
  });
  const t = site({ node });
  const offer = await t.connect.offer();
  const grant = grantFor(offer, t.clock.now);
  assert.deepEqual(await t.connect.take(forwarded(offer, grant)), { outcome: "unchecked", kind: "unreachable" });
  assert.equal(node.calls.filter((m) => m === "account_log").length, 3, "asked, and twice again");
  down = false;
  const admitted = [];
  const listed = (c) => {
    admitted.push(c.address);
    return "not_listed";
  };
  assert.deepEqual(await t.connect.take(forwarded(offer, grant), listed), { outcome: "refused", reason: "not_listed" });
  assert.deepEqual(admitted, [ADDRESS], "the site's rule sees the account's public facts");
  const taken = await t.connect.take(forwarded(offer, grant), async (c) => (c.managed ? "managed_only" : null));
  assert.equal(taken.outcome, "connected");
  assert.deepEqual(
    t.events.filter((e) => e.event === "connect_server_take").map((e) => [e.meta.outcome, e.meta.reason ?? e.meta.kind ?? ""]),
    [["unchecked", "unreachable"], ["refused", "not_listed"], ["connected", ""]],
  );
});

test("offers live 5 minutes and are bounded, the oldest dropped first; drop ends one early", async () => {
  const t = site({ options: { maxOffers: 3 } });
  const first = await t.connect.offer();
  t.clock.now += 1_000;
  const second = await t.connect.offer();
  t.clock.now += 1_000;
  const third = await t.connect.offer();
  assert.equal(t.connect.size, 3);
  t.clock.now += 1_000;
  await t.connect.offer();
  assert.equal(t.connect.size, 3);
  assert.deepEqual(await t.connect.take(forwarded(first, grantFor(first, t.clock.now))), { outcome: "refused", reason: "offer" }, "the oldest went");
  assert.equal((await t.connect.take(forwarded(second, grantFor(second, t.clock.now)))).outcome, "connected");
  assert.ok(t.events.some((e) => e.event === "connect_server_drop" && e.meta.bound === 1 && e.meta.expired === 0));
  // Past its life an offer is gone, keys and all, spent or not.
  t.clock.now += OFFER_LIFE_MS;
  assert.deepEqual(await t.connect.take(forwarded(third, grantFor(third, t.clock.now))), { outcome: "refused", reason: "offer" });
  assert.equal(await t.connect.confirm(second.sid), null);
  assert.equal(t.connect.size, 0);
  assert.ok(t.events.some((e) => e.event === "connect_server_drop" && e.meta.expired === 3));
  const fifth = await t.connect.offer();
  assert.equal(t.connect.drop(fifth.sid), true);
  assert.equal(t.connect.drop(fifth.sid), false);
  assert.equal(t.connect.drop("junk"), false);
  assert.equal(t.connect.size, 0);
  assert.deepEqual(await t.connect.take(forwarded(fifth, encodeSeen(1n))), { outcome: "refused", reason: "offer" });
});

test("an offer is live until 5 minutes after its making and gone at them, for the wallet's notice and the grant alike", async () => {
  assert.equal(OFFER_LIFE_MS, 5 * 60_000);
  const t = site();
  const offer = await t.connect.offer();
  t.clock.now += 5 * 60_000 - 1;
  assert.deepEqual(await t.connect.take(forwarded(offer, encodeSeen(1n))), { outcome: "seen" }, "a millisecond before");
  assert.equal((await t.connect.take(forwarded(offer, grantFor(offer, t.clock.now)))).outcome, "connected");
  const late = await t.connect.offer();
  t.clock.now += 5 * 60_000;
  assert.deepEqual(await t.connect.take(forwarded(late, encodeSeen(1n))), { outcome: "refused", reason: "offer" }, "at the mark");
  assert.deepEqual(await t.connect.take(forwarded(late, grantFor(late, t.clock.now))), { outcome: "refused", reason: "offer" });
  assert.equal(t.connect.size, 0, "its keys went with it");
});

test("two grants for one offer in flight: one session, the other spent", async () => {
  const waiting = [];
  const node = stubNode({ account_log: (params) => new Promise((resolve) => waiting.push(() => resolve({ account: params.address, events: [] }))) });
  const t = site({ node });
  const offer = await t.connect.offer();
  const a = t.connect.take(forwarded(offer, grantFor(offer, t.clock.now)));
  const b = t.connect.take(forwarded(offer, grantFor(offer, t.clock.now + 1)));
  for (let i = 0; i < 50 && waiting.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.equal(waiting.length, 2, "both grants are at the node");
  waiting[1]();
  waiting[0]();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.outcome, rb.outcome].sort(), ["connected", "refused"]);
  assert.equal((ra.outcome === "refused" ? ra : rb).reason, "spent");
});

test("what createServerConnect refuses at once, and keys it will not make an offer from", async () => {
  const base = { node: stubNode(), network: "devnet", genesis: GENESIS, origin: ORIGIN, name: "Shop" };
  assert.throws(() => createServerConnect({ ...base, origin: "https://Shop.example" }), /origin/);
  assert.throws(() => createServerConnect({ ...base, origin: "https://shop.example/" }), /origin/);
  assert.throws(() => createServerConnect({ ...base, name: "" }), /name/);
  assert.throws(() => createServerConnect({ ...base, name: "x".repeat(41) }), /name/);
  assert.throws(() => createServerConnect({ ...base, genesis: "5A".repeat(32) }), /genesis/);
  assert.throws(() => createServerConnect({ ...base, network: "mainnet2" }), /network/);
  assert.throws(() => createServerConnect({ ...base, maxOffers: 0 }), /maxOffers/);
  assert.doesNotThrow(() => createServerConnect(base));
  const short = createServerConnect({ ...base, keys: () => ({ sid: new Uint8Array(31), boxSecret: new Uint8Array(32), page: new Uint8Array(32) }) });
  await assert.rejects(short.offer(), /32 bytes/);
  const same = createServerConnect({ ...base, keys: () => ({ sid: new Uint8Array(32).fill(1), boxSecret: new Uint8Array(32).fill(2), page: new Uint8Array(32).fill(3) }) });
  await same.offer();
  await assert.rejects(same.offer(), /already/);
  // Fresh keys: 32 bytes each, different every time, P a public key of its own.
  const k1 = makeServerKeys();
  const k2 = makeServerKeys();
  for (const k of [k1, k2]) for (const f of ["sid", "boxSecret", "page"]) assert.equal(k[f].length, 32, f);
  assert.notDeepEqual(k1.sid, k2.sid);
  assert.notDeepEqual(k1.boxSecret, k2.boxSecret);
  assert.notDeepEqual(k1.page, k2.page);
});

// ── The vectors through the server's path ───────────────────────────────────

const v = JSON.parse(readFileSync(new URL("../../../vectors/connect-v1.json", import.meta.url), "utf8"));

test("vectors/connect-v1.json through the server's path: every grant taken for its address, every refused one for its reason, the reply confirmed", async () => {
  const s = v.session;
  const keys = () => ({ sid: fromHex(s.sid_hex, 32), boxSecret: fromHex(s.box_secret_hex, 32), page: fromHex(s.page_public_hex, 32) });
  const logEvents = (name) => (name === "none" ? [] : v.logs[name].map((e) => ({ event: e.event_hex })));
  const vectorSite = (log) =>
    createServerConnect({
      node: {
        call: async (method, params) =>
          method === "node_status"
            ? { network: "devnet", genesis: v.chain.genesis_hash_hex, accounts: { policy: v.chain.account_policy } }
            : { account: params.address, events: logEvents(log) },
      },
      network: "devnet", genesis: v.chain.genesis_hash_hex, origin: s.origin, name: s.name, now: () => Number(v.now), retryMs: [0, 0], keys,
    });
  assert.equal(v.grants.length, 6);
  for (const g of v.grants) {
    const site = vectorSite(g.log);
    const offer = await site.offer();
    assert.equal(offer.sid, b64url(fromHex(s.sid_hex)));
    assert.equal(offer.boxKey, b64url(fromHex(s.box_public_hex)));
    assert.equal(offer.page, b64url(fromHex(s.page_public_hex)));
    const taken = await site.take({ sid: offer.sid, payload: g.payload });
    assert.equal(taken.outcome, "connected", `${g.name}: ${JSON.stringify(taken)}`);
    assert.equal(taken.connection.address, g.address, g.name);
    assert.equal(taken.connection.signer, g.signer.ed25519 ? "ed25519" : "p256", g.name);
    assert.equal(taken.connection.managed, g.log !== "none", g.name);
  }
  assert.ok(v.refused_grants.length > 12);
  for (const r of v.refused_grants) {
    const site = vectorSite(r.log);
    const offer = await site.offer();
    const payload = b64url(sealLinkPayload(fromHex(s.box_public_hex, 32), fromHex(s.sid_hex, 32), fromHex(s.page_public_hex, 32), fromHex(r.grant_borsh_hex)));
    // What does not decode to a grant is nobody's (§15.1 step 4); a grant that decodes is refused for its reason.
    const expected = r.reason === "encoding" || r.reason === "version" ? { outcome: "ignored" } : { outcome: "refused", reason: r.reason };
    assert.deepEqual(await site.take({ sid: offer.sid, payload }), expected, r.name);
  }
  for (const r of v.refused_payloads) {
    const site = vectorSite("none");
    const offer = await site.offer();
    assert.deepEqual(await site.take({ sid: offer.sid, payload: r.payload }), { outcome: "ignored" }, r.name);
  }
  // The reply kept, the grant it names taken, the confirmation sealed to the reply's key for the page (§15.3).
  const named = v.grants.find((g) => g.name === v.reply.for_grant);
  const site = vectorSite(named.log);
  const offer = await site.offer();
  assert.deepEqual(await site.take({ sid: offer.sid, payload: v.reply.payload }), { outcome: "reply" });
  const taken = await site.take({ sid: offer.sid, payload: named.payload });
  assert.equal(taken.outcome, "connected");
  assert.equal(taken.confirm.relay, b64url(fromHex(v.reply.relay_public_hex)));
  assert.equal(taken.confirm.sid, b64url(fromHex(v.reply.sid_hex)));
  const plain = openLinkPayload(fromHex(v.reply.key_secret_hex, 32), fromHex(v.reply.sid_hex, 32), fromHex(s.page_public_hex, 32), fromB64url(taken.confirm.payload));
  assert.ok(plain, "opens for the wallet's key, its reply slot and the offer's P");
  const confirm = decodeConfirm(plain);
  assert.equal(toHex(confirm.login), v.confirm.login_hex);
  assert.equal(confirm.at, BigInt(v.now));
  checkConfirm(confirm, fromHex(v.reply.login_hex, 32), Number(v.now));
  // A reply for another login confirms nothing.
  const otherSite = vectorSite(named.log);
  const o2 = await otherSite.offer();
  const otherReply = encodeReply({ relay: fromHex(v.reply.relay_public_hex, 32), sid: fromHex(v.reply.sid_hex, 32), key: fromHex(v.reply.key_public_hex, 32), login: new Uint8Array(32).fill(9) });
  assert.deepEqual(await otherSite.take({ sid: o2.sid, payload: b64url(sealLinkPayload(fromHex(s.box_public_hex, 32), fromHex(s.sid_hex, 32), fromHex(s.page_public_hex, 32), otherReply)) }), { outcome: "reply" });
  assert.equal((await otherSite.take({ sid: o2.sid, payload: named.payload })).confirm, null);
});
