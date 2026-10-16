# Building an app, for a coding agent

You were handed a **developer key** and asked to build an app (a grain) that answers in its chat in Saltix, and maybe
shows a screen. This page is the whole path, the rules every app follows, and what to do with an error report.

## The developer key is a secret

`saltix-app:1:<hrp>:<genesis>:<slug>:<secret>` (Saltix 24-app-studio §3): the network's address prefix (`dsalt` on the
test network), the first 8 bytes of its genesis hash, the app's slug, and the server key's Ed25519 secret. Whoever holds
it speaks for the app until the owner replaces it.

- Keep it in `app.key`, owner-only, in `SALTIX_APP_KEY` from a secret store, or in a file `SALTIX_APP_KEY_FILE` names
  (a systemd credential). If the person pastes it to you, write it
  with `(umask 077 && cat > app.key)` or an editor, and never repeat it back.
- Never put it on a command line (shells keep their history), in a log, a test, a commit, an issue, a chat or an error
  report. `.gitignore` keeps every `*.key` out of git; check `git status` before committing anyway.
- `npx grain app-key --file app.key` prints its public parts (network, genesis, slug, public key, address) and whether
  the registry names it, through the network's public relays. It never prints the secret.

## Set up

```sh
git clone git@github.com:corvise/saltix-grains.git && cd saltix-grains
npm ci && npm run build
npx grain init ../<slug> --chat --slug <slug>    # chat.json, server.mjs, package.json, .gitignore, README.md
cd ../<slug> && npm install                      # the SDK, from the checkout: it is not on npm yet
# put the key in app.key (above), then:
npm start
```

`npm start` logs one JSON line per event. `{"event":"ready","slug":…,"address":…,"network":"devnet","spec":2}` means
the app answers. It exits with **1** for a fault of the setup (no key, `app.key` readable by others) and with **78** when
the key cannot work (another network's, replaced, revoked, the app retired) or `chat.json` changed under a version it
served (`setupCannotWork`: an `AppKeyError` or a `ChatSetupError`): restarting does not help, the log says what does.
`owner.key`, which `grain init` also makes, is for registering from a computer on a test network; an app made in Saltix
has its owner on the phone and never uses it.

Every command takes `--help` and runs nothing then: `npx grain <command> --help`.

**No node needed.** Every registry command (`grain show`, `publish`, `configure`, `access`, `bind`, `rate`, `sponsor`,
`app-key`) and `grain faucet` (test SALT for `owner.key`'s account, once every 5 minutes) reach the test network through
its public relays, each pinned by its certificate's hash. `--node URL` is for a node of your own and `--relay
wss://…#<sha256>` for a relay you name, always with its pin.

## The chat spec: `chat.json`

What users can send, declared ahead; the wallet draws each command's form and checks it before anything leaves the phone
(the full table: [docs/chats.md](../chats.md#the-spec)).

```json
{
  "slug": "<slug>", "version": 2,
  "intro": { "en": "Plans a workout for you." },
  "commands": [
    { "name": "plan", "title": { "en": "Plan" }, "help": { "en": "A workout plan" },
      "params": [
        { "name": "minutes", "title": { "en": "Minutes" }, "required": true, "kind": { "number": { "min": 5, "max": 120 } } },
        { "name": "level", "title": { "en": "Level" }, "required": true,
          "kind": { "choice": { "options": [{ "value": "easy", "title": { "en": "Easy" } }, { "value": "hard", "title": { "en": "Hard" } }] } } },
        { "name": "outdoor", "title": { "en": "Outdoors" }, "kind": "flag" }
      ] }
  ],
  "keeps": 0, "ai": false
}
```

- **Raise `version` with every change.** Saltix takes a spec only when its version is higher than the one it holds; an
  app made in Saltix starts at 1. A spec changed under the same version reaches nobody, and nothing says so.
- `keeps` (days you keep what users send) and `ai` (whether a language model answers) are shown to users before their
  first action: they must be true.
- At most 32 commands of at most 8 parameters; names `[a-z0-9_]`, a command's starting with a letter; every text has
  `en`; unknown fields are refused. The server signs the spec with its key at start, which it may while every price is 0.

## Handlers and cards: `server.mjs`

One handler for each command:

```js
chat.command("plan", (ask) => {
  const minutes = Number(ask.args.minutes);                   // a number arrives as a bigint
  const sets = Math.max(1, Math.floor(minutes / (ask.args.level === "hard" ? 5 : 10)));
  return card()
    .fields({ Minutes: String(minutes), Sets: String(sets), Where: ask.args.outdoor ? "outdoors" : "indoors" })
    .status("done")
    .run("Again", "plan", { minutes: ask.args.minutes, level: ask.args.level });
});
chat.text((ask) => card().text("Pick Plan below."));
```

- **Arguments**, typed by the spec: text and choice a `string`; number a `bigint` in units of 10^-decimals; duration a
  `number` of seconds; date `"YYYY-MM-DD"`; file a `FileRef`; flag a `boolean`. An optional one the user left out is
  `undefined`.
- **The asker**: `ask.lang` (answer in it when you can, else English), `ask.key` (the user's key in your app, the same
  as the page's `grain.login`), `ask.member` and `ask.fromTeam` (only for a private app's members and your own team:
  a public app never learns who its users are), `ask.request.id`.
- **Cards**: 1–16 blocks (`text`, `fields`, `secret`, `file`, `invoice`, `status`, `code`, `poll`) and 0–8 actions
  (`run`, `open`, `reply`, `publish`), designed by the card standard: [cards.md](cards.md) (a status first, at most 6
  actions, labels of at most 18 characters, the first `run` primary, destructive commands named so). Check each card
  with `assertCardStandard(card, spec)` in the tests. A poll's vote and a card whose buttons change are answered with
  `ask.update(card)`, in place of the card tapped. A frame holds 48 000 bytes: send more as a file (`await chat.upload(bytes, {name, mime})`, then
  `.file(ref, {format})`). Slow work: `await ask.working("…")` first; the answer replaces it.
- **Refuse** with `throw new ChatRefusal(text)` (a `refused` status, in the user's language). Any other error answers
  `failed` and is reported to your team's console.
- **Payments** (`chat.invoice`, `chat.paymentOf`): `const inv = chat.invoice({ amount: "2.5", memo: "Premium, 1 month" })`, then
  `card().text(…).invoice(inv)`. The developer key's invoice pays the app's owner only. Keep `inv.invoice` with what
  the user asked for, and deliver once `await chat.paymentOf(inv.invoice)` has the confirmations you need
  ([../payments.md](../payments.md)).

## The rules every app follows

- **Secrets**: never log, print, commit or report a key (the developer key, `owner.key`, `server.key`, `sponsor.key`)
  or a token. The SDK scrubs developer keys, long hex and the server secret from reports and its own log; name anything
  else in `redact`.
- **Logs** carry event names and numbers: never what users wrote, their arguments, keys or addresses.
- **Unasked messages**: `chat.notify` and `chat.notification` count against **10 per user in any 24 hours** (100 to a
  member of your team), and throw `ChatBudgetSpent` past it. Answer requests; never use the budget for promotion.
- **Language**: answer in `ask.lang` when you can, else in English.
- **State**: pass a store that survives restarts (`fileChatStore("chat.store.json")`, or your database through
  `ChatStore`): the default keeps answered requests and your team's consoles in memory only.
- **Versions**: raise `chat.json`'s `version` with every change of it, and the program's own version (`version`, which
  `server.mjs` takes from `package.json`) with every release, so error reports name it.
- **Tests**: test every command end to end with `testChat` (`@saltix/grain-server/testing`), never with a real
  developer key and never against the live network; a new command comes with its test.
- **One spec a version**: the server keeps the spec it served in its store and refuses to start (78,
  `chat_spec_changed_under_version`) on a `chat.json` changed under that version; never delete `chat.store.json` to get
  past it, raise `version`.
- **Pages: safe by default; full screen only with viewport-fit=cover and the insets.** Saltix lays a page out inside the
  safe area, below the band that holds its controls (⋯ | ✕, the capsule): a page that says nothing needs nothing.
  Draw edge to edge only by declaring `viewport-fit=cover` in the viewport meta, and then keep text inside
  `--saltix-safe-*` and nothing tappable under `--saltix-controls-*` (Saltix sets them on `:root`). The rules in full
  are in `AGENTS.md`; `grain lint` warns about a page that declares it and reads no inset.
- **Cards** follow the card design standard ([cards.md](cards.md)): a status first, at most 6 actions, labels of at
  most 18 characters, the first `run` primary, destructive commands named so. Check each with `assertCardStandard(card,
  spec)` in the tests.
- **Bundles**: `grain bundle` makes the same bytes from the same files on any computer (files stored, never deflated,
  at most 20 MiB): rebuild it in CI and fail when `grain.json` changes (`git diff --exit-code grain.json`); never edit
  `entry.sealed` by hand.
- **Formats**: never build a protocol message by hand. The SDK makes and checks every one, byte for byte the network's.
- **Money**: never deliver on the page's or the user's word: only on `chat.paymentOf` (or `findPayment`) with enough
  confirmations. Never put another payee in an invoice: a developer key's invoice pays the owner, and wallets refuse
  anything else (`payee`). Say in the card what to do if the payment sheet does not open (Saltix 0.1.53 and older
  refuse a developer key's invoice: update Saltix).

## Test

- **A handler** is a function that returns a card: call it with an `ask`-shaped object and read `card.blocks` (and
  `card.actions(commandOf)`). Fast, and enough for most logic. `assertCardStandard(card, spec)` there too.
- **End to end** (`npm test`; `grain init --chat` writes `test/chat.test.mjs`): `testChat` from
  `@saltix/grain-server/testing` starts your handlers (`chat.mjs`) on a development relay and registry with a
  development key, nothing real, and asks as a wallet does: arguments typed by the spec, the reply checked as Saltix
  checks a card and read for you (`text`, `fields`, `status`, `secrets`, `actions`, the `working` statuses it
  replaced).

  ```js
  import { testChat } from "@saltix/grain-server/testing";
  import { handlers } from "../chat.mjs";
  const t = await testChat({ spec: new URL("../chat.json", import.meta.url), setup: handlers, access: "private", members: { ann: ["user"] } });
  const reply = await t.as("ann").ask("plan", { minutes: 30n, level: "hard" }, { lang: "ru" });
  assert.deepEqual(reply.fields, { Minutes: "30", Sets: "6" });
  assertCardStandard(reply.message, t.chat.spec);                                               // the card standard
  assert.equal((await t.ask("plan", { minutes: 30n, level: "hard" })).status.state, "refused");  // a stranger
  await t.as("owner").hello();                         // the owner's console, before anyone writes
  await t.close();
  ```

  `t.as("owner")` and the `members` you name carry their accounts' proofs; any other name is a user with none.
  `t.chat` is the `ChatServer`, `t.registry` the development registry (`setAccess`, `setServers`, `retire`, then
  `await t.chat.checkRegistry()`), `user.unasked()` waits for `notify` and the team's cards, `t.logs` holds the server's
  log. A request the spec does not allow is refused in the test itself; a card a wallet would not show fails it.
- **In Saltix**: run the server with the real developer key and use the app from the owner's phone: its chat is the
  app's console. Your own chat does not run in the simulator yet (it runs `examples/hello-grain`).

## Ship

- **Run it** where it stays up, under a supervisor that does not restart on exit 78. With systemd, as Saltix runs its
  own apps: the key as a credential, never in an environment file.

  ```ini
  [Service]
  ExecStart=/usr/bin/node /opt/<slug>/server.mjs
  # The key, root's 0600 file, readable by this service alone; server.mjs reads the file SALTIX_APP_KEY_FILE names.
  LoadCredential=app-key:/etc/credstore/<slug>.app-key
  Environment=SALTIX_APP_KEY_FILE=%d/app-key
  # The chat store survives restarts in /var/lib/<slug> (server.mjs keeps it in STATE_DIRECTORY).
  StateDirectory=<slug>
  DynamicUser=yes
  Restart=on-failure
  RestartPreventExitStatus=78
  ```

  `server.mjs` reads `chat.json` and its version from beside itself, so it runs from any directory, without npm.
- **A new command or text**: change `chat.json`, raise `version`, restart. Each user gets the new spec before their
  next answer.
- **A new name, icon or screen** is a new manifest, which only the owner's phone signs: `await chat.proposeUpdate(next)`
  sends it to the owner's console as **Review and approve**; or the owner scans `grain publish`'s QR code.
- **Public**: the app starts private (its owner and members). The owner makes it public in Saltix (My apps → the app),
  or `grain access --public` with `owner.key` on the test network.

## An error report from the console

The owner long-presses a report in the app's console in Saltix and copies it **for an AI agent**. It reads:

```text
Saltix app console · <slug> · message <id> · <UTC time> · app version <the registry's manifest version>
from <slug>, verified
[failed] TypeError: Cannot read properties of undefined (reading 'length')
App: <slug>
Error: TypeError
Message: Cannot read properties of undefined (reading 'length')
Where: <the top frame: file:line:column>
Command: /<command>
Request: <request id>
App version: <your program's version>
Chat spec: v<version>
Time (UTC): <time>
<the stack, and the context you passed>
```

1. Find the handler of **Command** and the line of **Where**; the stack is under the fields.
2. The report never carries the user's arguments or text. Reproduce with a test over the arguments that could get
   there; add to `chat.report`'s `context` (or a `ChatRefusal` check) what the next report should say.
3. Fix it, raise the program's version, run the tests, restart the server.
4. **Occurrences** says how often it happened since the last report; one error is reported at most once an hour.

## When it does not start

| It says | Do |
|---|---|
| `no developer key` | Put it in `app.key` (owner-only) or `SALTIX_APP_KEY` |
| `app.key: readable by others` | `chmod 600 app.key` |
| `not a developer key` / `a malformed developer key` | Copy the whole key again: it starts with `saltix-app:1:` |
| `the developer key is for devnet …, but the network answering is …` | The test network was reset: the owner makes the app and its key again |
| `the registry does not name this server key …: the owner replaced this server key` | Ask the owner for the new developer key |
| `…: the registry has no such grain` | Just made: wait until Saltix shows the app live in My apps, then start again |
| `…: the grain is retired` | A retired slug is never used again: the owner makes a new app |
| `chat.json changed but keeps version N` / `…below version N this server already served` | Raise `version` in `chat.json` above N and start again |
| `wallets write to the first server key the registry names` (a warning) | Requests go to the first key's server: run that one |
| `no public relays are known for mainnet` | Pass `NODE_RPC`, your own node's wallet interface |
