// The example grain (examples/hello-grain) is what developers copy first, so every card it sends follows the card design
// standard (docs/cards.md, 22-grain-chats §5a): run end to end on the SDK's own harness, each answer checked as Saltix
// checks it and against the standard, and the server's own lint (`card_standard`) silent.
import test from "node:test";
import assert from "node:assert/strict";
import { assertCardStandard, lintCard } from "../dist/index.js";
import { testChat } from "../dist/testing.js";
import { startChat } from "../../../examples/hello-grain/chat.mjs";

const spec = new URL("../../../examples/hello-grain/chat.json", import.meta.url);

test("every card hello-grain sends follows the card standard: a status first, when it has one", async () => {
  // `fail` also sends the team the SDK's own error report (report.ts): it follows the standard too, so the server's lint
  // stays silent with it on.
  const t = await testChat({ spec, start: (options) => startChat(options) });
  try {
    const replies = {
      hello: await t.ask("hello", { name: "Ann" }),
      "hello (the owner)": await t.as("owner").ask("hello", {}),
      key: await t.ask("key", { site: "docs", duration: 3600 }),
      report: await t.ask("report", { day: "2026-01-02", top: 3n, errors_only: true }),
      "report (a day to come)": await t.ask("report", { day: "2999-01-01" }),
      fail: await t.ask("fail", {}),
      text: await t.say("hi"),
    };
    for (const [what, reply] of Object.entries(replies)) {
      assert.doesNotThrow(() => assertCardStandard(reply.message, t.chat.spec, { strict: false }), `${what}: ${JSON.stringify(lintCard(reply.message, t.chat.spec))}`);
      for (const working of reply.working) assert.doesNotThrow(() => assertCardStandard(working, t.chat.spec), `${what}: its working status`);
      const statuses = reply.blocks.flatMap((b, i) => ("status" in b ? [i] : []));
      assert.ok(statuses.length === 0 || (statuses.length === 1 && statuses[0] === 0), `${what}: a status is the card's first block`);
    }
    // The cards are what the example says they are.
    assert.equal(replies.key.status.state, "done");
    assert.ok("secret" in replies.key.blocks[1], "the key's secret right under its status");
    assert.equal(replies.report.status.state, "done");
    assert.ok(replies.report.blocks.some((b) => "file" in b), "the report as a file");
    assert.equal(replies.report.working.length, 1, "a working status first, replaced by the answer");
    assert.equal(replies["report (a day to come)"].status.state, "refused");
    assert.equal(replies.fail.status.state, "failed");
    // `fail`'s report went to the team (it is sent after the answer: waited for, a bounded while).
    for (let i = 0; i < 50 && !t.logs.some((l) => l.event === "chat_error_reported"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(t.logs.some((l) => l.event === "chat_error_reported"), "fail's error reached the team");
    assert.deepEqual(t.logs.filter((l) => l.event === "card_standard"), [], "the server's own lint found nothing, the report included");
  } finally {
    await t.close();
  }
});
