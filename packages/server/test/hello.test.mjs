// The team's hello (Saltix 22-grain-chats §3a): an account on the grain's team introduces itself to its own app without
// the user typing, so the app's console reaches it from the start. The server keeps the member's address and welcomes
// the hello, at most once an hour per key; it answers nothing at all to anything else, and a flood of hellos reaches its
// node only up to a small cap a minute. A hello is no request: no handler, no numbers, no budget, no request memory.
import test from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import {
  ChatServer, card, toHex, fromHex, accountId, ROLES, memoryChatStore, chatWelcomeProblem, encodeChatFrame, signChatWelcome,
  signChatHello, signMemberProof, newChatId, WELCOME_EVERY_MS, HELLO_LIFE_MS, MESSAGE_AHEAD_MS, HELLO_CHECKS_PER_MINUTE,
} from "../dist/index.js";
import { createDevRelay } from "../../../scripts/dev-relay.mjs";
import {
  DAY, OWNER, SERVER, chain, ownerKey, quiet, spec, signedSpec, serverKey, appKey, cert, fakeChain, wallet, sleep, manifest, serverOn,
} from "./chat-helpers.mjs";

const accountOf = (secret) => toHex(accountId(ed25519.getPublicKey(secret)));
const DEV = fromHex("63".repeat(32), 32);
const VIEWER = fromHex("64".repeat(32), 32);
const USER = fromHex("65".repeat(32), 32);
const STRANGER = fromHex("66".repeat(32), 32);
const ownerAccount = accountOf(OWNER);

/** A public grain whose members are a developer, a viewer and a user. */
function teamChain() {
  const fake = fakeChain();
  fake.state.grain.members = [
    { account: accountOf(DEV), roles: ROLES.developer },
    { account: accountOf(VIEWER), roles: ROLES.viewer },
    { account: accountOf(USER), roles: ROLES.user },
  ];
  return fake;
}

/** A store that counts what the server asks of it: a hello touches neither the requests' memory, the numbers nor a
 *  budget. */
function countingStore() {
  const store = memoryChatStore();
  const calls = { take: 0, forget: 0, seen: 0, spend: 0 };
  const counting = {};
  for (const name of ["take", "forget", "spend", "specSent", "setSpecSent", "seen", "usage", "team", "setTeam"]) {
    counting[name] = (...args) => {
      if (name in calls) calls[name]++;
      return store[name](...args);
    };
  }
  return { store: counting, calls };
}

/** A server from the developer key on a development relay, reading `fake`'s chain, its log kept. */
async function studio(fake, over = {}) {
  const relay = await createDevRelay();
  const events = [];
  const log = (level, event, meta) => events.push({ level, event, meta });
  const server = await ChatServer.start({ appKey: appKey(), spec: spec(), wallet: fake.wallet, endpoints: [relay.endpoint()], log, ...over });
  for (const name of ["key", "revoke", "report", "idle"]) server.command(name, () => card().text(name));
  return { relay, server, events, close: async () => { server.close(); await relay.close(); } };
}

/** Waits until `test()` holds, at most `ms`. */
async function until(test, ms = 5_000) {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
}

const count = (events, event, reason) => events.filter((e) => e.event === event && (reason === undefined || e.meta?.reason === reason)).length;
/** The kept frames the server has not acknowledged yet. */
const unacked = (relay, server) => relay.mailboxes.get(server.address)?.size ?? 0;
/** The unasked messages `w` got so far. */
const unasked = (w) => w.frames.filter((f) => f.message && f.message.message.answers === null).map((f) => f.message);

test("a team member's hello is welcomed, and the console reaches the team before anyone writes", async () => {
  const fake = teamChain();
  const t = Date.now();
  const { store, calls } = countingStore();
  const { relay, server, events, close } = await studio(fake, { now: () => t, store });
  const handled = [];
  server.text(() => { handled.push("text"); return card().text("text"); });
  for (const name of ["key", "revoke", "report", "idle"]) server.command(name, () => { handled.push(name); return card().text(name); });
  const owner = await wallet(relay, 0x81, server.address, [serverKey]);
  const dev = await wallet(relay, 0x82, server.address, [serverKey]);
  try {
    const before = store.usage(t);
    const ownersHello = owner.hello(OWNER, { at: t });
    await owner.sendHello(ownersHello);
    await owner.until(() => owner.welcomes().length === 1);
    const [welcome] = owner.welcomes();
    assert.equal(welcome.welcome.hello, ownersHello.hello.id, "it names the hello");
    assert.deepEqual(welcome.server, { registered: serverKey }, "signed as the server's messages are");
    const check = { chain, slug: "access", hello: ownersHello.hello.id, ownerKey, servers: [serverKey], spec: spec(), from: server.address, now: t };
    assert.equal(chatWelcomeProblem(welcome, check), null, "a welcome the owner's wallet takes");
    const devsHello = dev.hello(DEV, { at: t });
    await dev.sendHello(devsHello);
    await dev.until(() => dev.welcomes().length === 1);
    assert.equal(chatWelcomeProblem(dev.welcomes()[0], { ...check, hello: devsHello.hello.id }), null);

    const team = await server.team();
    assert.deepEqual(team.map((m) => [m.account, m.address]), [
      [ownerAccount, owner.address], [accountOf(DEV), dev.address], [accountOf(VIEWER), null],
    ], "the hellos' addresses, as a request's proof would give them");

    // The console reaches them: the update goes to the one who approves it, a notice to the owner and the developer.
    const next = { ...manifest().manifest, version: 2, name: { en: "Access" } };
    assert.deepEqual(await server.proposeUpdate(next), { sent: 2, unreachable: 0, spent: 0, failed: 0, version: 2, owner: true });
    await owner.until(() => unasked(owner).length === 1);
    assert.equal(owner.problem(unasked(owner)[0]), null, "a card the owner's wallet takes");
    assert.deepEqual(await server.notifyTeam(card().text("Deployed 1.4.2")), { sent: 2, unreachable: 0, spent: 0, failed: 0 });
    await dev.until(() => unasked(dev).length === 2);

    // Nobody wrote: no request went, no handler ran, nothing was counted or remembered as a request, and the only
    // budget spent is the team's two cards each.
    assert.deepEqual(handled, []);
    assert.equal(calls.take, 0, "not in the requests' memory");
    assert.equal(calls.seen, 0, "not in the numbers");
    assert.deepEqual(store.usage(t), before);
    assert.deepEqual(before, { users_1d: 0, users_30d: 0, requests_30d: 0 });
    assert.equal(calls.spend, 4, "the welcomes spent no budget; the cards did");
    // The wallets got a welcome and the team's cards: never a hello, a spec or the numbers, which go with answers.
    for (const w of [owner, dev]) {
      assert.ok(w.frames.every((f) => f.welcome || f.message), "welcomes and messages only");
      assert.equal(w.frames.filter((f) => f.welcome).length, 1);
    }
    assert.equal(count(events, "chat_hello_welcomed"), 2);
    assert.equal(count(events, "chat_team_reachable"), 2);
    const log = JSON.stringify(events);
    for (const name of [ownerAccount, accountOf(DEV), owner.address, dev.address, owner.key, dev.key]) assert.ok(!log.includes(name), "the log names nobody");
    await until(() => unacked(relay, server) === 0);
  } finally {
    owner.client.close();
    dev.client.close();
    await close();
  }
});

test("a viewer of a private grain is welcomed too: the team is the team, public grain or private", async () => {
  const fake = teamChain();
  fake.state.grain.public = false;
  const t = Date.now();
  const { relay, server, close } = await studio(fake, { now: () => t });
  const viewer = await wallet(relay, 0x83, server.address, [serverKey]);
  try {
    await viewer.sendHello(viewer.hello(VIEWER, { at: t }));
    await viewer.until(() => viewer.welcomes().length === 1);
    assert.equal((await server.team()).find((m) => m.account === accountOf(VIEWER)).address, viewer.address);
    assert.deepEqual(await server.notifyTeam(card().text("for viewers"), { roles: ["viewer"] }), { sent: 1, unreachable: 0, spent: 0, failed: 0 });
  } finally {
    viewer.client.close();
    await close();
  }
});

test("a hello that does not check gets no answer at all, and its frame is acked", async () => {
  const fake = teamChain();
  const t = Date.now();
  const store = memoryChatStore();
  const { relay, server, events, close } = await studio(fake, { now: () => t, store });
  const dev = await wallet(relay, 0x84, server.address, [serverKey]);
  const user = await wallet(relay, 0x85, server.address, [serverKey]);
  const stranger = await wallet(relay, 0x86, server.address, [serverKey]);
  /** Sends `signed` from `w` (or its frame as is) and waits for the server to drop it for `reason`. */
  async function dropped(w, signed, reason, event = "chat_hello_dropped") {
    const n = count(events, event, reason);
    await w.client.send(server.address, signed instanceof Uint8Array ? signed : encodeChatFrame({ hello: signed }), { keep: true });
    await until(() => count(events, event, reason) > n);
  }
  try {
    const asked = fake.calls.account_get;
    await dropped(dev, dev.hello(DEV, { at: t, slug: "other" }), "slug");
    await dropped(dev, { ...dev.hello(DEV, { at: t }), signature: "00".repeat(64) }, "signature");
    await dropped(dev, dev.hello(DEV, { at: t - HELLO_LIFE_MS - 1 }), "time");
    await dropped(dev, dev.hello(DEV, { at: t + MESSAGE_AHEAD_MS + 1 }), "time");
    // Relayed by another address than its key's: the stranger forwards the developer's hello.
    await dropped(stranger, dev.hello(DEV, { at: t }), "sender");
    // A proof for another grain key, an expired one, one of another network, another grain's: no node asked.
    await dropped(dev, dev.hello(DEV, { at: t }, { grain_key: "77".repeat(32) }), "proof");
    await dropped(dev, dev.hello(DEV, { at: t }, { expires_at: t }), "proof");
    await dropped(dev, dev.hello(DEV, { at: t }, { expires_at: t + 31 * DAY }), "proof");
    await dropped(dev, dev.hello(DEV, { at: t }, { slug: "other" }), "proof");
    const otherNetwork = signMemberProof({ slug: "access", account: accountOf(DEV), grain_key: dev.key, expires_at: t + DAY }, DEV, "6d".repeat(32));
    await dropped(dev, signChatHello({ slug: "access", id: newChatId(), at: t, member: otherNetwork, lang: "en" }, dev.secret, chain.genesis), "proof");
    // Accounts off the team: a user of the grain, a stranger.
    await dropped(user, user.hello(USER, { at: t }), "not_team");
    await dropped(stranger, stranger.hello(STRANGER, { at: t }), "not_team");
    assert.equal(fake.calls.account_get, asked, "none of them cost the node an account");
    // A bad proof: the developer's account, signed by a key that does not speak for it.
    await dropped(dev, dev.hello(STRANGER, { at: t }, { account: accountOf(DEV) }), "member:signer");
    // A language out of form does not read at all.
    const unread = encodeChatFrame({ hello: { ...dev.hello(DEV, { at: t }), hello: { ...dev.hello(DEV, { at: t }).hello, lang: "RU" } } });
    await dropped(dev, unread, undefined, "chat_frame_malformed");

    await sleep(150);
    for (const w of [dev, user, stranger]) assert.deepEqual(w.frames, [], "no answer at all");
    assert.deepEqual(store.team(), {}, "nobody's address kept");
    assert.equal(count(events, "chat_hello_welcomed"), 0);
    await until(() => unacked(relay, server) === 0);
  } finally {
    for (const w of [dev, user, stranger]) w.client.close();
    await close();
  }
});

test("a key is welcomed once an hour: a hello within it is taken, the address kept, and not answered", async () => {
  const fake = teamChain();
  let t = Date.now();
  const store = memoryChatStore();
  const { relay, server, events, close } = await studio(fake, { now: () => t, store });
  const dev = await wallet(relay, 0x87, server.address, [serverKey]);
  const owner = await wallet(relay, 0x88, server.address, [serverKey]);
  try {
    await dev.sendHello(dev.hello(DEV, { at: t }));
    await dev.until(() => dev.welcomes().length === 1);
    const welcomedAt = t;
    // Forgotten meanwhile (a store that lost it): the next hello keeps the address again, with no second welcome.
    store.setTeam(accountOf(DEV), null);
    t += 1_000;
    await dev.sendHello(dev.hello(DEV, { at: t }));
    await until(() => count(events, "chat_hello_repeated") === 1);
    assert.equal(store.team()[accountOf(DEV)], dev.address, "the route is kept");
    t = welcomedAt + WELCOME_EVERY_MS - 1;
    await dev.sendHello(dev.hello(DEV, { at: t }));
    await until(() => count(events, "chat_hello_repeated") === 2);
    await sleep(100);
    assert.equal(dev.welcomes().length, 1, "a millisecond before the hour: no welcome");
    // The hour is over: the next hello is welcomed, by its own id.
    t = welcomedAt + WELCOME_EVERY_MS;
    const later = dev.hello(DEV, { at: t });
    await dev.sendHello(later);
    await dev.until(() => dev.welcomes().length === 2);
    assert.equal(dev.welcomes()[1].welcome.hello, later.hello.id);

    // Two copies of one hello at once: one welcome.
    const twice = owner.hello(OWNER, { at: t });
    await Promise.all([owner.sendHello(twice), owner.sendHello(twice)]);
    await owner.until(() => owner.welcomes().length === 1);
    await until(() => count(events, "chat_hello_repeated") === 3);
    await sleep(100);
    assert.equal(owner.welcomes().length, 1);
  } finally {
    dev.client.close();
    owner.client.close();
    await close();
  }
});

test("past the minute's cap, hellos are dropped before they reach the node", async () => {
  assert.equal(HELLO_CHECKS_PER_MINUTE, 30);
  const fake = teamChain();
  let t = Date.now();
  const { relay, server, events, close } = await studio(fake, { now: () => t, helloChecksPerMinute: 2 });
  const owner = await wallet(relay, 0x89, server.address, [serverKey]);
  const dev = await wallet(relay, 0x8a, server.address, [serverKey]);
  const viewer = await wallet(relay, 0x8b, server.address, [serverKey]);
  const junk = await wallet(relay, 0x8c, server.address, [serverKey]);
  try {
    // What fails without the node does not count against the cap.
    for (let i = 0; i < 3; i++) await junk.sendHello(junk.hello(DEV, { at: t }, { grain_key: "77".repeat(32) }));
    await until(() => count(events, "chat_hello_dropped", "proof") === 3);
    const asked = fake.calls.account_get;
    await owner.sendHello(owner.hello(OWNER, { at: t }));
    await owner.until(() => owner.welcomes().length === 1);
    await dev.sendHello(dev.hello(DEV, { at: t }));
    await dev.until(() => dev.welcomes().length === 1);
    assert.equal(fake.calls.account_get, asked + 2);
    // The third this minute, and the fourth: dropped, logged once, the node not asked.
    await viewer.sendHello(viewer.hello(VIEWER, { at: t }));
    await until(() => count(events, "chat_hello_busy") === 1);
    await viewer.sendHello(viewer.hello(VIEWER, { at: t }));
    await until(() => unacked(relay, server) === 0);
    assert.equal(count(events, "chat_hello_busy"), 1, "logged once a minute");
    assert.deepEqual(events.find((e) => e.event === "chat_hello_busy").meta.limit, 2);
    assert.equal(fake.calls.account_get, asked + 2, "the node was not asked");
    assert.equal(viewer.welcomes().length, 0);
    // A minute later the viewer is welcomed.
    t += 60_000;
    await viewer.sendHello(viewer.hello(VIEWER, { at: t }));
    await viewer.until(() => viewer.welcomes().length === 1);
    for (const bad of [-1, 0, 1.5]) {
      await assert.rejects(ChatServer.start({ appKey: appKey(), spec: spec(), wallet: fake.wallet, endpoints: [relay.endpoint()], log: quiet, helloChecksPerMinute: bad }), /helloChecksPerMinute/);
    }
  } finally {
    for (const w of [owner, dev, viewer, junk]) w.client.close();
    await close();
  }
});

test("a hello the node cannot check now, or a server without a registry, gets no answer", async () => {
  const fake = teamChain();
  let t = Date.now();
  const { relay, server, events, close } = await studio(fake, { now: () => t });
  const dev = await wallet(relay, 0x8d, server.address, [serverKey]);
  try {
    fake.state.down = true;
    fake.block();
    t += 3_000;
    await dev.sendHello(dev.hello(DEV, { at: t }));
    await until(() => count(events, "chat_hello_unchecked") === 1);
    await until(() => unacked(relay, server) === 0);
    assert.equal(dev.welcomes().length, 0);
    fake.state.down = false;
    t += 3_000;
    await dev.sendHello(dev.hello(DEV, { at: t }));
    await dev.until(() => dev.welcomes().length === 1);
  } finally {
    dev.client.close();
    await close();
  }
  // A certified key without a node has no registry to find its team in.
  const events2 = [];
  const certified = await serverOn({ log: (level, event, meta) => events2.push({ event, meta }) });
  const w = await wallet(certified.relay, 0x8e, certified.server.address);
  try {
    await w.sendHello(w.hello(OWNER));
    await until(() => count(events2, "chat_hello_dropped", "no_registry") === 1);
    await sleep(100);
    assert.deepEqual(w.frames, []);
  } finally {
    w.client.close();
    await certified.close();
  }
});

test("users never send a welcome: the server drops one", async () => {
  const fake = teamChain();
  const t = Date.now();
  const { relay, server, events, close } = await studio(fake, { now: () => t });
  const user = await wallet(relay, 0x8f, server.address, [serverKey]);
  try {
    const forged = signChatWelcome({ slug: "access", hello: "15".repeat(16), at: t }, user.secret, chain.genesis);
    await user.client.send(server.address, encodeChatFrame({ welcome: forged }), { keep: true });
    await until(() => events.some((e) => e.event === "chat_frame_dropped" && e.meta.kind === "welcome"));
    await until(() => unacked(relay, server) === 0);
    await sleep(100);
    assert.deepEqual(user.frames, []);
  } finally {
    user.client.close();
    await close();
  }
});

test("a certified key welcomes under its certificate, and never under an expired one", async () => {
  const fake = teamChain();
  let t = Date.now();
  const expires = t + 2 * WELCOME_EVERY_MS;
  const relay = await createDevRelay();
  const events = [];
  const server = await ChatServer.start({
    slug: "access", spec: signedSpec(), secret: SERVER, cert: cert(expires), chain, ownerKey, wallet: fake.wallet, endpoints: [relay.endpoint()],
    now: () => t, log: (level, event, meta) => events.push({ level, event, meta }),
  });
  const dev = await wallet(relay, 0x90, server.address);
  try {
    const first = dev.hello(DEV, { at: t });
    await dev.sendHello(first);
    await dev.until(() => dev.welcomes().length === 1);
    const [w] = dev.welcomes();
    assert.ok("certified" in w.server, "under the certificate");
    assert.equal(chatWelcomeProblem(w, { chain, slug: "access", hello: first.hello.id, ownerKey, servers: [], from: server.address, now: t }), null);
    // The certificate has ended: the address is still kept, and no welcome goes.
    t = expires;
    await dev.sendHello(dev.hello(DEV, { at: t }));
    await until(() => count(events, "chat_hello_unwelcomed", "cert_expired") === 1);
    await sleep(100);
    assert.equal(dev.welcomes().length, 1);
    assert.equal((await server.team()).find((m) => m.account === accountOf(DEV)).address, dev.address);
  } finally {
    dev.client.close();
    server.close();
    await relay.close();
  }
});
