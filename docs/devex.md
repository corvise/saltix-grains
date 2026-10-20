# Developer experience: what an app's developer needs next

How it is to build a Saltix app (a grain) with these SDKs today, for a person and for a coding agent that starts from a
developer key, and what to build next, in order. Written 2026-10-16 from a walk through the whole journey in a clean
checkout: a developer key, `grain init`, running and testing a chat, a screen, a bundle, publishing, the server with its
key, its numbers, error reports, payments, updates and logs. Effort is for one engineer or agent: **S** up to a day,
**M** two to four days, **L** a week or more.

## Where it stands

What works well: the developer key really is the server's whole configuration (`ChatServer.start({ appKey, spec })`
finds the test network's relays, checks the registry, signs the spec and refuses a key of a reset network with a clear
message); the server checks every request as a wallet would; error reports reach the console scrubbed of secrets and
ready to paste into an agent; the formats are held byte for byte to the protocol's vectors.

What a newcomer hit, in the order of the journey (fixed ones link their pull request):

| Step | What happened | State |
|---|---|---|
| Install | `npx grain` on a fresh clone: "could not determine executable to run" until a second `npm install` | fixed, #19 |
| Help | `grain init --help` made a grain with an owner key; `grain dev --help` served forever; `grain publish --help` went on to publish | fixed, #18 |
| Flags | `grain init --chat coach` made a *hosted* grain named after the current directory; a mistyped flag was ignored | fixed, #18 |
| Init | a directory named `t1` gave an invalid slug, found only at `grain lint`; `sponsor.key` was not in `.gitignore` | fixed, #20 |
| Chat project | `grain init --chat` made a spec and nothing to run: the server, its `package.json`, key handling and exit codes were guesswork | fixed, #20 |
| Spec version | the template's spec was version 1, the same as the starting spec Saltix signs; Saltix keeps the held spec unless the new one is higher, so the template's commands never reached the owner | fixed, #20 |
| `grain dev` | a taken port died with a stack; in a chat-only grain it served nothing, forever | fixed, #21 |
| Wrong advice | an unregistered or retired grain was told to make a new developer key | fixed, #22 |
| Docs | `npm run dev` read a node at port 30734 (a node listens on 30334); examples said `network: "testnet"` for the test network, which is of the devnet kind; nothing said where `--node` comes from | fixed, #23 |
| Local loop | your own chat cannot run locally: the development relay and registry only serve `hello-grain` | roadmap 1 |
| Tests | testing one command end to end took 50 lines, imports by path into the checkout and wire details (the messaging key's domain, arguments typed and sorted) | fixed, #32 (`testChat`) |
| SDK | not on npm, the repository private; Saltix's own apps' program vendors `dist/` | roadmap 3 |
| `--node` | every registry command needs a node's plain-HTTP interface; the node is published for Linux x86-64 only; the test network's nodes are not reachable that way | fixed, #31 (the public relays, `grain faucet`) |
| Spec changes | a `chat.json` changed under the same version starts fine and reaches nobody | fixed, #28 (78, `ChatSpecVersionError`) |
| Bundles | a sealed screen needs an https host of your own; `grain bundle`'s bytes depend on Node's zlib | fixed: `grain publish` puts the bundle into the network itself (6); the bytes fixed, #27 |
| Icons | an icon had to be a 256 × 256 PNG made by hand; nothing said how wallets draw it | fixed: `grain icon` makes one to Saltix's standard from any picture, with a preview ([icons.md](icons.md)) |
| Payments | a server running from a developer key could not sign invoices | done: it signs invoices to the owner (`chat.invoice`, [payments.md](payments.md)) |
| Logs | `ChatServer` logs nothing unless given `log`, and keeps its state in memory unless given a store | roadmap 13 |
| Keys | the developer key travelled from the phone to the server: a clipboard, a chat, an agent's prompt; an agent asked the user to paste it | fixed: `grain pair` (Saltix 24-app-studio §3a): the key is made where it runs and Saltix pairs it by a QR code; agents start from `grain status` |
| Diagnosis | what went wrong in a developer's session was known only from what they remembered | started: every command logs its steps to `.grain/log.jsonl` ([below](#the-steps-log)); `grain doctor` |
| Agent's start (2026-10-19) | an agent handed a developer key alone found nothing about Saltix; with a brief it built a page-only game, could not publish it without hosting of its own, ran the example's chat on another app's key, and did not know what needs a server | [how-it-works.md](how-it-works.md), the brief Saltix copies, one app one key, pairing (`grain pair`, above); `grain publish` puts a page into the network itself, no hosting (roadmap 6) |
| Example, then project | `npm run example` serves spec version 3 under the app's key, and the project `grain init --chat` made started at 2, which a wallet holding 3 refuses: the app's own commands never reached Saltix | fixed: a project starts at 4 |
| `npx grain` in a project | a project did not depend on the command line, so `npx grain …` there fell through to the npm registry's unrelated package named `grain` | fixed: every project `grain init` makes links it from the checkout |
| A page-only app, start to finish (2026-10-20) | a fresh agent with the public SDK alone built and published a tic-tac-toe page on the test network in 14 minutes, and met: the simulator could not open the page once `grain publish` had sealed it; a second `grain publish` with nothing changed raised the version and sent a transaction; `grain status` sent a page to `grain pair`, exit 1; the way without a phone was scattered; `owner.key` signed a free slug whenever it existed; an app registered from it was public at once; `npm install` missing from a step; placeholder links passing lint; ~100 lines of its own to drive the simulator headless; no icon without a picture; help cut mid-sentence; the init line calling the public key the key; `grain show` printing `null` and exit 1 for a free slug; a fee without its unit; lint saying "ready to register" after publishing; commands missing from the steps' log; npm 11's warnings; a link to a manifest a sealed page has not; a quick path buried under server topics | fixed (see [the SDK's decisions](agents/sdk.md#decisions)): `devPageUrl`; nothing changed, nothing sent; `not_needed`; *No phone, test network* and `grain doctor`'s deposit; the owner's Saltix unless `--key`, the owner said first; registered private; `grain dev --check`; `grain icon --monogram`; `--sign-in`; the quick path in AGENTS.md and the README |
| A private page-only app, round two (2026-10-20) | a fresh agent with the public SDK alone built a units converter, published it private with no phone, updated it and published again with nothing changed, with no error in 13.5 minutes, and met: a first `grain publish --key` of two transactions one after the other (about 80 s, then 155 s) saying only "waiting for it to land…", beside a README that promised 3 minutes at most, so a tool's 2-minute timeout would cut it; the app public between the two; `grain lint` passing `grain init`'s counter words in `connect.json`; `grain dev --check` warning of a long page's button at the fold; "Saltix opens it from the Apps section" for an app nobody could open; the Connect preview saying a hosted app's code may change, and lint's placeholder warning, on a page that would be sealed; the steps' log without `grain profile`'s registry step, an icon's refusal reason, `doctor`'s reason or `grain dev`'s end; docs saying "and a fee" doctor did not show, a profile doctor did not check before registration, `--key` rules told three ways; a pairing hint on a publish with no phone; the way without a phone in five places; `grain show`'s JSON first; a pale ground for a dark mark that vanished on the light theme; a thin monogram; `permissions` explained nowhere near it | fixed (see [the SDK's decisions](agents/sdk.md#decisions)): `SetGrainAccess` right behind `RegisterGrain` with the next nonce, waited for together and said as it goes (`wait.ts`), times stated, resumed and never sent twice (`sent`, `private_pending`), doctor's **public, but should be private**; `connect-template`; the navigation bar judged by fixed or sticky and the scroll's end; who opens the app; sealed from `grain init`; the log as documented; doctor's fees and `connect.json` check; one canonical *No phone, test network*; `grain show --json`; grounds apart from both themes; a bold monogram; `permissions` in each project's README and AGENTS.md |
| A private notes page, round three (2026-10-20) | a fresh agent with the public SDK alone published a private notes page with no phone (`--no-wait`), set its profile and access, updated it and published again, and met: `grain doctor` saying "published: the network holds its bundle" and naming `grain profile` next while nothing was uploaded (a relay's `fetching` read as held); doctor exiting 1 while a transaction was only on its way, logged `refused`, and never saying it landed; `grain access` sending a transaction that changed nothing; doctor's "its owner alone open it" for an app nobody could open; `next: nothing` with `public/` changed; `--no-wait` saying "this command waits for it"; a fee estimate without the relays' sources; publish's "its owner's account and members open it" before "nobody opens it"; two pages telling where a bundle goes two ways; `grain dev --check` never tapping a button | fixed (see [the SDK's decisions](agents/sdk.md#decisions)): `published` only with the bytes held or seen taken (`inNetwork`); exit statuses 0, 1, 75 and `wait` lines; every key file's transaction followed until it lands, said when it has; nothing to change, nothing sent, for every owner's call; who opens it in publish's words; a change not published is `grain publish`; the fees of the manifest as sent; *Where the bundle goes* once; `grain dev --check --tap`; a published app private by default in Saltix 0.1.61 |

## The roadmap

| # | What | Why | Effort | Depends on |
|---|---|---|---|---|
| 1 | **A local loop for your own chat** | Today a chat can be tried only on the test network, after making the app in Saltix | M | the simulator in `grain dev` (`feat/app-home`) |
| 2 | **A test harness for chat commands** | Agents write tests first; today they cannot without the SDK's private helpers | S–M | — |
| 3 | **The SDK as versioned packages** | Nobody outside can install it; the in-house app vendors `dist/` | M | the owner: public or not |
| 4 | **The command line without a node** | No macOS node, no public plain-HTTP node: `--node` blocks every registry command | M | — |
| 5 | **A spec changed under its version is refused** | It silently reaches nobody | S | — |
| 6 | **Bundles hosted without your own server** (done) | A sealed screen needed an https host | L | protocol: named blobs (32-images) |
| 7 | **Bundle bytes independent of zlib** | The same files may make another hash on another Node | S | a version bump for published bundles |
| 8 | **One command to deploy the server** | Every app rebuilds the systemd unit, credentials and restart rules | M | 3 |
| 9 | **Payments for apps made in Saltix** (done) | A developer key could not sign invoices | S (SDK) + M (Saltix) | decided: invoices to the owner |
| 10 | **An app doctor** (started: `grain doctor`) | "Why does my app not answer?" has eight possible answers today | M | 4 |
| 11 | **Typed handlers from the spec** | A number argument is a `bigint`, a flag may be missing: found at run time | S–M | — |
| 12 | **A payments sandbox and a funded key** | Invoices and `findPayment` need a node and test SALT | M | 4; macOS nodes for a local devnet |
| 13 | **Logs and state that are right by default** | A server without `log` is silent; without `store` it forgets on restart | S | — |
| 14 | **Spec versioning and migration** | Removing a command breaks `run` buttons on old cards | M | 5 |
| 15 | **A key rotation guide and tool** (a paired key: `grain pair --new`) | Replacing a key stops the server; there is a way without a gap, undocumented | S (guide) / M (tool) | 4 |
| 16 | **Templates by app type** | A sealed screen beside a chat, paid actions, notifications: each rebuilt by hand | M each | 2, 6 |
| 17 | **Docs checked against the code** | Docs drifted (port, network kind, commands) | S | — |
| 18 | **A CI workflow in every project** | `npm test`, `grain lint`, the spec's lint and the bundle's hash on every push | S | 2, 7 |
| 19 | **Pairing by QR code and the steps' log** (done in the SDK; Saltix's sheet follows) | No key is copied; a session's steps can be read back | M | Saltix: the pairing sheet (24-app-studio §3a) |

### 1. A local loop for your own chat

`npm run dev` runs a development relay and registry in one process (`scripts/dev.mjs`, `scripts/dev-relay.mjs`), but
for `examples/hello-grain` only: its slug, its keys and its chat are hard-coded. A developer's own chat runs only on the
test network, after **New app** in Saltix and with the developer key, and is seen only in a phone.

- `grain dev` in a chat project: makes a development key for the project's slug (never a real one), serves the
  development relay and a registry that names it, starts `server.mjs` (or the command given) with `SALTIX_APP_KEY` and
  `NODE_RPC` pointing at them, and opens the simulator's chat pane on it; restarts the server when its files change.
- The development relay and registry move from `scripts/` into the SDK (`@saltix/grain-server/dev`), so the command
  line and tests use them.
- **Effort** M. **Depends on** the simulator served by `grain dev` itself (`/_simulator/`, `feat/app-home`).

### 2. A test harness for chat commands

Testing one command end to end today (done in the walk): start a development relay imported by path from the SDK's
`scripts/`, fake a node's `node_status`, `grain_get`, `account_get` and `relay_list`, connect a `RelayClient` with a
messaging key derived under `"Saltix grain messaging key v1"`, sign a request with its arguments as Borsh-shaped pairs
sorted by name, decode the frame, find the block. About 50 lines, and every one is something an agent has to guess.

```ts
import { testChat } from "@saltix/grain-server/testing";
const t = await testChat({ spec: new URL("../chat.json", import.meta.url), setup: handlers });
const reply = await t.ask("plan", { minutes: 30n, level: "hard" }, { lang: "ru" });
assert.equal(reply.fields.Sets, "6");                            // checked as a wallet checks it
await t.as("owner").ask("stats");                                // the owner's member proof
await t.close();
```

(As built; the walk proposed `card.fields()` and `t.asMember(…)`.)

- Exports what `packages/server/test/chat-helpers.mjs` already has (the fake chain, the wallet), with arguments typed by
  the spec, the card checked by `chatMessageProblem`, and helpers for members, the team, `working` and files.
- `grain init --chat` then writes a test of its `hello` command.
- **Built** (2026-10-16): `testChat` (`@saltix/grain-server/testing`) with strangers, the owner and named members
  (proofs), `say`, `hello`, `unasked`, replies read and checked as a wallet checks them; the development relay and a
  registry of one grain moved into the SDK (`@saltix/grain-server/dev`); `grain init --chat` writes `chat.mjs` (the
  handlers) and `test/chat.test.mjs`, run by `npm test`.
- **Effort** S–M.

### 3. The SDK as versioned packages

The packages are not on npm. The repository is public since 2026-10-19 (the protocol's own stays private until the
main network launches, so the SDK carries its account of the protocol in `docs/protocol/`). A project outside the
checkout installs the packages by path (`npm install <checkout>/packages/server`), so it breaks when the checkout moves,
and the program that runs Saltix's own apps vendors the built `dist/` with a sync script. Every package is version
0.1.0.

- Release the three packages with versions (semver: a format change is a major version while 0.x is the minor), each
  release's CHANGELOG section, and a tag. Where: npm under `@saltix` if the SDK may be public; otherwise tarballs at
  download.saltix.io with `SHA256SUMS` (`npm install https://download.saltix.io/sdk/saltix-grain-server-0.2.0.tgz`), or
  GitHub Packages.
- `grain init` already writes the dependency as `^<version>` when the tool itself came from a registry (#20).
- `ChatServer` logs the SDK's version at start; error reports name it.
- **Effort** M (a CI release job). **Depends on** the owner's decision of where to publish them.

### 4. The command line without a node

`grain show`, `publish` (its QR code too: it quotes the deposit and watches the registry), `configure`, `access`,
`bind`, `rate`, `retire`, `sponsor` and `app-key make` need `--node`, a node's interface over plain HTTP. The node is
published for Linux x86-64 only, and the test network's nodes are not reachable that way, so a developer on a Mac needs a
Linux server and an SSH tunnel. Yet every relay serves the wallet interface at `POST /rpc` (Saltix 09-relay §10.7),
`transaction_submit`, `faucet_request`, `grain_get` and `handle_get` included, and `ChatServer` and `grain app-key`
already use the network's public relays (`RelayGateways`, pinned by their certificates).

- Every command takes the network instead (`--network devnet`, the default while the test network is the only one with
  public relays, or the developer key's), and `--node` stays for your own node.
- `grain faucet --key owner.key`: test SALT for a key file's account (`faucet_request`).
- **Effort** M (`registry.ts`, `studio.ts`, `sponsor.ts` take a `WalletInterface` instead of a URL).
- **Built** (2026-10-16): every command reaches the network through `--network` (devnet by default), `--relay
  URL#sha256` or `--node`; the SDK's reads take a node's URL or any wallet interface (`NodeLike`); `RelayGateways` asks
  `relay_list` when the relays it knows cannot answer and passes over a node with no faucet; `grain faucet [--wait]`.
  Checked live: `grain show` and `grain faucet --wait` for a throwaway key on the test network.

### 5. A spec changed under its version is refused

Saltix takes a spec only when its version is higher than the one it holds (`AppChats.newer`), so a `chat.json` changed
without raising `version` reaches nobody who has the old one, and the server starts and answers as if all were well.
Saltix's access grain (since retired) had built its own guard (`checkServed`: the spec's hash kept per version, a
change under the same version refused at start).

- `ChatServer` keeps the hash of the spec it served for each version in its `ChatStore` and refuses to start
  (`chat_spec_changed_under_version`) when the spec differs under the same version; `grain chat-spec` lints it too.
- **Effort** S. 22-grain-chats §2 says a wallet takes a version "at least" the one it holds, Saltix only a higher one:
  one of the two should change (see "For the owner" below).
- **Built** (2026-10-16): the spec says "higher" (the protocol's pull request 222); `ChatServer` keeps the highest spec served in its
  store and refuses one changed under it or below it (`ChatSpecVersionError`), the template's server exits with 78
  (`setupCannotWork`). `grain chat-spec` does not read a server's store, so it does not lint this.

### 6. Bundles hosted without your own server

A sealed screen (`grain bundle`) names `sources`, https URLs where wallets download the ZIP. A developer needs a host;
Saltix's own apps use download.saltix.io, the owner's server. A relay's file store (09-relay §10.5) is close: anyone
holding a file's id downloads it, and `ChatServer.upload` already writes there. But a file lives 30 days, a relay's
certificate is self-signed (pinned through its record), and a manifest's sources must outlive it.

- Interim (M): `grain bundle --upload github` (a release asset) and documented hosts; the wallet downloads any https
  source and checks the hash, so the host needs no trust.
- Lasting (L, protocol): a public file kept while a live manifest names its hash, on the relays or the durable tier
  (10-storage), with sources such as `saltix-file:<relay record>/<id>` that wallets resolve through the relay list.
- **Depends on** a protocol decision for the lasting form.
- **Built** (2026-10-19, with the protocol's 32-images): the network keeps a sealed grain's bundle (16 MiB at most) as a
  named blob at its keepers, and `grain publish` puts it there from the developer's computer, in pieces of 256 KiB at a
  relay's gateway, resumed after a break and waiting out a busy node; with `grain pair`'s key before the owner signs (the
  network holds it pending for a day on the key's statement), without one once the registry names it. A sealed manifest
  needs no source from protocol version 2; before it `grain publish` names the network's own copies at up to 3 relays.
  Wallets fetch it from their own relay. `grain icon` makes the icon, which goes up once the registry names it.
  `grain doctor` says where a publish stands.

### 7. Bundle bytes independent of zlib

`grain bundle` deflates each file with Node's zlib at level 9 when that is smaller. The same files make the same bytes
only with the same zlib, and Node bundles its own (Chromium's), which changes between releases: a CI built on another
Node may produce another hash than the one the owner approved. Saltix's access grain stored every file uncompressed for
exactly this reason.

- Store (method 0), or deflate with a pinned pure-JS implementation; a test that the hash of a fixed tree is a constant,
  run on Node 20, 22 and 24 in CI.
- **Built** (2026-10-16): every file stored; the fixed tree's hash is pinned and matched by a ZIP built by hand from
  the format; CI runs it on Node 22, then 24 and 20.
- **Effort** S. Changes the bytes of every bundle: the next version of a published grain gets a new hash, which is
  expected.

### 8. One command to deploy the server

The template's server exits with 78 when its key cannot work (#20), so a supervisor can stop restarting it. Every app
still writes its own unit; Saltix's `saltix-app@.service` shows what a good one holds: the key as a systemd credential
(`LoadCredential`), never in the environment file; `DynamicUser`, `StateDirectory` for the chat store,
`RestartPreventExitStatus=78`, the hardening options.

- `grain deploy init` writes `deploy/` for the project (a systemd unit like Saltix's, a Dockerfile, the credential's
  path); `grain deploy --ssh host` copies the project, installs its dependencies, puts the key in place from
  `SALTIX_APP_KEY` or a file (never the command line) and starts it; `grain deploy --check` reads the journal for
  `ready`.
- **Effort** M. **Depends on** 3 (installing the SDK on the server).

### 9. Payments for apps made in Saltix

A registered server key signs chats and notifications but not invoices (12-grains §5.2): an invoice needs the owner key
or a key it certified. An app made in Saltix has its owner key on the phone (a managed account's is a P-256 device key),
and Saltix has no way to certify the server key, while `grain cert` needs the owner key as a file. So an app made in
Saltix cannot take a payment through an invoice at all.

- **Decided and built (2026-10-16)**: a registered key signs invoices whose `to` is the grain's owner, as the registry
  has it when the wallet checks (12-grains §5.2), so a stolen developer key cannot redirect money. Saltix's
  **Certify for payments** was rejected: one more owner action for no added safety. The SDK has `chat.invoice`,
  `chat.paymentOf` and `signInvoice` with an `AppKey` ([payments.md](payments.md)); Saltix takes such invoices from
  0.1.54.

### 10. An app doctor

"Why does my app not answer?" has many answers, each found today by reading logs: a malformed key, a key of a reset
network, a registry that does not name it, a key that is not the first one named, a private app without the member, a
spec version not above what wallets hold, a server not registered at any relay, numbers not reported, a bundle whose
hash does not match its sources, a certificate about to end.

- `grain doctor` (the developer key from `SALTIX_APP_KEY` or `--file`): checks each, through the public relays, and says
  what to do for each failure, in the order a newcomer meets them. A JSON form for agents.
- **Started** (2026-10-19): `grain doctor [--json]` checks the project, `.gitignore`, the key (`grain status`'s states),
  the key file's mode, `chat.json`'s version, `npm install`, the bundle's hash, what the registry holds and the Connect
  profile, and ends with the next step. Since 2026-10-20 it exits 0, 1 or 75 (nothing to do, something to do, only
  waiting for the network), follows every transaction a key file here sent until it lands, and calls a page published
  only once the network holds its bundle. Still to come: the key not first in the list, the relay registration, numbers
  reported, a certificate about to end.
- **Effort** M. **Depends on** 4.

### 11. Typed handlers from the spec

`ask.args` is a record of unions: a number argument is a `bigint` (a first handler does `Number(...)` or concatenates a
string), an optional one may be missing, a choice is any string. `grain chat-spec --types` writes `chat.d.ts` from
`chat.json`, and `chat.command` takes the command's argument type, so a handler that does not fit the spec fails to
compile; `run` actions' arguments are typed the same way.

- **Effort** S–M.

### 12. A payments sandbox and a funded key

The simulator makes no payment (it answers a made-up id), and `findPayment` needs a node. With 4: `grain faucet` for a
key file; `grain pay --invoice <hex> --key payer.key`, which pays an invoice as a wallet would, on the test network; the
development registry of 1 records payments so `findPayment` finds them locally. A local devnet (`saltix-node devnet`)
needs node builds for macOS.

- **Effort** M. **Depends on** 4, and macOS node builds for a local devnet.

### 13. Logs and state that are right by default

`ChatServer.start` without `log` logs nothing, `chat_stopped` included; without `store` it keeps answered requests,
numbers and the team's addresses in memory, so a restart forgets where the team's consoles are. Both are fine in tests
and wrong in production.

- With a developer key and no `log`, log JSON lines to stderr (`log: false` for silence); with no `store`, warn
  `chat_store_memory` once.
- Forward warnings and errors of the SDK itself (a relay refusing numbers, uploads failing) to the console as a daily
  digest, within the team's budget.
- **Effort** S (defaults), M (digest).

### 14. Spec versioning and migration

- `grain chat-spec --diff <old>`: commands and parameters removed or narrowed, which break `run` buttons on cards users
  already hold; a deprecation pattern (a removed command's handler answers "this moved to …").
- **Effort** M. **Depends on** 5.

### 15. A key rotation guide and tool

Replacing the developer key in Saltix stops the server at the next block; requests wait in the old key's mailbox. Without
a gap: a registry names up to 4 keys and wallets write to the first, so start a second server with a new key named
second, then put it first, then drop the old one.

- A guide in `docs/chats.md`; `grain app-key rotate` does the three `ConfigureGrain` calls in order, waiting for each.
- **Effort** S (guide), M (tool). **Depends on** 4 for the tool.

### 16. Templates by app type

`grain init --template chat | page | screen | paid | notify`: a chat with a sealed screen beside it (the screen's
manifest proposed to the owner in the console when its bundle changes, as Saltix Pass does), paid actions
(with 9), notifications. Each with its test (2) and its deploy (8).

- **Effort** M each. **Depends on** 2, 6.

### 17. Docs checked against the code

The walk found a wrong port, a wrong network kind and missing commands. `docs.test.mjs` (#23) and the help's own test
(#18) hold a few facts; a `check-docs` step like Saltix's (links, backticked paths and commands, every CLI flag the docs
name taken by the command) would hold them all.

- **Effort** S.

### 18. A CI workflow in every project

`grain init` writes `.github/workflows/ci.yml`: `npm test`, `grain lint`, `grain chat-spec` (lint only), and the bundle's
hash compared with `grain.json`'s.

- **Effort** S. **Depends on** 2, 7.

## The steps' log

Every `grain` command run in an app's project (a directory with `grain.json`, `chat.json`, `app.key` or `.grain/`)
appends its steps to `.grain/log.jsonl`, one JSON line each, so that a session can be read back: where a developer (or
their agent) got stuck, how long the pairing took, which refusal came first. It stays on the computer; attach it to a
report about the tools. `SALTIX_GRAIN_LOG=off` turns it off; past 1 MiB it moves to `log.1.jsonl`.

```json
{"at":"2026-10-19T12:00:03.120Z","tool":"0.1.0","run":"9f2c01ab","command":"pair","step":"request","outcome":"ok","reason":"accepted","ms":41250,"network":"devnet"}
```

- `run` ties the lines of one command together; `ms` counts from its start; `network` is the network's kind once the
  command reached one.
- **Never in it:** a key, an address, an account, a slug, a path, an argument, a name or anything typed. `step` and
  `reason` are codes (`[a-z][a-z0-9_]*`, at most 48 characters); anything else is written as `other` before it reaches
  the file (`devlog.ts`).
- `outcome`: `ok`, `waiting`, `refused`, `failed` or `timeout`.

| Step | Reasons |
|---|---|
| `init` | `chat`, `page`, `page_sign_in`: the project made |
| `rotate` | `asked` (`--new`), or why `app.key` stopped working: `revoked`, `replaced`, `retired`, `unregistered`, `other_network` |
| `paired_already` | `app.key` is named: nothing to do |
| `key_made`, `key_reused` | a new key in `.grain/pair.key`, or the one an earlier offer made |
| `offer_made`, `offer_shown_again` | a new offer, or the one still living |
| `offer` | `no_wait` (`--no-wait`: shown, not waited for); `offer_expired` (timeout: nobody asked in 30 minutes) |
| `relay` | `ok`, or `network_unreachable`: no relay took the key's registration |
| `request` | the answer to a request: `accepted`, `used`, `expired`, `unknown`, `other_app`, `not_owner`; a frame that was not a request: `frame_not_pairing`, `frame_malformed`, `frame_slug`, `frame_unread` |
| `registry` | timeout: `answered_not_named` (Saltix was answered, its transaction has not named the key: a managed owner's delay, a cancelled PIN) or `not_asked` |
| `paired` | `app.key` and `app.json` written |
| `status` | the state: `paired`, `not_needed` (a page alone), `pairing`, `unpaired`, `revoked`, `replaced`, `retired`, `unregistered`, `other_network`, `invalid`, `unknown` |
| `doctor` | `done` (`ok`) when nothing is left (exit 0); `refused` with the first thing to do (exit 1): `project`, `git`, `key`, `key_file`, `app`, `chat_spec`, `dependencies`, `registry` (a page's slug free: the deposit, the fees, the way to it; grain.json changed since the registry's version; a key file's transaction that can land no more), `bundle` (`public/` changed since), `upload` (not in the network: never a relay's `fetching` alone), `published`, `access` (public, but should be private), `icon`, `connect_profile`; `waiting` with the first thing waited for when nothing is to do but wait for the network (exit 75): `registry`, `upload`, `access`, `connect_profile` (a transaction a key file here sent, on its way) |
| `serve` | `grain dev` serves: `sealed` (a new project's form), `page` (an older `grain init`'s placeholder origin), `hosted` |
| `check` | `grain dev --check`: `clean`, `warnings`, or the first error's kind (`controls`, `page_error`, `open`, `connect_sheet`, `layout`, `tap`: with `--tap`, a tap after which the page threw or asked for what Saltix refuses); `refused` with `no_browser`; `waiting` with `no_sandbox`; `failed` with `browser` |
| `lint` | `clean`, `warnings`, `errors` |
| `icon` | `made`, `checked`, `monogram`; `refused` with why: the image check's reason (`alpha`, `dimensions`, `depth`, `metadata`, `animation`, `format`…), `hash` (not the icon `grain.json` names), `decode`, or what `grain icon` could not make (`empty`, `size`, `monogram`) |
| `grant`, `wait` | `grain faucet`: `sent` (or `refused` with the reason), then `landed` or `not_landed` |
| `signer` | who signs an owner's call: `key_named`, `key_owns`, `wallet_asked`, `wallet_no_key`, `wallet_free`, `wallet_not_owner` |
| `doctor_publish` | where a page's publish stands: `not_uploaded`, `pending`, `waiting_for_owner`, `pending_expired`, `published` (the registry names the version and the network holds its bundle) |
| `network` | `grain publish` reached the network: `protocol_<n>`, the protocol version it runs |
| `bundle` | `built`; failures end the command (`bundle_no_public`, `bundle_refused`, `bundle_too_large`) |
| `sources` | the manifest's sources: `network` (protocol version 2: none), `relays` (before it: the network's own copies), `own` (the developer's hosts) |
| `version` | `raised`: the registry held this version or above, so the next one is published |
| `upload` | `pending` (held on the server key's statement), `named` (the registry names it), `held` (the network had it); `waiting` with `offset` (resumed), `busy`, `rate_limited`, `unreachable`, `not_named` (the node a block behind), or `after_registry_<why>` (no key vouches: `unpaired`, `revoked`, `replaced`, `other_network`, `other_app`, `unregistered`, `invalid`); `refused` with the node's reason (`kind`, `not_named`, `size`, `format`, `method`, `files`, `name`, `unpacked`, `hash`, `slug`, `key`, `time`, `signature`, `busy`, `pending`, `full`, `store`, `rate_limited`) or the SDK's (`check`, `stuck`, `unreachable`) |
| `sign` | `key_file`: signed with `owner.key` here (publish, profile) |
| `access` | after a registration: `waiting` with `sent` (`SetGrainAccess` private sent right behind it, or again by a later run) or `after_registry` (the pool took no nonce ahead: sent once the registration landed); `ok` with `private` once the registry says so, `wallet` (a publishing link's first version: Saltix 0.1.61 and later make it private unless the owner switched on Public in the Marketplace, an older one leaves it public); `timeout` with `not_landed` when it is still public at the end of the wait (`grain doctor` says so, the next `grain publish` sends it again) |
| `link` | `shown`: the publishing link's QR code is shown (`waiting`) |
| `registry` (publish) | `published`, `published_before` (the registry holds this content already); `waiting` with `no_wait` (the QR code shown, or a key file's transactions in the pool) or `earlier` (a transaction an earlier run sent, waited for rather than sent again); `timeout` with `not_signed` or `not_landed` |
| `registry` (show) | `registered`, `free`, `retired` |
| `registry` (an owner's call: profile, access, configure, bind, retire, rate) | `set` once the registry holds it; `unchanged` when it holds already what the call would make (nothing signed or sent); `timeout` with `not_landed` (a key file's) or `not_signed` (the owner's Saltix); `waiting` with `no_wait`, or `unknown` (the node cannot say where the transaction is) |
| `profile` | `refused` before anything is signed: `connect_template` (`connect.json` still holds `grain init`'s words), `placeholder_link` |
| `icon` | `uploaded`, `held`, `none` (the manifest names no icon); `refused` with `file_missing` or the node's reason |
| `published` | the publish is done: `sealed`, `hosted` or `chat`; `unchanged` when nothing was signed, sent or uploaded |
| `end` | the exit: `ok` (with `sigint` or `sigterm` for `grain dev` stopped while it served), `waiting` with `exit_75` (`grain doctor` while it only waits for the network), or `failed` with `usage`, `app_key_<problem>` (`not_app_key`, `unknown_network`, `malformed`, `bad_slug`), `pairing_<problem>`, a server setup code (`chat_unpaired`, `chat_key_exposed`, …), `<step>_<reason>` of a publish that stopped (`upload_busy`, `form_hosted_entry`, `sign_no_salt`, `key_key_file_mode`, …), `icon_<reason>`, `node_refused`, `network_unreachable`, `fs_<code>`, `sigint` or `sigterm` (a run cut short: Ctrl-C, a tool's timeout), `exit_<n>` or `error` |

## For the owner: what needs the protocol or Saltix

- **The spec's version rule** (decided): 22-grain-chats §2 now says a wallet replaces a spec only with a higher
  version (the protocol's pull request 222), as Saltix does; the SDK's guard of 5 holds a server to it.
- **Long-lived public files for bundles** (6): a file class on relays or the durable tier kept while a live manifest
  names it (09-relay §10.5, 10-storage, 12-grains §8).
- **Node builds for macOS** (12): a local devnet on a developer's own computer.
- **Saltix's developer pages** (saltix.io/developers): rewritten to what exists (the studio and the developer key, the
  console, the home and the capsule rule, payments with a developer key).
- **Distribution** (3, decided 2026-10-19): the SDK and its docs are public, the protocol's specifications are not
  until the main network launches; `docs/protocol/` holds what apps need of them. Where the packages are published is
  still open.
