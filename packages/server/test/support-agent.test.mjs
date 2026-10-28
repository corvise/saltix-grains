// The support agent (examples/support-agent, docs/support.md): an app's support answered by its program in the app's
// chat, from the app's notes or a language model, handed over to a person's @name. Run end to end on the SDK's harness
// with the model faked, every card held to the card standard, and its log held to names and numbers: never what a user
// wrote, an answer, a user's key or address.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertCardStandard, chatSpecFromJson, lintCard } from "../dist/index.js";
import { testChat } from "../dist/testing.js";
import {
  DEFAULT_MODEL, MAX_ANSWER, MODEL_QUESTIONS_PER_DAY, asksForPerson, claudeAnswerer, createSupportAgent, matchNote, readFaq,
} from "../../../examples/support-agent/support.mjs";

const read = (name) => JSON.parse(readFileSync(new URL(`../../../examples/support-agent/${name}`, import.meta.url), "utf8"));
const notes = readFaq(read("faq.json"));
const specJson = read("chat.json");

/** The harness with the agent mounted as server.mjs mounts it; `model` and the agent's log as the test gives them. */
async function start({ model = null, perDay, aiSpec = model !== null, now } = {}) {
  const events = [];
  const agent = createSupportAgent({ notes, human: "@anna_k", model, perDay, now, log: (level, event, meta) => events.push({ level, event, meta }) });
  const t = await testChat({
    spec: { ...specJson, ai: aiSpec },
    setup: (chat) => {
      chat.text(agent.text);
      chat.command("topics", agent.topics);
      chat.command("human", agent.human);
    },
  });
  return { t, events };
}

/** Every card the agent sends keeps the card standard, and none carries a status out of place. */
function standard(t, reply, what) {
  assert.doesNotThrow(() => assertCardStandard(reply.message, t.chat.spec, { strict: false }), `${what}: ${JSON.stringify(lintCard(reply.message, t.chat.spec))}`);
}

test("the example's notes, spec and profile are in bounds, and every note's own question finds it in each language", () => {
  assert.equal(notes.length, 4);
  for (const note of notes) {
    for (const lang of Object.keys(note.question)) assert.equal(matchNote(notes, note.question[lang], lang)?.id, note.id, `${note.id} ${lang}`);
  }
  const spec = chatSpecFromJson(specJson);
  assert.deepEqual(spec.commands.map((c) => c.name), ["topics", "human"]);
  assert.equal(spec.keeps, 0, "the agent keeps nothing past its answer");
  assert.equal(spec.ai, false, "no model by default: the spec says so");
  assert.equal(read("connect.json").support, null, "a placeholder username would send users to whoever mints it");
});

test("readFaq refuses what a card could not show, naming the entry and the field", () => {
  const one = (change) => {
    const value = structuredClone(read("faq.json"));
    change(value.entries[0]);
    return () => readFaq(value);
  };
  assert.throws(one((e) => (e.label.en = "A label far too long for a button")), /entries\[0\]\.label\.en: 1 to 18/);
  assert.throws(one((e) => delete e.answer.en), /entries\[0\]\.answer: by language, "en" among them/);
  assert.throws(one((e) => (e.id = "What")), /entries\[0\]\.id/);
  assert.throws(one((e) => (e.words.en = [])), /entries\[0\]\.words\.en/);
  assert.throws(one((e) => (e.answer.ru = "x".repeat(MAX_ANSWER + 1))), /entries\[0\]\.answer\.ru/);
  assert.throws(() => readFaq({ entries: [read("faq.json").entries[0], read("faq.json").entries[0]] }), /each once/);
  assert.throws(() => readFaq({}), /"entries"/);
});

test("matching: a word finds the words it starts, a short word only itself, and a question for a person is no note's", () => {
  assert.equal(matchNote(notes, "Can I get my PAYMENTS back?", "en")?.id, "pay", "case and plural");
  assert.equal(matchNote(notes, "Где мой счет?", "ru")?.id, "pay", "ё or е");
  assert.equal(matchNote(notes, "I forgot my seed phrase", "ru")?.id, "phrase", "English in a Russian Saltix");
  assert.equal(matchNote(notes, "pine trees", "en"), null, "pin finds only pin");
  assert.equal(matchNote(notes, "Hello there", "en"), null);
  assert.ok(asksForPerson("Can I talk to a person please", "en"));
  assert.ok(asksForPerson("Позовите живого человека", "ru"));
  assert.ok(!asksForPerson("Can I add another person to a group of 20 people?", "en"), "a lone word asks for nobody");
  assert.ok(!asksForPerson("Сколько человек в группе?", "ru"));
});

test("without a model: the notes answer, a person takes the rest, every card to the standard, and the log names no one", async () => {
  const { t, events } = await start();
  try {
    const secret = "my order 4471-zebra";
    const answer = await t.say("How do payments work?");
    assert.equal(answer.text, notes.find((n) => n.id === "pay").answer.en);
    assert.deepEqual(answer.actions.map((a) => [a.label, a.kind]), [["Talk to a person", { run: { command: "human", args: [] } }]]);
    const ru = await t.say("Как устроена оплата?", { lang: "ru" });
    assert.equal(ru.text, notes.find((n) => n.id === "pay").answer.ru);
    assert.equal(ru.actions[0].label, "Позвать человека");
    const unknown = await t.say(`Where is ${secret}?`);
    assert.match(unknown.text, /a person on the app's team/);
    assert.deepEqual(unknown.fields, { "Write to": "@anna_k" });
    const asked = await t.say("I want to talk to a person");
    assert.match(asked.text, /A person on the app's team answers you/);
    const human = await t.ask("human", {}, { lang: "ru" });
    assert.deepEqual(human.fields, { Написать: "@anna_k" });
    const topics = await t.ask("topics", {});
    assert.deepEqual(topics.actions.map((a) => a.label), ["What it does", "Your data", "Payments", "Phrase and PIN"]);
    assert.deepEqual(topics.actions[2].kind, { reply: { text: "How do payments work?" } }, "a tap asks the note's question");
    for (const [what, reply] of Object.entries({ answer, ru, unknown, asked, human, topics })) standard(t, reply, what);
    // The log: where each answer came from, never the words, the user's key or address.
    assert.deepEqual(events.map((e) => [e.event, e.meta.source, e.meta.why ?? e.meta.note]), [
      ["support_answer", "rules", "pay"], ["support_answer", "rules", "pay"], ["support_answer", "person", "unknown"],
      ["support_answer", "person", "asked"], ["support_answer", "person", "asked"],
    ]);
    const logged = JSON.stringify([...events, ...t.logs]);
    for (const never of [secret, "4471", t.as("stranger").key, t.as("stranger").address, "payments work"]) assert.ok(!logged.includes(never), never);
  } finally {
    await t.close();
  }
});

test("with a model: what the notes miss is the model's, marked so; a model that declines or fails hands over", async () => {
  const asked = [];
  let next = async () => "Exports run every night at 02:00 UTC.";
  const model = (question, o) => {
    asked.push({ question, lang: o.lang });
    return next();
  };
  const { t, events } = await start({ model });
  try {
    assert.equal(t.chat.spec.ai, true);
    const fromNotes = await t.say("What does the app keep about me?");
    assert.equal(asked.length, 0, "the notes answer first: the model is not asked");
    assert.match(fromNotes.text, /Nothing past its answer/);
    const answer = await t.say("When do exports run?", { lang: "ru" });
    assert.deepEqual(asked, [{ question: "When do exports run?", lang: "ru" }]);
    assert.equal(answer.text, "Exports run every night at 02:00 UTC.");
    assert.deepEqual(answer.fields, { Ответ: "языковая модель, по заметкам приложения" }, "an answer of the model says so");
    standard(t, answer, "a model's answer");
    next = async () => null;
    assert.deepEqual((await t.say("Why is the sky blue?")).fields, { "Write to": "@anna_k" }, "a model that cannot answer from the notes");
    next = async () => {
      const e = new Error("overloaded: the question was 'secret words'");
      e.status = 529;
      throw e;
    };
    assert.deepEqual((await t.say("What about secret words?")).fields, { "Write to": "@anna_k" }, "a model that fails");
    next = async () => `${"word ".repeat(400)}end`;
    const long = await t.say("Tell me everything");
    assert.ok([...long.text].length <= MAX_ANSWER && long.text.endsWith("…"), "a long answer is cut at a word");
    assert.deepEqual(events.filter((e) => e.event === "support_model_failed").map((e) => e.meta.reason), ["http_529"]);
    assert.ok(!JSON.stringify(events).includes("secret words"), "an error's message never reaches the log");
    assert.deepEqual(events.filter((e) => e.event === "support_answer").map((e) => e.meta.why ?? e.meta.source),
      ["rules", "model", "model_declined", "model_failed", "model"]);
  } finally {
    await t.close();
  }
});

test("the model answers a user's daily share, then a person; the next day, again; other users have their own", async () => {
  let clock = Date.UTC(2026, 9, 28, 10);
  const { t } = await start({ model: async () => "An answer.", perDay: 2, now: () => clock });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await t.say(`Question ${i}`)).text, "An answer.");
    assert.match((await t.say("Question 3")).text, /That is all the questions the assistant answers for you today/);
    assert.equal((await t.as("other").say("Question 1")).text, "An answer.", "another user's share is their own");
    clock += 86_400_000;
    assert.equal((await t.say("Question 4")).text, "An answer.", "a new day");
  } finally {
    await t.close();
  }
  assert.equal(MODEL_QUESTIONS_PER_DAY, 20);
});

test("createSupportAgent refuses a person who is no username", () => {
  for (const human of [undefined, "", "anna k", "+0 777 1234", "@Anna__k"]) {
    assert.throws(() => createSupportAgent({ notes, human }), /human: the username/, String(human));
  }
  assert.doesNotThrow(() => createSupportAgent({ notes, human: "Anna_K" }), "typed as a person would: read as @anna_k");
});

test("claudeAnswerer asks Anthropic's API for an answer from the notes, and reads a refusal or a broken answer as a hand-over", async () => {
  const requests = [];
  let response;
  const client = { beta: { messages: { create: async (body) => (requests.push(body), response) } } };
  const ask = claudeAnswerer(client, { app: "split-bill", notes });
  const reply = (json, stop = "end_turn") => ({ stop_reason: stop, content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(json) }] });

  response = reply({ answer: " Nightly. ", handover: false });
  assert.equal(await ask("When?", { lang: "en" }), "Nightly.");
  const body = requests[0];
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, "claude-opus-5-5");
  assert.deepEqual(body.messages, [{ role: "user", content: "When?" }], "the question alone, nothing of the user");
  assert.deepEqual(body.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(body.fallbacks, "default");
  assert.equal(body.output_config.effort, "low");
  assert.deepEqual(body.output_config.format.schema.required, ["answer", "handover"]);
  assert.match(body.system, /split-bill/);
  for (const note of notes) assert.ok(body.system.includes(note.answer.en), `the facts hold ${note.id}`);
  assert.match(body.system, /Never ask for a recovery phrase/);

  response = reply({ answer: "", handover: true });
  assert.equal(await ask("Who are you?", { lang: "en" }), null, "the model hands over");
  response = reply({ answer: "x", handover: false }, "refusal");
  response.content = [];
  assert.equal(await ask("…", { lang: "en" }), null, "a refusal");
  response = { stop_reason: "max_tokens", content: [{ type: "text", text: '{"answer": "cut sh' }] };
  assert.equal(await ask("…", { lang: "en" }), null, "an answer cut short");
  await claudeAnswerer(client, { app: "x", notes, model: "another-model" })("q", { lang: "en" });
  assert.equal(requests.at(-1).model, "another-model", "SUPPORT_MODEL names another");
});
