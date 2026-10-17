// A Connect session against a relay the test drives (a port of the explorer's connect-session tests): slot, keep-alive,
// the wallet's notice, a grant taken or refused, expiry, hand-off, a dropped connection, failover, another network, stop.
import test from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { ConnectError, ConnectSession, KEEP_MS, QR_LIFE_MS, SLOT_LIFE_MS, b64url, encodeGrant, encodeSeen, fromB64url, loginMessage, parseOffer, sealLinkPayload } from "../dist/index.js";
import { toHex } from "@saltix/grain-server/web";
import { Clock, FakeLink, RELAY_KEY, keys, opened } from "./helpers.mjs";

const GENESIS = new Uint8Array(32).fill(0x5a);
const ORIGIN = "https://dex.example";
const ACCOUNT_SECRET = new Uint8Array(32).fill(0x44);

function grantFor(offer, at) {
  const login = { network: GENESIS, account: new Uint8Array(32), origin: offer.origin, sid: offer.sid, page: offer.page, at: BigInt(at) };
  const signer = { ed25519: toHex(ed25519.getPublicKey(ACCOUNT_SECRET)) };
  return { version: 1, login, signer, signature: ed25519.sign(loginMessage(login), ACCOUNT_SECRET) };
}

function harness(opts = {}) {
  const clock = new Clock();
  const h = { clock, phases: [], links: [], dials: [], refused: [], events: [], connected: [], reconnecting: [], verified: [], visible: { value: true }, keyCount: 0 };
  h.session = new ConnectSession({
    relays: opts.relays ?? ["/saltix/r/1/"],
    network: GENESIS,
    networkKind: "devnet",
    origin: ORIGIN,
    name: "Example DEX",
    dial: async (base) => {
      h.dials.push(base);
      if (opts.failDial?.(base)) throw new Error("unreachable");
      const link = new FakeLink(RELAY_KEY, opts.network ?? "devnet", (f) => (opts.answer ? opts.answer(base, f) : opened(f)));
      h.links.push(link);
      return link;
    },
    keys: async () => {
      h.keyCount++;
      return keys();
    },
    verify: async (g, _bytes, s) => {
      h.verified.push(s);
      if (opts.verify) return opts.verify(g, s);
      return `account ${"ed25519" in g.signer ? "ed25519" : "p256"}`;
    },
    connected: (v) => h.connected.push(v),
    events: {
      phase: (p) => h.phases.push(p),
      refused: (r) => h.refused.push(r.reason),
      reconnecting: (on) => h.reconnecting.push(on),
      telemetry: (event, meta) => h.events.push({ event, meta }),
    },
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    // The relays in their order.
    random: () => 0.999,
    visible: () => h.visible.value,
  });
  return h;
}

const last = (h) => h.phases[h.phases.length - 1];
const kinds = (h) => h.phases.map((p) => p.kind);
const named = (h, event) => h.events.some((e) => e.event === event);

function offerOf(h) {
  const p = last(h);
  assert.ok(p.kind === "offer" || p.kind === "seen", `no offer: ${p.kind}`);
  const offer = parseOffer(p.text);
  assert.equal(typeof offer, "object");
  return { offer, sid: b64url(offer.sid) };
}

async function started(h) {
  const run = h.session.start();
  await h.clock.advance(0);
  await run;
}

test("a slot is opened and offered with the relay's key, the page's origin and name", async () => {
  const h = harness();
  await started(h);
  assert.deepEqual(kinds(h), ["opening", "offer"]);
  const { offer, sid } = offerOf(h);
  assert.deepEqual(h.links[0].sent[0], { type: "link_open", sid });
  assert.deepEqual(offer.relay, RELAY_KEY);
  assert.equal(offer.origin, ORIGIN);
  assert.equal(offer.name, "Example DEX");
  assert.ok(last(h).link.startsWith("https://saltix.io/connect#saltix-connect:1:"));
  assert.ok(named(h, "connect_open"));
  // Telemetry names no key, slot or account.
  for (const { meta } of h.events) for (const value of Object.values(meta ?? {})) assert.ok(String(value).length < 20);
  h.session.stop();
});

test("the slot is kept open every minute, for 30 minutes at most", async () => {
  const h = harness();
  await started(h);
  const link = h.links[0];
  const { offer, sid } = offerOf(h);
  link.deliver(sealLinkPayload(offer.boxKey, offer.sid, offer.page, encodeSeen(1n)), sid);
  await h.clock.advance(KEEP_MS * 3 + 10);
  assert.equal(link.sent.filter((f) => f.type === "link_open").length, 4);
  await h.clock.advance(SLOT_LIFE_MS - KEEP_MS * 3);
  // At 30 minutes a new slot replaces it.
  assert.equal(h.keyCount, 2);
  assert.deepEqual(h.links[1].sent, [{ type: "link_open", sid: offerOf(h).sid }]);
  h.session.stop();
});

test("the phone's notice shows once, what does not open is ignored, and a good grant is taken", async () => {
  const h = harness();
  await started(h);
  const { offer, sid } = offerOf(h);
  const link = h.links[0];
  link.deliver(new Uint8Array(80), sid);
  link.deliver(sealLinkPayload(offer.boxKey, new Uint8Array(32), offer.page, encodeSeen(1n)), sid);
  link.deliver(sealLinkPayload(offer.boxKey, offer.sid, offer.page, encodeSeen(1n)), "another-slot");
  assert.equal(last(h).kind, "offer");
  link.deliver(sealLinkPayload(offer.boxKey, offer.sid, offer.page, encodeSeen(1n)), sid);
  link.deliver(sealLinkPayload(offer.boxKey, offer.sid, offer.page, encodeSeen(2n)), sid);
  assert.deepEqual(kinds(h), ["opening", "offer", "seen"]);
  link.deliver(sealLinkPayload(offer.boxKey, offer.sid, offer.page, encodeGrant(grantFor(offer, h.clock.now))), sid);
  await h.clock.advance(0);
  assert.deepEqual(kinds(h), ["opening", "offer", "seen", "checking", "connected"]);
  assert.equal(h.verified.length, 1);
  assert.deepEqual(h.verified[0].sid, offer.sid);
  assert.deepEqual(h.verified[0].page, offer.page);
  assert.equal(h.verified[0].origin, ORIGIN);
  assert.deepEqual(h.connected, ["account ed25519"]);
  assert.equal(link.closed, true);
  await h.clock.advance(SLOT_LIFE_MS * 2);
  assert.equal(h.keyCount, 1, "nothing runs after: no new slot");
  assert.equal(h.clock.timers.size, 0);
});

test("a refused grant says why and the offer stays; a node that could not check is no refusal of the grant", async () => {
  const h = harness({ verify: async () => { throw new ConnectError("not_a_device"); } });
  await started(h);
  const { offer, sid } = offerOf(h);
  h.links[0].deliver(sealLinkPayload(offer.boxKey, offer.sid, offer.page, encodeGrant(grantFor(offer, h.clock.now))), sid);
  await h.clock.advance(0);
  assert.deepEqual(h.refused, ["not_a_device"]);
  assert.deepEqual(kinds(h), ["opening", "offer", "checking", "offer"]);
  assert.deepEqual(h.connected, []);
  assert.ok(named(h, "connect_refused"));
  h.session.stop();
  const busy = harness({ verify: async () => { throw new Error("busy"); } });
  await started(busy);
  const o = offerOf(busy);
  busy.links[0].deliver(sealLinkPayload(o.offer.boxKey, o.offer.sid, o.offer.page, encodeGrant(grantFor(o.offer, busy.clock.now))), o.sid);
  await busy.clock.advance(0);
  assert.deepEqual(busy.refused, ["unchecked"]);
  busy.session.stop();
});

test("an unseen offer is replaced after two minutes, only while the page is in front", async () => {
  const h = harness();
  await started(h);
  const first = offerOf(h).sid;
  h.visible.value = false;
  await h.clock.advance(QR_LIFE_MS + 10);
  assert.equal(offerOf(h).sid, first);
  h.visible.value = true;
  await h.clock.advance(KEEP_MS + 10);
  assert.notEqual(offerOf(h).sid, first);
  assert.equal(h.links[0].closed, true);
  assert.ok(named(h, "connect_offer_expired"));
  h.session.stop();
});

test("an offer refused after its two minutes is replaced at once, not left for the slot's thirty", async () => {
  // The grant comes just before the mark and its check ends after it: the expiry that passed meanwhile is not lost.
  const pending = [];
  const refuse = () => pending.shift()(new ConnectError("not_a_device"));
  const h = harness({ verify: () => new Promise((_, fail) => pending.push(fail)) });
  await started(h);
  const { offer, sid } = offerOf(h);
  await h.clock.advance(QR_LIFE_MS - 1_000);
  h.links[0].deliver(sealLinkPayload(offer.boxKey, offer.sid, offer.page, encodeGrant(grantFor(offer, h.clock.now))), sid);
  await h.clock.advance(2_000);
  assert.equal(last(h).kind, "checking");
  refuse();
  await h.clock.advance(0);
  assert.deepEqual(h.refused, ["not_a_device"]);
  assert.notEqual(offerOf(h).sid, sid, "a new slot and new keys");
  assert.equal(h.keyCount, 2);
  assert.equal(h.links[0].closed, true);
  assert.ok(named(h, "connect_offer_expired"));

  // In the background the refused offer stays until the page is in front again, then goes.
  const second = offerOf(h);
  await h.clock.advance(QR_LIFE_MS - 1_000);
  h.links[1].deliver(sealLinkPayload(second.offer.boxKey, second.offer.sid, second.offer.page, encodeGrant(grantFor(second.offer, h.clock.now))), second.sid);
  await h.clock.advance(2_000);
  h.visible.value = false;
  refuse();
  await h.clock.advance(KEEP_MS * 2);
  assert.equal(offerOf(h).sid, second.sid);
  h.visible.value = true;
  await h.clock.advance(KEEP_MS + 10);
  assert.notEqual(offerOf(h).sid, second.sid);
  assert.equal(h.keyCount, 3);

  // A grant refused well within the two minutes leaves the offer to its own time.
  const third = offerOf(h);
  h.links[2].deliver(sealLinkPayload(third.offer.boxKey, third.offer.sid, third.offer.page, encodeGrant(grantFor(third.offer, h.clock.now))), third.sid);
  await h.clock.advance(1_000);
  refuse();
  await h.clock.advance(0);
  assert.equal(offerOf(h).sid, third.sid);
  await h.clock.advance(QR_LIFE_MS);
  assert.notEqual(offerOf(h).sid, third.sid);
  assert.equal(h.keyCount, 4);
  h.session.stop();
  assert.equal(h.clock.timers.size, 0);
});

test("an offer the visitor took to Saltix on this phone stays", async () => {
  const h = harness();
  await started(h);
  const first = offerOf(h).sid;
  h.session.handOff();
  await h.clock.advance(QR_LIFE_MS * 3);
  assert.equal(offerOf(h).sid, first);
  assert.ok(named(h, "connect_link_opened"));
  h.session.stop();
});

test("a dropped connection opens the same slot again at the same relay, and a grant is taken there", async () => {
  let up = true;
  const h = harness({ failDial: () => !up });
  await started(h);
  const { offer, sid } = offerOf(h);
  up = false;
  h.links[0].drop();
  assert.deepEqual(h.reconnecting, [true]);
  await h.clock.advance(3_100);
  assert.ok(h.dials.length > 2);
  up = true;
  h.session.wake();
  await h.clock.advance(0);
  assert.deepEqual(h.reconnecting, [true, false]);
  const again = h.links[h.links.length - 1];
  assert.deepEqual(again.sent[0], { type: "link_open", sid });
  assert.equal(offerOf(h).sid, sid);
  again.deliver(sealLinkPayload(offer.boxKey, offer.sid, offer.page, encodeGrant(grantFor(offer, h.clock.now))), sid);
  await h.clock.advance(0);
  assert.equal(h.connected.length, 1);
});

test("another relay answering at the path starts over", async () => {
  let relay = RELAY_KEY;
  const h = harness({ answer: (_b, f) => opened(f, relay) });
  await started(h);
  const first = offerOf(h).sid;
  relay = new Uint8Array(32).fill(0x36);
  h.links[0].drop();
  await h.clock.advance(0);
  assert.notEqual(offerOf(h).sid, first);
  assert.deepEqual(offerOf(h).offer.relay, relay);
  h.session.stop();
});

test("the next relay is tried when one refuses or names no key; none answering fails", async () => {
  const h = harness({
    relays: ["/r/a/", "/r/b/", "/r/c/"],
    answer: (base, f) => (base === "/r/a/" ? { type: "error", message: "busy", detail: "link_open" } : base === "/r/b/" ? opened(f, new Uint8Array(16)) : opened(f)),
  });
  await started(h);
  assert.deepEqual(h.dials, ["/r/a/", "/r/b/", "/r/c/"]);
  assert.equal(h.links[0].closed && h.links[1].closed, true);
  assert.equal(last(h).kind, "offer");
  h.session.stop();
  const none = harness({ relays: ["/r/a/", "/r/b/"], failDial: () => true });
  await started(none);
  assert.deepEqual(last(none), { kind: "failed", reason: "no_relay" });
  const silent = harness({ answer: () => null });
  const run = silent.session.start();
  await silent.clock.advance(10_100);
  await run;
  assert.deepEqual(last(silent), { kind: "failed", reason: "no_relay" });
  const empty = harness({ relays: [] });
  await started(empty);
  assert.deepEqual(last(empty), { kind: "failed", reason: "no_relay" });
});

test("a relay of another network is refused", async () => {
  const h = harness({ network: "mainnet" });
  await started(h);
  assert.deepEqual(last(h), { kind: "failed", reason: "network" });
  assert.equal(h.links[0].closed, true);
});

test("nothing runs after stop", async () => {
  const h = harness();
  await started(h);
  h.session.stop();
  const count = h.phases.length;
  await h.clock.advance(SLOT_LIFE_MS * 2);
  assert.equal(h.phases.length, count);
  assert.equal(h.links[0].closed, true);
  assert.equal(h.clock.timers.size, 0);
  const p = h.phases[1];
  assert.deepEqual(parseOffer(p.link), parseOffer(p.text));
  assert.equal(fromB64url(p.text.split(":")[5]).length, 32);
});
