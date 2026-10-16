# Working on the SDK, for a coding agent

This repository holds the SDKs a Saltix app is built with: the page's bridge, the server's side, the `grain` command line
and the simulator. It follows the protocol (corvise/saltix `specs/`); it never defines a format itself.

## Map

| Where | What |
|---|---|
| `packages/grain/src/index.ts` | `@saltix/grain`, the page's side of the bridge, one module (`grain init` copies it into `public/`) |
| `packages/server/src/` | `@saltix/grain-server`; `index.ts` re-exports every module below |
| `manifest.ts`, `registry.ts`, `tx.ts`, `handle.ts` | the manifest, the registry's calls (`signGrainTx`, `grainCallProblem`), transactions v3, usernames |
| `chat.ts`, `chat-card.ts` | the chat's formats (specs, requests, messages, member proofs) and the card builder |
| `card-standard.ts`, `card-lint.ts` | the card standard (22-grain-chats §5a: the action bar's rows and emphasis, polls' looks and shares; it reproduces the vectors' `cards`), and the lint against the guide's numbers ([cards.md](cards.md)) |
| `chat-server.ts`, `chat-store.ts`, `report.ts`, `stats.ts`, `member.ts` | `ChatServer`: requests, budget, console, error reports, numbers, private apps |
| `testing.ts`, `dev.ts` | `@saltix/grain-server/testing` (`testChat`: an app's chat under test, wallets that check every card) and `/dev` (`createDevRelay`, `createDevRegistry`): subpaths, not in `index.ts` |
| `app-key.ts`, `network.ts` | the developer key; the public relays and the chain view a server reads |
| `relay.ts`, `records.ts`, `seal.ts`, `upload.ts`, `file.ts` | `RelayClient`, relay records, sealed frames, files next to the relay |
| `login.ts`, `invoice.ts`, `notification.ts`, `sponsor.ts`, `node.ts` | sign-ins, invoices, notifications, sponsors, a node's wallet interface |
| `publish.ts`, `publish-link.ts`, `inflate.ts`, `keys.ts`, `address.ts`, `bytes.ts` | publishing links, raw DEFLATE, device keys, Address v1, encoding |
| `packages/cli/src/main.ts` | `grain`: the help and every command's dispatch |
| `packages/cli/src/` others | `network.ts` (where a command reaches the network: public relays, `--relay`, `--node`), `faucet.ts`, `project.ts` (manifest checks, key files), `template.ts` (`grain init`, its AGENTS.md), `dev.ts` (and the simulator it serves at `/_simulator/`), `pages.ts` (`grain lint`'s checks of a page), `bundle.ts`, `registry.ts` (publish, retire, show), `studio.ts` (configure, access, rate, bind, app-key), `chat.ts` (chat-spec, cert), `sponsor.ts` |
| `simulator/` | the wallet's side in a desktop browser (`simulator/phone.ts`: the page framed as Saltix frames it, inside the safe area or edge to edge with `viewport-fit=cover`, with the wallet's controls, on a phone, one on its side, the Galaxy Z Fold's sizes and an iPhone-like screen); it imports the server's modules one by one, never `index.ts` (which holds Node-only code); `grain dev` serves it too, built into the command line's package |
| `scripts/dev.mjs`, `scripts/dev-relay.mjs` | `npm run dev`: the simulator, `examples/hello-grain`, a development relay (the SDK's `/dev`, re-exported) and registry |
| `scripts/sync-vectors.sh` | copies the protocol's golden vectors from a Saltix checkout; `vectors/SOURCE` names its commit |
| `examples/hello-grain/` | the example: a page, its server and a chat (`npm run example` runs the chat from a developer key) |
| `docs/` | `first-app.md`, `chats.md`, and these pages |

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
- **A test that starts a server or a process bounds every wait** (as `wallet.until` in
  `packages/server/test/chat-helpers.mjs` does): a broken change must fail the test, not hang CI.
- **No secrets** in code, tests, fixtures or logs: tests use fixed fake keys (`"61".repeat(32)`), never a real
  developer key; `examples/**/*.key` and `*.store.json` are ignored. Scan the staged diff before committing.
- **Logs** carry event names and numbers, never keys, arguments, what users wrote or who is on a team.
- **The command line**: every flag a command takes is in its help; `--help` runs nothing. Every command keeps a key off
  the command line (files, `SALTIX_APP_KEY`, stdin).
- **Docs move with the code**: README, `docs/first-app.md`, `docs/chats.md` and a line in `CHANGELOG.md` under
  `[Unreleased]` in the same pull request.

## How a change lands

1. A branch from `main`: `feat/…`, `fix/…`, `docs/…`.
2. Conventional Commits in English, scope the package (`server`, `grain`, `cli`, `simulator`, `docs`); a format change
   is `feat(server)!:` with a `BREAKING CHANGE:` footer.
3. `npm test` passes; CI (`.github/workflows/ci.yml`: Node 22 on the project's own runner, `npm ci && npm test`) passes
   on the pull request.
4. Squash merge. Saltix's own app (saltix-wallet `server/access-grain`) vendors the built server SDK by its sync script:
   a change it needs is synced there in a pull request of its own.
