# AGENTS.md

Rules for coding agents, and the people working with them: building an app for Saltix with these SDKs, and working on
this repository (saltix-grains: the grain SDKs, the simulator and the `grain` command line). `CLAUDE.md` points here.

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

Secrets (`owner.key`, `server.key`, `app.key`, a developer key `saltix-app:1:…`) are never committed, printed, logged or
pasted into a chat.

## Working on this repository

- **The protocol is corvise/saltix's.** Its `specs/` are the source of truth, and its golden vectors are copied here by
  `scripts/sync-vectors.sh <a Saltix checkout>` (`vectors/SOURCE` names the commit). The SDKs reproduce them byte for
  byte, refusals included; a format changes in the specs first, never here.
- **Commands:** `npm ci`, then `npm test` (builds every package and the simulator, then runs each package's
  `node --test`), which is what CI runs. `npm run dev` serves the simulator with the example grain and its chat on a
  development relay; `npm run example` runs the example's chat from a developer key.
- **Layout:** `packages/grain` (the page's bridge, one module: `grain init` copies it whole), `packages/server` (formats,
  checks, `ChatServer`, the relay client), `packages/cli` (`grain`; it builds the simulator into its package for
  `grain dev`), `simulator/` (the wallet's side in a desktop browser), `examples/hello-grain`, `docs/`.
- **Style:** English only, no emojis; comments say why, not what. Tests assert behaviour, refusals included; a critical
  check is mutation-tested (a deliberately broken check must fail a test).
- **Logs** carry event names and numbers, never keys, secrets, accounts, addresses or what users wrote.
- **Every change** adds a line to `CHANGELOG.md` under `[Unreleased]` and keeps the README and `docs/` in step.
- **Commits:** Conventional Commits (`feat(server): …`, scope `server`, `grain`, `cli`, `simulator`, `docs`), with `!` and
  a `BREAKING CHANGE:` footer for a format change; work lands through a pull request.
