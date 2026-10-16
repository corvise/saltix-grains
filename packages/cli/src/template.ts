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

export const gitignore = `owner.key
server.key
app.key
signed.json
*.store.json
# Every other key file too (sponsor.key, a rater's key…): whoever holds one speaks for its account.
*.key
bundle.zip
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

/** A chat-only grain's starting spec (Saltix 22-grain-chats §2): an intro and one command to build on. Version 2: an app
 *  made in Saltix starts with a spec of version 1 that its owner key signed, and a wallet takes only a higher one. */
export const chatJson = (slug: string, name: string) => JSON.stringify({
  slug,
  version: 2,
  intro: { en: `${name}: a chat-only app in Saltix.` },
  commands: [
    { name: "hello", title: { en: "Say hello" }, help: { en: "A greeting" }, params: [{ name: "name", title: { en: "Your name" }, kind: { text: { max: 32 } } }] },
  ],
  keeps: 0,
  ai: false,
}, null, 2) + "\n";

export const chatReadme = (slug: string) => `# ${slug}

A chat-only grain: an app users talk to in Saltix, with no page and nothing to host (Saltix specs/24-app-studio.md).

- **Run it:** put the developer key in \`app.key\` (\`(umask 077 && pbpaste > app.key)\`; never on the command line,
  shells keep their history), then \`npm install\` and \`npm start\`: \`server.mjs\` is the server, its log one JSON line
  per event. It exits with 78 when the key cannot work (replaced, revoked, the app retired, another network's): make a
  new developer key in Saltix, since restarting does not help.
- **Add a command:** declare it in \`chat.json\`, add its handler in \`server.mjs\`, and raise \`version\` with every change:
  a wallet takes only a version above the one it holds, and an app made in Saltix starts at 1.
- \`grain publish --node <url>\` registers the slug (a deposit by its length: 100 SALT for 3–5 characters, 30 for 6–7,
  10 for 8 or more; back 30 days after \`grain retire\`). Or make the app in Saltix: My apps → New app.
- \`grain cert init\` makes \`server.key\`; \`grain configure --slug ${slug} --server server.key --node <url>\` names it in the
  registry; \`grain app-key make --slug ${slug} --node <url>\` writes \`app.key\`, the developer key the server runs with.
- Run the chat: \`ChatServer.start({ appKey, spec })\` with \`chat.json\` (docs/first-app.md).

\`owner.key\`, \`server.key\` and \`app.key\` are secrets: keep them out of git.
`;
