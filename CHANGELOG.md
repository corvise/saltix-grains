# Changelog

## [Unreleased]

### Added

- **Sign in with Saltix, the session at the server** (Saltix 19-connect §15, the server-held mode; `@saltix/connect`
  0.2.0; [docs/connect.md §5](docs/connect.md#5-the-two-modes-the-pages-own-and-the-server-held)): no format changes,
  the vectors hold, every Saltix released signs into it.
  - **`@saltix/connect/server`** for Node 20 and later: `createServerConnect({ node, network, genesis, origin, name })`
    makes and keeps the keys of every offer (30 minutes, bounded, the oldest dropped first) and hands the page only the
    public parts (`offer()`); `take({sid, payload}, admit)` opens each payload the page forwarded with `Q`'s secret and
    answers the server's word — `ignored`, `seen`, `reply` (kept), `refused` with its reason (`offer`, `spent`, a
    grant's, or the site's own from `admit`), `unchecked`, or `connected` with the account's public facts (never the
    grant's bytes) and the confirmation sealed for the page — in §15.2's order, reusing the page's own `verifyGrant`,
    the offer spent in the same step that takes the grant, a refusal spending nothing; `confirm(sid)`, `drop(sid)`,
    `size`. Telemetry of outcomes, reasons and timings only.
  - **The client's server-held mode**: `createConnect({ server: { offer, login } })` (or a `Courier` of the site's own)
    takes the offer from the server, opens the slot and shows the code as before, forwards every payload sealed as it
    came and in order, says it is checking once the wallet's reply was taken, renders `connected` with what the server
    answered (`Connection.answer`; `grant` absent — the page never sees the login's bytes), keeps nothing
    (`connection` is null: the session is the server's), delivers the confirmation the server sealed, and keeps the
    slot across a reload with no secret in it; `failed {reason: "server"}` when the server gives no offer, or one for
    another origin or name. `courier.ts` is the JSON both sides speak (`ServerOffer`, `Forwarded`, `Taken`,
    `Confirmation`) and `httpCourier`.
  - **The example site** (`packages/connect/example`, `npm run example:connect`): a whole site on Node's `http` module
    to copy — the two routes behind an `Origin` check and the limits (16 KiB a body, 10 offers a minute a client), a
    session cookie minted after the checks (HttpOnly, SameSite=Lax, Secure on https), `/me`, sign-out, an allow-list,
    a journal that names no address — with its page, the courier.
  - **The guide's §5 rewritten around the two modes** (the page's own, for display; the server-held, a server's
    login), the rule *never a hosted check as the only way*, and what a site must never do;
    [docs/protocol/connect.md](docs/protocol/connect.md) carries §15; `AGENTS.md`, the README and
    [docs/agents/sdk.md](docs/agents/sdk.md) name the mode. `Connection.grant` is optional now (absent in the
    server-held mode) and `Connection.answer` carries the server's own fields.
  - Tests: the server library (the login taken once, the second `take` refused as `spent`, a login for another slot,
    a stale `at`, a wrong signature, another origin or network refused and the offer kept, the node unreachable, the
    site's rule, the bound and the life of offers, two grants in flight, the vectors' grants, refusals, reply and
    confirmation through the server's path byte for byte), the client's mode end to end over a relay and a fetch the
    test plays (the state machine, the kept slot, the wire, the dialog), and the example's routes.
  - **The guide's third way, with worked examples and a test plan**: [docs/connect.md](docs/connect.md) opens with the
    three ways that share one sheet (a mini-app's, a page's, a server's), and §5 gains §5.1, a DApp's back end on Node
    (the two routes, a session cookie minted after the checks, the back end's own data by account, the swaps still
    signed in Saltix), §5.2, a plain website whose members' pages stay files (a sidecar with `/session/check`, nginx's
    `auth_request`, the members' list as `admit`, `next` a path of the site), and §5.3, the test plan a site runs
    against its own routes before it goes live (a login from a key the test holds and a node it plays: the login taken
    once, a replay refused as `spent`, a stale `at` as `time`, a wrong signature, another origin, slot, key or network,
    an unknown offer, junk ignored, the node down as `unchecked`, the site's rule, the `Origin` check, the session's
    end, a journal without addresses). [docs/protocol/connect.md](docs/protocol/connect.md) §15 is held to the
    amendment as merged (corvise/saltix `78618ec4`): the keys' kinds, the signer's rules of rule 5, the relay's side of
    `link_deliver`; the protocol index, `AGENTS.md` (what a site needs, in order) and the README name the third way.

- **Support for your app** (Saltix 19-connect §11.1, corvise/saltix #474, protocol version 9; [docs/support.md](docs/support.md)):
  an app's Connect profile names who answers its users, and the SDK holds every form to the network's rules.
  - **The profile's format 2**: `support` may be a Saltix address too, the owner's own or one whose holder signed its
    consent (`support_consent`, `SupportConsent`: the address's key over `"Saltix support consent v1"`, the network's
    genesis hash, the app's slug and its owner). `profileProblem`, `verifyProfile`, `checkGrainProfile` and
    `checkSiteProfile` read by a `ProfileReading` (the block's protocol version, the network, its genesis hash), with
    the refusals `consent_missing`, `consent_unneeded`, `consent_key`, `consent_slug`, `consent_owner`,
    `consent_signature`, and `version` for format 2 before version 9; `supportAddress`, `supportKind`,
    `supportProblem`, `supportAccount`, `signSupportConsent`, `verifySupportConsent`, `encodeSupportConsent`,
    `supportConsentFromJson`, `offlineOwner`, `grainOwnerPayload` (also a server key's proof's payload), and
    `supportConsentFromEnvironment`, which signs with the key in `SALTIX_SUPPORT_KEY`, never a file. A profile call of
    format 2 is protocol version 9's (`callVersions`), and `signGrainTx` checks its consent on the network it signs
    for. Held to `vectors/connect-profiles-v1.json`'s `support_address`, every case as a block of version 8 and one of
    version 9 read it.
  - **`grain support <contact>`** writes `connect.json`'s support contact in its canonical form and checks it as the
    network will: a link or an e-mail address; a username, refused when nobody holds it (whoever minted it would get
    the app's users' questions), said to open the app's chat when bound to it; an address of this network from
    protocol version 9, the owner's own or with its holder's consent (`--consent F`, or signed here from
    `SALTIX_SUPPORT_KEY`). `grain support consent` is the holder's side. `grain lint` takes format 2 and checks a
    consent's key and app; `grain profile` holds the profile to the network's reading (format 2 refused before version 9,
    saying when it comes; a consent of another network refused before anything is signed); `grain show` prints the
    support contact; the simulator's Connect sheet shows a username or an address as a chat. `readSiteProfile`
    (`@saltix/connect`) takes the network to hold a site's support address to.
  - **The support agent** (`examples/support-agent`, `npm run support-agent`): an app's support answered by its own
    program in the app's chat, which every user reaches: the app's notes (`faq.json`) first, a language model next when
    `ANTHROPIC_API_KEY` is set (Anthropic's SDK, loaded only then; a daily share per user; `chat.json` says `"ai": true`
    or it does not start), and a person's `@name` takes over when neither can answer or the user asks. It logs names
    and numbers, never what users wrote. An agent with an address of its own is not built:
    [docs/support-agent-address.md](docs/support-agent-address.md) says what it still needs.
  - Every project's `AGENTS.md` (and the SDK's `AGENTS.md`, `CLAUDE.md`, `docs/agents/app.md`) has *Support for your
    app*: the four forms, setting it, the consent, the agent, what a user sees.

### Changed

- **Pairing a server, version 2** (Saltix 24-app-studio §3a, corvise/saltix #488; the owner's rule of 2026-10-28: a
  developer copies one command from the app's page in Saltix, public data only, runs it and shows the QR code; the owner
  scans, compares the code and confirms with the PIN; no key, token or secret is ever shown, pasted or carried, and a
  coding agent never asks a person for a key, a token or an address they did not give it):
  - **`grain pair [--app <slug>] [--owner <address>] [--genesis <16 hex>] [--name <server name>] [--new] [--no-wait]
    [--timeout S]`** takes the command's three fields from the command line, else from the project (`app.json`,
    `.grain/pair.json`, `grain.json`'s slug), else, for an app the registry holds, the owner from its record
    (`grain_get`) and the genesis from the network; a new app needs `--app` and `--owner`, and it says so plainly. It
    reads the registry's record first (another account's, or retired: refused before anything is shown; naming the key
    already: finished), makes or keeps the pending key, signs the key's proof for the app and its owner (the very proof
    a `ConfigureGrain` of tag 39 carries), prints the app, the owner, the server's name (`--name`, the host name unless
    told), the code and the QR code (the terminal, the link, `.grain/pair.html`), renews the offer when it expires with
    nobody having scanned it, and **watches the registry** (the record's server keys, polled with a short backoff; no
    relay session, no mailbox, no message from the phone) until the key is named, then writes `app.key`, `app.json`
    (now with `owner`) and `.gitignore`. A key the registry names for another live app (`ServerKeyTaken` at the phone)
    is told `grain pair --new`. It waits until the key is named unless `--timeout S` bounds it; `--no-wait` shows the
    offer and returns.
  - **`@saltix/grain-server`'s `pairing.ts`** is version 2's: `PairingOffer` with `owner` and `proof` (fields and
    order as §3a), `PairTarget` with `pairCommand`/`parsePairCommand` and `pairTarget`, `makeOffer` signing the proof
    with `signServerKeyProof` (the one definition, `ConfigureGrain`'s), `offerProblem` checking the form, the version
    (an offer of version 1: "this offer is from an older SDK: update it and run `grain pair` again"; above 2: "update
    Saltix"), the network, the clock, the expiry, the owner and the proof in the specification's order, `judgeSlug`
    (`free`, `own`, `paired_already`, `another_account`, `retired`) over `slugRecordOf(grain_get's record)`,
    `offerProof` for the phone's call, `versionMessage`. Held to `vectors/server-pairing-v2.json` (synced at
    corvise/saltix `5c045a9f`): the command, the offers in English, Russian and unnamed, the proof's message and
    signature, the slug's verdicts, the owner's signed `ConfigureGrain`, and all 42 refusals.
  - **`grain status`** says `waiting` (an offer shown, the registry not naming the key yet) in place of `pairing`, with
    the app and the owner the offer is for, and names the whole command when it knows no fields; `grain doctor`'s key
    finding and next step follow. **A developer key made in Saltix** (`app.key` without an `app.json` naming it, or
    `SALTIX_APP_KEY`) still works, with a warning at the server's start (`appKeyFromEnvironment`'s `warn`, the console
    unless told: `DEVELOPER_KEY_WARNING`, `keyPairedHere`) and in `grain status` and `grain doctor` to pair a server in
    its place; Saltix makes no new ones (§3, retired).
  - The pages that describe pairing or developer keys say so: `docs/first-app.md` (the command from the app's page,
    the brief with the owner's address and the three facts as placeholders), `docs/agents/app.md` and `AGENTS.md`
    (run `grain pair` with the fields from the app's page, show the QR code, wait for the registry; the never-ask rule
    in bold), `docs/agents/README.md`, `docs/protocol/app-studio.md` (§3 and §3a from the specification),
    `docs/how-it-works.md`, `docs/chats.md`, `docs/devex.md` (the steps' log: `fields`, `record`, `offer_renewed`,
    `registry`'s reasons), `docs/payments.md`, the templates' `AGENTS.md` and README, the README and the example.

- **The docs say what an app meets on the network now** (corvise/saltix `fbbc06c3`): Saltix's test network runs
  Consensus 2 since its v15 of 26 October 2026, so a block the node shows is final at its committee's certificate and one
  confirmation is enough to deliver on (`docs/payments.md`, the wallet interface's *Confirmations*); an epoch is 1 600
  certified beacon heights, reckoned by `node_status.pace` and `epochs_ahead`, never `genesis_time + epoch ·
  epoch_slots` (the wallet interface's new *Epochs and their times*, with `node_status`'s `epoch_heights`, `pace`,
  `epochs_ahead` and `committee`); the test network runs protocol version 6 and takes 7, 8 and 9 at epochs 60, 96 and
  132 (`docs/protocol/basics.md`, where version 1 was "what every network runs"); ask for SALT in an invoice from
  version 4, since WORK lives in the pools' books; donations are the owner's switch in Saltix, which the SDK reads and
  never sends (`AGENTS.md`'s *Donations to your app*, the README); the node installs on macOS and Windows too.
- **The vectors are synced at corvise/saltix `6671fabb`** (#474's head), and the SDK follows what the sync brought:
  **usernames alone** (the numbers left with the v15 genesis, 2026-10-25): `Handle` is `{ name }`, a number's text
  (`+0 777 1234`) reads as no handle, and `grain bind` says so; `grain_get`'s `donations` (`RegisteredGrain`), whose
  call `SetGrainDonations` (tag 76) the SDK does not send, said in the test that skips it.
- **The pool vocabulary** (corvise/saltix #337, the owner's decision of 2026-10-22; a breaking change of the wallet
  interface's words, with no aliases): the mining layer speaks the words of mining, here as in the protocol. A city is a
  **pool**, its governor the **operator**, its node's signing key the **pool key**, a citizen a **miner** with a
  **mining license**, the labor exchange **earnings**, the labor fund the **work fund**, subsidies **payouts**. What the
  SDK reads changed with it: `exchange_list`'s rows carry `pool` and `pool_key` (once `city` and `operator`; the CLI's
  `Exchange`, `grain sponsor open --exchange <pool>`), a grain's `ratings` are `{count, sum, miners_count, miners_sum}`
  (once `citizens_*`; `GrainRatings`), `grain_list` sorts by `miners` and `grain_ratings`' rows say `miner`. The golden
  vectors are synced at corvise/saltix `e6448704`, main's merge commit of #337: `access-v1.json` (`pool_key_*_hex`,
  `pool_hex`, its rules) and `handles-v1.json` (the reserved names `pool` and `operator`) changed in words only, no byte
  of any Borsh form or signature. The protocol pages, `AGENTS.md` and the guides use the new words; the old ones
  survive only in this changelog's history.

### Removed

- **Version 1's exchange through the relays**: the `SGP1` frames (`PairRequest`, `PairAnswer`, `PairFrame`,
  `encodePairFrame`/`decodePairFrame`), `judgePair`, `answerPair`, `checkPairAnswer`, `PAIR_ANSWER_WAIT_MS`,
  `grain pair --accept`, `--slug` (now `--app`) and `acceptHint`; `vectors/server-pairing-v1.json`. On protocol version
  6 the messenger's gate held both frames, so version 1 could not pair, and nothing in use was paired by it.

### Fixed

- **The simulator's node answers Consensus 2's clocks, as a node of 0.2.5 does** (Saltix 43-consensus-2 §8;
  [the wallet interface](docs/protocol/wallet-interface.md#epochs-and-their-times)). `createDevRegistry`'s
  `node_status` modelled the longest chain only, a block a slot, so an app tested against it never met the test
  network's two clocks. It now gives `epoch`, `epoch_slots`, `epoch_heights`, the registry's `position` (the next beacon
  block's, `⌊(height + 1) · E / E_H⌋`) and `pace` (the ms a height takes), consistent with its own heights: the slot clock
  reads the heights at their pace and runs ahead of the position, as on the test network, and a record's `registered`,
  `updated` and `retired` are positions. `clock` (`DevClock`) chooses: Consensus 2 by default (1 600 heights of 2 400
  positions an epoch, `DEV_PACE_MS` 2 000 ms a height), its pace not measured yet (`measured: false`, `pace: null`), or
  the longest chain (`kind: "longest"`, the old answers).
- **`chat.paymentOf` finds a WORK invoice paid on chain** ([docs/payments.md](docs/payments.md)). On a network of
  protocol version 4 or later — the test network is one — no account holds WORK on chain, so a WORK invoice is paid
  from the payer's book or in SALT of the same integer on chain (Saltix 35-work-on-layer-2 §3.4), and `paymentOf`
  counted only a payment in the invoice's own asset: one paid in SALT was never found. It now counts SALT of the same
  integer for a WORK invoice (`paysAsset`, exported for `findPayment`'s callers); a SALT invoice is still paid in SALT
  only, and a payment from a book is not on chain.

### Security

- **`grain pair` pairs only the app the developer named or confirmed** (Saltix 24-app-studio §3a). Before, an offer that
  named no app (no `grain.json`, no `--slug`) took itself as paired with whatever app the registry first named the key
  for: whoever saw the offer (a shared screen, a pasted log) could ask for an app of their own, name the key for it with
  the proof they got, and this computer wrote `app.key` for that app and served it. Now such an offer answers whoever
  asks, prints "Saltix asked to pair this server with S, owner …" and writes nothing: `grain pair --accept S` confirms
  the app once the user says it is the one they meant, `grain pair --new` makes a new key and offer otherwise; `grain
  status` says "asked to pair it with S, not confirmed" and names the same command. An earlier offer's answer counts for
  nothing once a new offer is shown. The offer's `--name` is kept with it, so `--accept` need not repeat it.
- **A key file signs on test networks only** (12-grains §10): `grain publish --key`, `retire`, `rate`, `access`,
  `profile`, `bind`, `configure` and `app-key make` are refused when the network is `mainnet`, before anything is
  uploaded or sent; the owner's Saltix signs there from the QR code. `grain sign` (offline) is unchanged.
- **A key file, a chat's store or `app.json` under `public/` goes into no bundle**: `grain bundle` and `grain publish`
  refuse it by name (a bundle is uploaded before the owner signs and served by the network to anyone by its hash),
  `grain lint` reports it as an error first, and `grain dev` never serves such a file.
- **`grain dev` listens on `127.0.0.1` by default** (`--host 0.0.0.0` for a phone on the same network; the Android
  emulator reaches the host's loopback at `10.0.2.2`): it signs with `owner.key` and takes writes to its development
  registry, which were open to the whole network before.
- **A trust anchor's certificate pin is never replaced by a `relay_list`**: the relays a gateway starts from
  (`PUBLIC_RELAYS`, `--relay`) keep their pins; one relay's list re-pins only relays it discovered.
- **An answer from a node or a relay is read up to 4 MiB** (`MAX_ANSWER_BYTES`): `rpc`, the gateways and
  `relayRequest` refuse a longer one instead of buffering it.
- **CI pins its actions by commit and runs `npm ci --ignore-scripts`**; the docs say the same.
- **The support agent's model answers at most 500 questions a day for all users together** (`perDayTotal`,
  `MODEL_QUESTIONS_PER_DAY_TOTAL`, `SUPPORT_MODEL_DAILY` in `examples/support-agent/server.mjs`), then a person takes
  over until the day turns. A user's daily share (20) is per key in the app, and keys cost nothing to make: a flood of
  new accounts could have run up the app's bill without end (the threat audit of 2026-10-28). The hand-over card says
  why, the log counts `why: "total"`, and the per-user map holds at most the day's total users.
- **`PUBLIC_RELAYS` pins the test network's current certificates**: a relay makes a new certificate when its network
  starts over, and the pins were the previous network's since 2026-10-26, so every call through the public relays
  failed on them (and a developer was pushed to pass unpinned endpoints). The comment no longer claims the
  certificates outlive a reset.

### Changed

- **The golden vectors are the protocol's at `a40da88d`** (`vectors/SOURCE`): `accounts-v1.json` with `device_key_forms`
  (a P-256 key in SEC1's compact form `05 ‖ x`, which protocol versions 1 and 2 take as a device key and version 3
  refuses), `images-v1.json` with the fourth blob kind (`token_logo`, tag 2), `handles-v1.json` with numbers of
  protocol version 3's form and `relay-v1.json`. `deviceKeyValid`, `sameDeviceKey` and `verifyByDeviceKey` take the
  compact form as one key with its compressed form (`compressedP256`), so a device added that way in version 1 or 2
  keeps signing in a key event log, a member proof and a Connect grant; `NAMED_KINDS` has `token_logo`; `displayHandle`
  writes a ten-digit number that starts with a code of three equal digits as `+0 777 123 4567`. Numbers of version
  3's fixed form (a leading zero) are not read yet: the test says so where it skips them. docs/agents/sdk.md: the
  vectors are synced with every change of the protocol's.

### Added

- **`@saltix/connect`: the link to Saltix keeps the page, and a page unloaded on the way comes back to its slot**
  (Saltix 19-connect §14.1; the owner, 2026-10-21: on Android Chrome the https link opened in the same tab navigated the
  tab, the page unloaded and its slot died, and the wallet spun against nothing). `offer.app` is what Open Saltix
  points at: on Android an intent link (`intent:1:…#Intent;scheme=saltix-connect;package=io.saltix.app;
  S.browser_fallback_url=<the https link>;end`, `offerIntentLink`, `offerAppLink`, `isAndroid`), which the browser
  hands to the installed app without navigating; the https link elsewhere. The session keeps its slot in
  `sessionStorage` (`keep`, `KEPT_SLOT_KEY`: the slot id, `Q`'s secret, `P`'s public key, whether seen or held; never a
  private key) and `start()` opens the same slot again on a reload within its life (`connect_resumed`,
  `connect_resume_failed`); `start({fresh: true})` and `connect.renew()` make a new one; forgotten once connected.
  A payload the relay held for a parked slot (09-relay §10.3 step 6a), sent right after `link_opened`, is taken on
  resume and on a reconnect. While the page is hidden the session dials nothing after a dropped connection (a phone's
  browser behind Saltix has no network) and opens the slot on `wake()`. `Phase` and `OfferView` carry `app`;
  docs/connect.md §6 items 3–4.

- **`@saltix/connect`: connection feedback** (Saltix 19-connect §14, the owner's reference standard, 2026-10-21). The
  session keeps the wallet's `ConnectReply` (a payload of first byte 2: the wallet's reply slot, its key and the login
  it goes with) and, when a grant checks, raises `connected` at once and then confirms the login to that slot
  (`ConnectConfirm` sealed to the reply's key with `aad = reply sid ‖ P`, `link_deliver` on the page's own slot
  connection, `link_delivered` waited for 5 s) before the slot closes; telemetry `connect_reply` and `connect_confirm
  {outcome}`. `encodeReply`, `encodeConfirm`, `decodeConfirm`, `checkConfirm`, `CONNECT_DELIVERY_MS`,
  `CONNECT_CONFIRM_MS`, `CONFIRM_DELIVERED_MS`. The dialog's Open Saltix link opens in the same tab (no
  `target="_blank"`): the page stays where the visitor returns to. docs/connect.md §6 is the page's checklist;
  docs/protocol/connect.md §14 the protocol; vectors synced to corvise/saltix `a6d0de6b` (`reply`, `confirm`,
  `refused_confirms`; a payload of first byte 2 is a reply, the refused grant of another version is `version-3`).

- **Ready for protocol version 2** (24-app-studio §2, 13-accounts §6.1, 23-upgrades §6a):
  - `grain configure` sends `ConfigureGrain` in the form of the version the network runs: bare keys (tag 34) in
    version 1, each key with its proof (tag 39) from version 2, signed here by its key file. A key given as bare hex is
    refused from version 2, and the owner's Saltix is pointed to `grain pair`.
  - Every signed call passes `windowFor` (`versions.ts`). A call the network's version does not take is refused. One
    of a form a scheduled version retires is valid at most until the slot before the switch, and is not sent in the last
    30 slots before it.
  - `callVersions` (`@saltix/grain-server`) gives each registry call's versions: `ConfigureGrain` 34 until 2, 39 from 2,
    and a sealed manifest without a source from 2.
  - `checkLog` and `keySpeaksFor` take a managed account's quorum in either form, all its signers in one. A quorum cut
    down to one signer is refused, as is one whose signers sign two forms. Held to `vectors/accounts-v1.json`
    (`quorums_v2`), now synced with the others.

- **`grain dev --check --tap` taps the buttons a tap brings up** ("Clear history" once there is a history): after each
  tap the simulator names the buttons shown that were never seen (`saltixSimulator.more()`), tapped in their turn within
  30 buttons and 40 s; those left are a warning ("N buttons appeared later and were not tapped").
- **`shortAddress`** in `@saltix/grain`: an address as Saltix shortens it (`dsalt1qabcd…uvwxyz`).
- **Wait lines say their limit**: `in the pool, waiting for a shard block (1:39 of up to 6:00)`.

- **`grain dev --check --tap`**: after the layout pass, each of the page's buttons tapped once (at most 30, never a link)
  by real pointer events, as a person taps: a tap after which the page throws, or asks Saltix for something it refuses,
  is an error; one that changes nothing on the page and asks for nothing, a button something covers, and a page that
  would leave for another origin are warnings; a screenshot after each tap in `.grain/check/`. Bounded and safe: 40 s
  for all taps, documents from elsewhere stopped before they load, no window opened, and payments declined (4001) by the
  simulator, which a tool now drives (`saltixSimulator.drive()`, `buttons()`, `aim()`, `calls()`).
- **`grain doctor`'s exit status**: 0 nothing left to do, 1 something to do (`next:` says what), 75 nothing but waiting
  for the network (sysexits' EX_TEMPFAIL); `wait` lines, `outcome` and `exit` in `--json`; the log says `waiting`, and
  `end` `waiting` `exit_75`. Documented in the README with a note for agents and scripts written for exit 1.
- **Doctor follows every transaction a key file here sent until it lands**: `grain access` and `grain profile` keep
  theirs in `.grain/publish.json` beside `grain publish`'s, and doctor says where each stands (in the pool, in a block,
  not seen yet), that it landed (`ok registry v1 registered (the transaction sent at … landed)`), or that it can land no
  more, with the command that sends it again.
- **Nothing to change, nothing sent, for every owner's call**: `grain access`, `configure`, `bind` and `profile` compare
  with the registry (a profile by its words) and say "nothing to change" (exit 0) instead of signing the same again;
  checked again when a call is built anew after the account's earlier one landed.
- **Where the bundle goes**, said once in docs/how-it-works.md for every protocol version (the network's keepers
  always; the manifest's `sources` none from version 2, addresses of the network's own copy at up to 3 relays before
  it) and linked from the README, AGENTS.md and first-app.md.

- **A key file's first publish makes the app private in the same breath**: `grain publish --key owner.key` sends
  `SetGrainAccess` private right behind `RegisterGrain`, with the next nonce, before the registration lands (the pool
  takes a nonce ahead; a shard's registry calls reach the registry in their order), so the app is never public in
  between and the publish takes one transaction's time, not two. What it sent is kept in `.grain/publish.json`
  (`sent`, `private_pending`): a run cut short, or `--no-wait` (now taken with a key file too), is finished by the next
  run, which waits for it rather than sending it again; a call that makes the app private and is lost is sent again
  until the registry says private. `grain doctor` says what is on its way, and **public, but should be private** with
  the fix; `grain access` in the project ends it.
- **Waits said as they go** (`wait.ts`): a registry call, an owner's Saltix, an earlier run's transaction — what it waits
  for, where it stands (in the pool, in a shard block on its way to the registry) and for how long; one line rewritten on
  a terminal, a line when the stage changes and every 15 seconds elsewhere. A transaction is waited for 6 minutes (was
  3). The docs state the times (about 1.5 to 2.5 minutes a registry call on the test network, up to about 6 for a first
  publish) and tell coding agents to run such commands in the background, with a timeout of 10 minutes or more, or with
  `--no-wait` and then `grain doctor`.
- **`connect-template`**: `grain lint` warns, and `grain profile` refuses before anything is signed, a `connect.json`
  whose tagline, about, privacy or highlights are still `grain init`'s words about its counter or hello chat.
- **Who opens the app**, said once `grain publish` is done: anyone; its owner and members in Saltix; or, for a private
  app a key file owns, nobody until a member is named, with the command that names one and the simulator to try it.
- **`grain show --json`**: the registry's record and nothing else; without it, a summary in words.
- `grain doctor` shows the fees of a first publish (the pool's floor for its two transactions) beside the deposit, and
  checks `connect.json` (as `grain lint` does, the template's words included) until the registry can hold the profile;
  it says whether the app is public or private.
- `grain.json`'s `permissions` explained in every project's README and AGENTS.md, and in docs/agents/app.md.


- **`grain dev --check`**: the simulator driven headless in the Chrome, Chromium, Edge or Brave of this computer
  (`CHROME_PATH`), over `--remote-debugging-pipe`, with a profile and a temporary directory it removes after: the
  Connect sheet, the page's load, then every screen it plays (a phone, one on its side, the Galaxy Z Fold's three sizes,
  an iPhone-like screen) in both themes, judged by pure functions (`judge`): an error for something tappable under the
  wallet's controls, a page that throws or does not load, a Connect profile a wallet refuses; a warning for a sideways
  scroll, something under a system bar, a request the wallet refused, one look for both themes. A screenshot of each
  screen and `report.json` in `.grain/check/`, exit 1 on an error; no browser downloaded, and without one it says so.
  The simulator shows the project's icon (`/_icon.png`, the one `grain.json` names) on its Connect sheet and splash, and
  answers a tool through `window.saltixSimulator`.
- **`grain icon --monogram L`**: an icon to the standard with no picture, one or two of A–Z and 0–9 drawn bold inside the
  keyline circle on `--background` or a tint the slug picks, the ink white or dark by contrast, from a stroke font of
  the SDK's own (the same bytes on any computer); checked, previewed and named in `grain.json` as any other.
- **`grain init --sign-in`**: the page for some people only, which checks first and renders after; `grain init` alone
  now makes a page that works on its own, with no gate.
- **A quick path for a page-only app** at the top of `AGENTS.md` and the README, and *No phone, test network* in
  `docs/how-it-works.md` and `docs/agents/app.md`: from an empty folder to a published page, every command and nothing
  about servers; a project's `AGENTS.md` for a page leads with a page's steps and rules, the server's after.
- **Decisions** in `docs/agents/sdk.md`: what the SDK decided, why, and what it rejected.

- **`grain publish` puts a page straight into the Saltix network** (Saltix 32-images §7.3, 12-grains §8, §10): no
  server, host, domain or certificate of the developer's. It seals `public/` (the bundle check every node runs, run here
  first), names the sources by the network's protocol (`node_status.protocol.version`: none from version 2; before it
  the network's own copies, `https://<relay>/_blob/grain_bundle/<hash>` at up to 3 relays of its relay list, those
  offering space first by the bundle's placement), and uploads the bundle in pieces of 256 KiB at a relay's gateway
  (`blob_put`): with `grain pair`'s `app.key` (or `--app-key`, `SALTIX_APP_KEY`) at once, on the server key's
  `SignedBundleUpload` statement, so the network holds it pending for a day and the owner signs whenever they like;
  without one, once the registry names it. Then the publishing QR code (and `.grain/publish.html`) or `owner.key`, the
  registry watched, and the icon uploaded unless the network holds it. Progress on a terminal or in quarters for an
  agent; `offset` resumed from `received` (from 0 after a failover), `busy` and `rate_limited` waited out, a network
  that does not answer tried again, every refusal said in words with what to do. Run again it finishes what a break left;
  a version not above the registry's is raised to the next; `--no-wait` returns once the QR code is shown. `--hosted`
  publishes a page at the developer's own origin; `grain init`'s placeholder origin is sealed; a chat-only app as it is.
  An `owner.key` of another account than the registry's owner (an app made in Saltix) asks the owner's Saltix instead.
  Every step goes to `.grain/log.jsonl` with stable reasons, and where the publish stands to `.grain/publish.json`.
- **`grain icon`** makes a 512 × 512 icon to Saltix's standard (32-images §3) from any PNG or JPEG: fitted (`--fit
  crop|contain|mark`, a logo's mark inside the keyline circle by default), flattened onto `--background` or the
  picture's own ground, converted to sRGB (ICC matrix-and-curves profiles, a PNG's gamma), turned by EXIF, resampled
  with a Lanczos filter, written with only the chunks the image check takes, in true colour or a palette when that is
  what fits 64 KiB; it prints the hash first, checks §3.4 (256 × 256 taken with a warning, the mark outside the keyline
  circle, a small mark, a pure white or black ground), writes a preview of the icon in the rounded-square mask at 24, 40,
  56 and 96 dp on dark and light with its zones, and names it in `grain.json`. `grain lint` holds the project's icon to
  the same checks. [docs/icons.md](docs/icons.md).
- **`grain doctor` knows where a page's publish stands**: `not_uploaded`, `pending`, `waiting_for_owner`,
  `pending_expired`, `published` (`--json`: `publish`), whether the network holds the bundle and the icon, and that a
  page alone needs no paired key.
- **`@saltix/grain-server`: named blobs** (`named.ts`, `bundle-upload.ts`, `blobs.ts`): the image check and the bundle
  check (`checkImage`, `checkBundle`, `namedProblem`, `namedHash`, `monogramColour`), the server key's statement
  (`signBundleUpload`, `encodeSignedBundleUpload`/`decodeSignedBundleUpload`, `bundleUploadProblem`), and putting blobs
  into the network (`putBundle`, `putIcon`, `getBlob`, `blobHeld`, `BlobRefused`), held byte for byte to
  `vectors/images-v1.json`, refusals included. `chat.proposeUpdate(next, { bundle })` puts a sealed update's bundle into
  the network before the owner is asked. `manifestProblem` takes the protocol version (`NETWORK_BUNDLES`: a sealed
  manifest may name no source from version 2). `@saltix/grain-server/dev`'s registry takes `blob_put` and `blob_get` as
  a node does, and names relays with their keys and space. Mutation-tested: 22 of 22 mutants killed (the statement's
  message, Borsh, domain, key, time and signature checks; the icon's byte bound, sides, squareness and alpha; `grain
  icon`'s 64 KiB, 512 and keyline; the upload's resume, waits and statement; the publish's statement and sources rule).
- `vectors/images-v1.json` synced (`scripts/sync-vectors.sh` copies it); `docs/protocol/images.md`, the protocol's
  32-images as an app needs it.

- **Pairing a server by QR code** (Saltix 24-app-studio §3a): no key is copied any more. `grain pair` makes the server's
  Ed25519 key on the computer that runs it (`.grain/pair.key`, owner-only, never printed or logged), shows its offer as
  a terminal QR code (colours set on a terminal; plain half blocks elsewhere, for an agent's output), a link
  `salt:grain-pair?o=…`, `.grain/pair.html` and a 6-digit code; answers the owner's Saltix through the relays (one app
  and one owner per offer, with the key's proof for them; `other_app`, `used`, `not_owner`… otherwise); watches the
  registry until it names the key (`--timeout`, resumed by running it again), then writes `app.key` (owner-only) and
  `app.json` and keeps `app.key`, `*.key` and `.grain/` out of git. `--new` pairs a new key (rotation); `--no-wait` shows
  the offer and returns, for an agent that must show it before it waits. `@saltix/grain-server`: the formats
  (`makeOffer`, `encodeOffer`/`decodeOffer`, `offerLink`/`parseOfferLink`, `offerProblem`, `offerCode`/`offerCodeText`,
  `offerAddress`, `keyFingerprint`, `encodePairFrame`/`decodePairFrame`, `judgePair`, `answerPair`, `checkPairAnswer`,
  `signServerKeyProof`/`verifyServerKeyProof`), held byte for byte to `vectors/server-pairing-v1.json`, refusals
  included.
- **`grain status`** (paired, pairing, unpaired, revoked, replaced, retired, unregistered, other_network, invalid,
  unknown, and the command to run next; `--json`; exit 0 only when paired) and **`grain doctor`** (`.gitignore`, the
  key, its file's mode, `chat.json`'s version, `npm install`, the bundle, what the registry holds, the Connect profile,
  then the exact next step).
- **The steps' log**: every command run in an app's project appends its steps to `.grain/log.jsonl` (the command, the
  step, its outcome, a stable reason code, the milliseconds, the network's kind; never a key, an address, a slug, a path
  or anything typed: codes only, enforced before writing). The codes: [docs/devex.md](docs/devex.md#the-steps-log).
  `SALTIX_GRAIN_LOG=off` turns it off.
- **A server refuses to start unpaired**: `appKeyFromEnvironment` (`SALTIX_APP_KEY`, `SALTIX_APP_KEY_FILE`, or `app.key`)
  throws `ChatSetupError` `chat_unpaired` (exit 78) saying to run `grain pair`, and `chat_key_exposed` for a key file
  others may read; the server `grain init --chat` makes and `examples/hello-grain` use it. The registry's refusals now
  say `grain pair --new` instead of "make a new developer key".
- **`ConfigureGrain` of protocol version 2** (tag 39, `configureProven`: each key with its proof), byte for byte to the
  vectors' `configure-v2`; no network runs version 2 yet.
- The agents' rules start from `grain status` → `grain pair` → show the QR code and wait, and never ask the user to paste
  a key (rule 1 of every project's `AGENTS.md`, its "Start here, every session", `docs/agents/app.md`, the README,
  `docs/first-app.md`); the developer key stays as the fallback for a host where no command runs.

- **How a mini-app works, on one page, read first** (`docs/how-it-works.md`): the pieces (Saltix, the registry the
  owner's phone signs, the page in a WebView with the bridge, the chat, the program that connects out to the relays with
  no domain, open port or certificate, its paired key, the relays) and what runs where; **Do I need a server?** (a page
  alone, or users together live, need none; a chat, payments, shared state, notifications and a page for some people
  only need a program); **the lifecycle as one checklist** (one app, one project, one key; set up and pair; build; the
  standards; try it; publish; run the program; updates and key rotation); publishing a page today (a sealed bundle at
  any HTTPS URL, `grain publish --wallet`) and what is coming (the network hosting the bundle); running the program on a
  computer or a small server. The README's first line tells whoever holds a `saltix-app:1:` key where to start (this
  page and `AGENTS.md`) and that the key belongs in `app.key`, never in a chat or a commit; `AGENTS.md`, `docs/agents/`
  and every project's *Start here, every session* send a reader there first.
- **`AGENTS.md` starts with what an agent given Saltix's brief or a developer key does**: how it works and its table,
  the key's public parts only, the app's own project beside the checkout, pairing (`grain status`, `grain pair`: show the
  QR code or `.grain/pair.html` and the 6-digit code and wait, `grain doctor`), never asking for a key, **one app, one
  key, one program** (never the example or a second program on an app's key, never another app's key or slug), git, a
  key pasted anyway, `npm start` and the first answer. `docs/first-app.md`'s *Building with a coding agent* carries the
  brief Saltix copies beside a developer key (**Copy brief for a coding agent**, word for word with placeholders, never a
  key), what the person and the agent each do, the first test and a leaked key; rule 1 of every project's `AGENTS.md`
  says one app, one key, one program. `docs.test.mjs` holds the README's line, the first steps, the brief and
  how-it-works' tables and checklist to their words; `agent-docs.test.mjs` holds every `grain` command that `AGENTS.md`,
  the README, how-it-works and the first app name, as well as `docs/agents/`, to the help.
- **The protocol, as an app needs it, in the SDK** (`docs/protocol/`): the repository is public and the protocol's own
  is not until the main network launches, so the app-facing parts of its specifications are written here under their
  names and section numbers, each page naming the protocol commit it was read at: [grains](docs/protocol/grains.md)
  (12-grains: the manifest, the registry's grain calls, the bridge and the page's frame, sign-in and the team's member
  proof, invoices, storage, relays and notifications, the container, bundles, publishing),
  [grain chats](docs/protocol/grain-chats.md) (22-grain-chats), [the app studio](docs/protocol/app-studio.md)
  (24-app-studio), [Saltix Connect](docs/protocol/connect.md) (19-connect), [relays](docs/protocol/relays.md) (the client
  protocol a server speaks, files, sponsors), the [wallet interface](docs/protocol/wallet-interface.md) and the
  [basics](docs/protocol/basics.md) (encodings, domains, keys, addresses, amounts, transactions, usernames, protocol
  versions). [vectors/README.md](vectors/README.md) says what each golden vector holds: the protocol's own bytes. Every
  link to the protocol's private repository (and to the wallet's) is gone from the README, `AGENTS.md`, `CLAUDE.md`,
  `docs/`, the packages' descriptions and comments and the projects `grain init` makes, which now link the SDK's pages
  (`PROTOCOL_DOCS`). `protocol-docs.test.mjs` follows every link and anchor of every page and refuses a link into the
  private repositories or a spec file a reader cannot open.
- **Check first, render after** (Saltix 12-grains §5.1a): a page signs in and learns what the account may do before it
  shows anything. `grain.signIn({ url })` (`@saltix/grain`) posts to the server's `challenge` and `session` routes and
  forwards Saltix's login with its `member` as it came (the account's member proof for the app's team and a private
  app's members, `null` for anyone else, absent from Saltix 0.1.53); `gateOf(signIn, TEAM)` says what to draw: `open`,
  `refused`, `update`, `declined`, `failed` or `outside`; `Rights`, `TEAM`. The server's side: `SignIns` (challenges
  spent once, the login, the proof) with `SignIns.of(chat)`, `ChatServer.member(proof, key)` (the proof checked as a
  request's against the registry and the account's keys; a public grain counts its team alone; a team member's proof
  says where their chat is; `ChatMemberUnchecked` when the node does not answer), `rightsOf` and `signInAnswer`.
  `grain lint` warns (`render-before-sign-in`) about a page that signs in and shows anything outside its splash
  (`data-grain-splash`) in its HTML, or marks no splash. `grain init`'s page shows a splash until its gate decides
  (`SIGN_IN`, `FOR`), then the app or a refusal page. The simulator's sign-ins carry the account's proof by the
  development registry, and play Saltix 0.1.53 (no `member`). `AGENTS.md`, every project's `AGENTS.md` (a tenth rule)
  and `docs/agents/app.md` say so.
- **Every app ships a Connect profile** (Saltix 19-connect §11–§12, 12-grains §10): `grain init` writes `connect.json`
  (every template, chat-only included: the JSON form's `profile` without `owner` and `revision`, in English and Russian,
  describing the app it makes). `grain lint` fails without it and checks every rule of the format with the field and
  its limit, the privacy summary (required when the manifest asks for `address` or `storage`), the subject's slug, the
  icon file (`icon.png` or `public/icon.png`: 256×256, the hash `grain.json` names), the Borsh size; it warns about an
  empty about, English alone, owner or revision given, a link too long for a QR code, and each permission nothing in
  the app's sources uses ("asks only for what it uses"). `grain profile` sets it: a QR code of `salt:grain-profile?p=…`
  for the owner's Saltix (waiting for the registry), or with `--key` signed at the registry's revision and one and sent
  as `SetGrainProfile`; `--clear` removes it. `grain show` prints the registry's profile and whether a wallet takes it.
  `grain connect-profile --origin --name --category --key [--owner] [--revision] [--out]` signs a website's profile for
  `/.well-known/saltix-connect`. `AGENTS.md`, every project's `AGENTS.md` (a ninth rule) and `docs/agents/app.md` (the
  Connect profile: how to write a good one) say so.
- **The simulator previews the Connect sheet** (Saltix 19-connect §12): before a grain opens, from `connect.json`
  (`grain dev` and `npm run dev` serve it at `/_connect.json`; `examples/hello-grain/connect.json`) and the manifest:
  "Saltix Connect", the identity, "In its own words", "To continue, sign in" with a row per permission (the address
  worded "It can follow your activity on the blockchain: balances, transfers, names", the address and notifications
  behind switches off by default), the privacy summary and links, Continue or Cancel (Back cancels), inside the page's
  frame below the controls' band. Continue records the sign-in and the switches; **Show it again** replays it.
- **`@saltix/connect`** (packages/connect, Saltix 19-connect §2–§5, §13): "Sign in with Saltix" for websites and
  DApps, the page's side of Saltix Connect ported from the explorer's tested `explorer/src/connect/`. `createConnect({
  network, relays, node, name, origin?, genesis? })` runs the session (keys, a link slot through relays the page reaches,
  the offer as text, link and QR code, `ConnectSeen`), checks the grant (rules 1–5, the account's key event log from the
  page's node) and keeps the connection 30 days in `localStorage`; events `offer`, `seen`, `checking`, `connected`,
  `refused`, `failed`, `reconnecting`, `disconnected`. `signInButton(el, { lang, theme, onClick })` and `connect.css`
  draw the button standard (Saltix's mark, navy or white, at least 44 px, radius a quarter of the height, classes only
  for a strict CSP); `openConnectDialog` shows the QR code titled "Saltix Connect" ("Scan with Saltix to sign in", on a
  phone "Open Saltix"); `readSiteProfile` reads a site's `/.well-known/saltix-connect` as a wallet does. Also one
  self-contained ES module, `dist/saltix-connect.js`, for a site without a bundler.
- **The Connect profile** (Saltix 19-connect §11, 12-grains §3 and §10; vectors `connect-v1.json` and
  `connect-profiles-v1.json` synced from the protocol's pull request 224): `@saltix/grain-server` reads, writes, signs and checks a
  service's own signed words about itself (`profile.ts`: `profileProblem` with the node's reasons, `encodeProfile`,
  `decodeSignedProfile` canonical only, `profileFromJson`/`signedProfileFromJson`/`profileToJson`, `signProfile`,
  `verifyProfile`, `checkGrainProfile`, `checkSiteProfile`, `checkProfileOwner`, `httpsLinkOk`, `supportOk`), the
  profile link `salt:grain-profile?p=` (`profileLink`, `readProfileLink`), the owner's `SetGrainProfile` call (tag 38:
  `GrainCall` `{profile: {slug, profile}}`, `RegisteredGrain.profile`), and key event logs checked offline
  (`keylog.ts`: `checkLog`, `keySpeaksFor`), a port of the explorer's. `@saltix/grain-server/web` exports what runs in a
  web page. Ed25519 signatures are now verified strictly, as the node does (`verifyEd25519`; a small-order key or a
  non-canonical encoding verifies nothing), and a Borsh string keeps a leading U+FEFF, as the node reads it.
- **The card design standard** (Saltix 22-grain-chats §4, §5a; vectors synced from the protocol's pull request 221): `card().code(text)`
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

- **A new page project starts sealed**: `grain init` names the bundle `public/` makes in `grain.json`, as `grain publish`
  will publish it, so `grain lint` has no placeholder host to warn of on every run and the simulator's Connect sheet
  never calls the code changeable. An older project's placeholder origin is still sealed by `grain publish`, and lint
  now says `grain bundle` seals it.
- **`grain dev --check` judges the navigation bar by what stays there**: the simulator measures each tappable element as
  the page opens and with everything scrolled to its end, and whether it is fixed or sticky to the bottom; such a pinned
  element is a warning when it is under the bar as the page opens, one that scrolls with the page only when it is still
  under the bar at the end. A button at a long page's fold is no longer a warning; a button fixed over the bar still is.
- **`grain icon`**: a mark on transparency goes on a light (`#dfe4ec`) or a dark (`#262d38`) ground, whichever leaves
  less of it faint, both apart from Saltix's white and its dark theme's `#121212` (were `#f2f4f7` and `#101820`, which
  vanished into one theme each), so a two-colour mark keeps both. The monogram is bolder (a stroke 0.24 of its height,
  was 0.17), with a tenth of it clear between two letters (they touched).
- The way without a phone is told once, in docs/how-it-works.md's *No phone, test network* (the steps, how long each
  takes, the access call and its window, who opens the app), and linked from the README, AGENTS.md,
  docs/agents/app.md and every project's AGENTS.md and README; one rule for who signs: a key file signs an owner's
  call by itself when its account owns the app, `--key` names one, `--wallet` asks Saltix.
- docs/protocol/basics.md: an account's transactions in nonce order, several at once, and the beacon chain's time for
  a registry call (08-node §2, 05-beacon §1, 06-licenses §4).


- **`grain publish` with nothing changed publishes nothing**: what the registry holds already is compared with what it
  would sign in the manifest's canonical form (the owner, the version and the relays' copies aside), never signed
  again, its missing uploads finished, and with none it says "nothing to publish" and exits 0; a version is raised only
  for a change of content (a node answers with its objects' keys sorted, so the JSON comparison raised the version and
  sent `UpdateGrain` every run). The development registry answers with sorted keys, as a node does.
- **A key file signs an owner's call only when `--key` names it**, or for an app the registry already names its account
  as the owner of (`publish`, `profile`, `access`, `configure`, `bind`); otherwise the owner's Saltix signs (a QR code),
  and `--wallet` always asks it. `grain init`'s `owner.key` no longer registers a free slug by itself. Every such call
  prints the account that will own what it makes before anything is signed; `--key` naming another owner's app is
  refused.
- **A registration by a key file is made private at once** (`SetGrainAccess`), as Saltix's New app makes an app; a
  first version a publishing link registers is public, and `grain publish` says so and how to make it private.
- **`grain status` says `not_needed` for a page alone** (exit 0, without asking the network) and names `grain doctor`;
  `grain doctor` ends with a page's words, and before a page's first publish names the slug's deposit, what `owner.key`'s
  account holds and, on the test network, `grain faucet --wait` and `grain publish --key owner.key`.
- `grain lint` says what the last `grain publish` left (published as it is, changed since, or ready to publish) instead
  of "ready to register"; it warns of `grain init`'s placeholder origin, and refuses (as `grain profile` does) a Connect
  profile's link to a host reserved for examples. `grain init`'s `connect.json` has no placeholder link, and its page
  links to the app by its slug outside Saltix (`slugLink`). `grain sign` refuses the placeholder origin.
- `grain show` for a free slug says the deposit and exits 0 (no `null`), and says the network, the version and the
  access of a registered one. Fees are said in SALT. `grain init` calls the key it prints the public one.
- esbuild 0.28 (0.24 had GHSA-67mh-4wv8-2f99 in its development server), its install script denied in `allowScripts`:
  `npm install` in the checkout warns of nothing.

- `grain bundle` needs no `--sources` (the network keeps the bundle); `--sources` only for hosts of the developer's own.
  `grain icon <png>` checks the icon as wallets do before it prints the hash, and refuses one they refuse.
- The icon standard is 512 × 512 (32-images §3): `grain lint`'s icon check is the image check, no longer "a 256 × 256
  PNG".
- The CLI depends on `pngjs` and `jpeg-js` (pure JavaScript) to read pictures.

- **Vectors synced** from the protocol's pairing change (`573525d`): `server-pairing-v1.json` is new; `grains-v1.json`
  gains `configure-v2`; `grain-chats-v1.json`'s member proof allows 5 minutes of clock skew in its own case.
- **The docs match the code and Saltix 0.1.54** (2026-10-17): `AGENTS.md`, `docs/agents/` and every project's
  `AGENTS.md` say what a page gets from Saltix (`grain_info`, four events, eight CSS variables, no design tokens; Saltix
  takes its band's colour from the page) and how to name apps and people (an eleventh rule: Saltix gives an app nobody's
  name); card examples put their status first; the CLI list, the test network's genesis, the build step, Saltix
  0.1.54's invoices and blocks, and the retired access grain are brought up to date.
- **A page's frame: safe by default, full screen only with `viewport-fit=cover`** (Saltix 12-grains §5, §7, §11, the
  owner's report of 2026-10-16: a page that knows nothing of insets went under Android's status bar). Saltix lays a page
  out inside the safe area, below the band that holds its controls, unless the page declares `viewport-fit=cover`; then
  edge to edge, and Saltix sets `--saltix-safe-*` and `--saltix-controls-*` on `:root` itself.
  - `@saltix/grain`: `viewportFitCover` (the declaration read as Saltix reads it: the last `viewport-fit`, ASCII
    case-insensitive, `,` `;` and whitespace between pairs), `viewportOf`, `frameFor` and `cornerDepth` (the frame a
    wallet gives, for tools that play one), `BAND`; `controls` may be `null` (inside the safe area) in `GrainInfo` and
    the `insets` event; `grain.layout()` warns once on the console (`COVER_GUIDANCE`) when a page in a wallet asks for its
    layout without declaring `viewport-fit=cover`.
  - The simulator frames the page as Saltix does, by its meta, and sets the variables on it (same origin): a phone of
    360 × 780 with a punch-hole, one on its side with the cutout on the left, the Galaxy Z Fold's three windows (the
    inner one with its taskbar) and an iPhone-like 393 × 852 with a Dynamic Island, the band in the page's colour and a
    line saying which frame it is. Its chrome's classes are its own (`sys-*`): the chat cards' `.bar`, `.status` and
    `.capsule` no longer restyle the status bar and the controls.
  - `grain lint`: nothing for a page without `viewport-fit=cover`; `cover-without-insets` for a page that declares it
    while nothing reads the safe area; `full-screen-top-bar` only in such an app, for a bar pinned to the top whose own
    rule keeps clear of nothing.
  - The rule line every report for an AI agent ends with, `AGENTS.md`, `grain init`'s `AGENTS.md`, `docs/agents/app.md`
    and `docs/first-app.md`: one rule set, "safe by default; full screen only with viewport-fit=cover and the insets".

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

- A managed account whose key event log holds a quorum signed under protocol version 2 failed the offline log check:
  every Connect grant and site profile it signed would have been refused once a network ran version 2.
- `grain configure` sent tag 34 on any network, which a version 2 network refuses, so revoking a developer key
  (`--revoke-all`) would have failed there too.
- `grain app-key make` suggested `grain configure --server <hex>`, which cannot be proven from version 2. It now names
  the key file.

- **Ctrl-C on `npx grain dev` left no `end` line in `.grain/log.jsonl`**: npm forwards the terminal's SIGINT to the
  command, which gets it from the terminal too; the handler went after the first signal, and the second killed the
  process before the line was written. The handler now stays for the life of the process, writes first, and ignores a
  second signal; SIGHUP (a closed terminal) ends the log too (exit 129). Every command, `grain publish`, `profile` and
  `access` waiting included.
- `--tap` said "ok tap tapped 9 buttons once each" beside a tap's error: the count is an "ok" line only when no tap
  failed, and `next:` says `grain dev --check --tap` again.
- `grain lint` said "no errors; ready to publish" with `connect.json` still `grain init`'s words, and for a page changed
  since a version published with `--no-wait`: its last line says what is left in doctor's words (`left: public/ changed
  since v1: grain publish seals v2`; `rewrite connect.json for this app`), and `grain publish` records a version it
  finds in the registry as published.
- Hints named `--key owner.key` for an app that key owns, which signs by itself, and the docs did not: one rule, no
  hint or page names it after the first publish (a key file elsewhere is named).
- The simulator's Connect sheet named the owner in hex ("by 0e4bcda5…"): a short address of the network, as Saltix.
- `grain doctor --json` and `grain status --json` gave `next: null` where the text said `nothing: …`: the same words.
- AGENTS.md's quick path, every page project's AGENTS.md and the README listed `npx grain dev`, a server that never
  returns, as a step: they say to run it in the background or not at all, and to check with `--check`.
- docs/agents/app.md explains the Connect sheet's "Payments and contacts" row, on every sheet whatever the manifest asks.

- **`grain doctor` said "published: the network holds its bundle" with nothing uploaded**: a relay that knows a
  bundle's or an icon's hash from the manifest answers `blob_get` with `{blob: null, fetching: true}` while it looks for
  the bytes, and doctor took that for held. Now `published` needs a relay that holds the blob, or an upload this
  computer saw a node take (`uploaded_at`, `icon_uploaded_at`, also recorded when `grain publish` finds them held);
  otherwise the upload is left and `next` is `grain publish`. The development registry answers `fetching` for a named
  blob nobody brought, as a node does.
- `grain doctor` said `next: nothing` while `public/` (or `grain.json`) had changed since the published version: a
  change not published is something to do, `grain publish`.
- `grain doctor`'s access line read "private: its owner alone open it", untrue for an app a key file owns: it says who
  opens it in the words `grain publish` ends with ("nobody opens it in Saltix yet", and the command that names a member).
- `grain doctor`'s first-publish fees left out the relays' sources `grain publish` adds on protocol version 1: they are
  the fees of the manifest as it will be sent.
- `grain publish` said "only its owner's account and the members it names open it" and then "nobody opens it in Saltix
  yet": who opens it is said once, at the end. With `--no-wait` it no longer says "this command waits for it".
- A first version the owner's Saltix registers from the publishing QR code is said to be private unless the owner
  switched on **Public in the Marketplace** on the sheet (Saltix 0.1.61 and later, saltix-wallet #411; an older Saltix
  registers it public: `grain access --private`), never "public from its first version"; the log's `access` reason for
  it is `wallet`.
- An owner's call with `--no-wait` sent a reader to `grain show`; it names `grain doctor`, which says when it landed.
- `grain dev --check` waits for a cold browser to answer (up to 45 s) before its first call, which on a busy CI runner's
  first launch timed out at 15 s (`Target.createTarget: no answer`).
- The steps' log as docs/devex.md has it: an owner's call signed with a key file logs `registry` (`set`, `not_landed`,
  `no_wait`), `grain profile` among them; an icon refused logs its reason (`alpha`, `hash`, …), not `checked`;
  `doctor` with nothing left logs `done`; a command stopped by Ctrl-C or SIGTERM logs its `end` (`grain dev`: `ok`, any
  other: `failed`, `sigint` or `sigterm`) and exits with the shell's status for the signal.
- `grain publish` with a key file no longer says "grain pair lets the bundle go up before the owner signs": there is no
  owner to wait for.
- The docs' "and a fee" (doctor showed none), "the Connect profile" before registration (doctor checked none), and the
  README's way without a phone, which missed `grain profile`.


- **The simulator opens a sealed page**: after `grain publish` sealed `grain.json`, `grain dev`'s simulator looked for its
  start page beside the manifest (`/.well-known/index.html`, a 404); it opens it from the bundle's root now
  (`devPageUrl`, in `@saltix/grain/rules`).
- **`grain help <command>` keeps each note whole**: the notes shared by commands were filtered line by line, so one
  command's help began a note in its middle (`notesOf`).
- The steps' log has `grain dev` (`serve`, `check`), `faucet` (`grant`, `wait`), `profile`, `show`, `lint` and `icon`
  steps and the network each reached; `publish` --key no longer says to keep running "until the owner has signed".
- `docs/first-app.md`'s page steps run `npm install` in the project before `npx grain`; `docs/agents/app.md` says
  `npm install`, a 512 × 512 icon and 16 MiB bundles.

- **Tests leave nothing in the temporary directory.** 146 directories a run (projects, bundles, keys, stores) stayed
  behind, filling developers' temporary directories and any shared runner's: every test now takes its directories
  from `scratch()` (`scripts/scratch.mjs`), removed after the file's last test, failed ones included. CI runs the tests
  with `TMPDIR` in a directory of the job's own and fails if they leave anything there (`scripts/ci-tmp.sh`); `tsc`'s
  module compile cache goes beside it (`NODE_COMPILE_CACHE`), and setup-node's `yarn --version` keeps none
  (`DISABLE_V8_COMPILE_CACHE`).
- **A chat project's spec starts at version 4**, above the 1 Saltix signs when it makes an app and the 3 the example
  serves: after `npm run example` on an app's key, a project that started at 2 was refused by the wallet holding 3, so
  its commands never reached Saltix (`CHAT_SPEC_FIRST_VERSION`, tested against the example's spec).
- **Every project `grain init` makes links the `grain` command**: a chat's `package.json` depends on the command line
  beside the server SDK, and a page project gets a `package.json` of its own, so `npx grain …` in a project runs this
  tool after `npm install` instead of falling through to the npm registry's unrelated package named `grain`.
- **A slug registered by another account** (an app made in Saltix, beside the `owner.key` `grain init` made) says to
  add `--wallet`, so the owner's Saltix signs.
- **The simulator plays by Saltix's rules** (`@saltix/grain/rules`, from the wallet's own `GrainBridge.kt`,
  `GrainContainer.kt`, `GrainStorage.kt`, `SealedSite.kt`, each a tested pure function): a payment, the app's chat, its
  page in the wallet and asking again for the address or notifications need a tap of the user within 5 seconds (the page
  says whether its tap is fresh: `navigator.userActivation`); what the manifest does not ask for is 4100; the app's page
  is for its team (by the development registry); each method has Saltix's rate, and only a method the bridge answers
  gets a bucket (`BridgeLimiter`: a made-up name is 4200 and costs nothing to keep); storage keeps keys of 1 to 128
  bytes, values of 60 KiB, 1 MiB an app; an answer over 64 KiB of JSON is the error 5000 and an event over it is dropped,
  as in Saltix (a relay frame over about 32 KB never reaches a page). A sealed grain signs in under its virtual origin
  (`https://<slug>.grain.invalid`), so `SignIns` with `sealedOrigin` takes it, and `grain dev` serves its pages with
  Saltix's Content-Security-Policy (`sealedCsp`). An invoice of a server key the development registry names pays the
  owner, as in Saltix. `grain dev` keeps a development registry (`/api/dev`, `/api/dev/access`, and `/api/dev/rpc`, a
  node's wallet interface for the app's own server; with `--app-key`, of its network and naming its key), so the
  simulator's sign-ins carry member proofs and the team's gate can be tried without `npm run dev`. `AGENTS.md`,
  `docs/agents/app.md` and the README say the limits.
- **A developer key's server refuses a chat spec of version 1** (`ChatSetupError` `chat_spec_version_starter`, exit 78):
  Saltix makes an app with a starting spec of version 1 that wallets keep until a higher one comes, so such a server's
  commands never appeared, and nothing said so. `docs/chats.md`'s example is version 2; every project's `AGENTS.md`
  (rule 2) and `docs/agents/app.md` say to serve 2 or more.
- **A member proof may end 5 minutes past 30 days** (`MEMBER_PROOF_AHEAD_MS`, `memberProofTimely`), the time a wallet's
  clock may run ahead of the server's, as the node's check allows with corvise/saltix `fix/node-review`: a server whose
  clock lagged called a fresh proof "expired", and the team's first sign-in failed. `testChat` and the simulator mint
  proofs at the full 30 days, as Saltix does. (The vectors' "+30 days + 1 ms" refusal moves when they are synced with the
  node change.)
- **`grain connect-profile` goes above the revision the site serves now**, read at `/.well-known/saltix-connect` as a
  wallet reads it, and above the file written before; when neither can be told it asks for `--revision N` instead of
  starting at 1, which a wallet keeping a higher revision never takes (`--offline`: the file only).
- **An account's registry calls one at a time**: a call signed with a key file (`publish`, `retire`, `configure`,
  `access`, `rate`, `bind`, `profile`) returns once it landed and the registry holds it (3 minutes at most), so the
  next is built above it (its nonce, a profile's revision); one the pool refuses for the account's earlier call still
  pending is built again once that landed. `--no-wait` returns once the pool took it (`--wait`, now the default, is
  still taken).
- **The vectors are the protocol's bytes, checked in CI**: `relay-v1.json` (the 24 profile-name vectors) and
  `grain-chats-v1.json` synced from corvise/saltix 4b431c1; `scripts/sync-vectors.sh` records each file's git blob id
  in `vectors/SOURCE` (from a clean checkout only), and `scripts/check-vectors.mjs`, run by CI, holds every file to it.
- **Ed25519 is verified as the node verifies it, everywhere** (security): `verifyLogin`, `SignIns`, chat requests,
  hellos, welcomes and messages, address records and key bindings, an app's numbers, sponsors' certificates and the
  development relay's mailbox acks checked signatures with `@noble/curves`' permissive `verify` (ZIP-215, cofactored), so
  a key of small order "signed" any message: the identity point, with R the identity and s = 0, signed in to any app
  under a pseudonym shared by everyone, with no wallet. Now all of them go through `verifyEd25519`, rewritten as an
  exact port of ed25519-dalek's `verify_strict` (the node's `ed25519::verify`): `s` below L, key and `R` canonical and
  not of small order, and `R` exactly `[s]B − [k]A` (a torsion part in `R` or in a key no longer passes a cofactored
  equation). `ed25519KeyValid` takes keys as the node's `is_valid_public_key` does, the few non-canonical encodings of
  points not of small order included. `ed25519.test.mjs` pins ed25519-dalek 2.2.0's verdicts on 12 crafted cases,
  every small-order point, the golden vectors' signatures, the review's proof of concept at every check, and that no
  module calls a library's `verify` again.
- **`ChatServer.member` (and so `SignIns.check`) throws `ChatMemberUnchecked` whenever the node does not answer**: a node
  down before the grain's registry record was read threw a plain `Error`, which servers answered with 500 instead of
  503 ("try again"). `ChatKeyNotRegistered` still ends the server; the warning `chat_signin_member_unchecked` names the
  reason. Every project's `AGENTS.md` (rule 10), `AGENTS.md` and `docs/agents/app.md` say to answer it with 503.
- **A Connect offer expires after 2 minutes even when a grant's check crosses the mark** (`@saltix/connect`): the
  expiry found the session `checking` and let it be, and a refused grant then left the offer up for the slot's 30
  minutes; anyone who saw the QR code could keep it alive so. A refusal after the mark now replaces the offer at once
  (in front of the visitor; in the background, once the page is in front again).
- **The page's check of a grant is the reference, and its edges are settled** (`verifyGrant`): it reads the node's
  status for each grant, so a node now on another network or chain refuses it (`network`) and one that names no account
  policy leaves even an empty log unchecked (`no_policy`), as the explorer did; the node is asked again only when it
  could not answer (unreachable, a timeout, HTTP 429, 502, 503, 504 or its JSON-RPC -32603, `retryable`), no longer
  after an answer that is no answer or any HTTP 5xx, and now after a busy node's -32603. `NodeUnreachable` gains the kind
  `http`; `VerifyDeps` no longer takes a `policy`. The explorer's `explorer/src/connect/` takes the same rules and the
  strict Ed25519 check (corvise/saltix, a pull request of its own).
- **A Connect grant is for display only** (docs): `Connection.grant` said it was kept "for a server that checks it
  again". A grant is a bearer artefact that answers no server's challenge; `docs/connect.md` (section 5), `store.ts` and
  `AGENTS.md` now say a server never takes it as a login, and what a server's own login would need (its own nonce, spent
  once).
- **An error report keeps the card standard** (docs/cards.md): its status was the error's name and message, up to 200
  characters, so every handler's failure made the server log `card_standard` (`status-length`), and a context with a
  version, a spec and a time gave 9 or more rows of fields. Now the status is a title of at most 60 characters cut at a
  word (`reportStatus`: `Error · TypeError`; the message when the name says nothing; `Refused · ` and a refusal's
  words), at most 8 rows are fields, and the rest lead the text as `Label: value` lines before the full message and the
  stack. Nothing is lost: the copy for an AI agent reads the same lines, its first one shorter. `examples/hello-grain`'s
  test now runs with reports on and holds the report to the standard too.
- **`grain.layout()` no longer overrides Saltix's CSS variables, nor freezes them after `stop()`** (Saltix 12-grains
  §5, §7): it wrote `--saltix-safe-*` and `--saltix-controls-*` into `:root`'s inline style, which beats the sheet Saltix
  keeps them in (a stale value from `grain_info` hid the frame script's newer one), and left them there after `stop()`,
  so later changes of Saltix's (a fold, a turn, a keyboard) never showed. Its values now go in a stylesheet of the
  page's own below Saltix's (`layoutSheet`: a constructed sheet first in `document.adoptedStyleSheets`, which a page's
  CSP does not refuse, or a `<style data-saltix-layout>` where a browser has none): they count only where Saltix sets
  none (a web wallet, an older Saltix, a plain browser), still win over the page's own fallbacks, and `stop()` removes
  them and nothing else. `layoutCss(layout)` gives the rule; `applyLayout`, the inline writer, is gone. Tests model the
  cascade with Saltix's frame script in place.
- **`grain.ready()` says what it does**: its doc said "the wallet hides its splash"; Saltix shows its splash only while
  the page loads and ignores `grain_ready` (12-grains §7). The doc says so, and the simulator, which held its splash
  until `grain_ready` (or 2.5 s after the load), now takes it away once the page has loaded and only logs the call.
- **The simulator draws the band in Saltix's colours, in Saltix's order** (12-grains §7, saltix-wallet `frame.js` and
  `AppFrame`): it read only the first `theme-color` (whatever its `media`) and only as a literal `#rrggbb`, then the
  body's background, and nothing after. Now the band takes `grain_setHeader`'s colour (held until the next call), else
  the page's: the first `theme-color` whose `media` matches and which is a valid, opaque CSS colour (read by a canvas,
  as Saltix does), else the background of `<body>`, then `<html>`, else `#121212` for a dark `color-scheme` and white
  otherwise; the margins take the page's colour; the status bar's icons and the controls contrast with the band's
  colour and the navigation bar's with the page's, dark or light by Android's luminance. It reads the colour when
  Saltix does: as the head is parsed and whenever it changes, on load, on a theme change and on the system's dark
  preference. The rules are `pageColorOf` and `frameColors` in `@saltix/grain`, unit-tested.
- **hello-grain's report card puts its status first**, as the card standard says (it came last, after the file and the
  invoice). `packages/server/test/example.test.mjs` runs every command of the example on `testChat` and holds each card
  to `assertCardStandard` and the server's own lint.
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

- **A spec changed under its version stops the server** (Saltix 22-grain-chats §2, the protocol's pull request 222: a wallet
  replaces the spec it holds only with a higher version). `ChatServer` keeps the highest spec it served in its store
  (`ChatStore.served`/`setServed`, the version and `chatSpecHash`, SHA-256 of the spec's Borsh; `fileChatStore` and
  `memoryChatStore` keep it) and refuses to start on a spec changed under that version or below it
  (`ChatSpecVersionError`, `code` `chat_spec_changed_under_version` or `chat_spec_version_lowered`, logged with the
  version served and `raise "version" above N`); `setSpec` is held to it, and takes the same spec again. Before, such a
  server started, answered, and its spec reached nobody who held that version. Saltix's access grain's own guard
  (`checkServed`) can move to it.
- **A developer key of another network exits with 78, not 1** (the test network was reset): systemd restarted such a
  server forever, though the docs promised 78. Every configuration refusal of `ChatServer.start` is now a
  `ChatSetupError` with a `code` and `exitCode` 78: `chat_wrong_network` (the key's network, or `chain`, against the
  node's), `chat_key_not_registered` (`ChatKeyNotRegistered` is one), `chat_spec_changed_under_version` and
  `chat_spec_version_lowered` (`ChatSpecVersionError`), `chat_no_relays`. `setupCannotWork(e)` (these and
  `AppKeyError`) and `EXIT_CONFIG`: the template's `server.mjs` and the example exit with 78 through it, 1 for anything
  else. The template's `AGENTS.md` rules say which setups exit with 78.

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
- **A test harness for an app's chat** (`@saltix/grain-server/testing`; `docs/devex.md` item 2): `testChat({ spec,
  setup | start, access, members, options, timeoutMs })` starts the app's handlers on a development relay and registry
  of its own with a development key, and gives wallets that ask as Saltix does — `t.ask(command, args, { lang })` with
  arguments typed by the spec (a request the spec does not allow is a `TypeError`, never sent), `t.say(text)`,
  `t.as("owner" | a member's name | anyone)` with the account's member proof for the owner and members, `hello()`,
  `unasked()`, `connect()` — and check every spec, card and welcome as Saltix does (a frame a wallet would refuse fails
  the test). Replies are read for tests: `text`, `fields`, `status`, `secrets`, `actions`, the `working` statuses they
  replaced. `t.registry` changes the registry at a new block (`setAccess`, `setServers`, `retire`), `t.logs` holds the
  server's log. The development relay moved from `scripts/dev-relay.mjs` (now a re-export) into the SDK with a registry
  of one grain: `@saltix/grain-server/dev` (`createDevRelay`, `createDevRegistry`). `grain init --chat` writes the
  handlers in `chat.mjs` (which `server.mjs` runs), `test/chat.test.mjs` and `npm test`; the template's `AGENTS.md` gains
  rule 8 (test every command end to end, never with a real key), as do `AGENTS.md` and `docs/agents/app.md`.
- **An app's numbers reach every node through its relay** (Saltix 22-grain-chats §4, 09-relay §3): `RelayClient.reportStats(signed)`
  sends the newest `SignedGrainStats` in a `grain_stats` frame and again whenever the client registers; the `stats`
  event carries the relay's answer (`{taken, slug, at}` or `{taken: false, reason}`), logged as `relay_stats_taken` or
  `relay_stats_refused`. The chat server reports each signing (at most hourly). The development relay keeps the newest
  numbers of each grain (`relay.stats`) and answers as a relay does.
- **The command line needs no node** (Saltix 09-relay §10.7; `docs/devex.md` item 4). Every registry command
  (`show`, `publish` and its QR code, `retire`, `configure`, `access`, `rate`, `bind`, `sponsor`, `app-key make`)
  reaches the network through its public relays' gateways by default (`--network devnet`, Saltix's test network), each
  pinned by the certificate its relay record publishes; `--relay wss://host:port/#<sha256>` (repeatable) names relays of
  your own, `--node URL` stays for your own node, and one command takes one of them. **`grain faucet [--key F |
  --address A] [--wait]`**: test SALT, and WORK while the purse holds some, from the test network's faucet
  (`faucet_request`), its refusals in words (`try again in 240 s`), `--wait` until it is in the account. In the server
  SDK: `grainGet`, `grainQuote`, `grantFor` and `findPayment` take a node's URL or any wallet interface (`NodeLike`,
  `nodeCall`); `RelayGateways` takes `{ discover: true }` (once the relays it knows cannot answer, it asks `relay_list`
  and tries the relays named, under their records' pins) and passes over a node that runs no faucet as over one that
  does not follow the shard; `publicGateways(network)`; `RpcError` carries the node's `reason` and `data`
  (`retry_after`). Checked live against the test network: `grain show` and `grain faucet --wait` for a throwaway key.
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
