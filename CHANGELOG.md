# Changelog

## [Unreleased]

### Added

- **The card design standard** (Saltix 22-grain-chats §4, §5a; vectors synced from corvise/saltix#221): `card().code(text)`
  and `card().poll(question, command, options, {chosen, closed, tally})` (blocks 6 and 7, typed by the spec when sent:
  `Card.typedBlocks`), `ask.update(card)` to answer a tap in place of the card tapped (a poll's new counts), the
  standard's rules (`cardLayout`, `isDestructive`, `pollLook`, `shares`, `perRow`, `isToken`, `isImage`, `isWide`,
  reproducing the vectors' `cards`), and its lint (`lintCard`, `assertCardStandard`, `CARD_LIMITS`; `ChatServer` logs
  `card_standard` once per rule broken). The simulator draws cards by the standard: the action bar under the capsule,
  emphasis, choices, polls, code, collapsed text, file tiles, and a tap's spinner and check; a `run` whose arguments
  fill its form sends at once (a right click opens the form). Guides: [docs/cards.md](docs/cards.md) and
  [docs/agents/cards.md](docs/agents/cards.md), linked from `AGENTS.md`; every `grain init` project's `AGENTS.md` gains
  a seventh rule, cards by the standard (`CARDS_GUIDE`, `assertCardStandard` in its tests). Saltix 0.1.53 and older drop
  a message with a code or poll block.
- **Payments from a developer key** (Saltix 12-grains §5.2, vectors synced from Saltix #223): a registered server key
  signs invoices whose `to` is the grain's owner, which wallets check against the registry. `ChatServer.invoice`
  signs one to the owner the registry names and refuses any other payee, a retired grain or an unknown record, before
  anything is signed; a card's `invoice` block takes its result. `ChatServer.paymentOf` finds the payment through the
  server's relays or node (only the invoice's asset and at least its amount). `signInvoice` takes an `AppKey` (its own
  grain and network, no certificate). `invoiceProblem` takes the grain's record and says `retired` and `payee` as
  wallets do. `findPayment` takes any wallet interface, `unitsOf` reads `"2.5"` SALT. Docs: `docs/payments.md`.
  Saltix 0.1.53 and older refuse such an invoice. `AGENTS.md`, every project's `AGENTS.md` (`grain init`: a sixth rule,
  money moves only in the wallet and only to the owner) and `docs/agents/app.md` say so.

### Changed

- **Breaking for chat clients**: the grain chat frames gain the team's hello and the server's welcome (Saltix
  22-grain-chats §3a; vectors synced from Saltix 2d0c4c9, a `hello` section). `ChatFrame` tag 4 is `hello`
  (`SignedChatHello`: `ChatHello {slug, id, at, member: SignedMemberProof, lang}`, signed by the user's grain key over
  `"Saltix grain chat hello v1"`), user to server only; tag 5 is `welcome` (`SignedChatWelcome`:
  `ChatWelcome {slug, hello, at}` with its `ServerKey`, signed over `"Saltix grain chat welcome v1"`), server to user
  only. A hello whose `lang` is out of form does not read. An older server drops a hello frame and acks it (harmless:
  the member is reached once they write, as before); a wallet needs this SDK, or the formats it follows, to take a
  welcome. `serverKeyHolds` and `chatCertHolds` take anything with `revoked` (`Revoking`), so a wallet that holds no spec
  yet checks a welcome with `{ revoked: [] }`.
- **Breaking for chat clients**: a chat request names the user's language (Saltix 22-grain-chats §3; vectors synced
  from Saltix f99df76). `ChatRequest` ends with `lang`: the language the user's Saltix shows (2–8 of `[a-z-]`, as
  the spec's maps name languages), or `""` when the app does not say. Handlers read it as `ask.lang` and answer in it
  when they can, else in English, so a stranger's refusal comes in one language. `decodeChatFrame` and
  `decodeSignedChatRequest` refuse any other value, `requestFitProblem` says `language` (`requestLangOk` checks one).
  The simulator sends the page's language. It joins the app studio's change below in the same release.
- `ChatKeyNotRegistered` and the `chat_stopped` hint say what to do for each reason: a new developer key when the owner
  revoked or replaced it (or run the server that holds the new one), a new app when the grain is retired, and for a
  grain the registry does not hold yet, wait for its registration to land. Every reason used to say "make a new
  developer key", which cannot help a retired or not yet registered grain.
- **Breaking for chat clients**: the grain chat formats of the app studio (Saltix 24-app-studio, 22-grain-chats;
  `vectors/grain-chats-v1.json` regenerated, synced from Saltix bc63456). `SignedChatMessage` names its key as
  `server: ServerKey` (`{certified: InvoiceKeyCert}` or `{registered: key}`) instead of `cert`; `SignedGrainChatSpec`
  gains `server` (null: the owner key; a key: a registered server key, every price 0); `ChatRequest` gains
  `member` after `text` (a private grain's `SignedMemberProof`, or null); `ChatFrame` gains `stats` and a spec frame's `cert` is
  optional. Old `SGC1` frames no longer decode either way. `chatMessageProblem` and `signedChatSpecProblem` take the
  registry's `servers` (`server_price` for a priced spec a server key signed); `signChatMessage` without a certificate
  signs as a registered key; `notificationProblem` takes `servers` too (notifications keep their encoding).
- `RegisterGrain` sends the deposit of the slug's length, as the node quotes it (`grainQuote`; 100 SALT for 3–5
  characters, 30 for 6–7, 10 for 8 or more), or 100 SALT to a node from before; `grain publish` and `grain show` say it.
- The chat's well-known document is `{spec, cert?, stats?}` (`chatDocumentOf(spec, cert?, stats?)`, `decodeChatDocument`).
- `rpc` throws an `RpcError` with the node's error code.
- `npm run dev` reads a node at `http://127.0.0.1:30334`, where a node's wallet interface listens by default (it read
  30734, where none does, so invoices and payments in the example failed with a local node). The README says which kind
  of network Saltix's test network is (devnet: `dsalt1…`, `network: "devnet"`; its examples said `testnet`), and where
  `--node` comes from: a node of your own or a tunnel to one, while the chat server and `grain app-key` need none.
  Tests hold the README to the help (every command shown), to the port and to the network's kind.

- `decodeInvoice` and the certificates in notifications refuse an asset tag other than 0 or 1 and a time beyond 2^53
  ms instead of reading them loosely; relay records' base64url no longer needs Node's `Buffer`, so the formats run in a
  browser.
- The protocol is Saltix (Saltix #165), and so are the SDKs: `@saltix/grain`, `@saltix/grain-server` and
  `@saltix/grain-cli` (called `@salarium/*` until 2026-10-12), in the repository corvise/saltix-grains. Every domain
  string the packages hash or sign under starts with `"Saltix "` (`"Saltix grain login v1"`,
  `"Saltix grain manifest v1"`, `"Saltix transaction v3"`, `"Saltix address v1"`, …); a hosted grain serves its
  manifest at `/.well-known/saltix-grain`; the page finds the wallet's provider at `window.saltix`, and the simulator's
  frame is `saltix-simulator`. Vectors synced from Saltix a4d1d83.
- A grain's manifest names its owner (Saltix 12-grains §2–3): `owner` (the account id) and `owner_key` (`{ ed25519 }`
  or `{ p256 }`, `DeviceKey`), which must speak for it; a managed account's phone signs with P-256 (`verifyByDeviceKey`:
  SHA-256, low s). `grain init` writes the key file's account and key; `lint`, `sign` and `publish --key` refuse a
  manifest that is not the key file's own; publish links zero both (`UNOWNED`). `invoiceProblem`,
  `notificationProblem` and `signerOf` take the owner key as a `DeviceKey`; the simulator takes either form. Vectors
  synced (a managed owner's manifest and a phone's server key certificate).
- A sponsor certificate's key carries its tag (Saltix 11-access §4.3: `sponsor` is a device key, so a managed
  account's phone can grant with P-256): `encodeSponsorCert` writes Ed25519's tag 0 before the key, `decodeSponsorCert`
  and `sponsorCertProblem` take only an Ed25519 sponsor, as a grain's server signs. Vectors synced from Saltix (with a
  phone's grant).
- Transaction v3 (Saltix 03-ledger §3, 13-accounts §6.1): `encodeTx`, `signTx` and every transaction built on them
  (grains' registry calls, a sponsor's channel) carry the sender's tag and the proof's, and their id is
  `"Saltix transaction v3"`; fees count the extra byte. Vectors synced from Saltix 602995e. Every package's tests
  exit when one fails instead of waiting on an open server.
- **`grain bundle` stores every file as it is** (ZIP method 0), never deflated: a bundle's bytes, and so the hash the
  owner signs, depend on its files only, not on the zlib inside the Node that made it (Node bundles its own, which
  changes between releases; Saltix's access grain stores its files for the same reason). A test pins the hash of a
  fixed tree, matched byte for byte by a ZIP built by hand from the format, and CI builds it again on Node 20 and 24.
  The next bundle of a published grain gets a new hash, as any new bundle does. Its files may come to 20 MiB at most
  (deflated, compressible ones could exceed that); a host may still compress the download on the wire.

### Fixed

- **The command line never runs a command it was asked about, and never ignores a flag** (`args.ts`): `--help` or
  `-h` anywhere (and `grain help <command>`) prints that command's part of the help and exits 0. Before, `grain init
  --help` made a grain with an owner key in the current directory, `grain dev --help` served forever and `grain publish
  --help` went on to publish. A switch no longer swallows the next word (`grain init --chat coach` made a hosted grain
  named after the current directory); a flag a command does not take is refused with the ones it takes (exit 2: a typo
  such as `--manifst` linted `grain.json`); `--name=value` works; an unknown command says so instead of printing the
  whole help; `grain --version`. A test holds every flag each command's help names to the ones it takes.
- **A private app publishes no numbers** (Saltix 22-grain-chats §4, 24-app-studio §6a; the owner's rule, 2026-10-16):
  while the registry says the grain is private, the chat server hands none to its relay (`RelayClient.clearStats()`
  forgets the kept ones, so none go again on registering) and leaves `stats` out of its well-known document; it logs
  `stats_not_reported {reason: "private"}` once per change, and `stats_resumed {reason: "public"}` when the grain is
  public again, handing the newest numbers over at once. The registry is read as before: every few minutes and at a
  request's new beacon block. Its members still get them in the chat. The nodes refuse a private grain's numbers
  (`private`) anyway.
- `grain dev` says a taken port in words (`port 8090 is taken …: pass --port`, exit 1) instead of dying with an
  unhandled `EADDRINUSE` and a stack (`npm run dev` takes 8090 too), and refuses a chat-only grain at once, instead of
  printing that it serves a `public/` that does not exist and answering every request with an error, forever.
- `npm run dev`: `/` redirects to the simulator's own path, so its page finds its script (it was not found at `/`).
- `npx grain` works after a fresh `npm ci` and `npm run build`: the package's command is `bin/grain.js`, a file in the
  repository that runs `dist/main.js`, so npm links it at install (it linked no command while `dist/` was missing, and
  `npx grain` said "could not determine executable to run" until a second `npm install`). Before the build it says to
  build. A project outside the checkout installs the tool with `npm install --save-dev <checkout>/packages/cli`.

### Added

- **The team's hello** (Saltix 22-grain-chats §3a): an account on the grain's team introduces itself to its own app
  without the user typing, so `proposeUpdate`, `notifyTeam` and error reports reach it before anyone writes.
  `ChatServer` takes a hello only from the team (the owner, developers 2, viewers 4; a user-only member is not on it):
  for its slug, from its key's address, signed, at most 5 minutes ahead and 7 days behind (`HELLO_LIFE_MS`), with a
  member proof checked against the registry and the account's keys exactly as a request's team proof is; it keeps the
  member's address and answers with a welcome naming the hello, signed as its messages are, at most once an hour per key
  (`WELCOME_EVERY_MS`: a hello within it is taken and not answered); anything else gets no answer at all and its frame
  is acked. At most `helloChecksPerMinute` hellos a minute (`HELLO_CHECKS_PER_MINUTE`, 30) reach the registry and the
  node, counting only those that pass every check needing neither. A hello runs no handler and counts in no number,
  budget or request memory. Under an expired certificate the address is kept and no welcome goes. Logged as
  `chat_hello_welcomed`, `chat_hello_repeated`, `chat_hello_dropped {reason}`, `chat_hello_unchecked`,
  `chat_hello_busy` and `chat_hello_unwelcomed`, never naming an account, a key or an address. The formats:
  `signChatHello`, `chatHelloProblem`, `helloTimely`, `introductionProblem` (the reference's `member::introduces`,
  `not_team`), `signChatWelcome`, `chatWelcomeProblem` (as a wallet checks one: `unasked` for another hello),
  `HELLO_RETRY_MS`. The simulator's chat pane says hello when the account is on the app's team and checks the welcome.
- **Full-screen pages** (Saltix 12-grains §5, §7, bridge version 3):
  - `@saltix/grain`: `grain.layout(onChange?)` returns `{safeArea, controls, source}` from `grain_info`, keeps it current
    on the `insets` event, window resizes and theme changes (one `grain_info` at a time), and sets
    `--saltix-safe-top|bottom|left|right` and `--saltix-controls-top|right|width|height` on `:root`. The fallbacks are
    decided in one place (`layoutOf`): Saltix bridge 3 or newer gives its values (a missing field 0, absent controls
    none); bridge 1–2 a safe area of 0 and no controls; a plain browser its own `env(safe-area-inset-*)` and no controls.
    `GrainInfo` gains `safe_area.left|right` and `controls`, `Events` the `insets` event; `controlsFor`, `CONTROLS_BOX`
    (96 × 48, 8 from the right inset, 4 below the top one), `cssVariables`, `LAYOUT_VARIABLES`.
  - `@saltix/grain`: `grain.manage.open({section?})` (`grain_manage_open`, bridge version 3): the app's own manage page
    in the wallet, at `"members"` (`MANAGE_SECTIONS`), from a tap, for the app's team; the simulator answers it.
  - The simulator shows the page full screen as Saltix does: under a status bar (32) and a navigation bar (24), with the
    translucent `⋯ | ✕` on a blur where `controls` says, contrasting with the page's `grain_setHeader` colour or its
    theme; ✕ closes, Back goes through the page's history then closes, ⋯ shows a mock of the wallet's sheet; a loading
    screen until `grain_ready`; `grain_info` answers bridge 3; *Size* switches between a phone and the Galaxy Z Fold's
    475×751, 704×932 and 932×704 and sends `insets`. `?manifest=<url>` loads a manifest and opens its page.
  - `grain dev` serves the same simulator at `/_simulator/` (built into the command line's package) and prints its
    address.
  - `grain init`'s page lays out edge to edge by the variables, its top bar level with the controls and clear of them;
    every project (`--chat` too) gets `AGENTS.md`, the rules a coding agent follows, and `CLAUDE.md`, which points to it.
    `AGENTS.md` links the SDK's docs/agents/app.md (`APP_GUIDE`) and states, besides the full-screen rules, the five
    every app follows (`appRules`), worded as that guide and `server.mjs` have them: the developer key from the
    environment or a file, never logged; `chat.json`'s version raised with every change; the unasked budget (10 a day to
    a user, 100 to the team, `ChatBudgetSpent` past it); state in `STATE_DIRECTORY`; exit 78 when the key cannot work.
    A test holds the three together.
  - `grain lint` warns (`full-screen-top-bar`) when a page in `public/` has a fixed or sticky top bar (`top: 0` or a few
    pixels, `inset`, or the classes `fixed|sticky top-0`) but no page, stylesheet or script of the app's own uses
    `--saltix-safe-*`, `--saltix-controls-*` or `env(safe-area-inset-top)`.
  - `AGENTS.md` (linking docs/agents/app.md and docs/agents/sdk.md) and `CLAUDE.md` (`@AGENTS.md`,
    `@docs/agents/sdk.md`) at the repository's root, "Designing for Saltix" in docs/first-app.md, the SDK's map in
    docs/agents/sdk.md, and the example grain laid out full screen.
- **Updates the owner approves in the console** (Saltix 22-grain-chats §4, 12-grains §10; vectors synced from the
  protocol PR): the card action `publish` (`Card.publish(label, manifest | link)`, tag 3) carries the manifest's text
  as a publishing link does, and `ChatServer.proposeUpdate(manifest | link, { text?, label?, roles? })` sends it to the
  team in the console, refusing another grain's manifest or a version the registry holds, and says whether the owner
  got it (`owner`; logged as `chat_update_proposed`); `ChatServer.registered(fresh?)` reads what the registry holds for the
  grain. `chatMessageBoundsProblem` refuses a `publish` of another grain
  (`slug`), two of them, or a text out of form (`bounds:action`); `proposedManifest` and `teamOnly` read it.
  `readPublishText`, `readPublishLink` and `decodeManifest` read the link's form strictly in any runtime (a raw DEFLATE
  decoder of our own, `inflate.ts`, so the simulator runs it too); `publishText` and `publishLink` (with `UNOWNED`)
  moved here from the command line. The simulator says what the owner's Saltix offers. Breaking for chat clients that
  refuse unknown action tags: Saltix 0.1.51 and older drop such a card.

- `docs/devex.md`: what building an app is like today, from a walk through the whole journey (developer key, `grain
  init`, a chat, tests, a screen, a bundle, publishing, the server, its numbers, errors, payments, updates, logs), what
  was fixed on the way, and a roadmap of 18 items in order with why, effort and dependencies, and what needs the
  protocol or Saltix.
- **An app's numbers reach every node through its relay** (Saltix 22-grain-chats §4, 09-relay §3): `RelayClient.reportStats(signed)`
  sends the newest `SignedGrainStats` in a `grain_stats` frame and again whenever the client registers; the `stats`
  event carries the relay's answer (`{taken, slug, at}` or `{taken: false, reason}`), logged as `relay_stats_taken` or
  `relay_stats_refused`. The chat server reports each signing (at most hourly). The development relay keeps the newest
  numbers of each grain (`relay.stats`) and answers as a relay does.
- `docs/agents/`: pages for coding agents beside `AGENTS.md`: building an app from a developer key (set up, the chat
  spec, handlers and cards, the rules every app follows, testing, shipping under systemd, acting on an error report
  pasted from the console, what each start-up error means) and working on the SDK (its map, commands, rules and how a
  change lands). A test holds them to the files, commands and scripts they name.
- **The app's console** (Saltix 24-app-studio §4, 22-grain-chats §3–§4): the team's chat with its own app is where the
  app talks to the people who build it.
  - `chat.team()`: the owner and the members with the developer or viewer role, from the registry (cached per beacon
    block), each with their address in the app once their proof showed it. The team's wallets send their member proof
    to their own app, public ones too; the server keeps the address (`ChatStore.team`/`setTeam`, kept by
    `fileChatStore`), forgets a member the registry drops, and ignores anyone else's proof at no cost to the node.
    Handlers see `ask.member` and `ask.fromTeam` for the team's requests (`onTeam`, `teamMemberOf`,
    `needsTeamController`, `TEAM_ROLES`).
  - `chat.notifyTeam(card, { roles? })`: unasked, to the owner and the developers by default, within
    `CHAT_UNASKED_TEAM_PER_DAY` (100) a day each; it skips members it cannot reach yet or whose day is spent and logs
    counts only. `notify`, `notification` and late `replace`s give a team member's address the same budget;
    `ChatBudgetSpent` says its `limit`.
  - `chat.report(error, { context?, roles? })`: a card made for an AI agent to read (`reportCard`: a `failed` status,
    fields for the app, the error, where, the command, the request, the app's `version`, the spec, the time in UTC,
    the stack as text, all within a card's bounds); the same error folds for an hour (`REPORT_FOLD_MS`, "×N" in the
    next card, `flushReports`); developer keys, hex of 64 digits or more, the server secret and the options' `redact`
    are scrubbed (`scrubSecrets`, `errorFacts`); it never throws. Handlers' errors are reported on their own
    (`reportErrors`, on by default), and their log lines are scrubbed the same way.
  - The example's **Fail on purpose** (spec v3); the development registry makes the simulator's account a user and
    developer, and the simulator sends the team's proof and takes 100 unasked messages a day for the team.
- `grain init --chat` makes a server to run: `server.mjs` starts the chat from the developer key (`SALTIX_APP_KEY`, the
  file `SALTIX_APP_KEY_FILE` names, such as a systemd credential, or `app.key`, each read only when its owner alone can
  read it; `NODE_RPC` for a network with no public relays), keeps its store in `STATE_DIRECTORY` (systemd's
  `StateDirectory=`) or the current directory, reads `chat.json` and its version from beside it wherever it is started
  from, answers the starting spec's `hello` in the user's language, logs one JSON line per event, flushes error reports on `SIGINT`/`SIGTERM`, and exits with 78
  (EX_CONFIG) when the key cannot work, so a supervisor does not restart it; `package.json` runs it with `npm start` and
  depends on the server SDK the tool runs with (by its path while the SDK is not on npm). `grain init` refuses a slug
  the registry would refuse before making anything (a directory named `t1` made a grain no command could register), and
  every project's `.gitignore` keeps all `*.key` files (`sponsor.key` and a rater's key were not), `node_modules/` and
  `bundle.zip` out of git. The starting `chat.json` is version 2: an app made in Saltix holds the owner-signed starting
  spec of version 1, and Saltix takes only a higher version, so the template's commands never reached its owner.
- The app studio (Saltix 24-app-studio, the SDK's step 3):
  - **the developer key as the whole configuration**: `ChatServer.start({ appKey, spec })` reads
    `saltix-app:1:<hrp>:<genesis>:<slug>:<secret>` strictly (`AppKey`, `AppKeyError`, never printing the secret), finds
    the network's public relays (`PUBLIC_RELAYS`: the test network's three, pinned by their certificates) and the rest
    from `relay_list`, reads the node through the relays' gateways (`RelayGateways`), refuses a key of another or reset
    network, starts only if the registry names the key (`ChatKeyNotRegistered`), signs an unsigned spec with it, and
    asks the registry every few minutes and at each new beacon block a request comes in: once the key is replaced or
    revoked, or the grain retired, it stops answering, leaves the relays, logs `chat_stopped` and calls `onStop`;
  - **private apps**: `admits`, `memberProofProblem`, `signMemberProof`, `keyStandsFor` byte for byte the reference;
    the server takes a private app's requests from its owner and its users and developers only, their proofs checked
    against `grain_get` and `account_get` (`ChainView`, cached per tip), refuses everyone else with a refusal and
    nothing more, and fails rather than admits when the node does not answer; handlers see `ask.member`;
  - **the numbers an app reports**: `GrainStats`, `signGrainStats`, `grainStatsProblem`; the server counts distinct
    users of the last day and 30 days and the requests of 30 days (`UsageWindow`: a user's last request only, forgotten
    after 30 days; requests by the hour), signs them at most hourly and serves them in the well-known document and as
    `ChatFrame::Stats`;
  - the registry calls 34–37 (`ConfigureGrain`, `BindHandle`, `SetGrainAccess`, `RateGrain`) with the shard's checks
    (`grainCallProblem`), deposits by length (`grainDeposit`), handles (`parseHandle`, `displayHandle`,
    `encodeHandle`), chat-only manifests (`Entry::Chat`, `isChatOnly`), byte for byte `vectors/grains-v1.json` and
    `vectors/handles-v1.json` (now synced);
  - `grain configure`, `grain access`, `grain rate`, `grain bind`, `grain app-key` (public parts and whether the
    registry names it; `make` writes one for a server key file, owner-only), `grain init --chat`; repeated flags;
  - the example's chat runs from a developer key (`npm run example`, `examples/hello-grain/server.mjs`); `npm run dev`
    serves a development registry and runs the chat from its developer key; the simulator checks registered keys,
    plays private apps (member proofs, refusals) and shows the reported numbers;
  - [docs/first-app.md](docs/first-app.md), "Your first app in ten minutes"; docs/chats.md on registered keys,
    private apps and members, and reported numbers.

- Grain chats (Saltix 22-grain-chats, step 2: the server SDK; [docs/chats.md](docs/chats.md)):
  - `@saltix/grain-server`: the formats and every check of the reference, byte for byte `vectors/grain-chats-v1.json`
    (synced from Saltix 28ad465): `GrainChatSpec` with its JSON form, `ChatRequest`, `ChatMessage` with blocks and
    actions, `ChatFrame` (`"SGC1"`), and the file reference of 09-relay §10.5.2 (`FileRef`, Borsh and JSON); `ChatServer`
    on `RelayClient`: requests checked (sender, signature, life, fit) and routed by command with typed arguments,
    answered once per `(key, id)` until they expire, refused with a reason or dropped, kept frames acknowledged once
    answered; cards signed with the server key (`card()`), a working status replaced in place; files sealed with
    AES-256-GCM and uploaded next to the relay over its pinned certificate (`409`, `404`, `507` handled); unasked messages
    and notifications within 10 a day per user; a newer spec pushed; `/.well-known/saltix-grain-chat` for any framework;
    `ChatStore` (in memory, or a file). `RelayClient`: `ackKept: "by_handler"`, `reserveFile`, `endpoint`;
  - `@saltix/grain`: `grain.chat.open({cert?, spec?})` (bridge version 2) and `chatLink(slug, cert?)`;
  - `grain chat-spec` (lint with the fault located, check against `grain.json`, a higher version for a change, sign) and
    `grain cert init | grain cert` (a server key, and the owner key's certificate for it);
  - the simulator's chat pane, which plays the wallet's side through a development relay (`scripts/dev-relay.mjs`,
    started by `npm run dev`), and the example grain's chat with every block and action and a CSV report as a file.

- Sealed grains (Saltix 12-grains §8): `grain bundle` makes a deterministic ZIP of `public/` (at most 20 MiB) and
  names its hash, size, sources, start and connect origins in `grain.json`; `grain dev` makes and serves the bundle of a
  sealed grain for a debug wallet. `manifestProblem(m, dev)` takes developer origins as a sealed grain's sources.

- A grain's sponsor (Saltix 11-access §4, 12-grains §5.4):
  - `@saltix/grain`: `relay.open({ grant })`;
  - `@saltix/grain-server`: `issueSponsorCert`, `decodeSponsorCert`, `sponsorCertProblem`, `grantFor` (a grant at login
    from the node's slot), `signChannelTx` (open, top up, close the sponsor's channel), byte for byte
    `vectors/access-v1.json`; the transaction envelope shared by registry and channel calls (`signTx`);
  - `grain sponsor init | show | open | top-up | close`: the sponsor key and its channel, refused before a node would.

- Relays for grains and notifications (Saltix 12-grains §5.4–5.5, stage 3 on the free lane):
  - `@saltix/grain`: `relay.open/send/close/onFrame` (frames of at most `MAX_RELAY_PAYLOAD` = 48 000 bytes),
    the `relay` event, `notifications.allow`;
  - `@saltix/grain-server`: relay records (`signKeyBinding`, `signAddressRecord`, `recordProblem`,
    `messagingKeyOf`, `signMailboxAck`) byte for byte `vectors/relay-v1.json`; `sealFrame`/`openFrame`
    (`crypto_box`, tweetnacl); `signNotification`, `decodeNotification`, `notificationProblem` byte for byte
    `vectors/grains-v1.json`; `RelayClient`, a server's connection to the relays (`ws`): registers under its key,
    pins self-signed relays by the hash in their record, seals to checked keys, acks its mailbox, reconnects;
  - the simulator answers the relay and notification methods, plays a frame arriving, and checks a server's
    notification as a wallet does.
- Vectors synced with Saltix b1d399c (`relay-v1.json` added; grain messaging keys and notifications).

- `grain publish` in the owner's wallet (Saltix 12-grains §10): without a key file it shows a QR code of
  `salt:grain-publish?m=…` (the manifest's Borsh, `owner_key` zeroed, raw DEFLATE, base64url), waits for the
  registry to hold the grain as the wallet published it, and writes `signed.json`; `grain show --out`. Checked
  end to end with a debug Saltix on a local devnet. `sameManifest` in the server SDK.
- `@saltix/grain-cli` 0.1.0, the `grain` command line (Saltix 12-grains §10): `init` (a project with an
  owner-only key and the bridge), `dev` (public/ and the manifest signed for the asking developer origin),
  `lint` (bounds, developer origins, the size a transaction allows), `icon`, `sign`, `publish` (register or
  update through a node, deposit and balance checked first), `retire`, `show`. Checked against a local devnet:
  registered, updated and retired a grain end to end.
- `@saltix/grain-server`: `encodeGrainTx`, `signGrainTx`, `minimumFee`, `grainGet` — the owner's registry
  transactions, byte for byte `vectors/grains-v1.json`.
- `slugLink(slug, start?)`: the link that opens a registered grain, `salt:grain/<slug>`; `GrainInfo.listing`
  may be `listed` (in the network's registry, not on the wallet's verified list; Saltix 12-grains §9).
  Vectors synced with Saltix's registry transactions.
- `@saltix/grain` 0.1.0: the page's side of the bridge, version 1 (12-grains §5): info, ready,
  close, expand, setHeader, haptic, copy, share, openLink, scanQr, login, requestAddress,
  pickContact, pay, storage, events; `inWallet()`, `walletLink()`; the simulator transport.
- `@saltix/grain-server` 0.1.0: sign-in checks, invoices and invoice keys, payments found on
  chain, manifests (Borsh, id, signature, JSON form, developer origins), Address v1, reproducing
  `vectors/grains-v1.json` and `vectors/crypto-v1.json`.
- The simulator and `examples/hello-grain` with `npm run dev`.
