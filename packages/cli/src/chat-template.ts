// What `grain init` makes besides the manifest and the page: for a chat, a server that runs it from the key `grain pair`
// paired (Saltix 24-app-studio §3a); for either, the package.json that links the SDK and the `grain` command from the checkout.
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** How a project in \`dir\` depends on the package whose root is \`root\`: its version, when it came from a registry's
 *  package; else the checkout's package by its path, since the SDK is not on npm yet. */
function dependencyOn(dir: string, root: string): string {
  if (root.split(sep).includes("node_modules")) {
    return "^" + (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  }
  return "file:" + relative(dir, root).split(sep).join("/");
}

/** How a project in \`dir\` depends on the server SDK this tool runs with. */
export function sdkDependency(dir: string): string {
  const entry = fileURLToPath((import.meta as unknown as { resolve(s: string): string }).resolve("@saltix/grain-server"));
  return dependencyOn(dir, dirname(dirname(entry)));
}

/**
 * How a project in \`dir\` depends on this command line: so \`npx grain …\` in the project runs this tool, linked from
 * the checkout, and never asks the npm registry for a package of that name (which is someone else's).
 */
export function cliDependency(dir: string): string {
  return dependencyOn(dir, fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, ""));
}

/** A chat-only grain's package.json: \`npm start\` runs its chat; \`sdk\` is how it depends on @saltix/grain-server and
 *  \`cli\` on the \`grain\` command line. */
export const chatPackageJson = (slug: string, sdk: string, cli: string) => JSON.stringify({
  name: slug,
  version: "0.1.0",
  private: true,
  type: "module",
  scripts: { start: "node server.mjs", test: "node --test --test-force-exit \"test/*.test.mjs\"" },
  engines: { node: ">=20" },
  dependencies: { "@saltix/grain-server": sdk },
  devDependencies: { "@saltix/grain-cli": cli },
}, null, 2) + "\n";

/** A page grain's package.json: nothing to run but the \`grain\` command line (\`cli\`), so \`npx grain dev\` and the rest
 *  run this tool in the project. */
export const pagePackageJson = (slug: string, cli: string) => JSON.stringify({
  name: slug,
  version: "0.1.0",
  private: true,
  scripts: { dev: "grain dev", lint: "grain lint" },
  engines: { node: ">=20" },
  devDependencies: { "@saltix/grain-cli": cli },
}, null, 2) + "\n";

/** A chat-only grain's server: the key in `app.key` is its whole configuration (Saltix 24-app-studio §3a). */
export const chatServer = (slug: string) => `// The chat of ${slug}, run by its server key (Saltix 24-app-studio §3a): \`grain pair\` made it on this computer and
// wrote app.key once the registry named it; the key names the app, its network and the server key the registry trusts.
// The server finds the network's public relays and answers chat.json's commands.
//
//   npm start             the key from SALTIX_APP_KEY, the file SALTIX_APP_KEY_FILE names (a systemd credential), or
//                         app.key beside this file (owner-only); with none, it refuses to start (78) and says to run
//                         grain pair
//   NODE_RPC              your own node's wallet interface, for a network with no public relays
//   STATE_DIRECTORY       where chat.store.json is kept (systemd sets it with StateDirectory=; else here): it also
//                         remembers the spec served, so chat.json changed without raising "version" is refused (78)
//
// The log is one JSON line per event, and never holds a key or what users wrote.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatServer, appKeyFromEnvironment, chatSpecFromJson, fileChatStore, setupCannotWork } from "@saltix/grain-server";
import { handlers } from "./chat.mjs";

/** The exit code when the setup cannot work as it stands (EX_CONFIG, the SDK's EXIT_CONFIG): no key (not paired yet: run
 *  grain pair), the key is not one or the registry does not name it, or chat.json changed under a version this server
 *  served. Restarting would not help. */
const DEAD_KEY = 78;

const log = (level, event, meta = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), level, event, ...meta }));
/** A file next to this one, wherever the server is started from. */
const beside = (name) => new URL(name, import.meta.url);

let chat;
try {
  chat = await ChatServer.start({
    // SALTIX_APP_KEY, SALTIX_APP_KEY_FILE or app.key here, owner-only, never from the command line (which shells keep);
    // none: "run grain pair" (chat_unpaired, 78).
    appKey: appKeyFromEnvironment({ dir: fileURLToPath(new URL(".", import.meta.url)) }),
    spec: chatSpecFromJson(JSON.parse(readFileSync(beside("chat.json"), "utf8"))),
    store: fileChatStore(join(process.env.STATE_DIRECTORY || ".", "chat.store.json")),
    version: JSON.parse(readFileSync(beside("package.json"), "utf8")).version,
    node: process.env.NODE_RPC,
    log,
    onStop: () => process.exit(DEAD_KEY),
  });
} catch (e) {
  // The log says what to do; 78 when restarting cannot help (raise "version" for a chat.json changed under it).
  log("error", "not_started", { error: e.message });
  process.exit(setupCannotWork(e) ? DEAD_KEY : 1);
}

// The app's handlers, in chat.mjs: test/chat.test.mjs runs them the same way (npm test).
handlers(chat);

log("info", "ready", { slug: chat.slug, address: chat.address, network: chat.chain.network, spec: chat.spec.version });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void chat.flushReports().finally(() => { chat.close(); process.exit(0); }));
}
`;

/** A chat-only grain's handlers (\`chat.mjs\`): what the app does, apart from how it starts, so tests run it too. */
export const chatHandlers = (slug: string) => `// What ${slug} answers: one handler for each command chat.json declares. server.mjs runs them with the paired key;
// test/chat.test.mjs runs them on a development network (npm test). ask.args holds a command's arguments, typed by the
// spec (a number is a bigint); ask.lang is the user's language ("" when unknown): answer in it when you can, else in
// English.
import { card } from "@saltix/grain-server";

/** Register the app's handlers on chat, its ChatServer. */
export function handlers(chat) {
  chat.command("hello", (ask) => {
    const name = ask.args.name || (ask.lang === "ru" ? "друг" : "friend");
    return card().status("done").text(ask.lang === "ru" ? \`Привет, \${name}!\` : \`Hello, \${name}!\`).run("Again", "hello", {});
  });
  chat.text((ask) => card().text(ask.lang === "ru" ? "Выберите команду ниже." : "Pick a command below.").reply("Hello", "hello"));
}
`;

/** A chat-only grain's first test (\`test/chat.test.mjs\`): its commands end to end, as a wallet sends them. */
export const chatTest = (slug: string) => `// ${slug}'s chat end to end (npm test): chat.json and the handlers of chat.mjs on a development relay and registry,
// with a development key (never a real one), asked as Saltix asks and every card checked as Saltix checks it.
import test from "node:test";
import assert from "node:assert/strict";
import { assertCardStandard } from "@saltix/grain-server";
import { testChat } from "@saltix/grain-server/testing";
import { handlers } from "../chat.mjs";

test("hello greets by name, in the user's language", async (t) => {
  const chat = await testChat({ spec: new URL("../chat.json", import.meta.url), setup: handlers });
  t.after(() => chat.close());
  const reply = await chat.ask("hello", { name: "Ann" });
  assert.equal(reply.text, "Hello, Ann!");
  assert.equal(reply.status?.state, "done");
  assertCardStandard(reply.message, chat.chat.spec);   // the card design standard (AGENTS.md)
  assert.equal((await chat.ask("hello", {}, { lang: "ru" })).text, "Привет, друг!");
});

test("text alone points at the commands", async (t) => {
  const chat = await testChat({ spec: new URL("../chat.json", import.meta.url), setup: handlers });
  t.after(() => chat.close());
  assert.equal((await chat.say("hi")).text, "Pick a command below.");
});
`;
