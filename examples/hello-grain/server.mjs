// The example's chat as your app's server, from its key and nothing else: the key `grain pair` made in the checkout and
// Saltix paired (app.key, 24-app-studio §3a), or a developer key Saltix gave you (§3):
//
//   npx grain pair && npm run example      or   SALTIX_APP_KEY_FILE=app.key npm run example
//
// The key names the app, its network and its server key. The server finds the network's public relays, checks that
// the registry names the key, signs `chat.json` with it (its slug set to your app's) and answers in your app's chat.
//
//   SALTIX_APP_KEY       the developer key itself (keep it out of your shell's history: an .env file, or a secret store)
//   SALTIX_APP_KEY_FILE  or a file holding it, readable by you alone (app.key in the checkout by default: grain pair writes it)
//   CHAT_SPEC            the chat spec in its JSON form (chat.json next to this file by default)
//   CHAT_STORE           where the server remembers answered requests and its numbers (chat.store.json)
//   NODE_RPC             your own node's wallet interface, for a network with no public relays (a local devnet)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CONFIG, appKeyFromEnvironment, chatSpecFromJson, fileChatStore, setupCannotWork } from "../../packages/server/dist/index.js";
import { startChat } from "./chat.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The key from the environment or app.key where the example runs (`npm run example` starts in the checkout); none, or one
 *  `grain pair` has not paired yet: it says to run grain pair, and exits with 78. The text never reaches the log. */
function serverKey() {
  try {
    return appKeyFromEnvironment();
  } catch (e) {
    console.error(e.message);
    process.exit(setupCannotWork(e) ? EXIT_CONFIG : 2);
  }
}

const key = serverKey();
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
