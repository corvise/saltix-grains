// The app's console (Saltix 24-app-studio §4, 22-grain-chats §3–§4): the grain's team proves itself to its own app,
// public or private, so the server learns where each member's chat is; it writes to the team within 100 unasked
// messages a day each; errors go to the team as cards made for an AI agent, scrubbed of secrets and folded within an
// hour.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import {
  ChatServer, ChatRefusal, ChatBudgetSpent, card, toHex, toBase64, fromHex, accountId, encodeAddress, signMemberProof, memoryChatStore,
  fileChatStore, ROLES, CHAT_UNASKED_PER_DAY, CHAT_UNASKED_TEAM_PER_DAY, REPORT_FOLD_MS, scrubSecrets, errorFacts, errorFingerprint,
  reportCard, reportStatus, chatMessageBoundsProblem, encodeChatFrame, signChatMessage, MAX_FRAME_BYTES, onTeam, teamMemberOf,
  needsTeamController, readPublishText, publishLink, teamOnly, UNOWNED, assertCardStandard, lintCard, CARD_LIMITS,
} from "../dist/index.js";
import { createDevRelay } from "../../../scripts/dev-relay.mjs";
import { createDevRegistry } from "../dist/dev.js";
import {
  DAY, OWNER, SERVER, chain, ownerKey, quiet, spec, signedSpec, cert, serverKey, appKey, fakeChain, wallet, sleep, manifest,
} from "./chat-helpers.mjs";

const accountOf = (secret) => toHex(accountId(ed25519.getPublicKey(secret)));
const DEV = fromHex("53".repeat(32), 32);
const VIEWER = fromHex("54".repeat(32), 32);
const USER = fromHex("55".repeat(32), 32);
const STRANGER = fromHex("56".repeat(32), 32);
const ownerAccount = toHex(accountId(fromHex(ownerKey.ed25519, 32)));
const HEX64 = "ab".repeat(32);

/** A report's rows as the copy for an agent reads them: its fields, then the text's `Label: value` lines before the
 *  message and the stack (the fields past the card's 8). */
function reportRows(blocks) {
  const rows = blocks.flatMap((b) => ("fields" in b ? b.fields.rows : []));
  const text = blocks.find((b) => "text" in b)?.text.text ?? "";
  for (const line of text.split("\n")) {
    if (line === "Message:" || line === "Stack:") break;
    const m = /^([^:]{1,40}): (.*)$/.exec(line);
    if (m) rows.push([m[1], m[2]]);
  }
  return Object.fromEntries(rows);
}

/** A server from the developer key on a development relay, reading `fake`'s chain, its log kept. */
async function studio(fake, over = {}) {
  const relay = await createDevRelay();
  const events = [];
  const log = (level, event, meta) => events.push({ level, event, meta });
  const server = await ChatServer.start({ appKey: appKey(), spec: spec(), wallet: fake.wallet, endpoints: [relay.endpoint()], log, ...over });
  return { relay, server, events, close: async () => { server.close(); await relay.close(); } };
}

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

/** `w`'s request signed with a member proof of the account `secret` (over: the proof's fields). */
const proved = (w, secret, t, over = {}, command = "idle") => w.request(command, [], {
  member: signMemberProof({ slug: "access", account: accountOf(secret), grain_key: w.key, expires_at: t + DAY, ...over }, secret, chain.genesis),
});

async function ask(w, signed) {
  await w.send(signed);
  await w.until(() => w.answers(signed.request.id).length >= 1);
  return w.answers(signed.request.id)[0].message;
}

/** The unasked messages `w` got so far. */
const unasked = (w) => w.frames.filter((f) => f.message && f.message.message.answers === null).map((f) => f.message);

/** Throws the same error from the same line every time. */
function boom(message = "Cannot read properties of undefined (reading 'site')") {
  throw new TypeError(message);
}
const caught = (f) => {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error("did not throw");
};

test("secrets are scrubbed: developer keys, long hex, the server's own and what the app names", () => {
  const key = `saltix-app:1:dsalt:6c6c6c6c6c6c6c6c:access:${HEX64}`;
  const text = `start ${key} failed; secret=${HEX64.toUpperCase()}; 0x${HEX64}; pair ${HEX64}${HEX64}; id ${"cd".repeat(16)}; short ${"e".repeat(63)}`;
  const out = scrubSecrets(text);
  assert.ok(!out.includes("saltix-app:1:"), "no trace of a developer key, its public parts included");
  assert.ok(!/[0-9a-f]{64}/i.test(out), "no run of 64 hex survives");
  assert.match(out, /\[developer key removed\] failed/);
  assert.match(out, /secret=\[hex removed\]/, "upper case too");
  assert.match(out, /0x\[hex removed\]/);
  assert.match(out, /pair \[hex removed\];/, "a longer run as one");
  assert.ok(out.includes("cd".repeat(16)), "a request id (32 hex) stays");
  assert.ok(out.includes("e".repeat(63)), "63 hex digits stay: name things by a prefix");
  // What the app names: exact text and patterns, every occurrence; nothing shorter than 8 characters.
  const named = scrubSecrets("token apitoken-123456 and apitoken-123456; Bearer abc.def.ghi; a", ["apitoken-123456", /Bearer [\w.]+/, "a"]);
  assert.equal(named, "token [removed] and [removed]; [removed]; a");
  const sticky = scrubSecrets("x9 y9 x9", [/x\d/]);
  assert.equal(sticky, "[removed] y9 [removed]", "a pattern without the g flag removes every match");
});

test("an error's facts: name, message, top frame, frames and causes, scrubbed; anything thrown", () => {
  const e = caught(() => boom());
  const f = errorFacts(e);
  assert.equal(f.name, "TypeError");
  assert.equal(f.message, "Cannot read properties of undefined (reading 'site')");
  assert.match(f.top, /^at boom \(.*console\.test\.mjs:\d+:\d+\)$/);
  assert.ok(f.stack.split("\n").every((l) => l.startsWith("at ")), "frames only: the message is not repeated");
  assert.equal(f.refusal, false);
  assert.equal(errorFingerprint(f), errorFingerprint(errorFacts(caught(() => boom()))), "the same error, the same fingerprint");
  assert.notEqual(errorFingerprint(f), errorFingerprint(errorFacts(caught(() => boom("other")))), "another message, another");
  assert.notEqual(errorFingerprint(f), errorFingerprint(errorFacts(new TypeError(f.message))), "another place, another");

  const outer = new Error(`could not mint for ${HEX64}`, { cause: new RangeError(`bad key ${HEX64}`, { cause: "the node said no" }) });
  const g = errorFacts(outer, ["the node"]);
  assert.equal(g.message, "could not mint for [hex removed]");
  assert.match(g.stack, /Caused by: RangeError: bad key \[hex removed\]/);
  assert.match(g.stack, /Caused by: \[removed\] said no/);
  assert.ok(!g.stack.includes(HEX64));
  assert.equal(errorFacts(new ChatRefusal("no")).refusal, true);
  assert.deepEqual(errorFacts("plain words"), { name: "Error", message: "plain words", top: "", stack: "", refusal: false });
  assert.equal(errorFacts({ code: 7 }).message, '{"code":7}');
  assert.equal(errorFacts(null).name, "thrown null");
});

test("a report card fits a card's bounds whatever the error says", () => {
  const long = new Error(`${"line\twith\u0001control\r\n".repeat(400)}\uD800 lone`);
  long.stack = `Error: x\n${Array.from({ length: 600 }, (_, i) => `    at f${i} (/srv/app/server.mjs:${i}:1)`).join("\n")}`;
  const context = { command: "/key", request: "ab".repeat(16), version: "1.4.2" };
  for (let i = 0; i < 20; i++) context[`extra_${i}_${"k".repeat(50)}`] = `v${i}\n${HEX64}`;
  const c = reportCard(errorFacts(long), { slug: "access", at: Date.UTC(2026, 9, 15, 12, 0, 0), context, specVersion: 3, folded: { times: 7, since: Date.UTC(2026, 9, 15, 11, 0, 0) } });
  const message = { slug: "access", id: "00".repeat(16), at: Date.now(), answers: null, replaces: null, blocks: c.blocks, actions: [] };
  assert.equal(chatMessageBoundsProblem(message), null);
  const frame = encodeChatFrame({ message: signChatMessage(message, SERVER, chain.genesis) });
  assert.ok(frame.length <= MAX_FRAME_BYTES);
  const [status, fields, text] = c.blocks;
  assert.equal(status.status.state, 3, "failed");
  assert.ok([...status.status.text].length <= CARD_LIMITS.status, status.status.text);
  // The card standard: a status first, at most 60 characters, at most 8 rows of fields; nothing it warns of.
  assert.doesNotThrow(() => assertCardStandard(c), JSON.stringify(lintCard(c)));
  assert.equal(fields.fields.rows.length, CARD_LIMITS.fields, "the standard's 8 rows of fields");
  assert.deepEqual(fields.fields.rows.map(([l]) => l), ["App", "Error", "Message", "Where", "Command", "Request", "App version", "Chat spec"]);
  // The rest lead the text, a line each, none lost: 16 rows in all as before, as the copy for an agent reads them.
  const rows = reportRows(c.blocks);
  assert.equal(Object.keys(rows).length, 16, "16 rows at most, the same as before");
  assert.equal(rows.App, "access");
  assert.equal(rows.Command, "/key");
  assert.equal(rows.Request, "ab".repeat(16));
  assert.equal(rows["App version"], "1.4.2");
  assert.equal(rows["Chat spec"], "v3");
  assert.equal(rows["Time (UTC)"], "2026-10-15T12:00:00.000Z");
  assert.equal(rows.Occurrences, "×7 since the last report, 2026-10-15T11:00:00.000Z");
  assert.ok(!JSON.stringify(fields).includes(HEX64), "context values scrubbed");
  assert.match(text.text.text, /^Time \(UTC\): 2026-10-15T12:00:00\.000Z\nOccurrences: ×7 since/);
  assert.match(text.text.text, /\nMessage:\n/);
  assert.match(text.text.text, /\n… \d+ more lines$/, "cut at a line, saying how much is left");
  assert.ok([...text.text.text].length <= 4_000);

  // A refusal reported says refused; a card without a stack or a long message has no text block, and no occurrences.
  const r = reportCard(errorFacts(new ChatRefusal("no")), { slug: "access", at: 0 });
  assert.equal(r.blocks[0].status.state, 2);
  assert.equal(r.blocks[0].status.text, "Refused · no");
  const plain = reportCard(errorFacts("short"), { slug: "access", at: 0 });
  assert.equal(plain.blocks.length, 2);
  assert.ok(!plain.blocks[1].fields.rows.some(([label]) => label === "Occurrences"));
  assert.doesNotThrow(() => assertCardStandard(plain));
});

test("a report's status is a short title, cut at a word; the name and the message in full are the card's", () => {
  // A named error: its name.
  const typed = errorFacts(new TypeError("Cannot read properties of undefined (reading 'site')"));
  assert.equal(reportStatus(typed), "Error · TypeError");
  // A plain Error, a thrown string: the message says what it is, cut at a word within 60 characters.
  const words = errorFacts(new Error("could not mint the access key because the node at the city did not answer in time"));
  const s = reportStatus(words);
  assert.equal(s, "Error · could not mint the access key because the node at…");
  assert.ok([...s].length <= CARD_LIMITS.status);
  assert.equal(reportStatus(errorFacts("short")), "Error · short");
  // A word that ends right at the limit stays whole; a single word longer than half the limit is cut where it must be.
  const whole = "abcd ".repeat(10) + "a bcdef";
  assert.equal(reportStatus(errorFacts(new Error(whole))), "Error · abcd abcd abcd abcd abcd abcd abcd abcd abcd abcd a…");
  assert.equal(reportStatus(errorFacts(new Error("abcd ".repeat(10) + "abc def"))), "Error · abcd abcd abcd abcd abcd abcd abcd abcd abcd abcd…");
  const long = reportStatus(errorFacts(new Error("x".repeat(200))));
  assert.equal([...long].length, CARD_LIMITS.status);
  assert.ok(long.startsWith("Error · xxx") && long.endsWith("…"));
  // A refusal: refused, and the words it gave the user; nothing to say: just the head.
  assert.equal(reportStatus(errorFacts(new ChatRefusal("Not yours."))), "Refused · Not yours.");
  assert.equal(reportStatus(errorFacts(new Error(""))), "Error");
  // Newlines and controls never reach the title; the full message is still the card's.
  const multi = new Error("first line\nsecond line");
  assert.equal(reportStatus(errorFacts(multi)), "Error · first line second line");
  const c = reportCard(errorFacts(new TypeError("Cannot read properties of undefined (reading 'site')")), { slug: "access", at: 0 });
  assert.equal(reportRows(c.blocks).Message, "Cannot read properties of undefined (reading 'site')");
  assert.equal(reportRows(c.blocks).Error, "TypeError");
});

test("the team: who the registry names, and where each member's chat is once their proof showed it", async () => {
  const fake = teamChain();
  let t = Date.now();
  const store = memoryChatStore();
  const { relay, server, events, close } = await studio(fake, { now: () => t, store });
  const seen = [];
  server.command("idle", (a) => { seen.push({ member: a.member, team: a.fromTeam }); return card().text("idle"); });
  const owner = await wallet(relay, 0x71, server.address, [serverKey]);
  const dev = await wallet(relay, 0x72, server.address, [serverKey]);
  const viewer = await wallet(relay, 0x73, server.address, [serverKey]);
  const user = await wallet(relay, 0x74, server.address, [serverKey]);
  const stranger = await wallet(relay, 0x75, server.address, [serverKey]);
  try {
    let team = await server.team();
    assert.deepEqual(team.map((m) => [m.account, m.owner, m.roles, m.address]), [
      [ownerAccount, true, 7, null], [accountOf(DEV), false, ROLES.developer, null], [accountOf(VIEWER), false, ROLES.viewer, null],
    ], "the owner, then developers and viewers; a user alone is not on the team");

    // A public grain: anyone is answered; nobody is known without a proof.
    await ask(owner, owner.request("idle"));
    assert.deepEqual(seen.pop(), { member: null, team: false });
    const calls = fake.calls.account_get;
    // Proofs that do not show a team member are ignored, and cost the node nothing: a stranger's, a mere user's, a
    // proof for another key, an expired one.
    await ask(stranger, proved(stranger, STRANGER, t));
    await ask(user, proved(user, USER, t));
    await ask(dev, proved(dev, DEV, t, { grain_key: "77".repeat(32) }));
    await ask(dev, proved(dev, DEV, t, { expires_at: t - 1 }));
    assert.equal(fake.calls.account_get, calls, "no account asked for");
    // A proof of the developer's account signed by another key: asked, and refused as the account's keys say.
    const forged = dev.request("idle", [], {
      member: { ...signMemberProof({ slug: "access", account: accountOf(DEV), grain_key: dev.key, expires_at: t + DAY }, STRANGER, chain.genesis) },
    });
    await ask(dev, forged);
    assert.deepEqual(seen.splice(0), Array(5).fill({ member: null, team: false }), "still answered, as anyone in a public grain");
    assert.ok(events.filter((e) => e.event === "chat_team_proof_ignored").length >= 5);
    team = await server.team();
    assert.ok(team.every((m) => m.address === null), "nobody learned");

    // The team's own proofs: the server learns their chats, and handlers see who asked.
    await ask(owner, proved(owner, OWNER, t));
    assert.deepEqual(seen.pop(), { member: { account: ownerAccount, roles: 7 }, team: true });
    await ask(dev, proved(dev, DEV, t));
    assert.deepEqual(seen.pop(), { member: { account: accountOf(DEV), roles: ROLES.developer }, team: true });
    team = await server.team();
    assert.equal(team[0].address, owner.address);
    assert.equal(team[1].address, dev.address);
    assert.equal(team[2].address, null, "the viewer has not written yet");
    assert.deepEqual(store.team(), { [ownerAccount]: owner.address, [accountOf(DEV)]: dev.address }, "kept by the store");
    assert.ok(!JSON.stringify(events).includes(ownerAccount) && !JSON.stringify(events).includes(owner.address), "the log names nobody");

    // Removed from the members at a beacon block: no longer on the team, and forgotten.
    fake.state.grain.members = fake.state.grain.members.filter((m) => m.account !== accountOf(DEV));
    fake.block();
    t += 3_000;
    team = await server.team();
    assert.deepEqual(team.map((m) => m.account), [ownerAccount, accountOf(VIEWER)]);
    assert.deepEqual(store.team(), { [ownerAccount]: owner.address });
    await ask(dev, proved(dev, DEV, t));
    assert.deepEqual(seen.pop(), { member: null, team: false }, "a former developer's proof shows nothing");
  } finally {
    for (const w of [owner, dev, viewer, user, stranger]) w.client.close();
    await close();
  }
});

test("a private grain learns its team from the proofs it admits, and its viewers' though it refuses them", async () => {
  const fake = teamChain();
  fake.state.grain.public = false;
  const t = Date.now();
  const store = memoryChatStore();
  const { relay, server, close } = await studio(fake, { now: () => t, store });
  server.command("idle", () => card().text("idle"));
  const viewer = await wallet(relay, 0x76, server.address, [serverKey]);
  const user = await wallet(relay, 0x77, server.address, [serverKey]);
  try {
    const refused = await ask(viewer, proved(viewer, VIEWER, t));
    assert.equal(refused.blocks[0].status.state, 2, "a viewer does not use a private grain");
    const admitted = await ask(user, proved(user, USER, t));
    assert.equal(admitted.blocks[0].text.text, "idle");
    assert.deepEqual(store.team(), { [accountOf(VIEWER)]: viewer.address }, "a user admitted is not remembered");
    const team = await server.team();
    assert.equal(team.find((m) => m.account === accountOf(VIEWER)).address, viewer.address, "the viewer is reachable");
    assert.ok(!team.some((m) => m.account === accountOf(USER)), "a user is not the team");
  } finally {
    viewer.client.close();
    user.client.close();
    await close();
  }
});

test("writing to the team: by role, skipping who cannot be reached, within 100 a day each", async () => {
  const fake = teamChain();
  let t = Date.now();
  const store = memoryChatStore();
  const { relay, server, events, close } = await studio(fake, { now: () => t, store });
  server.command("idle", () => card().text("idle"));
  const owner = await wallet(relay, 0x78, server.address, [serverKey]);
  const viewer = await wallet(relay, 0x79, server.address, [serverKey]);
  const stranger = await wallet(relay, 0x7a, server.address, [serverKey]);
  try {
    await ask(owner, proved(owner, OWNER, t));
    await ask(viewer, proved(viewer, VIEWER, t));
    await ask(stranger, stranger.request("idle"));

    // The owner and the developers by default: the developer has not written, so only the owner gets it.
    const first = await server.notifyTeam(card().text("A user wrote: the key did not open the site"));
    assert.deepEqual(first, { sent: 1, unreachable: 1, spent: 0, failed: 0 });
    await owner.until(() => unasked(owner).length === 1);
    assert.equal(owner.problem(unasked(owner)[0]), null, "a card the owner's wallet takes");
    assert.equal(unasked(viewer).length, 0, "not the viewer, unless asked");
    assert.deepEqual(await server.notifyTeam(card().text("for viewers"), { roles: ["viewer"] }), { sent: 1, unreachable: 0, spent: 0, failed: 0 });
    await viewer.until(() => unasked(viewer).length === 1);
    assert.equal(unasked(owner).length, 1, "the owner plays the owner only");
    const logged = events.filter((e) => e.event === "chat_team_notified");
    assert.deepEqual(logged[0].meta, { sent: 1, unreachable: 1, spent: 0, failed: 0 }, "counts only");

    // The team's budget is 100 a day, a stranger's 10, whichever way the app writes.
    assert.equal(CHAT_UNASKED_TEAM_PER_DAY, 100);
    for (let i = 0; i < 20; i++) assert.ok(store.spend(owner.address, t, CHAT_UNASKED_TEAM_PER_DAY));
    assert.equal((await server.notifyTeam(card().text("the 22nd today"))).sent, 1, "past 10 for the team");
    for (let i = 0; i < CHAT_UNASKED_TEAM_PER_DAY - 23; i++) assert.ok(store.spend(owner.address, t, CHAT_UNASKED_TEAM_PER_DAY));
    await server.notify(owner.address, card().text("the hundredth"));
    const spent = await server.notifyTeam(card().text("one too many"));
    assert.deepEqual(spent, { sent: 0, unreachable: 1, spent: 1, failed: 0 });
    await assert.rejects(server.notify(owner.key, card().text("x")), (e) => e instanceof ChatBudgetSpent && e.limit === CHAT_UNASKED_TEAM_PER_DAY);
    for (let i = 0; i < CHAT_UNASKED_PER_DAY; i++) await server.notify(stranger.address, card().text(`${i}`));
    await assert.rejects(server.notify(stranger.address, card().text("x")), (e) => e instanceof ChatBudgetSpent && e.limit === CHAT_UNASKED_PER_DAY);
    // Past 10, a member keeps the team's budget only while on the team.
    for (let i = 0; i < CHAT_UNASKED_PER_DAY; i++) store.spend(viewer.address, t, CHAT_UNASKED_TEAM_PER_DAY);
    fake.state.grain.members = [];
    fake.block();
    t += 3_000;
    await assert.rejects(server.notify(viewer.address, card().text("x")), ChatBudgetSpent, "no longer on the team: 10 a day");

    // Bad calls throw before anything goes out.
    await assert.rejects(server.notifyTeam(card()), /chat message/, "a card without blocks");
    await assert.rejects(server.notifyTeam(card().text("x"), { roles: [] }), /roles/);
    await assert.rejects(server.notifyTeam(card().text("x"), { roles: ["admin"] }), /roles/);
  } finally {
    for (const w of [owner, viewer, stranger]) w.client.close();
    await close();
  }
});

test("an update is proposed to the team in the console, for the owner to approve", async () => {
  const fake = teamChain();
  const t = Date.now();
  const { relay, server, events, close } = await studio(fake);
  server.command("idle", () => card().text("idle"));
  const owner = await wallet(relay, 0x78, server.address, [serverKey]);
  const dev = await wallet(relay, 0x7b, server.address, [serverKey]);
  const viewer = await wallet(relay, 0x79, server.address, [serverKey]);
  const stranger = await wallet(relay, 0x7a, server.address, [serverKey]);
  // The registry's chat-only v1, with a sealed screen: v2.
  const next = {
    ...manifest().manifest, version: 2, permissions: 0,
    entry: { sealed: { bundle: "88".repeat(32), size: 4096, sources: ["https://download.saltix.io/apps/screens/a.zip"], start: "index.html", connect: ["https://api.saltix.io"] } },
  };
  try {
    // Nobody on the team has written yet: nobody is reached, and the owner is told apart.
    const early = await server.proposeUpdate(next);
    assert.deepEqual(early, { sent: 0, unreachable: 2, spent: 0, failed: 0, version: 2, owner: false });
    assert.equal(events.find((e) => e.event === "chat_update_proposed").level, "warn");

    // The developer has written, the owner not yet: it went, but not to the one who approves it.
    await ask(dev, proved(dev, DEV, t));
    assert.deepEqual(await server.proposeUpdate(next), { sent: 1, unreachable: 1, spent: 0, failed: 0, version: 2, owner: false });
    await dev.until(() => unasked(dev).length === 1);

    await ask(owner, proved(owner, OWNER, t));
    await ask(viewer, proved(viewer, VIEWER, t));
    await ask(stranger, stranger.request("idle"));
    const sent = await server.proposeUpdate(next);
    assert.deepEqual(sent, { sent: 2, unreachable: 0, spent: 0, failed: 0, version: 2, owner: true });
    await owner.until(() => unasked(owner).length === 1);
    await dev.until(() => unasked(dev).length === 2);
    const card0 = unasked(owner)[0];
    assert.equal(owner.problem(card0), null, "a card the owner's wallet takes");
    assert.ok(teamOnly(card0.message));
    const [action] = card0.message.actions;
    assert.equal(action.label, "Review the update");
    assert.deepEqual(readPublishText(action.kind.publish.manifest), { ...next, ...UNOWNED });
    assert.match(card0.message.blocks[0].text.text, /^Access has a new version \(2\)\. The owner approves it here\.$/);
    assert.equal(unasked(viewer).length, 0, "viewers only when asked");
    assert.equal(unasked(stranger).length, 0, "never anyone off the team");
    const logged = events.filter((e) => e.event === "chat_update_proposed").at(-1);
    assert.deepEqual(logged, { level: "info", event: "chat_update_proposed", meta: { version: 2, sent: 2, unreachable: 0, spent: 0, failed: 0, owner: true } });

    // By its link, with the team's viewers and words of the app's own.
    const byLink = await server.proposeUpdate(publishLink(next), { roles: ["owner", "viewer"], text: "A screen of its own.", label: "Approve" });
    assert.equal(byLink.sent, 2);
    await viewer.until(() => unasked(viewer).length === 1);
    assert.equal(unasked(viewer)[0].message.actions[0].label, "Approve");

    // Another grain's manifest, a version the registry holds, roles without the owner: refused before anything goes.
    await assert.rejects(server.proposeUpdate({ ...next, slug: "other" }), /not access's/);
    await assert.rejects(server.proposeUpdate({ ...next, version: 1 }), /registry holds access v1/);
    await assert.rejects(server.proposeUpdate(next, { roles: ["developer"] }), /owner/);
    await assert.rejects(server.proposeUpdate("salt:grain-publish?m=AAAA"), /a manifest to publish/);
    assert.equal((await server.registered(true)).version, 1, "what the registry holds");
    fake.state.grain.version = 2;
    fake.block();
    assert.equal((await server.registered(true)).version, 2);
    await assert.rejects(server.proposeUpdate(next), /registry holds access v2/, "approved: nothing left to propose");
    assert.equal(unasked(owner).length, 2, "the owner got the two proposals that went");
  } finally {
    for (const w of [owner, dev, viewer, stranger]) w.client.close();
    await close();
  }
});

test("an update proposed with its bundle: the bundle goes into the network first, on the server key's word", async () => {
  const fake = teamChain();
  // The network's blob store, as a node keeps it: statements checked against the registry's server keys.
  const store = createDevRegistry({ slug: "access", ownerSecret: OWNER, servers: [serverKey], genesis: chain.genesis });
  const answer = fake.wallet.call.bind(fake.wallet);
  fake.wallet.call = (method, params) => (method.startsWith("blob_") ? store.call(method, params) : answer(method, params));
  const vectors = JSON.parse(readFileSync(new URL("../../../vectors/images-v1.json", import.meta.url), "utf8"));
  const zip = fromHex(vectors.bundles.made[0].hex);
  const { relay, server, events, close } = await studio(fake);
  const owner = await wallet(relay, 0x78, server.address, [serverKey]);
  const next = {
    ...manifest().manifest, version: 2, permissions: 0,
    entry: { sealed: { bundle: vectors.bundles.made[0].hash, size: zip.length, sources: [], start: "index.html", connect: [] } },
  };
  try {
    await ask(owner, proved(owner, OWNER, Date.now()));
    const proposal = await server.proposeUpdate(next, { bundle: zip });
    assert.deepEqual(proposal.bundle, { hash: vectors.bundles.made[0].hash, pending: true });
    assert.equal(proposal.owner, true);
    assert.ok(store.blobs.get(proposal.bundle.hash).pendingUntil > Date.now(), "held pending for its day");
    assert.ok(events.some((e) => e.event === "blob_kept"));
    // Not the manifest's bundle: refused before anything goes.
    await assert.rejects(server.proposeUpdate(next, { bundle: zip.subarray(1) }), /not the bundle the manifest names/);
    // A key the registry no longer names: the network refuses its word, and nothing is proposed.
    store.setServers(["22".repeat(32)]);
    const before = unasked(owner).length;
    const other = { ...next, entry: { sealed: { ...next.entry.sealed } } };
    store.blobs.clear();
    await assert.rejects(server.proposeUpdate(other, { bundle: zip }), (e) => e.name === "BlobRefused" && e.reason === "key");
    await owner.until(() => unasked(owner).length === before);
  } finally {
    owner.client.close();
    await close();
  }
});

test("a handler's error reaches the team as a card for an AI agent; the same error folds for an hour", async () => {
  const fake = teamChain();
  let t = Date.now();
  const { relay, server, events, close } = await studio(fake, { now: () => t, version: "1.4.2", redact: ["tok-secret-0123456789"] });
  server.command("idle", () => card().text("idle"));
  server.command("key", () => boom());
  server.command("revoke", () => { throw new ChatRefusal("Not yours."); });
  server.command("report", () => { throw new Error(`minted with ${HEX64} and tok-secret-0123456789 under ${appKey().reveal()} (${toBase64(SERVER, true)})`); });
  const owner = await wallet(relay, 0x7b, server.address, [serverKey]);
  const user = await wallet(relay, 0x7c, server.address, [serverKey]);
  const reports = () => unasked(owner);
  try {
    await ask(owner, proved(owner, OWNER, t));
    const r = user.request("key", [["duration", { duration: 600 }], ["site", { choice: "web" }]]);
    const answer = await ask(user, r);
    assert.equal(answer.blocks[0].status.state, 3, "the user gets failed");
    assert.match(answer.blocks[0].status.text, /went wrong/);
    await owner.until(() => reports().length === 1);
    const [report] = reports();
    assert.equal(owner.problem(report), null);
    const [status, fields, stack] = report.message.blocks;
    assert.equal(status.status.state, 3);
    assert.equal(status.status.text, "Error · TypeError");
    assert.equal(fields.fields.rows.length, 8, "the card standard's 8 rows; the ninth leads the text");
    const rows = reportRows(report.message.blocks);
    assert.equal(rows.Error, "TypeError");
    assert.equal(rows.Message, "Cannot read properties of undefined (reading 'site')");
    assert.equal(rows.Command, "/key");
    assert.equal(rows.Request, r.request.id);
    assert.equal(rows["App version"], "1.4.2");
    assert.equal(rows["Chat spec"], "v2");
    assert.match(rows.Where, /^boom \(/);
    assert.equal(rows["Time (UTC)"], new Date(t).toISOString());
    assert.match(stack.text.text, /^Time \(UTC\): .+\nStack:\nat boom/);
    assert.ok(!events.some((e) => e.event === "card_standard"), `the server's lint is silent: ${JSON.stringify(events.filter((e) => e.event === "card_standard"))}`);
    assert.equal(user.frames.filter((f) => f.message?.message.answers === null).length, 0, "nothing reaches the user but the answer");

    // The same error again within the hour: folded, nothing sent.
    assert.equal(REPORT_FOLD_MS, 3_600_000, "an hour");
    for (let i = 0; i < 3; i++) await ask(user, user.request("key", [["duration", { duration: 600 }], ["site", { choice: "web" }]]));
    await sleep(200);
    assert.equal(reports().length, 1);
    assert.equal((await server.report(caught(() => boom()))).folded, true);
    t += REPORT_FOLD_MS - 1;
    assert.equal((await server.report(caught(() => boom()))).folded, true, "a millisecond before the hour");
    // Another error is not the same one.
    assert.deepEqual(await server.report(caught(() => boom("another"))), { folded: false, sent: 1, unreachable: 1, spent: 0, failed: 0 });
    await owner.until(() => reports().length === 2);
    // The hour is over: the next one goes, counting those folded.
    t += 1;
    const next = await server.report(caught(() => boom()), { context: { command: "/key", shard: 3 } });
    assert.equal(next.folded, false);
    await owner.until(() => reports().length === 3);
    const third = reportRows(reports()[2].message.blocks);
    assert.equal(third.Occurrences, `×6 since the last report, ${new Date(t - REPORT_FOLD_MS).toISOString()}`);
    assert.equal(third.shard, "3", "the context's further keys, past the fields in the text");

    // Refusals are answers, not errors; secrets never reach a card or the log.
    await ask(user, user.request("revoke", [["id", { text: "k-1" }]]));
    await ask(user, user.request("report"));
    await owner.until(() => reports().length === 4);
    const leaked = JSON.stringify(reports()[3].message.blocks);
    for (const secret of [HEX64, "tok-secret-0123456789", toHex(SERVER), toBase64(SERVER, true), "saltix-app:1:"]) assert.ok(!leaked.includes(secret), secret);
    assert.match(leaked, /minted with \[hex removed\] and \[removed\] under \[developer key removed\] \(\[removed\]\)/);
    const log = JSON.stringify(events);
    for (const secret of [HEX64, "tok-secret-0123456789", toHex(SERVER), toBase64(SERVER, true)]) assert.ok(!log.includes(secret), `log: ${secret}`);
    assert.equal(reports().length, 4, "the refusal was not reported");
  } finally {
    owner.client.close();
    user.client.close();
    await close();
  }
});

test("folded errors are counted after the hour even when they stop", async () => {
  const fake = teamChain();
  let t = Date.now();
  const { relay, server, close } = await studio(fake, { now: () => t });
  server.command("idle", () => card().text("idle"));
  const owner = await wallet(relay, 0x7d, server.address, [serverKey]);
  try {
    await ask(owner, proved(owner, OWNER, t));
    const start = t;
    await server.report(caught(() => boom()));
    t += 60_000;
    await server.report(caught(() => boom()));
    await server.report(caught(() => boom()));
    assert.equal(await server.flushReports(), 0, "not within the hour");
    t = start + REPORT_FOLD_MS;
    assert.equal(await server.flushReports(), 1);
    await owner.until(() => unasked(owner).length === 2);
    const rows = reportRows(unasked(owner)[1].message.blocks);
    assert.equal(rows.Occurrences, `×2 since the last report, ${new Date(start).toISOString()}`);
    assert.equal(await server.flushReports(), 0, "counted once");
    // The flush starts a new hour: the next one within it folds.
    assert.equal((await server.report(caught(() => boom()))).folded, true);
  } finally {
    owner.client.close();
    await close();
  }
});

test("reports are off on request, and never throw where the team cannot be found", async () => {
  const fake = teamChain();
  const t = Date.now();
  const { relay, server, close } = await studio(fake, { now: () => t, reportErrors: false });
  server.command("idle", () => card().text("idle"));
  server.command("key", () => boom());
  const owner = await wallet(relay, 0x7e, server.address, [serverKey]);
  try {
    await ask(owner, proved(owner, OWNER, t));
    await ask(owner, owner.request("key", [["duration", { duration: 600 }], ["site", { choice: "web" }]]));
    await sleep(300);
    assert.equal(unasked(owner).length, 0, "reportErrors: false");
    // A certified key without a node has no registry: no team, and report says so in the log rather than throwing.
    const events = [];
    const certified = await ChatServer.start({
      slug: "access", spec: signedSpec(), secret: SERVER, cert: cert(), chain, ownerKey, endpoints: [relay.endpoint()],
      log: (level, event, meta) => events.push({ event, meta }),
    });
    assert.deepEqual(await certified.report(new Error("x")), { folded: false, sent: 0, unreachable: 0, spent: 0, failed: 0 });
    assert.match(events.find((e) => e.event === "chat_report_failed").meta.reason, /registry/);
    await assert.rejects(certified.team(), /registry/);
    certified.close();
  } finally {
    owner.client.close();
    await close();
  }
});

test("the team's addresses survive a restart in a file store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "console-"));
  const fake = teamChain();
  const t = Date.now();
  try {
    const first = await studio(fake, { now: () => t, store: fileChatStore(join(dir, "chat.json")) });
    first.server.command("idle", () => card().text("idle"));
    const owner = await wallet(first.relay, 0x7f, first.server.address, [serverKey]);
    await ask(owner, proved(owner, OWNER, t));
    owner.client.close();
    await first.close();
    const second = await studio(fake, { now: () => t, store: fileChatStore(join(dir, "chat.json")) });
    assert.equal((await second.server.team())[0].address, encodeAddress("devnet", accountId(fromHex(owner.key, 32))));
    await second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the team's checks, as functions", () => {
  const access = { owner: "aa".repeat(32), public: true, members: [{ account: "bb".repeat(32), roles: ROLES.user | ROLES.developer }, { account: "cc".repeat(32), roles: ROLES.viewer }, { account: "dd".repeat(32), roles: ROLES.user }] };
  assert.equal(onTeam(access, "aa".repeat(32)), true, "the owner");
  assert.equal(onTeam(access, "bb".repeat(32)), true, "a developer who also uses it");
  assert.equal(onTeam(access, "cc".repeat(32)), true, "a viewer");
  assert.equal(onTeam(access, "dd".repeat(32)), false, "a user");
  assert.equal(onTeam(access, "ee".repeat(32)), false, "a stranger");
  const key = toHex(ed25519.getPublicKey(fromHex("60".repeat(32), 32)));
  const now = Date.now();
  const team = { ...access, members: [...access.members, { account: accountOf(DEV), roles: ROLES.developer }] };
  const proof = signMemberProof({ slug: "access", account: accountOf(DEV), grain_key: key, expires_at: now + DAY }, DEV, chain.genesis);
  const check = { genesis: chain.genesis, slug: "access", requestKey: key, proof, now, controller: null };
  assert.equal(needsTeamController(team, check), true);
  assert.equal(teamMemberOf(team, check), accountOf(DEV));
  assert.equal(teamMemberOf(access, check), null, "not on this grain's team");
  assert.equal(needsTeamController(access, check), false, "and its proof costs the node nothing");
  assert.equal(teamMemberOf(team, { ...check, controller: { devices: [{ key: { ed25519: "88".repeat(32) }, kind: "phone" }] } }), null, "a key that no longer speaks for it");
  assert.equal(teamMemberOf(team, { ...check, requestKey: "77".repeat(32) }), null, "another grain key");
  assert.equal(teamMemberOf(team, { ...check, genesis: "6d".repeat(32) }), null, "another network");
  assert.equal(teamMemberOf(team, { ...check, proof: null }), null);
});
