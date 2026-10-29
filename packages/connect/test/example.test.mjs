// The example site (packages/connect/example): its routes over HTTP — the page and the SDK's files, the offer and the
// login behind an Origin check and the limits, the session cookie minted after `connected`, `/me`, sign-out, the
// allow-list, the offers' rate — and the whole flow through the real `@saltix/connect/server` against a node the test
// plays, with a journal that names no address.
import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { ed25519 } from "@noble/curves/ed25519";
import { accountId, encodeAddress, fromHex, toHex } from "@saltix/grain-server/web";
import { b64url, encodeGrant, fromB64url, loginMessage, sealLinkPayload } from "../dist/index.js";
import { createServerConnect } from "../dist/server.js";
import { COOKIE, MAX_BODY_BYTES, OFFERS_PER_MINUTE, SESSION_MS, exampleSite } from "../example/server.mjs";

const ORIGIN = "http://localhost:8091";
const GENESIS = "5a".repeat(32);
const SECRET = new Uint8Array(32).fill(0x44);
const KEY = ed25519.getPublicKey(SECRET);
const ADDRESS = encodeAddress("devnet", accountId(KEY), 0);
const CONNECTION = { network: GENESIS, account: toHex(accountId(KEY)), address: ADDRESS, signer: "ed25519", managed: false, since: 1 };
const OFFER = { sid: b64url(new Uint8Array(32).fill(1)), boxKey: b64url(new Uint8Array(32).fill(2)), page: b64url(new Uint8Array(32).fill(3)), origin: ORIGIN, name: "Example site" };

/** A server library the test plays: offers as given, each take answered from `answers` in turn, the admit hook honoured. */
function fakeConnect(answers) {
  const takes = [];
  return {
    takes,
    offer: async () => OFFER,
    take: async (forwarded, admit) => {
      takes.push(forwarded);
      const a = answers.shift() ?? { outcome: "ignored" };
      if (a.outcome === "connected" && admit) {
        const why = await admit(a.connection);
        if (why) return { outcome: "refused", reason: why };
      }
      return a;
    },
  };
}

async function listening(options) {
  const clock = { now: 1_700_000_000_000 };
  const log = [];
  const site = exampleSite({ origin: ORIGIN, network: "devnet", relays: ["/saltix/r/1/", "wss://relay.example:30335/"], now: () => clock.now, log: (event, meta) => log.push({ event, ...meta }), ...options });
  await new Promise((r) => site.server.listen(0, "127.0.0.1", r));
  const { port } = site.server.address();
  return { ...site, clock, log, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => site.server.close(r)) };
}

function call(base, method, path, { headers = {}, body, origin = ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, headers: { ...(origin ? { origin } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

const cookieOf = (res) => (res.headers["set-cookie"] ?? [])[0] ?? null;

test("the routes: the page and the SDK's files, the offer and the login behind an Origin check, the cookie, /me, sign-out", async () => {
  const connect = fakeConnect([{ outcome: "seen" }, { outcome: "connected", connection: CONNECTION, confirm: null }]);
  const s = await listening({ connect });
  try {
    const page = await call(s.base, "GET", "/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /text\/html/);
    assert.match(page.text, /<script type="module" src="\/app\.js">/);
    assert.doesNotMatch(page.text, /<script>|style=/, "no inline script or style: the page keeps its strict policy");
    assert.match(page.headers["content-security-policy"], /default-src 'none'; script-src 'self'; style-src 'self'/);
    assert.match(page.headers["content-security-policy"], /connect-src 'self' wss:\/\/relay\.example:30335;/, "the wss relay's origin, and this one's paths");
    for (const [path, type] of [["/app.js", "text/javascript"], ["/site.css", "text/css"], ["/saltix-connect.js", "text/javascript"], ["/connect.css", "text/css"]]) {
      const r = await call(s.base, "GET", path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers["content-type"], new RegExp(type), path);
      assert.ok(r.text.length > 100, path);
    }
    const config = await call(s.base, "GET", "/config.json");
    assert.deepEqual(config.json, { network: "devnet", relays: ["/saltix/r/1/", "wss://relay.example:30335/"], server: { offer: "/connect/offer", login: "/connect/login" } });
    assert.equal((await call(s.base, "GET", "/nothing")).status, 404);
    assert.equal((await call(s.base, "GET", "/me")).status, 401);
    // A POST is this page's own: without the page's origin, or from elsewhere, nobody's.
    assert.equal((await call(s.base, "POST", "/connect/offer", { origin: null })).status, 403);
    assert.equal((await call(s.base, "POST", "/connect/offer", { origin: "https://evil.example" })).status, 403);
    assert.equal((await call(s.base, "POST", "/connect/login", { origin: null, body: { sid: "AA", payload: "AA" } })).status, 403);
    const offer = await call(s.base, "POST", "/connect/offer");
    assert.equal(offer.status, 200);
    assert.deepEqual(offer.json, OFFER);
    assert.equal(offer.headers["cache-control"], "no-store");
    assert.equal((await call(s.base, "POST", "/connect/login", { body: "{not json" })).status, 400);
    assert.equal((await call(s.base, "POST", "/connect/login", { body: "[1]" })).status, 400);
    assert.equal((await call(s.base, "POST", "/connect/login", { body: JSON.stringify({ sid: "AA", payload: "A".repeat(MAX_BODY_BYTES) }) })).status, 413);
    const seen = await call(s.base, "POST", "/connect/login", { body: { sid: OFFER.sid, payload: "AAAA" } });
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.json, { outcome: "seen" });
    assert.equal(cookieOf(seen), null, "no session before a grant");
    assert.deepEqual(connect.takes, [{ sid: OFFER.sid, payload: "AAAA" }], "forwarded as it came");
    const login = await call(s.base, "POST", "/connect/login", { body: { sid: OFFER.sid, payload: "BBBB" } });
    assert.equal(login.status, 200);
    assert.deepEqual(login.json, { outcome: "connected", connection: CONNECTION, confirm: null, next: "/" });
    const cookie = cookieOf(login);
    assert.match(cookie, new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}$`), cookie);
    assert.doesNotMatch(cookie, /Secure/, "http://localhost: no Secure flag");
    const token = cookie.split(";")[0];
    assert.equal(s.sessions.size, 1);
    const me = await call(s.base, "GET", "/me", { headers: { cookie: token } });
    assert.deepEqual(me.json, { address: ADDRESS, since: s.clock.now, until: s.clock.now + SESSION_MS });
    assert.equal((await call(s.base, "GET", "/me", { headers: { cookie: `${COOKIE}=nonsense` } })).status, 401);
    // The session ends at its time, and at sign-out.
    s.clock.now += SESSION_MS - 1;
    assert.equal((await call(s.base, "GET", "/me", { headers: { cookie: token } })).status, 200);
    s.clock.now += 1;
    assert.equal((await call(s.base, "GET", "/me", { headers: { cookie: token } })).status, 401);
    assert.equal(s.sessions.size, 0);
    const again = await call(s.base, "POST", "/connect/login", { body: { sid: OFFER.sid, payload: "CCCC" } });
    assert.equal(again.json.outcome, "ignored", "the fake has no more answers");
    const out = await call(s.base, "POST", "/signout", { headers: { cookie: token } });
    assert.equal(out.status, 200);
    assert.match(cookieOf(out), /Max-Age=0/);
    assert.deepEqual(s.log.map((l) => l.event), ["offer", "request_failed", "request_failed", "request_failed", "login", "login", "login", "signout"]);
    assert.deepEqual(s.log.filter((l) => l.event === "request_failed").map((l) => l.status), [400, 400, 413], "a bad request is journaled by its status");
    assert.ok(!s.log.some((l) => JSON.stringify(l).includes(ADDRESS) || /[0-9a-f]{64}/.test(JSON.stringify(l))), "the journal names no address or account");
  } finally {
    await s.close();
  }
});

test("the allow-list is the site's own rule after the protocol's checks; the offers' rate per client; Secure on https", async () => {
  const connect = fakeConnect([{ outcome: "connected", connection: CONNECTION, confirm: null }, { outcome: "connected", connection: { ...CONNECTION, address: "dsalt1other" }, confirm: null }]);
  const s = await listening({ connect, allow: new Set([ADDRESS]) });
  try {
    const listed = await call(s.base, "POST", "/connect/login", { body: { sid: OFFER.sid, payload: "AAAA" } });
    assert.equal(listed.json.outcome, "connected");
    assert.ok(cookieOf(listed));
    const stranger = await call(s.base, "POST", "/connect/login", { body: { sid: OFFER.sid, payload: "AAAA" } });
    assert.deepEqual(stranger.json, { outcome: "refused", reason: "not_listed" });
    assert.equal(cookieOf(stranger), null);
    for (let i = 0; i < OFFERS_PER_MINUTE; i++) assert.equal((await call(s.base, "POST", "/connect/offer")).status, 200, `offer ${i + 1}`);
    assert.equal((await call(s.base, "POST", "/connect/offer")).status, 429);
    s.clock.now += 60_000;
    assert.equal((await call(s.base, "POST", "/connect/offer")).status, 200);
    assert.ok(s.log.some((l) => l.event === "offer_limited"));
  } finally {
    await s.close();
  }
  const https = await listening({ connect: fakeConnect([{ outcome: "connected", connection: CONNECTION, confirm: null }]), origin: "https://shop.example" });
  try {
    const login = await call(https.base, "POST", "/connect/login", { origin: "https://shop.example", body: { sid: OFFER.sid, payload: "AAAA" } });
    assert.match(cookieOf(login), /; Secure$/);
  } finally {
    await https.close();
  }
});

test("the whole flow through the real server library: an offer, a grant sealed to it, the session, then spent", async () => {
  const node = { call: async (method, params) => (method === "node_status" ? { network: "devnet", genesis: GENESIS, accounts: { policy: { delay: 600, dispute_timeout: 3600 } } } : { account: params.address, events: [] }) };
  const telemetry = [];
  const connect = createServerConnect({ node, network: "devnet", genesis: GENESIS, origin: ORIGIN, name: "Example site", retryMs: [0, 0], telemetry: (event, meta) => telemetry.push({ event, ...meta }) });
  const s = await listening({ connect });
  try {
    const offer = (await call(s.base, "POST", "/connect/offer")).json;
    assert.equal(offer.origin, ORIGIN);
    const keys = { sid: fromB64url(offer.sid), boxKey: fromB64url(offer.boxKey), page: fromB64url(offer.page) };
    const login = { network: fromHex(GENESIS, 32), account: accountId(KEY), origin: ORIGIN, sid: keys.sid, page: keys.page, at: BigInt(Date.now()) };
    const grant = encodeGrant({ version: 1, login, signer: { ed25519: toHex(KEY) }, signature: ed25519.sign(loginMessage(login), SECRET) });
    const payload = b64url(sealLinkPayload(keys.boxKey, keys.sid, keys.page, grant));
    const taken = await call(s.base, "POST", "/connect/login", { body: { sid: offer.sid, payload } });
    assert.equal(taken.json.outcome, "connected", taken.text);
    assert.equal(taken.json.connection.address, ADDRESS);
    assert.ok(!("grant" in taken.json.connection));
    const token = cookieOf(taken).split(";")[0];
    assert.equal((await call(s.base, "GET", "/me", { headers: { cookie: token } })).json.address, ADDRESS);
    assert.deepEqual((await call(s.base, "POST", "/connect/login", { body: { sid: offer.sid, payload } })).json, { outcome: "refused", reason: "spent" });
    assert.deepEqual(s.log.filter((l) => l.event === "login").map((l) => [l.outcome, l.reason]), [["connected", undefined], ["refused", "spent"]]);
    for (const line of [...s.log, ...telemetry]) assert.ok(!JSON.stringify(line).includes(ADDRESS) && !/[0-9a-f]{64}/.test(JSON.stringify(line)), JSON.stringify(line));
  } finally {
    await s.close();
  }
});
