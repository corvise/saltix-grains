# AGENTS.md

Rules for coding agents, and the people working with them: building an app for Saltix with these SDKs, and working on
this repository (saltix-grains: the grain SDKs, the simulator and the `grain` command line). `CLAUDE.md` points here.
Read [docs/how-it-works.md](docs/how-it-works.md) first: what a mini-app is made of, what runs where, whether an app
needs a server, and every step from an empty folder to a published app as one checklist. Three pages go on from this
file, and the protocol has pages of its own:

- [docs/agents/app.md](docs/agents/app.md): building an app, from pairing its server (`grain status`, then `grain pair`,
  which pairs the app the offer names or the one confirmed with `grain pair --accept S`, never one nobody here named:
  a QR code the owner's Saltix scans; never ask anyone to paste a key) to an app that runs, is tested and
  ships; the rules every app follows; how to act on an error report pasted from Saltix's console.
- [docs/agents/sdk.md](docs/agents/sdk.md): working on the SDK: the repository's map, its commands and tests, the golden
  vectors, and how a change lands.
- [docs/agents/cards.md](docs/agents/cards.md): the card design standard as rules for every card an app sends (a status
  first, at most 6 actions, short labels, destructive names, choices and polls, answering every tap), checked with
  `assertCardStandard`. The SDK's own cards keep it too: an error report (`chat.report`) is titled "Error · TypeError"
  (at most 60 characters, cut at a word), has at most 8 rows of fields, and carries the rest — the other fields, the
  full message, the stack — in its text, so the copy for an AI agent loses nothing.
- [docs/protocol/](docs/protocol/README.md): the Saltix protocol as an app needs it, the reference under every rule
  here: the manifest, the bridge and the page's frame, sign-in and member proofs, invoices, chats and cards, the app
  studio and developer keys, Saltix Connect and its profile, relays, the wallet interface, addresses and amounts. Each
  page names the specification it reflects (`12-grains §5.4` is [grains.md § 5.4](docs/protocol/grains.md#54-relays-real-time-between-users))
  and the protocol commit it was read at. The protocol's own repository is not public: read these pages, and the
  golden vectors in [vectors/](vectors/README.md), which are its bytes and win over any page.

## Quick path: a page-only app

A page that works on its own (a game, a tool, what it keeps per user in `grain.storage`) needs no server, no key to pair
and no hosting. From an empty folder to an app published in the network, every command and nothing else:

```sh
git clone https://github.com/corvise/saltix-grains.git && cd saltix-grains && npm install && npm run build
npx grain init ../<slug> --slug <slug> --name "<Name>" && cd ../<slug> && npm install
npx grain status                 # not_needed: a page alone has nothing to pair
npx grain dev --check --tap      # write public/, then this; it exits: the Connect sheet, every screen, both themes, each button tapped
npx grain icon --monogram <L>    # or grain icon <picture> --out icon.png
npx grain lint && npx grain doctor   # what is left; before the first publish, what registering the slug takes
npx grain publish                # says who will own the app; the owner's Saltix signs from a QR code
```

**`npx grain dev` without `--check` is a server**: it serves the simulator until Ctrl-C, for a person to look at in a
browser, and never returns. A coding agent runs it in the background (and stops it after), or not at all: it checks
the page with `npx grain dev --check --tap`, which exits 0, or 1 with what is wrong.

Run `grain publish` again with nothing changed and it says "nothing to publish" and sends nothing; a change to `public/`
or `grain.json` makes the next version. Write `connect.json` for the app before `grain profile`: `grain init`'s is about
its counter, and `grain profile` refuses it. **No phone, on the test network**: `grain faucet --wait`,
`grain publish --key owner.key`, `grain profile`, `grain access`, as
[No phone, test network](docs/how-it-works.md#no-phone-test-network) walks them. **A command that waits for the chain**
(`grain publish`, `profile`, `access` signed with a key file: about 1.5 to 2.5 minutes a transaction, up to about 6 for a
first publish) **runs in the background or with a timeout of 10 minutes or more**, or with `--no-wait` and then
`grain doctor` until it says it landed: it exits 75 while it only waits for the network, 1 when something is to do
(`next:` says what), 0 when nothing is left ([its exit statuses](README.md#grain-doctor-where-a-project-stands-and-its-exit-status)).
A call that would change nothing the registry holds says "nothing to change" and sends nothing. The rest of this page, and of [docs/agents/app.md](docs/agents/app.md), about servers,
keys and pairing is for an app with a program: a chat, payments, notifications, a page for some people only.

## Start here: Saltix's brief, or a developer key

Saltix offers **Copy brief for a coding agent** beside each app's key: the app's name, slug, form and network and these
steps, in English, with a line saying which language to answer the person in, and never a key
([the brief](docs/first-app.md#building-with-a-coding-agent)). A string that starts with `saltix-app:1:` is a Saltix
mini-app's **developer key** (Saltix 24-app-studio [§3](docs/protocol/app-studio.md#3-the-developer-key)). Whichever
you were given, an app is waiting for you:

1. **Read [docs/how-it-works.md](docs/how-it-works.md)**, then come back. Whether the app needs a program at all is
   its table [Do I need a server?](docs/how-it-works.md#do-i-need-a-server), in short:

   | The app | A program? |
   |---|---|
   | a page that works on its own (a game, a tool; what it keeps per user in `grain.storage`) | no |
   | users who have it open together, live (`grain.relay` frames between them) | no |
   | a chat; payments it delivers on; state shared between users; notifications while it is closed; a page for some people only | yes: `ChatServer`, which connects out to the relays (no domain, open port or certificate) |

2. **Get the SDK and make the app's own project beside it**:
   `git clone https://github.com/corvise/saltix-grains.git && cd saltix-grains && npm install && npm run build`, then
   `npx grain init ../<slug> --chat --slug <slug>` (a page: without `--chat`) and `cd ../<slug> && npm install`, which
   links the SDK and the `grain` command from the checkout (the SDK is not on npm yet).
3. **Pair it, every session from `grain status`** (Saltix 24-app-studio
   [§3a](docs/protocol/app-studio.md#3a-pairing-a-server-by-qr-code)). `npx grain status`: `paired`, go on (a page
   alone says `not_needed`: [the quick path](#quick-path-a-page-only-app)). Anything else: `npx grain pair` (in the
   background, or `npx grain pair --no-wait` and then `npx grain pair` to wait). **Show the person its QR code (the
   terminal's, or `.grain/pair.html`) and the 6-digit code, and wait**: they scan it with Saltix (the phone's camera,
   or My apps → Pair a server), check that Saltix shows the same code, keep **Add this server** and confirm with the
   PIN. `grain pair` writes `app.key` and `app.json` once the registry names the key; the
   key is made on this computer and never leaves it. Then `npx grain doctor` names what is left. **Never ask the person
   to paste, type or send a key.**
4. **A developer key is only for a host where no command runs.** If one reaches you anyway, read only its public parts:
   `saltix-app:1:<hrp>:<genesis>:<slug>:<secret>`, `hrp` the network (`dsalt`: Saltix's test network, of the devnet
   kind; `tsalt`: a testnet; `salt`: the main network), `genesis` the first 8 bytes of its genesis hash in hex, `slug`
   the app (`salt:grain/<slug>`). The last part, 64 hex characters, is the secret: never print, repeat, log or quote it,
   nor the whole key; `npx grain app-key --file app.key --offline` prints the public parts, never `cat` the file. A key
   pasted into the chat is in the conversation's history now: write it to `app.key` with `(umask 077 && cat > app.key)`
   without repeating it, and once the app runs ask the person to pair this project instead (`grain pair --new`, then
   **Use only this server**) or to replace the key in Saltix (a long press on the app, then Program, **Replace key**).
5. **One app, one key, one program.** The key is this app's alone and runs one program: the app's own project. Never
   run the SDK's example (`npm run example`) or any other program with the key of an app that already has a program,
   and never reuse another app's key or slug: two programs on one key both answer in its chat. The example is an app of
   its own.
6. **Keep keys out of git.** `grain pair` and `grain init` write a `.gitignore` that names `app.key`, every `*.key` and
   `.grain/`; before the first commit, see that `git status` shows no key file.
7. **Run it**: `npm start` in the project logs `{"event":"ready",…}`; in Saltix the app's home (tap the app in My apps)
   shows its command **Say hello**, and the answer is a card marked "from <slug>, verified". Then ask the person what the
   app should do. [docs/agents/app.md](docs/agents/app.md) is the whole path from there, and
   [the lifecycle](docs/how-it-works.md#the-lifecycle-as-one-checklist) every step to a published app: one app per
   project, pair, build, the standards, the simulator, publish, run the program, updates and key rotation.

## Building an app: safe by default, full screen only with viewport-fit=cover

Saltix lays an app's page inside the safe area; full screen only with viewport-fit=cover: then pad by grain_info.safe_area, keep tappable content clear of grain_info.controls, test at 475×751, 704×932 and 932×704 dp in grain dev (saltix-grains AGENTS.md).

That line closes every report Saltix copies for an AI agent. In full (Saltix 12-grains [§5](docs/protocol/grains.md#5-the-bridge), [§7](docs/protocol/grains.md#7-security-of-the-container), bridge version 3):

- **Saltix opens every app as a full app**, its controls `⋯ | ✕` floating in the top right corner, and lays the page out
  as browsers do.
- **Inside the safe area, by default.** A page that says nothing about insets is drawn below the status bar, the
  cutout and a 56 px band that holds the controls, above the navigation bar or gesture area and the keyboard, clear of
  rounded corners. Nothing of the system or the wallet is ever over it, so it needs nothing else; the band takes the
  page's colour ([below](#building-an-app-what-a-page-gets-from-saltix-and-what-it-does-not)).
- **Edge to edge only with `viewport-fit=cover`**: `<meta name="viewport" content="width=device-width,
  initial-scale=1, viewport-fit=cover">`, the web's own declaration (Safari on iOS reads it too). The page is then
  drawn under the status bar and the navigation bar (never under the keyboard), and keeps its text and controls inside
  the safe area itself. **Saltix sets the CSS variables on `:root`**: `--saltix-safe-top`, `--saltix-safe-bottom`,
  `--saltix-safe-left` and `--saltix-safe-right` in pixels (`grain_info.safe_area`), kept current when the phone turns,
  unfolds or folds and when a keyboard opens. Pad by them; backgrounds may run under the bars. `grain.layout()` (from
  `@saltix/grain`) sets the same values where Saltix does not, and says on the console when a page asks for them
  without declaring `viewport-fit=cover`. Its values sit below Saltix's, in a stylesheet of the page's own, so Saltix's
  always win, its later changes too, and `stop()` takes away only what `grain.layout()` set. **Never write these
  variables into `:root`'s inline style** (`document.documentElement.style.setProperty`): an inline value beats
  Saltix's and stays as it was when the phone turns, unfolds or opens a keyboard.
- **The wallet's controls `⋯ | ✕` float in the top right corner**: over an edge-to-edge page, `grain_info.controls`
  and `--saltix-controls-top`, `--saltix-controls-right`, `--saltix-controls-width`, `--saltix-controls-height` (a box
  of 96 × 48, 8 px from the right inset and 4 px below the top one; CSS px equal dp); inside the safe area they sit in
  the band, `controls` is null and the variables 0. **Never put anything tappable under them.** A top bar's title stops
  short of them (`padding-right: calc(var(--saltix-controls-right) + var(--saltix-controls-width) + 8px)`), or the bar
  starts below them (`top: calc(var(--saltix-controls-top) + var(--saltix-controls-height))`).
- **`env(safe-area-inset-*)` is not the contract** in a wallet: Android's WebView reports at most a cutout. Read the
  variables (or `max()` of a variable and its `env()`).
- **No close button of your own.** ✕ and the system's Back close the app; Back goes through your page's own history
  first. ⋯ opens the wallet's sheet for the app, never inside your page.
- **`grain.setHeader("#rrggbb")`** names the colour at the top of your page: the wallet draws its band, the status
  bar's icons and its controls to contrast with it. It holds until the next call: call it again when your theme changes.
- **Outside Saltix the variables fall back by themselves**: an older Saltix (bridge 1–2, and 0.1.53) draws its header
  above the page, so the safe area and the controls are 0; a plain browser gives its own insets (`env(safe-area-inset-*)`).
- **Test at 475×751, 704×932 and 932×704** (the Galaxy Z Fold's sizes), on a 360×780 phone, one on its side and the
  iPhone-like screen in the simulator `grain dev` prints, light and dark: it frames the page as Saltix does, in both
  ways, and says which. `grain dev --check` does it headless in the Chrome, Chromium or Edge of this computer and exits
  1 on an error (something tappable under the controls, a page that throws or does not load, a Connect profile a
  wallet refuses), with a screenshot of every screen in `.grain/check/`; `--check --tap` also taps each button once and
  fails on a tap that throws or asks Saltix for what it refuses (a tap that changes nothing is a warning; the page
  never leaves, and no payment is made). `grain lint` warns about a page that declares `viewport-fit=cover` and reads no inset
  (`cover-without-insets`), and about a bar pinned to the top of such a page whose rule keeps clear of nothing
  (`full-screen-top-bar`).

A sealed app's bundle (`grain bundle`, and `grain publish`, which bundles first) is the same bytes from the same files on
any computer and any Node (files stored, never deflated, in the form every node checks; at most 16 MiB for the network to
keep it): rebuild it in CI and fail when `grain.json` changes; never edit `entry.sealed` by hand.

**A page needs no server and no hosting: `grain publish` puts it into the Saltix network.** It seals `public/`, checks
it as every node does, and uploads it from this computer straight into the network (Saltix 32-images
[§7.3](docs/protocol/images.md#73-bundles-from-the-developers-machine-into-the-network)), says which account will own
the app, then shows the QR code the owner's Saltix signs the version from, waits for the registry, and uploads the icon.
With `grain pair`'s `app.key` the bundle goes up before the owner signs (held pending for a day); without one, after.
Never set up hosting, a CDN, a domain or a certificate for a page, and never ask the user for one; never pass
`--sources` unless the user hosts the bundle on purpose. `grain publish --no-wait` returns once the QR code is shown:
show it (or `.grain/publish.html`) to the user, then run `grain publish` again after they confirmed; it finishes what is
left. With nothing changed it says "nothing to publish" and sends nothing; a version is raised only when `grain.json` or
`public/` changed. **A key file signs only when `--key` names it, or by itself for an app its account owns**
([No phone, test network](docs/how-it-works.md#no-phone-test-network)); `grain init`'s `owner.key` never registers an
app by itself. So `--key owner.key` goes on the first `grain publish` only: after it, `grain profile`, `grain access`
and `grain publish` in the project sign with the `owner.key` that owns the app by themselves, and the commands the tools
suggest never name it (only a key file elsewhere: `--key <its path>`).
`grain doctor` says where a publish stands (`not_uploaded`, `pending`, `waiting_for_owner`, `pending_expired`, or
`published`: the registry names the version and the network holds its bundle, never on a relay's `fetching` alone), and
before the first one what registering the slug takes; a refusal says what to do. The bundle goes to the network's
keepers on every protocol version, and only the manifest's `sources` differ:
[where the bundle goes](docs/how-it-works.md#where-the-bundle-goes). A first version the owner's Saltix registers from
the QR code is private unless they switch on **Public in the Marketplace** on its sheet (Saltix 0.1.61 and later; an
older Saltix registers it public: then `grain access --slug <slug> --private`). `--hosted` only for
a page the user hosts at their own origin.

**The icon** is a 512 × 512 opaque PNG, sRGB, no metadata, at most 64 KiB, its mark inside the keyline circle
(5/12 of the side from the centre), the background full bleed (Saltix cuts the rounded square, corners 0.26 of the side):
make it with `grain icon <picture> --out icon.png` from any PNG or JPEG (it names it in `grain.json`), or, with no
picture yet, `grain icon --monogram <letter>` (a letter or two on a colour), look at the preview it writes, and never
draw rounded corners, transparency or a border yourself ([docs/icons.md](docs/icons.md)).

A top bar that keeps clear on an edge-to-edge page, as the page `grain init` makes has it:

```css
header {
  position: sticky; top: 0;
  padding-top: max(var(--saltix-safe-top), var(--saltix-controls-top));
  padding-left: calc(16px + var(--saltix-safe-left));
  padding-right: max(calc(16px + var(--saltix-safe-right)), calc(var(--saltix-controls-right) + var(--saltix-controls-width) + 8px));
}
header h1 { min-height: max(48px, var(--saltix-controls-height)); display: flex; align-items: center; }
main { padding-bottom: calc(16px + var(--saltix-safe-bottom)); }
```

The `grain` command line needs no node: registry commands and `grain faucet` (test SALT) go through the test network's
public relays, each pinned by its certificate; `--node URL` is for a node of your own.

**Every app ships a complete Connect profile, and asks only for what it uses.** The first time someone opens an app,
Saltix shows its Connect sheet (Saltix 19-connect [§12](docs/protocol/connect.md#12-the-connect-sheet)): "Saltix
Connect", the app's identity, its profile "in its own words", then a row for each permission the manifest asks for, and
Continue. The profile is `connect.json` (`grain init` writes one): a tagline that says what the app is, what it does,
highlights that are facts (not slogans), and what it keeps about a user and for how long (required when `grain.json`
asks for `address` or `storage`), in English and Russian. `grain lint` fails without it and checks every rule; it warns
about a permission nothing in the app's sources uses: drop it. `grain init`'s `connect.json` describes its counter:
`grain lint` warns while it does (`connect-template`), and `grain profile` refuses it. `grain profile` sets it in the
registry (a QR code for the owner's Saltix, or the key file that owns the app). Its links are the app's own: a link to
an example domain (`.example`) is refused, as it leads nowhere. How to write one:
[docs/agents/app.md](docs/agents/app.md#the-connect-profile-connectjson). Websites and DApps use the same standard to
sign their users in: [docs/connect.md](docs/connect.md) (`@saltix/connect`). A Connect grant is for display only: a
bearer artefact that answers no server's challenge, so a server never takes it as a login
([docs/connect.md](docs/connect.md#5-a-grant-is-for-display-never-a-servers-login)).

A chat-only app has no page: Saltix draws its home from the chat spec. Its server reaches the team in the app's console
without anyone writing first, because the team's wallets say hello (docs/chats.md).

**Payments** go through the wallet's own sheet, and a developer key's invoice pays the app's owner only (Saltix
12-grains [§5.2](docs/protocol/grains.md#52-payments)): `chat.invoice({ amount: "2.5", memo })` signs one to the owner the registry names, a card's
`invoice` block carries it (a page hands it to `grain.pay`), and `chat.paymentOf` finds the payment on chain. Never
deliver on the page's or the user's word, and never put another payee in an invoice: wallets refuse it (`payee`).
Saltix 0.1.54 pays a developer key's invoice and 0.1.53 and older cannot, so say in the card what to do if the sheet does
not open: update Saltix ([docs/payments.md](docs/payments.md)).

**The server's key is paired, never copied** (Saltix 24-app-studio [§3a](docs/protocol/app-studio.md#3a-pairing-a-server-by-qr-code)). Start every session in an app's project
with `grain status` (a page alone: `not_needed`, nothing to pair); when it is not `paired`, run `grain pair`, show the user its QR code (or `.grain/pair.html`) and the
6-digit code, and wait while they scan it with Saltix and confirm: the key is made on this computer and never leaves it,
and `grain pair` writes `app.key` once the registry names it. Never ask the user to paste, type or send a key; a developer
key is only for a host where no command runs. `grain doctor` names the next step. Every command logs its steps to
`.grain/log.jsonl`, codes and timings only.

Secrets (`owner.key`, `server.key`, `app.key`, `.grain/pair.key`, a developer key `saltix-app:1:…`) are never committed,
printed, logged or pasted into a chat. The other rules every app follows (the chat spec's version, the unasked budget, state, the exit
status of a dead key, payments, the Connect profile, people's names) are in
[docs/agents/app.md](docs/agents/app.md#the-rules-every-app-follows). Two of them, in short:
raise `chat.json`'s `version` with every change of it (the server refuses to start on a spec changed under a version it
served, and the store that remembers it is never deleted to get past it); and a server whose setup cannot work as it
stands (a key of another network or one the registry does not name, such a spec) exits with 78 (`setupCannotWork`,
`ChatSetupError`), which its supervisor must not restart. Test every command end to end with `testChat`
(`@saltix/grain-server/testing`: a development relay, registry and key, every card checked as Saltix checks it), never
with a real developer key.

## Building an app: check first, then render

A page that is for some people only (its team, a private circle) shows nothing of itself before it knows who signed in
(Saltix 12-grains [§5.1a](docs/protocol/grains.md#51a-the-teams-sign-in-check-first-render-after)). A public app for a limited circle shows strangers a refusal page without any of its
UI; a private app never loads for them at all, since Saltix reads the registry first.

- On a first open Saltix Connect's sheet comes first; then the page loads. **Until its sign-in resolves it shows only a
  splash**: the app's icon and name in an element marked `data-grain-splash`, everything else `hidden` or not yet drawn.
  Never a skeleton of the UI.
- **`grain.signIn({ url })`** (`@saltix/grain`) signs in through the server's `challenge` and `session` routes. Saltix
  attaches the account's member proof for the app's team (its owner, developers, viewers) and a private app's members,
  `null` for anyone else; Saltix 0.1.53 and older attach nothing at all.
- **The server** answers with `SignIns` and `signInAnswer` (`@saltix/grain-server`): rights `owner`, `developer`,
  `viewer`, `user` or `none` from the registry, a session only for those the app is for, and every request checked
  again by them. `ChatMemberUnchecked` (the node did not answer, for the registry or the account's keys) is a 503: the
  page tries again; never a refusal, never a 500.
- **`gateOf(signIn, TEAM)`** decides: the app (`open`), a refusal page (`refused`: whom it is for, that its owner can
  invite them), "update Saltix" (`update`: an older Saltix cannot prove membership, so never say it is not for them),
  a sign-in button (`declined`), try again (`failed`), open it in Saltix (`outside`).
- `grain lint` warns (`render-before-sign-in`) about a page that signs in and shows anything else in its HTML first, or
  marks no splash. [docs/agents/app.md](docs/agents/app.md#a-page-for-some-people-only-check-first-then-render) has the
  steps and the code; `grain init --sign-in` makes a page that follows them (`grain init` alone makes a page that works
  on its own, with no sign-in).

## Building an app: what a page gets from Saltix, and what it does not

This is everything Saltix tells a page (bridge version 3, Saltix 0.1.54; Saltix 12-grains [§5](docs/protocol/grains.md#5-the-bridge), [§7](docs/protocol/grains.md#7-security-of-the-container)):

- **`grain.info()`** (`grain_info`): `slug`, `version` (the manifest's), `form` (`hosted` or `sealed`), `listing`
  (`verified`, `listed` or `unlisted`), `host` (`saltix`) and `host_version`, `bridge` (3), `language` (Saltix's own:
  `en`, `ru`), `theme` (`dark` or `light`), `safe_area {top, bottom, left, right}`, `controls {top, right, width,
  height}` or `null`, `network` (`devnet` on the test network) and `start` (the link's, or `null`).
- **Events** (`grain.on`): `theme {theme}` whenever the theme changes (the first one is `grain_info`'s), `visibility
  {visible}`, `insets {safe_area, controls}`, and `relay {from, payload}` once the page opened the relay.
- **CSS variables** on `:root`, in `px`, set by Saltix's own script before the page's first one runs and kept current:
  `--saltix-safe-top`, `--saltix-safe-right`, `--saltix-safe-bottom`, `--saltix-safe-left`, `--saltix-controls-top`,
  `--saltix-controls-right`, `--saltix-controls-width`, `--saltix-controls-height`. They win over the page's own
  stylesheets' values for the same names, so a page may define them there as a plain browser's fallbacks, as `grain
  init`'s page does (never in `:root`'s inline style, which would win over Saltix's), and over `grain.layout()`'s,
  which count only where Saltix sets none.
- **`window.saltix`** (`isSaltix`, `isGrain`, `bridge`, `request`, `on`, `off`), which `@saltix/grain` wraps;
  `inWallet()` says whether it is there.
- **Its limits**: a payment, the app's chat (`grain.chat.open`), its page in the wallet (`grain.manage.open`, the team
  only) and asking again for the address or notifications need a tap of the user within 5 seconds; what the manifest
  does not ask for is 4100; each method has a rate (4290 past it); storage keeps keys of 1 to 128 bytes, values of
  60 KiB, 1 MiB an app; and an answer or an event is at most 64 KiB of JSON: a longer answer is the error 5000, a longer
  event is dropped. A relay frame arrives as hex, twice its size, so one over about 32 KB never reaches a page: keep
  frames small. `grain dev`'s simulator holds a page to all of it (`@saltix/grain/rules`).

**No design tokens.** Saltix gives a page no colours, palette, accent, fonts, corners or spacing, and no CSS variables
besides the eight above. A page brings its own design, for a light and a dark theme, and picks one by `grain_info.theme`
and the `theme` event, not by `prefers-color-scheme`, which need not match the theme chosen in Saltix.
(`--saltix-signin-height` is not the wallet's: it sizes the "Sign in with Saltix" button of `@saltix/connect`, for
websites.)

**Saltix takes its colours from the page instead.** The page's colour is the first `<meta name="theme-color">` whose
`media` matches and which is a valid, opaque CSS colour (any other is passed over), else the background of `<body>`,
then `<html>`, else `#121212` for a page whose `color-scheme` is dark and white otherwise; give an opaque one. The room
around a page inside the safe area and the navigation bar's icons follow it; the band, the status bar's icons and the
controls follow `grain.setHeader`'s colour when the page gave one (it holds until the next call, whatever the head says
meanwhile), else it too. Saltix reads the page's colour as its head is parsed, again whenever the head changes, once
the page has loaded, when the theme changes and when the system's dark preference does; not when a script changes the
body's background alone: change the `theme-color` with it, or call `grain.setHeader`. `grain dev`'s simulator draws
the band, the margins and the icons in the same order and reads the colour at the same moments (`pageColorOf`,
`frameColors` in `@saltix/grain`).

**The wallet's splash** (the app's icon and name over Saltix's background, a thin progress line at the top) shows while
the page loads and goes once it has loaded: `grain.ready()` neither holds nor hides it, and Saltix ignores that call
today (so does the simulator). A page that checks first shows a splash of its own until its gate decides (above).

## Naming: apps and people

- **Words.** The product is Saltix, everywhere. Saltix calls apps *mini-apps* in what users read (lower case; Russian
  «мини-приложения»); *grain* is the protocol's word, for manifests, the bridge's `grain_*`, these SDKs and the specs,
  not a word for what users read. In an app's own words, an app is an app.
- **An app** is its slug (3–32 of `[a-z0-9-]`, fixed, never used again once retired), its manifest's `name` in each
  language (English required), and optionally a Saltix username bound to it (`grain bind --handle @name`), which opens
  its chat. Saltix never shows a name alone: the slug and its mark go with it, and a slug that reads like a known one
  (`0`/`o`, `1`/`l`/`i`, `rn`/`m`, `vv`/`w`, hyphens) carries a warning ([22-grain-chats §5](docs/protocol/grain-chats.md#5-in-the-wallet)).
- **People.** Accounts have a profile name of their own (a first and a last name, Saltix [09-relay §1.5](docs/protocol/basics.md#peoples-names)) and may hold
  usernames, but Saltix gives an app neither: a user is their grain key, a pseudonym of this app alone (`ask.key`,
  `grain.login`); only the team and a private app's members are known as accounts (`ask.member`, `SignIns`), and a page
  gets an address only from `grain.requestAddress()` (the `address` permission, the user's yes) or
  `grain.pickContact()`. Never show a key as a name. Where the app shows people to each other, it shows the name each
  typed in it (its own data, which `connect.json`'s privacy line names) or a shared address, shortened; a typed name is
  never proof of who someone is (*People's names* in [docs/agents/app.md](docs/agents/app.md#the-rules-every-app-follows),
  rule 11 of every project's `AGENTS.md`).

## Working on this repository

[docs/agents/sdk.md](docs/agents/sdk.md) is the whole of it. In short:

- **The protocol is Saltix's, not this repository's.** Its specifications live in the protocol's repository, which is
  not public before the main network launches; [docs/protocol/](docs/protocol/README.md) is this repository's account
  of everything an app needs from them, each page naming the specification and commit it reflects. Its golden vectors
  are copied here unchanged by `scripts/sync-vectors.sh <a protocol checkout>` (`vectors/SOURCE` names the commit and
  each file's blob id, which CI holds them to: `node scripts/check-vectors.mjs`). The SDKs reproduce them byte for
  byte, refusals included; a format changes in the protocol first, never here, and its page in `docs/protocol/` moves
  with it.
- **`npm ci --ignore-scripts && npm test`** is what CI runs (after `node scripts/check-vectors.mjs`): no dependency's
  install script runs (esbuild's binary comes from its platform package); the build makes every package and the
  simulator, then each package's tests run. CI's actions are pinned by commit.
- **One Ed25519 check:** `verifyEd25519` (`packages/server/src/keys.ts`), the node's own `verify_strict` (no key or `R`
  of small order, `s` reduced, `R` exactly `[s]B − [k]A`); never a library's `verify`, which takes signatures the node
  refuses (`ed25519.test.mjs` holds every module to it). `@saltix/connect`'s check of a grant (`verifyGrant`) is the
  reference Saltix's explorer follows.
- **Style:** English only, no emojis; comments say why, not what. Saltix is the only name (never an older one); users
  read *mini-apps*, code and specs say *grain*. Tests assert behaviour, refusals included; a critical check is
  mutation-tested. Logs carry event names and numbers, never keys, accounts, addresses or what users wrote.
- **Every change** adds a line to `CHANGELOG.md` under `[Unreleased]` and keeps the README and `docs/` in step (links
  and anchors included: `protocol-docs.test.mjs` follows every one, and refuses a link into the private repositories);
  Conventional Commits, `!` and a `BREAKING CHANGE:` footer for a format change, through a pull request.
- **A change a developer meets** (a command, a rule, what the bridge gives, a template) extends this `AGENTS.md`,
  [docs/agents/](docs/agents/README.md) and every project's `AGENTS.md` and `CLAUDE.md` (`packages/cli/src/template.ts`:
  `agentsMd`, `appRules`, `fullScreenRules`) in the same pull request; `agents-template.test.mjs` holds them together.
