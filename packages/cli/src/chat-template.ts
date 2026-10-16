// What `grain init --chat` makes besides the spec: a server that runs the chat from its developer key, and the
// package.json that starts it (Saltix 24-app-studio §3).
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** How a project in \`dir\` depends on the server SDK this tool runs with: its version, when the tool came from a
 *  registry's package; else the checkout's package by its path, since the SDK is not on npm yet. */
export function sdkDependency(dir: string): string {
  const entry = fileURLToPath((import.meta as unknown as { resolve(s: string): string }).resolve("@saltix/grain-server"));
  const root = dirname(dirname(entry));
  if (root.split(sep).includes("node_modules")) {
    return "^" + (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  }
  return "file:" + relative(dir, root).split(sep).join("/");
}

/** A chat-only grain's package.json: `npm start` runs its chat; `sdk` is how it depends on @saltix/grain-server. */
export const chatPackageJson = (slug: string, sdk: string) => JSON.stringify({
  name: slug,
  version: "0.1.0",
  private: true,
  type: "module",
  scripts: { start: "node server.mjs" },
  engines: { node: ">=20" },
  dependencies: { "@saltix/grain-server": sdk },
}, null, 2) + "\n";

/** A chat-only grain's server: the developer key is its whole configuration (Saltix 24-app-studio §3). */
export const chatServer = (slug: string) => `// The chat of ${slug}, run by its developer key (Saltix 24-app-studio §3): the key names the app, its network and
// the server key the registry trusts; the server finds the network's public relays and answers chat.json's commands.
//
//   npm start      the key from app.key (owner-only) or SALTIX_APP_KEY; NODE_RPC: your own node, for a network
//                  with no public relays
//
// The log is one JSON line per event, and never holds a key or what users wrote.
import { existsSync, readFileSync, statSync } from "node:fs";
import { AppKey, ChatServer, card, chatSpecFromJson, fileChatStore } from "@saltix/grain-server";

/** The exit code when the key cannot work (EX_CONFIG): a supervisor restarting the server would not help. */
const DEAD_KEY = 78;

const log = (level, event, meta = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), level, event, ...meta }));

/** The developer key from SALTIX_APP_KEY or app.key: never from the command line, which shells keep. */
function developerKey() {
  if (process.env.SALTIX_APP_KEY?.trim()) return AppKey.parse(process.env.SALTIX_APP_KEY);
  if (!existsSync("app.key")) throw new Error("no developer key: put it in app.key (owner-only) or SALTIX_APP_KEY");
  if (process.platform !== "win32" && (statSync("app.key").mode & 0o077) !== 0) throw new Error("app.key: readable by others; chmod 600 it");
  return AppKey.parse(readFileSync("app.key", "utf8"));
}

let chat;
try {
  chat = await ChatServer.start({
    appKey: developerKey(),
    spec: chatSpecFromJson(JSON.parse(readFileSync("chat.json", "utf8"))),
    store: fileChatStore("chat.store.json"),
    version: process.env.npm_package_version,
    node: process.env.NODE_RPC,
    log,
    onStop: () => process.exit(DEAD_KEY),
  });
} catch (e) {
  log("error", "not_started", { error: e.message });
  process.exit(["AppKeyError", "ChatKeyNotRegistered"].includes(e.name) ? DEAD_KEY : 1);
}

// One handler for each command chat.json declares. ask.args holds its arguments, typed by the spec; ask.lang is the
// user's language ("" when unknown): answer in it when you can, else in English.
chat.command("hello", (ask) => {
  const name = ask.args.name || (ask.lang === "ru" ? "друг" : "friend");
  return card().text(ask.lang === "ru" ? \`Привет, \${name}!\` : \`Hello, \${name}!\`).status("done").run("Again", "hello", {});
});
chat.text((ask) => card().text(ask.lang === "ru" ? "Выберите команду ниже." : "Pick a command below.").reply("Hello", "hello"));

log("info", "ready", { slug: chat.slug, address: chat.address, network: chat.chain.network, spec: chat.spec.version });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void chat.flushReports().finally(() => { chat.close(); process.exit(0); }));
}
`;
