// vectors/connect-v1.json and connect-profiles-v1.json: the page reproduces the offers, logins, grants and sealed
// payloads byte for byte, refuses every refused offer, grant and payload for its reason, and reads a site's Connect
// profile as a wallet does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { decodeSignedProfile, encodeAddress, fromHex, policyOf, profileToJson, toHex, verifyByDeviceKey } from "@saltix/grain-server/web";
import {
  ConnectError, b64url, checkAccount, checkGrant, checkSiteProfileDocument, decodePayload, encodeGrant, encodeLogin, encodeSeen, fromB64url,
  loginMessage, offerLink, offerText, openLinkPayload, parseOffer, readSiteProfile, sealLinkPayload,
} from "../dist/index.js";

const read = (name) => JSON.parse(readFileSync(new URL(`../../../vectors/${name}`, import.meta.url), "utf8"));
const v = read("connect-v1.json");
const p = read("connect-profiles-v1.json");

const genesis = fromHex(v.chain.genesis_hash_hex, 32);
const policy = policyOf(v.chain.account_policy);
const now = BigInt(v.now);
const s = v.session;
const boxSecret = fromHex(s.box_secret_hex, 32);
const session = { network: genesis, origin: s.origin, sid: fromHex(s.sid_hex, 32), page: fromHex(s.page_public_hex, 32) };
const logEvents = (name) => (name === "none" ? [] : v.logs[name].map((e) => fromHex(e.event_hex)));
const loginOf = (j) => ({ network: fromHex(j.network_hex), account: fromHex(j.account_hex), origin: j.origin, sid: fromHex(j.sid_hex), page: fromHex(j.page_hex), at: BigInt(j.at) });

const reasonOf = (f) => {
  try {
    f();
  } catch (e) {
    if (e instanceof ConnectError) return e.reason;
    throw e;
  }
  return "taken";
};

test("the offer's text and link from the session's keys", () => {
  const offer = {
    relay: fromHex(s.relay_public_hex),
    sid: fromHex(s.sid_hex),
    boxKey: x25519.getPublicKey(boxSecret),
    page: ed25519.getPublicKey(fromHex(s.page_secret_hex)),
    origin: s.origin,
    name: s.name,
  };
  assert.equal(toHex(offer.boxKey), s.box_public_hex);
  assert.equal(toHex(offer.page), s.page_public_hex);
  assert.equal(offerText(offer), v.offer.text);
  assert.equal(offerLink(offer), v.offer.link);
  assert.deepEqual(parseOffer(v.offer.link), offer);
  assert.deepEqual(parseOffer(v.offer.text), offer);
});

test("the other offers read, and every broken one is refused for its reason", () => {
  for (const o of v.other_offers) {
    const parsed = parseOffer(o.text);
    assert.equal(typeof parsed, "object", o.name);
    assert.equal(parsed.origin, o.origin);
    assert.equal(parsed.name, o.page_name);
  }
  assert.ok(v.refused_offers.length > 15);
  for (const o of v.refused_offers) assert.equal(parseOffer(o.text), o.reason, o.name);
});

test("every grant: login, message, signature, Borsh and sealed payload byte for byte", () => {
  assert.equal(v.grants.length, 6);
  const plainSecret = fromHex(v.plain_secret_hex, 32);
  const plainKey = toHex(ed25519.getPublicKey(plainSecret));
  for (const g of v.grants) {
    const login = loginOf(g.login);
    assert.equal(toHex(encodeLogin(login)), g.login_borsh_hex, g.name);
    const message = loginMessage(login);
    assert.equal(toHex(message), g.message_hex, g.name);
    const signer = g.signer.ed25519 ? { ed25519: g.signer.ed25519 } : { p256: g.signer.p256 };
    // The plain account's key signs here again (Ed25519 is deterministic); the phone's and the browser's keys are
    // accounts-v1.json's, and their signatures are checked.
    if ("ed25519" in signer && signer.ed25519 === plainKey) assert.equal(toHex(ed25519.sign(message, plainSecret)), g.signature_hex, g.name);
    assert.ok(verifyByDeviceKey(signer, message, g.signature_hex), g.name);
    const bytes = encodeGrant({ version: 1, login, signer, signature: fromHex(g.signature_hex, 64) });
    assert.equal(toHex(bytes), g.grant_borsh_hex, g.name);
    const sealed = sealLinkPayload(x25519.getPublicKey(boxSecret), session.sid, session.page, bytes, fromHex(g.one_time_secret_hex));
    assert.equal(b64url(sealed), g.payload, g.name);
  }
});

test("the page takes every grant of the file and shows its address", () => {
  for (const g of v.grants) {
    const plain = openLinkPayload(boxSecret, session.sid, session.page, fromB64url(g.payload));
    assert.ok(plain, g.name);
    const payload = decodePayload(plain);
    assert.equal(payload.kind, "grant");
    checkGrant(payload.grant, session, now);
    const { kind } = checkAccount(payload.grant, logEvents(g.log), genesis, policy);
    assert.equal(encodeAddress("devnet", payload.grant.login.account, kind), g.address, g.name);
  }
});

test("the wallet's seen notice opens", () => {
  assert.equal(toHex(encodeSeen(BigInt(v.seen.at))), v.seen.borsh_hex);
  const sealed = sealLinkPayload(x25519.getPublicKey(boxSecret), session.sid, session.page, encodeSeen(BigInt(v.seen.at)), fromHex(v.seen.one_time_secret_hex));
  assert.equal(b64url(sealed), v.seen.payload);
  const plain = openLinkPayload(boxSecret, session.sid, session.page, fromB64url(v.seen.payload));
  assert.deepEqual(decodePayload(plain), { kind: "seen", at: BigInt(v.seen.at) });
});

test("every refused grant is refused for its reason", () => {
  assert.ok(v.refused_grants.length > 12);
  for (const r of v.refused_grants) {
    const reason = reasonOf(() => {
      const payload = decodePayload(fromHex(r.grant_borsh_hex));
      checkGrant(payload.grant, session, now);
      checkAccount(payload.grant, logEvents(r.log), genesis, policy);
    });
    assert.equal(reason, r.reason, r.name);
  }
});

test("every refused payload is ignored for its reason", () => {
  for (const r of v.refused_payloads) {
    const reason = reasonOf(() => {
      const plain = openLinkPayload(boxSecret, session.sid, session.page, fromB64url(r.payload));
      if (!plain) throw new ConnectError("open");
      decodePayload(plain);
    });
    assert.equal(reason, r.reason, r.name);
  }
});

test("a grant of another version is refused however it came", () => {
  const payload = decodePayload(fromHex(v.grants[0].grant_borsh_hex));
  assert.equal(reasonOf(() => checkGrant({ ...payload.grant, version: 2 }, session, now)), "version");
  const at = payload.grant.login.at;
  assert.equal(reasonOf(() => checkGrant(payload.grant, session, at + 600_000n)), "taken", "10 minutes is within");
  assert.equal(reasonOf(() => checkGrant(payload.grant, session, at + 600_001n)), "time");
  assert.equal(reasonOf(() => checkGrant(payload.grant, session, at - 600_001n)), "time");
});

test("base64url in one spelling only", () => {
  assert.deepEqual(fromB64url("AA"), Uint8Array.of(0));
  for (const t of ["AB", "AA==", "A", "A+"]) assert.equal(fromB64url(t), null, t);
});

// ── A site's profile, as a wallet reads it ─────────────────────────────────

const pGenesis = fromHex(p.chain.genesis_hash_hex, 32);
const pPolicy = policyOf(p.chain.account_policy);
const pLog = (name) => (name === "none" ? [] : p.logs[name].map((e) => fromHex(e.event_hex)));

test("a site's profile document: the accepted ones are taken, the refused ones refused for their reason", () => {
  for (const a of p.accepted.filter((a) => "site" in a.for)) {
    const read = checkSiteProfileDocument(a.json, a.for.site.origin, pLog(a.log), pGenesis, pPolicy);
    assert.equal(read.problem, null, a.name);
    assert.equal(read.profile.profile.subject.site.origin, a.for.site.origin);
  }
  for (const r of p.refused.filter((r) => "site" in r.for)) {
    const document = profileToJson(decodeSignedProfile(fromHex(r.signed_borsh_hex)));
    const read = checkSiteProfileDocument(document, r.for.site.origin, pLog(r.log), pGenesis, pPolicy);
    assert.equal(read.problem, r.reason, r.name);
  }
  assert.equal(checkSiteProfileDocument({ profile: {} }, "https://dex.example", [], pGenesis, pPolicy).problem, "json");
});

test("readSiteProfile fetches the well-known document without cookies or redirects, and checks it", async () => {
  const site = p.accepted.find((a) => a.name === "site-managed-phone");
  const asked = [];
  const fetcher = (body, status = 200) => async (url, init) => {
    asked.push({ url, init });
    return new Response(body, { status });
  };
  const node = { call: async (method, params) => {
    assert.equal(method, "account_log");
    assert.equal(params.address, site.json.profile.owner);
    return { account: params.address, events: p.logs.managed.map((e) => ({ event: e.event_hex })) };
  } };
  const options = (f) => ({ node, genesis: p.chain.genesis_hash_hex, policy: pPolicy, fetch: f });
  const ok = await readSiteProfile("https://dex.example", options(fetcher(JSON.stringify(site.json))));
  assert.equal(ok.problem, null);
  assert.equal(asked[0].url, "https://dex.example/.well-known/saltix-connect");
  assert.equal(asked[0].init.credentials, "omit");
  assert.equal(asked[0].init.redirect, "error");
  assert.equal(asked[0].init.referrerPolicy, "no-referrer");
  assert.equal((await readSiteProfile("https://dex.example.com", options(fetcher(JSON.stringify(site.json))))).problem, "service");
  assert.equal((await readSiteProfile("https://dex.example", options(fetcher("not found", 404)))).problem, "fetch");
  assert.equal((await readSiteProfile("https://dex.example", options(fetcher("{")))).problem, "json");
  assert.equal((await readSiteProfile("https://dex.example", options(fetcher(" ".repeat(64 * 1024 + 1))))).problem, "size");
  const failing = { ...options(async () => { throw new TypeError("redirected"); }) };
  assert.equal((await readSiteProfile("https://dex.example", failing)).problem, "fetch");
  // The owner's log as the node has it now: without the phone among its devices, the key speaks for nobody.
  const stranger = { call: async (_m, params) => ({ account: params.address, events: [] }) };
  assert.equal((await readSiteProfile("https://dex.example", { ...options(fetcher(JSON.stringify(site.json))), node: stranger })).problem, "key");
});
