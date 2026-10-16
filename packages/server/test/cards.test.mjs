// The card standard (Saltix 22-grain-chats §4, §5a): the poll and code blocks as the protocol's vectors have them, the
// standard's layout reproduced case by case, the card builder's poll typed by the spec, the lint, and a vote answered in
// place of its poll through a relay.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  card, fromHex, toHex, decodeChatFrame, encodeChatFrame, encodeSignedChatMessage, signChatMessage, chatMessageToSign,
  chatMessageProblem, chatMessageBoundsProblem, decodeSignedChatSpec, requestFitProblem, cardLayout, isDestructive, perRow, pollLook,
  shares, isToken, isImage, isWide, lintCard, assertCardStandard, CARD_LIMITS, SHORT_LABEL, MEDIUM_LABEL, THREE_FROM_DP,
  TWO_FROM_DP, MAX_CHOICES, SEGMENTED_OPTIONS, SEGMENTED_LABEL, TOKEN_CHARS, TEXT_LINES, CODE_LINES, IMAGE_FORMATS, DESTRUCTIVE,
  encodeAddress, accountId,
} from "../dist/index.js";
import { ed25519 } from "@noble/curves/ed25519";
import { spec as helperSpec, serverOn, wallet } from "./chat-helpers.mjs";

const v = JSON.parse(readFileSync(new URL("../../../vectors/grain-chats-v1.json", import.meta.url), "utf8"));
const chain = { genesis: v.chain.genesis_hash_hex, network: v.chain.network };
const NOW = Number(v.now_ms);
const SERVER = fromHex(v.keys.server_secret_hex, 32);
const servers = v.keys.registered_servers;
const ownerKey = { ed25519: v.keys.owner_public_hex };
const serverAddress = encodeAddress("devnet", accountId(ed25519.getPublicKey(SERVER)));
const vspec = decodeSignedChatSpec(v.spec_doc.signed_hex).spec;

/** The vectors' card with a poll and code (grain_chat_vectors.rs, `poll`), in this SDK's form. */
const pollMessage = () => {
  const pick = (label, seconds, votes) => ({ label, args: [["duration", { duration: seconds }], ["site", { choice: "saltix-io" }]], votes });
  return {
    slug: "access", id: "36".repeat(16), at: NOW + 4_000, answers: null, replaces: null,
    blocks: [
      {
        poll: {
          question: "How long should a new key open saltix.io?", command: "key",
          options: [pick("10 minutes", 600, 3), pick("1 day", 86_400, 12), pick("30 days", 2_592_000, 5)], chosen: 1, closed: false, tally: true,
        },
      },
      { code: { text: "curl -H 'X-Saltix-Key: 7KQ2-M9XA-4F' \\\n  https://saltix.io/" } },
    ],
    actions: [{ label: "Revoke", kind: { run: { command: "revoke", args: [["id", { text: "k-0042" }]] } } }],
  };
};

test("a card with a poll and code is the node's, and what the file says is refused is refused", () => {
  const p = v.poll;
  const signed = signChatMessage(pollMessage(), SERVER, chain.genesis);
  assert.equal(toHex(chatMessageToSign(pollMessage(), chain.genesis)), p.message_hex);
  assert.equal(toHex(encodeSignedChatMessage(signed)), p.signed_hex);
  assert.equal(toHex(encodeChatFrame({ message: signed })), p.frame_hex);
  const read = decodeChatFrame(fromHex(p.frame_hex)).message;
  assert.deepEqual(read, signed);
  const check = (m) => chatMessageProblem(m, { chain, ownerKey, servers, spec: vspec, from: serverAddress, now: NOW + 5_000 });
  assert.equal(check(read), null);
  // Each option's vote is a request the spec takes.
  for (const o of read.message.blocks[0].poll.options) {
    const request = { slug: "access", id: "15".repeat(16), at: NOW, expires_at: NOW + 60_000, via: read.message.id, command: "key", args: o.args, text: "", member: null, lang: "en" };
    assert.equal(requestFitProblem(request, vspec), null, o.label);
  }
  assert.equal(p.refused.length, 5);
  for (const r of p.refused) {
    const m = decodeChatFrame(fromHex(r.frame_hex)).message;
    assert.equal(check(m), "bounds:block", r.why);
    assert.equal(chatMessageBoundsProblem(m.message), "bounds:block", r.why);
    assert.throws(() => signChatMessage(m.message, SERVER, chain.genesis), /chat message/, r.why);
  }
  // Tabs and other control characters stay out of a code block's bytes; line breaks are kept.
  const bad = { ...pollMessage(), blocks: [{ code: { text: "a\tb" } }] };
  assert.equal(chatMessageBoundsProblem(bad), "bounds:block");
});

test("the standard's layout is the protocol's, case by case", () => {
  const c = v.cards;
  assert.deepEqual(
    [SHORT_LABEL, MEDIUM_LABEL, THREE_FROM_DP, TWO_FROM_DP, MAX_CHOICES, SEGMENTED_OPTIONS, SEGMENTED_LABEL, TOKEN_CHARS, TEXT_LINES, CODE_LINES],
    [c.constants.short_label, c.constants.medium_label, c.constants.three_from_dp, c.constants.two_from_dp, c.constants.max_choices,
      c.constants.segmented_options, c.constants.segmented_label, c.constants.token_chars, c.constants.text_lines, c.constants.code_lines],
  );
  assert.deepEqual([...IMAGE_FORMATS], c.constants.image_formats);
  assert.deepEqual([...DESTRUCTIVE], c.constants.destructive);
  assert.ok(c.layouts.length >= 15);
  for (const k of c.layouts) {
    const actions = k.actions.map((a) => ({
      label: a.label,
      kind: a.kind === "run" ? { run: { command: a.command, args: [] } } : a.kind === "open" ? { open: { start: "home" } }
        : a.kind === "reply" ? { reply: { text: a.label } } : { publish: { manifest: "x" } },
    }));
    const layout = cardLayout(actions, k.per_row);
    assert.deepEqual(layout.emphasis, k.emphasis, k.why);
    assert.deepEqual(layout.rows, k.rows, k.why);
  }
  for (const [name, expected] of Object.entries(c.destructive)) assert.equal(isDestructive(name), expected, name);
  for (const [value, expected] of Object.entries(c.tokens)) assert.equal(isToken(value), expected, value);
  for (const k of c.polls) assert.equal(pollLook(k.labels.map((label) => ({ label, args: [], votes: 0 })), k.closed, k.tally), k.look, JSON.stringify(k));
  for (const k of c.shares) assert.deepEqual(shares(k.votes), k.shares, JSON.stringify(k.votes));
  for (const k of c.per_row) assert.equal(perRow(k.width_dp), k.per_row, String(k.width_dp));
  assert.ok(isImage("png") && !isImage("pdf"));
  assert.ok(isWide(pollMessage()));
  assert.ok(!isWide({ blocks: [{ text: { text: "Hi" } }, { status: { state: 1, text: "" } }], actions: [] }));
});

test("a poll's options are typed by the spec when the card is sent, as a run's arguments", () => {
  const s = helperSpec();
  const commandOf = (name) => s.commands.find((c) => c.name === name);
  const c = card().poll("How long?", "key", [
    { label: "10 minutes", args: { duration: 600, site: "saltix-io" }, votes: 2 },
    { label: "1 day", args: { duration: 86_400, site: "web" } },
  ], { chosen: 0 });
  const [poll] = c.typedBlocks(commandOf);
  assert.deepEqual(poll.poll.options[0].args, [["duration", { duration: 600 }], ["site", { choice: "saltix-io" }]]);
  assert.deepEqual(poll.poll.options[1].args, [["duration", { duration: 86_400 }], ["site", { choice: "web" }]]);
  assert.equal(poll.poll.tally, true, "votes given: a tally");
  assert.equal(poll.poll.chosen, 0);
  assert.equal(card().poll("Which?", "key", [{ label: "A" }, { label: "B" }]).blocks[0].poll.tally, false, "a choice");
  assert.throws(() => card().poll("Which?", "nope", [{ label: "A" }, { label: "B" }]).typedBlocks(commandOf), /no command nope/);
  assert.throws(() => card().poll("Which?", "key", [{ label: "A", args: { duration: 5 } }, { label: "B" }]).typedBlocks(commandOf), /key.duration/);
  assert.equal(card().code("a\tb").blocks[0].code.text, "a    b", "tabs become spaces");
});

test("the lint says what a card does against the standard, and nothing for a good one", () => {
  const s = helperSpec();
  const good = card().status("done", "Your key is ready").secret("Key", "7KQ2").fields({ Site: "saltix.io" })
    .run("Renew", "key", { duration: 600, site: "saltix-io" }).run("Revoke", "revoke", { id: "k-1" }).open("All keys", "keys");
  assert.deepEqual(lintCard(good, s), []);
  assert.doesNotThrow(() => assertCardStandard(good, s));
  const rules = (c, sp) => lintCard(c, sp).map((w) => w.rule);

  // Too many actions, too many rows, a long label.
  const crowded = card().text("x");
  for (let i = 0; i < 7; i++) crowded.reply(`Answer number ${i}`);
  assert.deepEqual([...new Set(rules(crowded))], ["actions", "rows"]);
  assert.deepEqual(rules(card().text("x").reply("Show me everything you have")), ["label"]);
  assert.throws(() => assertCardStandard(crowded), /actions: 7 actions/);
  // Four runs of one command want a poll.
  const four = card().text("x");
  for (const d of ["1", "2", "3", "4"]) four.run(d, "key");
  assert.ok(rules(four).includes("choice"));
  // A status is the title: first, short, one.
  assert.deepEqual(rules(card().text("x").status("done")), ["status-first"]);
  assert.deepEqual(rules(card().status("done", "x".repeat(CARD_LIMITS.status + 1))), ["status-length"]);
  assert.deepEqual(rules(card().status("working").status("done")), ["statuses"]);
  // Tables go as files; a long text and long code collapse.
  const rows = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`Row ${i}`, "v"]));
  assert.deepEqual(rules(card().fields(rows)), ["fields"]);
  assert.deepEqual(rules(card().text("x".repeat(CARD_LIMITS.text + 1))), ["text-length"]);
  assert.deepEqual(rules(card().text("a\nb\nc\nd\ne\nf\ng\nh\ni")), ["text-length"]);
  assert.ok(rules(card().code(Array(41).fill("x").join("\n"))).includes("code-length"));
  // Polls: one a card, few options, a short question; and older wallets drop them.
  const options = (n) => Array.from({ length: n }, (_, i) => ({ label: `Option ${i}` }));
  assert.deepEqual(rules(card().poll("Which?", "key", options(3))), ["new-blocks"]);
  assert.deepEqual(rules(card().poll("Which?", "key", options(7))), ["new-blocks", "poll-options"]);
  assert.deepEqual(rules(card().poll("Which?", "key", options(2)).poll("And?", "key", options(2))), ["polls", "new-blocks"]);
  assert.deepEqual(rules(card().poll("x".repeat(101), "key", options(2))), ["new-blocks", "question"]);
  assert.doesNotThrow(() => assertCardStandard(card().poll("Which?", "key", options(3))), "info is not a breach");
  assert.throws(() => assertCardStandard(card().poll("Which?", "key", options(3)), undefined, { strict: true }), /new-blocks/);
  // With the spec: commands it lacks, and destructive ones it does not mark confirm.
  assert.deepEqual(rules(card().text("x").run("Go", "fly"), s), ["unknown-command"]);
  const unconfirmed = { ...s, commands: s.commands.map((c) => (c.name === "revoke" ? { ...c, confirm: false } : c)) };
  assert.deepEqual(rules(card().text("x").run("Revoke", "revoke", { id: "k" }), unconfirmed), ["danger-confirm"]);
  // A publish is the owner's panel and never counts as an action.
  const many = card().text("x");
  for (const l of ["A", "B", "C", "D", "E", "F"]) many.reply(l);
  assert.deepEqual(rules(many.publish("Review", "AAAA")), []);
});

test("a vote is answered in place of its poll, with the new votes and the user's choice", async () => {
  const { relay, server, close } = await serverOn();
  const user = await wallet(relay, 0x51, server.address);
  try {
    const votes = { "saltix-io": 0, web: 0 };
    const pollCard = (chosen) => card().poll("Where do you test?", "key", [
      { label: "saltix.io", args: { duration: 600, site: "saltix-io" }, votes: votes["saltix-io"] },
      { label: "Web", args: { duration: 600, site: "web" }, votes: votes.web },
    ], { chosen });
    server.command("report", () => pollCard(null));
    server.command("key", async (ask) => {
      votes[ask.args.site]++;
      await ask.update(pollCard(ask.args.site === "web" ? 1 : 0));
    });
    const ask = user.request("report", []);
    await user.send(ask);
    await user.until(() => user.answers(ask.request.id).length === 1);
    const [first] = user.answers(ask.request.id);
    assert.equal(user.problem(first), null);
    const option = first.message.blocks[0].poll.options[1];
    const vote = user.request("key", option.args, { via: first.message.id });
    await user.send(vote);
    await user.until(() => user.answers(vote.request.id).length === 1);
    const [updated] = user.answers(vote.request.id);
    assert.equal(user.problem(updated), null);
    assert.equal(updated.message.replaces, first.message.id, "in place of the poll");
    assert.deepEqual(updated.message.blocks[0].poll.options.map((o) => o.votes), [0, 1]);
    assert.equal(updated.message.blocks[0].poll.chosen, 1);
    assert.equal(updated.message.blocks[0].poll.tally, true);
  } finally {
    user.client.close();
    await close();
  }
});
