# Your first app in ten minutes

An app in Saltix can be a chat: users talk to it in the wallet, it answers with cards it signs. You make the app in
Saltix, take the **developer key** it gives you, and run a server with it. The key is the server's whole configuration:
it names the app, its network and the server key the registry trusts (Saltix
[24-app-studio](https://github.com/corvise/saltix/blob/main/specs/24-app-studio.md)). There is nothing to host, no
domain and no certificate.

What you need: Saltix on your phone with some SALT for the deposit (the test network's faucet gives it), Node 20 or
newer, and a checkout of this repository.

## 1. Make the app in Saltix (2 minutes)

In Saltix: **Apps → My apps → New app**.

1. **The name**, as people see it.
2. **The slug**, the app's address in the registry. Saltix proposes one and shows the deposit for its length: 100 SALT for
   3–5 characters, 30 for 6–7, 10 for 8 or more. The deposit comes back 30 days after you retire the app.
3. **A username** (optional): `@name` then opens the app's chat.
4. **A category and a description.**
5. **Create.** The phone makes a server key, registers the app, names the key in the registry and signs a starting chat
   spec (an intro, no commands yet).
6. **The developer key** is shown once: `saltix-app:1:dsalt:7e70a4e3…:your-app:…`. Copy it.

The developer key is a secret: whoever holds it speaks for your app until you replace it. Never post it in a chat or a
repository. You can replace or revoke it at any time (My apps → your app → Developer key); a replaced key stops working
at the block that takes the change, and a server running with it stops.

Keep the app **private** while you develop it: only you and the members you add can use it (My apps → your app). It goes
public when it is ready (step 4).

## 2. Run the example with your key (3 minutes)

```sh
git clone git@github.com:corvise/saltix-grains.git && cd saltix-grains
npm install && npm run build                # the SDK and the grain command line
(umask 077 && pbpaste > app.key)            # the key from the clipboard into an owner-only file (Linux: xclip -o)
npm run example
```

```text
starting AppKey(dsalt 7e70a4e3c2b04efe your-app, key 1476ff04a2885b87…)
the chat of your-app answers at dsalt1q… on devnet (spec v3)
```

`npm run example` runs [`examples/hello-grain/server.mjs`](../examples/hello-grain/server.mjs): it reads the key from
`app.key` (or `SALTIX_APP_KEY`), finds the network's public relays, checks that the registry names the key for your
app, signs [`chat.json`](../examples/hello-grain/chat.json) with the key and answers. The key never appears in its
output.

In Saltix, tap your app in **My apps**: it opens the app's **home**, Saltix's own screen drawn from your chat spec, with
its commands as buttons and the answers as cards (long-press manages the app instead). Its chat, a secondary way in, is
your app's **console**. Pick **Say hello**: the answer is a card marked "from your-app, verified", because the registry
names the key that signed it. Try **A key** (a secret, masked until you tap it), **A report** (a CSV file next to the
relay) and **Fail on purpose** (below).

## 3. Add a command (3 minutes)

Make a project of your own beside the checkout, named by your app's slug (in the checkout):

```sh
npx grain init ../your-app --chat --slug your-app   # chat.json, connect.json, chat.mjs, server.mjs, test/, package.json, README.md
cd ../your-app && npm install                        # the SDK, from the checkout (it is not on npm yet)
mv ../saltix-grains/app.key .                        # .gitignore keeps every *.key out of git
npm start                                            # the starting chat: one command, hello
```

`owner.key` is the command line's own owner key, for registering from a computer on a test network; an app made in
Saltix has its owner on your phone and never uses it. `server.mjs` logs one JSON line per event and exits with 78 when
the key cannot work (replaced, revoked, the app retired, another network's) or `chat.json` changed without raising its
`version`, which a supervisor should not restart on.

`chat.json` declares what users can send; its `slug` is your app's. Each command has a title, help and typed parameters;
the wallet draws the form and checks it before anything leaves the phone ([docs/chats.md](chats.md#the-spec)):

```json
{
  "slug": "your-app",
  "version": 2,
  "intro": { "en": "Rolls dice for you." },
  "commands": [
    {
      "name": "roll", "title": { "en": "Roll" }, "help": { "en": "Roll some dice" },
      "params": [
        { "name": "sides", "title": { "en": "Sides" }, "required": true,
          "kind": { "choice": { "options": [{ "value": "d6", "title": { "en": "Six" } }, { "value": "d20", "title": { "en": "Twenty" } }] } } }
      ]
    }
  ],
  "keeps": 0,
  "ai": false
}
```

`chat.mjs` has a handler for each command of the spec (`server.mjs` runs them): replace `hello`'s with `roll`'s.

```js
chat.command("roll", (ask) => {
  const sides = ask.args.sides === "d20" ? 20 : 6;
  return card().fields({ Rolled: String(1 + Math.floor(Math.random() * sides)) }).run("Again", "roll", { sides: ask.args.sides });
});
chat.text(() => card().text("Pick Roll below."));
```

And its test, in `test/chat.test.mjs` (`npm test` runs it on a development relay and registry, with no key of yours):

```js
test("roll answers a number of the dice asked", async (t) => {
  const chat = await testChat({ spec: new URL("../chat.json", import.meta.url), setup: handlers });
  t.after(() => chat.close());
  const rolled = Number((await chat.ask("roll", { sides: "d20" })).fields.Rolled);
  assert.ok(rolled >= 1 && rolled <= 20);
});
```

```sh
npm test && npm start
```

Every request names the user's language (`ask.lang`: `en`, `ru`, …, or `""` when the app does not say): answer in it
when you can, and in English otherwise.

The spec is signed by your server key, which may sign a spec while every command is free. A wallet keeps the highest
version it has seen: start above the spec Saltix signed when it made the app, and raise `version` with every change.
Each user gets the new spec before their next answer. The server remembers the spec it served (in `chat.store.json`)
and will not start on a `chat.json` changed under the same version: it says `raise "version" above N`.

## 4. Go public (1 minute)

Until now only you could use the app. To let testers in, add them as members: **My apps → your app → Members** (roles:
*user* uses it, *developer* gets a server key of their own, *viewer* reads the app's page). A member's wallet proves the
account with every request; your handler sees it as `ask.member`.

Before anyone else opens it, say what it is: the first time someone opens an app, Saltix shows its **Connect sheet**
("Saltix Connect", your app, its profile "in its own words", what it asks for, Continue). The profile is `connect.json`
in your project: a tagline that says what the app is, what it does, highlights that are facts, and what it keeps about a
user and for how long, in English and Russian ([how to write it](agents/app.md#the-connect-profile-connectjson)).
`grain lint` checks it; `grain profile` shows a QR code your Saltix sets it from (or write it in **My apps → your app →
Connect profile**). Ask only for the permissions the app uses: each is a row on that sheet.

When it is ready: **My apps → your app → Make public**. A public app is in the marketplace, anyone can open its chat,
and it never learns who its users are: each user is a key of their own in your app.

The same from the command line in the checkout (`npx grain …`): signed with the owner's key file on test networks, or,
without one, done in Saltix while the tool waits for the registry. Every command reaches the test network through its
public relays, pinned by their certificates; `--node URL` is a node of your own instead
([README](../README.md#networks-no-node-of-your-own-needed)). `grain faucet --wait` gives `owner.key`'s account test
SALT for the fees and deposits:

```sh
grain faucet --wait                                                # test SALT for owner.key's account
grain access --slug your-app --private --member dsalt1q…:user      # members, while private
grain access --slug your-app --public                              # anyone
grain bind --handle @your_app --slug your-app                      # a username you hold opens its chat
grain profile --key owner.key --wait                               # the Connect profile from connect.json
grain app-key --file app.key                                       # the key's public parts; is it registered?
```

## When something fails, you hear of it

Your chat with your own app is its console. When a handler throws, the user gets "failed", and you and your developers
get a report in the console: the error, where it happened, the command and request, your app's version, the time in UTC
and the stack. Try it with **Fail on purpose** in the example.

To fix it with a coding agent: long-press the report → **Copy for an AI agent** → paste it into Claude Code (or
another agent) in your app's folder, with "fix this". The copy carries the app, the message's id and the time, and never
a secret: the SDK scrubs keys out of every report.

```js
const chat = await ChatServer.start({ appKey, spec, store: fileChatStore("chat.store.json"), version: "1.0.3" });
await chat.notifyTeam(card().text("Someone asked for a feature: dark dice"));   // feedback, digests, alerts
await chat.report(error, { context: { command: "/roll" } });                    // an error you caught yourself
```

Your app reaches you from the start, without you writing to it: your Saltix says **hello** to your own app when you make
it, when you join its team and when you open it, with a proof of who you are, and the server keeps where your console is
and welcomes it (an older Saltix does not say hello: write to the app once). Each of your requests carries the same
proof. The same error is reported once an hour, with a count; the team gets at most 100 such messages a day. More in
[docs/chats.md](chats.md#the-teams-wallets-say-hello).

## Designing for Saltix

An app with a screen of its own (a page: `grain init`, then `grain dev`) opens as a full app, with Saltix's controls
`⋯ | ✕` floating in its top right corner, and its page laid out as browsers lay out a web page (Saltix 12-grains §7):
**safe by default; full screen only with viewport-fit=cover and the insets.** One line says it, the one Saltix ends
**Copy for an AI agent** with:

> Saltix lays an app's page inside the safe area; full screen only with viewport-fit=cover: then pad by grain_info.safe_area, keep tappable content clear of grain_info.controls, test at 475×751, 704×932 and 932×704 dp in grain dev (saltix-grains AGENTS.md).

- **Inside the safe area, by default.** A page that says nothing about insets is drawn below the status bar, the cutout
  and a band that holds the controls, above the navigation bar or gesture area and the keyboard. Nothing is ever over
  it; the band takes your page's colour. Such a page needs no work at all.
- **Edge to edge, when you ask**: `<meta name="viewport" content="width=device-width, initial-scale=1,
  viewport-fit=cover">` (`grain init`'s page does). The page then runs under the system's bars: keep text and controls
  inside the safe area by `--saltix-safe-top`, `--saltix-safe-bottom`, `--saltix-safe-left` and `--saltix-safe-right`,
  which Saltix sets on `:root` in pixels and keeps current as the phone turns or unfolds (`grain.layout()`, from
  `@saltix/grain`, sets them where Saltix does not, below Saltix's own values, and takes them away on `stop()`). Never
  write them into `:root`'s inline style: an inline value beats Saltix's and goes stale when the phone turns.
  Backgrounds may run under the bars.
- **The wallet's controls `⋯ | ✕` float in the top right corner**: over an edge-to-edge page, a 96 × 48 box, 8 px from
  the right inset and 4 px below the top one, which `grain_info.controls` and `--saltix-controls-top`, `-right`,
  `-width` and `-height` give. Never put anything tappable under it. A top bar's title stops short of it, or the bar
  starts below it.
- **No close button of your own.** ✕ closes the app, and the system's Back goes through your page's history first, then
  closes it. ⋯ opens the wallet's own sheet for the app (its chat, manage, share, reload, permissions).
- **Name the colour at the top of your page** with `grain.setHeader("#rrggbb")`: the wallet draws its band, the status
  bar's icons and its controls to contrast with it, until your next call. Without it, Saltix takes the page's
  `theme-color` (the first whose `media` matches and which is an opaque colour), else its background, and reads it again
  when the head changes, once the page has loaded and when the theme changes (not when a script changes the body's
  background alone). The simulator does the same, in the same order.
- **Saltix's splash** (your app's icon and name) shows while the page loads and goes once it has loaded:
  `grain.ready()` neither holds nor hides it. A page that checks who signed in first shows a splash of its own.
- **Your design is your own.** Saltix gives a page no colours, fonts or spacing (no design tokens), only `grain_info`
  (its `theme`, `dark` or `light`, and `language`) and the eight variables above. Draw both themes and switch by
  `grain_info.theme` and the `theme` event. Nor does Saltix give anyone's name: a user is a key of their own in your
  app, so let people type the name your app shows ([AGENTS.md](../AGENTS.md#naming-apps-and-people)).
- **Test at 475×751, 704×932 and 932×704** (the Galaxy Z Fold's sizes; CSS px equal dp), on a 360×780 phone and on the
  iPhone-like screen in the simulator `grain dev` prints, light and dark: it frames the page as Saltix does, inside the
  safe area or edge to edge by your meta, draws the bars, the cutout and the controls where a phone and Saltix do, and
  its ✕ and **Back** close the app as the phone's do. `grain lint` warns about a page that declares `viewport-fit=cover` and reads no inset
  (`cover-without-insets`), and about a bar pinned to the top of such a page that keeps clear of nothing
  (`full-screen-top-bar`).

A top bar that keeps clear on an edge-to-edge page, as `grain init`'s page has it:

```css
header {
  position: sticky; top: 0;
  padding-top: max(var(--saltix-safe-top), var(--saltix-controls-top));   /* level with the controls */
  padding-left: calc(16px + var(--saltix-safe-left));
  padding-right: max(calc(16px + var(--saltix-safe-right)), calc(var(--saltix-controls-right) + var(--saltix-controls-width) + 8px));
}
header h1 { min-height: max(48px, var(--saltix-controls-height)); display: flex; align-items: center; }
main { padding-bottom: calc(16px + var(--saltix-safe-bottom)); }
```

Outside Saltix the variables fall back by themselves: an older Saltix (bridge 1–2, and 0.1.53) draws its header above
the page, so they are 0; a plain browser gives its own insets (`env(safe-area-inset-*)`). A chat-only app has no page:
Saltix draws its home itself. A page for some people only (its team, a private circle) shows a splash until its
sign-in decides, then the app or a refusal page
([check first, then render](agents/app.md#a-page-for-some-people-only-check-first-then-render)), as `grain init`'s page
does. Every project `grain init` makes has an `AGENTS.md` with these rules, and a `CLAUDE.md` that points to it, so a
coding agent follows them too.

## What the server does for you

- **Checks every request** as the protocol says: from its key's address, signed, alive, fitting the spec; a private
  app's from its owner and members only, judged against the registry and the accounts' current keys.
- **Signs every card** with your key, answers each request once, keeps answers in the user's mailbox while the phone is
  offline, and takes requests that came while it was down.
- **Watches the registry**: it starts only when the registry names the key, and stops — saying so in its log — once the
  key is replaced or revoked.
- **Reports its numbers**: users of the last day and 30 days and the requests, signed hourly and handed to its relay,
  which gossips them to every node; the marketplace and the explorer show them as "reported by the app". A private
  app reports none (its log says `stats_not_reported`) until it is public. It keeps nothing about a user longer than 30
  days for them.
- **Tells your team** what goes wrong: handlers' errors as reports in the console, folded within an hour and scrubbed of
  secrets.
- **Welcomes your team's wallets**: a team member's Saltix says hello to the app by itself, and the server keeps where
  their console is, so updates and reports reach them before anyone writes. Nobody else gets an answer to a hello.

## When it does not start

| It says | Do |
|---|---|
| `the registry does not name this server key for your-app: the owner replaced this server key` (or `names no server key`) | Make a new developer key in Saltix (My apps → your app → Developer key), or run the server that holds the new one |
| `…: the grain is retired` | A retired slug is never used again: make a new app |
| `…: the registry has no such grain` | Just made? Wait until Saltix shows the app live in My apps, then start again |
| `the developer key is for devnet 7e70a4e3…, but the network answering is …: was the network reset?` | The test network was reset: make the app and its key again |
| `not a developer key` / `a malformed developer key` | Copy the whole key again (it starts with `saltix-app:1:`) |
| `no public relays are known for mainnet` | Pass `node` (your own node's wallet interface) to `ChatServer.start`, or `NODE_RPC` to the example |
| `wallets write to the first server key the registry names` (a warning) | Requests reach the first key's server: run that one, or make yours first in Saltix |
