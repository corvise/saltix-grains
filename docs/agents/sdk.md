# Working on the SDK, for a coding agent

This repository holds the SDKs a Saltix app is built with: the page's bridge, the server's side, the `grain` command line
and the simulator. It follows the protocol and never defines a format itself. The protocol's specifications live in its
own repository, not public before the main network launches; [docs/protocol/](../protocol/README.md) is this
repository's account of what apps need of them, and the golden vectors in `vectors/` are its bytes.

## Map

| Where | What |
|---|---|
| `packages/grain/src/rules.ts` | `@saltix/grain/rules`, the wallet's bridge rules the simulator plays by (as Saltix's Android app applies them: its bridge, container, storage and sealed site): `tapRule`, `permissionRule`, `manageRule`, `BridgeLimiter` (a bucket per known method only), `bridgeAnswer` and `bridgeEvent` (64 KiB), `storageRule`, `sealedCsp`, `devPageUrl` (where a development wallet opens a page: a sealed one's start page from the bundle's root, never beside the manifest); tested in `packages/grain/test/rules.test.mjs`; never part of a page's `index.js` |
| `packages/grain/src/index.ts` | `@saltix/grain`, the page's side of the bridge, one module (`grain init` copies it into `public/`); `layoutSheet`, where `grain.layout()` keeps its CSS variables below the wallet's; and the wallet's rules the simulator plays by (`frameFor`, `controlsFor`, `pageColorOf`, `frameColors`, `shortAddress`) |
| `packages/server/src/` | `@saltix/grain-server`; `index.ts` re-exports every module below |
| `manifest.ts`, `registry.ts`, `tx.ts`, `handle.ts` | the manifest, the registry's calls (`signGrainTx`, `grainCallProblem`), transactions v3, usernames |
| `chat.ts`, `chat-card.ts` | the chat's formats (specs, requests, messages, member proofs) and the card builder |
| `card-standard.ts`, `card-lint.ts` | the card standard (22-grain-chats §5a: the action bar's rows and emphasis, polls' looks and shares; it reproduces the vectors' `cards`), and the lint against the guide's numbers ([cards.md](cards.md)) |
| `chat-server.ts`, `chat-store.ts`, `report.ts`, `stats.ts`, `member.ts` | `ChatServer`: requests, budget, console, error reports, numbers, private apps |
| `testing.ts`, `dev.ts` | `@saltix/grain-server/testing` (`testChat`: an app's chat under test, wallets that check every card) and `/dev` (`createDevRelay`, `createDevRegistry`): subpaths, not in `index.ts` |
| `app-key.ts`, `network.ts` | the developer key; the public relays and the chain view a server reads |
| `pairing.ts`, `key-file.ts` | pairing a server by QR code (24-app-studio §3a: the offer, its link and code, the frames, the computer's judgment, the wallet's check of an answer, the server key's proof; `vectors/server-pairing-v1.json`); where a server finds its key (`appKeyFromEnvironment`), refusing to start unpaired |
| `relay.ts`, `records.ts`, `seal.ts`, `upload.ts`, `file.ts` | `RelayClient` (its `access` grant shown only where a relay's hello asks, `AccessRefused` from a round of refusals, `accessEnded`, `accessLost`), relay records, sealed frames, files next to the relay |
| `access.ts`, `gate.ts`, `dev-gate.ts` | a test network's gate (37-gate, `vectors/gate-v1.json`): the grant, the delegation and the token in Borsh, `AccessKey` (P-256, RFC 6979, low `s`), `accessToken`, the relay's own check (`checkAccessToken`, in its order: what the dev relay runs), a code's canonical form and id, `helloGates`/`statusGates`; the reference gate's interface (`redeemComputerAccess`: a new key, a challenge, `unattested: "computer"`, the grant checked before it is taken; `GATE_WORDS`); `createDevGate` in `/dev`, and `createDevRelay({ access })`, which requires grants as a gated relay does |
| `named.ts`, `bundle-upload.ts`, `blobs.ts` | named blobs (32-images, `vectors/images-v1.json`): the image check and the bundle check (`checkImage`, `checkBundle`, `namedProblem`, `namedHash`), the server key's statement for a pending bundle (`signBundleUpload`, `bundleUploadProblem`), and putting a bundle (in pieces, resumed on `offset`, `busy` and `rate_limited` waited out) and an icon into the network and reading them back (`putBundle`, `putIcon`, `getBlob`, `blobHeld`); `dev.ts`'s registry takes blobs as a node does |
| `login.ts`, `sign-in.ts`, `invoice.ts`, `notification.ts`, `sponsor.ts`, `node.ts` | sign-ins (a page's, with the team's member proof and its rights: `SignIns`), invoices, notifications, sponsors, a node's wallet interface |
| `profile.ts`, `profile-link.ts`, `keylog.ts`, `web.ts` | the Connect profile (19-connect §11: format, checks with the node's reasons, JSON form, signing, the profile link's reader; its writer needs zlib), key event logs checked offline (the node's rules, as Saltix's explorer checks them; a quorum in either protocol version's form, all its signers in one, held to `vectors/accounts-v1.json`'s `quorums_v2`), and `@saltix/grain-server/web`, the modules that run in a web page |
| `packages/connect/src/` | `@saltix/connect`, Sign in with Saltix for websites ([../connect.md](../connect.md)): `client.ts` (`createConnect`), `session.ts`, `offer.ts`, `grant.ts`, `seal.ts`, `relay.ts`, `store.ts`, `verify.ts` (the page's check of a grant: the reference Saltix's explorer follows), `button.ts`, `dialog.ts`, `connect.css`, `site.ts` (`readSiteProfile`); built also as one module, `dist/saltix-connect.js` |
| `publish.ts`, `publish-link.ts`, `inflate.ts`, `keys.ts`, `address.ts`, `bytes.ts` | publishing links, raw DEFLATE, device keys and the one Ed25519 check (`verifyEd25519`), Address v1, encoding |
| `packages/cli/src/main.ts` | `grain`: the help and every command's dispatch |
| `packages/cli/src/` others | `network.ts` (where a command reaches the network: public relays, `--relay`, `--node`), `faucet.ts`, `project.ts` (manifest checks, key files), `template.ts` (`grain init`, its AGENTS.md), `dev.ts` (and the simulator it serves at `/_simulator/`), `pages.ts` (`grain lint`'s checks of a page), `connect.ts` (`connect.json`, and `grain lint`'s checks of it, the icon and permissions nothing uses; `templateTexts`, the words `grain init` wrote, which lint warns of and `grain profile` refuses), `pair.ts` (`grain pair`: the key in `.grain/`, the offer shown, the relay connection that answers Saltix, the registry watched, `app.key` and `app.json`), `status.ts` (`grain status`, `grain doctor`: `projectKind`, a page alone's `not_needed`, the deposit and the fees of the manifest as sent before a first publish, `inNetwork` (a relay's `fetching` is no proof anyone holds a blob), `stageOf` (each transaction a key file here sent, until it lands), `outcomeOf` and `DOCTOR_EXIT`: 0 nothing to do, 1 something to do, 75 only waiting), `owner.ts` (who signs an owner's call: `signerFor`, the owner's Saltix unless `--key` names a key file or the registry names its account; `ownerLine`, said before anything is signed; `keyFlag`, the one rule for `--key` in a suggested command), `check.ts` (`grain dev --check`: the simulator driven through `window.saltixSimulator`, what it saw judged by `judge`; `--tap`, each button tapped once by pointer events, and those a tap brings up (`more()`), judged by `judgeTaps`; `underNavigationBar`, `underStatusBar`: an element fixed or sticky to the bottom where the page opens, one that scrolls at its scroll's end), `browser.ts` (`findBrowser`, and the DevTools protocol over `--remote-debugging-pipe`; `ready`, a cold start waited for), `monogram.ts` (`grain icon --monogram`: a stroke font of A–Z and 0–9, `monogramPixels`), `access.ts` (a computer's access on a test network closed by access codes: `obtainAccess`, the grant kept in `.grain/access.json` and its key in `.grain/access.key` while it lasts, else a code's from `--access-code`, `SALTIX_ACCESS_CODE` or the terminal; `accessRefusalWords`, what to do about each refusal of the relays, and the grant forgotten when it is no good; `gatedOf`, `node_status.access`), `devlog.ts` (the steps' log, `.grain/log.jsonl`: codes only; `EXIT_WAITING`, 75; `endOnSignals`, its last line on Ctrl-C, SIGTERM or SIGHUP however the command was launched), `profile.ts` (`grain profile`, `grain connect-profile`); `chat-template.ts` the chat's server and every project's `package.json`, which links the SDK and the `grain` command from the checkout, `bundle.ts` (the bundle, checked as every node checks it), `publish-flow.ts` (`grain publish`: the form, the bundle, its sources, what the registry holds already (`sameContent`, in the manifest's canonical form: nothing changed, nothing sent), the upload on the paired key's statement, the owner's signature, a key file's registration with `SetGrainAccess` private right behind it, what it sent kept and waited for by the next run (`sent`, `private_pending`; `recordSent` for `grain access` and `grain profile`, `landedIn`), the manifest as sent (`sealedAsSent`, which doctor's fees use), the registry, the icon, who opens the app (`whoOpens`, `whoOpensNow`, `walletAccessWords`); `.grain/publish.json`, which `grain doctor` and `grain lint` (`readiness`: lint's last line, what is left in doctor's words, `publicChanged`, `nextVersion`) read), `sources.ts` (a sealed manifest's sources by the network's protocol: none from version 2, before it the network's own copies at up to 3 relays), `versions.ts` (the network's protocol version from `node_status`, a node left behind's `outdated` included; the next version's first slot; `windowFor`, which `submit` signs every call by: a call its version does not take refused, one of a form a scheduled version retires valid at most until the slot before it), `icon.ts`, `image.ts`, `png-write.ts` (`grain icon`: an icon to the standard from any PNG or JPEG, §3.4's checks, the preview; decoding with colour profiles and EXIF, Lanczos resampling, PNG writing and palettes), `registry.ts` (publish's calls, retire, show), `studio.ts` (configure, in the form of the network's version: bare keys in version 1, each key with the proof its key file signs from version 2; access, rate, bind, app-key; `unchanged`: nothing to change, nothing sent), `send.ts` (an account's registry calls one at a time: each waits until it landed, saying where it stands, and one the pool refuses for an earlier pending call is built again), `wait.ts` (a long wait said as it goes, with its limit: one line rewritten on a terminal, a line when the stage changes and every 15 seconds elsewhere), `chat.ts` (chat-spec, cert), `sponsor.ts` |
| `simulator/` | the wallet's side in a desktop browser (`simulator/connect-sheet.ts`: a preview of the Connect sheet from `connect.json` and the manifest, before a grain opens; `simulator/phone.ts`: the page framed as Saltix frames it, inside the safe area or edge to edge with `viewport-fit=cover`, with the wallet's controls, the band, margins and icons in the page's colours (`frameColors`, `pageColorOf`, read when Saltix reads them) and Saltix's splash while the page loads, on a phone, one on its side, the Galaxy Z Fold's sizes and an iPhone-like screen; `simulator/icon.ts`: the project's icon, which `grain dev` serves at `/_icon.png`, in the sheet and the splash; `window.saltixSimulator`, what `grain dev --check` drives: the devices, the theme, the sheet, the refused requests and the page's geometry; for `--tap`, the buttons and where to tap each (`buttons`, `aim`), those a tap brought up (`more`), every request (`calls`), and `drive()`, after which it declines payments and opens no link); it imports the server's modules one by one, never `index.ts` (which holds Node-only code); `grain dev` serves it too, built into the command line's package |
| `scripts/dev.mjs`, `scripts/dev-relay.mjs` | `npm run dev`: the simulator, `examples/hello-grain`, a development relay (the SDK's `/dev`, re-exported) and registry |
| `scripts/sync-vectors.sh`, `scripts/check-vectors.mjs` | copies the protocol's golden vectors from a checkout of the protocol's repository, `vectors/SOURCE` naming its commit and each file's blob id (every file, or those named alone, each line then naming its own commit); the check CI runs that every file is those bytes; `vectors/README.md` says what each file holds |
| `scripts/scratch.mjs`, `scripts/ci-tmp.sh` | a test file's directories (`scratch(prefix)`: under the system's temporary directory, removed after the file's last test, a failed one's too); CI's check that the tests left nothing in the job's own temporary directory |
| `examples/hello-grain/` | the example: a page, its server and a chat (`npm run example` runs the chat from a developer key); `packages/server/test/example.test.mjs` runs its chat on `testChat` and holds every card to the card standard |
| `docs/` | `how-it-works.md` (read first: the pieces, *Do I need a server?*, the lifecycle; `docs.test.mjs` holds its tables and checklist, `agent-docs.test.mjs` lets it and the other guides name a command not built yet only as coming), `first-app.md` (with the brief Saltix copies for a coding agent, word for word as the wallet's test holds it), `chats.md`, `cards.md` (and its pictures in `cards/`), `payments.md`, `connect.md`, `devex.md` (the developer experience and its roadmap), these pages, and `docs/protocol/` (the protocol as an app needs it, page by specification; `packages/cli/test/protocol-docs.test.mjs` follows every link and anchor of every page and refuses a link into the private repositories) |

## Commands

```sh
npm ci                     # esbuild's install script is denied (allowScripts): its binary comes from its platform package
npm test                   # builds every package and the simulator, then each package's node --test: what CI runs
cd packages/cli && node --test --test-force-exit test/check.test.mjs   # grain dev --check in this computer's Chrome
npm run build --workspace packages/server            # one package
cd packages/server && node --test --test-force-exit test/chat-server.test.mjs   # one file
node --test --test-force-exit --test-name-pattern "budget" test/chat-server.test.mjs  # one test
npm run dev                # the simulator and the example on :8090
```

Tests import `dist/`: build the package before running its tests by path, and again after editing `src/`.

## Rules of the repository

- **Formats come from the protocol.** A change to a format starts in the protocol's specifications and vectors; here,
  a maintainer with a checkout of the protocol's repository runs `scripts/sync-vectors.sh <checkout>` (a clean one: it
  records the commit and each file's git blob id in `vectors/SOURCE`), then changes the code until `vectors.test.mjs`
  and `chat.test.mjs` pass. A format the SDK takes up before the rest of the protocol's changes since is synced alone,
  `scripts/sync-vectors.sh <checkout> <file>…`: its line names its own commit, and the other files stay as they were. Never edit a vector by hand: CI runs `node scripts/check-vectors.mjs`, which holds every
  file to its id in `SOURCE`; with `--saltix <checkout>` it also says which files the protocol changed since, time to
  sync.
- **The protocol's pages move with it.** `docs/protocol/` keeps each specification's section numbers and names the
  protocol commit its text was read at (`As of corvise/saltix <commit>`). A sync or a change that reaches apps updates
  the page and that line in the same pull request, re-read against the specification: what an app needs, never the
  chain's internals, nodes', relays' or wallets' own workings, or anything about servers. They link nothing in the
  private repositories.
- **Tests assert behaviour**, refusals included. A check that guards money, keys or what a wallet trusts is
  mutation-tested: break it in `dist/*.js`, run its test file, see it fail, restore and rebuild (the CHANGELOG and pull
  requests say how many mutants were killed).
- **Ed25519 is verified in one place**: `verifyEd25519` in `keys.ts`, the node's `verify_strict` case for case
  (`ed25519.test.mjs` pins ed25519-dalek's verdicts on keys and `R` of small order or with a torsion part, `s` not
  reduced, non-canonical encodings). A library's `verify` is permissive (RFC 8032's cofactored equation; a key of small
  order "signs" every message): no module calls one, and the test fails if one does.
- **The page's check of a Connect grant is the reference.** `@saltix/connect`'s `verifyGrant` and `retryable` decide
  what is refused, what is only unchecked and when the node is asked again; Saltix's explorer, which lives with the
  protocol, follows them, and a change here is synced there in a pull request of its own.
- **A test removes what it makes.** A directory, a project or a key file comes from `scratch()` in
  `scripts/scratch.mjs`, never from `mkdtempSync` itself, and goes after the file's last test, failed ones included. CI
  runs the tests with `TMPDIR` in a directory of the job's own and fails if they leave anything there
  (`scripts/ci-tmp.sh`): a developer's temporary directory, and a self-hosted runner's shared one, never fill up run
  after run. Rejected: comparing listings of `/tmp` before and after (another job's files would count), and removing at
  a test's end (a failing test never gets there).
- **A test that starts a server or a process bounds every wait** (as `wallet.until` in
  `packages/server/test/chat-helpers.mjs` does): a broken change must fail the test, not hang CI.
- **The simulator plays Saltix by Saltix's own code.** What it draws (the frame, the band's colours, the icons'
  contrast, the splash) follows the wallet's (its frame script and its Android app's frame and grain screen), and so
  does what it answers (the Android app's bridge: taps, permissions, the team, rate limits, storage, 64 KiB a message,
  a sealed grain's origin and policy); each rule it needs is a pure function in `@saltix/grain`
  (`frameFor`, `controlsFor`, `pageColorOf`, `frameColors`; `@saltix/grain/rules` for the bridge's) with its test in
  `packages/grain/test/`, never logic inline in `simulator/`, which no test reaches. When Saltix changes, change the
  function and its test to match first.
- **`grain.layout()` never writes `:root`'s inline style.** Saltix sets the variables itself, in a sheet that wins over
  the page's stylesheets ([12-grains §5](../protocol/grains.md#5-the-bridge)); the SDK's go in `layoutSheet`, below it, and `stop()` removes them and nothing
  else. `grain.test.mjs` models the cascade (inline, adopted sheets, `<style>`) with Saltix's frame script in place: a
  change there keeps the wallet's values winning, the later ones too.
- **The example keeps the rules it teaches.** `examples/hello-grain` is what developers copy: every card it sends passes
  `assertCardStandard` (`example.test.mjs`), and a command added there gets a case in that test.
- **No secrets** in code, tests, fixtures or logs: tests use fixed fake keys (`"61".repeat(32)`), never a real
  developer key; `examples/**/*.key` and `*.store.json` are ignored. Scan the staged diff before committing.
- **Logs** carry event names and numbers, never keys, arguments, what users wrote or who is on a team.
- **Publishing needs no host.** `grain publish` puts a page's bundle into the network itself (32-images §7.3): never add
  a step, a flag or a doc that sends a developer to a host of their own, a CDN or a third party's service; sources are
  the network's own relays' copies (before protocol version 2) or none. `publish.test.mjs` runs the whole flow against
  `@saltix/grain-server/dev`'s registry, which takes blobs as a node does.
- **The command line**: every flag a command takes is in its help; `--help` runs nothing. Every command keeps a key off
  the command line (files, `SALTIX_APP_KEY`, stdin).
- **Docs move with the code**: README, `docs/` and a line in `CHANGELOG.md` under `[Unreleased]` in the same pull
  request. A change a developer meets also extends `AGENTS.md`, these pages and every project's `AGENTS.md` (the texts in
  `packages/cli/src/template.ts`: `agentsMd`, `appRules`, `fullScreenRules`), which `agents-template.test.mjs`,
  `agent-docs.test.mjs` and `docs.test.mjs` hold to each other and to the code.

## Decisions

What the SDK decided, and why, where a choice was made; the newest first. A change that goes against one says so here.

- **2026-10-21, a test network closed by access codes** (Saltix 37-gate, approved by the owner 2026-10-20): its relays
  let a connection in only with an access grant, unless a registered server key of a live grain signed its record, and
  their wallet interface takes `transaction_submit` and `faucet_request` only with one.
  - **Who shows a grant**: a key the registry does not name (`grain pair`'s, a certified one) and the tools' writes;
    never a paired server, which the relays exempt, so `npm start` needs no code and a paired project is never asked
    for one. `RelayClient` shows the grant its `access` option gives, only where the hello names `access`. Rejected:
    showing one whenever there is one (a paired server would depend on a code a day, and an ended grant would refuse
    a key the relay would have let in).
  - **The code before the offer**: `grain pair` gets the grant from `node_status.access` before it shows the QR code, so
    a missing or refused code stops it before anyone scans; `--no-wait` gets it too, and the run that waits reuses it.
    Rejected: asking when a relay's hello names access (the person would scan an offer the computer cannot answer).
  - **A computer's grant is unattested** (`unattested: "computer"`, at most 24 hours of the code's length), its P-256
    key made fresh for each redemption with `@noble/curves`, already a dependency (no new one). The grant and its key
    are kept in the project (`.grain/access.json`, `.grain/access.key`, owner-only, out of git), reused while more than
    a minute is left and the network's gates still sign it, forgotten when the relays refuse it as ended, of another
    gate, network or lifetime, or of a token they do not take. Rejected: one grant per user for every project (a second
    place to look, and a grant outliving the project it was got for); reusing the key across grants (nothing gained).
  - **A token at the relay's moment**: signed at the hello's `sts`, so this computer's clock never decides whether a
    relay takes it.
  - **Writes ask on demand**: `RelayGateways.useAccess` gives a credential that is asked for only when a relay refuses a
    write for want of one (HTTP 401, `-32001`), once for writes at once, then shown up front; a token names the relay
    `relay_list` gives for that endpoint. A network without a gate never asks. Rejected: a code up front for every
    command (a read-only command, or a network with no gate, would ask for nothing it needs).
  - **Every refusal in words**: the gate's (`GATE_WORDS`: a code not taken, too many attempts with the wait, computers
    not served, a gate of another network) and the relays' (`accessRefusalWords`: what to do, and whether the kept grant
    is forgotten), and the log's reasons are codes (`gate` `redeemed`, `kept`, `code_needed`, `rejected`; `relay`
    `access_expired`). A code mistyped is refused before the gate is asked (a letter I, L, O or U is a misread 1
    or 0): an attempt costs the person one of the gate's few. Rejected: mapping those letters to digits (the gate's
    canonical form is the code in upper case, and a guess spent an attempt).
  - **Vectors**: `gate-v1.json` is synced alone from `9ff53fd8` (the gate's own commit), its `SOURCE` line naming that commit
    (`scripts/sync-vectors.sh <checkout> <file>…`, `check-vectors.mjs` reads the third word). Rejected: syncing every
    file from that commit (names and numbers, images and profiles changed since `b9019fd`, each a change of the SDK of
    its own).
  - **Development**: `createDevGate` speaks the gate's interface with every refusal (`refuse`), and
    `createDevRelay({ access })` requires grants with the node's own check, ends access at a grant's end and on
    `endAccess`, and exempts the keys `exempt` names, so the tests meet what the network does.
- **2026-10-20, ready for protocol version 2** (versions 2 and 3 are to be scheduled on the test network; no network runs them yet):
  - **`grain configure` follows the network's version**, never a flag: tag 34 with bare keys while `node_status` says
    version 1, tag 39 with each key's proof from version 2 (a node left behind counts by the version its `outdated`
    saw). The proof is signed here by the key file `--server` names, for the grain's owner the registry names: the key
    never leaves the computer. Rejected: a `--v2` flag (a developer cannot know when the network switches), and sending
    a bare key from version 2 to see whether the node takes it (it never does: nothing could sign its proof).
  - **A call of a form a scheduled version retires is signed valid only until the slot before it** (`windowFor`, which
    every signed call passes): tag 34 lands before the switch or expires there, and in the last 30 slots it is not sent
    at all (run it again after, when it goes as tag 39). Rejected: the whole 600-slot window (the pool drops a tag 34
    still waiting at the switch, and the command waits 6 minutes for nothing), and waiting for the switch inside the
    command (up to a day on the test network).
  - **The owner's Saltix names a computer's key by pairing it** from version 2: `grain configure --server` on the wallet's
    side would ask the owner to name by hand a key whose proof the phone does not have, so it says to run `grain pair`
    instead; `--revoke-all` still goes to Saltix, since an empty list needs no proof.
  - **The offline log check takes a quorum in either form**, the newer first, all its signers in one: the protocol's
    `check_log` (13-accounts §7), held to `accounts-v1.json`'s `quorums_v2` by rebuilding its log with them. Before, a
    managed account with a quorum signed under version 2 would fail every Connect grant and site profile check.

- **2026-10-20, from the acceptance test's fourth round** (a fresh agent with the public SDK alone published, updated
  and published again a page app in 11.5 minutes, every timing and doctor exit status as documented, and reported what
  still misled it):
  - **A signal is handled for the life of the process** (`endOnSignals`, `devlog.ts`): Ctrl-C on `npx grain dev` left
    no `end` line (3 of 3), while SIGINT to the command's own process group did. Root cause: a terminal's Ctrl-C signals
    the whole foreground process group, npm (npx, `npm run`) and the command alike, and npm forwards the SIGINT it got to
    the command too, so the command gets two, about half a millisecond apart. The handler was `process.once`: the first
    signal removed it, Node gave SIGINT back to its default action, and the second killed the process during the
    handler's synchronous write, before the line reached the file. Now the handler stays (`process.on`), writes the line
    synchronously first thing, ignores a second signal, and exits with the first's status (130, 143; SIGHUP, a closed
    terminal, 129, handled too). `grain pair`'s own SIGINT handler, which never ran, is gone. Tested through `npx --no
    grain` in a process group of its own (dev and a waiting publish), and with a second signal sent while a slow handler
    writes. Rejected: telling people to run `./node_modules/.bin/grain` or `npx --no` (npm forwards either way); logging
    on the next start that a run ended without its line (a run still going, in another terminal, would read as one cut
    short; only `kill -9` ends a run with no line now, and it is documented).
  - **`--tap` taps what a tap brings up**: after each tap the simulator (`saltixSimulator.more()`) gives the buttons now
    shown that were never seen, by element and by name with its numbers left out (a counter's label, or a page that
    draws its buttons again, is no new button), and they are tapped in their turn within the same bounds: 30 buttons in
    all, 40 s. Those the bounds leave are a warning ("N buttons appeared later and were not tapped"). Rejected: tapping
    every button again after each tap (a page that redraws would be tapped to the bound); a deeper exploration of states
    (unbounded, and a test of the page's logic, not of its taps).
  - **A failed tap is never beside an "ok" line**: the count of tapped buttons is said only when no tap failed (the
    header line counts them either way), and `next:` names the command that found it (`grain dev --check --tap`).
  - **A wait says its limit**: `(1:39 of up to 6:00)`, the time left of the command's own deadline when the wait began.
  - **`grain lint`'s last line says what is left**, in `grain doctor`'s words (`publicChanged`, `nextVersion`,
    `TEMPLATE_NEXT`): `left: public/ changed since v1: grain publish seals v2`, `rewrite connect.json for this app`;
    never "ready to publish" while something is. And a version `grain publish` finds in the registry with the same
    content counts as published (`published_at` recorded), so a `--no-wait` publish finished by the next run no longer
    reads as never published. Doctor's profile line says to rewrite `connect.json` before `grain profile` while it holds
    the template's words.
  - **One rule for `--key`** (`keyFlag`): it goes on a first `grain publish` only; after it, a key file that owns the app
    signs by itself, so no hint and no page names `--key owner.key`, and the suggested command is the same whoever owns
    the app (a phone's account gets the QR code). A key file elsewhere is named. Rejected: `--key owner.key` everywhere
    (a hint would differ by who owns the app, and the docs' No phone steps already ran without it).
  - **The owner on the Connect preview is a short address** (`shortAddress` in `@saltix/grain`, Saltix's own form:
    prefix and kind, 4 characters of the id, `…`, the last 6), of the development registry's network; never hex.
  - **`--json`'s `next` is the text's**: `grain doctor` and `grain status` give `nothing: …` where they used to give
    `null`; `outcome` and `exit` tell done apart.
  - **`grain dev` is said to be a server** wherever an agent reads the quick path (AGENTS.md, the README, every page
    project's AGENTS.md, how-it-works.md, the help): it runs until Ctrl-C, so an agent runs it in the background or not
    at all, and checks with `--check`, which exits.
  - **The Connect sheet's "Payments and contacts" row** is explained in docs/agents/app.md: on every sheet, no
    permission bit, nothing to drop.

- **2026-10-20, from the acceptance test's third round** (a fresh agent with the public SDK alone published a private
  notes page with no phone, set its profile and access, updated it and published again, and reported what misled it):
  - **"Published" needs the bytes, never a relay's `fetching`** (`inNetwork`): a relay knows a bundle's and an icon's
    hash from the manifest the registry holds and answers `blob_get` with `{blob: null, fetching: true}` while it looks
    for them, whether or not anyone has them (32-images §8); doctor took that for held and said "published" with
    nothing uploaded. Held by the relay asked, or seen taken from here (`uploaded_at`, `icon_uploaded_at`, which
    `grain publish` now also records when it finds them held), is in the network; otherwise the upload is left and
    `next` is `grain publish`. The development registry answers `fetching` for a named blob nobody brought, as a node
    does, so the tests meet what the network does. Rejected: asking more relays (still no proof); downloading the
    bundle to check (megabytes for a yes or no).
  - **Doctor's exit status tells waiting apart** (`outcomeOf`, `DOCTOR_EXIT`): 0 nothing to do, 1 something to do, 75
    nothing but waiting for the network, sysexits' EX_TEMPFAIL as 78 is a server's EX_CONFIG; something to do outweighs
    waiting (it can be done meanwhile, and `next` says it); the log says `waiting`, never `refused`, for a transaction on
    its way, and `end` `waiting` `exit_75`. The README keeps a note for scripts written for exit 1. Rejected: 2 (the
    command line's misuse, so `grain doctor --typo` would read as waiting); one status for both (the agent ran doctor
    seven times and read each wait as a failure).
  - **Every transaction a key file here sent is followed until it lands**: `grain access` and `grain profile` keep
    theirs in `.grain/publish.json` beside `grain publish`'s (`sent`, with what each makes: the access, the profile's
    revision), and doctor says where each stands (in the pool, in a block, not seen yet), that it landed (`ok registry v1
    registered (the transaction sent at … landed)`), or that it can land no more, with the command that sends it again.
    Gone is judged as the command that would send it again judges: a registration or an update only past its last slot
    (sent twice, one is refused), an access or profile call once the node knows it not (twice is harmless). Rejected: a
    file of its own for owner's calls (two places to read, and publish's own access call is one of them); doctor
    forgetting what landed (it only reads: the next command that sees it land forgets it).
  - **Nothing to change, nothing sent, for every owner's call** (`unchanged`): `access`, `configure` and `bind` compare
    with the registry, `profile` by its words (texts, links, subject; never its revision or signature, which a new one
    always changes), before the owner's Saltix is asked or a key file signs, and again whenever a call is built anew
    after the account's earlier one landed, so two commands at once send it once. Rejected: only `access` (`profile` run
    twice cost a fee and two minutes as well).
  - **Who opens the app, in one set of words** (`whoOpensNow`): `grain publish`'s last line and doctor's access line;
    publish no longer says "its owner and members open it" before "nobody opens it in Saltix yet".
  - **A change not published is something to do**: `public/` changed since grain.json's bundle, or grain.json saying
    something else than the registry's version (`sameContent`), is `fix` with `grain publish`, never `nothing`.
  - **The fees doctor quotes are the manifest's as sent** (`sealedAsSent`: sealed, with the sources the network's
    protocol asks for), equal to what the two transactions pay.
  - **Where the bundle goes, said once** (how-it-works.md, *Where the bundle goes*): the network's keepers on every
    protocol version; only the manifest's `sources` differ (none from version 2; before it, addresses of the network's
    own copy at up to 3 relays). Publish's `sources:` line says the same.
  - **`grain dev --check --tap`**: each of the page's buttons tapped once (at most 30, never a link, at the phone's
    size in the dark theme) by the DevTools protocol's pointer events, so the page's bridge carries a user's tap; then
    the page's exceptions and the requests Saltix refused are errors (a user's 4001 never), no change on the page and no
    request a warning, and so are a covered button and a document from another origin. The page's frame is compared
    pixel by pixel (two PNG encodings of the same pixels differ, and the status bar's clock moves), each look taken at
    rest, until two agree (a hover's look is drawn a frame or two later; a page that never rests, an animation, is never
    called unchanged). Bounded and safe:
    40 s for all taps; documents from elsewhere stopped before they load (`Fetch`, documents only); no window
    (`--block-new-web-contents`); the simulator, driven by a tool, declines payments (4001) and opens no link. Opt-in:
    a page's buttons may reach its server, and `--check` keeps its meaning. Rejected: `el.click()` (no user activation:
    the bridge refuses what needs a tap); tapping links (they leave the page); on by default.
  - **A published app is private by default in Saltix** (saltix-wallet #411, Saltix 0.1.61): unless the owner switches
    on Public in the Marketplace on the publishing sheet, Saltix sends `SetGrainAccess` private itself once the
    registration landed. `grain publish` says so (log `access` `wallet`) and never "anyone opens it" for a first version
    the wallet registered, which the registry may make private a block or two later; an older Saltix registers it
    public: `grain access --private`.
  - **Smaller ones**: `--no-wait` never says the command waits; an owner's call with `--no-wait` names `grain doctor`,
    not `grain show`, as what says it landed; `grain dev --check` waits for a cold browser to answer (`Browser.ready`, up
    to 45 s) before its first call, which a busy CI runner's first launch let time out at 15 s.

- **2026-10-20, from the acceptance test's second round** (a fresh agent with the public SDK alone published a private
  page-only app with no phone, updated it and published again with nothing changed, without an error, in 13.5 minutes,
  and reported what slowed it):
  - **`SetGrainAccess` private right behind `RegisterGrain`**, with the next nonce, before the registration lands. The
    pool takes a transaction up to 64 nonces ahead of the account's (08-node §2, [basics](../protocol/basics.md#transactions-an-apps-tools-sign)),
    an account's calls apply in nonce order, and a shard's registry calls reach the beacon chain's registry in their
    order (05-beacon §1, 06-licenses §4): the access call applies after the registration, in the same block or the next.
    The app is never public in between, and a first publish takes one transaction's time (about 1.5 to 2.5 minutes on
    the test network) instead of two. A pool that takes no nonce ahead: sent once the registration landed. Rejected:
    one after the other (two transactions' time, and the app public for about 2.5 minutes, for good if the second never
    landed); a call that registers private (the protocol has none).
  - **What a key file sent is kept** in `.grain/publish.json` (`sent`, `private_pending`): a run cut short (a tool's
    timeout, Ctrl-C) or `--no-wait` is finished by the next, which waits for the registration rather than sending it
    again (its nonce would be refused, or a fresh one fail at the registry); an access call that can no longer land is
    sent again, until the registry says private (twice is harmless: both make it private); `grain doctor` says what is
    on its way, and **public, but should be private** with the fix; the owner's own `grain access` in the project ends
    it. Rejected: sending again blindly; leaving it to the developer to notice.
  - **A wait is said as it goes** (`wait.ts`): its stage (in the pool, in a shard block on its way to the registry, the
    owner's Saltix) and the time waited; on a terminal one line rewritten in place, elsewhere a line when the stage
    changes and every 15 seconds, since an agent's tool shows nothing else for minutes. A transaction is waited for 6
    minutes at most (it was 3, close to the 155 seconds one took). The docs state the times and tell agents to run such
    commands in the background, with a timeout of 10 minutes or more, or with `--no-wait` and then `grain doctor`.
    Rejected: a spinner (nothing for a log or an agent to read); a longer silent wait.
  - **`connect-template`**: `grain lint` warns, and `grain profile` refuses, a profile whose tagline, about (with any
    name in it), privacy or highlights are still `grain init`'s words about its counter or hello chat. Rejected: no
    words in the template (an agent learns the format from them, and lint would fail a fresh project before its page
    exists); refusing in lint (an error before the profile is the next step).
  - **The navigation bar is judged by what stays there**: the simulator measures each tappable element as the page
    opens and with everything scrolled to its end, and whether it (or an element around it) is fixed or sticky to the
    bottom; `underNavigationBar` judges such a pinned one where the page opens, since it stays there while the page
    scrolls under it, and any other (a sticky top bar too) at the scroll's end, as high as a user can bring it; the
    status bar as the page opens, where an element that scrolls is at its lowest. Rejected: fixed and sticky elements
    only (a page with no room below its last button is a true positive); the scroll's end alone (a bar sticky to the
    bottom rests above the page's padding there, yet sits under the navigation bar while the page scrolls).
  - **Sealed from `grain init`**: a page project's `grain.json` names the bundle `public/` makes, as `grain publish`
    will publish it, so the Connect preview never calls the code changeable and lint has no placeholder host to warn of
    on every run. An older project's placeholder is still sealed by `grain publish`, and lint says `grain bundle` seals
    it now. Rejected: no entry until the first bundle (every reader of a manifest would need a case for none).
  - **Who opens it**, said once a page is published: anyone; its owner and members in Saltix; or, for a private app a
    key file owns, nobody until a member is named, with the command that names one and the simulator to try it in.
    Rejected: "Saltix opens it from the Apps section" for every app (nobody could, there). (Round three: doctor says
    the same words.)
  - **The steps' log as documented**: an owner's call logs `registry` (`set`, `not_landed`, `not_signed`, `no_wait`);
    an icon's refusal its reason (`alpha`, `hash`…); `doctor` `done`; a run stopped by a signal its `end`
    (`grain dev`: `ok`; any other: `failed`), its exit status the shell's (130, 143).
  - **Smaller ones**: `grain doctor` shows the fees (the pool's floor for the two transactions) and checks
    `connect.json` before the registry can hold it; `grain show` prints a summary, `--json` the record alone; a mark on
    transparency goes on a light or a dark ground, both apart from the two themes' own (a contrast of 1.25 with the
    nearer), whichever leaves less of the mark faint (1/contrast², weighted by alpha), so a two-colour mark keeps both;
    the monogram's stroke is 0.24 of its height, with a tenth of it clear between two letters; `permissions` is
    explained in every project's README and AGENTS.md (JSON takes no comment; a command that explains fields was
    rejected as one more thing to find); the way without a phone is described once, in how-it-works.md, and linked from
    the rest.

- **2026-10-20, from a fresh agent's acceptance test** (it built and published a page-only game from the public SDK
  alone, and reported what it met):
  - **Who signs an owner's call** (`owner.ts`): the owner's Saltix (a QR code, or My apps) by default; a key file only
    when `--key` names it, or for an app the registry already names its account as the owner of; `--wallet` always
    Saltix; the account that will own what the call makes is printed before anything is signed. Why: `grain init` puts
    an `owner.key` in every project, and `grain publish` signed with it whenever the slug was free, so a developer with
    a phone could end up with an app owned by a throwaway key. Rejected: the key file whenever it exists (that
    accident); a key file only on the test network, with a notice (a notice does not stop it, and a plain account may
    keep its key in a file on any network).
  - **Nothing changed, nothing sent** (`sameContent`): `grain publish` compares what the registry holds with what it
    would sign in the manifest's canonical form (Borsh), the owner, the version and the relays' copies aside; the same
    content is never signed again, its missing uploads are finished, and with none it says "nothing to publish" and
    exits 0. A version is raised only for a change of content. Why: the comparison was JSON text, and a node answers
    with its objects' keys sorted, so every run raised the version and sent `UpdateGrain` (a fee, two minutes, a QR code
    for the owner). The development registry answers with sorted keys too, so the tests meet what the network does.
    Rejected: always raising (that cost); comparing JSON with sorted keys (the canonical bytes are what is signed).
  - **A key file's registration starts private**: `SetGrainAccess` private right after `RegisterGrain`, as Saltix's New
    app does (24-app-studio §2a: a new grain is public until its owner says otherwise). A publishing link registers a
    free slug public (the wallet's own flow, 12-grains §10), and `grain publish` says so (superseded in round three:
    Saltix 0.1.61 makes it private unless the owner chooses public). Rejected: changing the docs to
    "public at once" (an app half made would be in the marketplace); one call that registers private (the protocol
    has none).
  - **A page alone pairs nothing**: `grain status` says `not_needed` (exit 0, no network asked) and names `grain doctor`;
    `doctor` ends with a page's words, and before a first publish names the deposit and, on the test network, the way
    without a phone. Rejected: `unpaired`, exit 1 (an agent told to start with `grain status` was sent to pair a page).
  - **`grain dev --check`** drives the simulator in the developer's own Chrome, Chromium, Edge or Brave
    (`CHROME_PATH`), headless, over `--remote-debugging-pipe`, with a profile and a temporary directory it removes
    after (the temporary one short, in the system's: a browser on Linux keeps a socket there, whose path has at most
    108 bytes); the simulator measures (`window.saltixSimulator`), `judge` decides, tested on its own. Without a sandbox
    only where the system gives none. CI runs it in GitHub's Ubuntu image's Chrome. Rejected: Puppeteer or Playwright (a browser download in every install); a debugging
    port (a port open on the computer, and Node 20 has no WebSocket).
  - **`grain icon --monogram`**: one or two letters from a stroke font of the SDK's own, so the bytes are the same on any
    computer. Rejected: a font file or a text-drawing package (another system draws other bytes; a native dependency).
  - **Templates**: `grain init` makes a page that works on its own (no gate); `--sign-in` the page that checks first.
    `connect.json` has no placeholder link; `grain lint` and `grain profile` refuse links to hosts reserved for
    examples, `grain lint` warns of `grain init`'s placeholder origin and `grain sign` refuses it. A page outside
    Saltix links to the app by its slug (`slugLink`), never to a manifest at its own origin, which a sealed page has not.
  - **The simulator opens a sealed page's start from the bundle's root** (`devPageUrl`), where `grain dev` serves
    `public/`, and shows the project's icon on its Connect sheet and splash.
  - **One command's help keeps each note whole** (`notesOf`): a note goes on in lines indented by four, and is shown or
    left out as a whole.
  - **esbuild 0.28** (0.24's development server was GHSA-67mh-4wv8-2f99; the SDK only bundles with it), its install
    script denied in `allowScripts` (npm 11 asks): the binary comes from its platform package.

## How a change lands

1. A branch from `main`: `feat/…`, `fix/…`, `docs/…`.
2. Conventional Commits in English, scope the package (`server`, `grain`, `connect`, `cli`, `simulator`, `docs`); a
   format change is `feat(server)!:` with a `BREAKING CHANGE:` footer.
3. `npm test` passes; CI (`.github/workflows/ci.yml`: `node scripts/check-vectors.mjs` and `npm ci && npm test` on
   Node 22 on GitHub's runners, and the bundle's bytes again on Node 24 and 20) passes on the pull request.
4. Squash merge. The program that runs Saltix's own apps by their developer keys (Saltix Pass) vendors the built
   server SDK: a change it needs is synced there in a pull request of its own.
