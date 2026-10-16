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
| Tests | testing one command end to end took 50 lines, imports by path into the checkout and wire details (the messaging key's domain, arguments typed and sorted) | roadmap 2 |
| SDK | not on npm, the repository private; Saltix's own app vendors `dist/` | roadmap 3 |
| `--node` | every registry command needs a node's plain-HTTP interface; the node is published for Linux x86-64 only; the test network's nodes are not reachable that way | roadmap 4 |
| Spec changes | a `chat.json` changed under the same version starts fine and reaches nobody | roadmap 5 |
| Bundles | a sealed screen needs an https host of your own; `grain bundle`'s bytes depend on Node's zlib | roadmap 6, 7 |
| Payments | a server running from a developer key could not sign invoices | done: it signs invoices to the owner (`chat.invoice`, [payments.md](payments.md)) |
| Logs | `ChatServer` logs nothing unless given `log`, and keeps its state in memory unless given a store | roadmap 13 |

## The roadmap

| # | What | Why | Effort | Depends on |
|---|---|---|---|---|
| 1 | **A local loop for your own chat** | Today a chat can be tried only on the test network, after making the app in Saltix | M | the simulator in `grain dev` (`feat/app-home`) |
| 2 | **A test harness for chat commands** | Agents write tests first; today they cannot without the SDK's private helpers | S–M | — |
| 3 | **The SDK as versioned packages** | Nobody outside can install it; the in-house app vendors `dist/` | M | the owner: public or not |
| 4 | **The command line without a node** | No macOS node, no public plain-HTTP node: `--node` blocks every registry command | M | — |
| 5 | **A spec changed under its version is refused** | It silently reaches nobody | S | — |
| 6 | **Bundles hosted without your own server** | A sealed screen needs an https host today | M (interim) / L | protocol: long-lived public files |
| 7 | **Bundle bytes independent of zlib** | The same files may make another hash on another Node | S | a version bump for published bundles |
| 8 | **One command to deploy the server** | Every app rebuilds the systemd unit, credentials and restart rules | M | 3 |
| 9 | **Payments for apps made in Saltix** (done) | A developer key could not sign invoices | S (SDK) + M (Saltix) | decided: invoices to the owner |
| 10 | **An app doctor** | "Why does my app not answer?" has eight possible answers today | M | 4 |
| 11 | **Typed handlers from the spec** | A number argument is a `bigint`, a flag may be missing: found at run time | S–M | — |
| 12 | **A payments sandbox and a funded key** | Invoices and `findPayment` need a node and test SALT | M | 4; macOS nodes for a local devnet |
| 13 | **Logs and state that are right by default** | A server without `log` is silent; without `store` it forgets on restart | S | — |
| 14 | **Spec versioning and migration** | Removing a command breaks `run` buttons on old cards | M | 5 |
| 15 | **A key rotation guide and tool** | Replacing a key stops the server; there is a way without a gap, undocumented | S (guide) / M (tool) | 4 |
| 16 | **Templates by app type** | A sealed screen beside a chat, paid actions, notifications: each rebuilt by hand | M each | 2, 6 |
| 17 | **Docs checked against the code** | Docs drifted (port, network kind, commands) | S | — |
| 18 | **A CI workflow in every project** | `npm test`, `grain lint`, the spec's lint and the bundle's hash on every push | S | 2, 7 |

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
const t = await testChat({ spec: "chat.json", setup: (chat) => registerHandlers(chat) });
const card = await t.ask("plan", { minutes: 30n, level: "hard" }, { lang: "ru" });
assert.deepEqual(card.fields(), { Minutes: "30", Sets: "6" });   // checked as a wallet checks it
await t.asMember("owner").ask("stats");                          // a member's proof, a private app
await t.close();
```

- Exports what `packages/server/test/chat-helpers.mjs` already has (the fake chain, the wallet), with arguments typed by
  the spec, the card checked by `chatMessageProblem`, and helpers for members, the team, `working` and files.
- `grain init --chat` then writes a test of its `hello` command.
- **Effort** S–M.

### 3. The SDK as versioned packages

The packages are not on npm and the repository is private; Saltix's site says the kit "is shared on request". A project
outside the checkout installs it by path (`npm install <checkout>/packages/server`), so it breaks when the checkout moves,
and Saltix's own access grain vendors the built `dist/` with a sync script. Every package is version 0.1.0.

- Release the three packages with versions (semver: a format change is a major version while 0.x is the minor), each
  release's CHANGELOG section, and a tag. Where: npm under `@saltix` if the SDK may be public; otherwise tarballs at
  download.saltix.io with `SHA256SUMS` (`npm install https://download.saltix.io/sdk/saltix-grain-server-0.2.0.tgz`), or
  GitHub Packages.
- `grain init` already writes the dependency as `^<version>` when the tool itself came from a registry (#20).
- `ChatServer` logs the SDK's version at start; error reports name it.
- **Effort** M (a CI release job). **Depends on** the owner's decision: public or not.

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

### 5. A spec changed under its version is refused

Saltix takes a spec only when its version is higher than the one it holds (`AppChats.newer`), so a `chat.json` changed
without raising `version` reaches nobody who has the old one, and the server starts and answers as if all were well.
Saltix's access grain built its own guard (`checkServed`: the spec's hash kept per version, a change under the same
version refused at start).

- `ChatServer` keeps the hash of the spec it served for each version in its `ChatStore` and refuses to start
  (`chat_spec_changed_under_version`) when the spec differs under the same version; `grain chat-spec` lints it too.
- **Effort** S. 22-grain-chats §2 says a wallet takes a version "at least" the one it holds, Saltix only a higher one:
  one of the two should change (see "For the owner" below).

### 6. Bundles hosted without your own server

A sealed screen (`grain bundle`) names `sources`, https URLs where wallets download the ZIP. A developer needs a host;
Saltix's access grain uses download.saltix.io, the owner's server. A relay's file store (09-relay §10.5) is close: anyone
holding a file's id downloads it, and `ChatServer.upload` already writes there. But a file lives 30 days, a relay's
certificate is self-signed (pinned through its record), and a manifest's sources must outlive it.

- Interim (M): `grain bundle --upload github` (a release asset) and documented hosts; the wallet downloads any https
  source and checks the hash, so the host needs no trust.
- Lasting (L, protocol): a public file kept while a live manifest names its hash, on the relays or the durable tier
  (10-storage), with sources such as `saltix-file:<relay record>/<id>` that wallets resolve through the relay list.
- **Depends on** a protocol decision for the lasting form.

### 7. Bundle bytes independent of zlib

`grain bundle` deflates each file with Node's zlib at level 9 when that is smaller. The same files make the same bytes
only with the same zlib, and Node bundles its own (Chromium's), which changes between releases: a CI built on another
Node may produce another hash than the one the owner approved. Saltix's access grain stores every file uncompressed for
exactly this reason.

- Store (method 0), or deflate with a pinned pure-JS implementation; a test that the hash of a fixed tree is a constant,
  run on Node 20, 22 and 24 in CI.
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
  `chat.paymentOf` and `signInvoice` with an `AppKey` ([payments.md](payments.md)); Saltix takes such invoices from its
  release after 0.1.53.

### 10. An app doctor

"Why does my app not answer?" has many answers, each found today by reading logs: a malformed key, a key of a reset
network, a registry that does not name it, a key that is not the first one named, a private app without the member, a
spec version not above what wallets hold, a server not registered at any relay, numbers not reported, a bundle whose
hash does not match its sources, a certificate about to end.

- `grain doctor` (the developer key from `SALTIX_APP_KEY` or `--file`): checks each, through the public relays, and says
  what to do for each failure, in the order a newcomer meets them. A JSON form for agents.
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
manifest proposed to the owner in the console when its bundle changes, as Saltix's access grain does), paid actions
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

## For the owner: what needs the protocol or Saltix

- **The spec's version rule**: 22-grain-chats §2 says a wallet takes a spec whose version is at least the one it holds;
  Saltix takes only a higher one. Either the spec says "higher", or Saltix takes an equal one (which lets a changed spec
  under the same version through: the stricter rule with the SDK's guard of 5 is safer).
- **Long-lived public files for bundles** (6): a file class on relays or the durable tier kept while a live manifest
  names it (09-relay §10.5, 10-storage, 12-grains §8).
- **Node builds for macOS** (12): a local devnet on a developer's own computer.
- **Saltix's developer pages** (saltix.io/developers, in saltix-wallet's `site/`): they still say the app studio and the
  developer key are "being built", that a handler's error goes "to your log only" (it reaches the console), and that the
  kit is shared on request.
- **Distribution** (3): whether the SDK and its docs may be public.
