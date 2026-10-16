// The chat server from a developer key (Saltix 24-app-studio): the registry names the key, or the server does not
// start; once the owner revokes or replaces it, the server stops; a private grain takes its owner's and members'
// requests only, judged against the registry and the accounts' keys per tip; the numbers it reports are signed hourly.
import test from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import {
  ChatServer, ChatKeyNotRegistered, AppKey, AppKeyError, card, toHex, fromHex, accountId, decodeChatDocument, grainStatsProblem,
  signedChatSpecProblem, signMemberProof, signChatSpecAsServer, registeredKeyStatus, memoryChatStore, ROLES, STATS_EVERY_MS,
  decodeNotification, notificationProblem, decodeSignedGrainStats, fromBase64Url,
} from "../dist/index.js";
import { createDevRelay } from "../../../scripts/dev-relay.mjs";
import { DAY, OWNER, SERVER, chain, ownerKey, quiet, spec, signedSpec, cert, serverKey, appKey, fakeChain, wallet, sleep } from "./chat-helpers.mjs";

/** Wait until `done()` holds, at most 5 seconds. */
async function waitFor(done) {
  for (let i = 0; i < 100 && !done(); i++) await sleep(50);
  assert.ok(done(), "in time");
}

const MEMBER = fromHex("50".repeat(32), 32);
const memberAccount = toHex(accountId(ed25519.getPublicKey(MEMBER)));
const VIEWER = fromHex("46".repeat(32), 32);
const viewerAccount = toHex(accountId(ed25519.getPublicKey(VIEWER)));

/** A server started from the developer key on a development relay, reading `fake`'s chain. */
async function studio(fake, over = {}) {
  const relay = await createDevRelay();
  const events = [];
  const log = (level, event, meta) => events.push({ level, event, meta });
  const server = await ChatServer.start({ appKey: appKey(), spec: spec(), wallet: fake.wallet, endpoints: [relay.endpoint()], log, ...over });
  return { relay, server, events, close: async () => { server.close(); await relay.close(); } };
}

test("a developer key is the server's whole configuration", async () => {
  const fake = fakeChain();
  const { relay, server, events, close } = await studio(fake);
  const user = await wallet(relay, 0x61, server.address, [serverKey]);
  server.command("key", (ask) => card().secret("Key", "7KQ2-M9XA-4F").status("done", "Opens the site once"));
  try {
    assert.equal(server.slug, "access");
    assert.equal(server.key, serverKey);
    assert.equal(server.address, appKey().address);
    assert.deepEqual(server.chain, chain, "the network the node reports");
    assert.equal(server.grain.servers[0], serverKey);
    // The spec was unsigned: the registered key signed it, and a wallet takes it as the registry names the key.
    const doc = decodeChatDocument(server.document());
    assert.equal(doc.spec.server, serverKey);
    assert.equal(doc.cert, null, "no certificate");
    assert.equal(signedChatSpecProblem(doc.spec, "access", ownerKey, [serverKey]), null);
    assert.equal(signedChatSpecProblem(doc.spec, "access", ownerKey, []), "cert", "not once the key is removed");
    assert.ok(doc.stats, "the numbers from the start");
    assert.equal(grainStatsProblem(doc.stats, { genesis: chain.genesis, slug: "access", servers: [serverKey], now: Date.now() }), null);
    const started = events.find((e) => e.event === "chat_started");
    assert.equal(started.meta.registered, true);
    assert.equal(started.meta.access, "public");
    assert.ok(!JSON.stringify(events).includes(toHex(SERVER)), "no secret in the log");

    const request = user.request("key", [["duration", { duration: 600 }], ["site", { choice: "web" }]]);
    await user.send(request);
    await user.until(() => user.answers(request.request.id).length === 1);
    const [answer] = user.answers(request.request.id);
    assert.deepEqual(answer.server, { registered: serverKey }, "signed as the registered key");
    assert.equal(user.problem(answer), null);
    assert.equal(user.problem(answer, spec(), []), "cert", "a wallet whose registry no longer names it");
    // Before the answer: the spec (no certificate) and the numbers, once.
    const kinds = user.frames.map((f) => Object.keys(f).find((k) => k !== "from"));
    assert.deepEqual(kinds, ["spec", "stats", "message"]);
    assert.equal(user.frames[0].spec.cert, null);
    const again = user.request("key", [["duration", { duration: 600 }], ["site", { choice: "web" }]]);
    await user.send(again);
    await user.until(() => user.answers(again.request.id).length === 1);
    assert.equal(user.frames.filter((f) => f.stats).length, 1, "the numbers once a day");
    // A notification under the registered key: no certificate, checked against the registry's keys.
    await server.notification(user.key, { title: "Your key", body: "" });
    await user.until(() => user.others.length === 1);
    assert.equal(decodeNotification(user.others[0]).cert, null);
    assert.equal(notificationProblem(user.others[0], "access", ownerKey, chain.genesis, Date.now(), [serverKey]), null);
    assert.throws(() => server.setCert(cert()), /registered/);
  } finally {
    user.client.close();
    await close();
  }
});

test("a server starts only while the registry names its key, on the key's network", async () => {
  const relay = await createDevRelay();
  const start = (fake, over = {}) => ChatServer.start({ appKey: appKey(), spec: spec(), wallet: fake.wallet, endpoints: [relay.endpoint()], log: quiet, ...over });
  const refused = async (change, reason, remedy) => {
    const fake = fakeChain();
    change(fake.state);
    await assert.rejects(start(fake), (e) => e instanceof ChatKeyNotRegistered && e.reason === reason && remedy.test(e.message), reason);
  };
  try {
    // Each reason says what to do about it: a new key for a live grain, a new app for a retired one, and for one the
    // registry does not hold yet, waiting for its registration or making it.
    await refused((s) => (s.grain.servers = []), "revoked", /no server key.*My apps → access → Developer key/);
    await refused((s) => (s.grain.servers = ["77".repeat(32)]), "replaced", /replaced this server key.*Developer key.*or run the server that holds/);
    await refused((s) => (s.grain.retired = 900), "retired", /retired.*never used again: make a new app/);
    await refused((s) => (s.grain = null), "unregistered", /no such grain\. If access was just made, wait until its registration is in a block/);
    for (const reason of ["retired", "unregistered"]) {
      const fake = fakeChain();
      if (reason === "retired") fake.state.grain.retired = 900;
      else fake.state.grain = null;
      await assert.rejects(start(fake), (e) => !/Developer key/.test(e.message), `${reason}: a new developer key would not help`);
    }
    const elsewhere = fakeChain();
    elsewhere.state.status.genesis = "6d".repeat(32);
    await assert.rejects(start(elsewhere), /reset/, "a key of another genesis");
    const kind = fakeChain();
    kind.state.status.network = "testnet";
    await assert.rejects(start(kind), /reset|testnet/, "a key of another kind of network");
    await assert.rejects(start(fakeChain(), { cert: cert() }), /no certificate/);
    await assert.rejects(start(fakeChain(), { secret: SERVER }), /not both/);
    await assert.rejects(start(fakeChain(), { slug: "other" }), /access's, not other's/);
    await assert.rejects(start(fakeChain(), { appKey: "saltix-app:1:dsalt:6c6c6c6c6c6c6c6c:access:" + "AB".repeat(32) }), AppKeyError);
    await assert.rejects(start(fakeChain(), { spec: signChatSpecAsServer(spec(), fromHex("41".repeat(32), 32)) }), /chat spec: cert/, "a spec another key signed");
    await assert.rejects(start(fakeChain(), { spec: { ...spec(), slug: "chess" } }), /for chess, not access/);
    const priced = spec();
    priced.commands[0].price = 5n;
    await assert.rejects(start(fakeChain(), { spec: priced }), /free/, "a server key signs no price");
    // The owner's signed spec is taken too, checked against the manifest's owner key from the registry.
    const owners = await start(fakeChain(), { spec: signedSpec(2) });
    assert.equal(owners.spec.version, 2);
    owners.close();
    const forged = signedSpec(2);
    forged.spec.intro = { en: "Something else" };
    await assert.rejects(start(fakeChain(), { spec: forged }), /signature/);
    // Not the first key: it starts, and says that wallets write to the first one.
    const second = fakeChain();
    second.state.grain.servers = ["77".repeat(32), serverKey];
    const events = [];
    const s2 = await start(second, { log: (level, event) => events.push(event) });
    assert.ok(events.includes("chat_not_first_key"));
    s2.close();
    // No public relays for a network that has none, and no node given.
    await assert.rejects(ChatServer.start({ appKey: AppKey.of("mainnet", chain.genesis, "access", SERVER), spec: spec(), log: quiet }), /no public relays/);
    assert.equal(registeredKeyStatus(second.state.grain, serverKey), null);
  } finally {
    await relay.close();
  }
});

test("a revoked or replaced key stops the server, which says so and answers no more", async () => {
  for (const [change, reason] of [[(g) => (g.servers = []), "revoked"], [(g) => (g.servers = ["77".repeat(32)]), "replaced"], [(g) => (g.retired = 5), "retired"]]) {
    const fake = fakeChain();
    const stops = [];
    const { relay, server, events, close } = await studio(fake, { onStop: (r) => stops.push(r) });
    const user = await wallet(relay, 0x62, server.address, [serverKey]);
    let runs = 0;
    server.command("idle", () => { runs++; return card().text("idle"); });
    try {
      const first = user.request("idle");
      await user.send(first);
      await user.until(() => user.answers(first.request.id).length === 1);
      assert.equal(await server.checkRegistry(), null, "still named");
      assert.equal(server.stopped, null);
      change(fake.state.grain);
      fake.block();
      assert.equal(await server.checkRegistry(), reason);
      assert.equal(server.stopped, reason);
      assert.deepEqual(stops, [reason]);
      const stopped = events.find((e) => e.event === "chat_stopped");
      assert.equal(stopped.level, "error");
      assert.equal(stopped.meta.reason, reason);
      assert.match(stopped.meta.hint, reason === "retired" ? /stopped answering\. A retired slug is never used again/ : /stopped answering\. Make a new developer key/);
      // Nothing more goes out under the key: requests wait in the mailbox, unanswered; sending throws.
      const after = user.request("idle");
      await user.send(after);
      await sleep(300);
      assert.equal(user.answers(after.request.id).length, 0, reason);
      assert.equal(runs, 1);
      await assert.rejects(server.relay.ready(), /closed/, "off the relays: the key's mailbox waits for whoever holds a key the registry names");
      await assert.rejects(server.notify(user.address, card().text("x")), ChatKeyNotRegistered);
      await assert.rejects(server.notification(user.key, { title: "x", body: "" }), ChatKeyNotRegistered);
      assert.equal(await server.checkRegistry(), reason, "stopped for good");
      assert.ok(!JSON.stringify(events).includes(toHex(SERVER)), "no secret in the log");
    } finally {
      user.client.close();
      await close();
    }
  }
});

test("a request after the block that removed the key stops the server before any answer", async () => {
  const fake = fakeChain();
  let t = Date.now();
  const { relay, server, close } = await studio(fake, { now: () => t });
  const user = await wallet(relay, 0x63, server.address, [serverKey]);
  let runs = 0;
  server.command("idle", () => { runs++; return card().text("idle"); });
  try {
    fake.state.grain.servers = [];
    fake.block();
    t += 3_000; // the node's status is read again: a new beacon block
    const r = user.request("idle");
    await user.send(r);
    await sleep(400);
    assert.equal(server.stopped, "revoked");
    assert.equal(user.answers(r.request.id).length, 0);
    assert.equal(runs, 0);
    assert.equal(relay.mailboxes.get(server.address)?.size, 1, "the request stays in the mailbox");
  } finally {
    user.client.close();
    await close();
  }
});

test("a private app takes its owner's and members' requests only", async () => {
  const fake = fakeChain();
  fake.state.grain.public = false;
  fake.state.grain.members = [{ account: memberAccount, roles: ROLES.user }, { account: viewerAccount, roles: ROLES.viewer }];
  let t = Date.now();
  const { relay, server, events, close } = await studio(fake, { now: () => t });
  const user = await wallet(relay, 0x64, server.address, [serverKey]);
  const seen = [];
  server.command("idle", (ask) => { seen.push(ask.member); return card().text("idle"); });
  const status = (id) => user.answers(id)[0]?.message.blocks.find((b) => "status" in b)?.status;
  const proof = (secret, over = {}) => signMemberProof({
    slug: "access", account: toHex(accountId(ed25519.getPublicKey(secret))), grain_key: user.key, expires_at: t + DAY, ...over,
  }, secret, chain.genesis);
  const ask = async (member) => {
    const r = user.request("idle", [], { member });
    await user.send(r);
    await user.until(() => user.answers(r.request.id).length === 1);
    return r.request.id;
  };
  try {
    assert.equal(events.find((e) => e.event === "chat_started").meta.access, "private");
    // A member, and the owner, are taken; the handler learns who asked.
    await ask(proof(MEMBER));
    assert.deepEqual(seen.pop(), { account: memberAccount, roles: ROLES.user });
    await ask(proof(OWNER));
    assert.deepEqual(seen.pop(), { account: toHex(accountId(fromHex(ownerKey.ed25519, 32))), roles: 7 });

    // Everyone else gets a refusal and nothing more.
    const refusals = {
      missing: await ask(null),
      stranger: await ask(proof(fromHex("51".repeat(32), 32))),
      viewer: await ask(proof(VIEWER)),
      expired: await ask(proof(MEMBER, { expires_at: t - 1 })),
      long: await ask(proof(MEMBER, { expires_at: t + 30 * DAY + 1 })),
      lent: await ask(proof(MEMBER, { grain_key: "77".repeat(32) })),
    };
    assert.equal(seen.length, 0, "no handler ran");
    for (const [name, id] of Object.entries(refusals)) {
      assert.equal(status(id).state, 2, name);
      assert.equal(user.answers(id).length, 1, `${name}: one refusal`);
      assert.equal(user.answers(id)[0].message.blocks.length, 1, `${name}: nothing but the refusal`);
    }
    assert.match(status(refusals.missing).text, /private/);
    assert.match(status(refusals.stranger).text, /private/);
    assert.match(status(refusals.expired).text, /expired/);
    const reasons = events.filter((e) => e.event === "chat_request_refused").map((e) => e.meta.reason);
    assert.deepEqual(reasons, ["member:missing", "member:not_member", "member:not_member", "member:expired", "member:expired", "member:mismatch"]);
    assert.equal(user.frames.filter((f) => f.spec).length, 1, "the spec went with the first answer a member got, not with a refusal");

    // The member's account becomes managed by another device: its old key no longer speaks for it, from the shard
    // block that does it.
    fake.state.controllers.set(memberAccount, { devices: [{ key: { ed25519: "88".repeat(32) }, kind: "phone" }] });
    const before = await ask(proof(MEMBER));
    assert.equal(seen.length, 1, "the same tip: the account's keys as read before");
    seen.length = 0;
    fake.shardBlock();
    t += 3_000;
    const signer = await ask(proof(MEMBER));
    assert.equal(seen.length, 0);
    assert.match(status(signer).text, /no longer speaks/);
    assert.ok(before);

    // Removed from the members at a beacon block: refused from there on.
    fake.state.controllers.delete(memberAccount);
    fake.shardBlock();
    fake.state.grain.members = [];
    fake.block();
    t += 3_000;
    const removed = await ask(proof(MEMBER));
    assert.match(status(removed).text, /private/);
    assert.equal(seen.length, 0);

    // Public again: anyone, and no proof is read.
    fake.state.grain.public = true;
    fake.block();
    t += 3_000;
    await ask(null);
    assert.deepEqual(seen.pop(), null, "a public app never knows who asked");
  } finally {
    user.client.close();
    await close();
  }
});

test("membership is read once per tip, and a node that does not answer fails the request, never admits it", async () => {
  const fake = fakeChain();
  fake.state.grain.public = false;
  fake.state.grain.members = [{ account: memberAccount, roles: ROLES.developer }];
  let t = Date.now();
  const { relay, server, close } = await studio(fake, { now: () => t });
  const user = await wallet(relay, 0x65, server.address, [serverKey]);
  let runs = 0;
  server.command("idle", () => { runs++; return card().text("idle"); });
  const proof = () => signMemberProof({ slug: "access", account: memberAccount, grain_key: user.key, expires_at: t + DAY }, MEMBER, chain.genesis);
  const ask = async (member) => {
    const r = user.request("idle", [], { member });
    await user.send(r);
    await user.until(() => user.answers(r.request.id).length === 1);
    return user.answers(r.request.id)[0].message.blocks[0];
  };
  try {
    const grains = fake.calls.grain_get;
    for (let i = 0; i < 3; i++) await ask(proof());
    assert.equal(runs, 3);
    assert.equal(fake.calls.account_get, 1, "the account's keys once on this shard tip");
    assert.equal(fake.calls.grain_get, grains, "the grain's record once on this beacon tip");
    // Strangers' proofs cost the node nothing: they are refused before the account is asked for.
    await ask(signMemberProof({ slug: "access", account: "52".repeat(32), grain_key: user.key, expires_at: t + DAY }, fromHex("52".repeat(32), 32), chain.genesis));
    assert.equal(fake.calls.account_get, 1);
    fake.shardBlock();
    t += 3_000;
    await ask(proof());
    assert.equal(fake.calls.account_get, 2, "read again on a new shard tip");
    fake.state.down = true;
    fake.block();
    t += 3_000;
    const failed = await ask(proof());
    assert.equal(failed.status.state, 3, "failed, not admitted");
    assert.match(failed.status.text, /could not check/);
    assert.equal(runs, 4);
    assert.equal(server.stopped, null, "an unreachable node stops nothing");
  } finally {
    user.client.close();
    await close();
  }
});

test("the numbers are signed at most hourly, count each user once, and reach wallets", async () => {
  const fake = fakeChain();
  let t = Date.now();
  const store = memoryChatStore();
  const { relay, server, close } = await studio(fake, { now: () => t, store });
  const a = await wallet(relay, 0x66, server.address, [serverKey]);
  const b = await wallet(relay, 0x67, server.address, [serverKey]);
  server.command("idle", () => card().text("idle"));
  try {
    const first = server.reported;
    assert.deepEqual(first.stats, { slug: "access", at: t, users_1d: 0, users_30d: 0, requests_30d: 0 });
    for (const [w, n] of [[a, 3], [b, 1]]) {
      for (let i = 0; i < n; i++) {
        const r = w.request("idle");
        await w.send(r);
        await w.until(() => w.answers(r.request.id).length === 1);
      }
    }
    assert.equal(await server.publishStats(), first, "not again within the hour");
    t += STATS_EVERY_MS;
    const next = await server.publishStats();
    assert.deepEqual(next.stats, { slug: "access", at: t, users_1d: 2, users_30d: 2, requests_30d: 4 });
    assert.equal(grainStatsProblem(next, { genesis: chain.genesis, slug: "access", servers: [serverKey], now: t }), null);
    assert.deepEqual(decodeChatDocument(server.document()).stats, next, "the well-known document carries them");
    // Each signing goes to the relay, whose node gossips it (22-grain-chats §4); a new connection gets it again.
    await waitFor(() => relay.stats.get("access")?.stats.at === t);
    assert.deepEqual(relay.stats.get("access"), next);
    const again = relay.next("grain_stats");
    relay.kick(server.address);
    assert.deepEqual(decodeSignedGrainStats(fromBase64Url((await again).stats)), next, "sent again on registering");
    assert.equal(grainStatsProblem(next, { genesis: chain.genesis, slug: "access", servers: [], now: t }), "key", "once the key is removed, no wallet shows them");
    // A day later, the numbers reach a user again before their next answer.
    t += DAY;
    const r = a.request("idle", [], { at: t, expires_at: t + DAY });
    await a.send(r);
    await a.until(() => a.answers(r.request.id).length === 1);
    assert.equal(a.frames.filter((f) => f.stats).length, 2);
    // A certified key reports nothing: no wallet would show numbers it signed.
    const certified = await ChatServer.start({ slug: "access", spec: signedSpec(), secret: SERVER, cert: cert(), chain, ownerKey, endpoints: [relay.endpoint()], log: quiet });
    assert.equal(await certified.publishStats(), null);
    assert.equal(certified.document().stats, undefined);
    certified.close();
  } finally {
    a.client.close();
    b.client.close();
    await close();
  }
});

test("a private app's numbers do not go to its relay, and go again once it is public", async () => {
  const fake = fakeChain();
  fake.state.grain.public = false;
  let t = Date.now();
  const { relay, server, events, close } = await studio(fake, { now: () => t });
  const user = await wallet(relay, 0x68, server.address, [serverKey]);
  server.command("idle", () => card().text("idle"));
  const reports = () => relay.sent.filter((f) => f.type === "grain_stats").length;
  const registers = () => relay.sent.filter((f) => f.type === "register").length;
  const logged = (event) => events.filter((e) => e.event === event).map((e) => e.meta);
  /** A new connection of the server, and time for it to send what it keeps for the relay. */
  const reconnect = async () => {
    const n = registers();
    relay.kick(server.address);
    await waitFor(() => registers() > n);
    await sleep(200);
  };
  try {
    // Private from the start: signed for its members' chats, but not sent to the relay nor put in the document.
    await waitFor(() => server.reported !== null);
    await sleep(200);
    assert.deepEqual(logged("stats_not_reported"), [{ reason: "private" }]);
    assert.equal(reports(), 0, "nothing to the relay");
    assert.equal(server.document().stats, undefined, "nor in the document");
    // An hour later: signed again, a registry read, a new connection; still nothing, and logged once.
    t += STATS_EVERY_MS;
    const signed = await server.publishStats();
    assert.equal(signed.stats.at, t);
    fake.block();
    assert.equal(await server.checkRegistry(), null);
    await reconnect();
    assert.equal(reports(), 0, "none sent again on registering");
    assert.equal(logged("stats_not_reported").length, 1, "logged once per change");

    // Public again: the newest numbers go at once, and are in the document.
    fake.state.grain.public = true;
    fake.block();
    assert.equal(await server.checkRegistry(), null);
    assert.deepEqual(logged("stats_resumed"), [{ reason: "public" }]);
    await waitFor(() => relay.stats.get("access")?.stats.at === t);
    assert.deepEqual(relay.stats.get("access"), signed);
    assert.deepEqual(decodeChatDocument(server.document()).stats, signed);

    // Private again, seen at a request's new beacon block: withheld before the request is refused, logged again.
    fake.state.grain.public = false;
    fake.block();
    t += 3_000;
    const r = user.request("idle", [], { at: t, expires_at: t + DAY });
    await user.send(r);
    await user.until(() => user.answers(r.request.id).length === 1);
    assert.match(user.answers(r.request.id)[0].message.blocks[0].status.text, /private/);
    assert.deepEqual(logged("stats_not_reported"), [{ reason: "private" }, { reason: "private" }]);
    const before = reports();
    t += STATS_EVERY_MS;
    await server.publishStats();
    await reconnect();
    assert.equal(reports(), before, "nothing more to the relay");
    assert.equal(server.document().stats, undefined);
    assert.equal(logged("stats_resumed").length, 1);
  } finally {
    user.client.close();
    await close();
  }
});
