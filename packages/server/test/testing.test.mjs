// The test harness an app's tests use (`@saltix/grain-server/testing`): its chat end to end on a development relay and
// registry, wallets that check every card as Saltix does, the owner and members with proofs, strangers without.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { testChat } from "@saltix/grain-server/testing";
import { createDevRegistry } from "@saltix/grain-server/dev";
import {
  ChatRefusal, RelayClient, card, chatSpecFromJson, encodeChatFrame, newChatId, signChatMessage, ROLES, fromHex, toHex,
} from "../dist/index.js";
import { scratch } from "../../../scripts/scratch.mjs";

const en = (text) => ({ en: text });
const SPEC = {
  slug: "coach", version: 2, intro: en("Plans a workout."), keeps: 0, ai: false,
  commands: [
    {
      name: "plan", title: en("Plan"), help: en("A workout plan"),
      params: [
        { name: "minutes", title: en("Minutes"), required: true, kind: { number: { min: 5, max: 120 } } },
        { name: "level", title: en("Level"), required: true, kind: { choice: { options: [{ value: "easy", title: en("Easy") }, { value: "hard", title: en("Hard") }] } } },
        { name: "outdoor", title: en("Outdoors"), kind: "flag" },
      ],
    },
    { name: "slow", title: en("Slow"), help: en("Works first"), params: [] },
    { name: "who", title: en("Who"), help: en("Who asks"), params: [] },
    { name: "broken", title: en("Broken"), help: en("Fails"), params: [] },
    { name: "idle", title: en("Idle"), help: en("Not served"), params: [] },
  ],
};

/** The app under test: its handlers, as an app's `chat.mjs` exports them. */
function handlers(chat) {
  chat.command("plan", (ask) => {
    const minutes = Number(ask.args.minutes);
    if (ask.args.level === "hard" && minutes < 10) throw new ChatRefusal(ask.lang === "ru" ? "Слишком мало." : "Too short for hard.");
    const sets = Math.max(1, Math.floor(minutes / (ask.args.level === "hard" ? 5 : 10)));
    return card().fields({ Minutes: String(minutes), Sets: String(sets), Where: ask.args.outdoor ? "outdoors" : "indoors" })
      .text(ask.lang === "ru" ? "Готово" : "Ready").status("done").run("Again", "plan", { minutes: ask.args.minutes, level: ask.args.level });
  });
  chat.command("slow", async (ask) => {
    await ask.working("Thinking…");
    return card().text("Done thinking").status("done");
  });
  chat.command("who", (ask) => card().fields({ Team: String(ask.fromTeam), Account: ask.member?.account ?? "none" }));
  chat.command("broken", () => {
    const sessions = undefined;
    return card().text(`${sessions.length}`);
  });
  chat.text((ask) => card().text(`You wrote ${ask.text.length} characters`));
}

test("a command typed by the spec, answered with a card a wallet shows, in the user's language", async (t) => {
  const chat = await testChat({ spec: SPEC, setup: handlers });
  t.after(() => chat.close());
  const reply = await chat.ask("plan", { minutes: 30n, level: "hard" });
  assert.deepEqual(reply.fields, { Minutes: "30", Sets: "6", Where: "indoors" });
  assert.deepEqual(reply.status, { state: "done", text: "" });
  assert.equal(reply.text, "Ready");
  assert.deepEqual(reply.actions[0], { label: "Again", kind: { run: { command: "plan", args: [["level", { choice: "hard" }], ["minutes", { number: 30n }]] } } });
  const ru = await chat.ask("plan", { minutes: 20, level: "easy", outdoor: true }, { lang: "ru" });
  assert.deepEqual([ru.text, ru.fields.Sets, ru.fields.Where], ["Готово", "2", "outdoors"], "an integer is taken for a number");
  assert.equal((await chat.say("hello there")).text, "You wrote 11 characters");
  // Refusals come back as the wallet shows them; a request the spec does not allow never leaves the test.
  const short = await chat.ask("plan", { minutes: 5n, level: "hard" }, { lang: "ru" });
  assert.deepEqual(short.status, { state: "refused", text: "Слишком мало." });
  assert.equal((await chat.ask("idle")).status.state, "refused", "a command with no handler");
  await assert.rejects(chat.ask("nope"), /no command nope/);
  await assert.rejects(chat.ask("plan", { minutes: "thirty", level: "hard" }), /plan\.minutes: not a value/);
  await assert.rejects(chat.ask("plan", { minutes: 30n, level: "medium" }), /plan\.level/);
  assert.ok(chat.logs.some((l) => l.event === "chat_started") && chat.logs.some((l) => l.event === "chat_request"), "the server's log is kept");
  assert.ok(chat.logs.every((l) => !JSON.stringify(l).includes(toHex(chat.appKey.secret()))), "and never holds the key");
});

test("a working status, then the answer that replaces it; a failing handler answers failed and reports to the team", async (t) => {
  const chat = await testChat({ spec: SPEC, setup: handlers });
  t.after(() => chat.close());
  const slow = await chat.ask("slow");
  assert.equal(slow.text, "Done thinking");
  assert.deepEqual(slow.working.map((m) => m.blocks), [[{ status: { state: 0, text: "Thinking…" } }]]);
  assert.equal(slow.message.replaces, slow.working[0].id);
  const owner = chat.as("owner");
  await owner.hello(); // the owner's console, known before anyone writes
  const failed = await chat.ask("broken");
  assert.equal(failed.status.state, "failed");
  const [report] = await owner.unasked(1);
  assert.equal(report.status.state, "failed");
  assert.match(report.text + JSON.stringify(report.fields), /TypeError/);
  assert.equal(report.fields.Command, "/broken");
});

test("a private app: the owner and members get answers that know them, a stranger a refusal", async (t) => {
  const chat = await testChat({ spec: SPEC, setup: handlers, access: "private", members: { ann: ["user"], dev: ["user", "developer"] } });
  t.after(() => chat.close());
  const refused = await chat.ask("who");
  assert.deepEqual(refused.status, { state: "refused", text: "This app is private: only its owner and members can use it." });
  const ann = chat.as("ann");
  assert.deepEqual((await ann.ask("who")).fields, { Team: "false", Account: ann.account });
  const dev = chat.as("dev");
  assert.equal((await dev.ask("who")).fields.Team, "true");
  assert.equal((await chat.as("owner").ask("who")).fields.Account, chat.registry.grain.owner);
  assert.deepEqual(chat.registry.grain.members.map((m) => m.roles).sort(), [ROLES.user, ROLES.user | ROLES.developer].sort());
  await assert.rejects(chat.as("stranger").hello(), /not on the app's team/);
  // The registry changes at the next block, which the server reads within seconds, or now when asked: public, so
  // anyone is answered.
  chat.registry.setAccess(true, []);
  await chat.chat.checkRegistry();
  assert.equal((await chat.ask("who")).fields.Team, "false");
  assert.throws(() => chatSpecFromJson({ ...SPEC, members: 1 }), /members/, "the spec's JSON is read strictly");
});

test("unasked messages reach a user who connected; a card from anyone but the app's server fails the test", async (t) => {
  const chat = await testChat({ spec: SPEC, setup: handlers });
  t.after(() => chat.close());
  const user = chat.as("bob");
  await user.connect();
  await chat.chat.notify(user.address, card().text("Your plan is ready"));
  assert.equal((await user.unasked(1))[0].text, "Your plan is ready");
  // An impostor writes to the user as if it were the app: the wallet would not show it, and the harness says so.
  const impostor = await RelayClient.connect({ endpoints: [chat.relay.endpoint()], secret: new Uint8Array(32).fill(0x66), network: "devnet", log: () => {} });
  t.after(() => impostor.close());
  const forged = signChatMessage({ slug: "coach", id: newChatId(), at: Date.now(), answers: null, replaces: null, blocks: [{ text: { text: "Pay me" } }], actions: [] },
    new Uint8Array(32).fill(0x66), chat.registry.genesis);
  await impostor.send(user.address, encodeChatFrame({ message: forged }), { keep: true });
  await assert.rejects(user.ask("who"), /a frame from dsalt1.*not the app's server/);
});

test("the spec from chat.json, and a server started by the app's own start function", async (t) => {
  const dir = scratch("harness-");
  writeFileSync(join(dir, "chat.json"), JSON.stringify(SPEC));
  const started = [];
  const chat = await testChat({
    spec: join(dir, "chat.json"),
    start: async (options) => {
      started.push(Object.keys(options).sort());
      const { ChatServer } = await import("../dist/index.js");
      const server = await ChatServer.start({ ...options, version: "1.2.3" });
      handlers(server);
      return server;
    },
    timeoutMs: 3_000,
  });
  t.after(() => chat.close());
  assert.deepEqual(started, [["appKey", "endpoints", "log", "spec", "wallet"]]);
  assert.equal(chat.appKey.slug, "coach");
  assert.equal(chat.appKey.network, "devnet");
  assert.equal(chat.chat.spec.version, 2);
  assert.equal((await chat.ask("plan", { minutes: 60n, level: "easy" }, { timeoutMs: 2_000 })).fields.Sets, "6");
  // A setup that throws closes what the harness started and passes the error on.
  await assert.rejects(testChat({ spec: SPEC, setup: () => { throw new Error("no database"); } }), /no database/);
  await assert.rejects(testChat({ spec: SPEC, members: { owner: ["user"] } }), /the owner is there already/);
});

test("the development registry answers as a node's wallet interface, each change a new block", async () => {
  const owner = fromHex("41".repeat(32), 32);
  const r = createDevRegistry({ slug: "coach", ownerSecret: owner, servers: ["aa".repeat(32)] });
  const before = await r.call("node_status");
  assert.equal(before.network, "devnet");
  assert.match(before.genesis, /^[0-9a-f]{64}$/);
  const { grain } = await r.call("grain_get", { slug: "coach" });
  assert.deepEqual([grain.public, grain.servers, grain.retired, "chat" in grain.manifest.manifest.entry], [true, ["aa".repeat(32)], null, true]);
  assert.equal((await r.call("grain_get", { slug: "other" })).grain, null);
  r.setServers([]);
  assert.notEqual((await r.call("node_status")).beacon.hash, before.beacon.hash);
  assert.deepEqual((await r.call("grain_get", { slug: "coach" })).grain.servers, []);
  r.retire();
  assert.notEqual((await r.call("grain_get", { slug: "coach" })).grain.retired, null);
  await assert.rejects(r.call("transaction_submit", {}), /does not answer transaction_submit/);
});

test("the development node's clocks are a node's of Consensus 2: the registry's position by the heights, the slot by their pace", async () => {
  const owner = fromHex("41".repeat(32), 32);
  const NOW = 1_800_000_000_000;
  const r = createDevRegistry({ slug: "coach", ownerSecret: owner, servers: [], now: () => NOW });
  const s = await r.call("node_status");
  assert.deepEqual([s.epoch_slots, s.epoch_heights, s.pace, s.epochs_ahead], [2400, 1600, 2000, []]);
  // At height 1 the next beacon block's position is ⌊2 · 2400 / 1600⌋; the slot, a height of 2 000 ms gone, is 2.
  assert.deepEqual([s.beacon.height, s.position, s.slot, s.epoch], [1, 3, 2, 0]);
  assert.equal((s.genesis_time + s.slot) * 1000, NOW, "the node's time is the computer's");
  for (let i = 0; i < 99; i++) r.block();
  const t = await r.call("node_status");
  assert.deepEqual([t.beacon.height, t.position, t.slot], [100, 151, 200]);
  assert.ok(t.slot > t.position, "the slots run ahead of the registry's clock, as on the test network");
  // What the registry keeps is dated by its clock: the record's last change, at height 100.
  assert.equal((await r.call("grain_get", { slug: "coach" })).grain.updated, 150);
  r.retire();
  assert.equal((await r.call("grain_get", { slug: "coach" })).grain.retired, 151);
  // An epoch is 1 600 heights: the block after height 1 599 opens epoch 1.
  for (let i = 0; i < 1_498; i++) r.block();
  const before = await r.call("node_status");
  assert.deepEqual([before.beacon.height, before.position, before.epoch], [1_599, 2_400, 1]);
  const prior = createDevRegistry({ slug: "coach", ownerSecret: owner, servers: [] });
  for (let i = 0; i < 1_597; i++) prior.block();
  assert.equal((await prior.call("node_status")).epoch, 0, "height 1 598: the next block is the epoch's last");
  // A node that has not measured its pace yet says so; a faster chain's slots run behind its positions.
  const fresh = createDevRegistry({ slug: "coach", ownerSecret: owner, servers: [], clock: { kind: "consensus2", measured: false } });
  assert.equal((await fresh.call("node_status")).pace, null);
  const fast = createDevRegistry({ slug: "coach", ownerSecret: owner, servers: [], clock: { kind: "consensus2", paceMs: 1_000 } });
  for (let i = 0; i < 99; i++) fast.block();
  const f = await fast.call("node_status");
  assert.deepEqual([f.slot, f.position, f.pace], [100, 151, 1_000]);
  // The longest chain: a block a slot, the position the slot, no heights' epoch and no pace.
  const old = createDevRegistry({ slug: "coach", ownerSecret: owner, servers: [], clock: { kind: "longest" } });
  old.block();
  const o = await old.call("node_status");
  assert.deepEqual([o.slot, o.position, o.epoch_heights, o.pace, o.epoch], [2, 2, null, null, 0]);
  assert.equal((await old.call("grain_get", { slug: "coach" })).grain.updated, 2);
  // A clock no network has is refused.
  assert.throws(() => createDevRegistry({ slug: "coach", ownerSecret: owner, servers: [], clock: { kind: "consensus2", epochHeights: 3_000 } }), /clock/);
  assert.throws(() => createDevRegistry({ slug: "coach", ownerSecret: owner, servers: [], clock: { kind: "consensus2", paceMs: 0 } }), /clock/);
});

test("a card a wallet would not show fails the test: here, dated 10 minutes ahead", async (t) => {
  const { ChatServer } = await import("../dist/index.js");
  const chat = await testChat({
    spec: SPEC, timeoutMs: 3_000,
    start: async (options) => {
      const server = await ChatServer.start({ ...options, now: () => Date.now() + 10 * 60_000 });
      handlers(server);
      return server;
    },
  });
  t.after(() => chat.close());
  await assert.rejects(chat.ask("who"), /a card a wallet would not show: time/);
});
