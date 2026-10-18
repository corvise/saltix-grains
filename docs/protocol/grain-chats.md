# Grain chats: talking to an app

> Reflects Saltix 22-grain-chats (approved 2026-10-15; the user's language, the team's hello and welcome, `Publish`,
> the `Code` and `Poll` blocks and the card standard, 2026-10-15 to 2026-10-16), as of corvise/saltix `7d3744c5`
> (2026-10-19). Section numbers are the specification's.

A **grain chat** is a conversation between a user and a grain's server:

- **end to end encrypted**: no relay and no wallet provider reads it;
- **pseudonymous**: the user speaks under the grain key, never under the account's address;
- **structured**: the server answers with **signed cards** the wallet draws itself, and the user sends **typed
  actions** a document signed for the grain declares. Free text is the exception, not the interface.

Unlike other messengers' bots: every app message is signed by a key the chain vouches for, so a card reads "from
`<slug>`, verified" because the registry says so, and stays verifiable when forwarded; actions are declared ahead and
checked by the wallet before anything leaves the phone; the app never learns who the user is unless the user shares
the address; nothing has a deadline (requests and answers wait in mailboxes); and the app cannot start a conversation,
nor write unasked beyond a small daily budget the user controls.

The SDK: `ChatServer` (`@saltix/grain-server`) is a whole chat server, `testChat` (`@saltix/grain-server/testing`)
tests one, and every format below has
its encoder, signer and checker (`docs/chats.md` lists them). The vectors: `vectors/grain-chats-v1.json`.

## 1. Parties and identities

| Who | Key | Address at relays |
|---|---|---|
| The user, in this grain | the grain key ([grains §5.1](grains.md#51-identity)) | its personal address, registered as a grain alias ([grains §5.4](grains.md#54-relays-real-time-between-users)) |
| The grain's server | a **server key** the owner registered (`ConfigureGrain`) or certified (`InvoiceKeyCert`) | the server key's personal address, registered as any client ([grains §5.5](grains.md#55-notifications)) |
| The owner | the manifest's `owner_key`, fixed in the registry | none: it stays off the server |

A grain chat is the 1:1 conversation between the user's grain alias and the server's address; both sides seal frames
to each other's messaging key as grain frames are sealed.

**Server keys.** A key speaks for the grain in either of two ways:

- **Registered**: the grain's registry record names it (`servers`, [app studio §2](app-studio.md#2-the-registry)), as
  the wallet's node reads it now. No certificate and no expiry: the owner replaces or removes it with
  `ConfigureGrain`, and a wallet refuses it from the block that takes that call.
- **Certified**: an `InvoiceKeyCert` whose `expires_at` is at most `CHAT_CERT_LIFE` (31 days) ahead, while the owner key
  still speaks for the owner.

Neither may be listed in the chat spec's `revoked` (§2). A stolen certified key speaks for the grain for a month at
most, and the owner cuts that short with a new spec; a stolen registered key speaks until the owner's next
`ConfigureGrain`.

**The chat's address** is the server key's personal address: the certificate's when the grain's `.well-known` document
(§2) carries one, otherwise the first key the registry names.

**Private grains** are used by their owner and members only, and the user's wallet proves the account behind the
grain key with every request (§3). A public grain sees such a proof only from its own team.

**The user's grain alias** is registered at a relay apart from the account's own address, so that no single relay sees
both the account and the grains it uses.

## 2. The chat spec

What a grain offers in its chat is a document of its own, not part of the manifest, so the app's actions change
without a transaction while only the grain's keys can change them.

```text
GrainChatSpec {
  slug:      String                the grain's slug
  version:   u32                   at least 1; a wallet replaces its spec only with a higher one (below)
  intro:     Map<lang, String>     1–16 languages, "en" among them; at most 300 characters each: what the chat does,
                                   shown before the user's first action
  commands:  Vec<Command>          0–32, names unique
  revoked:   Vec<[u8; 32]>         0–16 server keys the wallet no longer takes (§1)
  keeps:     u16                   days the server keeps what users send it; 0: nothing past the answer
  ai:        bool                  answers come from a language model
}
Command {
  name:      String                1–24 of [a-z0-9_], starting with a letter
  title:     Map<lang, String>     at most 32 characters each, "en" among them
  help:      Map<lang, String>     at most 120 characters each
  params:    Vec<Param>            0–8, names unique
  confirm:   bool                  the wallet asks "Send?" before sending it
  price:     u64                   µWORK the action costs; 0 in this version (§7)
}
Param {
  name:      String                1–24 of [a-z0-9_]
  title:     Map<lang, String>     at most 32 characters each, "en" among them
  kind:      ParamKind
  required:  bool
}
ParamKind = 0 Text     { max: u16 }                          1–2 000 characters
          | 1 Number   { min: i64, max: i64, decimals: u8 }  decimals ≤ 9, min ≤ max
          | 2 Choice   { options: Vec<Choice> }             1–16 options
          | 3 Duration { options: Vec<u64> }                1–16 lengths in seconds, ascending, all > 0
          | 4 Date                                          a calendar day
          | 5 File     { max: u64, mimes: Vec<String> }     1 byte–50 MiB; 0–8 media types, none: any
          | 6 Flag                                          yes or no
Choice { value: String (1–32 of [a-z0-9_-]), title: Map<lang, String> (at most 32 characters each, "en" among them) }

SignedGrainChatSpec { spec, server: Option<[u8; 32]>, signature: [u8; 64] }
  over derive("Saltix grain chat spec v1", Borsh(spec)):
    server None: by the manifest's owner_key, as the manifest is signed;
    server a key: by that key, a server key the registry record names and the spec does not revoke, while every
                  command's price is 0
```

- A language map holds at most 16 languages, sorted by code as in the manifest; a command's choices have distinct
  values. **One encoding**: a reader refuses bytes that are not the
  canonical Borsh of what they decode to (a map out of order, a key repeated), so a signed object has one encoding.
- Texts hold no control characters, except line breaks in a `Text` parameter's value, a request's text and a `Text`
  block.
- A spec is at most `MAX_CHAT_SPEC` (32 KiB) of Borsh.
- A developer changes free commands with the server's own key; a command with a price (once prices exist, §7) needs
  the owner key, and a server-signed spec with a price is refused (`ServerPrice`).

**Where it comes from.** The grain's first origin serves it, with the current server key's certificate when there is
one, and the numbers the app reports:

```text
GET https://<origins[0]>/.well-known/saltix-grain-chat
{ "spec": "<hex of Borsh(SignedGrainChatSpec)>", "cert": "<hex of Borsh(InvoiceKeyCert)>",
  "stats": "<hex of Borsh(SignedGrainStats)>" }        cert and stats optional (absent or null)
```

- A sealed grain serves it from its first `connect` origin. A private grain's document carries no `stats`.
- A chat-only grain has no origin: its spec and numbers come in the chat (`Spec`, `Stats`, §4), and until its spec
  arrives the wallet sends text only.
- The server also pushes a newer spec (and certificate) in the chat. It cannot know which version a wallet fetched,
  so it sends each version to a user once, before that user's next answer.

The wallet checks, against the registry's record and manifest: the slug; the signature (the owner key, which still
speaks for the owner, or a registered server key the spec does not revoke, with every price 0); a certificate for this
slug, unexpired, within 31 days and not revoked; and the version.

**Versions.** A wallet replaces the spec it holds only with a **higher** version. A spec of the version it holds is, to
it, the one it holds, whatever the new bytes say (a certificate beside it is checked and taken); a lower version is
refused with the certificate beside it. So a server raises the version with every change and never serves
two specs under one version: a spec changed under the same version reaches no wallet that holds that version, and
nothing tells the server. `ChatServer` keeps the highest version it served and that spec's hash, and refuses to start
on a changed spec of that version or on a lower version. A wallet fetches the spec again at least once a day while the chat is in use, so a revocation reaches it
within a day.

## 3. Requests: what the user sends

```text
ChatRequest {
  slug:       String
  id:         [u8; 16]          random; unique per request
  at:         u64               Unix ms
  expires_at: u64               after `at`, at most 7 days later: the server drops it after that
  via:        Option<[u8; 16]>  the message whose action (§4) this request runs
  command:    String            a command of the spec, or "" for text alone
  args:       Vec<(String, Value)>   by the command's parameters, sorted by name, each at most once
  text:       String            at most 2 000 characters; the text of a request without a command
  member:     Option<SignedMemberProof>   the account's member proof (below), or none
  lang:       String            the language the user's Saltix shows: 2–8 of [a-z-], or ""
}
Value = 0 Text(String) | 1 Number(i64: in units of 10^-decimals) | 2 Choice(String) | 3 Duration(u64)
      | 4 Date(u32: days since 1970-01-01) | 5 File(FileRef: relays.md) | 6 Flag(bool)

SignedChatRequest { request, key: [u8; 32] (the user's grain key), signature: [u8; 64] }
  by key over derive("Saltix grain chat request v1", genesis_hash ‖ Borsh(request))

MemberProof       { slug: String, account: [u8; 32], grain_key: [u8; 32], expires_at: u64 (Unix ms) }
SignedMemberProof { proof, key: DeviceKey, signature: [u8; 64] }
  by key, which speaks for `account`, over derive("Saltix grain member v1", genesis_hash ‖ Borsh(proof)):
  Ed25519, or P-256 over SHA-256 with a low s
```

**Member proofs.**

- A private grain's member puts one in every request to it; an account on a grain's **team** (its owner, and members
  with the developer or viewer role) puts one in every request to that grain, public or private. That is how the
  server learns where its team's chats are. No other request carries one, so a public grain never learns who its users
  are.
- The same proof goes in the sign-in to the grain's page (`grain_login`'s `member`, [grains §5.1a](grains.md#51a-the-teams-sign-in-check-first-render-after)).
- The wallet makes it for up to 30 days by its own clock and signs it with the account's key (a managed account's
  device); the request's signature covers it. A reader takes a proof that ends at most 30 days and `MESSAGE_AHEAD`
  (5 minutes) after its own clock, so a server whose clock is behind still takes a proof just made.

**The user's language.** `lang` is the language the user's Saltix shows (`en`, `ru`, `pt-br`), or `""`. The server
answers in it when it can and in English otherwise; the spec's texts need nothing from it, the wallet picks them
itself. It says nothing else about the user. A reader refuses a request whose `lang` is neither `""` nor such a code,
as it refuses bytes that are not canonical. The SDK gives it to handlers as `ask.lang`.

**The wallet sends a request only if it fits the spec it holds**: the command exists; every required parameter is
there and nothing else; each value is of its parameter's kind and within its bounds (a text within `max`, a number
within `min`–`max`, a choice or duration among its options, a file within `max` and of the media types named). A
request without a command carries text only, 1 to 2 000 characters.

**The server takes a request only if**: it is dated at most 5 minutes ahead of its clock; the frame came from `key`'s
personal address (the relay's `from`); the signature checks and the slug is its own; `expires_at` has not passed; the
arguments fit its spec; and, for a **private** grain, `member` is a proof for its slug and the request's `key`,
unexpired, ending at most 30 days and 5 minutes after its clock, signed by a key that speaks for `account` now (the
server asks its node), and `account` is the owner or a member with role `user` or `developer` (`grain_get`).

A public grain's server takes a request whatever its `member` says. Either learns its team from proofs: one that checks
as above, from an account on the team, tells it that this grain key is that member's. A public grain's server ignores
any other proof and keeps nothing of it.

It answers each request at most once: it remembers `(key, id)` until `expires_at`, and acks the request's mailbox frame
only once its answer is sent, so a request it failed to answer comes back.

- **Refused**: an authentic, live request that does not fit (an unknown command, an argument out of bounds) gets an
  answer, a message whose `Status` is refused and says why. A private grain refuses a request without a valid member
  proof the same way, and nothing more: no command runs, no file is sent.
- **Dropped**: a request from another address than its key's, with a bad signature, expired, dated ahead or for
  another grain gets no answer, and neither does a frame no reader takes (a `lang` out of form). Its frame is still
  acked.

### 3a. The hello: the team introduces itself

Until a team member writes, the app cannot reach them, so the wallet of an account on the grain's team introduces
itself to the app without the user typing: a **hello**. The server keeps the member's address from it, as from a
request's proof, and answers with a **welcome**.

```text
ChatHello         { slug: String, id: [u8; 16] (random), at: u64 (Unix ms), member: SignedMemberProof, lang: String }
SignedChatHello   { hello, key: [u8; 32] (the user's grain key), signature: [u8; 64] }
  by key over derive("Saltix grain chat hello v1", genesis_hash ‖ Borsh(hello))

ChatWelcome       { slug: String, hello: [u8; 16] (the hello's id), at: u64 (Unix ms) }
SignedChatWelcome { welcome, server: ServerKey, signature: [u8; 64] }
  by the server key over derive("Saltix grain chat welcome v1", genesis_hash ‖ Borsh(welcome))
```

- **A frame of its own** (`ChatFrame` tags 4 and 5, §4), not a command: it is not drawn in the chat, not answered with
  a card, not counted in the reported numbers or the days that let a user rate the app. An older server cannot read
  tag 4: it drops the frame and acks it.
- **Who sends one**: only the wallet of an account on the grain's team, as the registry stands (the owner, or a
  member with the developer or viewer role). A developer or viewer sends one only once told that the app will know the
  account. A user's wallet never does.
- **When**, from the device's grain alias to the chat's address: the app was made and its console added; the account
  joined the team and holds its chat; the app is opened.
- **How often**: one hello per grain and device in flight; another only after `HELLO_RETRY` (6 hours) without a
  welcome. Once welcomed, none, until the server key the chat writes to changes or the proof has less than 3 days left.
  Wallets never show a hello or a welcome, and neither counts against any budget.

**The server takes a hello only if**: it is dated at most 5 minutes ahead and at most `HELLO_LIFE` (7 days) behind; it
came from `key`'s personal address; the signature checks and the slug is its own; `member` is a proof for its slug and
the hello's `key`, unexpired, ending at most 30 days and 5 minutes ahead, signed by a key that speaks for `account` now;
and `account` is on the team by the registry as the server's node reads it now. It keeps the hello key's address as
that member's and answers with a `Welcome` naming the hello's `id`, at most once per `WELCOME_EVERY` (1 hour) per key (a
hello within that is taken, not answered). Anything else gets no answer at all, and its frame is acked. So a hello tells
an app nothing a request with the same proof would not, and nothing at all about an account off its team.

**The wallet takes a welcome only if** it came from a server key's personal address and that key speaks for the grain
(§1); the signature and the slug check; it names the hello in flight; it is dated at most 5 minutes ahead. The chat
then takes the app's unasked messages by default (§4).

## 4. Messages: what the app sends

```text
ChatMessage {
  slug:     String
  id:       [u8; 16]              random; unique per message
  at:       u64                   Unix ms
  answers:  Option<[u8; 16]>      the id of the request it answers; none: the app writes unasked
  replaces: Option<[u8; 16]>      an earlier message of this chat that it updates in place
  blocks:   Vec<Block>            1–16
  actions:  Vec<Action>           0–8
}
Block = 0 Text    { text: String }                       1–4 000 characters; line breaks kept, no markup
      | 1 Fields  { rows: Vec<(String, String)> }        1–16 rows; label 1–40, value 1–200 characters
      | 2 Secret  { label: String, value: String,        label ≤ 40, value 1–256 characters;
                    expires_at: u64 }                    Unix ms, 0 for none
      | 3 File    { file: FileRef, title: String,        title ≤ 80 characters; format 1–16 of [a-z0-9]:
                    format: String }                     "csv", "json", "pdf", "md", …
      | 4 Invoice { invoice: SignedInvoice }             grains.md §5.2
      | 5 Status  { state: u8, text: String }            0 working, 1 done, 2 refused, 3 failed; text ≤ 200 characters
      | 6 Code    { text: String }                       1–4 000 characters; line breaks kept, no other control characters
      | 7 Poll    { question: String,                    1–200 characters
                    command: String,                     a command's name: every option runs it
                    options: Vec<PollOption>,            2–10
                    chosen: Option<u8>,                  the option this user's vote counts for; below the options' count
                    closed: bool,                        it takes no more votes
                    tally: bool }                        the votes are shown; without them it is a choice
PollOption { label: String (1–60 characters), args: Vec<(String, Value)> (sorted by name, each at most once), votes: u32 }
Action     { label: String (1–32 characters), kind: ActionKind }
ActionKind = 0 Run     { command: String, args: Vec<(String, Value)> }   a request the user may edit and send
           | 1 Open    { start: String }                                 opens the grain's screen (grains.md §4)
           | 2 Reply   { text: String }                                  sends this text, 1–200 characters
           | 3 Publish { manifest: String }                              a new manifest for the owner to approve (below)

ServerKey = 0 Certified(InvoiceKeyCert)       the certificate's key
          | 1 Registered([u8; 32])            a key the grain's registry record names
SignedChatMessage { message, server: ServerKey, signature: [u8; 64] }
  by the server key over derive("Saltix grain chat message v1", genesis_hash ‖ Borsh(message))
```

Beyond the bounds above, an `Invoice` block holds an invoice of this grain; a `Run`'s `command` is a command's name
and its `args` are sorted by name, each at most once; an `Open`'s `start` is 1–64 of `[A-Za-z0-9_-]`. A message out of
bounds is refused whole.

**The wallet shows a message only if** it came from the server key's personal address; the key speaks for the grain
(the certificate holds, or the registry names the key as the wallet's node reads it now) and the spec does not
revoke it; the signature and the slug check; `at` is at most 5 minutes ahead and at most 30 days old.

**Unasked messages.** A message that answers no request of this chat counts against the chat's budget in any 24 hours:
`CHAT_UNASKED_PER_DAY`, **10 per grain**, or `CHAT_UNASKED_TEAM_PER_DAY`, **100**, when the user's account is on the
grain's team. The grain's notifications count against the same budget. The wallet enforces it (it knows its account
and reads the record's members): nothing a server sends raises it. The wallet shows unasked messages only while the
user allows them in the chat's settings; the default is allowed once the user has sent the chat a request, or once
the app welcomed the wallet's hello. Past the budget they are dropped. Saltix's own notices in an app's console are
not messages of the chat and never go on the wire.

**Answers.** A message that answers a request the user sent is always shown when its `at` is before the request's
`expires_at`. A message that `replaces` an answer counts as an answer, whatever its own `answers` says; `replaces`
updates the earlier message in place (a `Status` from working to done) and may only replace a message of the same chat
and grain; one naming a message the wallet does not hold is shown as new.

**How the wallet draws messages**: natively, never as web content, by the card standard (§5a). **Secrets** are masked
until tapped, never shown in notifications or previews, copied on request, hidden after `expires_at`. A **File**
downloads on request; the wallet previews `txt`, `md`, `csv`, `json` and images itself, opens nothing as code, and
checks the file's hash against the signed card. An **Invoice** opens the wallet's payment sheet. A **Run** sends its
request at once (`via` this message) when its `args` fill the command's form (the request fits the spec), after the
wallet's own "Send?" when the command is marked `confirm` or is destructive (§5a); otherwise it opens the form filled
with `args`, and a long press always opens the form. A **Reply** sends its text at once. A **Code** block is drawn as
it is, in monospace, with Copy, never run, linked or highlighted. A **Poll**'s option sends `command` with that
option's `args`, as a `Run`; the app counts the vote and answers with a message that `replaces` the poll with the new
`votes` and `chosen`; a closed poll takes no tap.

**An update for the owner to approve (`Publish`).** Only a key that speaks for the owner signs a manifest
(`UpdateGrain`), so the app's program proposes an update where the owner already is, its console:

- `manifest` is exactly what a publishing link carries after `salt:grain-publish?m=` ([grains §10](grains.md#10-for-developers)):
  1–2 027 characters of `[A-Za-z0-9_-]`, the canonical base64url (no padding) of one raw DEFLATE stream with nothing
  after its last block, inflating to at most 16 384 bytes of canonical Borsh of a manifest whose `owner` is 32 zero
  bytes and `owner_key` the Ed25519 key (tag 0) of 32 zero bytes, its slug the message's. At most one `Publish` a message. Otherwise the message is refused whole
  (another grain's slug: `Slug`).
- Only a wallet whose account is on the grain's team shows it; others drop it. The owner sees, in the wallet's own
  words (never the `label`), that an update is available, from the registry's version to the manifest's, and **Review
  and approve**, which opens the publishing sheet; nothing is signed without it. The rest of the team sees what is
  proposed and that the owner approves it. Once the registry holds that version or a higher one, the card says so and
  offers nothing.
- It counts as any message: unasked, against the budget of 100 a day to each member of the team.

**Older readers.** An unknown block or action tag fails the frame's Borsh, so a reader that predates it drops the
whole message and acks its frame. Saltix 0.1.51 and older drop a message with a `Publish`; Saltix 0.1.53 and older one
with a `Code` or a `Poll`, other blocks included. A server cannot tell which reader a user has, so a card everyone must
see keeps to block tags 0–5 until the users' Saltix draws the newer ones.

**Forwarding.** A message forwarded to another chat travels with its server key (and certificate) and signature;
whoever receives it checks it against the registry, and a registered key the owner has since removed no longer
verifies.

### The frame

```text
plaintext of a grain-chat frame = "SGC1" ‖ Borsh(ChatFrame)
ChatFrame = 0 Request(SignedChatRequest)
          | 1 Message(SignedChatMessage)
          | 2 Spec { spec: SignedGrainChatSpec, cert: Option<InvoiceKeyCert> }   server → user only
          | 3 Stats(SignedGrainStats)                                           server → user only
          | 4 Hello(SignedChatHello)                                            user → server only (§3a)
          | 5 Welcome(SignedChatWelcome)                                        server → user only (§3a)

GrainStats       { slug: String, at: u64 (Unix ms), users_1d: u32, users_30d: u32, requests_30d: u64 }
SignedGrainStats { stats, key: [u8; 32] (a registered server key), signature: [u8; 64] }
  by key over derive("Saltix grain stats v1", genesis_hash ‖ Borsh(stats))
```

- Frames are sealed as grain frames ([grains §5.4](grains.md#54-relays-real-time-between-users)), at most 48 000 bytes
  of plaintext, and kept in the recipient's mailbox (`keep`). A larger report goes as a file.
- Frames to a grain alias that are not grain-chat frames go to the grain's page while it is open; with the page
  closed they are acked and dropped, notifications excepted.
- A server names the relay of every file it sends (`FileRef.relay`): "the reader's own relay" means nothing to a server.
- **Reported numbers.** A wallet shows them (`Stats`, or `stats` in the `.well-known` document) as "reported by the
  app", only when a key the registry names signed them, they are at most 2 days old and 5 minutes ahead, and
  `users_1d ≤ users_30d ≤ requests_30d`. The server also hands its newest numbers to its relay (`grain_stats`,
  [relays](relays.md#an-apps-numbers)) each time it signs them and whenever it registers; nodes check them and answer
  `grain_stats` and `grain_stats_list`, which the marketplace and the explorer read. **Only a public grain's numbers
  are published**: while the registry says the grain is private its server hands none to its relay and leaves `stats`
  out of its `.well-known` document; in the chat it still sends them to the users it admits.

## 5. In the wallet

- **Starting a chat** shows the grain's card before anything is sent: the name; the slug with its look-alike warning;
  verified or listed; the owner; the intro; the commands with their prices; what the server keeps (`keeps`, `ai`).
- **Look-alikes.** A grain whose slug differs from a known slug only by characters that read alike (`0`/`o`,
  `1`/`l`/`i`, `rn`/`m`, `vv`/`w`, hyphens) carries a warning on its card and in its chat header. The header always
  shows the slug and the mark; a display name never stands alone.
- **The composer** offers the spec's commands as a list; picking one opens its form, and the request goes when the
  form is complete. Free text is a separate field the spec need not support.
- **A chat's settings**: unasked messages on or off; share the account's address with the grain (the same consent as
  `grain_requestAddress`; the address reaches the server only through the grain's page, never in a chat frame); mute;
  block (drops the chat's frames).
- **History** is kept like a 1:1 chat's and synced across the user's devices. A grain keeps its own copy on its server
  for as long as `keeps` says.
- **Several devices.** A grain alias has one live route at a time, the device that registered it last; requests and
  messages wait in mailboxes until acked.
- **From the grain's screen**: `grain_chat_open {cert?, spec?}` (bridge version 2) opens the chat, with a certificate and
  spec the page's server passes when it has them.

## 5a. The card standard

Every Saltix draws an app's messages one way, so an app designs a card once. `vectors/grain-chats-v1.json` (`cards`)
holds the cases every client reproduces; [docs/cards.md](../cards.md) is the design guide and `assertCardStandard` the
lint.

- **The capsule**: the message's blocks, in order, in one card, with the time and the verified mark at its foot. A card
  of text and statuses alone, without actions, is as wide as its text; any other takes the reading width, at most 400 dp.
- **Blocks.** *Status*: the state's icon and colour with the text (or the state's word) as a title. *Text*: as it is,
  collapsed past 8 lines with **More**. *Fields*: two columns, labels muted; a value of one word of at least 20
  characters (a key, an address, a hash) in monospace with Copy. *Secret*: masked, with Show and Copy. *Code*:
  monospace with Copy, collapsed past 12 lines. *File*: a tile with the format, title, size and Save; `png`, `jpg`,
  `jpeg`, `gif` or `webp` previewed as an image once downloaded. *Invoice*: the amount, the memo and Pay. *Poll*: the
  question, then the options: open, without a tally, with at most 3 options of at most 12 characters, one segmented
  control; otherwise a list; with a tally each option's share as a bar, its votes and the total (whole percent summing
  to 100: the floors, then the points left to the largest remainders, an earlier option first among equals); `chosen`
  is marked, and a closed poll says so.
- **The action bar.** Actions sit in a bar under the capsule, as full-width pill buttons in rows, in the app's order. A
  label's length is its count of Unicode scalar values: at most 10 lets three share a row, at most 18 two, a longer one
  has a row of its own; a row takes the next button while every label in it allows one more. A card narrower than
  320 dp puts at most two in a row, narrower than 220 dp one. An `Open` has a row of its own, with the app's icon.
- **Emphasis.** The first `Run` that is neither destructive nor in a choice is the card's **primary**, filled. A `Run`
  of a destructive command is **danger**, in red, and asks "Send?" first. Every other `Run` and every `Reply` is
  **secondary**. An `Open` is the app's own button. A `Publish` is the owner's panel, never a button.
- **Destructive commands** are named so: the command's name, or its part before the first `_`, is one of `delete`,
  `remove`, `revoke`, `cancel`, `reset`, `wipe`, `erase`, `destroy`, `purge`, `ban`, `block`, `kick`, `reject`,
  `deny`, `disable`, `unsubscribe`, `unpublish`, `leave`. Nothing else marks one.
- **A choice.** A run of two or three consecutive `Run` actions of one non-destructive command, whose labels all fit
  one row at the card's width, is one segmented control (four such actions are plain buttons, and three are none below
  320 dp); the user's last pick through the card stays selected.
- **After a tap** the button shows a spinner and the card's other actions wait, until the request is answered (a
  message `answers` it whose first status, if any, is not working) or for a minute; then a check, or a refused mark when
  the answer's first status is refused or failed. A request that did not go leaves the bar as it was. Poll options
  behave the same.
- **Reach.** Every control is at least 48 dp and labelled for screen readers with its state; the long press that opens
  the form is offered to them as an action of its own.

What an app may rely on is the order, the rows, the emphasis and the states. Colours, type and corners are the
wallet's own, in its light and dark themes.

## 6. Adding an app

| From | How |
|---|---|
| A link or QR code | `salt:grain/<slug>?chat`, optionally `&cert=<base64url of Borsh(InvoiceKeyCert)>`, so the wallet can send text before it has fetched the spec (it takes no command until the spec arrives). A grain whose registry record names server keys needs no `cert`: the wallet writes to the first one |
| The Apps section | a grain's card offers **Chat** when its origin serves a chat spec |
| An invite | `salt:grain/<slug>?invite=<…>`, made by the app's owner ([app studio §2a.1](app-studio.md#2a1-invites)) |
| A shared contact | the link above, sent as a chat message: the wallet shows it as the grain's card |
| Inside the grain | `grain_chat_open` (§5) |

An app chat is a contact of its own kind, bound to the slug, listed in the messenger's Apps tab; it never shows the
server's address as a contact. Adding one sends nothing: the conversation starts with the user's first request.

## 7. Paying for an action

A command with a `price` above 0 will be paid from the user's WORK book, the answer being its receipt. This version
fixes `price` at 0, and a wallet refuses a spec with any other price.

## 8. Servers

A server SDK gives a grain's server: the relay connection under its server key; the `.well-known` document; a router
from commands to handlers, with requests checked and the user's language to answer in; message builders that sign;
files uploaded to its relay and referenced in cards; the daily budget of unasked messages, the team's included; and the
grain's team (who is on it, from the registry; where each member's chat is, from their proofs and hellos; messages to
it; error reports made for an AI agent to read). A server answers in its own time: a request waits in its mailbox
while it is down, and its answer waits in the user's mailbox while the phone is. `ChatServer` is all of this.

## 10. Parameters

| Parameter | Value |
|---|---|
| `CHAT_CERT_LIFE` | 31 days: the longest server-key certificate a wallet takes for chat |
| `MAX_CHAT_SPEC` | 32 KiB of Borsh |
| `CHAT_UNASKED_PER_DAY` | 10 per grain in any 24 hours, notifications included |
| `CHAT_UNASKED_TEAM_PER_DAY` | 100 per grain in any 24 hours to an account on the grain's team, notifications included |
| Card standard | three a row up to 10 characters a label, two up to 18; rows of three from 320 dp, of two from 220 dp; a choice of 2–3; a segmented poll of at most 3 options of at most 12 characters; tokens from 20 characters; Text collapsed past 8 lines, Code past 12; a tap waits at most a minute |
| A `Publish` action's `manifest` | 1–2 027 characters (its link at most 2 048), inflating to at most 16 384 bytes; one per message |
| A request's life | at most 7 days, dated at most 5 minutes ahead |
| A member proof | at most 30 days; a reader allows 5 minutes of skew (`MESSAGE_AHEAD`) |
| `HELLO_LIFE` | 7 days; dated at most 5 minutes ahead |
| `HELLO_RETRY` | 6 hours without a welcome |
| `WELCOME_EVERY` | 1 hour per grain key |
| A message's age | at most 30 days old, 5 minutes ahead |
| A frame | 48 000 bytes of plaintext |
| Spec refresh | at least once a day while the chat is in use |
| Reported numbers | shown at most 2 days old |
