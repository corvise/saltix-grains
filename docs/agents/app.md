# Building an app, for a coding agent

You were handed a **developer key** and asked to build an app (a grain) that answers in its chat in Saltix, and maybe
shows a screen. This page is the whole path, the rules every app follows, and what to do with an error report.

## The developer key is a secret

`saltix-app:1:<hrp>:<genesis>:<slug>:<secret>` (Saltix 24-app-studio [§3](../protocol/app-studio.md#3-the-developer-key)): the network's address prefix (`dsalt` on the
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
git clone https://github.com/corvise/saltix-grains.git && cd saltix-grains
npm ci && npm run build
npx grain init ../<slug> --chat --slug <slug>    # grain.json, chat.json, connect.json, chat.mjs, server.mjs, test/, AGENTS.md…
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

**No node needed.** Every registry command (`grain show`, `publish`, `retire`, `profile`, `configure`, `access`, `bind`,
`rate`, `sponsor`, `app-key`) and `grain faucet` (test SALT for `owner.key`'s account, once every 5 minutes) reach the
test network through its public relays, each pinned by its certificate's hash. `--node URL` is for a node of your own
and `--relay wss://…#<sha256>` for a relay you name, always with its pin.

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
  app made in Saltix starts at 1, so your server serves 2 or more (from its developer key it refuses to start on 1,
  `chat_spec_version_starter`, exit 78). A spec changed under the same version reaches nobody, and nothing says so.
- `keeps` (days you keep what users send) and `ai` (whether a language model answers) are shown to users before their
  first action: they must be true.
- At most 32 commands of at most 8 parameters; names `[a-z0-9_]`, a command's starting with a letter; every text has
  `en`; unknown fields are refused. The server signs the spec with its key at start, which it may while every price is 0.

## The Connect profile: `connect.json`

The first time someone opens your app, Saltix shows its **Connect sheet** (Saltix 19-connect [§12](../protocol/connect.md#12-the-connect-sheet)): "Saltix
Connect" on top, your app's icon, name and owner, then **In its own words**: your profile. Below it, "To continue, sign
in" with a row for each permission the manifest asks for, and Continue. `connect.json` is that profile: the JSON form's
`profile` object without `owner` and `revision`, which are filled in when it is set.

```json
{
  "version": 1,
  "subject": { "grain": { "slug": "<slug>" } },
  "texts": {
    "en": {
      "tagline": "Split a bill with friends in two taps",
      "about": "Add what everyone paid, and Split Bill works out who owes whom.\nSettle up in SALT from the chat.",
      "highlights": ["Invoices you confirm in Saltix", "No sign-up, no password", "Groups of up to 20"],
      "privacy": "Keeps the bills you add for 90 days, under the ID it sees for you. It never sees your address unless you share it."
    },
    "ru": { "tagline": "Разделите счёт с друзьями в два касания", "about": "…", "highlights": ["…"], "privacy": "…" }
  },
  "website": "https://splitbill.example/about",
  "support": "@splitbill_help",
  "terms": "https://splitbill.example/terms"
}
```

How to write a good one:

- **The tagline says what the app is**, in one line of at most 80 characters: "Split a bill with friends in two taps",
  not "The best app ever". It is shown under the name, and in lists.
- **About says what it does** (at most 600 characters, line breaks allowed): what a user does in it and what they get.
- **Highlights are facts, not slogans** (at most 4 of 60 characters): "Invoices you confirm in Saltix", "Works in groups
  of up to 20". A user should be able to check each one.
- **Privacy says what is kept and for how long** (one line of at most 300 characters): which data, where, how long, and
  whether the app sees the address. It is required when `grain.json` asks for `address` or `storage`. The address is
  not secret data: what is on chain is public, and the address links it to the user, so the sheet words it as "it can
  follow your activity on the blockchain".
- **English and Russian.** `en` is required; a reader sees their own language, else English.
- **Links**: `website` and `terms` are `https://` links; `support` is an `https://` link, a `mailto:` address or a
  Saltix username (`@name`). Anything else is refused, so the sheet never opens a link a profile could turn against
  its user.
- **Ask only for what you use.** Every permission is a row on the sheet, and `address` and `notifications` are switches
  users may leave off. `grain lint` warns about a permission nothing in the app's sources uses.

`grain lint` checks every rule of the format with the field and its limit, the privacy summary, the icon file
(`icon.png` or `public/icon.png`: a 256×256 PNG whose hash `grain.json` names) and the link's length for a QR code.
`grain profile` sets it once the app is registered: a QR code the owner's Saltix scans (it fills in its account and the
registry's revision and one, shows the profile as the sheet will, and signs after the PIN), or `--key owner.key` on the
test network. The owner may also write it in Saltix's app studio (My apps → the app → Connect profile). `grain show`
prints the registry's profile and whether a wallet takes it. `grain dev`'s simulator shows a preview of the sheet from
`connect.json` and the manifest before the app opens (**Show it again** after a change).

## Handlers and cards: `server.mjs`

One handler for each command:

```js
chat.command("plan", (ask) => {
  const minutes = Number(ask.args.minutes);                   // a number arrives as a bigint
  const sets = Math.max(1, Math.floor(minutes / (ask.args.level === "hard" ? 5 : 10)));
  return card()
    .status("done")                                           // the card's title: a status comes first
    .fields({ Minutes: String(minutes), Sets: String(sets), Where: ask.args.outdoor ? "outdoors" : "indoors" })
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
  blocks and 6 actions, labels of at most 18 characters, the first `run` primary, destructive commands named so). Check
  each card with `assertCardStandard(card, spec)` in the tests. A poll's vote and a card whose buttons change are
  answered with `ask.update(card)`, in place of the card tapped. A frame holds 48 000 bytes: send more as a file
  (`await chat.upload(bytes, {name, mime})`, then `.file(ref, {format})`). Slow work: `await ask.working("…")` first;
  the answer replaces it.
- **Refuse** with `throw new ChatRefusal(text)` (a `refused` status, in the user's language). Any other error answers
  `failed` and is reported to your team's console.
- **Payments** (`chat.invoice`, `chat.paymentOf`): `const inv = chat.invoice({ amount: "2.5", memo: "Premium, 1 month" })`, then
  `card().text(…).invoice(inv)`. The developer key's invoice pays the app's owner only. Keep `inv.invoice` with what
  the user asked for, and deliver once `await chat.paymentOf(inv.invoice)` has the confirmations you need
  ([../payments.md](../payments.md)).

## A page for some people only: check first, then render

A public app for a limited circle shows strangers a refusal page without any of its UI; a private app's page never even
loads for them (Saltix reads the registry first and shows only that the app is private). Saltix 12-grains
[§5.1a](../protocol/grains.md#51a-the-teams-sign-in-check-first-render-after). On a first open Saltix Connect's sheet comes first; then your page loads, and its gate follows:

1. **The HTML shows a splash and nothing else**: the app's icon and name in an element marked `data-grain-splash`,
   the app's UI `hidden` (or not drawn yet). Never a skeleton of the UI: its layout already says what the app does.
2. **Sign in with `grain.signIn({ url })`** (`@saltix/grain`). It posts to your server's `<url>challenge` and
   `<url>session`; Saltix's login carries the account's member proof when it is on the app's team (its owner,
   developers and viewers) or a private app's member, and `null` for anyone else.
3. **Your server** answers both routes with `SignIns` (`SignIns.of(chat)` reads the registry through your chat
   server) and `signInAnswer`: `const r = await signIns.check(body)` checks the challenge, the grain key's login and the
   proof, and gives `r.signedIn.rights`: `owner`, `developer`, `viewer`, `user` or `none`. Give a session to those the
   app is for only, and check its rights again on every request: the page's gate decides what people see,
   never what they may do. `check` throws `ChatMemberUnchecked` when the node did not answer (for the registry record or
   the account's keys): answer it with 503, so that the page shows "try again" (`failed`), never a refusal and never a
   500.
4. **`gateOf(signIn, TEAM)`** says what to draw: `open` the app; `refused` a page that says whom the app is for and that
   its owner can invite them, with none of the app's UI; `update` "update Saltix" (Saltix 0.1.53 and older send no
   proof, so `none` may be a member: never tell them the app is not for them; ask them to update Saltix);
   `declined` a sign-in button; `failed` try again; `outside` open it in Saltix.

```js
import { TEAM, gateOf, grain } from "./grain.js";
const gate = await grain.signIn({ url: "https://api.example.com/my-app/" }).then((s) => gateOf(s, TEAM), (e) => gateOf(e, TEAM));
document.querySelector("[data-grain-splash]").remove();
if (gate === "open") drawApp(); else drawRefusal(gate);
```

`grain lint` warns (`render-before-sign-in`) about a page that signs in and shows anything in its HTML outside its
splash, or marks no splash. `grain init` makes a page that does all of this (`SIGN_IN`, `FOR` in `public/app.js`).

Saltix's own splash (the app's icon and name) covers the page only while it loads; `grain.ready()` neither holds nor
hides it (Saltix ignores it today, and so does the simulator). From then on the page's `data-grain-splash` is all a user
sees until the gate decides.

## What a page gets from Saltix

All of it, in full: [AGENTS.md](../../AGENTS.md#building-an-app-what-a-page-gets-from-saltix-and-what-it-does-not).

- `grain.info()`: `slug`, `version`, `form`, `listing`, `host`, `host_version`, `bridge` (3), `language`, `theme`
  (`dark` or `light`), `safe_area`, `controls`, `network`, `start`. Events: `theme`, `visibility`, `insets`, `relay`.
- Limits: a tap within 5 seconds before a payment, the chat, the app's page (its team only) and asking again for the
  address or notifications; the manifest's permissions (4100); a rate per method (4290); storage's 128-byte keys,
  60 KiB values and 1 MiB an app; 64 KiB of JSON an answer (else error 5000) or an event (else dropped): a relay frame
  over about 32 KB never reaches a page. `grain dev`'s simulator holds you to them.
- Eight CSS variables on `:root`, in `px`: `--saltix-safe-top|right|bottom|left` and
  `--saltix-controls-top|right|width|height`. Saltix's win over the page's stylesheets and over `grain.layout()`'s,
  which fills them in only where Saltix sets none and takes them away on `stop()`. Never write them into `:root`'s
  inline style: an inline value beats Saltix's and stays stale when the phone turns.
- **No design tokens**: no palette, accent, fonts, corners or spacing. Bring your own, light and dark, and switch by
  `grain_info.theme` and the `theme` event (`prefers-color-scheme` need not match the theme chosen in Saltix).
- **Saltix takes its colours from the page**: its band, the status bar's icons and its controls follow
  `grain.setHeader`'s colour (until the next call), else the page's own: its `theme-color` (the first whose `media`
  matches and which is an opaque colour), else its background, which the room around the page and the navigation bar's
  icons follow too. Give opaque colours. Saltix reads them again when the head changes, once the page has loaded and
  when the theme changes, not when a script changes the body's background alone: change the `theme-color` with it, or
  call `grain.setHeader`. The simulator in `grain dev` follows the same order at the same moments.
- **No one's name**: a user is a grain key ([the rules](#the-rules-every-app-follows), *People's names*).

## The rules every app follows

- **Connect profile**: every app ships a complete one (`connect.json`: tagline, about, highlights, privacy, in English
  and Russian) and asks only for what it uses ([above](#the-connect-profile-connectjson)). `grain lint` fails without
  it.
- **Check first, then render**: a page for some people only shows a splash until `grain.signIn` and `gateOf` decide,
  then the app or a refusal page with none of its UI; a public app for a limited circle shows strangers that refusal
  page ([above](#a-page-for-some-people-only-check-first-then-render)). The server checks the session's rights on every
  request.
- **People's names**: Saltix gives an app nobody's name, neither the profile name an account sets for itself (Saltix
  [09-relay §1.5](../protocol/basics.md#peoples-names)) nor its username. A user is their grain key, a pseudonym of this app alone (`ask.key`, the page's
  `grain.login`); only the team and a private app's members are known as accounts (`ask.member`, `SignIns`), and a
  page gets an address only from `grain.requestAddress` (the `address` permission) or `grain.pickContact`.
  Never show a key as a name. To show people to each other, show the name each typed in the app (its own data: say so
  in `connect.json`'s privacy) or a shared address, shortened; a typed name is never proof of who someone is.
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
  are in `AGENTS.md`; `grain lint` warns about a page that declares it and reads no inset. Never write those variables
  into `:root`'s inline style: it beats Saltix's own values. Saltix gives no colours or other design tokens: bring your
  own for both themes and switch by `grain_info.theme` and the `theme` event.
- **Cards** follow the card design standard ([cards.md](cards.md)): a status first (build the card with it first, even
  when its text depends on what comes after), at most 6 actions, labels of at most 18 characters, the first `run`
  primary, destructive commands named so. Check each with `assertCardStandard(card, spec)` in the tests.
- **Bundles**: `grain bundle` makes the same bytes from the same files on any computer (files stored, never deflated,
  at most 20 MiB): rebuild it in CI and fail when `grain.json` changes (`git diff --exit-code grain.json`); never edit
  `entry.sealed` by hand.
- **Formats**: never build a protocol message by hand. The SDK makes and checks every one, byte for byte the network's.
- **Money**: never deliver on the page's or the user's word: only on `chat.paymentOf` (or `findPayment`) with enough
  confirmations. Never put another payee in an invoice: a developer key's invoice pays the owner, and wallets refuse
  anything else (`payee`). Say in the card what to do if the payment sheet does not open (Saltix 0.1.54 pays a
  developer key's invoice, 0.1.53 and older refuse it: update Saltix).

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
  assert.deepEqual(reply.fields, { Minutes: "30", Sets: "6", Where: "indoors" });
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
[failed] Error · TypeError
App: <slug>
Error: TypeError
Message: Cannot read properties of undefined (reading 'length')
Where: <the top frame: file:line:column>
Command: /<command>
Request: <request id>
App version: <your program's version>
Chat spec: v<version>
Time (UTC): <time>
<the rest of the context you passed, then the stack>
Saltix lays an app's page inside the safe area; full screen only with viewport-fit=cover: then pad by grain_info.safe_area, keep tappable content clear of grain_info.controls, test at 475×751, 704×932 and 932×704 dp in grain dev (saltix-grains AGENTS.md).
```

1. The first line is only a title (60 characters at most): **Error** and **Message** are the error in full. Find the
   handler of **Command** and the line of **Where**; the stack is under the fields. The last line, the same in
   every copy, is the rule of an app's page ([AGENTS.md](../../AGENTS.md)): keep to it in any page you touch.
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
