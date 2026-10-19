# Your first app in ten minutes

An app in Saltix can be a chat: users talk to it in the wallet, it answers with cards it signs. You make a project on
your computer, **pair** it with an app in Saltix by scanning a QR code, and run its server. The server's key is made on
your computer and never leaves it: there is nothing to copy, paste or send (Saltix
[24-app-studio §3a](protocol/app-studio.md#3a-pairing-a-server-by-qr-code)). There is nothing to host, no domain and no
certificate.

What you need: Saltix on your phone with some SALT for the deposit (the test network's faucet gives it), Node 20 or
newer, and a checkout of this repository. How the pieces fit, and whether your app needs a server at all (a page alone
needs none): [How a mini-app works](how-it-works.md). Building it with a coding agent? Saltix copies a brief for it:
[Building with a coding agent](#building-with-a-coding-agent).

## 1. A project, paired with its app (3 minutes)

```sh
git clone https://github.com/corvise/saltix-grains.git && cd saltix-grains
npm install && npm run build                         # the SDK and the grain command line
npx grain init ../your-app --chat --slug your-app   # chat.json, connect.json, chat.mjs, server.mjs, test/, package.json…
cd ../your-app && npm install                        # the SDK, from the checkout (it is not on npm yet)
npx grain status                                     # status: unpaired; next: grain pair
npx grain pair
```

`grain pair` makes the server's key in `.grain/pair.key` (owner-only, never printed) and shows a QR code, a link,
`.grain/pair.html` (the same QR code for a browser) and a code:

```text
Pair this server with Saltix: scan the QR code with the app owner's Saltix (the phone's camera, or My apps → Pair a server).
  code         482 913   (Saltix shows it too: pair only if it is the same)
  app          your-app
  network      devnet 7e70a4e3c2b04efe
  server key   1476ff04 (its secret stays in .grain/pair.key on this computer)
```

In Saltix, scan it (the phone's camera opens Saltix, or **Apps → My apps → Pair a server**):

1. Saltix shows the same **code**: pair only if it matches your screen.
2. **The app.** You have no `your-app` yet, so Saltix makes it on the spot: private, named after `grain.json`, with the
   deposit for the slug's length (100 SALT for 3–5 characters, 30 for 6–7, 10 for 8 or more; it comes back 30 days
   after you retire the app). For an app you have, it pairs that one.
3. **Add this server** (the default): your app's chat goes to this computer. **Use only this server** removes every
   other key.
4. **Pair**: Saltix asks your computer through the relays, and the terminal prints `Saltix asked to pair this server
   with your-app…`. Then the PIN, and the transaction's four steps.

The terminal ends with `Paired: this server speaks for your-app on devnet (key 1476ff04)`: it wrote `app.key`
(owner-only) and `app.json` (the app, the network, the key's public half), and `.gitignore` keeps `app.key`, every
`*.key` and `.grain/` out of git. `npx grain status` now says `paired`.

- Nobody scanned in time? `npx grain pair` again shows the same offer while it lives (30 minutes), or a new one.
- A managed account's call may wait its delay: `npx grain pair` again finishes once the registry names the key.
- A coding agent that cannot leave a command running while it shows you the QR code runs `npx grain pair --no-wait`
  first, then `npx grain pair` to wait.
- **To rotate the key**, or replace one that stopped working (a reset network, a key removed): `npx grain pair --new`,
  then **Use only this server** in Saltix.

The paired key speaks for your app in its chat: it signs its cards, its price-free commands and its notifications, and
asks for payments to you only. It cannot move your money or change the app, and you remove it in one tap (**My apps →
your app → Servers**).

Keep the app **private** while you develop it: only you and the members you add can use it (My apps → your app). It goes
public when it is ready (step 4).

**Without Pair a server.** A Saltix from before pairing, or a host where no command runs (a platform that takes only
environment variables): make the app in **My apps → New app** and take its **developer key**,
`saltix-app:1:dsalt:7e70a4e3…:your-app:…`, shown once. It is a secret that travels: whoever holds it speaks for your app
until you replace it. Write it to an owner-only `app.key` with `(umask 077 && pbpaste > app.key)` (Linux: `xclip -o`),
or set `SALTIX_APP_KEY`, never on a command line and never in a chat or a repository.

## 2. Run it (1 minute)

```sh
npm start
```

```text
{"at":"…","level":"info","event":"ready","slug":"your-app","address":"dsalt1q…","network":"devnet","spec":4}
```

`server.mjs` reads `app.key` (or `SALTIX_APP_KEY`), finds the network's public relays, checks that the registry names
the key for your app, signs `chat.json` with it and answers. The key never appears in its output. Without a key it
refuses to start and says to run `grain pair` (exit 78, which a supervisor should not restart on); it exits with 78 too
when the key cannot work (replaced, revoked, the app retired, another network's) or `chat.json` changed without raising
its `version`.

In Saltix, tap your app in **My apps**: it opens the app's **home**, Saltix's own screen drawn from your chat spec, with
its commands as buttons and the answers as cards (long-press manages the app instead). Its chat, a secondary way in, is
your app's **console**. Pick **Say hello**: the answer is a card marked "from your-app, verified", because the registry
names the key that signed it.

The example in the checkout is an app of its own: `npx grain pair --name "Hello example"` there, and in Saltix pick
**New app** (never your app: one app, one program), then `npm run example`
([`examples/hello-grain/server.mjs`](../examples/hello-grain/server.mjs)), with **A key** (a secret, masked until you
tap it), **A report** (a CSV file next to the relay) and **Fail on purpose** (below).

`owner.key`, which `grain init` also makes, is the command line's own owner key, for registering from a computer on a
test network; an app made in Saltix has its owner on your phone and never uses it.

Never run the example, or any second program, with the key of an app that already has a program: two programs on one
key both answer in its chat, and the example's spec (version 3) sits below your project's (4, `grain init`'s), so a
wallet that holds yours refuses it.

## 3. Add a command (3 minutes)

`chat.json` declares what users can send; its `slug` is your app's. Each command has a title, help and typed parameters;
the wallet draws the form and checks it before anything leaves the phone ([docs/chats.md](chats.md#the-spec)):

```json
{
  "slug": "your-app",
  "version": 5,
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
version it has seen and refuses a lower one: `grain init` starts at 4, above the spec Saltix signed when it made the
app (1) and the example's (3), and you raise `version` with every change.
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
grain profile --key owner.key                                     # the Connect profile from connect.json
grain status                                                       # the server's key: paired? what next?
grain doctor                                                       # everything else, and the exact next step
```

## Publish a page: straight into the network

An app with a page of its own (`grain init` without `--chat`; `grain dev` shows it as Saltix frames it) needs **no server
and no hosting**: `grain publish` seals `public/` into one bundle and puts it into the Saltix network from your computer,
onto the servers that keep it (three storage cities and five relays offering space); your Saltix signs the version from
a QR code, and every wallet fetches the bundle from its own relay by its hash (Saltix
[32-images §7.3](protocol/images.md#73-bundles-from-the-developers-machine-into-the-network)). There is no domain, no
certificate and no file to upload anywhere.

```sh
npx grain init ../space-game --slug space-game --name "Space"   # grain.json, connect.json, public/ with the bridge
cd ../space-game && npx grain dev                              # write the game; the simulator shows it
npx grain icon ~/Pictures/logo.png --out icon.png             # its icon, to the standard (docs/icons.md)
npx grain pair                                                 # optional: lets the bundle go up before you sign
npx grain publish
```

```text
bundle: 14 files, 1.8 MiB, 9e41c0…
sources: the network's own copies at 3 relays (protocol version 1 needs one; wallets ask their own relay first)
version: the registry holds space-game v1; this one is v2 (grain.json says so now)
upload: into the network now, vouched for by the server key 1476ff04 (app.key)
  uploaded 0% (0 bytes of 1.8 MiB)
  uploaded 27% (512.0 KiB of 1.8 MiB)
  …
  uploaded 100% (1.8 MiB of 1.8 MiB)
the network holds the bundle, pending until 2026-10-20T14:02:11.000Z: the owner signs within that day, and this computer need not stay on
█▀▀▀▀▀█ … (the QR code)
Publish space-game v2: scan the QR code with the app owner's Saltix (the phone's camera), check the app and confirm with the PIN.
  page  …/space-game/.grain/publish.html (the QR code for a browser)
  link  salt:grain-publish?m=…
Waiting for the owner's Saltix and the registry… (Ctrl-C stops; grain publish again goes on from here)
icon: in the network
space-game v2 is published, its bundle in the network; signed.json written. Saltix opens it from the Apps section (or salt:grain/space-game).
```

What happens, step by step:

1. **The bundle.** `public/` is sealed as `grain bundle` seals it (the same bytes from the same files on any computer)
   and checked as every node checks it; `grain.json` names it and `bundle.zip` is written. A bundle the network keeps is
   at most 16 MiB.
2. **The sources.** A network that runs protocol version 2 needs none. Before it (the test network runs version 1), a
   sealed manifest must name one, so the tool names copies the network itself serves, at up to 3 relays of its own relay
   list; you never host anything.
3. **The upload.** With a server key the registry names for the app (`grain pair`'s `app.key`; or `SALTIX_APP_KEY`,
   `--app-key`), the bundle goes up now, in pieces of 256 KiB, on that key's signed statement: the network holds it
   **pending** for a day. A break is no loss: run `grain publish` again and it goes on where the node stands; a busy node
   is waited out. Without a paired key (an app's first version), it goes up once the registry names it, and the command
   keeps running until then.
4. **Your signature.** Scan the QR code with your Saltix: it shows the app, the version and what changed, and after the
   PIN signs the manifest and registers it (a new slug's deposit: 100 SALT for 3–5 characters, 30 for 6–7, 10 for 8 or
   more). Your key never leaves the phone. On the test network, `--key owner.key` signs here instead (after `grain faucet
   --wait`).
5. **The registry and the icon.** Once the registry holds the version, the icon goes into the network, and
   `signed.json` is written. Run again, `grain publish` finishes whatever a break left; a version the registry holds
   already only gets its uploads.

`--no-wait` returns once the QR code is shown (a coding agent shows it to you, then runs `grain publish` again after you
scanned it). `grain doctor` says where a publish stands: `not_uploaded`, `pending`, `waiting_for_owner`,
`pending_expired` or `published`. A refusal is said in words with what to do (`busy`: again in a few minutes; `key`: the
registry no longer names this computer's key, `grain pair --new`; …), and every step is in `.grain/log.jsonl` by its
reason. A page you host yourself is published with `--hosted` instead.

## Building with a coding agent

Wherever Saltix shows an app's key it offers **Copy brief for a coding agent**: on New app's last step, on the app's
page (its key, and How to build it while no program has answered), on its home, on a developer's key in their chat,
and on the console's notices of the app made and of a key added or replaced (from the Saltix release after 0.1.59).
Paste the brief into Claude Code or another agent in an empty folder. It is everything the agent needs to start, in English, with one line asking it to answer you
in the language your Saltix is in, and never the key, so it is safe in a chat. This is the brief of a chat-only app on
the test network; Saltix fills in the name, the slug, the network's genesis and what the app is for, and an app with a
page of its own gets its page's rule, `grain init` without `--chat` and `npx grain dev` in place of `npm start`:

```text
Brief for a coding agent: build the Saltix mini-app "{name}" ({slug}).
Answer me in English: it is the language of my Saltix app.

Saltix is a wallet and messenger on its own blockchain network (https://saltix.io). A mini-app opens inside Saltix: a page of its own (HTML in Saltix's WebView, talking to Saltix through the @saltix/grain bridge), a chat whose answers are cards signed by the app's program, or both. A page alone needs no server. A chat, payments and state shared between users need a program built on the SDK: it connects out to the network's relays, so it needs no domain, open port or certificate, and runs on this computer or any small server.

The app
- Name: {name}
- Slug: {slug} (its address: salt:grain/{slug})
- Form: chat only for now: Saltix draws its home from the chat spec (chat.json); a page of its own comes with a new version of its manifest, which I approve in Saltix
- Network: the Saltix test network (devnet kind: addresses dsalt1…, genesis {genesis}); it is reset now and then, and a key made before a reset stops working
- About: {what it is for}

SDK: https://github.com/corvise/saltix-grains (public). Read first: docs/how-it-works.md (what runs where, whether this app needs a server, every step to a published app), then AGENTS.md and docs/first-app.md. To start:
  git clone https://github.com/corvise/saltix-grains.git && cd saltix-grains
  npm install && npm run build
  npx grain init ../{slug} --chat --slug {slug} && cd ../{slug} && npm install

Then pair the project with the app; no key ever passes through this chat. Run `npx grain status` first: it says what is connected and the next step. Then `npx grain pair` (or `npx grain pair --no-wait`, then `npx grain pair` to wait): it makes the program's key on this computer, never printed, and shows a QR code (also in .grain/pair.html) and a six-digit code. Show me the QR code and the code, then wait: I scan it with Saltix, check the code and confirm, and it writes app.key once the app names the key. Then `npx grain doctor` names anything left. Never ask me to paste, type or send a key: a developer key (saltix-app:1:…) is only for a host where no command runs.

One app, one key, one program: the key is {slug}'s alone. Never run the SDK's example or another program with it, and never use another app's key or slug here: two programs on one key both answer in its chat.

Then `npm start`. It works when its log shows the "ready" event and the app's home in Saltix (tap the app in My apps) shows Say hello, whose answer is marked "from {slug}, verified". Then ask me what the app should do.

Stuck? `npx grain doctor`, docs/first-app.md ("When it does not start"), docs/agents/app.md, and the app's console in Saltix (its chat): errors arrive there as reports (long-press one, then Copy for an AI agent).
```

**What you do.** Paste the brief and let the agent set up the checkout and the app's own project beside it
(`../{slug}`). Then it pairs the project with your app: it runs `grain status`, then `grain pair`, and shows you a QR
code (in its output, or `.grain/pair.html` in a browser) and a 6-digit code. Scan it with Saltix (the phone's camera, or
**My apps → Pair a server**), check that Saltix shows the same code, keep **Add this server** and confirm with your PIN
([step 1](#1-a-project-paired-with-its-app-3-minutes) has the screens). The key is made on your computer and never
goes through the agent's chat; `grain pair` writes `app.key` once the registry names it, and `grain doctor` says what
is left. Only for a host where no command runs does a developer key stand in (**Copy key** in Saltix, then
`(umask 077 && pbpaste > app.key)` there yourself).

**What the agent does.** It clones the SDK, reads [How a mini-app works](how-it-works.md) and
[AGENTS.md](../AGENTS.md#start-here-saltixs-brief-or-a-developer-key), whose first section is for an agent given the
brief or a key, makes the app's own project with `grain init`, pairs it (`grain status`, `grain pair`, `grain doctor`),
runs `npm start`, asks you to try the app, and then asks you what the app should do. It never asks you for a key, and
never runs the SDK's example with your app's key: the project is the app's one program.

**The first test.** In Saltix, tap the app in My apps: its home shows the project's command, **Say hello**, with a
**Your name** field. Type a name: the answer comes as a card marked "from your-app, verified", saying "Hello, {name}!",
and the console notes that the program answered for the first time. A first change worth making is that answer: edit
it, raise `chat.json`'s `version`, start the program again and see the new card arrive. An app with a page starts with
`grain init` (without `--chat`) and `npx grain dev`, which shows the page as Saltix frames it; publishing it is
[Publish a page](how-it-works.md#publish-a-page).

**A key that leaked.** A key that went into a chat (the agent's too), a log, an issue or a commit is replaced, not
hidden. A paired key: `npx grain pair --new` on the computer, then **Use only this server** in Saltix; no key travels. A
developer key: in Saltix, a long press on the app, then Program, **Replace key**. Either way the old key stops working
at the block that takes the change, and a server still running with it stops with exit status 78
(`the owner replaced this server key`); requests sent meanwhile wait in its mailbox. Nothing else changes: the app, its
address, members, chat and deposit stay. A key in git's history stays there: replacing it is the fix, not rewriting the
history.

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
`⋯ | ✕` floating in its top right corner, and its page laid out as browsers lay out a web page (Saltix [12-grains §7](protocol/grains.md#7-security-of-the-container)):
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
| `no key: this server is not paired with an app` | `npx grain pair`, and scan its QR code with your Saltix |
| `this server's key is not paired with an app yet` | `npx grain pair` again: it finishes once Saltix's transaction named the key |
| `app.key: readable by others` | `chmod 600 app.key` |
| `the registry does not name this server key for your-app: the owner replaced this server key` (or `names no server key`) | `npx grain pair --new` and pair the new key, or run the server that holds the new one |
| `…: the grain is retired` | A retired slug is never used again: `npx grain pair --new`, and make a new app from its QR code |
| `…: the registry has no such grain` | Just made? Wait until Saltix shows the app live in My apps, then start again |
| `the developer key is for devnet 7e70a4e3…, but the network answering is …: was the network reset?` | The test network was reset: `npx grain pair --new` |
| `not a developer key` / `a malformed developer key` | `npx grain pair --new`; a handed-over key: copy the whole key again (it starts with `saltix-app:1:`) |
| `no public relays are known for mainnet` | Pass `node` (your own node's wallet interface) to `ChatServer.start`, or `NODE_RPC` to the example |
| `wallets write to the first server key the registry names` (a warning) | Requests reach the first key's server: run that one, or make yours first in Saltix |
