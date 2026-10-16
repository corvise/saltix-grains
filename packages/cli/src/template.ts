// What `grain init` makes: a hosted grain that runs in a wallet and in `grain dev`, laid out full screen as Saltix shows
// every app (12-grains §7), and the rules a coding agent follows (AGENTS.md, which CLAUDE.md points to).

/** The one line Saltix ends "Copy for an AI agent" with (24-app-studio §4), word for word. */
export const FULL_SCREEN_RULE =
  "Saltix shows apps full screen: keep tappable content clear of grain_info.controls, pad by grain_info.safe_area, test at 475×751, 704×932 and 932×704 dp in grain dev (saltix-grains AGENTS.md).";

export const indexHtml = (name: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${name}</title>
  <style>
    /* Saltix shows the app full screen, edge to edge (AGENTS.md): the system's bars over the page, and the wallet's
       controls (⋯ | ✕) floating in its top right corner. grain.layout() in app.js sets these variables; the values
       here hold until it does, and outside a wallet. */
    :root {
      --saltix-safe-top: env(safe-area-inset-top, 0px);
      --saltix-safe-bottom: env(safe-area-inset-bottom, 0px);
      --saltix-safe-left: env(safe-area-inset-left, 0px);
      --saltix-safe-right: env(safe-area-inset-right, 0px);
      --saltix-controls-top: 0px;
      --saltix-controls-right: 0px;
      --saltix-controls-width: 0px;
      --saltix-controls-height: 0px;
      --bar: #2f6bff;
    }
    html, body { margin: 0; }
    body { font-family: system-ui, sans-serif; background: #f4f6fb; color: #0b1020; min-height: 100vh; }
    body[data-theme="dark"] { background: #0b1020; color: #e6ecff; }
    /* The top bar: its colour runs under the status bar, its row starts level with the wallet's controls, and its title
       stops short of them. */
    header {
      position: sticky; top: 0; z-index: 1; background: var(--bar); color: #fff;
      padding-top: max(var(--saltix-safe-top), var(--saltix-controls-top));
      padding-left: calc(16px + var(--saltix-safe-left));
      padding-right: max(calc(16px + var(--saltix-safe-right)), calc(var(--saltix-controls-right) + var(--saltix-controls-width) + 8px));
    }
    header h1 {
      margin: 0; font-size: 18px; display: flex; align-items: center; min-height: max(48px, var(--saltix-controls-height));
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* The content keeps inside the safe area; on a wide screen (a phone unfolded, or turned) it stays a readable column. */
    main {
      box-sizing: border-box; max-width: 720px; margin: 0 auto;
      padding: 16px calc(16px + var(--saltix-safe-right)) calc(16px + var(--saltix-safe-bottom)) calc(16px + var(--saltix-safe-left));
    }
    button { font: inherit; padding: 12px; border-radius: 12px; border: none; width: 100%; margin: 6px 0; background: var(--bar); color: #fff; }
    pre { white-space: pre-wrap; font-size: 12px; background: rgba(127,127,127,.12); padding: 10px; border-radius: 10px; }
  </style>
</head>
<body>
  <header><h1>${name}</h1></header>
  <main>
    <button id="count">Count</button>
    <pre id="out"></pre>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

export const appJs = `// A grain: the wallet's bridge (./grain.js is @saltix/grain), storage synced through the user's vault.
import { grain, inWallet, walletLink } from "./grain.js";

const out = document.getElementById("out");
const show = (x) => { out.textContent = typeof x === "string" ? x : JSON.stringify(x, null, 2); };

// Full screen as Saltix shows it: the safe area and the wallet's controls as CSS variables, kept current when the phone
// turns or unfolds (index.html lays out by them).
grain.layout();

if (!inWallet()) {
  show("Open this grain in a Saltix wallet:\\n" + walletLink(location.origin + "/.well-known/saltix-grain"));
} else {
  grain.info().then((info) => { document.body.dataset.theme = info.theme; show(info); });
  grain.on("theme", ({ theme }) => { document.body.dataset.theme = theme; });
  // The colour at the top of the page: the wallet draws the status bar's icons and its controls to contrast with it.
  grain.setHeader("#2f6bff").catch(() => {});
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

/** The rules of a full-screen app, for AGENTS.md (the project's and saltix-grains'). */
export const fullScreenRules = `Saltix opens every app full screen, edge to edge: the page is drawn under the status bar and the navigation bar,
and the wallet's controls float over it.

- **Keep text and controls inside the safe area.** \`grain.layout()\` (from \`@saltix/grain\`) sets, on \`:root\`,
  \`--saltix-safe-top\`, \`--saltix-safe-bottom\`, \`--saltix-safe-left\` and \`--saltix-safe-right\` in pixels
  (\`grain_info.safe_area\`) and keeps them current. Pad by them; backgrounds may run under the bars.
- **The wallet's controls \`⋯ | ✕\` float in the top right corner**: \`grain_info.controls\`, and
  \`--saltix-controls-top\`, \`--saltix-controls-right\`, \`--saltix-controls-width\`, \`--saltix-controls-height\`
  (a 96 × 48 box, 8 px from the right inset and 4 px below the top one). Never put anything tappable under them. A top
  bar's title stops short of them (\`padding-right: calc(var(--saltix-controls-right) + var(--saltix-controls-width) + 8px)\`),
  or the bar starts below them (\`top: calc(var(--saltix-controls-top) + var(--saltix-controls-height))\`).
- **No close button of your own.** ✕ and the system's Back close the app; Back goes through your page's history first.
- \`grain.setHeader("#rrggbb")\` names the colour at the top of your page: the wallet draws the status bar's icons and its
  controls to contrast with it.
- Outside Saltix the variables fall back by themselves: an older Saltix (bridge 1–2) draws its header above the page, so
  the safe area and the controls are 0; a plain browser gives its own insets (\`env(safe-area-inset-*)\`).
- **Test at 475×751, 704×932 and 932×704** (the Galaxy Z Fold's sizes in CSS px, which equal dp) in \`grain dev\`'s
  simulator, light and dark. \`grain lint\` warns about a fixed or sticky top bar that uses none of the variables.
`;

const PAGE_COMMANDS = `- \`npx grain dev\`: serves \`public/\` and prints the simulator's address: your page full screen as Saltix shows it, with
  the wallet's controls, at a phone's and the Galaxy Z Fold's sizes, light and dark.
- \`npx grain lint\`: what stops \`grain.json\` from being registered, and warnings about the page.`;

const CHAT_COMMANDS = `- \`npm install\`, then \`npm start\`: runs \`server.mjs\` with the developer key (below); its log is one JSON line per
  event, and \`{"event":"ready",…}\` means the app answers.
- \`npm test\`: \`test/chat.test.mjs\`, the commands end to end with \`testChat\` from \`@saltix/grain-server/testing\` (a
  development relay and registry and a development key, nothing real); add a test for each command you add.
- \`npx grain lint\`: what stops \`grain.json\` from being registered.
- \`npx grain chat-spec\`: lints \`chat.json\` against \`grain.json\` (the server signs the spec with its own key at start).`;

/** Where the SDK's page for a coding agent building an app is: a project has no copy of it. */
export const APP_GUIDE = "https://github.com/corvise/saltix-grains/blob/main/docs/agents/app.md";
/** The card design standard's rules for a coding agent, by its address. */
export const CARDS_GUIDE = "https://github.com/corvise/saltix-grains/blob/main/docs/agents/cards.md";

/**
 * The rules every app follows besides the full-screen ones, as the SDK's docs/agents/app.md and the server `grain init
 * --chat` makes (\`server.mjs\`) have them: the developer key, the spec's version, the unasked budget, state, the
 * exit status of a key that cannot work, payments, and the card design standard.
 */
export const appRules = `1. **The developer key is a secret.** The server reads it from \`SALTIX_APP_KEY\`, the file \`SALTIX_APP_KEY_FILE\` names
   (a systemd credential) or \`app.key\` (owner-only), never from the command line, which shells keep. Never log, print,
   commit or report it, nor \`owner.key\`, \`server.key\` or any other key; if it is pasted to you, write it with
   \`(umask 077 && cat > app.key)\` and never repeat it back.
2. **Raise \`chat.json\`'s \`version\` with every change of it.** Saltix takes a spec only when its version is higher than
   the one it holds (an app made in Saltix starts at 1): a spec changed under the same version reaches nobody, and nothing
   says so. The server remembers the spec it served (in its store) and refuses to start on one changed under the same
   version (exit 78, \`raise "version" above N\`); never delete the store to get past it.
3. **Unasked messages have a budget**: \`chat.notify\` and \`chat.notification\` count against 10 per user in any 24
   hours (100 to a member of the app's team). Past it the SDK throws \`ChatBudgetSpent\` and sends nothing
   (\`chat.notifyTeam\` skips that member), and a wallet drops whatever goes over. Answer requests; never use the budget
   for promotion.
4. **Persistent state goes in \`STATE_DIRECTORY\`**, which systemd sets with \`StateDirectory=\`: \`server.mjs\` keeps its
   store (\`chat.store.json\`: the requests answered, the budget, the team's consoles) there, and in the directory it
   was started from without one. \`ChatServer\`'s default store keeps them in memory only, and a restart forgets them.
5. **Exit with status 78 when the key cannot work**, or the setup otherwise cannot as it stands: the registry does not
   name the key (replaced, revoked, the app retired, not registered), it is not a developer key, it is another network's
   (the test network was reset), or \`chat.json\` changed under a version served. \`server.mjs\` does, at start
   (\`setupCannotWork(e)\`: an \`AppKeyError\` or a \`ChatSetupError\`) and from \`ChatServer\`'s \`onStop\`, and exits with 1
   for anything else; a unit with \`RestartPreventExitStatus=78\` then does not restart a server that restarting cannot
   help.
6. **Money moves only in the wallet, and only to the app's owner.** Ask for a payment with \`chat.invoice\` and a card's
   \`invoice\` block (a page: \`grain.pay\` with the invoice your server signed). A developer key's invoice pays the app's
   owner and nobody else; wallets refuse any other payee. Deliver only once \`chat.paymentOf\` finds the payment on chain
   with the confirmations you need, never on the page's or the user's word. Saltix 0.1.53 and older cannot pay such an
   invoice: say in the card what to do if the payment sheet does not open (update Saltix).
7. **Cards follow the card design standard** ([its rules](${CARDS_GUIDE})), as every Saltix draws them: a status first,
   at most 6 actions, labels of at most 18 characters, the first \`run\` primary, destructive commands named so
   (\`revoke_key\`, \`delete…\`). Check each card a handler returns with \`assertCardStandard(card, spec)\` in the tests.
8. **Test every command end to end** with \`testChat\` (\`@saltix/grain-server/testing\`): it runs the handlers on a
   development relay and registry with a development key, asks as a stranger, the owner or a member, and checks every
   card as Saltix does. Never a real developer key in a test, and never a test against the live network.`;

/** AGENTS.md of a new project: what it is, how to run it, and the rules (a page's, or a chat-only app's). */
export const agentsMd = (slug: string, chat: boolean) => `# AGENTS.md

Rules for coding agents, and people, working on \`${slug}\`: an app that opens inside the Saltix wallet (Saltix
specs/12-grains.md${chat ? ", 22-grain-chats.md and 24-app-studio.md" : ""}). \`CLAUDE.md\` points here. The whole path, from a developer
key to an app that runs, is tested and ships, and what to do with an error report from Saltix's console:
[the SDK's page for a coding agent](${APP_GUIDE}).

## The one rule to keep

${FULL_SCREEN_RULE}

## What is here

${chat ? `- \`grain.json\`: the manifest of a chat-only app (\`entry: chat\`): no page; Saltix draws its home from \`chat.json\`.
- \`chat.json\`: the chat spec: the commands users run (version 2, above the 1 an app made in Saltix starts with).
- \`server.mjs\`: the chat's server, \`ChatServer\` from \`@saltix/grain-server\`, run by the developer key Saltix gave.
  \`package.json\`: \`npm start\` runs it.
- \`chat.mjs\`: the handlers, one for each command, which \`server.mjs\` and the tests (\`test/\`, \`npm test\`) both run.
- If the app gets a page of its own later (a hosted or sealed \`entry\`, its files in \`public/\`), the full-screen rules
  below apply to it.` : `- \`public/\`: the page. \`public/grain.js\` is \`@saltix/grain\`, the wallet's bridge: do not edit it (\`grain init\` copies it).
- \`grain.json\`: the manifest. The app's chat, when it has one, is a server of its own (\`ChatServer\`, the guide above).`}
- \`owner.key\` (and \`server.key\`, \`app.key\` once made): secrets. Never commit, print, log or paste them.

## Commands

${chat ? CHAT_COMMANDS : PAGE_COMMANDS}

## The rules every app follows

${appRules}

More in [the SDK's page](${APP_GUIDE}#the-rules-every-app-follows).

## A full-screen app

${fullScreenRules}`;

export const claudeMd = `# CLAUDE.md

The rules for this project are in [AGENTS.md](AGENTS.md), shared with every coding agent:

@AGENTS.md
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
  debug Saltix (the emulator reaches this computer at 10.0.2.2), or the simulator it prints in a browser.
- Saltix shows the app full screen: \`AGENTS.md\` says how the page keeps clear of the wallet's controls (coding agents
  read it too; \`CLAUDE.md\` points to it).
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
  new developer key in Saltix, since restarting does not help. Under systemd: the key as a credential
  (\`LoadCredential=app-key:…\`, \`Environment=SALTIX_APP_KEY_FILE=%d/app-key\`), \`StateDirectory=\` for its store, and
  \`RestartPreventExitStatus=78\`.
- **Add a command:** declare it in \`chat.json\`, add its handler in \`server.mjs\`, and raise \`version\` with every change:
  a wallet takes only a version above the one it holds, and an app made in Saltix starts at 1.
- \`grain publish --node <url>\` registers the slug (a deposit by its length: 100 SALT for 3–5 characters, 30 for 6–7,
  10 for 8 or more; back 30 days after \`grain retire\`). Or make the app in Saltix: My apps → New app.
- \`grain cert init\` makes \`server.key\`; \`grain configure --slug ${slug} --server server.key --node <url>\` names it in the
  registry; \`grain app-key make --slug ${slug} --node <url>\` writes \`app.key\`, the developer key the server runs with.
- Run the chat: \`ChatServer.start({ appKey, spec })\` with \`chat.json\` (docs/first-app.md).
- \`AGENTS.md\` is what a coding agent follows here (\`CLAUDE.md\` points to it).

\`owner.key\`, \`server.key\` and \`app.key\` are secrets: keep them out of git.
`;
