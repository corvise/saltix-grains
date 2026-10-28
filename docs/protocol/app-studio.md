# App studio: anyone makes an app in Saltix

> Reflects Saltix 24-app-studio (approved 2026-10-15; the launch, the app's home, the console, invites, Awaiting you
> and the Connect profile, 2026-10-15 to 2026-10-16; server keys that prove their holder, protocol version 2; pairing a
> server by QR code, 2026-10-19), as of corvise/saltix `44bbf728` (2026-10-20); the pool vocabulary (miners' ratings,
> `miners_count`, `miners_sum`) as of corvise/saltix `e6448704` (2026-10-22); pairing a server, version 2, and the
> developer key retired (§3, §3a) as of corvise/saltix `5c045a9f` (2026-10-28). Section numbers are the specification's.

Anyone makes an app in Saltix's **My apps**: names it, binds a username, pairs the computer that runs its program by a
QR code (the app's page shows one command naming the app, the owner and the network; the server key is made on that
computer and never leaves it, and the owner scans, compares the code and confirms), and opens its console at once.
[docs/first-app.md](../first-app.md) walks through it; this page is what lies under it: the registry's calls, pairing
a server, the developer key (retired), access and invites, and what Saltix does with an app.

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

**Developers** get their own server keys: a developer pairs their own computer (§3a) — they run `grain pair` with the
app's command, and the owner scans and confirms. Each developer's key is replaced or revoked alone; the four server
keys are shared among the owner's own servers and the developers.

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
  asks them to pair their computer (§3a).
- **Reading strictly**: the canonical form only; no trailing bytes, a slug that is a grain's, roles of the bits 1, 2
  and 4 only, a result of at most 4. In a link no padding, no spare bits, no further parameter, and the path's slug the
  invite's; white space around the link is allowed. An invite is usable at `now` while
  `now < expires_at ≤ now + INVITE_LIFE_MAX + INVITE_SKEW` (5 minutes). The MAC's key is bound to the network.
- These are wallets' messages, not chat messages: an app never sends or reads them. The protocol's own vectors hold
  them (`app-invites-v1.json`); this repository does not copy that file, since no SDK code makes or reads an invite.

## 3. The developer key

**Retired 2026-10-28.** A developer key was a bearer secret: Saltix made it on the phone and handed it over, and it
travelled — a clipboard, a chat, an agent's prompt — to a server, where whoever held it was the app. The owner's rule of
2026-10-28 (§3a) allows no such secret anywhere: a server's key is born on the server and paired by a QR code, and a
host where no command runs is where the program's own first start runs `grain pair` once (its console shows the QR code
as any terminal does). So:

- Saltix stops offering the key: no new developer key is made; New app's last step and the manage page show the pairing
  command instead (§4).
- **Keys in use keep working** until their owners pair a server in their place: the registry does not know how a key
  was born, and a key removed by its owner stops as before. The manage page shows such a key as *made on this phone*
  with its fingerprint and says to pair a server in its place. The SDK reads the key's form (below) while such keys
  exist, and says at start (`appKeyFromEnvironment`'s `DEVELOPER_KEY_WARNING`, for a key `app.json` does not name:
  `keyPairedHere`) and in `grain status` and `grain doctor` to pair instead.
- **Services of the app's own take no token either**: a service an app's program talks to authenticates the app by a
  request signed with its registered server key and checked against the registry, never by a token carried to the
  server.

The form, for the readers of a key still in use:

```text
saltix-app:1:<hrp>:<genesis>:<slug>:<secret>
```

- `hrp` is the network's address prefix (`dsalt` on the test network) and `genesis` the first 8 bytes of its genesis
  hash in lowercase hex (16 characters); `slug` the grain's; `secret` the server key's Ed25519 secret, 32 bytes in
  lowercase hex (64 characters). Read strictly: exactly that form, lowercase hex, a known prefix, a valid slug, white
  space only around it.
- The SDK takes it as the server's whole configuration: it finds the network's relays, checks that the key is for the
  network it reaches (`isFor`) and that the registry names it for the slug, derives its messaging key
  ([grains §5.5](grains.md#55-notifications)) and serves the chat. A network reset changes the genesis, and a key of the
  old one is refused. `app.key`, which `grain pair` writes once the registry names a paired key, holds that key in this
  same form: a file's form, never carried anywhere.
- **It is a secret.** Whoever holds it speaks for the app until the owner replaces the key. Never commit, print, log or
  paste it into a chat.
- **Rotation**: pair a server (§3a) with **Replace the other servers**, or pair one and remove this key in the manage
  page. A developer key never controls the grain: updating the manifest, retiring the grain and the deposit stay with
  the owner's account. It may ask users to pay, and only the owner; each payment is still the user's to approve.

The SDK: `AppKey.parse` (strict; its errors never quote the text), `AppKey.of`, `isFor`, `describe`; `grain app-key`;
`appKeyFromEnvironment`, `keyPairedHere`, `DEVELOPER_KEY_WARNING`. `vectors/grains-v1.json` (`app_key`).

## 3a. Pairing a server by QR code

**The rule (the owner, 2026-10-28; version 2).** Connecting a server — or a developer's AI agent — to an app is *scan
the QR code, compare the code, confirm with the PIN*, and nothing else. No secret is ever shown, copied, pasted or
carried between machines. A developer copies one command (or a prompt for an agent) from the app's page, and it holds
only public data. Nothing about it depends on a manual step by the owner.

**The key is born on the computer where the program runs, and its secret never leaves it.** The computer shows a QR code
of the key's public half with the key's own proof for the app and its owner; the owner's Saltix scans it, checks
everything by itself and names the key in the registry; the computer watches the registry and starts. Version 2 drops
version 1's exchange through the relays (*Version 1*, below): no frame travels either way.

### The command

The app's page in Saltix — the manage page's **Servers**, and New app's last step — shows one command for the computer
that runs the app's program, and a **prompt for a coding agent** that carries the same. It names three public facts,
which the registry holds for every app:

```text
grain pair --app <slug> --owner <the owner's address> --genesis <the first 8 bytes of the genesis hash, 16 hex digits>
```

- The syntax is the SDK's; the three fields are the protocol's: without them the computer cannot make the offer. A
  reader takes the three flags once each in any order, with white space free, and nothing else; the genesis is 16
  lower-case hex digits; the address any kind's, of a known network, its id the offer's `owner` (`PairTarget`,
  `pairCommand`, `parsePairCommand`; refused: `not_pairing`, `malformed`, `slug`, `unknown_network`). A project paired
  once keeps the fields, so `grain pair` there needs no arguments; for an app the registry holds, the SDK reads the
  owner from the record when the command names none. Nothing in the command is secret, and the page shows nothing
  else: no key, no token.
- A **new app** may be paired before it is registered: the command names the slug the owner will register, and Saltix
  registers it in the same confirmation. The developer makes nothing up: the command comes from the owner's page, or
  the owner's words.

### The offer

`grain pair` makes an Ed25519 server key in the app's project, or keeps the one an earlier offer made that was never
paired; signs the key's **proof** for the app and its owner — the very `ServerKeyProof.proof` a version 2
`ConfigureGrain` needs (§2) — and shows an **offer**: a QR code in the terminal (it works over SSH and in a coding
agent's output), the same as a link, a page with the QR code, and the offer's **code**.

```text
PairingOffer {                    Borsh; in a QR code and a link, never secret; version 2
  version:    u8                  2
  hrp:        String              the network's address prefix: "salt", "tsalt" or "dsalt"
  genesis:    [u8; 8]             the first 8 bytes of its genesis hash
  key:        [u8; 32]            the server key's Ed25519 public key
  nonce:      [u8; 16]            random: the offer's id
  slug:       String              the app
  owner:      [u8; 32]            the owner's account (AccountId)
  proof:      [u8; 64]            ServerKeyProof.proof (§2): Ed25519 by key over
                                  BLAKE3-derive_key("Saltix grain server v1", Borsh((genesis_hash, slug, owner)))
  name:       String              what to call this server: at most 32 characters, or ""
  created_at: u64                 Unix ms
  expires_at: u64                 Unix ms, after created_at and at most PAIR_OFFER_LIFE (30 minutes) after it
}
link = "salt:grain-pair?o=" base64url-without-padding(Borsh(PairingOffer))
code = the first 4 bytes of BLAKE3-derive_key("Saltix grain pairing code v1", Borsh(PairingOffer)),
       read as a big-endian u32, modulo 1 000 000: six digits with leading zeros, shown "482 913"
```

- **Nothing in it is secret, and nothing in it is signed but the proof.** The proof binds the full genesis hash, the
  slug and the owner, and the registry takes it only in a call that owner signs: shown in the open, it serves nobody
  first, no other app and no other owner. The nonce, the name and the times are the owner's reading aids: an offer
  rewritten around a real proof names the same key for the same app and owner.
- A reader takes the canonical form only: version 2, a known `hrp`, a valid Ed25519 key (none of small order), a slug
  of form, a name of at most 32 characters with none of Unicode `Cc` and `Cf`, U+2028, U+2029,
  `created_at < expires_at ≤ created_at + PAIR_OFFER_LIFE`, and nothing trailing (refused: `version`, `unknown_network`,
  `key`, `slug`, `name`, `life`, `malformed`). In a link it refuses padding, spare bits set and a further parameter;
  white space around the link is allowed. The proof is checked by the phone against its own genesis hash, not by the
  form.
- **The code** lets the owner compare what the phone scanned with what the computer shows: every offer has its own,
  derived from everything in it, the key and the proof included. **A key's fingerprint**, wherever people tell server
  keys apart, is its first 4 bytes in lower-case hex, `ab12cd34`.
- An offer is about 200 bytes: a QR code of about 69 modules a side at the default error correction, which a terminal
  shows and a phone reads.

### What the phone checks, and signs

1. **Where it takes an offer**: its scanner, a `salt:grain-pair?o=` link opened by the system's camera, and a link in a
   Saltix message, which names the sender. Never from a page, a grain or a chat with an app, and never pasted.
2. **It checks everything by itself**, in this order, and says which check failed and what to do: the form and the
   version — an offer of version 1 says "this offer is from an older SDK: update it and run `grain pair` again", one
   above 2 "update Saltix"; its own network, by `hrp` and `genesis` (`other_network`); made at most 5 minutes ahead of
   the phone's clock (`PAIR_SKEW`, `ahead`); not expired (`expired`); **the owner is this account** (`other_owner`);
   **the proof verifies** (strict Ed25519) under the offer's key for the phone's genesis hash, the slug and the owner
   (`proof`); **the slug**: the account's live app, or free — a new app made in place — and refused for another
   account's or retired (`judgeSlug` over the registry's record: `free`, `own`, `paired_already`, `another_account`,
   `retired`; the phone signs for `free` and `own` only). A key the app names already ends the sheet with "this server
   is paired already": nothing to sign.
3. **The sheet, Pair a server**: the app; for you, the account; the server (the offer's name and the key's fingerprint,
   `macbook-anna · ab12cd34`); the code, large; what the key may do; **Pair**, adding by default (the key goes first in
   the app's list, so the app's chat goes to this server), with **Replace the other servers** a switch off by default.
4. **The PIN**, then `ConfigureGrain` (tag 39) with the new list, every key with its proof, this key's from the offer;
   for a free slug, New app's creation with the key in its `ConfigureGrain`: one confirmation makes the app and pairs
   the server. The registry's refusals show the way out: a key another live app names (`ServerKeyTaken`), "this key
   serves another app: run `grain pair --new` on the computer".
5. **Done**: a console notice, "A server was paired: key ab12cd34 (<the offer's name>)". No message goes to the
   computer: it reads the registry.

### On the computer

What the protocol needs of `grain pair`; the rest is the SDK's ([docs/first-app.md](../first-app.md), the README):
- the key's secret is made on the computer and kept in a file only its owner reads (`.grain/pair.key`, then
  `app.key`); it is never printed, logged or sent;
- before it shows an offer, the computer reads the registry's record of the slug and refuses to go on when the record
  holds it for another account than the command's owner, or retired, saying so; a free slug is a new app the owner will
  register;
- it shows the offer, and shows a new one — the same key, a new nonce — when the offer expires with nobody having
  scanned it, saying so, so that an agent left waiting needs no second command;
- it watches the registry — the record's `servers` — through the network's public relays' wallet interface (a read,
  which no gate holds), and takes itself as paired once the record names its key; the program it runs refuses to start
  until then, saying to run `grain pair` (`chat_unpaired`). It needs no relay session of its own, no key registered
  anywhere and no message from the phone: the registry's word is the answer;
- it takes itself as paired only for the slug and owner it offered: no other naming of its key is possible, since the
  registry takes a key only with a proof for that app and owner, which the computer alone signs;
- `grain pair --new` makes a new key and a new offer (rotation, or a key for another app: the registry names a key for
  one live app only); `grain status` says `paired`, `waiting`, `unpaired` or what became of a key, from the registry.

### What a paired key may do, and what a stranger's offer could

A paired key is a registered server key like any other (§2): it speaks for the app in its chat, signs its price-free
chat specs and its notifications, signs invoices payable to the owner only, and signs the app's requests to services of
its own (§3); it never controls the app, never moves the owner's money, and the owner removes it with one call.

The danger is a stranger's offer ("scan this to set up your app"): an offer pairs only when it names this owner and this
app with a proof that verifies, so a stranger's offer is made for the owner's own app on purpose, never by chance; the
sheet shows the code in large type and asks whether the computer's screen shows the same, so the owner reads the
computer's own screen, or a link sealed to them in a Saltix chat; every pairing writes a console notice with the key's
fingerprint and name, so a key paired by mistake is seen and removed in one tap. An offer seen by someone else gives
them nothing: there is no exchange to win, and the proof serves only the owner's own call. An offer lives 30 minutes,
for the owner's reading, not for safety.

The same sheet **rotates** a key (`grain pair --new` on the computer, then **Replace the other servers**) and moves an
app to another computer (pair the new one, then remove the old key in the manage page). No key is copied either way.

### Version 1 (2026-10-19), superseded

Version 1 checked with the computer before anything was signed: the phone sent a `PairRequest` through the relays to
the offer key's address, the computer answered with a `PairAnswer` carrying the proof, and only then the phone signed.
On protocol version 6 it cannot pair: the messenger's gate drops both frames, and no rule a relay could check tells
them from anyone's. Version 2 sends no frame; the `SGP1` frames, `judgePair`, `answerPair`, `checkPairAnswer`,
`PAIR_ANSWER_WAIT` and `grain pair --accept` went with version 1, and `vectors/server-pairing-v1.json` with them. An
SDK of this version never sends them; a wallet of this version reads an offer of version 1 only to say to update the
SDK; a wallet from before version 2 refuses an offer of version 2 as of an unknown version, saying to update Saltix.

The SDK: `PairTarget`, `pairCommand`/`parsePairCommand`, `pairTarget`, `targetOwner`, `targetNetwork`, `targetIsFor`;
`makeOffer`, `encodeOffer`/`decodeOffer`, `offerLink`/`parseOfferLink`, `offerFormProblem`, `offerProblem`,
`offerProof`, `offerCode`, `offerCodeText`, `offerAddress`, `keyFingerprint`, `versionMessage`; `judgeSlug`,
`slugRecordOf`, `verdictPairs`; `signServerKeyProof`/`verifyServerKeyProof`; `grain pair`, `grain status`,
`grain doctor` ([docs/first-app.md](../first-app.md)); `appKeyFromEnvironment`, a server's refusal to start unpaired
(`chat_unpaired`). `vectors/server-pairing-v2.json`.

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
  username. At the end: the pairing command and a prompt for a coding agent, with **Copy** and **Scan** (§3a); no
  developer key is made (§3, retired).
- **An app being made is locked** until every step is in the registry: its page and a launch show only the steps'
  states, and no servers, console or members.
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
- **The manage page**: Awaiting you; Program (seen when); Servers (the keys the registry names with their fingerprints
  and names, **Pair a server** with the command and the prompt, a key removed by the owner; a developer key in use
  marked *made on this phone*, with a line saying to pair a server in its place); Screen
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
  **notices** there, drawn apart and marked as Saltix's, never sent anywhere: the app created; a server paired (the
  key's fingerprint and the offer's name), a key replaced or removed (never the key); the program's first answer, and
  the program silent; new ratings; members and
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
the latest counts. The registry keeps each rating with its slot and whether the account held an active mining license
then, and per grain the count and sum of scores, overall and of miners' ratings, which the card shows apart ("4.6
from 23 miners"). A review is shown without Unicode `Cc` and `Cf` characters and the line and paragraph separators
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

The wallet interface: `grain_get` and `grain_list` show `ratings {count, sum, miners_count, miners_sum}`;
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
| Developer key (retired) | `saltix-app:1:<hrp>:<16 hex>:<slug>:<64 hex>`, the form `app.key` keeps |
| The pairing command | `grain pair --app <slug> --owner <address> --genesis <16 hex>` |
| `PAIR_OFFER_LIFE` | 30 minutes; a wallet takes an offer made at most 5 minutes ahead of its clock (`PAIR_SKEW`) |
| A pairing offer | version 2: `salt:grain-pair?o=<base64url of Borsh(PairingOffer)>`, with the key's proof for the app and its owner; a 6-digit code; the server's name at most 32 characters |

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
