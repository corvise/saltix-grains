# Grain chats

A grain can talk with its users in a chat (Saltix [22-grain-chats](https://github.com/corvise/saltix/blob/main/specs/22-grain-chats.md)).
The user sends **typed actions** that your chat spec declares; your server answers with **signed cards** that the
wallet draws itself. It is end to end: no relay and no wallet provider reads it. The user speaks under their grain key,
the same pseudonym your page sees at `grain.login`, never under their account.

What makes it unlike other messengers' bots:

- every card is signed by your server key, which your owner key certified, so the wallet marks it "from `<slug>`,
  verified" because the chain says so, and the card stays verifiable when forwarded;
- actions are declared ahead and checked by the wallet before anything leaves the phone;
- your app cannot start a conversation, and writes unasked at most 10 times a day per user, notifications included;
- requests and answers wait in mailboxes: an offline phone and a restarting server both catch up.

## Setting up

```sh
grain cert init                    # server.key: the server key (owner-only), kept on your server
grain cert --days 30               # cert.json: the owner key certifies it (31 days at most for chats)
grain chat-spec --cert cert.json   # chat.json → chat.signed.json, the document your origin serves
```

1. Write `chat.json` (below) next to `grain.json`.
2. `grain chat-spec` checks it (the fault is named: `command key, parameter site: …`), checks its slug and the key file
   against `grain.json`, and signs it with the owner key. A spec that changed needs a higher `version`: a wallet keeps
   the highest it has seen and refuses lower.
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
  "slug": "access", "version": 1,
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
control characters. The signed spec is at most 32 KiB.

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
import { ChatServer, ChatRefusal, card, decodeCert, fileChatStore } from "@saltix/grain-server";

const chat = await ChatServer.start({
  slug: "access",
  spec: doc.spec,                       // chat.signed.json's hex, or a SignedGrainChatSpec
  secret: serverSecret,                 // server.key
  cert,                                 // cert.json
  chain: { genesis, network: "testnet" },
  ownerKey: manifest.owner_key,         // optional: checks the spec and certificate as a wallet does, at start
  node: "http://127.0.0.1:30334",       // relays from its relay_list, pinned by their certificates
  store: fileChatStore("chat.store.json"),
  log: (level, event, meta) => console.log(level, event, meta),
});

chat.command("key", async (ask) => {
  const { site, duration } = ask.args;            // checked against the spec
  const key = await mint(ask.key, site, duration); // ask.key: the user's grain key, as grain.login gives it
  return card()
    .secret("Key", key.code, { expiresAt: key.expiresAt })
    .fields({ Site: site, "Valid for": `${duration / 3600} h` })
    .status("done", "Opens the site once")
    .run("Revoke", "revoke", { id: key.id })      // opens the form filled in; the user may edit it
    .open("All keys", "keys");                     // opens the grain's screen with start=keys
});

chat.command("report", async (ask) => {
  await ask.working("Building the report…");      // shown at once; the answer replaces it in place
  const file = await chat.upload(csvBytes, { name: "report.csv", mime: "text/csv" });
  return card().text("Yesterday: 41 sessions, 3 errors.").file(file, { title: "Daily digest", format: "csv" }).status("done");
});

chat.command("revoke", (ask) => { throw new ChatRefusal("No key k-1 is yours."); });   // a "refused" status
chat.text((ask) => card().text("Pick a command below.").reply("Hello", "hello"));

http.createServer((req, res) => chat.serveDocument(req, res) || app(req, res));
```

**Cards.** `card()` builds a message of 1–16 blocks and 0–8 actions: `text` (1–4 000 characters, line breaks kept, no
markup), `fields` (1–16 rows of a label up to 40 and a value up to 200 characters), `secret` (label, value up to 256,
`expiresAt`), `file` (a `FileRef` from `chat.upload`, a title, a format such as `csv`), `invoice` (`signInvoice`'s hex,
for this grain), `status` (`working`, `done`, `refused`, `failed`, up to 200 characters); actions `run` (a command and
arguments, typed by the spec), `open` (the grain's screen with `start`) and `reply` (a text up to 200 characters). The
server signs it with the server key and attaches the certificate; a frame carries at most 48 000 bytes, so a larger
report goes as a file.

**Requests**, as the server takes them (§3):

| A request that… | Gets |
|---|---|
| fits the spec and has a handler | the handler's card (`answers` the request) |
| names no command of the spec, or an argument missing, unknown, repeated, out of order or out of bounds | a `refused` status saying which |
| has a command with no handler, or is text without `chat.text` | a `refused` status |
| makes the handler throw `ChatRefusal` | a `refused` status with its text |
| makes the handler throw anything else | a `failed` status ("Something went wrong"); the error goes to your log only |
| did not come from its key's address, is not signed by it on this network, is another grain's, or expired | nothing: dropped |
| was answered already (the same `key` and `id`) | nothing |

Each request is answered once: its `(key, id)` is remembered until it expires. A kept frame leaves the server's mailbox
only once its request is answered, so one that arrives while the server is down, or whose handling failed before an
answer went out, comes again and is answered then. `memoryChatStore` (the default) forgets on restart;
`fileChatStore(path)` keeps the record in a file; a larger grain implements `ChatStore` over its database.

**Writing unasked.** `chat.notify(user, card)` writes a message that answers no request, and
`chat.notification(user, {title, body, start})` sends a grain notification (12-grains §5.5) signed by the server key.
Both count against **10 per user in any 24 hours** and throw `ChatBudgetSpent` past it. `chat.replace(sent, card)`
updates a message in place: while the request it answered lives, the update answers it too; after that it counts as
unasked. A user is their address in the grain or their grain key in hex.

**A newer spec.** `chat.setSpec(signed)` takes a version not below the current one. Each user is sent the spec they have
not seen (`ChatFrame::Spec`, with the certificate) before their next answer; `chat.pushSpec(user)` sends it now.

**Logs** carry names and numbers (`chat_request`, `chat_request_refused`, `chat_request_dropped`,
`chat_handler_failed`, `chat_budget_spent`, `file_uploaded`…), never keys, secrets, arguments or what users wrote.

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
  owner), out of bounds, with a price above 0, or of a lower version than one it holds. It fetches the spec again at
  least once a day while the chat is in use;
- **a certificate** that is not the owner key's, for another grain, expired, ending more than **31 days** ahead, or for a
  key the spec revokes. Every message carries its certificate, so a refused one refuses the message;
- **a message** that did not come from the certificate key's own address, is out of bounds, dated more than 5 minutes
  ahead or more than 30 days old, or whose signature does not check;
- **an unasked message** (one that answers no request of the user's that still lives) while the user has not allowed
  them (allowed by default once they sent a request), or past 10 that day, notifications included;
- **a frame** that is not a grain chat's: dropped and taken off the mailbox.

It draws messages natively, never as web content: text without markup; fields as a table; secrets masked until tapped,
never in notifications or chat previews, copied on request, hidden after they expire; files downloaded on request and
checked against the card's hash, `txt`, `md`, `csv`, `json` and images previewed, anything else offered to the system's
viewers, nothing opened as code; invoices on the wallet's own payment sheet; `run` opening the command's form filled
in, which the user may edit; `replaces` updating a message of the same chat in place. A forwarded card keeps its
certificate and signature, and is marked verified or not wherever it goes.

The wallet sends a request only when it fits the spec it holds (a command it has, every required argument and nothing
else, each value of its kind and within its bounds), signed by the grain key for this network, living at most 7 days.

## Trying it

`npm run dev` runs a development relay at `/relay` (`scripts/dev-relay.mjs`: records checked, kept frames held until a
signed ack, files) and the example's chat on it (`examples/hello-grain/chat.json`, `chat.mjs`). In the simulator, load
the manifest, then **Load the chat** (or **Open the chat** in the grain): it plays the wallet's side exactly, checks
every card, builds forms from the spec and masks secrets. `CHAT_NODE=<a devnet node's wallet interface>` runs the chat
on that node's relays instead, for a debug Saltix on that devnet.

## The formats

For tests and TypeScript clients, byte for byte `vectors/grain-chats-v1.json`: `encodeChatFrame`/`decodeChatFrame`
(`"SGC1"` ‖ Borsh), `signChatSpec`, `signedChatSpecProblem`, `chatCertHolds`, `signChatRequest`,
`chatRequestProblem` (sender, signature, life, fit), `requestFitProblem`, `signChatMessage`, `chatMessageProblem` (as a
wallet checks a card), `chatSpecFromJson`/`chatSpecToJson`, and the file reference: `encodeFileRef`, `fileRefToJson`,
`fileRefFromJson`, `fileRefProblem`, `sealFile`, `openFile`. The page opens the chat with `grain.chat.open({cert?, spec?})`
(`@saltix/grain`, bridge version 2) and links to it with `chatLink(slug, cert?)`: `salt:grain/<slug>?chat&cert=…`.

| Limit | Value |
|---|---|
| A certificate for chat | 31 days at most |
| A spec | 32 KiB of Borsh |
| Unasked messages | 10 per user a day, notifications included |
| A request's life | at most 7 days |
| A message's age | at most 30 days old, 5 minutes ahead |
| A frame | 48 000 bytes of plaintext |
| A file | 50 MiB, kept 30 days |
