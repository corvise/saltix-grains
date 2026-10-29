// The server-held mode at the page (Saltix 19-connect §15): `createConnect({server})` end to end against a relay the
// test plays, with the real `@saltix/connect/server` behind a fetch the test routes and a node the test plays — the
// offer from the server, every payload forwarded sealed as it came, the session the server opened shown, the
// confirmation it sealed delivered on the slot; the session's state machine with a scripted courier; the slot kept
// across a reload without a secret; the wire `httpCourier` speaks; the dialog over it.
import test from "node:test";
import assert from "node:assert/strict";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { accountId, encodeAddress, fromHex, toHex } from "@saltix/grain-server/web";
import {
  ConnectFailed, ConnectSession, CourierError, DIALOG_CLASSES, KEPT_SLOT_KEY, b64url, createConnect, decodeConfirm, decodePayload, encodeGrant, encodeReply,
  encodeSeen, fromB64url, httpCourier, loginMessage, openConnectDialog, openLinkPayload, parseOffer, sealLinkPayload,
} from "../dist/index.js";
import { createServerConnect } from "../dist/server.js";
import { Clock, FakeDocument, FakeLink, MemoryStorage, RELAY_KEY, flush, opened } from "./helpers.mjs";

const GENESIS = "5a".repeat(32);
const ORIGIN = "https://shop.example";
const SECRET = new Uint8Array(32).fill(0x44);
const KEY = ed25519.getPublicKey(SECRET);
const ADDRESS = encodeAddress("devnet", accountId(KEY), 0);
const STATUS = { network: "devnet", genesis: GENESIS, accounts: { policy: { delay: 600, dispute_timeout: 3600 } } };
const REPLY_RELAY = new Uint8Array(32).fill(0x36);
const REPLY_SID = new Uint8Array(32).fill(0x55);
const REPLY_SECRET = new Uint8Array(32).fill(0x56);

const stubNode = () => ({
  call: async (method, params) => {
    if (method === "node_status") return STATUS;
    if (method === "account_log") return { account: params.address, events: [] };
    throw new Error(method);
  },
});

/** A relay that answers `link_open`, and the page's `link_deliver` with `link_delivered`. */
const answering = (f) => (f.type === "link_deliver" ? { type: "link_delivered", sid: f.sid, delivered: true } : opened(f));

/** KEY's account's grant for the parsed `offer` at `at`, with `change` on its login. */
function grantFor(offer, at, change = {}) {
  const login = { network: fromHex(GENESIS, 32), account: accountId(KEY), origin: offer.origin, sid: offer.sid, page: offer.page, at: BigInt(at), ...change };
  return encodeGrant({ version: 1, login, signer: { ed25519: toHex(KEY) }, signature: ed25519.sign(loginMessage(login), SECRET) });
}
const replyFor = (grant) => encodeReply({ relay: REPLY_RELAY, sid: REPLY_SID, key: x25519.getPublicKey(REPLY_SECRET), login: loginMessage(decodePayload(grant).grant.login) });
const sealedTo = (offer, bytes) => sealLinkPayload(offer.boxKey, offer.sid, offer.page, bytes);

/** The site's fetch: its two paths routed to the server library; `over` breaks it on purpose. */
function siteFetch(server, over = {}) {
  const requests = [];
  const fetcher = async (path, init) => {
    requests.push({ path, init });
    if (over.fail?.(path, requests.length)) throw new TypeError("fetch failed");
    const status = over.status?.(path, requests.length);
    if (status) return new Response("down", { status });
    const body = init.body ? JSON.parse(init.body) : {};
    let answer;
    if (path === "/connect/offer") answer = over.offer ? over.offer(await server.offer()) : await server.offer();
    else if (path === "/connect/login") {
      const taken = await server.take(body);
      answer = taken.outcome === "connected" ? { ...taken, next: "/me" } : taken;
      if (over.answer) answer = over.answer(answer);
    } else return new Response("not found", { status: 404 });
    return new Response(over.garble ? "{" : JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetcher, requests };
}

function setup(over = {}) {
  const server = createServerConnect({ node: stubNode(), network: "devnet", genesis: GENESIS, origin: ORIGIN, name: "Example shop", retryMs: [0, 0], ...over.server });
  const site = siteFetch(server, over.fetch);
  const links = [];
  const events = [];
  const seen = [];
  const connect = createConnect({
    network: "devnet",
    relays: ["/saltix/r/1/"],
    origin: ORIGIN,
    keep: over.keep ?? null,
    server: over.courier ?? { offer: "/connect/offer", login: "/connect/login", fetch: site.fetcher },
    dial: async () => {
      const link = new FakeLink(RELAY_KEY, "devnet", over.answer ?? answering);
      links.push(link);
      return link;
    },
    telemetry: (event, meta) => events.push({ event, meta }),
    ...over.options,
  });
  for (const e of ["offer", "seen", "checking", "connected", "refused", "failed", "disconnected"]) connect.on(e, (data) => seen.push([e, data]));
  return { connect, server, site, links, events, seen };
}

test("the page shows the server's offer, forwards what its slot receives sealed as it came, and shows the session the server opened", async () => {
  const t = setup();
  assert.equal(t.connect.connection, null);
  const offer = await t.connect.offer();
  const parsed = parseOffer(offer.text);
  assert.equal(parsed.origin, ORIGIN);
  assert.equal(parsed.name, "Example shop", "the offer's name is the server's");
  assert.equal(t.server.size, 1);
  assert.equal(t.site.requests[0].path, "/connect/offer");
  assert.equal(t.site.requests[0].init.method, "POST");
  assert.equal(t.site.requests[0].init.credentials, "same-origin", "the session's cookie is this origin's");
  assert.ok(offer.qr.path.length > 100);
  // The slot opened with the server's slot; the page's keys are the server's public ones and nothing else.
  const link = t.links[0];
  assert.deepEqual(link.sent[0], { type: "link_open", sid: b64url(parsed.sid) });
  const sealedSeen = sealedTo(parsed, encodeSeen(1n));
  link.deliver(sealedSeen, b64url(parsed.sid));
  await flush();
  assert.equal(t.connect.phase, "seen");
  const login = t.site.requests[1];
  assert.equal(login.path, "/connect/login");
  assert.deepEqual(JSON.parse(login.init.body), { sid: b64url(parsed.sid), payload: b64url(sealedSeen) }, "sealed as it came");
  assert.equal(t.seen.find(([e]) => e === "seen")[1].expiresAt, null);
  // The wallet's reply, then its grant: the page says it is checking only then, and shows what the server answered.
  const grant = grantFor(parsed, Date.now());
  link.deliver(sealedTo(parsed, replyFor(grant)), b64url(parsed.sid));
  await flush();
  assert.equal(t.connect.phase, "seen", "a reply is no check");
  link.deliver(sealedTo(parsed, grant), b64url(parsed.sid));
  await flush();
  assert.deepEqual(t.seen.map(([e]) => e), ["offer", "seen", "checking", "connected"]);
  const connected = t.seen.find(([e]) => e === "connected")[1];
  assert.equal(connected.address, ADDRESS);
  assert.equal(connected.account, toHex(accountId(KEY)));
  assert.equal(connected.signer, "ed25519");
  assert.equal(connected.managed, false);
  assert.ok(!("grant" in connected), "the page never sees the login's bytes");
  assert.deepEqual(connected.answer, { next: "/me" }, "what the site's server answered beside the account");
  assert.equal(t.connect.connection, null, "the session is the server's: nothing is kept in the page");
  assert.equal(t.connect.phase, "idle");
  // The confirmation the server sealed went out on the slot's own connection, to the wallet's reply slot (§15.3).
  const sent = link.sent.filter((f) => f.type === "link_deliver");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].relay, b64url(REPLY_RELAY));
  assert.equal(sent[0].sid, b64url(REPLY_SID));
  const plain = openLinkPayload(REPLY_SECRET, REPLY_SID, parsed.page, fromB64url(sent[0].payload));
  assert.ok(plain, "sealed to the reply's key, for the reply slot and this offer's P");
  assert.deepEqual(decodeConfirm(plain).login, loginMessage(decodePayload(grant).grant.login));
  assert.equal(link.closed, true);
  assert.equal(t.events.find((e) => e.event === "connect_confirm").meta.outcome, "delivered");
  assert.equal(t.site.requests.length, 4, "the offer, the notice, the reply, the grant: nothing polled");
  // The same login again, straight at the server: spent.
  assert.deepEqual(await t.server.take({ sid: b64url(parsed.sid), payload: b64url(sealedTo(parsed, grant)) }), { outcome: "refused", reason: "spent" });
  for (const { meta } of t.events) for (const value of Object.values(meta ?? {})) assert.ok(String(value).length < 20, `telemetry names no key, slot or account: ${value}`);
  t.connect.disconnect();
  assert.ok(!t.seen.some(([e]) => e === "disconnected"), "a server's session ends at the server, not here");
});

test("a grant the server refuses leaves the offer and says why; one it cannot check is unchecked; a copy is spent", async () => {
  const t = setup();
  const parsed = parseOffer((await t.connect.offer()).text);
  const link = t.links[0];
  link.deliver(sealedTo(parsed, encodeSeen(1n)), b64url(parsed.sid));
  await flush();
  link.deliver(sealedTo(parsed, grantFor(parsed, Date.now(), { origin: "https://evil.example" })), b64url(parsed.sid));
  await flush();
  link.deliver(sealedTo(parsed, grantFor(parsed, Date.now() - 11 * 60_000)), b64url(parsed.sid));
  await flush();
  assert.deepEqual(t.seen.filter(([e]) => e === "refused").map(([, d]) => d.reason), ["origin", "time"]);
  assert.equal(t.connect.phase, "seen", "the offer stays, at the wallet's notice");
  assert.equal(parseOffer((await t.connect.offer()).text).sid.toString(), parsed.sid.toString(), "the same offer");
  // The site's server down for one payload: unchecked, not refused.
  t.site.fetcher.down = true;
  const broken = setup({ fetch: { status: (path, n) => (path === "/connect/login" && n === 2 ? 500 : 0) } });
  const p2 = parseOffer((await broken.connect.offer()).text);
  broken.links[0].deliver(sealedTo(p2, grantFor(p2, Date.now())), b64url(p2.sid));
  await flush();
  assert.deepEqual(broken.seen.filter(([e]) => e === "refused").map(([, d]) => d.reason), ["unchecked"]);
  assert.equal(broken.events.find((e) => e.event === "connect_refused").meta.kind, "http");
  assert.equal(broken.connect.phase, "offer");
  // The server back: the grant delivered again connects (the offer was never spent).
  broken.links[0].deliver(sealedTo(p2, grantFor(p2, Date.now())), b64url(p2.sid));
  await flush();
  assert.equal(broken.seen.at(-1)[0], "connected");
  t.connect.cancel();
});

test("an offer for another origin, or under another name than the page's, fails the session; what createConnect refuses", async () => {
  const other = setup({ fetch: { offer: (o) => ({ ...o, origin: "https://other.example" }) } });
  await assert.rejects(other.connect.offer(), (e) => e instanceof ConnectFailed && e.reason === "server");
  assert.deepEqual(other.seen, [["failed", { reason: "server" }]]);
  assert.equal(other.events.find((e) => e.event === "connect_server_failed").meta.kind, "origin");
  assert.equal(other.links.length, 0, "no slot was opened for an offer that is not this page's");
  const named = setup({ options: { name: "Another name" } });
  await assert.rejects(named.connect.offer(), (e) => e.reason === "server");
  assert.equal(named.events.find((e) => e.event === "connect_server_failed").meta.kind, "name");
  const same = setup({ options: { name: "Example shop" } });
  assert.equal(parseOffer((await same.connect.offer()).text).name, "Example shop");
  same.connect.cancel();
  const down = setup({ fetch: { fail: () => true } });
  await assert.rejects(down.connect.offer(), (e) => e.reason === "server");
  assert.equal(down.events.find((e) => e.event === "connect_server_failed").meta.kind, "unreachable");
  const base = { network: "devnet", relays: [], origin: ORIGIN };
  assert.throws(() => createConnect(base), /node/);
  assert.throws(() => createConnect({ ...base, node: "http://127.0.0.1:1/" }), /name/);
  assert.doesNotThrow(() => createConnect({ ...base, server: { offer: "/o", login: "/l" } }));
  assert.throws(() => createConnect({ ...base, server: { offer: "/o", login: "/l" }, name: "" }), /name/);
});

// ── The session's state machine with a scripted courier ─────────────────────

function harness(opts = {}) {
  const clock = opts.clock ?? new Clock();
  const h = { clock, phases: [], links: [], refused: [], events: [], connected: [], offers: 0, takes: [] };
  const serverOffer = () => {
    const boxSecret = crypto.getRandomValues(new Uint8Array(32));
    return { sid: crypto.getRandomValues(new Uint8Array(32)), boxKey: x25519.getPublicKey(boxSecret), page: ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32))), origin: ORIGIN, name: "Example shop" };
  };
  h.courier = {
    offer: async () => {
      h.offers++;
      if (opts.offerFails) throw new CourierError(opts.offerFails);
      return serverOffer();
    },
    take: async (sid, payload) => {
      h.takes.push({ sid, payload });
      return opts.take(h.takes.length, sid, payload);
    },
  };
  h.session = new ConnectSession({
    relays: ["/saltix/r/1/"],
    networkKind: "devnet",
    origin: ORIGIN,
    dial: async () => {
      const link = new FakeLink(RELAY_KEY, "devnet", opts.answer ?? answering);
      h.links.push(link);
      return link;
    },
    courier: h.courier,
    connected: (v) => h.connected.push(v),
    events: {
      phase: (p) => h.phases.push(p),
      refused: (r) => h.refused.push(r.reason),
      reconnecting: () => {},
      telemetry: (event, meta) => h.events.push({ event, meta }),
    },
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => 0.999,
    visible: () => true,
    keep: opts.keep ?? null,
  });
  return h;
}
const kinds = (h) => h.phases.map((p) => p.kind);
const sidOf = (h) => {
  const p = h.phases.findLast((x) => x.kind === "offer" || x.kind === "seen");
  return b64url(parseOffer(p.text).sid);
};
async function started(h) {
  const run = h.session.start();
  await h.clock.advance(0);
  await run;
}
const CONNECTED = { kind: "connected", value: { address: ADDRESS }, confirm: null };

test("the server's word drives the phases: checking only for the grant, a refusal back to the notice, unchecked, then connected", async () => {
  const answers = [{ kind: "seen" }, { kind: "reply" }, { kind: "refused", reason: "not_listed" }, { kind: "unchecked", detail: "busy" }, { kind: "ignored" }, { kind: "seen" }, CONNECTED];
  const h = harness({ take: (n) => answers[n - 1] });
  await started(h);
  const sid = sidOf(h);
  const link = h.links[0];
  for (let i = 0; i < answers.length; i++) {
    link.deliver(new Uint8Array(60).fill(i + 1), sid);
    await h.clock.advance(0);
  }
  assert.deepEqual(kinds(h), ["opening", "offer", "seen", "checking", "seen", "checking", "seen", "checking", "seen", "checking", "seen", "checking", "connected"]);
  assert.deepEqual(h.refused, ["not_listed", "unchecked"]);
  assert.deepEqual(h.connected, [{ address: ADDRESS }]);
  assert.equal(h.takes.length, answers.length, "every payload went to the server, in order");
  assert.deepEqual(h.takes[0].payload, new Uint8Array(60).fill(1), "as it came");
  assert.ok(h.events.some((e) => e.event === "connect_refused" && e.meta.reason === "unchecked" && e.meta.kind === "busy"));
  assert.equal(link.closed, true);
  assert.equal(h.clock.timers.size, 0, "nothing runs after");
});

test("a server that holds no such offer makes the page ask for a fresh one; one that cannot be reached leaves the login unchecked", async () => {
  const h = harness({ take: (n) => (n === 1 ? { kind: "refused", reason: "offer" } : CONNECTED) });
  await started(h);
  const first = sidOf(h);
  h.links[0].deliver(new Uint8Array(60), first);
  await h.clock.advance(0);
  assert.deepEqual(h.refused, ["offer"]);
  assert.equal(h.offers, 2, "a fresh offer from the server");
  assert.notEqual(sidOf(h), first);
  assert.equal(h.links[0].closed, true);
  h.session.stop();
  const down = harness({ take: () => Promise.reject(new CourierError("timeout")) });
  await started(down);
  down.links[0].deliver(new Uint8Array(60), sidOf(down));
  await down.clock.advance(0);
  assert.deepEqual(down.refused, ["unchecked"]);
  assert.equal(down.events.find((e) => e.event === "connect_refused").meta.kind, "timeout");
  assert.equal(kinds(down).at(-1), "offer", "the offer stays: the person may be approved again");
  down.session.stop();
  const none = harness({ offerFails: "http", take: () => CONNECTED });
  await started(none);
  assert.deepEqual(kinds(none), ["opening", "failed"]);
  assert.deepEqual(none.phases.at(-1), { kind: "failed", reason: "server" });
  assert.equal(none.events.find((e) => e.event === "connect_server_failed").meta.kind, "http");
  assert.equal(none.links.length, 0);
});

test("the confirmation the server sealed is delivered as the page's own; without one the slot just closes", async () => {
  const confirm = { relay: REPLY_RELAY, sid: REPLY_SID, payload: new Uint8Array(70).fill(7) };
  const h = harness({ take: () => ({ ...CONNECTED, confirm }) });
  await started(h);
  h.links[0].deliver(new Uint8Array(60), sidOf(h));
  await h.clock.advance(0);
  const sent = h.links[0].sent.filter((f) => f.type === "link_deliver");
  assert.deepEqual(sent, [{ type: "link_deliver", relay: b64url(REPLY_RELAY), sid: b64url(REPLY_SID), payload: b64url(confirm.payload) }]);
  assert.equal(h.events.find((e) => e.event === "connect_confirm").meta.outcome, "delivered");
  assert.equal(h.links[0].closed, true);
  const plain = harness({ take: () => CONNECTED });
  await started(plain);
  plain.links[0].deliver(new Uint8Array(60), sidOf(plain));
  await plain.clock.advance(0);
  assert.equal(plain.links[0].sent.filter((f) => f.type === "link_deliver").length, 0);
  assert.equal(plain.events.find((e) => e.event === "connect_confirm").meta.outcome, "no_reply");
  assert.equal(plain.links[0].closed, true);
  assert.equal(plain.clock.timers.size, 0);
});

test("the slot kept across a reload holds no secret, is opened again without a new offer, and a slot of the other mode is not resumed", async () => {
  const keep = new MemoryStorage();
  const first = harness({ keep, take: () => CONNECTED });
  await started(first);
  const sid = sidOf(first);
  first.session.handOff();
  const kept = JSON.parse(keep.getItem(KEPT_SLOT_KEY));
  assert.equal(kept.sid, sid);
  assert.equal(kept.name, "Example shop");
  assert.ok(!("boxSecret" in kept) && !("pageKey" in kept), "nothing the server did not give the page (§15.1 step 1)");
  assert.equal(fromB64url(kept.boxKey).length, 32);
  first.links[0].drop();
  await first.clock.advance(3_000);
  const again = harness({ keep, clock: first.clock, take: () => CONNECTED });
  await again.session.start();
  await again.clock.advance(0);
  assert.equal(again.offers, 0, "the server still holds the offer: none asked for");
  assert.deepEqual(again.links[0].sent[0], { type: "link_open", sid });
  assert.equal(again.phases.at(-1).kind, "offer");
  assert.equal(parseOffer(again.phases.at(-1).text).name, "Example shop");
  assert.equal(again.events.find((e) => e.event === "connect_resumed")?.meta.held, true);
  again.links[0].deliver(new Uint8Array(60), sid);
  await again.clock.advance(0);
  assert.deepEqual(again.connected, [{ address: ADDRESS }]);
  assert.equal(keep.getItem(KEPT_SLOT_KEY), null, "forgotten once connected");
  // A page-mode slot (with Q's secret) in the store: a courier's session starts afresh.
  keep.setItem(KEPT_SLOT_KEY, JSON.stringify({ ...kept, boxSecret: b64url(new Uint8Array(32).fill(3)), opened: first.clock.now }));
  const mixed = harness({ keep, clock: first.clock, take: () => CONNECTED });
  await started(mixed);
  assert.equal(mixed.offers, 1);
  assert.notEqual(sidOf(mixed), sid);
  mixed.session.stop();
});

test("httpCourier speaks the site's JSON with the page's cookies, and an answer that is no answer is no word on any login", async () => {
  const seen = [];
  const answer = (body, status = 200) => async (path, init) => {
    seen.push({ path, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const offer = { sid: b64url(new Uint8Array(32).fill(1)), boxKey: b64url(new Uint8Array(32).fill(2)), page: b64url(new Uint8Array(32).fill(3)), origin: ORIGIN, name: "Shop" };
  const courier = (f, expect = { origin: ORIGIN }) => httpCourier({ offer: "/connect/offer", login: "/connect/login", fetch: f }, expect);
  const got = await courier(answer(offer)).offer();
  assert.deepEqual(got, { sid: new Uint8Array(32).fill(1), boxKey: new Uint8Array(32).fill(2), page: new Uint8Array(32).fill(3), origin: ORIGIN, name: "Shop" });
  assert.equal(seen[0].path, "/connect/offer");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.credentials, "same-origin");
  assert.equal(seen[0].init.cache, "no-store");
  assert.equal(seen[0].init.headers["content-type"], "application/json");
  const taken = await courier(answer({ outcome: "connected", connection: { network: GENESIS, account: "11".repeat(32), address: ADDRESS, signer: "p256", managed: true, since: 5 }, confirm: null, next: "/me" })).take(new Uint8Array(32).fill(1), new Uint8Array([9, 9]));
  assert.deepEqual(JSON.parse(seen[1].init.body), { sid: b64url(new Uint8Array(32).fill(1)), payload: b64url(new Uint8Array([9, 9])) });
  assert.deepEqual(taken, { kind: "connected", value: { network: GENESIS, account: "11".repeat(32), address: ADDRESS, signer: "p256", managed: true, since: 5, answer: { next: "/me" } }, confirm: null });
  const plain = await courier(answer({ outcome: "connected", connection: taken.value, confirm: { relay: b64url(REPLY_RELAY), sid: b64url(REPLY_SID), payload: "BwcH" } })).take(new Uint8Array(32), new Uint8Array(1));
  assert.ok(!("answer" in plain.value), "nothing beside the account: no answer field");
  assert.deepEqual(plain.confirm, { relay: REPLY_RELAY, sid: REPLY_SID, payload: new Uint8Array([7, 7, 7]) });
  for (const simple of ["ignored", "seen", "reply"]) assert.deepEqual(await courier(answer({ outcome: simple })).take(new Uint8Array(32), new Uint8Array(1)), { kind: simple });
  assert.deepEqual(await courier(answer({ outcome: "refused", reason: "spent" })).take(new Uint8Array(32), new Uint8Array(1)), { kind: "refused", reason: "spent" });
  assert.deepEqual(await courier(answer({ outcome: "unchecked", kind: "busy" })).take(new Uint8Array(32), new Uint8Array(1)), { kind: "unchecked", detail: "busy" });
  const kindOf = async (p) => {
    try {
      await p;
      return "taken";
    } catch (e) {
      assert.ok(e instanceof CourierError, String(e));
      return e.kind;
    }
  };
  assert.equal(await kindOf(courier(answer("{")).offer()), "bad_answer");
  assert.equal(await kindOf(courier(answer({ ...offer, sid: "AA" })).offer()), "bad_answer");
  assert.equal(await kindOf(courier(answer({ ...offer, origin: "https://other.example" })).offer()), "origin");
  assert.equal(await kindOf(courier(answer({ ...offer, name: "" })).offer()), "name");
  assert.equal(await kindOf(courier(answer(offer), { origin: ORIGIN, name: "Other" }).offer()), "name");
  assert.equal(await kindOf(courier(answer("down", 503)).offer()), "http");
  assert.equal(await kindOf(courier(async () => { throw new TypeError("fetch failed"); }).offer()), "unreachable");
  assert.equal(await kindOf(courier(answer({})).take(new Uint8Array(32), new Uint8Array(1))), "bad_answer");
  assert.equal(await kindOf(courier(answer({ outcome: "refused" })).take(new Uint8Array(32), new Uint8Array(1))), "bad_answer");
  assert.equal(await kindOf(courier(answer({ outcome: "connected", connection: { address: ADDRESS }, confirm: null })).take(new Uint8Array(32), new Uint8Array(1))), "bad_answer");
  assert.equal(await kindOf(courier(answer({ outcome: "connected", connection: taken.value, confirm: { relay: "AA", sid: "AA", payload: "AA" } })).take(new Uint8Array(32), new Uint8Array(1))), "bad_answer");
});

test("the dialog over the server-held mode: the code, the notice, and the session the server opened", async () => {
  const t = setup();
  const doc = new FakeDocument(false);
  const result = openConnectDialog(t.connect, { document: doc });
  await flush();
  const dialog = doc.body.children[0];
  const parsed = parseOffer((await t.connect.offer()).text);
  assert.ok(dialog.find(DIALOG_CLASSES.qr), "the server's offer as a QR code");
  const link = t.links[0];
  link.deliver(sealedTo(parsed, encodeSeen(1n)), b64url(parsed.sid));
  await flush();
  assert.match(dialog.find(DIALOG_CLASSES.status).textContent, /Continue in Saltix/);
  const grant = grantFor(parsed, Date.now());
  link.deliver(sealedTo(parsed, replyFor(grant)), b64url(parsed.sid));
  link.deliver(sealedTo(parsed, grant), b64url(parsed.sid));
  await flush();
  const connection = await result;
  assert.equal(connection.address, ADDRESS);
  assert.equal(doc.body.children.length, 0, "the dialog is gone: the page renders the session");
});
