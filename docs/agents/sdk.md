# Working on the SDK, for a coding agent

This repository holds the SDKs a Saltix app is built with: the page's bridge, the server's side, the `grain` command line
and the simulator. It follows the protocol (corvise/saltix `specs/`); it never defines a format itself.

## Map

| Where | What |
|---|---|
| `packages/grain/src/index.ts` | `@saltix/grain`, the page's side of the bridge, one module (`grain init` copies it into `public/`); `layoutSheet`, where `grain.layout()` keeps its CSS variables below the wallet's; and the wallet's rules the simulator plays by (`frameFor`, `controlsFor`, `pageColorOf`, `frameColors`) |
| `packages/server/src/` | `@saltix/grain-server`; `index.ts` re-exports every module below |
| `manifest.ts`, `registry.ts`, `tx.ts`, `handle.ts` | the manifest, the registry's calls (`signGrainTx`, `grainCallProblem`), transactions v3, usernames |
| `chat.ts`, `chat-card.ts` | the chat's formats (specs, requests, messages, member proofs) and the card builder |
| `card-standard.ts`, `card-lint.ts` | the card standard (22-grain-chats §5a: the action bar's rows and emphasis, polls' looks and shares; it reproduces the vectors' `cards`), and the lint against the guide's numbers ([cards.md](cards.md)) |
| `chat-server.ts`, `chat-store.ts`, `report.ts`, `stats.ts`, `member.ts` | `ChatServer`: requests, budget, console, error reports, numbers, private apps |
| `testing.ts`, `dev.ts` | `@saltix/grain-server/testing` (`testChat`: an app's chat under test, wallets that check every card) and `/dev` (`createDevRelay`, `createDevRegistry`): subpaths, not in `index.ts` |
| `app-key.ts`, `network.ts` | the developer key; the public relays and the chain view a server reads |
| `relay.ts`, `records.ts`, `seal.ts`, `upload.ts`, `file.ts` | `RelayClient`, relay records, sealed frames, files next to the relay |
| `login.ts`, `sign-in.ts`, `invoice.ts`, `notification.ts`, `sponsor.ts`, `node.ts` | sign-ins (a page's, with the team's member proof and its rights: `SignIns`), invoices, notifications, sponsors, a node's wallet interface |
| `profile.ts`, `profile-link.ts`, `keylog.ts`, `web.ts` | the Connect profile (19-connect §11: format, checks with the node's reasons, JSON form, signing, the profile link's reader; its writer needs zlib), key event logs checked offline (a port of the explorer's), and `@saltix/grain-server/web`, the modules that run in a web page |
| `packages/connect/src/` | `@saltix/connect`, Sign in with Saltix for websites ([../connect.md](../connect.md)): `client.ts` (`createConnect`), `session.ts`, `offer.ts`, `grant.ts`, `seal.ts`, `relay.ts`, `store.ts`, `verify.ts` (the page's check of a grant: the reference the explorer's `explorer/src/connect/` follows), `button.ts`, `dialog.ts`, `connect.css`, `site.ts` (`readSiteProfile`); built also as one module, `dist/saltix-connect.js` |
| `publish.ts`, `publish-link.ts`, `inflate.ts`, `keys.ts`, `address.ts`, `bytes.ts` | publishing links, raw DEFLATE, device keys and the one Ed25519 check (`verifyEd25519`), Address v1, encoding |
| `packages/cli/src/main.ts` | `grain`: the help and every command's dispatch |
| `packages/cli/src/` others | `network.ts` (where a command reaches the network: public relays, `--relay`, `--node`), `faucet.ts`, `project.ts` (manifest checks, key files), `template.ts` (`grain init`, its AGENTS.md), `dev.ts` (and the simulator it serves at `/_simulator/`), `pages.ts` (`grain lint`'s checks of a page), `connect.ts` (`connect.json`, and `grain lint`'s checks of it, the icon and permissions nothing uses), `profile.ts` (`grain profile`, `grain connect-profile`), `bundle.ts`, `registry.ts` (publish, retire, show), `studio.ts` (configure, access, rate, bind, app-key), `send.ts` (an account's registry calls one at a time: each waits until it landed, and one the pool refuses for an earlier pending call is built again), `chat.ts` (chat-spec, cert), `sponsor.ts` |
| `simulator/` | the wallet's side in a desktop browser (`simulator/connect-sheet.ts`: a preview of the Connect sheet from `connect.json` and the manifest, before a grain opens; `simulator/phone.ts`: the page framed as Saltix frames it, inside the safe area or edge to edge with `viewport-fit=cover`, with the wallet's controls, the band, margins and icons in the page's colours (`frameColors`, `pageColorOf`, read when Saltix reads them) and Saltix's splash while the page loads, on a phone, one on its side, the Galaxy Z Fold's sizes and an iPhone-like screen); it imports the server's modules one by one, never `index.ts` (which holds Node-only code); `grain dev` serves it too, built into the command line's package |
| `scripts/dev.mjs`, `scripts/dev-relay.mjs` | `npm run dev`: the simulator, `examples/hello-grain`, a development relay (the SDK's `/dev`, re-exported) and registry |
| `scripts/sync-vectors.sh` | copies the protocol's golden vectors from a Saltix checkout; `vectors/SOURCE` names its commit |
| `examples/hello-grain/` | the example: a page, its server and a chat (`npm run example` runs the chat from a developer key); `packages/server/test/example.test.mjs` runs its chat on `testChat` and holds every card to the card standard |
| `docs/` | `first-app.md`, `chats.md`, `cards.md` (and its pictures in `cards/`), `payments.md`, `connect.md`, `devex.md` (the developer experience and its roadmap), and these pages |

## Commands

```sh
npm ci                     # npm 11 warns that esbuild's install script is not approved: harmless here
npm test                   # builds every package and the simulator, then each package's node --test: what CI runs
npm run build --workspace packages/server            # one package
cd packages/server && node --test --test-force-exit test/chat-server.test.mjs   # one file
node --test --test-force-exit --test-name-pattern "budget" test/chat-server.test.mjs  # one test
npm run dev                # the simulator and the example on :8090
```

Tests import `dist/`: build the package before running its tests by path, and again after editing `src/`.

## Rules of the repository

- **Formats come from the protocol.** A change to a format starts in corvise/saltix's `specs/` and its vectors; here,
  `scripts/sync-vectors.sh <saltix checkout>`, then the code until `vectors.test.mjs` and `chat.test.mjs` pass. Never edit
  a vector by hand.
- **Tests assert behaviour**, refusals included. A check that guards money, keys or what a wallet trusts is
  mutation-tested: break it in `dist/*.js`, run its test file, see it fail, restore and rebuild (the CHANGELOG and pull
  requests say how many mutants were killed).
- **Ed25519 is verified in one place**: `verifyEd25519` in `keys.ts`, the node's `verify_strict` case for case
  (`ed25519.test.mjs` pins ed25519-dalek's verdicts on keys and `R` of small order or with a torsion part, `s` not
  reduced, non-canonical encodings). A library's `verify` is permissive (RFC 8032's cofactored equation; a key of small
  order "signs" every message): no module calls one, and the test fails if one does.
- **The page's check of a Connect grant is the reference.** `@saltix/connect`'s `verifyGrant` and `retryable` decide
  what is refused, what is only unchecked and when the node is asked again; the explorer's `explorer/src/connect/`
  (corvise/saltix) follows them, and a change here is synced there in a pull request of its own.
- **A test that starts a server or a process bounds every wait** (as `wallet.until` in
  `packages/server/test/chat-helpers.mjs` does): a broken change must fail the test, not hang CI.
- **The simulator plays Saltix by Saltix's own code.** What it draws (the frame, the band's colours, the icons'
  contrast, the splash) follows the wallet's (saltix-wallet `assets/grain/frame.js`, `AppFrame` and `GrainScreen` in
  its Android app); each rule it needs is a pure function in `@saltix/grain` (`frameFor`, `controlsFor`,
  `pageColorOf`, `frameColors`) with its test in `packages/grain/test/grain.test.mjs`, never logic inline in
  `simulator/`, which no test reaches. When Saltix changes, change the function and its test to match first.
- **`grain.layout()` never writes `:root`'s inline style.** Saltix sets the variables itself, in a sheet that wins over
  the page's stylesheets (12-grains §5); the SDK's go in `layoutSheet`, below it, and `stop()` removes them and nothing
  else. `grain.test.mjs` models the cascade (inline, adopted sheets, `<style>`) with Saltix's frame script in place: a
  change there keeps the wallet's values winning, the later ones too.
- **The example keeps the rules it teaches.** `examples/hello-grain` is what developers copy: every card it sends passes
  `assertCardStandard` (`example.test.mjs`), and a command added there gets a case in that test.
- **No secrets** in code, tests, fixtures or logs: tests use fixed fake keys (`"61".repeat(32)`), never a real
  developer key; `examples/**/*.key` and `*.store.json` are ignored. Scan the staged diff before committing.
- **Logs** carry event names and numbers, never keys, arguments, what users wrote or who is on a team.
- **The command line**: every flag a command takes is in its help; `--help` runs nothing. Every command keeps a key off
  the command line (files, `SALTIX_APP_KEY`, stdin).
- **Docs move with the code**: README, `docs/` and a line in `CHANGELOG.md` under `[Unreleased]` in the same pull
  request. A change a developer meets also extends `AGENTS.md`, these pages and every project's `AGENTS.md` (the texts in
  `packages/cli/src/template.ts`: `agentsMd`, `appRules`, `fullScreenRules`), which `agents-template.test.mjs`,
  `agent-docs.test.mjs` and `docs.test.mjs` hold to each other and to the code.

## How a change lands

1. A branch from `main`: `feat/…`, `fix/…`, `docs/…`.
2. Conventional Commits in English, scope the package (`server`, `grain`, `connect`, `cli`, `simulator`, `docs`); a
   format change is `feat(server)!:` with a `BREAKING CHANGE:` footer.
3. `npm test` passes; CI (`.github/workflows/ci.yml`: `npm ci && npm test` on Node 22 on the project's own runner, and
   the bundle's bytes again on Node 24 and 20) passes on the pull request.
4. Squash merge. The program that runs Saltix's own apps by their developer keys (Saltix Pass; saltix-wallet
   `server/access-grain`, named for the retired access grain) vendors the built server SDK with its sync script
   (saltix-wallet scripts/sync-grain-sdk.sh): a change it needs is synced there in a pull request of its own.
