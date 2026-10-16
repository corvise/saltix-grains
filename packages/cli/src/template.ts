// What `grain init` makes: a hosted grain that runs in a wallet and in `grain dev`.
export const indexHtml = (name: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${name}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #f4f6fb; color: #0b1020; }
    body[data-theme="dark"] { background: #0b1020; color: #e6ecff; }
    button { font: inherit; padding: 12px; border-radius: 12px; border: none; width: 100%; margin: 6px 0; background: #2f6bff; color: white; }
    pre { white-space: pre-wrap; font-size: 12px; background: rgba(127,127,127,.12); padding: 10px; border-radius: 10px; }
  </style>
</head>
<body>
  <h1>${name}</h1>
  <button id="count">Count</button>
  <pre id="out"></pre>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

export const appJs = `// A grain: the wallet's bridge (./grain.js is @saltix/grain), storage synced through the user's vault.
import { grain, inWallet, walletLink } from "./grain.js";

const out = document.getElementById("out");
const show = (x) => { out.textContent = typeof x === "string" ? x : JSON.stringify(x, null, 2); };

if (!inWallet()) {
  show("Open this grain in a Saltix wallet:\\n" + walletLink(location.origin + "/.well-known/saltix-grain"));
} else {
  grain.info().then((info) => { document.body.dataset.theme = info.theme; show(info); });
  grain.on("theme", ({ theme }) => { document.body.dataset.theme = theme; });
  grain.ready();
}

document.getElementById("count").addEventListener("click", async () => {
  try {
    const n = Number((await grain.storage.get("count")) ?? "0") + 1;
    await grain.storage.set("count", String(n));
    show(\`Counted \${n} times, on every phone of this account.\`);
  } catch (e) {
    show(\`\${e.code ?? ""} \${e.message}\`);
  }
});
`;

/** Keys first: owner.key, server.key, app.key, sponsor.key and a rater's key are all *.key, and none is ever
 *  committed. Then what the tools make. */
export const gitignore = `# Keys (owner.key, server.key, app.key, sponsor.key…): whoever holds one speaks for the grain.
*.key
signed.json
bundle.zip
*.store.json
node_modules/
`;

export const readme = (slug: string) => `# ${slug}

A grain: an app that opens inside a Saltix wallet (Saltix specs/12-grains.md).

- \`grain dev\` serves \`public/\` with the manifest signed for this computer: open the link it prints in a
  debug Saltix (the emulator reaches this computer at 10.0.2.2).
- \`grain lint\` checks \`grain.json\`; set \`entry.hosted\` to your https site and \`icon\` (\`grain icon icon.png\`).
- Put \`public/\` on your site and the signed manifest (\`grain sign\`) at \`/.well-known/saltix-grain\`.
- \`grain publish --node <url>\` registers the slug (a deposit by its length: 100 SALT for 3–5 characters, 30 for 6–7,
  10 for 8 or more; back 30 days after \`grain retire\`).

\`owner.key\` is the grain's owner key: keep it secret and out of git.
`;

/** A chat-only grain's starting spec (Saltix 22-grain-chats §2): an intro and one command to build on. */
export const chatJson = (slug: string, name: string) => JSON.stringify({
  slug,
  version: 1,
  intro: { en: `${name}: a chat-only app in Saltix.` },
  commands: [
    { name: "hello", title: { en: "Say hello" }, help: { en: "A greeting" }, params: [{ name: "name", title: { en: "Your name" }, kind: { text: { max: 32 } } }] },
  ],
  keeps: 0,
  ai: false,
}, null, 2) + "\n";

export const chatReadme = (slug: string) => `# ${slug}

A chat-only grain: an app users talk to in Saltix, with no page and nothing to host (Saltix specs/24-app-studio.md).

- \`grain publish --node <url>\` registers the slug (a deposit by its length: 100 SALT for 3–5 characters, 30 for 6–7,
  10 for 8 or more; back 30 days after \`grain retire\`). Or make the app in Saltix: My apps → New app.
- \`grain cert init\` makes \`server.key\`; \`grain configure --slug ${slug} --server server.key --node <url>\` names it in the
  registry; \`grain app-key make --slug ${slug} --node <url>\` writes \`app.key\`, the developer key the server runs with.
- Run the chat: put the developer key in \`app.key\` (\`(umask 077 && pbpaste > app.key)\`; never on the command line,
  shells keep their history), then \`npm install\` and \`npm start\`. \`server.mjs\` answers \`chat.json\`'s commands; add a
  handler for each command you add, and raise \`version\` in \`chat.json\` with every change (a wallet keeps the highest
  version it has seen).
- Its log is one JSON line per event; it exits with 78 when the key cannot work (replaced, revoked, the app retired,
  another network's): make a new developer key in Saltix, since restarting does not help.

\`owner.key\`, \`server.key\` and \`app.key\` are secrets: keep them out of git (\`.gitignore\` does).
`;

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
