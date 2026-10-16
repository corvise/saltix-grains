// The AGENTS.md every `grain init` project gets says what the SDK and its guide for agents say: the full-screen rule,
// a link to docs/agents/app.md, and the seven rules every app follows, each as the server `grain init --chat` makes and
// the SDK's guide have it, so the three never drift apart.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHAT_UNASKED_PER_DAY, CHAT_UNASKED_TEAM_PER_DAY } from "@saltix/grain-server";
import { APP_GUIDE, CARDS_GUIDE, FULL_SCREEN_RULE, agentsMd, appRules } from "../dist/template.js";
import { chatServer } from "../dist/chat-template.js";

const guide = readFileSync(new URL("../../../docs/agents/app.md", import.meta.url), "utf8");
const server = chatServer("coach");

test("every project's AGENTS.md links the SDK's guide and keeps the rules, a page's and a chat-only app's", () => {
  assert.equal(APP_GUIDE, "https://github.com/corvise/saltix-grains/blob/main/docs/agents/app.md");
  for (const chat of [false, true]) {
    const text = agentsMd("coach", chat);
    assert.ok(text.includes(FULL_SCREEN_RULE), "the full-screen rule, word for word");
    assert.ok(text.includes(`](${APP_GUIDE})`), "the guide, by its address: a project has no copy");
    assert.ok(text.includes(`](${APP_GUIDE}#the-rules-every-app-follows)`));
    assert.ok(text.includes(appRules), "the seven rules");
    assert.ok(text.includes("--saltix-controls-width"), "and the full-screen ones");
  }
  assert.match(agentsMd("coach", true), /`server\.mjs`/);
  assert.match(agentsMd("coach", true), /`npm start`/);
  assert.match(agentsMd("coach", false), /`npx grain dev`/);
  assert.equal([...appRules.matchAll(/^\d\. \*\*/gm)].length, 7);
});

test("the anchor the rules link to is the guide's heading", () => {
  assert.match(guide, /^## The rules every app follows$/m);
  assert.match(guide, /^## The developer key is a secret$/m);
});

test("(a) the key: where server.mjs reads it, where the guide keeps it, never on the command line", () => {
  for (const where of ["`SALTIX_APP_KEY`", "`SALTIX_APP_KEY_FILE`", "`app.key`", "(umask 077 && cat > app.key)"]) {
    assert.ok(appRules.includes(where), where);
    assert.ok(guide.includes(where.replace(/`/g, "")) || guide.includes(where), `the guide: ${where}`);
  }
  assert.match(server, /process\.env\.SALTIX_APP_KEY\b/);
  assert.match(server, /process\.env\.SALTIX_APP_KEY_FILE \|\| "app\.key"/);
  assert.match(appRules, /never from the command line/);
  assert.match(guide, /Never put it on a command line/);
});

test("(b) the spec's version: raised with every change, as the guide says", () => {
  assert.match(appRules, /Raise `chat\.json`'s `version` with every change of it/);
  assert.match(guide, /\*\*Raise `version` with every change\.\*\* Saltix takes a spec only when its version is higher/);
  assert.match(guide, /A spec changed under the same version reaches nobody, and nothing says so/);
  assert.match(appRules, /a spec changed under the same version reaches nobody, and nothing\s+says so/);
  assert.match(appRules, /refuses to start on one changed under the same\s+version \(exit 78/);
  assert.match(guide, /refuses to start \(78,\s+`chat_spec_changed_under_version`\)/);
});

test("(c) the unasked budget: the SDK's numbers", () => {
  assert.equal(CHAT_UNASKED_PER_DAY, 10);
  assert.equal(CHAT_UNASKED_TEAM_PER_DAY, 100);
  assert.match(appRules, /10 per user in any 24\s+hours \(100 to a member of the app's team\)/);
  assert.match(guide, /10 per user in any 24 hours\*\* \(100 to a\s+member of your team\)/);
  assert.match(appRules, /`ChatBudgetSpent`/);
  assert.match(guide, /throw `ChatBudgetSpent` past it/);
});

test("(d) state: STATE_DIRECTORY, where server.mjs keeps its store", () => {
  assert.match(server, /fileChatStore\(join\(process\.env\.STATE_DIRECTORY \|\| "\.", "chat\.store\.json"\)\)/);
  assert.match(appRules, /`STATE_DIRECTORY`/);
  assert.match(appRules, /`StateDirectory=`/);
  assert.match(guide, /STATE_DIRECTORY/);
});

test("(e) a key that cannot work exits with 78, anything else with 1", () => {
  assert.match(server, /const DEAD_KEY = 78;/);
  assert.match(server, /onStop: \(\) => process\.exit\(DEAD_KEY\)/);
  assert.match(server, /process\.exit\(setupCannotWork\(e\) \? DEAD_KEY : 1\)/);
  assert.match(appRules, /Exit with status 78 when the key cannot work/);
  for (const why of ["another network's", "`chat.json` changed under a version served", "`ChatSetupError`"]) assert.ok(appRules.includes(why), why);
  assert.match(appRules, /`RestartPreventExitStatus=78`/);
  assert.match(guide, /RestartPreventExitStatus=78/);
});

test("(f) payments: the SDK's calls, to the owner only, delivered on the chain's word, as the guide says", () => {
  for (const call of ["`chat.invoice`", "`chat.paymentOf`"]) {
    assert.ok(appRules.includes(call), call);
    assert.ok(guide.includes(call), `the guide: ${call}`);
  }
  assert.match(appRules, /pays the app's\s+owner and nobody else/);
  assert.match(guide, /a developer key's invoice pays the owner/);
  assert.match(appRules, /never on the page's or the user's word/);
  assert.match(guide, /never deliver on the page's or the user's word/i);
  assert.match(appRules, /Saltix 0\.1\.53 and older/);
});

test("(g) cards: the standard's rules, the lint the guide names, and the page they link to", async () => {
  const { assertCardStandard, CARD_LIMITS, card } = await import("@saltix/grain-server");
  const cards = readFileSync(new URL("../../../docs/agents/cards.md", import.meta.url), "utf8");
  assert.equal(CARDS_GUIDE, "https://github.com/corvise/saltix-grains/blob/main/docs/agents/cards.md");
  assert.ok(appRules.includes(`](${CARDS_GUIDE})`));
  assert.match(appRules, /at most 6 actions, labels of at most 18 characters/);
  assert.equal(CARD_LIMITS.actions, 6);
  assert.equal(CARD_LIMITS.label, 18);
  assert.match(cards, /At most 6 actions, 3 rows; labels at most 18 characters/);
  assert.match(guide, /`assertCardStandard\(card,\s+spec\)`/);
  assert.throws(() => assertCardStandard(card().text("x").reply("A label far longer than eighteen")), /label/);
});
