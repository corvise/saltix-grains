# How a Saltix mini-app works

Read this page first, whether you are a person or a coding agent: what a mini-app is made of, what runs where, whether
your app needs a server at all, and every step from an empty folder to an app people use, as one checklist. The pages it
links to go deeper; [AGENTS.md](../AGENTS.md) has the rules every app keeps.

## The pieces

```text
 the owner's phone                   the Saltix network                          wherever the program runs
 Saltix: My apps, the PIN  ──signs──▶ the registry, on chain:                     (this computer, any small server)
                                      slug, manifest, server keys,
                                      access, Connect profile, deposit
 users' phones                        relays: messages, mailboxes,  ◀──out, wss──  the app's program (optional):
 Saltix ── the app's page             files next to them                           ChatServer + app.key
           in a WebView, the  ◀────── the page's bundle, kept by the     ◀──────  grain publish, from your computer
           bridge to Saltix           network, checked by its hash
```

- **Saltix** is the wallet and messenger, on Android (and in a browser linked to the phone, web.saltix.io). It holds
  the user's keys; an app never gets them. Its **Apps** tab has the marketplace and **My apps**, where anyone makes an
  app in a few taps (**New app**: Saltix 24-app-studio, [app-studio.md](protocol/app-studio.md)).
- **The registry** is on chain ([grains §3](protocol/grains.md#3-registry), [app-studio §2](protocol/app-studio.md#2-the-registry)).
  For each app it holds its **slug** (its address `salt:grain/<slug>`, fixed, never used again once retired, with a
  deposit of 100, 30 or 10 SALT by its length), its signed **manifest** (name, icon, form, permissions, version), the
  **server keys** its program may speak with (at most 4), who may use it (**access**: private with its members, or
  public), its **Connect profile** (what Saltix shows before anyone opens it) and a username bound to it.
- **The owner's phone signs everything the registry holds of the app.** An app made in Saltix belongs to the phone's
  account, and only that account changes it, after the PIN: in My apps, from a QR code a command shows
  (`grain publish --wallet`, `grain profile --wallet`), or from a **Publish** card the program sends to the app's
  console (`chat.proposeUpdate`). No computer holds the owner's key. (An app registered from a computer with a key
  file, on the test network, is signed by that file instead: `grain init`'s `owner.key`.)
- **The page** (if the app has one) is HTML, JavaScript and CSS that Saltix opens full screen in a WebView, with its
  own controls `⋯ | ✕` in the corner. It talks to Saltix only through the bridge, `window.saltix`, which
  [`@saltix/grain`](../packages/grain) wraps: the user's key in this app and its sign-in, payments through Saltix's own
  sheet, storage (1 MiB per user, encrypted, synced across the user's devices), frames to other users of the app through
  the relays, notifications, the safe area ([grains §5](protocol/grains.md#5-the-bridge)). Its files are either
  **sealed** (one ZIP named by its hash, which the network keeps once `grain publish` put it there, and which Saltix
  downloads once from its own relay, checks and serves from the phone, offline) or **hosted** (pages from an HTTPS site
  you run, which may change them at any time; Saltix says so)
  ([grains §1](protocol/grains.md#1-forms), [§8](protocol/grains.md#8-sealed-bundles)).
- **The chat** (if the app has one) is the app in Saltix's messenger: users run the commands its spec declares
  (`chat.json`) and get cards back. A chat-only app has no page: Saltix draws its **home** from the spec. The team's
  chat with its own app is the app's **console**: notices, error reports and updates
  ([grain chats](protocol/grain-chats.md), [docs/chats.md](chats.md)).
- **The program** (if the app needs one) is a Node.js process built on
  [`@saltix/grain-server`](../packages/server): `ChatServer` answers the chat with cards it signs, signs invoices and
  notifications, keeps state, and reads the registry. It **connects out** to the network's public relays over a
  WebSocket, pinned by each relay's certificate hash, so it needs **no domain, no open port and no certificate**: it
  runs on a laptop behind a home router as well as on a small server. While it is off, requests wait in its mailbox (a
  command waits up to 7 days) and are answered when it comes back.
- **The program's key** is one of the server keys the registry names, kept in the project's `app.key` with the network
  and the slug (`saltix-app:1:<hrp>:<genesis>:<slug>:<secret>`): the program's whole configuration. **It is made on the
  computer where the program runs and never leaves it**: `grain pair` makes it and the owner's Saltix names it by a QR
  code ([app-studio §3a](protocol/app-studio.md#3a-pairing-a-server-by-qr-code)); a developer key made in Saltix stands
  in only for a host where no command runs ([§3](protocol/app-studio.md#3-the-developer-key)). It lets the program speak
  for the app, sign invoices that pay **the owner only**, and notify. It never changes the manifest, the keys, the
  access or the deposit, and the owner removes or replaces it in Saltix at any time.
- **Relays** are the network's nodes that carry messages between Saltix, pages and programs, keep mailboxes for whoever
  is offline, and keep files next to them for 30 days ([relays](protocol/relays.md)).

| Piece | Runs on | Holds |
|---|---|---|
| Saltix | users' phones (and a browser linked to one) | the user's keys; each app's storage for that user |
| The page | inside Saltix, in a WebView | nothing secret: its code is public |
| The page's files | a sealed bundle the network keeps (`grain publish` puts it there); or a hosted site you run | nothing secret |
| The program | your computer or any server with outbound internet | its key (`app.key`, made there by `grain pair`), its store (`chat.store.json`) |
| The registry | the chain | the manifest, server keys, access, Connect profile, deposit |
| The relays | the network's nodes | messages on their way, mailboxes, files for 30 days |

## Do I need a server?

| The app… | Program? | How |
|---|---|---|
| is a page that works on its own: a game, a calculator, a converter, a timer, notes | **No** | the page alone; what it keeps per user goes in `grain.storage` (1 MiB, encrypted, on every device of the user) |
| lets users who have it open play or talk together live (a two-player game) | **No** | frames between users' keys in the app, through the relays (`grain.relay`; `keep` holds one in the other's mailbox) |
| is a chat: commands and cards in Saltix, a home drawn from its spec | **Yes** | `ChatServer` with its paired key ([docs/chats.md](chats.md)) |
| takes payments for something it delivers | **Yes** | the program signs the invoice and delivers once `chat.paymentOf` finds the payment on chain ([payments](payments.md)) |
| pays someone other than the app's owner (a seller, a shop) | **Yes** | a server key the owner key certified (`grain cert`, for an app whose owner holds a key file): a developer key's invoice pays the owner only |
| keeps state shared between users beyond a session (a leaderboard, a shared list, bookings) | **Yes** | the program keeps it; users reach it through the chat |
| notifies users while the app is closed | **Yes** | notifications signed by a server key (`chat.notify`) |
| has a page for some people only (its team, a private circle) | **Yes** | `SignIns` checks who signed in against the registry ([check first, then render](agents/app.md#a-page-for-some-people-only-check-first-then-render)) |

**When a domain and a certificate do come in**: only when the page calls the program itself over HTTP
(`grain.signIn({ url })`, `fetch`). That endpoint is an HTTPS origin you run, named in the manifest's `connect` (a
sealed page reaches nothing else). A program that only answers the chat never needs one. A page-only app needs nothing
at all: `grain publish` puts its files into the network ([Publish](#publish-a-page) below).

## The lifecycle, as one checklist

1. **One app, one project, one key.** Each app has its own slug, its own folder and its own key in that folder's
   `app.key`. Never reuse another app's key or slug, and never run a second program on a key that already has one (the
   SDK's example included: it is an app of its own): two programs on one key both answer in its chat, and the users see
   both. The owner makes the app in Saltix (**My apps → New app**: it starts private and chat-only), when pairing the
   project (a free slug makes the app in place), or from `grain publish --wallet`'s QR code.
2. **Set up and pair.**
   - The SDK is not on npm yet: clone it, `npm install && npm run build`, and make the app's project beside it with
     `npx grain init ../<slug> --chat --slug <slug>` (a chat) or `npx grain init ../<slug> --slug <slug>` (a page), then
     `npm install` in the project, which links the SDK and the `grain` command from the checkout.
   - Then the key, by **pairing** (Saltix 24-app-studio [§3a](protocol/app-studio.md#3a-pairing-a-server-by-qr-code)),
     every session from `npx grain status`. Not `paired`: `npx grain pair` makes the program's server key on your
     computer (`.grain/pair.key`, owner-only, never printed, logged or sent) and shows a QR code (also
     `.grain/pair.html`), a link and a 6-digit code. The owner scans it with Saltix (the phone's camera, or **My apps →
     Pair a server**), checks that Saltix shows the same code, keeps **Add this server** and confirms with the PIN;
     Saltix asks the computer through the relays, and `grain pair` writes `app.key` and `app.json` once the registry
     names the key. No key is copied at all. `npx grain doctor` names what is left.
   - **A developer key** stands in only for a host where no command runs: the owner copies it in Saltix (**Copy key**)
     and saves it there themselves; a coding agent never asks for one in its chat.
3. **Build.** A chat: `chat.json` (the commands; raise its `version` with every change) and their handlers in
   `chat.mjs`, tested end to end with `testChat` (`npm test`) ([docs/agents/app.md](agents/app.md)). A page: `public/`,
   with `@saltix/grain` for the bridge. Both: a page beside the chat, which Saltix keeps.
4. **Keep the standards.** `grain lint` checks the Connect profile (`connect.json`, English and Russian, only the
   permissions the app uses), the icon (512 × 512, opaque, at most 64 KiB, drawn in Saltix's rounded square; `grain icon
   <picture> --out icon.png` makes one from any picture and names it, [icons](icons.md)) and the page: inside the safe
   area unless it declares
   `viewport-fit=cover` ([AGENTS.md](../AGENTS.md)), and a page for some people only checks first, then renders. Every
   card keeps the [card standard](agents/cards.md), which `assertCardStandard` checks in the tests.
5. **Try it.** A page: `npx grain dev` serves it with the simulator, which frames it as Saltix does at a phone's and the
   Galaxy Z Fold's sizes and holds it to Saltix's rules; a debug Saltix in the Android emulator opens the link it
   prints. A chat: `npm start` in the project, then in Saltix tap the app in **My apps**: its home shows the commands,
   and an answer is marked "from <slug>, verified".
6. **Publish.** A chat goes live as soon as its program runs: there is nothing to upload. A page is a new version of
   the manifest: `grain publish` puts its bundle into the network, and the owner signs it ([below](#publish-a-page)). Going **public** (from private) is the owner's, in
   Saltix or `grain access --public`.
7. **Run the program where it stays up** (when the app has one): your computer while you test, then any small server
   with outbound internet, under a supervisor that does not restart it on exit status 78 (a key that cannot work).
   [Below](#run-the-program).
8. **Update and rotate.** A new command or text: change `chat.json`, raise `version`, restart. A new release of the
   program: raise `package.json`'s `version` (error reports name it), restart. A new name, icon or page: a new manifest
   version the owner approves (`grain publish --wallet`, or `chat.proposeUpdate` in the console). A new key, to rotate
   one or replace one that leaked or stopped working: `npx grain pair --new` on the computer, then **Use only this
   server** in Saltix, and no key travels (a developer key: **Replace key** on the app's page in Saltix). The old key
   stops at the block that takes the change, its program exits with 78, and the new key in `app.key` starts it again.
   Requests sent meanwhile wait in the mailbox.

## Publish a page

The owner's phone signs every version of the manifest. **The network keeps the bundle**: `grain publish` seals
`public/` and puts it from your computer straight into the Saltix network, onto the servers that keep it (storage cities
and relays offering space), and every Saltix fetches it from its own relay by its hash (Saltix
[32-images §7.3](protocol/images.md#73-bundles-from-the-developers-machine-into-the-network)). No host, domain or
certificate of your own, and no file to upload anywhere.

```sh
npx grain lint                     # the manifest, the Connect profile, the icon, the page
npx grain icon logo.png --out icon.png   # the icon, once (grain.json names it)
npx grain publish                  # seal, check, upload into the network, then a QR code the owner's Saltix signs
```

- **With `app.key` paired** (`grain pair`), the bundle goes up before the owner signs, on the paired key's statement,
  and the network holds it for a day: the owner scans the QR code whenever they like. Without it (an app's first
  version), it goes up once the registry names the version, so the command keeps running until the owner signed.
- **The sources** a manifest names are the SDK's to fill in: none on a network that runs protocol version 2; before it
  (the test network runs version 1), copies the network itself serves at up to 3 relays of its relay list.
- **`--no-wait`** returns once the QR code is shown (also `.grain/publish.html`); `grain publish` again finishes (the
  bundle if it waited, the icon). A break, a busy node, a version the registry already holds: run it again.
  `grain doctor` says where it stands (`not_uploaded`, `pending`, `waiting_for_owner`, `pending_expired`, `published`).
- An app made in Saltix is its owner's phone's, so `grain publish` asks the owner's Saltix even when the project has an
  `owner.key`; `--wallet` says so outright. A program can propose the same update in the console instead:
  `chat.proposeUpdate(next, { bundle })` puts the bundle into the network and sends **Review and approve** to the owner.

**Hosted, if you want it.** Your HTTPS site serves `public/` and the signed manifest at `/.well-known/saltix-grain`
([README](../README.md#the-command-line)), and `grain publish --hosted` registers it; it can change the page at any
time, and Saltix tells users so.

**While you develop**, `grain dev` serves the page from your computer to the simulator and to a debug Saltix in the
emulator; a release Saltix never opens such a development origin.

## Run the program

- **On your computer**: `npm start` in the project. The app answers while it runs; requests sent while it is off wait
  in the mailbox up to 7 days.
- **On a server**: any small Linux machine with Node 20 or newer and outbound internet; nothing to open in its
  firewall. Put the SDK's checkout and the project side by side there as on your computer (the project links the SDK
  from `../saltix-grains` while it is not on npm): `npm install && npm run build` in the checkout, `npm install` in the
  project. Then run `server.mjs` under a supervisor. With systemd, the key as a credential and the store in a state
  directory ([docs/agents/app.md](agents/app.md#ship) has the whole unit):

  ```ini
  [Service]
  ExecStart=/usr/bin/node /opt/<slug>/server.mjs
  LoadCredential=app-key:/etc/credstore/<slug>.app-key
  Environment=SALTIX_APP_KEY_FILE=%d/app-key
  StateDirectory=<slug>
  Restart=on-failure
  RestartPreventExitStatus=78
  ```

- **Exit status 78** means restarting cannot help: the key was replaced or revoked, the app retired, the test network
  reset, or `chat.json` changed under a version already served. Its log says what to do
  ([When it does not start](first-app.md#when-it-does-not-start)).
- **One program per key.** Moving it to a server means pairing the server there (`grain pair` on it, **Add this
  server**), then removing the old key in Saltix and stopping the program on your computer.

## Where to look

- [AGENTS.md](../AGENTS.md): the rules, and the first steps of a coding agent given Saltix's brief or a key.
- [docs/first-app.md](first-app.md): the first app in ten minutes, building with a coding agent, when it does not start.
- [docs/agents/app.md](agents/app.md): the whole path for a coding agent, the rules every app follows, error reports.
- [docs/protocol/](protocol/README.md): the protocol as an app needs it.
- The app's **console** in Saltix (the app's chat, for its team): errors arrive there as reports; long-press one,
  then **Copy for an AI agent**.
