# App studio: anyone makes an app in Saltix

> Reflects Saltix 24-app-studio (approved 2026-10-15; the launch, the app's home, the console, invites, Awaiting you
> and the Connect profile, 2026-10-15 to 2026-10-16; server keys that prove their holder, protocol version 2; pairing a
> server by QR code, 2026-10-19), as of corvise/saltix `44bbf728` (2026-10-20). Section numbers are the specification's.

Anyone makes an app in Saltix's **My apps**: names it, binds a username, pairs the computer that runs its program by a
QR code (the server key is made there and never leaves it) or, where no command runs, gets a **developer key**, and
opens its console at once. [docs/first-app.md](../first-app.md) walks through it; this page
is what lies under it: the registry's calls, the developer key, access and invites, and what Saltix does with an app.

## 1. What it adds

| Before | With the studio |
|---|---|
| A grain's server key is certified off chain for at most 31 days | the owner registers **server keys** in the registry; a wallet trusts a key the registry names, with no expiry, until the owner replaces it |
| A grain needs a web page | a grain may be **chat-only** (`Entry::Chat`): no origin, nothing to host |
| The chat spec is signed by the owner key only | a registered server key also signs it while every price in it is 0 |
| A grain is found by its slug | also by a **username** bound to it: `@name` opens its chat |
| Every slug's deposit is 100 SALT | the deposit depends on the slug's length (§5) |
| An invoice needs the owner key or a certificate | a registered server key signs invoices too, payable only to the grain's owner ([grains §5.2](grains.md#52-payments)) |
| A key made on the phone is copied to the server | the server's computer makes its key and **pairs** it by a QR code (§3a): the key never leaves it |

Certificates keep working for invoices, notifications and chats; a registered key is the better way for a server that
runs for months.

## 2. The registry

**`ConfigureGrain`** is the owner's call, value 0. It replaces the grain's server keys and its category as a whole:

```text
version 1 (every network today):  ConfigureGrain { slug: String, servers: Vec<[u8; 32]>, category: u8 }       tag 34
from protocol version 2:          ConfigureGrain { slug: String, servers: Vec<ServerKeyProof>, category: u8 }  tag 39
ServerKeyProof { key: [u8; 32], proof: [u8; 64] }
  proof = Ed25519 by `key` over derive("Saltix grain server v1", Borsh((genesis_hash, slug, owner: [u8; 32])))
```

- `servers` holds 0–4 distinct, valid Ed25519 keys; `category` is 0–9 (§6). An empty list removes every server key at
  once: that is the developer key's revocation. A key dropped is free for another grain from that block on.
- Each key may serve one live grain only; a key another live grain names is refused (`ServerKeyTaken`).
- **Why the proof (tag 39).** A key is public once a wallet sends it, and a managed owner's call waits its delay in the
  open: with bare keys, anyone could register the same key first for a grain of their own. With the proof, only the
  key's holder names it, for one network, one grain and one owner. A block of version 2 refuses tag 34.
- **Which tag.** Send tag 34 while the network's `node_status.protocol.version` is 1 and tag 39 from version 2 (`next`
  says when it changes): a transaction valid past the switch waits, or goes in the new form, and a managed owner's
  pending tag 34 that would take effect under version 2 is dropped. `grain configure` does this by itself: tag 34 while
  the network runs version 1, valid at most until the slot before a scheduled switch (and not sent in the last 30
  slots before it), tag 39 from version 2, each key's proof signed by its key file (`--server server.key`; a key given
  as bare hex cannot be proven and is refused then). The owner's Saltix names a key of a computer by pairing it (§3a),
  whose answer carries the proof. The vectors hold both forms (`grains-v1.json`, `configure` and `configure-v2`;
  [vectors/README.md](../../vectors/README.md)). When the registry answers `ServerKeyTaken` for a key a wallet made, it
  makes a fresh key.
- A managed owner's call waits like every grain call, and a quorum applies it at once. `grain_get` and `grain_list` show
  `servers` and `category`.

**A registered server key may**: sign chat messages and the grain's notifications without a certificate; sign the
chat spec while every command's price is 0; sign invoices whose `to` is the grain's owner account; and register at
relays as the grain's chat address (its personal address). A wallet checks a key against the grain's record as its
node reads it now: a key the owner removed is refused from the next block on, and the wallet drops anything it signs.

**`Entry::Chat`** (tag 2 of the manifest's `entry`) is a chat-only grain: no page, no origins; it opens its home (§4)
where another grain opens its screen, and asks for no bridge permission but `notifications`.

**`BindHandle { handle: Handle, slug: Option<String> }`** (tag 35, value 0), by the handle's holder, points a username
at a live grain the same account owns, or clears the pointer with `None` (which fails when there is none). `handle_get`
shows `app: slug`, and `grain_get` the grain's `handles`. A wallet opens the grain's chat for `@name` and shows the
grain's card. A transfer, sale or release of the handle clears the pointer, and so does retiring the grain. The handle
still resolves to its holder's account for payments.

## 2a. Access: private or public, and members

An app is **private** (its members only) or **public** (anyone), set at creation and changed by the owner at any time.
Development usually happens private.

**`SetGrainAccess { slug, public: bool, members: Vec<([u8; 32], Roles)> }`** (tag 36, value 0), by the owner, replaces
both fields: at most `MAX_MEMBERS` (64) members, no repeats, the owner not among them. A new grain is public, with no
members, no server keys and category 0, until its owner says otherwise. A member removed, or the app made public, takes effect at the block that
takes the call.

```text
Roles = a bit set, not 0:  1 user        uses the app while it is private
                           2 developer   holds a server key of the app and may sign its price-free specs
                           4 viewer      sees the app's page in My apps read-only: state, keys' fingerprints,
                                         members, spec; for review and audit
```

Bits combine: a developer who also tests is `user | developer` (3). **The team** is the owner and the members with the
developer or viewer role; a member with the user role alone uses a private app and is not on its team.

**Proving membership.** A grain key tells the app nothing about the account, so a member's wallet adds a **member
proof** ([grain chats §3](grain-chats.md#3-requests-what-the-user-sends)) to every request to a private app, and every
team member's wallet to every request to its app, public or private, and to the sign-in to the app's page
([grains §5.1a](grains.md#51a-the-teams-sign-in-check-first-render-after)). The server of a private app takes a request
only if the proof's `grain_key` is the request's key, the proof is unexpired and ends at most 30 days and 5 minutes
after the server's clock, signed by a key that speaks for `account` now, and `account` is the owner or a member with
`user` or `developer`. Everyone else gets a refusal and nothing more.

A public app never asks for a proof and a user's wallet never sends one, so a public app keeps not knowing its users.
Joining a private app, or an app's team, tells the owner who the user is; the wallet says so first ("this app will know
your account").

**In the wallet**: a private app is not in the marketplace and its usage numbers are not published; a link to it opens
a card that says it is private; only its owner and members may add its chat, and anyone else is offered to enter an
invite; My apps lists the apps the account is a member of under **Shared with me**.

**Developers** get their own server keys: the owner adds a developer, and Saltix makes a key, registers it
(`ConfigureGrain`) and sends the developer key in their 1:1 chat, end to end. Each developer's key is replaced or
revoked alone; the four server keys are shared among the owner's own servers and the developers.

### 2a.1. Invites

The owner adds a member either by signing `SetGrainAccess`, or by making an **invite**: a link the owner shares, which
the person opens to join. The two wallets do the rest; the app's server takes no part.

```text
AppInvite   { slug: String, owner: [u8; 32], roles: u8 (not 0), id: [u8; 16], secret: [u8; 16], expires_at: u64 (Unix ms) }
JoinRequest { slug: String, invite_id: [u8; 16], account: [u8; 32], mac: [u8; 32] }
JoinAnswer  { slug: String, invite_id: [u8; 16], result: u8 }     0 added, 1 used, 2 expired, 3 unknown, 4 refused
key  = derive("Saltix app invite v1", genesis_hash ‖ secret)
mac  = BLAKE3-keyed(key, Borsh((slug, invite_id, account)))
link = "salt:grain/" slug "?invite=" base64url-without-padding(Borsh(AppInvite))
1:1 message plaintext: {"cmd":"app_join","request":"<base64url of Borsh(JoinRequest)>"}
                       {"cmd":"app_join_answer","answer":"<base64url of Borsh(JoinAnswer)>"}
```

- **A link is a bearer secret**: whoever holds it may join, once. It lives at most `INVITE_LIFE_MAX` (30 days). Nothing
  about an invite goes on chain, where its secret would be public. The owner may withdraw it until it is used.
- **Joining**: the joiner's wallet reads the invite strictly and checks that it is unexpired, that the registry's record
  of `slug` is live and names `owner` as its owner (a link whose owner differs is refused), and whether the account
  already holds every role it gives. On **Join** it sends a `JoinRequest` (`account` its own, `mac` from the link's
  secret, which never leaves the phone) to the owner's address as a kept 1:1 message, sealed end to end; the request's
  sender is the relay's `from`.
- **The owner's wallet** answers, in order: `unknown` (no such invite); `refused` (the sender is not `account`, or the
  MAC does not check, compared in constant time); for a used invite `added` again to the account that used it, `used`
  to anyone else; `expired`; otherwise it marks the invite used and adds the account with the invite's roles by
  `SetGrainAccess` (the union with roles it already has), alone where the phone may sign alone, else after asking the
  owner; it answers `refused` when the call cannot be made (the app retired, or 64 members). For a developer it also
  makes and sends a developer key.
- **Reading strictly**: the canonical form only; no trailing bytes, a slug that is a grain's, roles of the bits 1, 2
  and 4 only, a result of at most 4. In a link no padding, no spare bits, no further parameter, and the path's slug the
  invite's; white space around the link is allowed. An invite is usable at `now` while
  `now < expires_at ≤ now + INVITE_LIFE_MAX + INVITE_SKEW` (5 minutes). The MAC's key is bound to the network.
- These are wallets' messages, not chat messages: an app never sends or reads them. The protocol's own vectors hold
  them (`app-invites-v1.json`); this repository does not copy that file, since no SDK code makes or reads an invite.

## 3. The developer key

A grain's server key, handed to whoever builds the app, as one string:

```text
saltix-app:1:<hrp>:<genesis>:<slug>:<secret>
```

- `hrp` is the network's address prefix (`dsalt` on the test network) and `genesis` the first 8 bytes of its genesis
  hash in lowercase hex (16 characters); `slug` the grain's; `secret` the server key's Ed25519 secret, 32 bytes in
  lowercase hex (64 characters).
- Read strictly: exactly that form, lowercase hex, a known prefix, a valid slug, white space only around it.
- The SDKs take it as their whole configuration: they find the network's relays, check that the key is for the
  network they reach (`isFor`) and that the registry names it for the slug, derive its messaging key
  ([grains §5.5](grains.md#55-notifications)) and serve the chat. A network reset changes the genesis, and a key of the
  old one is refused.
- **It is a secret.** Whoever holds it speaks for the app until the owner replaces the key. Saltix shows it masked,
  copies it only on purpose, marks it sensitive for the clipboard and never logs it; it shows it again only after the
  account's PIN. Never commit, print, log or paste it into a chat.
- **Rotation**: **Replace the key** makes a new key and sends `ConfigureGrain` with it alone (the old one stops being
  trusted at the block that takes the call); **Revoke** sends an empty list.
- A developer key never controls the grain: updating the manifest, retiring the grain and the deposit stay with the
  owner's account. It may ask users to pay, and only the owner; each payment is still the user's to approve.

The SDK: `AppKey.parse` (strict; its errors never quote the text), `AppKey.of`, `isFor`, `describe`; `grain app-key`.
`vectors/grains-v1.json` (`app_key`).

Since 2026-10-19 the developer key is the fallback for a host where no command runs: a program's computer pairs a key of
its own (§3a), and `app.key` then holds that key in this same form.

## 3a. Pairing a server by QR code

The key is born on the computer that runs the app's program, and its secret never leaves it. The computer shows an
**offer**; the owner's Saltix scans it, checks with the computer through the relays, and names the key in the registry.

```text
PairingOffer { version: u8 (1), hrp: String, genesis: [u8; 8], key: [u8; 32], nonce: [u8; 16],
               slug: Option<String>, name: String, created_at: u64, expires_at: u64 }     Borsh, Unix ms
link = "salt:grain-pair?o=" base64url-without-padding(Borsh(PairingOffer))
code = the first 4 bytes of BLAKE3-derive_key("Saltix grain pairing code v1", Borsh(offer)), big-endian, mod 1 000 000
```

- `hrp` and `genesis` name the network as the developer key does; `key` is the server key's public half; `nonce` is
  random, the offer's id; `slug` the app the project is set up for (none: the owner picks one, or makes one); `name`
  what to call a new app (at most 32 characters, none of Unicode `Cc`, `Cf`, U+2028, U+2029; may be empty). It lives
  at most 30 minutes (`PAIR_OFFER_LIFE`); a wallet takes one made at most 5 minutes ahead of its clock.
- **Nothing in it is secret, and nothing in it is signed.** The computer proves it holds the key in its answer, with the
  proof a version 2 `ConfigureGrain` needs, which names the app and the owner: a signature made before it knew them
  could be copied by anyone into a call of their own.
- **The code** (six digits, shown `482 913`) is on both screens: Saltix asks the owner to pair only if they match, so
  a stranger's offer ("scan this to set up your app") is told apart. A key's **fingerprint**, wherever keys are told
  apart, is its first 4 bytes in lower-case hex.
- A paired key is a registered server key like any other (§2): it speaks in the app's chat, signs its price-free
  specs, its notifications and invoices payable to the owner only. It never controls the app or moves money.

**The exchange.** `"SGP1" ‖ Borsh(PairFrame)`, sealed as grain frames are and kept in the mailbox: the owner's grain
alias in the app sends `PairRequest { offer: [u8; 16] (the nonce), slug, owner: [u8; 32] }` to the offer key's
personal address, and the computer answers `PairAnswer { offer, slug, owner, result: u8, proof: Option<[u8; 64]> }`,
results `0 accepted` (with the key's `ServerKeyProof.proof` for that slug and owner, §2), `1 used`, `2 expired`,
`3 unknown`, `4 other_app`, `5 not_owner`. The computer answers in this order: another offer's nonce, `unknown`;
answered already, `accepted` again for the same slug and owner and `used` for any other; expired; the offer names a
slug and the request another, `other_app`; the registry holds the slug for another account, or retired, `not_owner`;
else `accepted`. A reader refuses another magic, trailing bytes, an unknown tag or result, a slug that is no app's, and
a proof with any result but `accepted` (or none with it). Saltix takes an answer only for its request in flight, an
accepted one only with a proof that verifies; it waits 2 minutes (`PAIR_ANSWER_WAIT`). Then the PIN and
`ConfigureGrain`: **Add this server** puts the key first, where the app's chat goes; **Use only this server** names it
alone. An app the owner does not have yet is made in the same confirmation, private, named by the offer's name.

On the computer, the key's secret is made there and kept in a file only its owner reads, never printed, logged or sent;
the computer answers requests only while it shows the offer, and one app and one owner per offer; and it takes itself as
paired only for the slug it offered or the developer confirmed, once the registry names its key for that slug at its
view of the canonical beacon tip. An offer seen by someone else lets them ask first, for an app of their own: that costs
the developer a new offer and nothing else, so an answer for an app the developer never named pairs nothing (the SDK:
`grain pair --accept S` confirms it, `grain pair --new` makes a new key and offer). The program the computer runs
refuses to start until it is paired, saying to run `grain pair`.

The SDK: `makeOffer`, `encodeOffer`/`decodeOffer`, `offerLink`/`parseOfferLink`, `offerProblem`, `offerCode`,
`offerCodeText`, `offerAddress`, `keyFingerprint`, `encodePairFrame`/`decodePairFrame`, `judgePair`, `answerPair`,
`checkPairAnswer`, `signServerKeyProof`/`verifyServerKeyProof`; `grain pair`, `grain status`, `grain doctor`
([docs/first-app.md](../first-app.md)); `appKeyFromEnvironment`, a server's refusal to start unpaired
(`chat_unpaired`). `vectors/server-pairing-v1.json`.

## 4. In Saltix: My apps

What a developer can rely on of how Saltix presents an app.

- **New app**, step by step, each step saying what it costs before the user signs: a name (at most 32 characters); the
  slug, checked as typed (free, taken, retired) with its deposit; a username (none, one the account holds, or a new one
  minted on the spot); a category, a description (200 characters) and the **Connect profile**, previewed exactly as a
  user will see it ([connect §11](connect.md#11-the-connect-profile)). **Create** makes a chat-only manifest (no
  server key on the phone, since 2026-10-19), then sends `RegisterGrain`, `SetGrainAccess` (for a private app),
  `ConfigureGrain` with the category (and a paired key, when the app is made from a pairing offer), and
  `SetGrainProfile` (revision 1); then signs, with the owner key, a starting chat spec of **version 1** with an intro
  and no commands (a developer's spec starts at version 2, since a wallet takes only a higher version); then binds the
  username. At the end: **Pair a server** (`grain pair` on the program's computer, §3a), or, for a host where no
  command runs, a developer key made then and shown once.
- **An app being made is locked** until every step is in the registry: its page and a launch show only the steps'
  states, and no developer key, console or members.
- **A tap launches, a long press manages.** A launch opens the first that applies: the creation's steps; a notice that
  the app is retired; its screen (hosted or sealed) in the wallet's container; or, for a chat-only app, its **home**. A
  launch never opens the chat, which is the conversation's history, reached from the home, the ⋯ sheet, the
  messenger's Apps tab and a notification. A private app the account may not use says so, whatever its form, before
  anything of it is fetched.
- **The app's home** is Saltix's own screen for a chat-only app, drawn natively from its signed chat spec, edge to edge
  with the wallet's controls: a header (icon, name, username, address, mark and state: running, silent since a date,
  no program yet, retired; a look-alike's warning); the commands as large buttons in the reader's language, each
  opening its native form, checked against the spec before anything is signed, the answer's card shown on the home;
  the latest answers and unasked messages; **Chat**; and, for the team, **Manage**. While the program was never seen,
  it says so plainly, and a request still waits in the app's mailbox for up to 7 days.
- **The program seen.** A wallet takes a chat-only app's program as seen at the latest of: the `at` of the newest
  reported numbers it holds that check; the `at` of the newest message from the app's server that checks; the moment
  the relays last said the app's chat address is online (`status`). Not seen for more than `APP_SILENT` (2 days), the
  home, the chat and the manage page say "silent since <date>". So a running program keeps its numbers signed or
  answers: the SDK's `ChatServer` stays registered, and the relays report it online.
- **Awaiting you.** What waits for the owner's signature lives on the app, for the owner only: an update the app's
  program proposed (a `Publish` card, the highest version proposed while the registry holds a lower one), joins by
  invite the phone cannot sign alone. A badge on the app's row, a dot with the count on ⋯, and the manage page's first
  section; a new item posts one system notification.
- **The manage page**: Awaiting you; Program (seen when, the developer keys, replaced or revoked by the owner); Screen
  (a developer adds one by publishing a page, the owner approves the manifest); Chat (the console); Members; Access;
  Username; Details (name, description, category, as a new manifest version); Connect profile (saving sends
  `SetGrainProfile` with the next revision); and a danger zone, **Retire for good**, confirmed by typing the slug. A
  viewer sees it read-only. A grain's page may open it for its team (`grain_manage_open`).
- **The console.** The chat of an app whose team the account is on is that app's **console**. The app writes there as
  to any user: answers, and unasked messages within a budget of 100 a day to each member (in any 24 hours,
  notifications included), for error reports and feedback,
  and its update proposals. Its server learns where each member's chat is from the proof on their requests and from
  their wallets' hellos ([grain chats §3a](grain-chats.md#3a-the-hello-the-team-introduces-itself)): when the app is
  made, when an account joins its team, and when the app is opened. Nobody has to write first. Saltix writes its own
  **notices** there, drawn apart and marked as Saltix's, never sent anywhere: the app created; a developer key made,
  replaced or revoked (never the key); the program's first answer, and the program silent; new ratings; members and
  access changed; the app retired.
- **Copying for an AI agent.** Any message copies as text, or for an AI agent: a header, then the message as text, then
  the rules of an app's frame:

  ```text
  Saltix app console · <slug> · message <id in hex, or "notice"> · <UTC time, ISO 8601> · app version <the registry's version>
  from <slug>, verified | from Saltix
  a text as it is; fields as "label: value" lines; a status as "[working|done|refused|failed] text";
  a file as "file: <title> (<format>, <size>)"; an invoice as "invoice: <amount> <asset>, <memo>"; actions as "→ <label>"
  Saltix lays an app's page inside the safe area; full screen only with viewport-fit=cover: then pad by
  grain_info.safe_area, keep tappable content clear of grain_info.controls, test at 475×751, 704×932 and 932×704 dp
  in `grain dev` (saltix-grains AGENTS.md).
  ```

  A Secret block is never copied in either form: it reads `[secret: <label>, not copied]`.
- **The messenger's Apps tab** lists apps' chats apart from people's: **Your apps** (the consoles), the apps the account
  uses, retired apps last. **+ → Chat with an app** takes an app's `@username`, its link, an invite's link, its slug or
  a QR code, and shows the app's card first; its chat is added only when the user starts it.

## 5. The deposit

| Slug | Deposit |
|---|---|
| 3–5 characters | 100 SALT |
| 6–7 characters | 30 SALT |
| 8 or more | 10 SALT |

It returns 30 days after `RetireGrain`. A `RegisterGrain` sends at least the slug's deposit; the registry keeps up to
100 SALT and returns anything above at once. Send the deposit exactly: `grain_get` answers it as `deposit` for any slug,
beside `grain` (`null` for a free slug). Grains registered before deposits went by length keep what they paid. The SDK:
`grainDeposit(slug)`, `grainQuote`.

## 6. The marketplace

The **Marketplace** lists the registry's live public grains: search by name and slug, categories, and each grain's card
(name, icon, username, owner, verified or listed, chat or screen, how long it has been registered, its Connect profile's
tagline). A tap launches an app, a long press shows its card. The wallet's listing policy decides what it features; the
registry judges no content.

**Categories** (`category`): 0 other, 1 tools, 2 finance, 3 social, 4 games, 5 shopping, 6 education, 7 news,
8 business, 9 developer.

## 6a. Statistics and ratings

The marketplace shows two kinds of facts and never mixes them.

**Checked on chain: ratings.** `RateGrain { slug, score: u8, review: String }` (tag 37), by any account but the owner,
value 0 plus its fee: `score` 1–5, or 0 to withdraw the rating (of a live or retired grain; it fails when there is
none); `review` at most 140 characters with no control characters, possibly empty. One rating per account and grain;
the latest counts. The registry keeps each rating with its slot and whether the account held an active citizenship
then, and per grain the count and sum of scores, overall and of citizens' ratings, which the card shows apart ("4.6
from 23 citizens"). A review is shown without Unicode `Cc` and `Cf` characters and the line and paragraph separators
(`grain_ratings` gives it so). A rating is public and names its account. In an app's chat, a user who sent it requests
on at least three different days may rate it from the chat's menu. Besides: the slots of registration and last update,
the number of versions, the owner (with a username if bound), the owner's other apps, the verified mark.

**Reported by the app**, shown as "reported by the app", never as fact:

```text
GrainStats       { slug: String, at: u64 (Unix ms), users_1d: u32, users_30d: u32, requests_30d: u64 }
SignedGrainStats { stats, key: [u8; 32], signature: [u8; 64] }
  by a registered server key over derive("Saltix grain stats v1", genesis_hash ‖ Borsh(stats))
```

The SDKs count distinct grain keys that sent a request in the last day and the last 30 days, publish at most once an
hour, and keep nothing per user beyond the window. A wallet shows numbers signed by a key the registry names, at most 2
days old and 5 minutes ahead, with `users_1d ≤ users_30d ≤ requests_30d`. They reach the marketplace and the explorer through the relays, never the chain: the server hands them to its
relay (`grain_stats`), nodes check and keep them, and any node answers `grain_stats {slug}` and
`grain_stats_list {sort?, after?, limit?}` (`sort: "users"`: the most used first). **Only a public app's numbers are
published**: a private app's server hands none to its relay, and nodes refuse and drop them.

The wallet interface: `grain_get` and `grain_list` show `ratings {count, sum, citizens_count, citizens_sum}`;
`grain_ratings {slug, after?, limit?}` lists ratings newest first ([wallet interface](wallet-interface.md#methods)).

## 8. Parameters

| Parameter | Value |
|---|---|
| Server keys per grain | at most 4 |
| `MAX_MEMBERS` | 64 |
| A member proof | at most 30 days, by the wallet's clock; a reader allows 5 minutes of skew |
| `INVITE_LIFE_MAX` | 30 days; a reader allows its clock to be 5 minutes behind the maker's (`INVITE_SKEW`) |
| An invite link | `salt:grain/<slug>?invite=<base64url of Borsh(AppInvite)>`, one use |
| Unasked messages | 100 a day to each member of the team (`CHAT_UNASKED_TEAM_PER_DAY`), 10 to anyone else, in any 24 hours, notifications included |
| `APP_SILENT` | 2 days |
| Deposit | 100 / 30 / 10 SALT for slugs of 3–5 / 6–7 / 8+ characters |
| Categories | 0–9 |
| Developer key | `saltix-app:1:<hrp>:<16 hex>:<slug>:<64 hex>` |
| `PAIR_OFFER_LIFE` | 30 minutes; a wallet takes an offer made at most 5 minutes ahead of its clock (`PAIR_SKEW`) |
| `PAIR_ANSWER_WAIT` | 2 minutes |
| A pairing offer | `salt:grain-pair?o=<base64url of Borsh(PairingOffer)>`; a 6-digit code; a new app's name at most 32 characters |

## 9. Wire shapes

**Registry calls** (in `Action::Registry { call, amount }`, value 0):

| Call | Tag | Fields |
|---|---|---|
| `ConfigureGrain` (version 1) | 34 | `slug: String`, `servers: Vec<[u8; 32]>`, `category: u8`; refused from protocol version 2 |
| `BindHandle` | 35 | `handle: Handle`, `slug: Option<String>` |
| `SetGrainAccess` | 36 | `slug: String`, `public: bool`, `members: Vec<([u8; 32], u8)>` |
| `RateGrain` | 37 | `slug: String`, `score: u8`, `review: String` |
| `SetGrainProfile` | 38 | `slug: String`, `profile: Option<SignedConnectProfile>` ([connect §11](connect.md#11-the-connect-profile)) |
| `ConfigureGrain` | 39 | `slug: String`, `servers: Vec<ServerKeyProof { key: [u8; 32], proof: [u8; 64] }>`, `category: u8`; from protocol version 2 |

- `ConfigureGrain`, `SetGrainAccess`, `SetGrainProfile` and `BindHandle` are guarded: a managed account's single signer
  only registers them as pending. `RateGrain` is not.
- A node refuses before a call enters a block: a bad slug; more than 4, repeated or invalid keys, or (tag 39) a proof
  that does not verify; a category above 9; more than 64 or repeated members, the sender among them, roles 0 or above
  7; a score above 5, or a review of more than 140 characters or with a control character.
- The registry refuses besides: not the owner; an unknown or retired grain (a withdrawal of a rating excepted); a key
  another live grain names; the owner rating its own grain; withdrawing no rating; a handle the sender does not hold,
  or clearing a pointer that is not there; a profile that is not the grain's owner's or not in bounds (`BadProfile`),
  of a revision not above the highest the grain took, even after a clear (`StaleProfile`), or clearing none
  (`NoProfile`).

**The wallet interface**: `grain_get` and `grain_list` show `servers`, `category`, `public`, `members`
(`[{account, roles}]`), `handles`, `ratings`, `profile` (the signed Connect profile's JSON form, or `null`) and
`profile_revision`; `grain_get` also answers `deposit`. `grain_list` takes `category` and `owner` or `member`, and lists
public grains otherwise. `handle_get` shows `app`.

**Chats**: the formats of [grain chats](grain-chats.md). Notifications and invoices keep their encoding: `cert: None`
means the owner key or a registered server key, which a wallet tries in turn; an invoice a registered key signed pays
only the grain's owner, and a retired grain takes none.
