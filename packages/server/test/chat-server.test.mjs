// The chat server through a relay, against a wallet that checks every card: requests checked and routed with typed
// arguments, answered once, refused or dropped as the spec says, the spec pushed, files uploaded, the unasked budget.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ed25519 } from "@noble/curves/ed25519";
import {
  ChatServer, ChatRefusal, ChatBudgetSpent, card, toHex, fromHex, chatDocumentOf, serveChatDocument, chatDocumentResponse,
  CHAT_DOCUMENT_PATH, CHAT_UNASKED_PER_DAY, memoryChatStore, downloadFile, signChatRequest, encodeChatFrame, newChatId,
  decodeNotification, openFrame, fromBase64Url, serverMessagingSecret, messagingPublic, derive,
} from "../dist/index.js";
import { createDevRelay } from "../../../scripts/dev-relay.mjs";
import { DAY, OWNER, SERVER, chain, ownerKey, quiet, spec, signedSpec, cert, options, serverOn, wallet, sleep } from "./chat-helpers.mjs";

test("a server starts only with a spec and a certificate a wallet takes", async () => {
  const relay = await createDevRelay();
  try {
    const refused = (over) => assert.rejects(ChatServer.start(options(relay, over)), undefined, JSON.stringify(Object.keys(over)));
    await assert.rejects(ChatServer.start(options(relay, { slug: "other" })), /chat spec: for access, not other/);
    await assert.rejects(ChatServer.start(options(relay, { cert: cert(Date.now() + 31 * DAY + 60_000) })), /more than 31 days/);
    await assert.rejects(ChatServer.start(options(relay, { cert: cert(Date.now() - 1) })), /expired/);
    await assert.rejects(ChatServer.start(options(relay, { cert: cert(undefined, "77".repeat(32)) })), /not for this server key/);
    await assert.rejects(ChatServer.start(options(relay, { spec: signedSpec(1, { revoked: [toHex(ed25519.getPublicKey(SERVER))] }) })), /revokes/);
    await assert.rejects(ChatServer.start(options(relay, { ownerKey: { ed25519: "11".repeat(32) } })), /signature/);
    const forged = signedSpec();
    forged.spec.intro = { en: "Something else" };
    await assert.rejects(ChatServer.start(options(relay, { spec: forged })), /signature/);
    const priced = { ...signedSpec(), spec: { ...spec(), commands: [{ ...spec().commands[0], price: 5n }] } };
    await assert.rejects(ChatServer.start(options(relay, { spec: priced })), /price/);
    await refused({ cert: { ...cert(), signature: "00".repeat(64) } });
    // Without the owner key the signatures are not checked, the rest is.
    const server = await ChatServer.start(options(relay, { ownerKey: undefined }));
    assert.throws(() => server.command("delete", () => {}), /no command delete/);
    assert.throws(() => server.setSpec(signedSpec(0)), /lower version|version/);
    server.close();
  } finally {
    await relay.close();
  }
});

test("a request is checked, routed by command with typed arguments, and answered with a signed card", async () => {
  const { relay, server, close } = await serverOn();
  const user = await wallet(relay, 0x41, server.address);
  try {
    let seen;
    server.command("key", (ask) => {
      seen = { args: ask.args, key: ask.key, user: ask.user, command: ask.command };
      return card().secret("Key", "7KQ2-M9XA-4F", { expiresAt: Date.now() + DAY }).fields({ Site: ask.args.site, For: `${ask.args.duration} s` })
        .status("done", "Opens the site once").run("Revoke", "revoke", { id: "k-0042" }).open("All keys", "keys").reply("Thanks");
    });
    const request = user.request("key", [["duration", { duration: 86_400 }], ["note", { text: "for the tester" }], ["site", { choice: "saltix-io" }]]);
    await user.send(request);
    await user.until(() => user.answers(request.request.id).length === 1);
    assert.deepEqual(seen, { args: { duration: 86_400, note: "for the tester", site: "saltix-io" }, key: user.key, user: user.address, command: "key" });

    // The spec first (the user had not been sent this version), then the answer, which the wallet shows.
    assert.ok("spec" in user.frames[0], "the spec came first");
    assert.equal(user.frames[0].spec.spec.spec.version, 1);
    const [answer] = user.answers(request.request.id);
    assert.equal(user.problem(answer), null);
    assert.equal(answer.message.replaces, null);
    assert.deepEqual(answer.message.blocks.map((b) => Object.keys(b)[0]), ["secret", "fields", "status"]);
    assert.deepEqual(answer.message.actions[0].kind, { run: { command: "revoke", args: [["id", { text: "k-0042" }]] } });
    assert.deepEqual(answer.message.actions[2].kind, { reply: { text: "Thanks" } });
    // Answered and taken off the server's mailbox.
    await sleep(100);
    assert.equal(relay.mailboxes.get(server.address)?.size ?? 0, 0);

    // The same request again (another frame): no second answer, and it leaves the mailbox too.
    await user.send(request);
    await sleep(300);
    assert.equal(user.answers(request.request.id).length, 1, "answered once");
    assert.equal(relay.mailboxes.get(server.address)?.size ?? 0, 0);
    assert.equal(user.frames.filter((f) => "spec" in f).length, 1, "the spec once");
  } finally {
    user.client.close();
    await close();
  }
});

test("requests that do not fit are refused with a reason; untrusted or expired ones are dropped", async () => {
  const { relay, server, close } = await serverOn();
  const user = await wallet(relay, 0x42, server.address);
  const other = await wallet(relay, 0x43, server.address);
  const handled = [];
  server.command("key", (ask) => { handled.push(ask.command); return card().text("ok"); });
  server.command("revoke", () => { throw new ChatRefusal("No key k-1 is yours."); });
  server.command("report", () => { throw new Error("database down"); });
  const status = (id) => user.answers(id)[0]?.message.blocks.find((b) => "status" in b)?.status;
  try {
    const cases = {
      unknown: user.request("delete"),
      argument: user.request("key", [["duration", { duration: 3_600 }], ["site", { choice: "saltix-io" }]]),
      missing: user.request("key", [["duration", { duration: 600 }]]),
      unserved: user.request("idle"),
      text: user.request("", [], { text: "hello" }),
      refusal: user.request("revoke", [["id", { text: "k-1" }]]),
      failure: user.request("report"),
    };
    for (const r of Object.values(cases)) await user.send(r);
    await user.until(() => Object.values(cases).every((r) => user.answers(r.request.id).length === 1));
    for (const r of Object.values(cases)) assert.equal(user.problem(user.answers(r.request.id)[0]), null, "a refusal is a signed card too");
    assert.equal(status(cases.unknown.request.id).state, 2);
    assert.match(status(cases.unknown.request.id).text, /no such command/);
    assert.match(status(cases.argument.request.id).text, /"duration"/);
    assert.match(status(cases.missing.request.id).text, /"site"/);
    assert.match(status(cases.unserved.request.id).text, /not served/);
    assert.match(status(cases.text.request.id).text, /commands, not text/);
    assert.deepEqual(status(cases.refusal.request.id), { state: 2, text: "No key k-1 is yours." });
    assert.deepEqual(status(cases.failure.request.id), { state: 3, text: "Something went wrong. Try again later." }, "no internals leak");
    assert.deepEqual(handled, [], "no handler ran for a request that does not fit");

    // Dropped: nothing in them can be trusted, or nobody waits. Each leaves the mailbox all the same.
    const forged = user.request("key", [["duration", { duration: 600 }], ["site", { choice: "web" }]]);
    forged.request.args[1][1] = { choice: "saltix-io" };
    const now = Date.now();
    const expired = user.request("key", [["duration", { duration: 600 }], ["site", { choice: "web" }]], { at: now - DAY, expires_at: now - 1 });
    const otherNetwork = signChatRequest({ ...user.request("idle").request }, user.secret, "6d".repeat(32));
    const otherGrain = user.request("idle", [], { slug: "chess" });
    for (const r of [forged, expired, otherNetwork, otherGrain]) await user.send(r);
    const relayed = user.request("idle");
    await other.send(relayed); // a request signed by user's key, sent from another address
    await sleep(500);
    for (const r of [forged, expired, otherNetwork, otherGrain, relayed]) {
      assert.equal(user.answers(r.request.id).length + other.answers(r.request.id).length, 0, "no answer");
    }
    assert.equal(relay.mailboxes.get(server.address)?.size ?? 0, 0, "acknowledged");
    assert.deepEqual(handled, []);
  } finally {
    user.client.close();
    other.client.close();
    await close();
  }
});

test("a working status is replaced by the answer, which carries a file the wallet downloads and checks", async () => {
  const { relay, server, close } = await serverOn();
  const user = await wallet(relay, 0x44, server.address);
  const csv = new TextEncoder().encode("day,sessions,errors\n2027-01-15,41,3\n".repeat(40_000)); // ~1.4 MiB: two pieces
  let release;
  const gate = new Promise((r) => (release = r));
  server.command("report", async (ask) => {
    await ask.working("Building the report…");
    await gate;
    const file = await server.upload(csv, { name: "report.csv", mime: "text/csv" });
    return card().text(`Top ${ask.args.top}, from ${ask.args.day}.`).file(file, { title: "Daily digest", format: "csv" }).status("done");
  });
  try {
    const request = user.request("report", [["day", { date: 20_468 }], ["top", { number: 5n }]]);
    await user.send(request);
    await user.until(() => user.answers(request.request.id).length === 1);
    const [working] = user.answers(request.request.id);
    assert.deepEqual(working.message.blocks, [{ status: { state: 0, text: "Building the report…" } }]);
    await sleep(100);
    assert.equal(relay.mailboxes.get(server.address)?.size, 1, "not acknowledged before it is answered");
    release();
    await user.until(() => user.answers(request.request.id).length === 2);
    const final = user.answers(request.request.id)[1];
    assert.equal(user.problem(final), null);
    assert.equal(final.message.replaces, working.message.id, "in place of the working status");
    assert.equal(final.message.blocks[0].text.text, "Top 5, from 2026-01-15.");
    const ref = final.message.blocks[1].file.file;
    assert.equal(ref.relay, null, "a developer's ws:// relay is the reader's own");
    assert.equal(ref.size, csv.length);
    assert.deepEqual(await downloadFile(ref, relay.endpoint()), csv);
    await assert.rejects(downloadFile({ ...ref, hash: "00".repeat(32) }, relay.endpoint()), /hash/, "a file is checked against the card");
    await sleep(100);
    assert.equal(relay.mailboxes.get(server.address)?.size ?? 0, 0, "acknowledged with the answer");
  } finally {
    user.client.close();
    await close();
  }
});

test("a newer spec reaches each user once, before the next answer", async () => {
  const { relay, server, close } = await serverOn();
  const user = await wallet(relay, 0x45, server.address);
  server.command("idle", () => card().text("idle"));
  try {
    const first = user.request("idle");
    await user.send(first);
    await user.until(() => user.answers(first.request.id).length === 1);
    assert.throws(() => server.setSpec(signedSpec(1, { revoked: [toHex(ed25519.getPublicKey(SERVER))] })), /revokes/);
    server.setSpec(signedSpec(2));
    assert.equal(server.document().spec, chatDocumentOf(signedSpec(2), cert()).spec, "the well-known document follows");
    for (let i = 0; i < 2; i++) {
      const r = user.request("idle");
      await user.send(r);
      await user.until(() => user.answers(r.request.id).length === 1);
    }
    const specs = user.frames.filter((f) => "spec" in f).map((f) => f.spec.spec.spec.version);
    assert.deepEqual(specs, [1, 2]);
    const order = user.frames.map((f) => ("spec" in f ? `spec ${f.spec.spec.spec.version}` : "answer"));
    assert.deepEqual(order, ["spec 1", "answer", "spec 2", "answer", "answer"]);
    assert.throws(() => server.setSpec(signedSpec(1)), /lower version/);
  } finally {
    user.client.close();
    await close();
  }
});

test("unasked messages and notifications share a budget of 10 a day per user", async () => {
  const { relay, server, close } = await serverOn();
  const a = await wallet(relay, 0x46, server.address);
  const b = await wallet(relay, 0x47, server.address);
  try {
    for (let i = 0; i < CHAT_UNASKED_PER_DAY; i++) await server.notify(a.address, card().text(`news ${i}`));
    await assert.rejects(server.notify(a.address, card().text("one more")), ChatBudgetSpent);
    await assert.rejects(server.notification(a.key, { title: "One more", body: "" }), ChatBudgetSpent, "by its grain key too");
    // Another user has a budget of their own; a notification counts in it.
    for (let i = 0; i < CHAT_UNASKED_PER_DAY - 1; i++) await server.notify(b.key, card().text(`news ${i}`));
    await server.notification(b.address, { title: "Your digest", body: "41 sessions", start: "digest" });
    await assert.rejects(server.notify(b.address, card().text("one more")), ChatBudgetSpent);
    await b.until(() => b.others.length === 1);
    const { notification, cert: c } = decodeNotification(b.others[0]);
    assert.equal(notification.title, "Your digest");
    assert.equal(c.key, toHex(ed25519.getPublicKey(SERVER)), "signed by the server key, with its certificate");
    await a.until(() => a.frames.filter((f) => f.message && f.message.message.answers === null).length === CHAT_UNASKED_PER_DAY);
    for (const f of a.frames) assert.equal(a.problem(f.message), null);
    await assert.rejects(server.notify("dsalt1notanaddress", card().text("x")), /personal address/);
  } finally {
    a.client.close();
    b.client.close();
    await close();
  }
});

test("the budget is any 24 hours, and a late update of an answer counts in it", async () => {
  const store = memoryChatStore();
  const t = 1_800_000_000_000;
  for (let i = 0; i < 10; i++) assert.ok(store.spend("u", t + i, 10));
  assert.ok(!store.spend("u", t + 10, 10));
  assert.ok(!store.spend("u", t + DAY - 1, 10), "within 24 hours of the first");
  assert.ok(store.spend("u", t + DAY + 1, 10), "the first is a day old");
  assert.ok(store.spend("v", t, 10), "per user");
  // Taken requests: once until they expire.
  assert.ok(store.take("u", "r1", t + 1_000, t));
  assert.ok(!store.take("u", "r1", t + 1_000, t + 999));
  assert.ok(store.take("u", "r2", t + 1_000, t), "another id");
  assert.ok(store.take("w", "r1", t + 1_000, t), "another user's id");
  store.forget("u", "r1");
  assert.ok(store.take("u", "r1", t + 1_000, t + 1), "forgotten: taken again");

  let now = Date.now();
  const { relay, server, close } = await serverOn({ now: () => now, store });
  const user = await wallet(relay, 0x48, server.address);
  let sent;
  server.command("idle", async (ask) => { sent = await ask.answer(card().status("working")); });
  try {
    const r = user.request("idle", [], { expires_at: now + 60_000 });
    await user.send(r);
    await user.until(() => user.answers(r.request.id).length === 1);
    await server.replace(sent, card().status("done"));
    for (let i = 0; i < 10; i++) await server.notify(user.address, card().text(`n${i}`));
    await assert.rejects(server.notify(user.address, card().text("x")), ChatBudgetSpent);
    const live = await server.replace(sent, card().status("done", "still answering")).catch((e) => e);
    assert.ok(!(live instanceof Error), "an update while the request lives answers it");
    now += 60_000;
    await assert.rejects(server.replace(sent, card().status("done", "late")), ChatBudgetSpent, "after it expired: unasked");
    await user.until(() => user.answers(r.request.id).length === 3);
    const updates = user.answers(r.request.id);
    assert.ok(updates.slice(1).every((m) => m.message.replaces === sent.id));
  } finally {
    user.client.close();
    await close();
  }
});

test("a request whose handling failed before an answer comes again from the mailbox and is answered once", async () => {
  const store = memoryChatStore();
  let fail = true;
  const flaky = { ...store, take: store.take.bind(store), forget: store.forget.bind(store), spend: store.spend.bind(store), setSpecSent: store.setSpecSent.bind(store),
    specSent(user) {
      if (fail) { fail = false; throw new Error("store unavailable"); }
      return store.specSent(user);
    } };
  const { relay, server, close } = await serverOn({ store: flaky });
  const user = await wallet(relay, 0x49, server.address);
  let runs = 0;
  server.command("idle", () => { runs++; return card().text("done"); });
  try {
    const r = user.request("idle");
    await user.send(r);
    await sleep(300);
    assert.equal(user.answers(r.request.id).length, 0);
    assert.equal(relay.mailboxes.get(server.address)?.size, 1, "still in the mailbox");
    relay.kick(server.address); // the server reconnects, and the mailbox comes again
    await user.until(() => user.answers(r.request.id).length === 1, 10_000);
    await sleep(200);
    assert.equal(runs, 1);
    assert.equal(user.answers(r.request.id).length, 1);
    assert.equal(relay.mailboxes.get(server.address)?.size ?? 0, 0);
  } finally {
    user.client.close();
    await close();
  }
});

test("uploads go on where the relay stands, start over once when it drops them, and wait for room", async () => {
  const { relay, server, close } = await serverOn();
  const bytes = new Uint8Array(2_500_000).map((_, i) => i % 251);
  const waits = [];
  const pause = async (ms) => { waits.push(ms); };
  const { uploadFile } = await import("../dist/index.js");
  try {
    // 507 twice: waits that grow, then the rest.
    let full = 2;
    relay.filePutHook = () => (full-- > 0 ? 507 : undefined);
    let ref = await uploadFile(server.relay, bytes, { name: "a.bin", mime: "application/octet-stream", pause });
    assert.deepEqual(waits, [2_000, 4_000]);
    assert.deepEqual(await downloadFile(ref, relay.endpoint()), bytes);

    // The relay loses bytes: a 409 sends the client back to where it stands.
    let lost = false;
    relay.filePutHook = (id, offset) => {
      const f = relay.files.get(id);
      if (!lost && offset === 2 * 1024 * 1024) { lost = true; f.bytes = f.bytes.subarray(0, 500_000); }
      return undefined;
    };
    ref = await uploadFile(server.relay, bytes, { name: "b.bin", mime: "application/octet-stream", pause });
    assert.ok(lost);
    assert.deepEqual(await downloadFile(ref, relay.endpoint()), bytes);

    // Dropped once: a new reservation. Dropped twice: it ends.
    let drops = 1;
    relay.filePutHook = () => (drops-- > 0 ? 404 : undefined);
    ref = await uploadFile(server.relay, bytes, { name: "c.bin", mime: "application/octet-stream", pause });
    assert.deepEqual(await downloadFile(ref, relay.endpoint()), bytes);
    relay.filePutHook = () => 404;
    await assert.rejects(uploadFile(server.relay, bytes, { name: "d.bin", mime: "application/octet-stream", pause }), /dropped the upload again/);
    waits.length = 0;
    relay.filePutHook = () => 507;
    await assert.rejects(uploadFile(server.relay, bytes, { name: "e.bin", mime: "application/octet-stream", pause }), /no room/);
    assert.equal(waits.length, 9);
    assert.equal(Math.max(...waits), 60_000);
    relay.filePutHook = null;
    await assert.rejects(uploadFile(server.relay, bytes, { name: "a/b", mime: "text/plain", pause }), /name/);
    await assert.rejects(uploadFile(server.relay, new Uint8Array(0), { name: "x", mime: "text/plain", pause }), /1 byte/);
  } finally {
    await close();
  }
});

test("the well-known document is served for any framework and for Node's http", async () => {
  const doc = chatDocumentOf(signedSpec(), cert());
  const r = chatDocumentResponse(doc);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.deepEqual(JSON.parse(r.body), doc);
  const http = createServer((req, res) => { if (!serveChatDocument(req, res, () => doc)) res.writeHead(404).end(); });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${http.address().port}`;
  try {
    const got = await fetch(base + CHAT_DOCUMENT_PATH);
    assert.equal(got.status, 200);
    assert.deepEqual(await got.json(), doc);
    assert.equal((await fetch(base + CHAT_DOCUMENT_PATH, { method: "POST" })).status, 404);
    assert.equal((await fetch(base + "/.well-known/saltix-grain")).status, 404);
  } finally {
    http.close();
  }
});

test("a run action's arguments are typed by the spec and checked; a card names a command the spec has", async () => {
  const { argsFor, valueOf, argOf } = await import("../dist/index.js");
  const [key, , report] = spec().commands;
  assert.deepEqual(argsFor(key, { site: "web", duration: 600 }), [["duration", { duration: 600 }], ["site", { choice: "web" }]], "sorted by name");
  assert.deepEqual(argsFor(report, { day: "2026-01-15", top: 7 }), [["day", { date: 20_468 }], ["top", { number: 7n }]]);
  assert.deepEqual(argsFor(key, {}), [], "a form left for the user to fill in");
  assert.throws(() => argsFor(key, { duration: 3_600 }), /duration: not a value/, "not among the options");
  assert.throws(() => argsFor(key, { site: "ftp" }), /site: not a value/);
  assert.throws(() => argsFor(key, { zone: "eu" }), /no parameter zone/);
  assert.throws(() => argsFor(report, { top: 101 }), /top/, "out of bounds");
  assert.throws(() => argsFor(report, { day: "2026-02-30" }), /day/);
  const money = { number: { min: 0n, max: 10_000n, decimals: 2 } };
  assert.deepEqual(valueOf(money, "12.5"), { number: 1_250n });
  assert.deepEqual(valueOf(money, "-0.01"), { number: -1n });
  assert.equal(valueOf(money, "1.234"), null, "more decimals than the parameter has");
  assert.equal(valueOf(money, 1.5), null);
  assert.equal(argOf({ date: 20_468 }), "2026-01-15");
  assert.equal(argOf({ number: 5n }), 5n);
  assert.throws(() => card().run("Delete", "delete").actions(() => undefined), /no command delete/);
});
