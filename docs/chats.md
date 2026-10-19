# Grain chats

A grain can talk with its users in a chat (Saltix [22-grain-chats](protocol/grain-chats.md),
[24-app-studio](protocol/app-studio.md)). The user sends **typed actions**
that your chat spec declares; your server answers with **signed cards** that the wallet draws itself. It is end to end:
no relay and no wallet provider reads it. The user speaks under their grain key, the same pseudonym your page sees at
`grain.login`, never under their account. A grain may be a chat and nothing else (`Entry::Chat`): no page, no origin,
nothing to host. [docs/first-app.md](first-app.md) makes one in ten minutes.

What makes it unlike other messengers' bots:

- every card is signed by your server key, which the grain's registry record names (or your owner key certified), so
  the wallet marks it "from `<slug>`, verified" because the chain says so, and the card stays verifiable when forwarded;
- actions are declared ahead and checked by the wallet before anything leaves the phone;
- your app cannot start a conversation, and writes unasked at most 10 times a day per user, notifications included
  (100 to your app's own team: [its console](#your-apps-console));
- requests and answers wait in mailboxes: an offline phone and a restarting server both catch up.

## Setting up

A server key speaks for the grain in either of two ways ([22-grain-chats §1](protocol/grain-chats.md#1-parties-and-identities)):

- **Registered**: the grain's registry record names it (`ConfigureGrain`, at most 4 keys). No certificate and no expiry:
  the owner replaces or revokes it, and wallets refuse it from the block that does. It also signs the chat spec while
  every command is free, so a developer changes commands without the owner's phone, and the numbers the app reports.
- **Certified**: the owner key certifies it for at most 31 days (`InvoiceKeyCert`).

Both sign invoices. A registered key's invoice pays the grain's owner only, which wallets check against the registry
([payments.md](payments.md); Saltix 0.1.53 and older refuse it). A certified key's invoice may pay any account.

### From a paired key or a developer key (registered)

`grain pair` makes the server's key on the computer that runs it and pairs it with the app in the owner's Saltix by a QR
code (Saltix 24-app-studio [§3a](protocol/app-studio.md#3a-pairing-a-server-by-qr-code), [docs/first-app.md](first-app.md)): once the registry names it,
`app.key` holds it in the developer key's form, `saltix-app:1:<hrp>:<genesis>:<slug>:<secret>`, which is also what
Saltix's App studio hands over where no command runs. It is the server's whole configuration:

```ts
const chat = await ChatServer.start({ appKey: appKeyFromEnvironment(), spec, store: fileChatStore("chat.store.json") });
```

`appKeyFromEnvironment({ dir, env })` reads `SALTIX_APP_KEY`, the file `SALTIX_APP_KEY_FILE` names, or `app.key` in
`dir` (owner-only: `chat_key_exposed` otherwise), and refuses a server with none (`chat_unpaired`, saying to run
`grain pair`).

`ChatServer.start` reads the key strictly (`AppKey.parse`: the exact form, lower-case hex, a known network, a valid
slug), finds the network's public relays (`PUBLIC_RELAYS`, each pinned by its certificate; the rest from `relay_list`),
reads the node's wallet interface through their gateways, refuses a key of another network (a reset one, say), and
starts only if the registry names the key for the slug (`ChatKeyNotRegistered` otherwise). An unsigned `spec` is
signed with the key at start. Pass `node` (your own node's wallet interface) for a network with no public relays.

Every few minutes (`checkEveryMs`, 5 by default), and at each new beacon block a request comes in, it asks the registry
again. Once the key is replaced or revoked, or the grain retired, it **stops**: it leaves the relays, answers nothing
more, logs `chat_stopped` with the reason and what to do, and calls `onStop`. Requests to the old key wait in its mailbox.
Wallets write to the first key the registry names; a server whose key is not the first warns `chat_not_first_key`.

The owner's side from the command line (the tool says what to do in the owner's Saltix and waits for the registry; a key
file signs instead for an app it owns, or when `--key` names it, on test networks):

```sh
grain pair                                                   # the owner's Saltix pairs this computer's own key (QR code)
grain status                                                 # paired, pairing, replaced…, and the next step
grain cert init                                              # or, on test networks: server.key, a key of your own
grain configure --slug S --server server.key                 # the registry names it (--revoke-all names none)
grain app-key make --slug S                                  # app.key: its developer key, owner-only, never printed
grain app-key --file app.key                                 # its public parts, and whether the registry names it
```

### With a certificate

```sh
grain cert init                    # server.key: the server key (owner-only), kept on your server
grain cert --days 30               # cert.json: the owner key certifies it (31 days at most for chats)
grain chat-spec --cert cert.json   # chat.json → chat.signed.json, the document your origin serves
```

1. Write `chat.json` (below) next to `grain.json`.
2. `grain chat-spec` checks it (the fault is named: `command key, parameter site: …`), checks its slug and the key file
   against `grain.json`, and signs it with the owner key. A spec that changed needs a higher `version`: a wallet
   replaces the spec it holds only with a higher version (Saltix [22-grain-chats §2](protocol/grain-chats.md#2-the-chat-spec)), keeps its own for the same one and
   refuses a lower one.
3. Serve `{spec, cert}` at `https://<origins[0]>/.well-known/saltix-grain-chat` (a sealed grain: its first `connect`
   origin). `ChatServer.serveDocument` or `chatDocumentResponse` does it from the running server, with the current
   certificate.
4. Run a `ChatServer` with the server key, the certificate and the signed spec.
5. Certificates end within 31 days: issue a new one before (`grain cert`) and pass it to `chat.setCert`. A stolen server
   key is cut short by listing it in the spec's `revoked` and publishing a new version.

Keep the owner key off the server: it signs the spec and the certificate offline. The server holds the server key only.

## The spec

```json
{
  "slug": "keys", "version": 2,
  "intro": { "en": "One-time access keys for the closed sites.", "ru": "Одноразовые ключи доступа к закрытым сайтам." },
  "commands": [
    {
      "name": "key", "title": { "en": "New key" }, "help": { "en": "A key that opens a site once" }, "confirm": false,
      "params": [
        { "name": "site", "title": { "en": "Site" }, "required": true,
          "kind": { "choice": { "options": [{ "value": "saltix-io", "title": { "en": "saltix.io" } }] } } },
        { "name": "duration", "title": { "en": "Access for" }, "required": true, "kind": { "duration": { "options": [600, 86400] } } },
        { "name": "note", "title": { "en": "Note" }, "kind": { "text": { "max": 40 } } }
      ]
    }
  ],
  "revoked": [],
  "keeps": 30,
  "ai": false
}
```

| Field | Bounds |
|---|---|
| `slug` | the grain's |
| `version` | at least 1, raised for every change |
| `intro` | what the chat does: 1–16 languages, `en` among them, at most 300 characters each |
| `commands` | 0–32; `name` 1–24 of `[a-z0-9_]` starting with a letter, unique |
| `title`, `help` | at most 32 and 120 characters a language; `title` needs `en`, `help` may be empty |
| `params` | 0–8 a command; `name` 1–24 of `[a-z0-9_]`, unique; `required` false unless said |
| `confirm` | the wallet asks "Send?" first |
| `price` | 0 in this version (paid actions come later) |
| `revoked` | 0–16 server keys (hex) wallets no longer take |
| `keeps` | days your server keeps what users send it; 0: nothing past the answer. Shown before the first action |
| `ai` | whether answers come from a language model. Shown before the first action |

`keeps` and `ai` are always stated; unknown fields are refused, so a typo is never a silent default. Texts hold no
control characters. The signed spec is at most 32 KiB. It is signed by the manifest's owner key (`grain chat-spec`,
`server` none) or, while every price is 0, by a registered server key (`signChatSpecAsServer`, `server` the key); a
server key never signs a price (`server_price`). A wallet replaces the spec it holds only with a higher version.

**One spec a version.** `ChatServer` keeps the highest spec it served in its store (`served`: the version and the
spec's SHA-256, `chatSpecHash`) and refuses to start on a spec changed under that version (`ChatSpecVersionError`,
`chat_spec_changed_under_version`) or below it (`chat_spec_version_lowered`), logging the event: such a spec would reach
no wallet that holds the version served, and nothing else would say so. `setSpec` is held to the same rule. Raise
`version` and start again.

**Setups that cannot work.** Every configuration refusal of `ChatServer.start` is a `ChatSetupError` (`code`, and
`exitCode` 78): `chat_unpaired` (no key: run `grain pair`; from `appKeyFromEnvironment`), `chat_key_exposed` (`app.key`
readable by others), `chat_wrong_network` (a developer key of another network: the test network was reset, or `chain`
contradicts the node), `chat_key_not_registered` (`ChatKeyNotRegistered`: replaced, revoked, retired, not registered),
`chat_spec_changed_under_version` and `chat_spec_version_lowered` (`ChatSpecVersionError`), `chat_spec_version_starter`
(a developer key's spec of version 1: Saltix made the app with a starting spec of version 1, which wallets keep until a
higher one comes, so serve 2 or more), `chat_no_relays` (a network with no public relays and no node given). `setupCannotWork(e)` is true for these and for an `AppKeyError` (not a
developer key): exit with `EXIT_CONFIG` (78) then, which a supervisor should not restart on; anything else (a network
that is down) exits with 1 and may pass on a restart. A store without
`served` and `setServed` (your own `ChatStore`) checks nothing across restarts; `fileChatStore` keeps it.

| Kind | JSON | A handler reads | Bounds |
|---|---|---|---|
| text | `{"text": {"max": 40}}` | `string` | `max` 1–2 000 characters; line breaks allowed in values |
| number | `{"number": {"min": 1, "max": 100, "decimals": 0}}` | `bigint`, in units of 10^-decimals | `min` ≤ `max`, decimals ≤ 9 |
| choice | `{"choice": {"options": [{"value", "title"}]}}` | `string` (the value) | 1–16 options, values 1–32 of `[a-z0-9_-]` |
| duration | `{"duration": {"options": [600, 86400]}}` | `number` of seconds | 1–16, ascending, above 0 |
| date | `"date"` | `"YYYY-MM-DD"` | a calendar day |
| file | `{"file": {"max": 1048576, "mimes": ["text/csv"]}}` | `FileRef` | 1 byte–50 MiB; 0–8 media types, none: any |
| flag | `"flag"` | `boolean` | |

## The server

```ts
import { ChatServer, ChatRefusal, card, chatSpecFromJson, fileChatStore } from "@saltix/grain-server";

// From a developer key: everything else is found.
const chat = await ChatServer.start({
  appKey: process.env.SALTIX_APP_KEY!,
  spec: chatSpecFromJson(JSON.parse(readFileSync("chat.json", "utf8"))),   // signed with the key at start
  store: fileChatStore("chat.store.json"),
  log: (level, event, meta) => console.log(level, event, meta),
});

// Or under a certificate:
const certified = await ChatServer.start({
  slug: "keys",
  spec: doc.spec,                       // chat.signed.json's hex, or a SignedGrainChatSpec
  secret: serverSecret,                 // server.key
  cert,                                 // cert.json
  chain: { genesis, network: "devnet" }, // Saltix's test network is of the devnet kind (dsalt1…)
  ownerKey: manifest.owner_key,         // optional: checks the spec and certificate as a wallet does, at start
  node: "http://127.0.0.1:30334",       // relays from its relay_list, pinned by their certificates; and the registry
  store: fileChatStore("chat.store.json"),
});

chat.command("key", async (ask) => {
  const { site, duration } = ask.args;            // checked against the spec
  const key = await mint(ask.key, site, duration); // ask.key: the user's grain key, as grain.login gives it
  return card()
    .status("done", "Opens the site once")         // a status first: the card's title (docs/cards.md)
    .secret("Key", key.code, { expiresAt: key.expiresAt })
    .fields({ Site: site, "Valid for": `${duration / 3600} h` })
    .run("Revoke", "revoke_key", { id: key.id })  // destructive: red, and asks "Send?" first
    .open("All keys", "keys");                     // opens the grain's screen with start=keys
});

chat.command("report", async (ask) => {
  await ask.working("Building the report…");      // shown at once; the answer replaces it in place
  const file = await chat.upload(csvBytes, { name: "report.csv", mime: "text/csv" });
  return card().status("done").text("Yesterday: 41 sessions, 3 errors.").file(file, { title: "Daily digest", format: "csv" });
});

chat.command("revoke_key", (ask) => {            // a "refused" status, in the user's language when you have it
  throw new ChatRefusal(ask.lang === "ru" ? "Ключ k-1 не ваш." : "No key k-1 is yours.");
});
chat.text((ask) => card().text("Pick a command below.").reply("Hello", "hello"));

http.createServer((req, res) => chat.serveDocument(req, res) || app(req, res));
```

**Cards.** `card()` builds a message of 1–16 blocks and 0–8 actions: `text` (1–4 000 characters, line breaks kept, no
markup), `fields` (1–16 rows of a label up to 40 and a value up to 200 characters), `secret` (label, value up to 256,
`expiresAt`), `file` (a `FileRef` from `chat.upload`, a title, a format such as `csv`), `invoice` (`chat.invoice`'s
result or `signInvoice`'s hex, for this grain: [payments.md](payments.md)), `status` (`working`, `done`, `refused`, `failed`, up to 200 characters); actions `run` (a command and
arguments, typed by the spec), `open` (the grain's screen with `start`), `reply` (a text up to 200 characters) and
`publish` (an update of the app for its owner to approve, [below](#updates-the-owner-approves-in-the-console)). The
server signs it with the server key, as a registered key (`ServerKey::Registered`) or under its certificate; a frame
carries at most 48 000 bytes, so a larger report goes as a file.

**Requests**, as the server takes them (§3):

| A request that… | Gets |
|---|---|
| fits the spec and has a handler | the handler's card (`answers` the request) |
| names no command of the spec, or an argument missing, unknown, repeated, out of order or out of bounds | a `refused` status saying which |
| has a command with no handler, or is text without `chat.text` | a `refused` status |
| makes the handler throw `ChatRefusal` | a `refused` status with its text |
| makes the handler throw anything else | a `failed` status ("Something went wrong"); the error goes to your log, and to your team's console as a report ([below](#your-apps-console)) |
| did not come from its key's address, is not signed by it on this network, is another grain's, or expired | nothing: dropped |
| does not read: a language out of form (below), say | nothing: dropped (`chat_frame_malformed` in your log) |
| was answered already (the same `key` and `id`) | nothing |
| reaches a private grain without a member proof its owner or a user or developer signed with a key that speaks for the account now | a `refused` status and nothing more: no command runs, no spec or file is sent |
| reaches a private grain while the node does not answer | a `failed` status ("could not check its members"): never admitted unchecked |

**The user's language.** Every request names the language the user's Saltix shows, as `ask.lang`: `en`, `ru`, `pt-br`
(2–8 of `[a-z-]`, as the spec's maps name languages), or `""` when the app does not say. Answer in it when you can, and
in English otherwise, so a stranger reads one language rather than all you know. It says nothing else about the user,
and the request's signature covers it. The spec's own texts (intro, titles, help) need nothing from you: the wallet
picks them from their maps itself. A request whose `lang` is in any other form does not read (`decodeChatFrame`,
`decodeSignedChatRequest` throw; `requestFitProblem` says `language`, `requestLangOk` checks one).

Each request is answered once: its `(key, id)` is remembered until it expires. A kept frame leaves the server's mailbox
only once its request is answered, so one that arrives while the server is down, or whose handling failed before an
answer went out, comes again and is answered then. `memoryChatStore` (the default) forgets on restart;
`fileChatStore(path)` keeps the record in a file; a larger grain implements `ChatStore` over its database.

**Writing unasked.** `chat.notify(user, card)` writes a message that answers no request, and
`chat.notification(user, {title, body, start})` sends a grain notification ([12-grains §5.5](protocol/grains.md#55-notifications)) signed by the server key.
Both count against **10 per user in any 24 hours** (100 to a member of the app's team) and throw `ChatBudgetSpent` past
it. `chat.replace(sent, card)`
updates a message in place: while the request it answered lives, the update answers it too; after that it counts as
unasked. A user is their address in the grain or their grain key in hex.

**A newer spec.** `chat.setSpec(spec)` takes a higher version (or the same spec again), signed, or unsigned for a
registered key to sign. Each user is sent the spec they have not seen (`ChatFrame::Spec`, with the certificate when the key has
one) before their next answer; `chat.pushSpec(user)` sends it now.

## Private apps and members

An app is public (anyone) or private (its owner and members, at most 64), as its registry record says (`SetGrainAccess`;
`grain access --slug S --private --member <address>:user+developer`). Roles: *user* uses the app while it is private,
*developer* holds a server key of the app, *viewer* reads its page in My apps.

The wallet of a member adds a **member proof** to every request to a private app: the account, the grain key it uses in
this app, an end at most 30 days ahead, signed by a key that speaks for the account (its own key, or a device of a
managed account; `SignedMemberProof`, [24-app-studio §2a](protocol/app-studio.md#2a-access-private-or-public-and-members)). A public app is sent one only by its own team (the
[console](#your-apps-console)), and never learns who its users are. The server takes a request to a private app only if
`admits` holds:

- the proof is for this app and the request's key, unexpired and at most 30 days long;
- its key speaks for the account now: the account's own key, or a device of its controller (not a guardian), read with
  `account_get`;
- the account is the owner, or a member with *user* or *developer*.

Membership is read from `grain_get` and the accounts' keys from `account_get`, cached until the beacon chain's (for the
record) or the account's shard's tip moves, so removing a member or a device takes effect with the block that does it.
A proof that cannot pass whatever the account's keys are (another app's, expired, a stranger's, a bad signature) costs
the node nothing. The handler of an admitted request sees `ask.member`: `{ account, roles }`.

The same proof comes with the sign-in to the app's page (`grain_login`'s `member`, Saltix [12-grains §5.1a](protocol/grains.md#51a-the-teams-sign-in-check-first-render-after)), so a page
knows its team and a private app's members before it shows them anything: `SignIns` (`SignIns.of(chat)`) checks it with
`ChatServer.member(proof, key)`, as a request's, and answers with the rights `owner`, `developer`, `viewer`, `user` or
`none` ([docs/agents/app.md](agents/app.md#a-page-for-some-people-only-check-first-then-render)).

## Your app's console

In Saltix, the chat of an app whose **team** you are on is the app's **console** ([24-app-studio §4](protocol/app-studio.md#4-in-saltix-my-apps)). The team is the
app's owner and the members with the *developer* or *viewer* role; a member who only uses a private app is not on it.
Errors and feedback reach the team there, and Saltix writes its own notices beside them (the app created, keys made or
replaced, the program's first answer, silent for 2 days, new ratings, members, access). Long-press a report → **Copy
for an AI agent** → paste it into Claude Code or another coding agent: it gets the app, the message's id, the time in
UTC and the version with the card's text, and never a secret.

```ts
const chat = await ChatServer.start({ appKey, spec, store: fileChatStore("chat.store.json"), version: "1.4.2" });

// Who is on the team, from the registry (cached per beacon block), and whether the app can reach each one yet.
const team = await chat.team();      // [{ account, owner: true, roles: 7, address: "dsalt1q…" }, { …, address: null }]

// Feedback, digests, alerts: unasked, to the owner and the developers by default.
await chat.notifyTeam(card().text("A user wrote: the key did not open the site").fields({ Site: "saltix.io" }));
await chat.notifyTeam(card().text("Daily digest: 41 sessions, 3 errors"), { roles: ["owner", "viewer"] });
// → { sent: 1, unreachable: 1, spent: 0, failed: 0 }

// An error, as a card made for an AI agent to read. Handlers' errors go this way on their own.
try {
  await mint(site);
} catch (e) {
  await chat.report(e, { context: { command: "/key", site } });
}

// Admin commands: the team proves itself to its own app, public or private.
chat.command("stats", (ask) => {
  if (!ask.fromTeam) throw new ChatRefusal("For the app's team only.");
  return card().fields({ Users: String(users()) });
});
```

**How the app reaches the team.** A user of a public app is a key the app cannot tie to an account. The team's wallets
therefore introduce themselves to their own app, public or private, with a **hello** ([below](#the-teams-wallets-say-hello)),
and send the same member proof with every request ([22-grain-chats §3](protocol/grain-chats.md#3-requests-what-the-user-sends), §3a); the server keeps each member's address in
the app from either (`ChatStore.team`, so a `fileChatStore` keeps it across restarts). A member whose wallet has not said
hello (a Saltix from before it) nor written to the app cannot be reached: `notifyTeam` counts them as `unreachable`. A
member the registry drops is forgotten at the next `team()`. Proofs from anyone else are ignored and cost the node
nothing; handlers see `ask.member` and `ask.fromTeam` for the team's requests only.

**The budget.** A wallet shows the team up to **100** unasked messages a day per app (`CHAT_UNASKED_TEAM_PER_DAY`), so
that reports get through while you work on the app; everyone else keeps 10. `notifyTeam` skips a member whose day is
spent (`spent`), and `notify` follows the same rule for a member's address. Saltix's own notices in the console never
count.

**Error reports.** `chat.report(error, { context?, roles? })` sends the team (the owner and the developers by default)
a card:

| Block | What |
|---|---|
| Status | `failed` (`refused` for a `ChatRefusal`), a title by the card standard (`reportStatus`): `Error · TypeError` — `Error · ` and the error's name, or its message when the name says nothing (a plain `Error`, a thrown string), `Refused · ` and the words of a refusal — at most 60 characters, cut at a word |
| Fields | App, Error, Message, Where (the top frame), Command, Request, App version (`version` of the server or the context), Chat spec, Time (UTC), Occurrences (when folded), then the context's other keys, up to 16 rows in all: the first 8 as fields (the standard's most) |
| Text | the rows past the 8th as `Label: value` lines, as the copy for an agent writes fields; then the full message when its field cut it, and the stack with its causes, cut at a line to fit 4 000 characters |

The card keeps the card standard (docs/cards.md) — the server's lint (`card_standard`) never fires for it — and loses
nothing: the error's name and message are the fields, and every line the copy for an AI agent reads is still there.

- **Folding.** The same error (name, message and top frame) is reported once an hour: the ones in between are counted,
  and the next card says "×N since the last report". If they stop, the count goes out within 10 minutes after the hour
  (`flushReports()`, which you may also call before stopping). A loop of one error sends at most one card an hour, and
  the team's budget bounds the rest.
- **No secrets.** Before anything leaves, the card is scrubbed of developer keys (`saltix-app:1:…`), every run of 64 or
  more hex digits (keys and secrets, and also hashes and accounts, which cannot be told apart by look: name them by a
  prefix in your errors), the server key's secret in base64, and whatever you name in `redact` (text of 8 characters or
  more, or patterns). Handlers' errors in your log are scrubbed the same way. A request's arguments and text never go
  in a report on their own: put in `context` only what the agent needs.
- **On its own.** Every error a handler throws, other than a `ChatRefusal`, is reported with its command and request
  id, the user still getting a `failed` status. `ChatServer.start({ reportErrors: false })` turns it off. It needs the
  registry (a developer key, or `node`); `report` never throws, and says in your log what it could not do.

### The team's wallets say hello

Nobody on the team has to write to their own app first. A team member's Saltix introduces itself (Saltix
[22-grain-chats §3a](protocol/grain-chats.md#3a-the-hello-the-team-introduces-itself)) when the app is made, when the account joins the team and when the app is opened: it sends a **hello**
(`ChatFrame::Hello`, tag 4), its member proof for this grain and the wallet's grain key, signed by that key. Nothing of
it shows in the chat, and a user's wallet never sends one, so a public app still never learns who its users are. The
server does it all on its own:

- **It takes a hello only** if it is for this grain, came from its key's address, is signed for this network, dated at
  most 5 minutes ahead and at most 7 days behind (`HELLO_LIFE_MS`), and its proof checks as a request's does (for this
  grain and this key, alive and at most 30 days long, signed by a key that speaks for the account now), from the
  **owner, a developer or a viewer**, by the registry at the beacon tip. A member who only uses a private app is not on
  the team.
- **Then it keeps the member's address**, as a request's proof does (`chat_team_reachable` the first time), and answers
  with a **welcome** (`ChatFrame::Welcome`, tag 5) naming the hello's id, signed as its messages are. The wallet stops
  sending hellos, and its console takes the app's unasked messages by default.
- **Once an hour per key** at most (`WELCOME_EVERY_MS`): a hello within the hour is taken (the address kept again) and
  not answered.
- **Nothing at all** to anything else: another grain's hello, a bad signature, a proof that does not check, an account
  off the team, one too old or dated ahead. The frame is taken off the mailbox. A hello tells your app nothing a request
  with the same proof would not, and nothing about anyone off its team.
- **Never a flood on your node.** At most `helloChecksPerMinute` hellos a minute (`HELLO_CHECKS_PER_MINUTE`, 30, by
  default) reach the registry and the node; only those that pass every check needing neither count. Past the cap a hello
  is dropped (`chat_hello_busy`, logged once a minute) and its wallet tries again within 6 hours (`HELLO_RETRY_MS`). A
  team is a few dozen accounts whose wallets say hello once per launch at most, and only until welcomed.
- **Never a request.** No handler runs; a hello is not in the numbers the app reports, in any budget or in the requests
  answered.

So `proposeUpdate` and `notifyTeam` reach the owner and the developers from the start. Keep the team's addresses in a
store that survives restarts (`fileChatStore`, or `team` and `setTeam` of your own): a welcomed wallet says hello again
only when the server key it writes to changes or its proof is renewed, 3 days before it ends. The welcomes of the last
hour live in memory, so a restart may welcome a key once more.

The log names reasons only, never an account, a key or an address: `chat_hello_welcomed`, `chat_hello_repeated` (within
the hour), `chat_hello_dropped` with its `reason` (`slug`, `sender`, `language`, `signature`, `time`, `proof`,
`not_team`, `member:signer`, `unregistered`, `no_registry`), `chat_hello_unchecked` (the node did not answer),
`chat_hello_busy`, and `chat_hello_unwelcomed` (`cert_expired`: a certified key whose certificate has ended keeps the
address and sends no welcome, which no wallet would take). A server on an SDK from before the hello cannot read one: it
drops the frame (`chat_frame_malformed`), and a member is reached once they write, as before. A welcome sent to the
server is dropped (`chat_frame_dropped`).

### Updates the owner approves in the console

A new screen, a new bundle, a new name: each is a new manifest, and only the owner's phone signs one (`UpdateGrain`,
Saltix [12-grains §10](protocol/grains.md#10-for-developers)). The program proposes it where the owner already is, in the console ([22-grain-chats §4](protocol/grain-chats.md#4-messages-what-the-app-sends)):

```ts
// The registry's manifest (chat.registered()), one version up, with the screen's sealed entry: the owner and owner key
// are the wallet's to fill in.
const next = { ...(await chat.registered(true))!.manifest!.manifest, version: 4, entry: { sealed: screen } };
const r = await chat.proposeUpdate(next);       // { sent: 2, unreachable: 0, spent: 0, failed: 0, version: 4, owner: true }
await chat.proposeUpdate(link, { text: "Notes has a screen of its own.", roles: ["owner", "developer", "viewer"] });
card().text("…").publish("Review", next);      // the same action on a card of your own
```

- The card carries a `publish` action: the manifest as a publishing link carries it (`salt:grain-publish?m=…`, its
  owner zeroed, raw DEFLATE, base64url; at most 2 027 characters and 16 384 bytes inflated: `publishText`,
  `publishLink`, `readPublishText`). It must be **this grain's**, one a message, or the wallet refuses the whole card
  (`slug`, `bounds:action`); `proposeUpdate` also refuses a version the registry already holds or passed.
- Saltix shows it to the **team only**. The owner gets "App update available, v3 → v4" and **Review and approve**, in
  Saltix's own words (never your `label`), which opens the publishing sheet: what changes, what it costs, the PIN. The
  developers (and viewers, if you name them) see what is proposed and that the owner approves it. Once the registry
  holds the version, the card says it is approved.
- It goes like `notifyTeam`, within the team's budget, and `owner` says whether the owner's console got it: until
  then (the owner's wallet has not said hello nor written to the app, or their budget is spent) nobody can approve it,
  so propose again later.
  The log says `chat_update_proposed` with the counts.
- Saltix 0.1.51 and older do not know the action and drop the card: send it once the owner's Saltix is newer, or
  give them the link (`grain publish`, or `publishLink(next)`) as well.

## The numbers an app reports

With a registered key, the server signs `GrainStats` at most once an hour (`chat.publishStats()`, `chat.reported`):
distinct users who sent a request in the last day and the last 30 days, and the requests of 30 days. They are in the
well-known document (`stats`) and go to each user once a day before an answer (`ChatFrame::Stats`), since a chat-only app
has no origin. Each signing also goes to the server's relay (`relay.reportStats`, a `grain_stats` frame, sent again
whenever the server registers): the relay's node checks them against the registry and gossips them, so every node
answers `grain_stats` for the marketplace and the explorer (Saltix [22-grain-chats §4](protocol/grain-chats.md#4-messages-what-the-app-sends)); the `stats` event of the
`RelayClient` says whether the node took them, and the log says `relay_stats_taken` or `relay_stats_refused` with the
reason. Nothing goes on chain. **A private app's numbers are not published**: while the registry says the app is private
(read every few minutes and at a request's new beacon block), the server hands none to its relay, sends none again
when it registers and leaves them out of the well-known document; the log says `stats_not_reported` with the reason
`private` once, and `stats_resumed` once the app is public, when the newest numbers go at once. Its members still get
them in the chat, and the nodes refuse a private app's numbers anyway (`private`). A wallet shows them as "reported by the app" only when a key the registry names signed them, they are at
most 2 days old and `users_1d ≤ users_30d ≤ requests_30d`. The count keeps, per user, only the time of their last
request, and forgets it once that is 30 days old; requests are counted by the hour with no one's name on them
(`UsageWindow`, kept by the `ChatStore`).

**Logs** carry names and numbers (`chat_request`, `chat_request_refused`, `chat_request_dropped`,
`chat_handler_failed`, `chat_budget_spent`, `chat_team_notified`, `chat_update_proposed`, `chat_error_reported`,
`chat_error_folded`, `file_uploaded`…), never keys, secrets, arguments, what users wrote or who is on the team.

## Files

`chat.upload(bytes, {name, mime})` seals the file under a fresh AES-256-GCM key, reserves it on the server's relay
connection (`file_new`), sends the ciphertext in pieces of 1 MiB to `https://<relay>/_file/<id>` over the relay's
pinned certificate and returns its `FileRef`: the relay's endpoint, the id, the key and nonce, the SHA-256 of the
plaintext, the size, name and media type. When the relay answers `409` the upload goes on from where it stands; `404`
(the reservation dropped) starts it over once under a new one; `507` (no room now) waits 2 s, then longer, up to a
minute, ten times in all. The relay keeps the file 30 days. `downloadFile(ref, ownRelay)` fetches and checks one, as a
wallet does.

## What a wallet shows, and what it refuses

Before the first action the wallet shows the grain's card: its name, the slug (with a warning when it reads like a
verified slug: `0`/`o`, `1`/`l`/`i`, `rn`/`m`, `vv`/`w`, hyphens), verified or listed, the owner, the intro, the
commands with their prices, and what the server keeps (`keeps`, `ai`). Adding a chat sends nothing; the conversation
starts with the user's first request.

It refuses:

- **a spec** that is not the grain's slug, not signed by the manifest's owner key (or that key no longer speaks for the
  owner) nor by a server key the registry names that the spec does not revoke, a server key's with a price, out of
  bounds, with a price above 0, or of a lower version than one it holds. It fetches the spec again at least once a day
  while the chat is in use;
- **a server key** the registry does not name at the wallet's canonical beacon block (from the block that removes it
  on, it drops what that key signs), or **a certificate** that is not the owner key's, for another grain, expired,
  ending more than **31 days** ahead, or for a key the spec revokes. Every message names its key, so a refused one
  refuses the message;
- **a message** that did not come from the server key's own address, is out of bounds, dated more than 5 minutes
  ahead or more than 30 days old, or whose signature does not check; one with a `publish` action of another grain, or
  two of them; one with a `publish` action to anyone off the app's team;
- **reported numbers** not signed by a key the registry names, older than 2 days or contradicting each other;
- **an unasked message** (one that answers no request of the user's that still lives) while the user has not allowed
  them (allowed by default once they sent a request, or once the app welcomed the wallet's hello), or past 10 that day
  (100 to the app's team), notifications included;
- **a welcome** that is not for the hello in flight, not from the chat's server key's address, from a key that does not
  speak for the grain, dated more than 5 minutes ahead, or whose signature does not check. It never shows a hello or a
  welcome in the chat;
- **a frame** that is not a grain chat's: dropped and taken off the mailbox.

It draws messages natively, never as web content, by the card standard ([docs/cards.md](cards.md)): the blocks in a
capsule and the actions in a bar under it; text without markup; fields in two columns; secrets masked until tapped,
never in notifications or chat previews, copied on request, hidden after they expire; code in monospace with Copy;
files downloaded on request and checked against the card's hash, `txt`, `md`, `csv`, `json` and images previewed,
anything else offered to the system's viewers, nothing opened as code; invoices on the wallet's own payment sheet;
polls as a segmented control or a list with shares; a `run` sending at once when its arguments fill the form (after
"Send?" when `confirm` or destructive), opening the form filled in otherwise or on a long press; `replaces` updating a
message of the same chat in place. A forwarded card keeps its
server key and signature, and is marked verified or not wherever it goes.

The wallet sends a request only when it fits the spec it holds (a command it has, every required argument and nothing
else, each value of its kind and within its bounds), signed by the grain key for this network, living at most 7 days.

## Trying it

`npm run dev` runs a development relay at `/relay` (`createDevRelay` of `@saltix/grain-server/dev`: records checked, kept frames held until a
signed ack, files), a development registry that names the example's server key, and the example's chat on both, from its
developer key (`examples/hello-grain/chat.json`, `chat.mjs`). In the simulator, load the manifest, then **Load the chat**
(or **Open the chat** in the grain): it plays the wallet's side exactly, checks every card against the registered keys,
builds forms from the spec, masks secrets and shows the numbers the app reports. **Private app** and **This account is a
member** change the development registry (a member uses and develops the app, so it is on its team); **Send a member
proof** is the wallet's side, to a private app or as the team. On the team, the pane says hello as Saltix does, on
loading the chat and on joining, and the simulator's log says when the app welcomed it. As a member, run **Fail on
purpose**: the answer says "failed", and the error report arrives as a message to the team. `CHAT_NODE=<a devnet node's
wallet interface>` runs the chat on that node's relays under a certificate instead, for a debug Saltix on that devnet.

`npm run example` runs the same chat as an app's server from the checkout's `app.key` (`grain pair` there, or
`SALTIX_APP_KEY`): an app of its own, never beside another program on the same key (both would answer).

## Testing a chat

`@saltix/grain-server/testing` runs an app's chat end to end in a test, on a development relay and registry of its own
(`@saltix/grain-server/dev`: `createDevRelay`, `createDevRegistry`) with a development key: nothing real, nothing on the
network. `grain init --chat` writes `test/chat.test.mjs` with it, run by `npm test`.

```js
import { testChat } from "@saltix/grain-server/testing";
const t = await testChat({ spec: new URL("../chat.json", import.meta.url), setup: handlers, members: { dev: ["developer"] } });
const reply = await t.ask("plan", { minutes: 30n, level: "hard" }, { lang: "ru" });   // a stranger, no proof
reply.text; reply.fields; reply.status; reply.secrets; reply.actions; reply.working;  // read for you
await t.as("dev").ask("stats");                                                       // a member's proof
await t.as("owner").hello();                                                          // the console, before anyone writes
await t.chat.notify(t.as("bob").address, card().text("Ready"));                       // after t.as("bob").connect()
await t.close();
```

- `spec`: a path or file URL of `chat.json`, its JSON, or a spec; `setup(chat)` registers the handlers, or `start(options)`
  starts the server itself from the options given (a developer key, the relay, the registry). `access: "private"`,
  `members` by name with roles (`user`, `developer`, `viewer`), `options` for `ChatServer.start` (`store`, `version`…).
- Arguments are typed by the spec (`argsFor`): a request the spec does not allow is a `TypeError` in the test, never sent.
- Every frame a wallet gets is checked as Saltix checks it: a spec signed by a key the registry names and not lower than
  the one held, a card from the app's address that `chatMessageProblem` passes, a welcome `chatWelcomeProblem` passes.
  Anything else fails the test, as does an answer that does not come within `timeoutMs` (5 s; the message names the
  server's log events).
- `t.registry` changes the registry at a new block (`setAccess`, `setServers`, `retire`); `await t.chat.checkRegistry()`
  makes the server read it now. `t.logs` holds what the server logged.

## The formats

For tests and TypeScript clients, byte for byte `vectors/grain-chats-v1.json`: `encodeChatFrame`/`decodeChatFrame`
(`"SGC1"` ‖ Borsh: request, message, spec with an optional certificate, stats, hello, welcome), `signChatHello`,
`chatHelloProblem` (slug, sender, language, signature, time), `introductionProblem` (the hello's proof, from the
team), `signChatWelcome`, `chatWelcomeProblem` (as a wallet checks one), `signChatSpec`, `signChatSpecAsServer`,
`signedChatSpecProblem` (with the registered `servers`), `chatCertHolds`, `serverKeyHolds`, `signChatRequest`,
`chatRequestProblem` (sender, signature, life, fit), `requestFitProblem`, `signChatMessage` (registered without a
certificate), `chatMessageProblem` (as a wallet checks a card, with `servers`), `signMemberProof`,
`memberProofProblem`, `admits`, `signGrainStats`, `grainStatsProblem`, `chatDocumentOf`/`decodeChatDocument`,
`chatSpecFromJson`/`chatSpecToJson`, and the file reference: `encodeFileRef`, `fileRefToJson`, `fileRefFromJson`,
`fileRefProblem`, `sealFile`, `openFile`. The developer key: `AppKey.parse` (strict; `AppKeyError` never quotes the
text), `AppKey.of`, `isFor`, `describe`; it never prints its secret. The page opens the chat with `grain.chat.open({cert?, spec?})`
(`@saltix/grain`, bridge version 2) and links to it with `chatLink(slug, cert?)`: `salt:grain/<slug>?chat&cert=…`.

| Limit | Value |
|---|---|
| A certificate for chat | 31 days at most |
| Server keys a grain's record names | 4 at most |
| A member proof | 30 days at most |
| Members of a grain | 64 at most |
| Reported numbers | signed hourly at most; shown at most 2 days old |
| A spec | 32 KiB of Borsh |
| Unasked messages | 10 per user a day, notifications included |
| A request's life | at most 7 days |
| A hello | dated at most 5 minutes ahead and 7 days behind; welcomed once an hour per key; 30 checked a minute by default |
| A message's age | at most 30 days old, 5 minutes ahead |
| A frame | 48 000 bytes of plaintext |
| A file | 50 MiB, kept 30 days |
