// An app's support, answered by its program in the app's chat (Saltix 22-grain-chats; docs/support.md): from the app's
// own notes (`faq.json`), or from a language model when one is configured, and handed over to a person's @name when
// neither can answer, when the user asks for a person, or once the model answered a user's daily share. The logic only:
// the model is a function handed in (`claudeAnswerer` makes one from an Anthropic client), so
// packages/server/test/support-agent.test.mjs runs it end to end on the SDK's harness with the model faked.
//
// What it logs is event names and numbers: where an answer came from (`rules`, `model`, `person`), the language, the time
// it took, the note's id (the app's own words). Never what a user wrote, an answer, a user's key or address.
import { card, parseHandle } from "../../packages/server/dist/index.js";

/** Characters of an answer a card carries at most: the model is asked for far less, and a longer one is cut at a word. */
export const MAX_ANSWER = 1200;
/** Questions a day the model answers for one user (their key in the app), at most: past it, a person. A language model
 *  costs money per question, and one user's flood must not run up the app's bill. */
export const MODEL_QUESTIONS_PER_DAY = 20;
/** Questions a day the model answers for all users together, at most: past it, a person for everyone until the day
 *  turns. A key in the app costs nothing to make, so a share per key alone bounds nothing: a thousand fresh accounts
 *  would have the model answer twenty thousand questions a day. Set your own with `perDayTotal`. */
export const MODEL_QUESTIONS_PER_DAY_TOTAL = 500;
/** Notes the agent holds at most, and how many a `topics` card offers (a card has at most 6 actions). */
const MAX_NOTES = 64;
const TOPICS = 6;
const DAY_MS = 86_400_000;

/** The agent's own words, by language: the app's notes bring the rest. */
const WORDS = {
  en: {
    person: "Talk to a person",
    topics: "Common questions: tap one, or write your own.",
    noTopics: "Write your question: the app's support answers here.",
    by: "Answered by",
    model: "a language model, from the app's notes",
    writeTo: "Write to",
    handover: {
      asked: "A person on the app's team answers you: write to them in Saltix.",
      unknown: "This one is for a person on the app's team: write to them in Saltix.",
      limit: "That is all the questions the assistant answers for you today: a person on the app's team takes it from here.",
      total: "The assistant has answered all the questions it takes today: a person on the app's team takes it from here.",
    },
  },
  ru: {
    person: "Позвать человека",
    topics: "Частые вопросы: выберите или напишите свой.",
    noTopics: "Напишите вопрос: поддержка приложения отвечает здесь.",
    by: "Ответ",
    model: "языковая модель, по заметкам приложения",
    writeTo: "Написать",
    handover: {
      asked: "Вам ответит человек из команды приложения: напишите ему в Saltix.",
      unknown: "На этот вопрос ответит человек из команды приложения: напишите ему в Saltix.",
      limit: "На сегодня помощник ответил на все ваши вопросы: дальше поможет человек из команды приложения.",
      total: "На сегодня помощник ответил на все вопросы, какие мог: дальше поможет человек из команды приложения.",
    },
  },
};

/** What asks for a person, by language: phrases, never a lone word a question may hold for another reason ("a group of
 *  20 people" asks for nobody). */
const PERSON = {
  en: ["human", "real person", "talk to a person", "talk to someone", "speak to someone", "operator", "live agent"],
  ru: ["позови человек", "позвать человек", "живо человек", "поговорить с человек", "связаться с человек", "оператор"],
};

/** The agent's language for a user: Russian for a Saltix in Russian, else English (the notes may have more). */
const wordsOf = (lang) => (lang === "ru" || lang.startsWith("ru-") ? WORDS.ru : WORDS.en);

/** Lowercase words of letters and digits: what matching reads of a text. */
const wordsIn = (text) => text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** A word of a phrase finds a word of the text it starts when it has at least this many characters (`refund` finds
 *  `refunds`, `возврат` finds `возврата`), and only itself when shorter (`a`, `to`, `с` find nothing else). */
const STEM = 4;

/** Whether `words` (a text's) hold `phrase`: its words in a row, each finding one of the text's. */
function holds(words, phrase) {
  const want = wordsIn(phrase);
  if (want.length === 0) return false;
  const finds = (w, word) => ([...w].length >= STEM ? word.startsWith(w) : word === w);
  for (let i = 0; i + want.length <= words.length; i++) {
    if (want.every((w, j) => finds(w, words[i + j]))) return true;
  }
  return false;
}

/** A text cut to `max` characters at a word, with an ellipsis when cut. */
function cut(text, max) {
  const chars = [...text.trim()];
  if (chars.length <= max) return chars.join("");
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/**
 * The app's notes from `faq.json`'s object, checked: `entries`, each an `id` (1–32 of `[a-z0-9_-]`), and by language
 * (English required) a `label` for its button (at most 18 characters, the card standard's), the `question`, its
 * `answer` (at most `MAX_ANSWER` characters) and the `words` that find it (a word finds a user's word it starts:
 * `refund` finds `refunds`). Throws, naming the entry and the field, for anything else.
 */
export function readFaq(value) {
  const entries = value?.entries;
  if (!Array.isArray(entries) || entries.length > MAX_NOTES) throw new Error(`faq: "entries", a list of at most ${MAX_NOTES} notes`);
  const ids = new Set();
  return entries.map((e, i) => {
    const at = `faq: entries[${i}]`;
    if (typeof e?.id !== "string" || !/^[a-z0-9_-]{1,32}$/.test(e.id) || ids.has(e.id)) throw new Error(`${at}.id: 1 to 32 of [a-z0-9_-], each once`);
    ids.add(e.id);
    for (const field of ["label", "question", "answer", "words"]) {
      if (typeof e[field] !== "object" || e[field] === null || e[field].en === undefined) throw new Error(`${at}.${field}: by language, "en" among them`);
    }
    for (const [lang, label] of Object.entries(e.label)) {
      if (typeof label !== "string" || [...label].length < 1 || [...label].length > 18) throw new Error(`${at}.label.${lang}: 1 to 18 characters`);
    }
    for (const field of ["question", "answer"]) {
      for (const [lang, text] of Object.entries(e[field])) {
        const n = typeof text === "string" ? [...text.trim()].length : 0;
        if (n < 1 || n > (field === "answer" ? MAX_ANSWER : 200)) throw new Error(`${at}.${field}.${lang}: 1 to ${field === "answer" ? MAX_ANSWER : 200} characters`);
      }
    }
    for (const [lang, words] of Object.entries(e.words)) {
      if (!Array.isArray(words) || words.length === 0 || !words.every((w) => typeof w === "string" && wordsIn(w).length > 0)) {
        throw new Error(`${at}.words.${lang}: a list of words or phrases`);
      }
    }
    return { id: e.id, label: e.label, question: e.question, answer: e.answer, words: e.words };
  });
}

/** The note that answers `text` best for a user of `lang`: the most of its words found, in the user's language, else in
 *  English; the first of equals. Null when none has one. */
export function matchNote(notes, text, lang) {
  const words = wordsIn(text);
  let best = null;
  for (const note of notes) {
    const phrases = [...(note.words[lang] ?? []), ...(lang === "en" ? [] : note.words.en)];
    const score = phrases.filter((p) => holds(words, p)).length;
    if (score > 0 && (best === null || score > best.score)) best = { note, score };
  }
  return best?.note ?? null;
}

/** Whether `text` asks for a person. */
export const asksForPerson = (text, lang) => {
  const words = wordsIn(text);
  return [...(PERSON[lang] ?? []), ...PERSON.en].some((p) => holds(words, p));
};

/** A note's text in `lang`, else English. */
const inLang = (map, lang) => map[lang] ?? map.en;

/** Questions the model answered in the current UTC day, per user and in all: forgotten when the day turns (and on a
 *  restart, which costs at most a day's again). A user past the total is never counted, so the map holds at most the
 *  total's users. */
class DailyShare {
  constructor(limit, total) {
    this.limit = limit;
    this.total = total;
    this.day = -1;
    this.all = 0;
    this.used = new Map();
  }
  /** Take one of `key`'s questions at `now`: `null` when taken, else why not — `limit` (the user's share is spent) or
   *  `total` (everyone's is). */
  take(key, now) {
    const day = Math.floor(now / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.all = 0;
      this.used.clear();
    }
    if (this.all >= this.total) return "total";
    const n = this.used.get(key) ?? 0;
    if (n >= this.limit) return "limit";
    this.used.set(key, n + 1);
    this.all++;
    return null;
  }
}

/** Why a model's call failed, as a code for the log: its HTTP status, or the error's name; never its message. */
const failureOf = (e) => (typeof e?.status === "number" ? `http_${e.status}` : typeof e?.name === "string" && /^[A-Za-z]+$/.test(e.name) ? e.name : "error");

/**
 * The support agent's handlers for an app's chat (`ChatServer`): `text` answers what a user writes, `topics` lists the
 * common questions, `human` hands over. Mount them on the app's own server, under the commands its `chat.json` names
 * (`chat.text(agent.text)`, `chat.command("topics", agent.topics)`, `chat.command("human", agent.human)`): one app, one
 * key, one program.
 *
 * - `notes`: `readFaq`'s, the app's own answers.
 * - `human`: the person who takes over, a Saltix username (`@anna`); the cards name them.
 * - `model`: `(question, { lang }) => Promise<string | null>`, an answer or null when it cannot answer from the notes
 *   (`claudeAnswerer`), or null for none: the notes alone answer, and a person the rest.
 * - `log`: `(level, event, meta)`, names and numbers only.
 * - `perDay`: the questions a day the model answers for one user (`MODEL_QUESTIONS_PER_DAY`).
 * - `perDayTotal`: the questions a day it answers for all users together (`MODEL_QUESTIONS_PER_DAY_TOTAL`): a user's
 *   share alone bounds nothing, since anyone can make keys without end.
 * - `personCommand`: the command a card's "Talk to a person" runs (`human`), or null when the spec has none.
 */
export function createSupportAgent({
  notes, human, model = null, log = () => {}, perDay = MODEL_QUESTIONS_PER_DAY, perDayTotal = MODEL_QUESTIONS_PER_DAY_TOTAL,
  personCommand = "human", now = Date.now,
}) {
  const person = parseHandle(human ?? "");
  if (person === null) throw new Error("human: the username of the person who takes over (@anna)");
  if (!Number.isSafeInteger(perDayTotal) || perDayTotal < 0) throw new Error("perDayTotal: the model's questions a day for everyone, a whole number");
  const contact = `@${person.name}`;
  const share = new DailyShare(perDay, perDayTotal);

  const withPerson = (c, words) => (personCommand === null ? c : c.run(words.person, personCommand));
  const handover = (words, why) => card().text(words.handover[why]).fields({ [words.writeTo]: contact });
  /** The card, said in the log by where it came from. */
  const answered = (c, source, lang, started, extra = {}) => {
    log("info", "support_answer", { source, lang, ms: now() - started, ...extra });
    return c;
  };

  return {
    async text(ask) {
      const started = now();
      const lang = ask.lang || "en";
      const words = wordsOf(lang);
      const question = ask.text.trim();
      if (asksForPerson(question, lang)) return answered(handover(words, "asked"), "person", lang, started, { why: "asked" });
      const note = matchNote(notes, question, lang);
      if (note) return answered(withPerson(card().text(inLang(note.answer, lang)), words), "rules", lang, started, { note: note.id });
      if (model === null) return answered(handover(words, "unknown"), "person", lang, started, { why: "unknown" });
      const spent = share.take(ask.key, now());
      if (spent !== null) return answered(handover(words, spent), "person", lang, started, { why: spent });
      let answer;
      try {
        answer = await model(question, { lang });
      } catch (e) {
        log("warn", "support_model_failed", { reason: failureOf(e), ms: now() - started });
        return answered(handover(words, "unknown"), "person", lang, started, { why: "model_failed" });
      }
      if (typeof answer !== "string" || answer.trim() === "") return answered(handover(words, "unknown"), "person", lang, started, { why: "model_declined" });
      const c = card().text(cut(answer, MAX_ANSWER)).fields({ [words.by]: words.model });
      return answered(withPerson(c, words), "model", lang, started);
    },

    topics(ask) {
      const lang = ask.lang || "en";
      const words = wordsOf(lang);
      if (notes.length === 0) return card().text(words.noTopics);
      const c = card().text(words.topics);
      // A tap sends the note's question as the user's own text, which `text` answers: one path for every answer.
      for (const note of notes.slice(0, TOPICS)) c.reply(inLang(note.label, lang), inLang(note.question, lang));
      return c;
    },

    human(ask) {
      const started = now();
      const lang = ask.lang || "en";
      return answered(handover(wordsOf(lang), "asked"), "person", lang, started, { why: "asked" });
    },
  };
}

/** The model this example asks by default: Anthropic's current Opus (`SUPPORT_MODEL` names another). */
export const DEFAULT_MODEL = "claude-opus-5-5";

/** What the model answers with: an answer, or a hand-over to a person. */
const ANSWER_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: { answer: { type: "string" }, handover: { type: "boolean" } },
    required: ["answer", "handover"],
    additionalProperties: false,
  },
};

/**
 * A `model` for `createSupportAgent` from an Anthropic client (`new Anthropic()` of `@anthropic-ai/sdk`, which reads
 * `ANTHROPIC_API_KEY` from the environment): it answers from the app's notes alone, in the language of the question, or
 * hands over (null) when they do not answer it, when the model declines (`refusal`), or when its answer does not read.
 * One question at a time, nothing of the conversation kept. `fallbacks: "default"` lets the API answer a request one
 * model's safeguards decline with the model Anthropic recommends for it (beta `server-side-fallback-2026-07-01`).
 */
export function claudeAnswerer(client, { app, notes, model = DEFAULT_MODEL }) {
  const facts = notes.map((n) => `Q: ${n.question.en}\nA: ${n.answer.en}`).join("\n\n");
  const system = [
    `You answer the users of ${app}, a mini-app in the Saltix wallet, in its support chat.`,
    "Answer only from the facts below. When they do not answer the question, or the user wants a person, set handover to true and leave the answer empty.",
    "Answer in the language the question is written in, in plain text without markup, in a few short sentences.",
    "Never ask for a recovery phrase, a PIN, a password or a key: nobody needs them, and say so if asked.",
    "",
    "Facts:",
    facts,
  ].join("\n");
  return async (question) => {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // A support chat: a short answer from given facts, at once.
      output_config: { effort: "low", format: ANSWER_FORMAT },
      system,
      messages: [{ role: "user", content: question }],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content.find((b) => b.type === "text")?.text;
    try {
      const { answer, handover } = JSON.parse(text);
      return handover === true || typeof answer !== "string" || answer.trim() === "" ? null : answer.trim();
    } catch {
      // Cut short (max_tokens) or not the format asked for: a person answers rather than half an answer.
      return null;
    }
  };
}
