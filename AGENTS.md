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
  `assertCardStandard`.

## Building an app: Saltix shows apps full screen

Saltix shows apps full screen: keep tappable content clear of grain_info.controls, pad by grain_info.safe_area, test at 475×751, 704×932 and 932×704 dp in grain dev (saltix-grains AGENTS.md).

That line closes every report Saltix copies for an AI agent. In full (Saltix specs/12-grains.md §5, §7, bridge version 3):

- **Saltix opens every app full screen, edge to edge.** The page is drawn under the status bar and the navigation bar.
- **Keep text and controls inside the safe area.** `grain.layout()` (from `@saltix/grain`) sets, on `:root`,
  `--saltix-safe-top`, `--saltix-safe-bottom`, `--saltix-safe-left` and `--saltix-safe-right` in pixels
  (`grain_info.safe_area`) and keeps them current when the phone turns, unfolds or folds. Pad by them; backgrounds may
  run under the bars.
- **The wallet's controls `⋯ | ✕` float in the top right corner**: `grain_info.controls`, and `--saltix-controls-top`,
  `--saltix-controls-right`, `--saltix-controls-width`, `--saltix-controls-height` (a box of 96 × 48, 8 px from the right
  inset and 4 px below the top one; CSS px equal dp). **Never put anything tappable under them.** A top bar's title stops
  short of them (`padding-right: calc(var(--saltix-controls-right) + var(--saltix-controls-width) + 8px)`), or the bar
  starts below them (`top: calc(var(--saltix-controls-top) + var(--saltix-controls-height))`).
- **No close button of your own.** ✕ and the system's Back close the app; Back goes through your page's own history
  first. ⋯ opens the wallet's sheet for the app, never inside your page.
- **`grain.setHeader("#rrggbb")`** names the colour at the top of your page: the wallet draws the status bar's icons and
  its controls to contrast with it.
- **Outside Saltix the variables fall back by themselves**: an older Saltix (bridge 1–2) draws its header above the page,
  so the safe area and the controls are 0; a plain browser gives its own insets (`env(safe-area-inset-*)`).
- **Test at 475×751, 704×932 and 932×704** (the Galaxy Z Fold's sizes) in the simulator `grain dev` prints, light and
  dark. `grain lint` warns (`full-screen-top-bar`) about a fixed or sticky top bar that uses none of the variables.

A top bar that keeps clear, as the page `grain init` makes has it:

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

A chat-only app has no page: Saltix draws its home from the chat spec. Its server reaches the team in the app's console
without anyone writing first, because the team's wallets say hello (docs/chats.md).

**Payments** go through the wallet's own sheet, and a developer key's invoice pays the app's owner only (Saltix
specs/12-grains.md §5.2): `chat.invoice({ amount: "2.5", memo })` signs one to the owner the registry names, a card's
`invoice` block carries it (a page hands it to `grain.pay`), and `chat.paymentOf` finds the payment on chain. Never
deliver on the page's or the user's word, and never put another payee in an invoice: wallets refuse it (`payee`).
Saltix 0.1.53 and older cannot pay a developer key's invoice, so say in the card what to do if the sheet does not open
([docs/payments.md](docs/payments.md)).

Secrets (`owner.key`, `server.key`, `app.key`, a developer key `saltix-app:1:…`) are never committed, printed, logged or
pasted into a chat. The other rules every app follows (the chat spec's version, the unasked budget, state, the exit
status of a dead key, payments) are in [docs/agents/app.md](docs/agents/app.md#the-rules-every-app-follows). Two of them, in short:
raise `chat.json`'s `version` with every change of it (the server refuses to start on a spec changed under a version it
served, and the store that remembers it is never deleted to get past it); and a server whose setup cannot work as it
stands (a key of another network or one the registry does not name, such a spec) exits with 78 (`setupCannotWork`,
`ChatSetupError`), which its supervisor must not restart.

## Working on this repository

[docs/agents/sdk.md](docs/agents/sdk.md) is the whole of it. In short:

- **The protocol is corvise/saltix's.** Its `specs/` are the source of truth, and its golden vectors are copied here by
  `scripts/sync-vectors.sh <a Saltix checkout>` (`vectors/SOURCE` names the commit). The SDKs reproduce them byte for
  byte, refusals included; a format changes in the specs first, never here.
- **`npm ci && npm test`** is what CI runs: it builds every package and the simulator, then runs each package's tests.
- **Style:** English only, no emojis; comments say why, not what. Tests assert behaviour, refusals included; a critical
  check is mutation-tested. Logs carry event names and numbers, never keys, accounts, addresses or what users wrote.
- **Every change** adds a line to `CHANGELOG.md` under `[Unreleased]` and keeps the README and `docs/` in step;
  Conventional Commits, `!` and a `BREAKING CHANGE:` footer for a format change, through a pull request.
