# Changelog

## [Unreleased]

### Changed

- **Breaking for chat clients**: a chat request names the user's language (Saltix 22-grain-chats §3; vectors synced
  from Saltix f99df76). `ChatRequest` ends with `lang`: the language the user's Saltix shows (2–8 of `[a-z-]`, as
  the spec's maps name languages), or `""` when the app does not say. Handlers read it as `ask.lang` and answer in it
  when they can, else in English, so a stranger's refusal comes in one language. `decodeChatFrame` and
  `decodeSignedChatRequest` refuse any other value, `requestFitProblem` says `language` (`requestLangOk` checks one).
  The simulator sends the page's language. It joins the app studio's change below in the same release.
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

### Fixed

- **A private app publishes no numbers** (Saltix 22-grain-chats §4, 24-app-studio §6a; the owner's rule, 2026-10-16):
  while the registry says the grain is private, the chat server hands none to its relay (`RelayClient.clearStats()`
  forgets the kept ones, so none go again on registering) and leaves `stats` out of its well-known document; it logs
  `stats_not_reported {reason: "private"}` once per change, and `stats_resumed {reason: "public"}` when the grain is
  public again, handing the newest numbers over at once. The registry is read as before: every few minutes and at a
  request's new beacon block. Its members still get them in the chat. The nodes refuse a private grain's numbers
  (`private`) anyway.
- `npm run dev`: `/` redirects to the simulator's own path, so its page finds its script (it was not found at `/`).

### Added

- **An app's numbers reach every node through its relay** (Saltix 22-grain-chats §4, 09-relay §3): `RelayClient.reportStats(signed)`
  sends the newest `SignedGrainStats` in a `grain_stats` frame and again whenever the client registers; the `stats`
  event carries the relay's answer (`{taken, slug, at}` or `{taken: false, reason}`), logged as `relay_stats_taken` or
  `relay_stats_refused`. The chat server reports each signing (at most hourly). The development relay keeps the newest
  numbers of each grain (`relay.stats`) and answers as a relay does.
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
