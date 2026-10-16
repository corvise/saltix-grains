// The example's chat as your app's server, from the developer key Saltix gave you (24-app-studio §3) and nothing else:
//
//   SALTIX_APP_KEY='saltix-app:1:…' npm run example         or   SALTIX_APP_KEY_FILE=app.key npm run example
//
// The key names the app, its network and its server key. The server finds the network's public relays, checks that
// the registry names the key, signs `chat.json` with it (its slug set to your app's) and answers in your app's chat.
//
//   SALTIX_APP_KEY       the developer key itself (keep it out of your shell's history: an .env file, or a secret store)
//   SALTIX_APP_KEY_FILE  or a file holding it, readable by you alone (app.key by default, when there is one)
//   CHAT_SPEC            the chat spec in its JSON form (chat.json next to this file by default)
//   CHAT_STORE           where the server remembers answered requests and its numbers (chat.store.json)
//   NODE_RPC             your own node's wallet interface, for a network with no public relays (a local devnet)
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppKey, EXIT_CONFIG, chatSpecFromJson, fileChatStore, setupCannotWork } from "../../packages/server/dist/index.js";
import { startChat } from "./chat.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The developer key from the environment or its file; the text never reaches the log. */
function developerKey() {
  if (process.env.SALTIX_APP_KEY?.trim()) return AppKey.parse(process.env.SALTIX_APP_KEY);
  const file = process.env.SALTIX_APP_KEY_FILE ?? (existsSync("app.key") ? "app.key" : null);
  if (!file) {
    console.error("No developer key: set SALTIX_APP_KEY, or SALTIX_APP_KEY_FILE to a file holding it (Saltix: My apps → your app → Developer key).");
    process.exit(2);
  }
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    console.error(`${file}: readable by others; chmod 600 it, since whoever holds the key speaks for your app.`);
    process.exit(2);
  }
  return AppKey.parse(readFileSync(file, "utf8"));
}

const key = developerKey();
const json = JSON.parse(readFileSync(process.env.CHAT_SPEC ?? join(here, "chat.json"), "utf8"));
const spec = chatSpecFromJson({ ...json, slug: key.slug });
const log = (level, event, meta) => console.log(`${new Date().toISOString()} ${level} ${event} ${JSON.stringify(meta ?? {})}`);

console.log(`starting ${key}`);
try {
  const chat = await startChat({
    appKey: key, spec, node: process.env.NODE_RPC, store: fileChatStore(process.env.CHAT_STORE ?? "chat.store.json"), log,
    onStop: () => process.exit(EXIT_CONFIG),
  });
  console.log(`the chat of ${chat.slug} answers at ${chat.address} on ${chat.chain.network} (spec v${chat.spec.version})`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { chat.close(); process.exit(0); });
} catch (e) {
  // 78 when restarting cannot help (the key, or chat.json changed under a version served): the message says what does.
  console.error(`not started: ${e.message}`);
  process.exit(setupCannotWork(e) ? EXIT_CONFIG : 1);
}
