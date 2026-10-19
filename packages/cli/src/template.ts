// What `grain init` makes: a hosted grain that runs in a wallet and in `grain dev`, drawn edge to edge (it declares
// viewport-fit=cover and keeps inside the insets, 12-grains §7), that checks first and renders after (its splash until
// its gate decides, 12-grains §5.1a), and the rules a coding agent follows (AGENTS.md, which CLAUDE.md points to).
import { httpsLinkOk } from "@saltix/grain-server";

/** The one line Saltix ends "Copy for an AI agent" with (24-app-studio §4), word for word. */
export const FULL_SCREEN_RULE =
  "Saltix lays an app's page inside the safe area; full screen only with viewport-fit=cover: then pad by grain_info.safe_area, keep tappable content clear of grain_info.controls, test at 475×751, 704×932 and 932×704 dp in grain dev (saltix-grains AGENTS.md).";

export const indexHtml = (name: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${name}</title>
  <style>
    /* Edge to edge (viewport-fit=cover above; AGENTS.md): the system's bars over the page, and the wallet's controls
       (⋯ | ✕) floating in its top right corner. Saltix sets these variables itself, and grain.layout() in app.js where
       it does not; the values here are a plain browser's. Without viewport-fit=cover Saltix would lay the page out
       inside the safe area, below its controls, and every variable would be 0. */
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
    /* Check first, render after (AGENTS.md): the splash, the app's mark and name and nothing of its UI, until app.js's
       gate decides; then the app, or the refusal. */
    [hidden] { display: none !important; }
    .splash, .refused { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
      box-sizing: border-box; padding: calc(24px + var(--saltix-safe-top)) calc(24px + var(--saltix-safe-right)) calc(24px + var(--saltix-safe-bottom)) calc(24px + var(--saltix-safe-left)); text-align: center; }
    .mark { width: 72px; height: 72px; border-radius: 20px; background: var(--bar); color: #fff; display: grid; place-items: center; font-size: 32px; font-weight: 700; }
    .refused p { max-width: 320px; margin: 0; opacity: .8; }
  </style>
</head>
<body>
  <div class="splash" data-grain-splash><div class="mark" aria-hidden="true">${(name.trim()[0] ?? "?").toUpperCase()}</div><strong>${name}</strong></div>
  <div id="app" hidden>
    <header><h1>${name}</h1></header>
    <main>
      <button id="count">Count</button>
      <pre id="out"></pre>
    </main>
  </div>
  <div class="refused" id="refused" hidden><div class="mark" aria-hidden="true">${(name.trim()[0] ?? "?").toUpperCase()}</div><h2 id="refused-title"></h2><p id="refused-body"></p></div>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

export const appJs = `// A grain: the wallet's bridge (./grain.js is @saltix/grain), storage synced through the user's vault.
import { TEAM, gateOf, grain, inWallet, walletLink } from "./grain.js";

const out = document.getElementById("out");
const show = (x) => { out.textContent = typeof x === "string" ? x : JSON.stringify(x, null, 2); };

// Edge to edge (index.html declares viewport-fit=cover): the safe area and the wallet's controls as CSS variables, kept
// current when the phone turns or unfolds (index.html lays out by them). Saltix sets them too, and its values win over
// these: this is for older ones, a web wallet and plain browsers.
grain.layout();

// Check first, render after (AGENTS.md): index.html shows only its splash until the gate below decides, then the app or
// the refusal, never the app's UI first. SIGN_IN is your server's sign-in, where SignIns from @saltix/grain-server
// answers \`challenge\` and \`session\` (empty: an app for everyone, with no server yet). FOR is whom the app is for once
// it signs in: TEAM (its owner, developers and viewers), [...TEAM, "user"] for a private app's members too.
const SIGN_IN = "";
const FOR = TEAM;
const REFUSED = {
  refused: ["This app is for its team", "Its owner can invite you."],
  update: ["Update Saltix", "This version of Saltix cannot confirm that you are on the app's team."],
  declined: ["Sign in to continue", "The app signs you in under a key of its own, never your address."],
  failed: ["The app did not open", "Its server did not answer. Try again in a minute."],
  outside: ["Open it in Saltix", walletLink(location.origin + "/.well-known/saltix-grain")],
};

async function gate() {
  if (!inWallet()) return "outside";
  if (!SIGN_IN) return "open";
  return grain.signIn({ url: SIGN_IN }).then((s) => gateOf(s, FOR), (e) => gateOf(e, FOR));
}

const outcome = await gate();
document.querySelector("[data-grain-splash]").remove();
if (outcome === "open") {
  document.getElementById("app").hidden = false;
  grain.info().then((info) => { document.body.dataset.theme = info.theme; show(info); });
  grain.on("theme", ({ theme }) => { document.body.dataset.theme = theme; });
  // The colour at the top of the page: the wallet draws the status bar's icons and its controls to contrast with it.
  grain.setHeader("#2f6bff").catch(() => {});
} else {
  // None of the app's UI: whom it is for, and what to do.
  const [title, body] = REFUSED[outcome];
  document.getElementById("refused-title").textContent = title;
  document.getElementById("refused-body").textContent = body;
  document.getElementById("refused").hidden = false;
}
if (inWallet()) grain.ready().catch(() => {});

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

/** The rules of an app's page, for AGENTS.md (the project's and saltix-grains'): safe by default, full screen only with
 *  viewport-fit=cover and the insets. */
export const fullScreenRules = `**Safe by default; full screen only with viewport-fit=cover and the insets.** Saltix opens every app as a full app, its
controls \`⋯ | ✕\` floating in the top right corner, and lays the page out as browsers do (Saltix 12-grains §7):

- **Inside the safe area, by default.** A page that says nothing is drawn below the status bar, the cutout and a band
  that holds the controls, above the navigation bar or gesture area and the keyboard. Nothing of the system or the
  wallet is ever over it; the band takes the page's colour (\`grain.setHeader\`, until the next call, else the first
  \`<meta name="theme-color">\` whose \`media\` matches and which is an opaque colour, else the background of
  \`<body>\`, then \`<html>\`). Saltix reads it again when the head changes, once the page has loaded and when the theme
  changes, not when a script changes the body's background alone: change the \`theme-color\` with it, or call
  \`grain.setHeader\`. Such a page needs nothing else.
- **Edge to edge only with \`viewport-fit=cover\`**: \`<meta name="viewport" content="width=device-width,
  initial-scale=1, viewport-fit=cover">\`. The page is then drawn under the status bar and the navigation bar, and must
  keep its text and controls inside the safe area itself: Saltix sets, on \`:root\`, \`--saltix-safe-top\`,
  \`--saltix-safe-bottom\`, \`--saltix-safe-left\` and \`--saltix-safe-right\` in pixels (\`grain_info.safe_area\`) and keeps
  them current when the phone turns, unfolds or folds, and when a keyboard opens. Pad by them; backgrounds may run
  under the bars. \`grain.layout()\` (from \`@saltix/grain\`) sets the same values where Saltix does not, below Saltix's
  own, and takes them away on \`stop()\`. Never write these variables into \`:root\`'s inline style: an inline value
  beats Saltix's and stays stale when the phone turns.
- **The wallet's controls \`⋯ | ✕\` float in the top right corner**, over an edge-to-edge page: \`grain_info.controls\`,
  and \`--saltix-controls-top\`, \`--saltix-controls-right\`, \`--saltix-controls-width\`, \`--saltix-controls-height\`
  (a 96 × 48 box, 8 px from the right inset and 4 px below the top one; 0 inside the safe area, where they sit in the
  band). Never put anything tappable under them. A top bar's title stops short of them
  (\`padding-right: calc(var(--saltix-controls-right) + var(--saltix-controls-width) + 8px)\`), or the bar starts below
  them (\`top: calc(var(--saltix-controls-top) + var(--saltix-controls-height))\`).
- **No close button of your own.** ✕ and the system's Back close the app; Back goes through your page's history first.
- Saltix's splash (the app's icon and name) shows while the page loads and goes once it has loaded: \`grain.ready()\`
  neither holds nor hides it (Saltix ignores it today). A page that checks first shows its own splash until its gate
  decides (rule 10).
- \`grain.setHeader("#rrggbb")\` names the colour at the top of your page: the wallet draws the band, the status bar's
  icons and its controls to contrast with it. It holds until the next call: call it again when your theme changes.
- **Saltix gives a page no design tokens**: no colours, fonts, corners or spacing of its own, and no variables but the
  eight above. Bring your own palette, light and dark, and switch by \`grain_info.theme\` (\`dark\` or \`light\`) and the
  \`theme\` event (\`grain.on("theme", …)\`), not by \`prefers-color-scheme\`, which need not match the theme chosen in
  Saltix. Saltix follows your colours instead: its band, the bars' icons and its controls.
- Outside Saltix the variables fall back by themselves: an older Saltix (bridge 1–2, and 0.1.53) draws its header above
  the page, so the safe area and the controls are 0; a plain browser gives its own insets (\`env(safe-area-inset-*)\`).
- **Test at 475×751, 704×932 and 932×704** (the Galaxy Z Fold's sizes in CSS px, which equal dp), on a 360×780 phone and
  on the iPhone-like screen in \`grain dev\`'s simulator, light and dark: it frames the page as Saltix does, in both ways.
  \`grain lint\` warns about a page that declares \`viewport-fit=cover\` and reads no inset (\`cover-without-insets\`), and
  about a bar pinned to the top of such a page that keeps clear of nothing (\`full-screen-top-bar\`).
`;

const PAGE_COMMANDS = `- \`npm install\` once: it links the \`grain\` command (and the SDK) from the saltix-grains checkout beside
  this project, so \`npx grain …\` here runs it, never the npm registry's unrelated package of that name.
- \`npx grain status\` first, every session, and \`npx grain doctor\`: where the project stands and the next step. An
  app's server (its chat, invoices, a sign-in) runs with a key \`npx grain pair\` pairs by a QR code (rule 1).
- \`npx grain dev\`: serves \`public/\` and prints the simulator's address: your page framed as Saltix frames it, with
  the wallet's controls, at a phone's, the Galaxy Z Fold's and an iPhone-like screen's sizes, light and dark.
- \`npx grain lint\`: what stops \`grain.json\` and \`connect.json\` from being registered, and warnings about the page and
  permissions nothing uses.
- \`npx grain publish --wallet\`: a QR code the owner's Saltix registers the app or its new version from (an app made in
  Saltix is its owner's phone's); without \`--wallet\` it signs with \`owner.key\` on the test network, after
  \`npx grain faucet --wait\` for test SALT. Registry commands reach the test network through its public relays, each
  pinned by its certificate: no node needed. \`--node URL\` is for a node of your own.
- \`npx grain profile\`: once the app is registered, sets its Connect profile from \`connect.json\` the same way.`;

const CHAT_COMMANDS = `- \`npx grain status\` first, every session: whether the server is paired with its app, and what to run next.
  \`npx grain pair\` pairs it (rule 1): a QR code the app owner's Saltix scans; the key is made here and never leaves.
  \`npx grain doctor\` checks the rest and names the next step.
- \`npm install\`, then \`npm start\`: runs \`server.mjs\` with the paired key (rule 1); its log is one JSON line per
  event, and \`{"event":"ready",…}\` means the app answers. \`npm install\` also links the \`grain\` command from the
  saltix-grains checkout beside this project, so \`npx grain …\` here runs it.
- \`npm test\`: \`test/chat.test.mjs\`, the commands end to end with \`testChat\` from \`@saltix/grain-server/testing\` (a
  development relay and registry and a development key, nothing real); add a test for each command you add.
- \`npx grain lint\`: what stops \`grain.json\` and \`connect.json\` from being registered; \`npx grain profile\` sets the
  Connect profile once the app is registered (a QR code for the owner's Saltix, or \`--key owner.key\`).
- \`npx grain chat-spec\`: lints \`chat.json\` against \`grain.json\` (the server signs the spec with its own key at start).
- \`npx grain show --slug <slug>\`, \`npx grain app-key --file app.key\`: what the registry holds, whether it names the key.
  Every registry command and \`npx grain faucet\` (test SALT) reach the test network through its public relays, each
  pinned by its certificate: no node needed. \`--node URL\` is for a node of your own.`;

/** The SDK's page to read first: what runs where, whether an app needs a server, the lifecycle as one checklist. */
export const HOW_IT_WORKS = "https://github.com/corvise/saltix-grains/blob/main/docs/how-it-works.md";
/** Where the SDK's page for a coding agent building an app is: a project has no copy of it. */
export const APP_GUIDE = "https://github.com/corvise/saltix-grains/blob/main/docs/agents/app.md";
/** The card design standard's rules for a coding agent, by its address. */
export const CARDS_GUIDE = "https://github.com/corvise/saltix-grains/blob/main/docs/agents/cards.md";
/** The SDK's pages on the Saltix protocol, as an app needs it (the protocol's own repository is not public). */
export const PROTOCOL_DOCS = "https://github.com/corvise/saltix-grains/blob/main/docs/protocol";

/**
 * The rules every app follows besides the full-screen ones, as the SDK's docs/agents/app.md and the server `grain init
 * --chat` makes (\`server.mjs\`) have them: the server's key, paired and never copied, the spec's version, the unasked budget, state, the
 * exit status of a key that cannot work, payments, the card design standard, tests, the Connect profile, checking
 * first, then rendering, and naming people.
 */
export const appRules = `1. **The server's key is made where it runs and never leaves it.** Start every session with \`grain status\`. When it
   is not \`paired\`, run \`grain pair\` (in the background, or \`grain pair --no-wait\` and then \`grain pair\`), show
   the user its QR code (the terminal's, or \`.grain/pair.html\`) and wait: the user scans it with Saltix, checks the
   6-digit code and confirms there, and \`grain pair\` writes \`app.key\` once the registry names the key. Never ask the
   user to paste, type or send a key. The server reads \`app.key\` (owner-only), \`SALTIX_APP_KEY\` or the file
   \`SALTIX_APP_KEY_FILE\` names (a systemd credential), never from the command line, which shells keep, and refuses to
   start without one (\`chat_unpaired\`). Never log, print, commit or report a key, nor \`owner.key\` or \`server.key\`.
   Only for a host where no command runs does a developer key made in Saltix stand in: if one is pasted to you, write it
   with \`(umask 077 && cat > app.key)\`, never repeat it back, and ask them to replace it in Saltix once it runs: it is
   in the chat's history now. **One app, one key, one program**: the key is this app's alone and runs this project's
   server only. Never run the SDK's example or another program with it beside this one, and never put another app's key
   or slug here: two programs on one key both answer in its chat.
2. **Raise \`chat.json\`'s \`version\` with every change of it.** Saltix takes a spec only when its version is higher than
   the one it holds (an app made in Saltix starts at 1, so a server with its developer key serves 2 or more, and refuses
   to start on 1: \`chat_spec_version_starter\`): a spec changed under the same version reaches nobody, and nothing
   says so. The server remembers the spec it served (in its store) and refuses to start on one changed under the same
   version (exit 78, \`raise "version" above N\`); never delete the store to get past it.
3. **Unasked messages have a budget**: \`chat.notify\` and \`chat.notification\` count against 10 per user in any 24
   hours (100 to a member of the app's team). Past it the SDK throws \`ChatBudgetSpent\` and sends nothing
   (\`chat.notifyTeam\` skips that member), and a wallet drops whatever goes over. Answer requests; never use the budget
   for promotion.
4. **Persistent state goes in \`STATE_DIRECTORY\`**, which systemd sets with \`StateDirectory=\`: \`server.mjs\` keeps its
   store (\`chat.store.json\`: the requests answered, the budget, the team's consoles) there, and in the directory it
   was started from without one. \`ChatServer\`'s default store keeps them in memory only, and a restart forgets them.
5. **Exit with status 78 when the key cannot work**, or the setup otherwise cannot as it stands: there is no key (not
   paired yet: \`chat_unpaired\`, run \`grain pair\`), the registry does not name the key (replaced, revoked, the app retired, not registered), it is not a developer key, it is another network's
   (the test network was reset), or \`chat.json\` changed under a version served. \`server.mjs\` does, at start
   (\`setupCannotWork(e)\`: an \`AppKeyError\` or a \`ChatSetupError\`) and from \`ChatServer\`'s \`onStop\`, and exits with 1
   for anything else; a unit with \`RestartPreventExitStatus=78\` then does not restart a server that restarting cannot
   help.
6. **Money moves only in the wallet, and only to the app's owner.** Ask for a payment with \`chat.invoice\` and a card's
   \`invoice\` block (a page: \`grain.pay\` with the invoice your server signed). A developer key's invoice pays the app's
   owner and nobody else; wallets refuse any other payee. Deliver only once \`chat.paymentOf\` finds the payment on chain
   with the confirmations you need, never on the page's or the user's word. Saltix 0.1.53 and older cannot pay such an
   invoice: say in the card what to do if the payment sheet does not open (update Saltix).
7. **Cards follow the card design standard** ([its rules](${CARDS_GUIDE})), as every Saltix draws them: a status first
   (build the card with it first, even when its text depends on what comes after),
   at most 6 actions, labels of at most 18 characters, the first \`run\` primary, destructive commands named so
   (\`revoke_key\`, \`delete…\`). Check each card a handler returns with \`assertCardStandard(card, spec)\` in the tests.
8. **Test every command end to end** with \`testChat\` (\`@saltix/grain-server/testing\`): it runs the handlers on a
   development relay and registry with a development key, asks as a stranger, the owner or a member, and checks every
   card as Saltix does. Never a real developer key in a test, and never a test against the live network.
9. **Ship a complete Connect profile, and ask only for what the app uses.** \`connect.json\` is what Saltix's Connect
   sheet shows before anyone signs in, as the app's own words: a tagline that says what the app is, what it does,
   highlights that are facts (not slogans), and what it keeps about a user and for how long (required when
   \`grain.json\` asks for \`address\` or \`storage\`), in English and Russian. \`grain lint\` checks it, and warns about a
   permission nothing in the app uses: drop it, since the sheet shows every one. \`grain profile\` sets it (a QR code for
   the owner's Saltix, or \`--key owner.key\` on the test network); the registry takes each change at a higher revision.
10. **Check first, then render.** A page that is for some people only (its team, a private circle) shows nothing of
   itself before it knows who signed in: a splash (its icon and name, in an element marked \`data-grain-splash\`; the
   rest \`hidden\`) until \`grain.signIn({ url })\` resolves, then \`gateOf(signIn, TEAM)\` decides: the app, or a refusal
   page with none of its UI ("this app is for its team; its owner can invite you"), or "update Saltix" for a Saltix that
   sends no member proof. A public app for a limited circle shows strangers that refusal page; a private app never loads
   for them at all (Saltix checks the registry first). The server answers the sign-in with \`SignIns\` and
   \`signInAnswer\` (\`@saltix/grain-server\`) and checks the session's rights again on every request: the page's gate
   decides what people see, never what they may do. \`ChatMemberUnchecked\` (the node did not answer) is a 503, so the
   page offers to try again, never a refusal. \`grain lint\` warns about a page that shows anything else first
   (\`render-before-sign-in\`).
11. **Name people only by what they gave the app.** Saltix gives an app nobody's name: not the name an account sets for
   itself (its profile, Saltix 09-relay §1.5), not its username. A user is their grain key, a pseudonym of this app
   alone (\`ask.key\`, \`grain.login\`); only the team and a private app's members are known as accounts (\`ask.member\`,
   \`SignIns\`). Never show a key as a name. Where the app shows people to each other, it shows the name each one typed
   in it (the app's own data: \`connect.json\`'s privacy line says so) or an address the user shared
   (\`grain.requestAddress\`), shortened; a name someone typed is never proof of who they are.`;

/** AGENTS.md of a new project: what it is, how to run it, and the rules (a page's, or a chat-only app's). */
export const agentsMd = (slug: string, chat: boolean) => `# AGENTS.md

Rules for coding agents, and people, working on \`${slug}\`: an app that opens inside the Saltix wallet (the protocol:
[grains](${PROTOCOL_DOCS}/grains.md)${chat ? `, [grain chats](${PROTOCOL_DOCS}/grain-chats.md) and [the app studio](${PROTOCOL_DOCS}/app-studio.md)` : ""}, in the SDK's
[docs/protocol/](${PROTOCOL_DOCS}/README.md)). \`CLAUDE.md\` points here. The whole path, from pairing the server
to an app that runs, is tested and ships, and what to do with an error report from Saltix's console:
[the SDK's page for a coding agent](${APP_GUIDE}).

## Start here, every session

[How a Saltix mini-app works](${HOW_IT_WORKS}): what runs where, whether this app needs a server at all, and every step
from here to a published app, as one checklist. Then:

1. \`npx grain status\`. \`paired\`: go on. Anything else: step 2, never a key pasted by the user.
2. \`npx grain pair\`: it prints a QR code (and writes \`.grain/pair.html\`). Show it to the user and say: scan it with
   Saltix (the phone's camera, or My apps → Pair a server), check that Saltix shows the same 6-digit code, confirm with
   the PIN. It waits, answers the phone, and once the registry names the key writes \`app.key\` and \`app.json\`. Run it
   in the background, or \`npx grain pair --no-wait\` to show the code and then \`npx grain pair\` to wait.
3. \`npx grain doctor\`: what is left, and the exact next step.

## The one rule to keep

${FULL_SCREEN_RULE}

## What is here

- \`connect.json\`: the app's Connect profile, what Saltix shows before anyone signs in (rule 9 below); \`npx grain
  profile\` sets it.
${chat ? `- \`grain.json\`: the manifest of a chat-only app (\`entry: chat\`): no page; Saltix draws its home from \`chat.json\`.
- \`chat.json\`: the chat spec: the commands users run (version 4: above the 1 an app made in Saltix starts with and
  the 3 the SDK's example serves, since a wallet takes only a higher version).
- \`server.mjs\`: the chat's server, \`ChatServer\` from \`@saltix/grain-server\`, run by the developer key Saltix gave.
  \`package.json\`: \`npm start\` runs it.
- \`chat.mjs\`: the handlers, one for each command, which \`server.mjs\` and the tests (\`test/\`, \`npm test\`) both run.
- If the app gets a page of its own later (a hosted or sealed \`entry\`, its files in \`public/\`), the frame's rules
  below apply to it.` : `- \`public/\`: the page. \`public/grain.js\` is \`@saltix/grain\`, the wallet's bridge: do not edit it (\`grain init\` copies it).
- \`grain.json\`: the manifest. The app's chat, when it has one, is a server of its own (\`ChatServer\`, the guide above).
- \`bundle.zip\`, once the app is sealed (\`npx grain bundle\`): the same bytes from the same files on any computer (files
  stored, at most 20 MiB). Rebuild it in CI and fail when \`grain.json\` changes; never edit \`entry.sealed\` by hand.`}
- \`owner.key\` (and \`server.key\`, \`app.key\` once \`grain pair\` wrote it, \`.grain/pair.key\` while it waits): secrets.
  Never commit, print, log or paste them. \`app.json\` (the app, its network, the key's public half) is not.
- \`.grain/\`: \`grain pair\`'s state and the steps' log (\`log.jsonl\`: codes and timings, nothing secret), out of git.

## Commands

${chat ? CHAT_COMMANDS : PAGE_COMMANDS}

## The rules every app follows

${appRules}

More in [the SDK's page](${APP_GUIDE}#the-rules-every-app-follows).

## The page's frame, and what Saltix gives a page

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
# grain pair's state (a key not paired yet, the offer's page) and the steps' log.
.grain/
`;

export const readme = (slug: string) => `# ${slug}

A grain: an app that opens inside a Saltix wallet (Saltix 12-grains: the SDK's [docs/protocol/grains.md](${PROTOCOL_DOCS}/grains.md)).

- **How it works**, whether the app needs a server (a page alone needs none) and how a page is published:
  [docs/how-it-works.md](${HOW_IT_WORKS}). \`npm install\` first: it links the \`grain\` command from the checkout.
- \`grain dev\` serves \`public/\` with the manifest signed for this computer: open the link it prints in a
  debug Saltix (the emulator reaches this computer at 10.0.2.2), or the simulator it prints in a browser.
- Saltix lays the page inside the safe area unless it declares \`viewport-fit=cover\` (this one does): \`AGENTS.md\` says
  how the page keeps clear of the system's bars and the wallet's controls (coding agents read it too; \`CLAUDE.md\`
  points to it).
- Check first, render after: \`public/index.html\` shows only a splash (\`data-grain-splash\`) until \`public/app.js\`'s
  gate decides; set \`SIGN_IN\` to your server's sign-in and \`FOR\` to whom the app is for (\`AGENTS.md\`, rule 10).
- \`grain lint\` checks \`grain.json\` and \`connect.json\` (the Connect profile Saltix shows before anyone signs in: write
  it for your app); set \`entry.hosted\` to your https site and \`icon\` (\`grain icon icon.png\`).
- Put \`public/\` on your site and the signed manifest (\`grain sign\`) at \`/.well-known/saltix-grain\`.
- \`grain publish\` registers the slug (a deposit by its length: 100 SALT for 3–5 characters, 30 for 6–7, 10 for 8 or
  more; back 30 days after \`grain retire\`), through the test network's public relays (\`--node <url>\` for your own
  node); on the test network \`grain faucet --wait\` gives \`owner.key\`'s account test SALT first. \`grain profile\`
  then sets the Connect profile from \`connect.json\`.

\`owner.key\` is the grain's owner key: keep it secret and out of git.
`;

/**
 * A chat-only grain's starting spec (Saltix 22-grain-chats §2): an intro and one command to build on. A wallet takes a
 * spec only when its version is higher than the one it holds, and refuses a lower one: an app made in Saltix holds a
 * spec of version 1 its owner key signed, and the SDK's example (\`npm run example\`) serves version 3 under the same
 * key. So the project starts at 4, above both, and its first answer reaches a wallet that ran the example.
 */
export const CHAT_SPEC_FIRST_VERSION = 4;

/** \`chat.json\` of a new chat-only grain, at \`CHAT_SPEC_FIRST_VERSION\`. */
export const chatJson = (slug: string, name: string) => JSON.stringify({
  slug,
  version: CHAT_SPEC_FIRST_VERSION,
  intro: { en: `${name}: a chat-only app in Saltix.` },
  commands: [
    { name: "hello", title: { en: "Say hello" }, help: { en: "A greeting" }, params: [{ name: "name", title: { en: "Your name" }, kind: { text: { max: 32 } } }] },
  ],
  keeps: 0,
  ai: false,
}, null, 2) + "\n";

/**
 * A new app's Connect profile (`connect.json`, Saltix 19-connect §11): the JSON form's `profile` object without `owner`
 * and `revision`, which `grain profile` fills in. It describes the app `grain init` makes, truthfully, in English and
 * Russian, so it passes `grain lint` as it is and shows what a good profile says: what the app is in one line, what it
 * does, facts it is good at, and what it keeps about a user and for how long. Rewrite it as the app grows.
 */
export function connectJson(slug: string, name: string, chat: boolean): string {
  const website = `https://${slug}.example/`;
  const texts = chat
    ? {
      en: {
        tagline: "Answers your requests right in a Saltix chat",
        about: `${name} lives in your Saltix messenger: pick a command, fill in its form, and the answer comes back as a card.\nThere is nothing to install and no account to make.`,
        highlights: ["Works inside the Saltix messenger", "No sign-up, no password", "Answers in English and Russian"],
        privacy: "Keeps the requests it answered and how many messages it sent you, under the ID it sees for you, for as long as the app runs. It never sees your address.",
      },
      ru: {
        tagline: "Отвечает на запросы прямо в чате Saltix",
        about: `${name} живёт в мессенджере Saltix: выберите команду, заполните форму, и ответ придёт карточкой.\nНичего не нужно устанавливать и регистрировать.`,
        highlights: ["Работает в мессенджере Saltix", "Без регистрации и пароля", "Отвечает по-русски и по-английски"],
        privacy: "Хранит запросы, на которые ответил, и число отправленных вам сообщений под идентификатором, который видит для вас, пока приложение работает. Ваш адрес не видит.",
      },
    }
    : {
      en: {
        tagline: "A counter that follows you to every phone",
        about: `Tap Count to add one. ${name} keeps the count in your Saltix vault, so it is the same on every phone of your account.`,
        highlights: ["The same count on all your phones", "No sign-up, no password", "Your data stays in your vault, encrypted"],
        privacy: "Keeps one number, your count, encrypted in your Saltix vault until you remove the app's data. It never sees your address.",
      },
      ru: {
        tagline: "Счётчик, который всегда с вами на любом телефоне",
        about: `Нажмите Count, чтобы прибавить единицу. ${name} хранит счёт в вашем хранилище Saltix, поэтому он одинаков на всех телефонах аккаунта.`,
        highlights: ["Один счёт на всех ваших телефонах", "Без регистрации и пароля", "Данные зашифрованы в вашем хранилище"],
        privacy: "Хранит одно число, ваш счёт, зашифрованным в хранилище Saltix, пока вы не удалите данные приложения. Ваш адрес не видит.",
      },
    };
  return JSON.stringify({
    version: 1,
    subject: { grain: { slug } },
    texts,
    // A link of a host the slug makes; replace it with the app's own site, or null for none.
    website: httpsLinkOk(website) ? website : null,
    support: null,
    terms: null,
  }, null, 2) + "\n";
}

export const chatReadme = (slug: string) => `# ${slug}

A chat-only grain: an app users talk to in Saltix, with no page and nothing to host (Saltix 24-app-studio: the SDK's
[docs/protocol/app-studio.md](${PROTOCOL_DOCS}/app-studio.md)).

- **How it works**, what needs a program and the lifecycle as one checklist: [docs/how-it-works.md](${HOW_IT_WORKS}).
- **Run it:** \`npm install\` (it links the SDK and the \`grain\` command from the checkout), then \`grain pair\` here: scan its QR code with your Saltix, which pairs this server with
  ${slug} (or makes the app); the key is made here and never leaves this computer, and \`grain pair\` writes \`app.key\`
  (owner-only) once the registry names it. Then \`npm start\`: \`server.mjs\` is the server, its log one JSON line per
  event. It exits with 78 when it has no key (run \`grain pair\`) or the key cannot work (replaced, revoked, the app
  retired, another network's: \`grain pair --new\`), since restarting does not help. \`grain status\` says where it
  stands. Where no command runs, a developer key made in Saltix stands in (\`SALTIX_APP_KEY\`, never on a command line). Under systemd: the key as a credential
  (\`LoadCredential=app-key:…\`, \`Environment=SALTIX_APP_KEY_FILE=%d/app-key\`), \`StateDirectory=\` for its store, and
  \`RestartPreventExitStatus=78\`.
- **Add a command:** declare it in \`chat.json\`, add its handler in \`chat.mjs\` and its test in \`test/chat.test.mjs\`
  (\`npm test\`), and raise \`version\` with every change: a wallet takes only a version above the one it holds, and an
  app made in Saltix starts at 1.
- \`grain publish\` registers the slug (a deposit by its length: 100 SALT for 3–5 characters, 30 for 6–7, 10 for 8 or
  more; back 30 days after \`grain retire\`), through the test network's public relays; \`grain faucet --wait\` gives
  \`owner.key\`'s account test SALT first. Or make the app in Saltix: My apps → New app.
- \`grain cert init\` makes \`server.key\`; \`grain configure --slug ${slug} --server server.key\` names it in the registry;
  \`grain app-key make --slug ${slug}\` writes \`app.key\`, the developer key the server runs with. Each takes \`--node
  <url>\` for a node of your own.
- \`grain profile\` sets the Connect profile from \`connect.json\` once the app is registered: write it for your app.
- \`server.mjs\` runs the chat with \`ChatServer.start({ appKey, spec })\` from \`chat.json\` (the SDK's
  [docs/first-app.md](https://github.com/corvise/saltix-grains/blob/main/docs/first-app.md)).
- \`AGENTS.md\` is what a coding agent follows here (\`CLAUDE.md\` points to it).

\`owner.key\`, \`server.key\` and \`app.key\` are secrets: keep them out of git.
`;
