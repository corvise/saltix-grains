// The support agent as an app's program (docs/support.md): it answers in the app's chat, from the app's notes
// (faq.json) or a language model, and hands over to a person's @name. Run from the app's key and nothing else, as
// examples/hello-grain is:
//
//   SUPPORT_HUMAN=@anna npm run support-agent        (in the checkout, with grain pair's app.key, or SALTIX_APP_KEY)
//
//   SUPPORT_HUMAN        required: the username of the person who takes over (@anna), named on the hand-over cards
//   ANTHROPIC_API_KEY    optional: a language model answers what the notes do not (npm install --no-save @anthropic-ai/sdk;
//                        chat.json's "ai" must say true, its version raised, as users are told before they write)
//   SUPPORT_MODEL        the model, claude-opus-5-5 by default
//   SUPPORT_MODEL_DAILY  the questions a day the model answers for all users together (500 by default): past it, a person
//   SUPPORT_FAQ          the app's notes (faq.json next to this file by default)
//   SALTIX_APP_KEY, SALTIX_APP_KEY_FILE, CHAT_SPEC, CHAT_STORE, NODE_RPC: as examples/hello-grain/server.mjs reads them
//
// Keys come from the environment (or grain pair's app.key, owner-only), never from a file in a repository, and none of
// them reaches the log. The app's profile names it as the app's support with a username bound to the app:
// grain bind --handle @name --slug <slug>, then grain support @name and grain profile in the app's project.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatServer, EXIT_CONFIG, appKeyFromEnvironment, chatSpecFromJson, fileChatStore, setupCannotWork } from "../../packages/server/dist/index.js";
import { DEFAULT_MODEL, claudeAnswerer, createSupportAgent, readFaq } from "./support.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const log = (level, event, meta) => console.log(`${new Date().toISOString()} ${level} ${event} ${JSON.stringify(meta ?? {})}`);

/** A setup that cannot work as it stands: said, and exit 78, which a supervisor does not restart. */
function cannot(message) {
  console.error(`not started: ${message}`);
  process.exit(EXIT_CONFIG);
}

/** An Anthropic client when ANTHROPIC_API_KEY is set (the SDK reads it from the environment), else null. */
async function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return null;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    return new Anthropic();
  } catch {
    return cannot("ANTHROPIC_API_KEY is set, but @anthropic-ai/sdk is not installed: npm install --no-save @anthropic-ai/sdk here, or npm install @anthropic-ai/sdk in your project");
  }
}

let key;
try {
  key = appKeyFromEnvironment();
} catch (e) {
  console.error(e.message);
  process.exit(setupCannotWork(e) ? EXIT_CONFIG : 2);
}
const json = JSON.parse(readFileSync(process.env.CHAT_SPEC ?? join(here, "chat.json"), "utf8"));
const spec = chatSpecFromJson({ ...json, slug: key.slug });
let notes;
try {
  notes = readFaq(JSON.parse(readFileSync(process.env.SUPPORT_FAQ ?? join(here, "faq.json"), "utf8")));
} catch (e) {
  cannot(e.message);
}
const client = await anthropic();
// Users read whether a language model answers before they write (22-grain-chats §2): the spec says what runs.
if (spec.ai !== (client !== null)) {
  cannot(client ? 'a language model answers, so chat.json says "ai": true (and its "version" goes up)'
    : 'no language model answers (no ANTHROPIC_API_KEY), so chat.json says "ai": false (and its "version" goes up)');
}
const model = client && claudeAnswerer(client, { app: key.slug, notes, model: process.env.SUPPORT_MODEL || DEFAULT_MODEL });
const daily = process.env.SUPPORT_MODEL_DAILY;
const perDayTotal = daily === undefined || daily === "" ? undefined : Number(daily);
let agent;
try {
  agent = createSupportAgent({ notes, human: process.env.SUPPORT_HUMAN, model, log, perDayTotal });
} catch (e) {
  cannot(e.message.startsWith("perDayTotal") ? `SUPPORT_MODEL_DAILY: a whole number of questions a day` : `SUPPORT_HUMAN: ${e.message}`);
}

console.log(`starting ${key}`);
try {
  const chat = await ChatServer.start({
    appKey: key, spec, node: process.env.NODE_RPC, store: fileChatStore(process.env.CHAT_STORE ?? join(process.env.STATE_DIRECTORY || ".", "support.store.json")),
    log, onStop: () => process.exit(EXIT_CONFIG),
  });
  chat.text(agent.text);
  chat.command("topics", agent.topics);
  chat.command("human", agent.human);
  console.log(`${chat.slug}'s support answers at ${chat.address} on ${chat.chain.network} (spec v${chat.spec.version}, ${model ? "notes and a language model" : "notes"})`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { chat.close(); process.exit(0); });
} catch (e) {
  console.error(`not started: ${e.message}`);
  process.exit(setupCannotWork(e) ? EXIT_CONFIG : 1);
}
