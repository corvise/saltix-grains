# AGENTS.md

Rules for coding agents, and the people working with them: building an app for Saltix with these SDKs, and working on
this repository (saltix-grains: the grain SDKs, the simulator and the `grain` command line). `CLAUDE.md` points here.
Three pages go on from it:

- [docs/agents/app.md](docs/agents/app.md): building an app, from a developer key to an app that runs, is tested and
  ships; the rules every app follows; how to act on an error report pasted from Saltix's console.
- [docs/agents/sdk.md](docs/agents/sdk.md): working on the SDK: the repository's map, its commands and tests, the golden
  vectors, and how a change lands.
- [docs/agents/cards.md](docs/agents/cards.md): the card design standard as rules for every card an app sends (a status
  first, at most 6 actions, short labels, destructive names, choices and polls, answering every tap), checked with
  `assertCardStandard`. The SDK's own cards keep it too: an error report (`chat.report`) is titled "Error · TypeError"
  (at most 60 characters, cut at a word), has at most 8 rows of fields, and carries the rest — the other fields, the
  full message, the stack — in its text, so the copy for an AI agent loses nothing.

## Building an app: safe by default, full screen only with viewport-fit=cover

Saltix lays an app's page inside the safe area; full screen only with viewport-fit=cover: then pad by grain_info.safe_area, keep tappable content clear of grain_info.controls, test at 475×751, 704×932 and 932×704 dp in grain dev (saltix-grains AGENTS.md).

That line closes every report Saltix copies for an AI agent. In full (Saltix specs/12-grains.md §5, §7, bridge version 3):

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
  ways, and says which. `grain lint` warns about a page that declares `viewport-fit=cover` and reads no inset
  (`cover-without-insets`), and about a bar pinned to the top of such a page whose rule keeps clear of nothing
  (`full-screen-top-bar`).

A sealed app's bundle (`grain bundle`) is the same bytes from the same files on any computer and any Node (files
stored, never deflated, at most 20 MiB): rebuild it in CI and fail when `grain.json` changes; never edit
`entry.sealed` by hand.

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
Saltix shows its Connect sheet (Saltix specs/19-connect.md §12): "Saltix Connect", the app's identity, its profile "in
its own words", then a row for each permission the manifest asks for, and Continue. The profile is `connect.json`
(`grain init` writes one): a tagline that says what the app is, what it does, highlights that are facts (not slogans),
and what it keeps about a user and for how long (required when `grain.json` asks for `address` or `storage`), in
English and Russian. `grain lint` fails without it and checks every rule; it warns about a permission nothing in the
app's sources uses: drop it. `grain profile` sets it in the registry (a QR code for the owner's Saltix, or `--key` on
the test network). How to write one: [docs/agents/app.md](docs/agents/app.md#the-connect-profile-connectjson). Websites
and DApps use the same standard to sign their users in: [docs/connect.md](docs/connect.md) (`@saltix/connect`).

A chat-only app has no page: Saltix draws its home from the chat spec. Its server reaches the team in the app's console
without anyone writing first, because the team's wallets say hello (docs/chats.md).

**Payments** go through the wallet's own sheet, and a developer key's invoice pays the app's owner only (Saltix
specs/12-grains.md §5.2): `chat.invoice({ amount: "2.5", memo })` signs one to the owner the registry names, a card's
`invoice` block carries it (a page hands it to `grain.pay`), and `chat.paymentOf` finds the payment on chain. Never
deliver on the page's or the user's word, and never put another payee in an invoice: wallets refuse it (`payee`).
Saltix 0.1.54 pays a developer key's invoice and 0.1.53 and older cannot, so say in the card what to do if the sheet does
not open: update Saltix ([docs/payments.md](docs/payments.md)).

Secrets (`owner.key`, `server.key`, `app.key`, a developer key `saltix-app:1:…`) are never committed, printed, logged or
pasted into a chat. The other rules every app follows (the chat spec's version, the unasked budget, state, the exit
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
(Saltix specs/12-grains.md §5.1a). A public app for a limited circle shows strangers a refusal page without any of its
UI; a private app never loads for them at all, since Saltix reads the registry first.

- On a first open Saltix Connect's sheet comes first; then the page loads. **Until its sign-in resolves it shows only a
  splash**: the app's icon and name in an element marked `data-grain-splash`, everything else `hidden` or not yet drawn.
  Never a skeleton of the UI.
- **`grain.signIn({ url })`** (`@saltix/grain`) signs in through the server's `challenge` and `session` routes. Saltix
  attaches the account's member proof for the app's team (its owner, developers, viewers) and a private app's members,
  `null` for anyone else; Saltix 0.1.53 and older attach nothing at all.
- **The server** answers with `SignIns` and `signInAnswer` (`@saltix/grain-server`): rights `owner`, `developer`,
  `viewer`, `user` or `none` from the registry, a session only for those the app is for, and every request checked
  again by them.
- **`gateOf(signIn, TEAM)`** decides: the app (`open`), a refusal page (`refused`: whom it is for, that its owner can
  invite them), "update Saltix" (`update`: an older Saltix cannot prove membership, so never say it is not for them),
  a sign-in button (`declined`), try again (`failed`), open it in Saltix (`outside`).
- `grain lint` warns (`render-before-sign-in`) about a page that signs in and shows anything else in its HTML first, or
  marks no splash. [docs/agents/app.md](docs/agents/app.md#a-page-for-some-people-only-check-first-then-render) has the
  steps and the code; `grain init` makes a page that follows them.

## Building an app: what a page gets from Saltix, and what it does not

This is everything Saltix tells a page (bridge version 3, Saltix 0.1.54; Saltix specs/12-grains.md §5, §7):

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
  (`0`/`o`, `1`/`l`/`i`, `rn`/`m`, `vv`/`w`, hyphens) carries a warning (22-grain-chats §5).
- **People.** Accounts have a profile name of their own (a first and a last name, Saltix 09-relay §1.5) and may hold
  usernames, but Saltix gives an app neither: a user is their grain key, a pseudonym of this app alone (`ask.key`,
  `grain.login`); only the team and a private app's members are known as accounts (`ask.member`, `SignIns`), and a page
  gets an address only from `grain.requestAddress()` (the `address` permission, the user's yes) or
  `grain.pickContact()`. Never show a key as a name. Where the app shows people to each other, it shows the name each
  typed in it (its own data, which `connect.json`'s privacy line names) or a shared address, shortened; a typed name is
  never proof of who someone is (*People's names* in [docs/agents/app.md](docs/agents/app.md#the-rules-every-app-follows),
  rule 11 of every project's `AGENTS.md`).

## Working on this repository

[docs/agents/sdk.md](docs/agents/sdk.md) is the whole of it. In short:

- **The protocol is corvise/saltix's.** Its `specs/` are the source of truth, and its golden vectors are copied here by
  `scripts/sync-vectors.sh <a Saltix checkout>` (`vectors/SOURCE` names the commit). The SDKs reproduce them byte for
  byte, refusals included; a format changes in the specs first, never here.
- **`npm ci && npm test`** is what CI runs: it builds every package and the simulator, then runs each package's tests.
- **Style:** English only, no emojis; comments say why, not what. Saltix is the only name (never an older one); users
  read *mini-apps*, code and specs say *grain*. Tests assert behaviour, refusals included; a critical check is
  mutation-tested. Logs carry event names and numbers, never keys, accounts, addresses or what users wrote.
- **Every change** adds a line to `CHANGELOG.md` under `[Unreleased]` and keeps the README and `docs/` in step;
  Conventional Commits, `!` and a `BREAKING CHANGE:` footer for a format change, through a pull request.
- **A change a developer meets** (a command, a rule, what the bridge gives, a template) extends this `AGENTS.md`,
  [docs/agents/](docs/agents/README.md) and every project's `AGENTS.md` and `CLAUDE.md` (`packages/cli/src/template.ts`:
  `agentsMd`, `appRules`, `fullScreenRules`) in the same pull request; `agents-template.test.mjs` holds them together.
