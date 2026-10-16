// Check first, render after (Saltix 12-grains §5.1a): `grain.signIn` asks the app's server for a challenge, the wallet
// for its login (with the team's member proof), and the server for what the account may do; `gateOf` says what a page
// for some people only shows then. An older Saltix's login has no `member`, and that is forwarded as it came.
import test from "node:test";
import assert from "node:assert/strict";
import { grain, gateOf, GrainError, ErrorCode, TEAM, _reset } from "../dist/index.js";

const CHALLENGE = "ab".repeat(32);

/** A wallet whose `grain_login` answers `login`, and a server that answers `session`; both record what they got. */
function setup(login, session = () => ({ status: 200, body: { signed_in: true, rights: "developer", token: "t" } })) {
  const asked = [];
  const posted = [];
  globalThis.saltix = { isGrain: true, request: async (args) => { asked.push(args); return login(args); } };
  _reset();
  const fetch = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body), init });
    const answer = url.endsWith("/challenge") ? { status: 200, body: { challenge: CHALLENGE } } : session(JSON.parse(init.body));
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
  };
  return { asked, posted, fetch };
}

const LOGIN = { key: "11".repeat(32), signature: "22".repeat(64), at: 5, origin: "https://pass.grain.invalid" };

test("a team member signs in with the proof the wallet attached, forwarded with the login and the page's fields", async () => {
  const { asked, posted, fetch } = setup(() => ({ ...LOGIN, member: "cd".repeat(100) }));
  const s = await grain.signIn({ url: "https://api.example/apps/pass/api", extra: { lang: "ru" }, fetch });
  assert.deepEqual(asked, [{ method: "grain_login", params: { challenge: CHALLENGE } }]);
  assert.equal(posted[0].url, "https://api.example/apps/pass/api/challenge");
  assert.equal(posted[1].url, "https://api.example/apps/pass/api/session");
  assert.deepEqual(posted[1].body, { lang: "ru", challenge: CHALLENGE, ...LOGIN, member: "cd".repeat(100) });
  // Cookies never go: the session is the server's token.
  assert.equal(posted[1].init.credentials, "omit");
  assert.deepEqual({ signedIn: s.signedIn, rights: s.rights, legacy: s.legacy, token: s.answer.token }, { signedIn: true, rights: "developer", legacy: false, token: "t" });
  assert.equal(gateOf(s, TEAM), "open");
});

test("a stranger's member is null and an older Saltix sends none: the second is legacy, and the server sees no member", async () => {
  const refuse = () => ({ status: 200, body: { signed_in: false, rights: "none" } });
  const stranger = setup(() => ({ ...LOGIN, member: null }), refuse);
  const s = await grain.signIn({ url: "https://api.example/", fetch: stranger.fetch });
  assert.equal(stranger.posted[1].body.member, null);
  assert.deepEqual({ signedIn: s.signedIn, rights: s.rights, legacy: s.legacy }, { signedIn: false, rights: "none", legacy: false });
  assert.equal(gateOf(s, TEAM), "refused");

  const old = setup(() => ({ ...LOGIN }), refuse);
  const o = await grain.signIn({ url: "https://api.example/", fetch: old.fetch });
  assert.equal(Object.hasOwn(old.posted[1].body, "member"), false);
  assert.equal(o.legacy, true);
  assert.equal(gateOf(o, TEAM), "update");
});

test("rights the server does not name are none, and nothing opens on them", async () => {
  for (const body of [{ signed_in: true }, { signed_in: true, rights: "admin" }, { signed_in: "yes", rights: "owner" }]) {
    const { fetch } = setup(() => ({ ...LOGIN, member: null }), () => ({ status: 200, body }));
    const s = await grain.signIn({ url: "https://api.example/", fetch });
    assert.notEqual(gateOf(s, TEAM), "open", JSON.stringify(body));
  }
});

test("a declined login, no wallet, a server that fails or refuses: no gate opens", async () => {
  const declined = setup(() => { throw { code: ErrorCode.UserRejected, message: "no" }; });
  const e1 = await grain.signIn({ url: "https://api.example/", fetch: declined.fetch }).catch((e) => e);
  assert.ok(e1 instanceof GrainError);
  assert.equal(gateOf(e1, TEAM), "declined");

  delete globalThis.saltix;
  _reset();
  const e2 = await grain.signIn({ url: "https://api.example/", fetch: async () => { throw new Error("unused"); } }).catch((e) => e);
  assert.equal(e2.code, ErrorCode.NoWallet);
  assert.equal(gateOf(e2, TEAM), "outside");

  const down = setup(() => LOGIN);
  const e3 = await grain.signIn({ url: "https://api.example/", fetch: async () => { throw new TypeError("network"); } }).catch((e) => e);
  assert.equal(e3.code, ErrorCode.Failed);
  assert.equal(gateOf(e3, TEAM), "failed");
  assert.equal(down.asked.length, 0, "no login without a challenge");

  const refusing = setup(() => LOGIN, () => ({ status: 401, body: { error: "login" } }));
  const e4 = await grain.signIn({ url: "https://api.example/", fetch: refusing.fetch }).catch((e) => e);
  assert.equal(e4.code, ErrorCode.Failed);
  assert.match(e4.message, /login/);

  const noChallenge = setup(() => LOGIN);
  const bad = async (url, init) => ({ ok: true, status: 200, json: async () => ({ challenge: "not hex" }) });
  const e5 = await grain.signIn({ url: "https://api.example/", fetch: bad }).catch((e) => e);
  assert.equal(e5.code, ErrorCode.Failed);
  assert.equal(noChallenge.asked.length, 0);
});

test("gateOf: only rights among those admitted open, anything unknown is a failure", () => {
  const signedIn = (rights, legacy = false) => ({ signedIn: true, rights, legacy, answer: {} });
  assert.equal(gateOf(signedIn("owner"), TEAM), "open");
  assert.equal(gateOf(signedIn("viewer"), TEAM), "open");
  assert.equal(gateOf(signedIn("user"), TEAM), "refused");
  assert.equal(gateOf(signedIn("user"), [...TEAM, "user"]), "open");
  assert.equal(gateOf(signedIn("none"), TEAM), "refused");
  assert.equal(gateOf(signedIn("none", true), TEAM), "update");
  // An older Saltix whose account the server knew anyway (adopted from the chat) opens.
  assert.equal(gateOf(signedIn("owner", true), TEAM), "open");
  // Rights without a session never open.
  assert.equal(gateOf({ signedIn: false, rights: "owner", legacy: false, answer: {} }, TEAM), "refused");
  assert.equal(gateOf(signedIn("none"), ["none"]), "open");
  for (const odd of [null, undefined, {}, "open", { signedIn: true }, new Error("x")]) assert.equal(gateOf(odd, TEAM), "failed");
});
