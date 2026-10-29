// `createConnect` end to end against a relay and a node the test plays: an offer with its QR code, the wallet's notice,
// a grant checked against the node's key event log and kept for 30 days, a refusal, disconnecting, and every way it
// fails before an offer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, decodeAddress, toHex } from "@saltix/grain-server/web";
import {
  CONNECT_LIFE_MS, ConnectFailed, STORAGE_KEY, createConnect, encodeGrant, encodeSeen, loadConnection, loginMessage, parseOffer, sealLinkPayload,
  b64url,
} from "../dist/index.js";
import { FakeLink, MemoryStorage, RELAY_KEY, flush, keys, opened } from "./helpers.mjs";

const GENESIS = "5a".repeat(32);
const ORIGIN = "https://dex.example";
const SECRET = new Uint8Array(32).fill(0x44);
const KEY = ed25519.getPublicKey(SECRET);

function setup(over = {}) {
  const links = [];
  const calls = [];
  const storage = over.storage ?? new MemoryStorage();
  const node = over.node ?? {
    call: async (method, params) => {
      calls.push(method);
      if (method === "node_status") return { network: "devnet", genesis: GENESIS, accounts: { policy: { delay: 600, dispute_timeout: 3600 } } };
      if (method === "account_log") return { account: params.address, events: [] };
      throw new Error(method);
    },
  };
  const events = [];
  const connect = createConnect({
    network: "devnet",
    relays: ["/saltix/r/1/"],
    node,
    name: "Example DEX",
    origin: ORIGIN,
    storage,
    keys,
    dial: async () => {
      const link = new FakeLink(RELAY_KEY, "devnet", opened);
      links.push(link);
      return link;
    },
    telemetry: (event) => events.push(event),
    ...over.options,
  });
  const seen = [];
  for (const e of ["offer", "seen", "checking", "connected", "refused", "failed", "disconnected"]) connect.on(e, (data) => seen.push([e, data]));
  return { connect, links, calls, storage, events, seen };
}

function grant(offer, change = {}) {
  const login = { network: Uint8Array.from(Buffer.from(GENESIS, "hex")), account: accountId(KEY), origin: offer.origin, sid: offer.sid, page: offer.page, at: BigInt(Date.now()), ...change };
  return encodeGrant({ version: 1, login, signer: { ed25519: toHex(KEY) }, signature: ed25519.sign(loginMessage(login), SECRET) });
}

const deliver = (t, bytes) => {
  const offer = parseOffer(t.lastOffer.text);
  t.links.at(-1).deliver(sealLinkPayload(offer.boxKey, offer.sid, offer.page, bytes), b64url(offer.sid));
};

test("an offer, the wallet's notice and a grant: connected, kept, restored, disconnected", async () => {
  const t = setup();
  assert.equal(t.connect.phase, "idle");
  assert.equal(t.connect.connection, null);
  const offer = await t.connect.offer();
  t.lastOffer = offer;
  assert.equal(t.connect.phase, "offer");
  const parsed = parseOffer(offer.text);
  assert.equal(parsed.origin, ORIGIN);
  assert.equal(parsed.name, "Example DEX");
  assert.equal(offer.link, `https://saltix.io/connect#${offer.text}`);
  assert.match(offer.qr.svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"[^>]*>.*<path d="M/);
  assert.ok(offer.qr.size > 25 && offer.qr.path.length > 100);
  assert.ok(offer.expiresAt > Date.now());
  assert.equal(await t.connect.offer(), offer, "the current offer while the session runs");

  deliver(t, encodeSeen(1n));
  assert.equal(t.connect.phase, "seen");
  assert.equal(t.seen.find(([e]) => e === "seen")[1].expiresAt, null);

  deliver(t, grant(parsed));
  await flush();
  const connected = t.seen.find(([e]) => e === "connected")?.[1];
  assert.ok(connected, JSON.stringify(t.seen.map(([e, d]) => [e, d.reason])));
  assert.equal(connected.account, toHex(accountId(KEY)));
  assert.deepEqual(decodeAddress(connected.address), { network: "devnet", kind: 0, id: accountId(KEY) });
  assert.equal(connected.signer, "ed25519");
  assert.equal(connected.managed, false);
  assert.equal(connected.network, GENESIS);
  assert.deepEqual(t.connect.connection, connected);
  assert.equal(t.connect.phase, "idle");
  assert.ok(t.calls.includes("account_log"), "the key event log was read");
  assert.equal(t.links[0].closed, true);

  // Another page of the site, or a reload: the connection is there.
  const again = setup({ storage: t.storage });
  assert.deepEqual(again.connect.connection, connected);
  again.connect.disconnect();
  assert.equal(again.connect.connection, null);
  assert.equal(t.storage.getItem(STORAGE_KEY), null);
  assert.deepEqual(again.seen, [["disconnected", {}]]);
  assert.ok(!again.events.some((e) => /[0-9a-f]{16}/.test(e)), "telemetry names no account");
});

test("a grant for another origin or out of time is refused and the offer stays", async () => {
  const t = setup();
  t.lastOffer = await t.connect.offer();
  const parsed = parseOffer(t.lastOffer.text);
  deliver(t, grant(parsed, { origin: "https://evil.example" }));
  await flush();
  deliver(t, grant(parsed, { at: BigInt(Date.now() - 11 * 60_000) }));
  await flush();
  assert.deepEqual(t.seen.filter(([e]) => e === "refused").map(([, d]) => d.reason), ["origin", "time"]);
  assert.equal(t.connect.phase, "offer");
  assert.equal(t.connect.connection, null);
  t.connect.cancel();
  assert.equal(t.connect.phase, "idle");
});

test("a node that cannot check the login leaves it unchecked, not refused", async () => {
  const t = setup({
    node: {
      call: async (method) => {
        if (method === "node_status") return { network: "devnet", genesis: GENESIS, accounts: { policy: { delay: 600, dispute_timeout: 3600 } } };
        throw new Error("the node answers no account_log");
      },
    },
  });
  t.lastOffer = await t.connect.offer();
  deliver(t, grant(parseOffer(t.lastOffer.text)));
  await flush();
  assert.deepEqual(t.seen.filter(([e]) => e === "refused").map(([, d]) => d.reason), ["unchecked"]);
  t.connect.cancel();
});

test("no offer from a node of another network, another genesis, or none answering; cancel says so", async () => {
  const status = (s) => ({ call: async () => s });
  const fails = async (t, reason) => {
    await assert.rejects(t.connect.offer(), (e) => e instanceof ConnectFailed && e.reason === reason);
    assert.deepEqual(t.seen.filter(([e]) => e === "failed").map(([, d]) => d.reason), [reason]);
  };
  await fails(setup({ node: status({ network: "mainnet", genesis: GENESIS }) }), "network");
  await fails(setup({ node: status({ network: "devnet", genesis: GENESIS }), options: { genesis: "66".repeat(32) } }), "network");
  await fails(setup({ node: { call: async () => { throw new Error("down"); } } }), "node");
  const t = setup();
  const pending = t.connect.offer();
  t.connect.cancel();
  await assert.rejects(pending, (e) => e.reason === "cancelled");
});

test("what a page passes is checked at once", () => {
  const base = { network: "devnet", relays: [], node: "http://127.0.0.1:1/", storage: null };
  assert.throws(() => createConnect({ ...base, name: "Example", origin: "https://Dex.example" }), /origin/);
  assert.throws(() => createConnect({ ...base, name: "Example", origin: "https://dex.example/path" }), /origin/);
  assert.throws(() => createConnect({ ...base, name: "", origin: ORIGIN }), /name/);
  assert.throws(() => createConnect({ ...base, name: "Ex‮ample", origin: ORIGIN }), /name/);
  assert.throws(() => createConnect({ ...base, name: "x".repeat(41), origin: ORIGIN }), /name/);
  assert.throws(() => createConnect({ ...base, name: "Example", origin: ORIGIN, genesis: "XY" }), /genesis/);
  assert.doesNotThrow(() => createConnect({ ...base, name: "Example DEX", origin: "http://localhost:5173" }));
});

test("the page's code life reaches its offers: expiresAt is that far ahead, 2 minutes without one", async () => {
  for (const [options, life] of [[{ qrLifeMs: 45_000 }, 45_000], [{}, 2 * 60_000]]) {
    const t = setup({ options });
    const before = Date.now();
    const offer = await t.connect.offer();
    assert.ok(offer.expiresAt >= before + life && offer.expiresAt <= Date.now() + life, `${offer.expiresAt - before} for ${life}`);
    t.connect.cancel();
  }
  const base = { network: "devnet", relays: [], node: "http://127.0.0.1:1/", storage: null, name: "Example", origin: ORIGIN };
  assert.throws(() => createConnect({ ...base, qrLifeMs: 29_999 }), /qrLifeMs/);
  assert.throws(() => createConnect({ ...base, qrLifeMs: 600_001 }), /qrLifeMs/);
  assert.doesNotThrow(() => createConnect({ ...base, qrLifeMs: 600_000 }));
});

test("a connection is kept 30 days, for its own network only", () => {
  const storage = new MemoryStorage();
  const c = { network: GENESIS, account: "11".repeat(32), address: "dsalt1q", grant: "AA", signer: "ed25519", managed: false, since: Date.now() };
  storage.setItem(STORAGE_KEY, JSON.stringify({ devnet: c }));
  assert.deepEqual(loadConnection("devnet", GENESIS, Date.now(), storage), c);
  assert.equal(loadConnection("devnet", "66".repeat(32), Date.now(), storage), null, "a reset network's is dropped");
  assert.equal(storage.getItem(STORAGE_KEY), null);
  storage.setItem(STORAGE_KEY, JSON.stringify({ devnet: c }));
  assert.equal(loadConnection("devnet", GENESIS, c.since + CONNECT_LIFE_MS, storage), null, "30 days on");
  storage.setItem(STORAGE_KEY, "not json");
  assert.equal(loadConnection("devnet", GENESIS, Date.now(), storage), null);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} };
  assert.equal(loadConnection("devnet", GENESIS, Date.now(), broken), null, "blocked storage is no storage");
  storage.setItem(STORAGE_KEY, JSON.stringify({ devnet: { ...c, since: Date.now() - CONNECT_LIFE_MS - 1 } }));
  assert.equal(setup({ storage }).connect.connection, null, "a page opened after 30 days");
});

test("the bundle a site includes without a bundler holds everything and imports nothing", async () => {
  const text = readFileSync(new URL("../dist/saltix-connect.js", import.meta.url), "utf8");
  assert.doesNotMatch(text, /\bimport\s*[\w{*]|\bimport\(|require\(/, "no import left");
  const bundle = await import("../dist/saltix-connect.js");
  for (const name of ["createConnect", "signInButton", "openConnectDialog", "readSiteProfile", "parseOffer"]) assert.equal(typeof bundle[name], "function", name);
});
