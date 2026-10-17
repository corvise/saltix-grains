// A page's sign-in (Saltix 12-grains §5.1, §5.1a): the challenge spent once, the grain key's login for this slug and
// origin, and the member proof the team's (and a private grain's members') wallets attach, checked as a chat request's
// against the registry and the account's keys. Rights come from the registry alone; anyone the wallet proved nothing of
// is `none`, and a wallet that sends no `member` at all (Saltix 0.1.53) is told apart from a stranger.
import test from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import {
  ChatMemberUnchecked, ChatServer, ROLES, SIGN_IN_CHALLENGE_MS, SignIns, accountId, decodeSignedMemberProof, encodeAddress,
  encodeSignedMemberProof, fromHex, loginMessage, rightsOf, sealedOrigin, signInAnswer, signMemberProof, toHex, MEMBER_PROOF_LIFE_MS, MEMBER_PROOF_AHEAD_MS,
} from "../dist/index.js";
import { createDevRelay } from "../../../scripts/dev-relay.mjs";
import { OWNER, appKey, chain, fakeChain, spec } from "./chat-helpers.mjs";

const accountOf = (secret) => toHex(accountId(ed25519.getPublicKey(secret)));
const DEV = fromHex("63".repeat(32), 32);
const VIEWER = fromHex("64".repeat(32), 32);
const USER = fromHex("65".repeat(32), 32);
const STRANGER = fromHex("66".repeat(32), 32);
/** The user's grain key in the app (its secret): what `grain.login` signs with. */
const GRAIN = fromHex("77".repeat(32), 32);
const grainKey = toHex(ed25519.getPublicKey(GRAIN));
const ORIGIN = sealedOrigin("access");

/** A public grain whose members are a developer, a viewer and a user (or private, with `open` false). */
function teamChain(open = true) {
  const fake = fakeChain();
  fake.state.grain.public = open;
  fake.state.grain.members = [
    { account: accountOf(DEV), roles: ROLES.developer },
    { account: accountOf(VIEWER), roles: ROLES.viewer },
    { account: accountOf(USER), roles: ROLES.user },
  ];
  return fake;
}

async function server(fake, now) {
  const relay = await createDevRelay();
  const events = [];
  const chat = await ChatServer.start({
    appKey: appKey(), spec: spec(), wallet: fake.wallet, endpoints: [relay.endpoint()], now,
    log: (level, event, meta) => events.push({ level, event, meta }),
  });
  return { chat, events, signIns: SignIns.of(chat, { now }), close: async () => { chat.close(); await relay.close(); } };
}

/** What a page posts: the challenge and what `grain.login` returned, with `member` as the wallet answered it. */
function login(challenge, { at, origin = ORIGIN, slug = "access", secret = GRAIN, member } = {}) {
  const t = at ?? Date.now();
  const signature = ed25519.sign(loginMessage(slug, origin, fromHex(challenge), t), secret);
  const body = { challenge, key: toHex(ed25519.getPublicKey(secret)), signature: toHex(signature), at: t, origin };
  if (member !== undefined) body.member = member;
  return body;
}

/** The member proof `account`'s wallet attaches: for `slug` and `key`, on `genesis`, hex of its Borsh. */
function proofOf(accountSecret, { slug = "access", key = grainKey, expires = Date.now() + 7 * 86_400_000, genesis = chain.genesis } = {}) {
  return toHex(encodeSignedMemberProof(signMemberProof({ slug, account: accountOf(accountSecret), grain_key: key, expires_at: expires }, accountSecret, genesis)));
}

/** Who signed in, once the sign-in went through. */
const r = (result) => {
  assert.equal(result.ok, true);
  return result.signedIn;
};

test("rights come from the registry's roles, the strongest first; a public grain's user role is none", () => {
  const access = { owner: "aa".repeat(32), public: true, members: [
    { account: "bb".repeat(32), roles: ROLES.user | ROLES.developer }, { account: "cc".repeat(32), roles: ROLES.viewer | ROLES.user },
    { account: "dd".repeat(32), roles: ROLES.user },
  ] };
  assert.equal(rightsOf(access, "aa".repeat(32)), "owner");
  assert.equal(rightsOf(access, "bb".repeat(32)), "developer");
  assert.equal(rightsOf(access, "cc".repeat(32)), "viewer");
  assert.equal(rightsOf(access, "dd".repeat(32)), "none");
  assert.equal(rightsOf({ ...access, public: false }, "dd".repeat(32)), "user");
  assert.equal(rightsOf(access, "ee".repeat(32)), "none");
  assert.equal(rightsOf(access, null), "none");
});

test("the team signs in with its proof: owner, developer and viewer, and the server learns where their chat is", async () => {
  const fake = teamChain();
  const t = Date.now();
  const { chat, signIns, events, close } = await server(fake, () => t);
  try {
    for (const [secret, rights] of [[OWNER, "owner"], [DEV, "developer"], [VIEWER, "viewer"]]) {
      const r = await signIns.check(login(signIns.challenge(), { at: t, member: proofOf(secret) }));
      assert.equal(r.ok, true);
      assert.equal(r.signedIn.rights, rights);
      assert.equal(r.signedIn.account, accountOf(secret));
      assert.equal(r.signedIn.proves, true);
      assert.equal(r.signedIn.problem, null);
      assert.equal(r.signedIn.key, grainKey);
      assert.equal(r.signedIn.address, encodeAddress("devnet", accountId(ed25519.getPublicKey(GRAIN))));
    }
    // The last one's proof says where the viewer's chat is: the console reaches them without their writing.
    const viewer = (await chat.team()).find((m) => m.account === accountOf(VIEWER));
    assert.equal(viewer.address, encodeAddress("devnet", accountId(ed25519.getPublicKey(GRAIN))));
    assert.deepEqual(signInAnswer(r(await signIns.check(login(signIns.challenge(), { at: t, member: proofOf(DEV) }))), true, { token: "t" }),
      { token: "t", signed_in: true, rights: "developer" });
    // The log names rights and reasons, never an account or a key.
    for (const e of events) assert.doesNotMatch(JSON.stringify(e.meta ?? {}), new RegExp(`${accountOf(DEV)}|${grainKey}`));
  } finally {
    await close();
  }
});

test("a stranger's wallet attaches nothing, and an old wallet sends no member at all: both none, told apart", async () => {
  const fake = teamChain();
  const t = Date.now();
  const { signIns, close } = await server(fake, () => t);
  try {
    const before = fake.calls.account_get;
    const stranger = r(await signIns.check(login(signIns.challenge(), { at: t, member: null })));
    assert.deepEqual({ rights: stranger.rights, account: stranger.account, proves: stranger.proves, problem: stranger.problem },
      { rights: "none", account: null, proves: true, problem: null });
    const old = r(await signIns.check(login(signIns.challenge(), { at: t })));
    assert.deepEqual({ rights: old.rights, proves: old.proves }, { rights: "none", proves: false });
    // Neither costs the node anything.
    assert.equal(fake.calls.account_get, before);
  } finally {
    await close();
  }
});

test("a public grain counts its team alone: a user's or a stranger's own proof is none, and costs the node nothing", async () => {
  const fake = teamChain();
  const t = Date.now();
  const { signIns, close } = await server(fake, () => t);
  try {
    const before = fake.calls.account_get;
    for (const secret of [USER, STRANGER]) {
      const s = r(await signIns.check(login(signIns.challenge(), { at: t, member: proofOf(secret) })));
      assert.deepEqual({ rights: s.rights, account: s.account, problem: s.problem }, { rights: "none", account: null, problem: "not_team" });
    }
    assert.equal(fake.calls.account_get, before);
  } finally {
    await close();
  }
});

test("a private grain counts every member: its user signs in as user, a stranger's proof is not_member", async () => {
  const fake = teamChain(false);
  const t = Date.now();
  const { signIns, close } = await server(fake, () => t);
  try {
    assert.equal(r(await signIns.check(login(signIns.challenge(), { at: t, member: proofOf(USER) }))).rights, "user");
    assert.equal(r(await signIns.check(login(signIns.challenge(), { at: t, member: proofOf(VIEWER) }))).rights, "viewer");
    const s = r(await signIns.check(login(signIns.challenge(), { at: t, member: proofOf(STRANGER) })));
    assert.deepEqual({ rights: s.rights, problem: s.problem }, { rights: "none", problem: "not_member" });
  } finally {
    await close();
  }
});

test("a proof for another app, another grain key, another network, expired or too long, or not signed for the account is none", async () => {
  const fake = teamChain();
  const t = Date.now();
  const { signIns, close } = await server(fake, () => t);
  const signer = fromHex("68".repeat(32), 32);
  try {
    const cases = [
      ["mismatch", proofOf(DEV, { slug: "other-app" })],
      ["mismatch", proofOf(DEV, { key: "ab".repeat(32) })],
      ["signature", proofOf(DEV, { genesis: "6d".repeat(32) })],
      ["expired", proofOf(DEV, { expires: t - 1 })],
      ["expired", proofOf(DEV, { expires: t + MEMBER_PROOF_LIFE_MS + MEMBER_PROOF_AHEAD_MS + 1 })],
    ];
    for (const [problem, member] of cases) {
      const s = r(await signIns.check(login(signIns.challenge(), { at: t, member })));
      assert.deepEqual({ rights: s.rights, account: s.account, problem: s.problem }, { rights: "none", account: null, problem }, problem);
    }
    // The developer's account is managed now: its own key no longer speaks for it, a device does.
    fake.state.controllers.set(accountOf(DEV), { devices: [{ key: { ed25519: toHex(ed25519.getPublicKey(signer)) }, kind: "phone" }] });
    fake.shardBlock();
    const managed = r(await signIns.check(login(signIns.challenge(), { at: t, member: proofOf(DEV) })));
    assert.deepEqual({ rights: managed.rights, problem: managed.problem }, { rights: "none", problem: "signer" });
    // Not a member proof at all: none, and the login still checks.
    for (const member of ["zz", "00".repeat(10), 7, "ab".repeat(600)]) {
      const s = r(await signIns.check(login(signIns.challenge(), { at: t, member })));
      assert.deepEqual({ rights: s.rights, problem: s.problem }, { rights: "none", problem: "malformed" });
    }
    // A proof minted by a wallet whose clock runs up to 5 minutes ahead of the server's still signs its member in.
    const ahead = r(await signIns.check(login(signIns.challenge(), { at: t, member: proofOf(OWNER, { expires: t + MEMBER_PROOF_LIFE_MS + MEMBER_PROOF_AHEAD_MS }) })));
    assert.deepEqual({ rights: ahead.rights, problem: ahead.problem }, { rights: "owner", problem: null });
  } finally {
    await close();
  }
});

test("a challenge is ours, spent once and short-lived; the login must be this grain's, at this origin, on time", async () => {
  const fake = teamChain();
  let t = Date.now();
  const { signIns, close } = await server(fake, () => t);
  try {
    assert.deepEqual(await signIns.check(login("ab".repeat(32), { at: t, member: null })), { ok: false, reason: "challenge" });
    const c = signIns.challenge();
    assert.equal((await signIns.check(login(c, { at: t, member: proofOf(DEV) }))).ok, true);
    assert.deepEqual(await signIns.check(login(c, { at: t, member: proofOf(DEV) })), { ok: false, reason: "challenge" });
    const late = signIns.challenge();
    t += SIGN_IN_CHALLENGE_MS;
    assert.deepEqual(await signIns.check(login(late, { at: t })), { ok: false, reason: "challenge" });
    assert.deepEqual(await signIns.check(login(signIns.challenge(), { at: t, origin: "https://other.grain.invalid" })), { ok: false, reason: "login" });
    assert.deepEqual(await signIns.check(login(signIns.challenge(), { at: t, slug: "other-app" })), { ok: false, reason: "login" });
    assert.deepEqual(await signIns.check(login(signIns.challenge(), { at: t - 6 * 60_000 })), { ok: false, reason: "login" });
    // A wrong login spends its challenge too.
    const spent = signIns.challenge();
    assert.deepEqual(await signIns.check({ ...login(spent, { at: t }), signature: "00".repeat(64) }), { ok: false, reason: "login" });
    assert.deepEqual(await signIns.check(login(spent, { at: t })), { ok: false, reason: "challenge" });
    for (const body of [null, [], "x", { challenge: signIns.challenge(), key: "x" }]) assert.equal((await signIns.check(body)).ok, false);
  } finally {
    await close();
  }
});

test("a node that does not answer leaves a team proof unchecked: the page is told to try again, never refused", async () => {
  const fake = teamChain();
  const t = Date.now();
  const { signIns, close } = await server(fake, () => t);
  try {
    const c = signIns.challenge();
    const body = login(c, { at: t, member: proofOf(DEV) });
    // The record is read (and cached); then the node goes down before the account's keys are asked.
    const real = fake.wallet.call.bind(fake.wallet);
    fake.wallet.call = async (method, params) => {
      if (method === "account_get") throw new Error("account_get: no relay answered");
      return real(method, params);
    };
    await assert.rejects(signIns.check(body), ChatMemberUnchecked);
  } finally {
    await close();
  }
});

test("a node down before the registry is read leaves the proof unchecked too, never a failure of the server", async () => {
  const fake = teamChain();
  let t = Date.now();
  const { chat, signIns, events, close } = await server(fake, () => t);
  try {
    // The node goes down after the server started, and the status it read is no longer fresh: the record cannot be read.
    fake.state.down = true;
    t += 60_000;
    const c = signIns.challenge();
    await assert.rejects(signIns.check(login(c, { at: t, member: proofOf(DEV, { expires: t + 7 * 86_400_000 }) })), ChatMemberUnchecked);
    await assert.rejects(chat.member(decodeSignedMemberProof(fromHex(proofOf(DEV, { expires: t + 7 * 86_400_000 }))), grainKey), ChatMemberUnchecked);
    assert.ok(events.some((e) => e.event === "chat_signin_member_unchecked" && e.level === "warn"));
    // Back up, the same proof checks.
    fake.state.down = false;
    const s = r(await signIns.check(login(signIns.challenge(), { at: t, member: proofOf(DEV, { expires: t + 7 * 86_400_000 }) })));
    assert.equal(s.rights, "developer");
  } finally {
    await close();
  }
});

test("without a way to read members every sign-in is none, and the login is still checked", async () => {
  const t = Date.now();
  const signIns = new SignIns({ slug: "access", origin: ORIGIN, network: "devnet", now: () => t });
  const s = r(await signIns.check(login(signIns.challenge(), { at: t, member: proofOf(DEV) })));
  assert.deepEqual({ rights: s.rights, account: s.account, proves: s.proves }, { rights: "none", account: null, proves: true });
  assert.throws(() => new SignIns({ slug: "-bad", origin: ORIGIN, network: "devnet" }), TypeError);
});
