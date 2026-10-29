# saltix-grains

Got a command starting with `grain pair --app`? It is the pairing command from a Saltix mini-app's page — start with
[docs/how-it-works.md](docs/how-it-works.md) and [AGENTS.md](AGENTS.md#start-here-saltixs-brief-or-the-pairing-command);
run it in the app's project and show its QR code. A key starting with `saltix-app:1:` is a developer key made before
pairing: keep the key in `app.key`, never in a chat or a commit, and pair a server in its place.

SDKs and tools for **grains**, apps that open inside Saltix wallets (*mini-apps*, as Saltix calls them in its Apps
tab; *grain* is the protocol's word). The rules are the protocol's, and **[docs/protocol/](docs/protocol/README.md)**
holds everything an app needs of them: [grains](docs/protocol/grains.md) (12-grains),
[grain chats](docs/protocol/grain-chats.md) (22-grain-chats), [the app studio](docs/protocol/app-studio.md)
(24-app-studio), [Saltix Connect](docs/protocol/connect.md) (19-connect), [images](docs/protocol/images.md)
(32-images: icons, and bundles the network keeps), [relays](docs/protocol/relays.md), the
[wallet interface](docs/protocol/wallet-interface.md) and the [basics](docs/protocol/basics.md) (addresses, amounts,
keys). A grain uses the wallet's identity, payments, storage and relays, and never holds the wallet's keys. It may be a
page, or a chat and nothing else.

### Quick path for a page-only app

A page that works on its own needs no server, no key to pair and no hosting:

```sh
git clone https://github.com/corvise/saltix-grains.git && cd saltix-grains && npm install && npm run build
npx grain init ../my-game --slug my-game --name "My game" && cd ../my-game && npm install
npx grain dev                    # a server until Ctrl-C: the simulator, for a person (an agent: in the background, or not at all)
npx grain dev --check --tap      # headless, and exits: every screen, both themes, each button tapped once (those a tap brings up too)
npx grain icon --monogram M      # an icon to the standard (or grain icon <picture> --out icon.png)
npx grain doctor                 # what is left; before the first publish, the deposit and the fees; exit 75: wait
npx grain publish                # into the network; the owner's Saltix signs from a QR code
```

No phone, on the test network: `grain faucet --wait`, `grain publish --key owner.key`, `grain profile`, `grain access`
([No phone, test network](docs/how-it-works.md#no-phone-test-network): the steps, how long each takes, who can open the
app). Servers, keys and pairing are for an app with a program (a chat, payments, notifications):
[Your first app in ten minutes](docs/first-app.md).

**[How a mini-app works](docs/how-it-works.md)**: what runs where, whether your app needs a server (a page alone needs
none; a program connects out to the relays, with no domain, open port or certificate), and every step to a published
app as one checklist. **[Your first app in ten minutes](docs/first-app.md)**: `grain pair`, with the command from the
app's page, shows a QR code; your Saltix scans it and makes (or pairs) the app; `npm start`. The server's key is made on your computer and never leaves it:
nothing to copy.

**A page needs no server and no hosting**: `grain publish` seals `public/` into a bundle and puts it straight into the
Saltix network, onto the servers that keep it ([where the bundle goes](docs/how-it-works.md#where-the-bundle-goes)), from
your computer; the owner's Saltix signs the version from a QR code
([Publish a page](docs/first-app.md#publish-a-page-straight-into-the-network)). Its icon follows one standard, and
`grain icon` makes one from any picture ([docs/icons.md](docs/icons.md)).

**Every app ships a Connect profile, and asks only for what it uses**: `connect.json`, the app's own words that Saltix's
Connect sheet shows before anyone signs in (Saltix 19-connect [§11](docs/protocol/connect.md#11-the-connect-profile)–[§12](docs/protocol/connect.md#12-the-connect-sheet)); `grain lint` fails without it
([docs/agents/app.md](docs/agents/app.md#the-connect-profile-connectjson)). Its `support` names who answers the app's
users: a link, an e-mail address, a username, or a Saltix address with its holder's consent; and a program can answer
them in the app's chat, handing over to a person (**[Support for your app](docs/support.md)**, `grain support`,
`examples/support-agent`). Websites and DApps sign their users in with the same standard:
**[Sign in with Saltix](docs/connect.md)** (`@saltix/connect`): into the page, for display, or into a session the
site's server holds (`@saltix/connect/server`) — never a hosted check as the only way.

**Safe by default; full screen only with viewport-fit=cover and the insets**: Saltix lays an app's page inside the safe
area, below its controls; a page that declares `viewport-fit=cover` is drawn edge to edge and pads by the variables
Saltix sets. Test at the Galaxy Z Fold's sizes in `grain dev` ([AGENTS.md](AGENTS.md),
[Designing for Saltix](docs/first-app.md#designing-for-saltix)).

| Package | What it is |
|---|---|
| [`@saltix/grain`](packages/grain) | the page's side of the bridge: typed `grain_*` methods, events, `inWallet()`, `slugLink()`, `walletLink()`, `grain.chat.open()`, `grain.layout()` (the page's safe area and the wallet's controls, as CSS variables below the wallet's own), `viewportFitCover()`, `frameFor()`, `pageColorOf()` and `frameColors()` (the frame and its colours as Saltix makes them, for tools that play the wallet), `shortAddress()` (an address as Saltix shortens it, `dsalt1qabcd…uvwxyz`), `grain.manage.open()` |
| [`@saltix/grain-server`](packages/server) | the server's side: check sign-ins, make and sign invoices, certify an invoice key, find payments on chain, sign the manifest and the Connect profile, the registry's calls, Address v1, key event logs checked offline, and the grain's chat (`ChatServer`, from a developer key alone); `@saltix/grain-server/web` is what runs in a page |
| [`@saltix/connect`](packages/connect) | "Sign in with Saltix" for websites and DApps: the page's side of Saltix Connect (`createConnect`: the session, the offer as a QR code and a link, the grant checked, the connection kept), the button standard (`signInButton`, `connect.css`), the dialog (`openConnectDialog`), a site's profile read as a wallet reads it, and the server's side for a site with a session of its own (`@saltix/connect/server`: `createServerConnect` makes the offer's keys, takes the login after every check and spends the offer once; the page is its courier, `createConnect({server})`; [`packages/connect/example`](packages/connect/example) is a whole site to copy, `npm run example:connect`) ([docs/connect.md](docs/connect.md)) |
| [`@saltix/grain-cli`](packages/cli) | the `grain` command line: `init`, `pair`, `status`, `doctor`, `dev`, `lint`, `icon`, `sign`, `bundle`, `publish`, `retire`, `show`, `profile`, `support`, `connect-profile`, `chat-spec`, `cert`, `configure`, `access`, `rate`, `bind`, `app-key`, `sponsor`, `faucet`; every command run in a project logs its steps to `.grain/log.jsonl` (codes and timings, nothing secret) |
| [`simulator/`](simulator) | the wallet's side of the bridge in a desktop browser, for development: a preview of Saltix's Connect sheet from `connect.json` before the app opens, the page framed as Saltix frames it (inside the safe area, or edge to edge with `viewport-fit=cover`) with the wallet's controls, on a phone, the Galaxy Z Fold's sizes and an iPhone-like screen, and a chat pane |
| [`examples/hello-grain`](examples/hello-grain) | a grain with its server: sign-in, storage, an invoice paid and found on chain, and a chat that runs from its paired key (`npm run example`) |
| [`examples/support-agent`](examples/support-agent) | an app's support answered by its program in the app's chat: the app's notes (`faq.json`), a language model whose key is in the environment, and a person's `@name` taking over (`createSupportAgent`, `npm run support-agent`) |
| [`docs/how-it-works.md`](docs/how-it-works.md) | read first: the pieces of a mini-app and what runs where, *Do I need a server?*, the lifecycle as one checklist (one app, one key; connect; build; the standards; the simulator; publish; run the program; updates and key rotation), publishing a page, running the program |
| [`docs/first-app.md`](docs/first-app.md) | your first app in ten minutes: Saltix's App studio, pairing the server, a command, going public, designing an app's page |
| [`AGENTS.md`](AGENTS.md) | the rules a coding agent (and a person) follows: an app's page (safe by default, full screen with `viewport-fit=cover`), what a page gets from Saltix (and that it gets no design tokens), checking first, naming apps and people, and work on this repository; `CLAUDE.md` points to it; [`docs/agents/`](docs/agents/README.md) goes on from it |
| [`docs/chats.md`](docs/chats.md) | grain chats: the spec, the server, registered and certified keys, private apps and members, the console and the team's hellos, the numbers an app reports, files, and what a wallet shows and refuses |
| [`docs/payments.md`](docs/payments.md) | payments: invoices from a registered key (a paired one: to the app's owner) or a certified key, in a chat card or from a page, finding the payment on chain, and what a wallet refuses |
| [`docs/support.md`](docs/support.md) | support for your app: the four forms of the support contact, `grain support`, a support address's consent, the support agent, what a user sees; and [what an agent with an address of its own still needs](docs/support-agent-address.md) |
| [`docs/connect.md`](docs/connect.md) | Sign in with Saltix on a website or DApp, three ways with one sheet: the site's Connect profile, the button, the QR code or the link, the Connect sheet, the grant checked and the relay path a page needs (the page's own sign-in); the server's sign-in for a site with a session (the server-held mode: the library, a worked example for a DApp's back end and one for a plain website, the test plan a site runs — the login taken once, a replay, a stale `at`, a wrong signature); never a hosted check as the only way |
| [`docs/icons.md`](docs/icons.md) | an app's icon: the standard (512 × 512, opaque, sRGB, 64 KiB, the rounded-square mask, the keyline circle), what `grain icon` makes from any picture, its checks and preview, and how it goes into the network |
| [`docs/cards.md`](docs/cards.md) | the card design standard: how every Saltix draws a card (the capsule, the action bar, emphasis, polls, states after a tap), what each block is for, do's and don'ts, and the lint |
| [`docs/protocol/`](docs/protocol/README.md) | the Saltix protocol as an app needs it, page by specification (12-grains, 22-grain-chats, 24-app-studio, 19-connect, relays, the wallet interface, the basics), each naming the protocol commit it reflects: the formats, the bridge, what wallets check and refuse |
| [`vectors/`](vectors/README.md) | the protocol's golden vectors, its own bytes copied unchanged, and what each file holds |

The packages reproduce `vectors/grains-v1.json` (manifests, chat-only ones included, logins, invoices, notifications,
the registry transactions of [12-grains](docs/protocol/grains.md) and [24-app-studio](docs/protocol/app-studio.md), deposits, developer keys made before pairing), the addresses of
`vectors/crypto-v1.json`, the relay records of `vectors/relay-v1.json`, the sponsors of `vectors/access-v1.json`, the
chats, member proofs, reported numbers, hellos and welcomes and file references of `vectors/grain-chats-v1.json`, the usernames bound to
apps of `vectors/handles-v1.json`, Saltix Connect's offers, grants and key event logs of `vectors/connect-v1.json`, the
Connect profiles, their link and `SetGrainProfile`, and support addresses with their consent (format 2), of
`vectors/connect-profiles-v1.json`, the pairing command, offers, proof and slug
verdicts of `vectors/server-pairing-v2.json` and the named blobs of `vectors/images-v1.json` (the image and bundle
checks, a bundle as `grain bundle` writes it, the server key's statement for an upload, the frames) byte for byte,
refusals included. The vectors are the protocol's golden bytes, copied unchanged ([vectors/README.md](vectors/README.md)):
`vectors/SOURCE` names the protocol commit and each file's blob id, which CI holds them to
(`node scripts/check-vectors.mjs`).

## Quick start

```sh
npm install
npm run dev            # builds, then serves the simulator and hello-grain on :8090
npx grain pair --app S --owner A --genesis G   # the command from the app's page in Saltix: a QR code; app.key once the registry names the key
npm run example        # hello-grain's chat as that app's server, from app.key (or SALTIX_APP_KEY)
SUPPORT_HUMAN=@anna npm run support-agent   # or the support agent as that app's server (docs/support.md)
SALTIX_GENESIS=<hash> npm run example:connect   # a site that signs visitors in with Saltix, the session at its server (docs/connect.md §5)
```

- **In a desktop browser:** open `http://localhost:8090/` (the simulator), press *Load a manifest*,
  then *Open*. The page is framed as Saltix frames it: edge to edge under a status bar and a navigation bar (the
  example declares `viewport-fit=cover`), with the wallet's ⋯ | ✕ in its corner; *Device* switches to a phone on its
  side, the Galaxy Z Fold's 475×751, 704×932 and 932×704, and an iPhone-like screen; *Theme* and *Language* are what
  `grain_info` says, and *Wallet* plays Saltix 0.1.53 too (sign-ins without a member proof). Before the first open it
  shows the Connect sheet from `connect.json`. Sign-in signatures are real; payments are not made. *Load the chat*
  talks to the example's chat through a development relay, as a wallet would ([docs/chats.md](docs/chats.md)).
- **In a debug Saltix in the Android emulator:** open the link the server prints,
  `salt:grain?manifest=http%3A%2F%2F10.0.2.2%3A8090%2F.well-known%2Fsaltix-grain`. Debug builds take
  developer origins (`localhost`, `127.0.0.1`, `10.0.2.2`); release builds never do.
- `NODE_RPC` (default `http://127.0.0.1:30334`, a node's own default) is a node of the wallet's network: the server
  reads its genesis for invoices and finds payments there.

### Networks: no node of your own needed

Saltix's **test network** is of the devnet kind: addresses `dsalt1…`, the pairing command's `--genesis` its genesis hash's first 8 bytes, and
`network: "devnet"` wherever the SDK asks (`testnet` is a kind no public network runs yet). It is reset now and then;
a paired key names the genesis it was made on (`app.json`), and the SDK refuses a key of a network that was reset. Since its v15
of 26 October 2026 it runs **Consensus 2**: a committee certifies every block, so a payment the node shows is final
with one confirmation; and an epoch is 1 600 certified beacon heights, which run behind the slot clock, so read when an
epoch begins from `node_status.epochs_ahead` and `pace`, never from `genesis_time + epoch · epoch_slots`
([the wallet interface](docs/protocol/wallet-interface.md#epochs-and-their-times)).

- **The chat server and every command** reach the test network through its public relays: each relay serves the
  wallet interface at `POST /rpc` on its client port (Saltix [09-relay §10.7](docs/protocol/relays.md#the-wallet-interface-at-a-relay)) behind a self-signed certificate, which
  the SDK pins by the hash its relay record publishes (`PUBLIC_RELAYS`, `publicGateways`); a call goes on to the next
  relay when one fails, and to the relays `relay_list` names when none of these can answer. `--network devnet` is the
  default; no other network has public relays yet.
- **`--relay wss://host:30335/#<sha256>`** (repeatable) names relays of your own instead, each pinned by its
  certificate's SHA-256 as its relay record names it.
- **`--node URL`** is your own node's wallet interface over plain HTTP instead: a test-network node
  (`https://download.saltix.io/node/install.sh` on Linux x86-64 or macOS, `install.ps1` on Windows; it listens on
  `http://127.0.0.1:30334`), or one reached
  through a tunnel, `ssh -N -L 30334:127.0.0.1:30334 you@your-server`.
- **Test SALT**: `grain faucet` asks the test network's faucet for owner.key's account (or `--address`), once every 5
  minutes; `--wait` until it is there. Then `grain publish --key owner.key` can pay the deposit.
- **Uploads go through the same relays**: `grain publish` puts a page's bundle and its icon into the network through
  the relay that answers (its gateway's `blob_put`), and the network carries them on to the servers that keep them
  ([where the bundle goes](docs/how-it-works.md#where-the-bundle-goes)).

## The command line

In the checkout, `npx grain …` runs it once `npm install` and `npm run build` have run. A project `grain init` makes
beside the checkout depends on the tool (and a chat's on the server SDK) by their paths there, since they are not on npm
yet: `npm install` in the project links them, and `npx grain …` there runs this tool. For a project of your own made
otherwise, install them from the checkout first (never run `npx grain` where the tool is not installed: npx would fetch
the npm registry's unrelated package of that name):

```sh
npm install --save-dev ../saltix-grains/packages/cli ../saltix-grains/packages/server
```

```sh
npx grain init ../dice --name "Dice roll"   # grain.json (sealed), connect.json, owner.key (owner-only), public/ with the bridge, AGENTS.md, package.json
npx grain init ../team-board --sign-in    # a page for some people only: its splash until its sign-in decides
cd ../dice && npm install && npx grain dev   # links the grain command; serves public/, the signed manifest and the simulator
npx grain dev --check                     # the simulator headless: every screen, both themes; .grain/check/; exit 1 on an error
npx grain dev --check --tap               # then each button tapped once: a throw or a refused request is an error
npx grain lint                            # what stops grain.json and connect.json; warns of a top bar under ⋯ | ✕; what is left
npx grain icon logo.png --out icon.png    # a 512x512 icon to the standard from any picture; grain.json names it
npx grain icon --monogram D               # or one with no picture: a letter on a colour (--background #rrggbb)
npx grain icon icon.png                   # an icon checked as wallets check it, and its hash
npx grain publish                         # public/ sealed and put into the network, the owner said, then a QR code:
                                          # the owner's Saltix signs the version (the network quotes a new slug's
                                          # deposit); with nothing changed, "nothing to publish" and nothing sent
npx grain publish --no-wait               # the same, returning once the QR code is shown; again later to finish
npx grain bundle --connect https://api.dice.example   # seal public/ yourself, and name the origins it may reach
npx grain sign                            # signed.json, for a page at your own origin (/.well-known/saltix-grain)
npx grain publish --hosted                # that page, hosted by you, instead of the network
npx grain faucet --wait                   # test SALT for owner.key's account, from the test network's faucet
npx grain publish --key owner.key        # or sign with a key file (test networks, no phone): the app owner.key's
                                          # account's and private; it waits for the chain (about 2-4 minutes, up to 6)
npx grain profile                         # the Connect profile (connect.json): a QR code for the owner's Saltix, or
                                          # signed by the key file that owns the app; --clear removes it
npx grain support @dice                   # who answers users: connect.json's support contact, checked as the network
                                          # will (a username bound to the app opens its chat); then grain profile
npx grain support dsalt1q… --consent support-consent.json   # a Saltix address (protocol version 9) and its holder's consent
SALTIX_SUPPORT_KEY=… npx grain support consent --slug dice   # the holder's side: its consent, the key from the environment
npx grain connect-profile --origin https://dex.example --name "Example DEX" --category finance --key site.key
                                          # a website's profile, for /.well-known/saltix-connect (docs/connect.md)
npx grain retire --slug dice              # close the slug for good; the deposit returns 30 days later
npx grain cert init && npx grain cert     # server.key, and cert.json: the owner key certifies it (31 days for chats)
npx grain chat-spec --cert cert.json      # chat.json → chat.signed.json, served at /.well-known/saltix-grain-chat
npx grain init ../coach --chat            # a chat-only grain: grain.json, chat.json, server.mjs (npm start), no page
npx grain status                          # is this project's server paired with its app? and what to run next
npx grain pair --app S --owner A --genesis G   # the command from the app's page in Saltix: a QR code for the owner's Saltix pairs this computer's own key
npx grain pair                            # a project paired once keeps the fields; an app the registry holds needs its slug alone (grain.json's)
npx grain pair --no-wait                  # the offer only (a coding agent shows it), then grain pair to wait
npx grain pair --new                      # a new key for the same app (rotation, or one that stopped working), or for another app
npx grain doctor                          # the project's state and the exact next step; exit 0, 1 or 75 (below)
npx grain configure --slug dice --server server.key --category games   # the registry names the server key
npx grain app-key make --slug dice        # app.key for server.key, owner-only, never printed (test networks without a phone)
npx grain app-key --file app.key          # app.key's public parts, and whether the registry names it
npx grain access --slug dice --private --member dsalt1q…:user+developer   # its owner and members only
npx grain access --slug dice --public     # anyone
npx grain bind --handle @dice --slug dice # a username you hold opens the app's chat
npx grain rate --slug chess --score 5 --review "Good" --key rater.key   # rate someone else's app
npx grain show --slug dice               # what the registry holds, in words (--json: the whole record)
npx grain show --slug dice --node http://127.0.0.1:30334   # any command, through your own node instead
```

- `grain help <command>` (or `grain <command> --help`, `-h`) prints that command's part of the help and runs nothing;
  `grain --version` names the tool's version. A flag's value is the next word or comes after `=` (`--node=URL`); a
  switch (`--chat`, `--wallet`, `--wait`, `--no-wait`, `--public`, `--private`, `--clear`, `--offline`, `--revoke-all`, `--new`,
  `--json`, `--hosted`, `--fix`, `--check`, `--tap`)
  takes none, so `grain init --chat coach` makes `coach`. A flag a command does not take is refused (exit 2), never
  ignored.
- A registry call signed with a key file (`publish`, `retire`, `configure`, `access`, `rate`, `bind`, `profile`)
  returns once its transaction landed and the registry holds what it makes: **about 1.5 to 2.5 minutes on the test
  network** (a shard block, then the beacon chain's registry), a first `grain publish --key` about 2 to 4, up to about
  6 (it gives up after 6 minutes a transaction, and the next run goes on). Meanwhile it says what it waits for, for how
  long and for how long at most (`in the pool, waiting for a shard block (1:39 of up to 6:00)`): one line rewritten on a
  terminal, a line every 15 seconds elsewhere. **A coding agent runs these commands in
  the background or with a timeout of 10 minutes or more**, or passes `--no-wait`, which returns once the pool took the
  transaction, then asks `grain doctor` until it says it landed: what `publish`, `access` and `profile` sent for the
  project's app is kept in `.grain/publish.json`, and `grain doctor` says where each stands until it landed (`grain show`
  for any other call). An owner's call that would change nothing the registry holds (`access`, `profile`, `configure`,
  `bind`: the same access, words, keys or app) says "nothing to change", signs and sends nothing, and exits 0, as
  `grain publish` does with nothing changed. Each call carries the account's nonce, and a
  profile its revision, as the node holds them, so the next call is built above it; a call the pool refuses because the
  account's earlier one is still pending (another command at the same time) is built again once that landed.
- `grain dev --check` drives that simulator in a headless Chrome, Chromium, Edge or Brave of this computer
  (`CHROME_PATH` names another), over a pipe, with a profile it removes after: the Connect sheet (a profile a wallet
  would refuse is an error), the page's load (an exception or a missing page is an error), then every screen in both
  themes (anything tappable under the wallet's controls is an error; a sideways scroll, something tappable that stays
  under a system bar, a request the wallet refused, one look for both themes are warnings), with a screenshot of each
  and `report.json` in `.grain/check/`; exit 1 on an error. What stays under the navigation bar: an element fixed, or
  sticky to the bottom, there as the page opens; or one that scrolls with the page still there with it scrolled to its
  end (a page with no room below its last button); a button at a long page's fold, which the page scrolls clear, is
  not. No browser is downloaded; with none, it says so. `--check --tap` then taps each of the page's buttons once, as a
  person would, at the phone's size in the dark theme (buttons only, never a link), and after each tap the buttons it
  brought up ("Clear history" once there is a history: shown now, never seen before by element or by name) in their
  turn; at most 30 in all, in 40 s, and buttons brought up past that are a warning (`N buttons appeared later and were
  not tapped`). A tap after which the page throws, or asks Saltix for something it refuses (a permission the manifest
  lacks, a call without a tap's right), is an error, and then no line says the taps went well; one that changes nothing
  on the page and asks Saltix for nothing, a button something else covers, and a page that would leave for another
  origin are warnings. `next:` names the command that found it (`grain dev --check --tap` again). It stays on this computer: the page is never navigated away
  (the check stops such a document before it loads), no window opens, and a payment is declined (4001, as a user may
  decline one); a user's own "no" is never an error. A screenshot of the page after each tap goes to `.grain/check/`.
- `grain dev` is a server: it runs until Ctrl-C (or SIGTERM, or its terminal closing), and its log's last line says it
  stopped, however it was launched (`npx grain dev`, `npm run dev`, the command itself). A coding agent runs it in the
  background, or not at all, and checks the page with `--check`, which exits. It listens on this computer alone
  (`127.0.0.1`; the emulator reaches it at `10.0.2.2`, the host's loopback; `--host 0.0.0.0` for a phone on the same
  network), signs the manifest for the origin each request came to (`localhost`, `127.0.0.1`, or
  the emulator's `10.0.2.2`) and prints the `salt:grain?manifest=…` link to open in a debug Saltix, and the simulator's
  address (`/_simulator/`): the page framed as Saltix frames it, with the wallet's controls, the band and the margins in
  the page's colours as Saltix takes them, and Saltix's splash while the page loads, on a phone, the Galaxy Z Fold's
  sizes and an iPhone-like screen. The simulator holds every request to Saltix's rules (`@saltix/grain/rules`, from
  the wallet's own): a tap of the user (within 5 seconds) before a payment, the app's chat, its page in the wallet
  (for its team only) and asking again for the address or notifications; the manifest's permissions; rate limits per
  method; storage's bounds (keys of 1 to 128 bytes, values of 60 KiB, 1 MiB an app); and 64 KiB an answer or an event
  (a relay frame over about 32 KB never reaches a page). A sealed grain signs in under its virtual origin
  (`https://<slug>.grain.invalid`) and its pages carry Saltix's Content-Security-Policy. `grain dev` keeps a
  development registry: the simulator's account joins the team or a private app (so its sign-ins carry member
  proofs), and your server reads it at `/api/dev/rpc` (`node`), of a developer key's network and naming its key with
  `--app-key`; invoices of that key pay the owner there as in Saltix.
- `grain init`'s page declares `viewport-fit=cover` and lays itself out edge to edge by the variables Saltix (and
  `grain.layout()`) sets, and `grain init` writes `AGENTS.md` (the rules a coding agent follows) and `CLAUDE.md` (which
  points to it). `grain lint` warns when a page in `public/` declares `viewport-fit=cover` and nothing reads the safe
  area (`cover-without-insets`), or such an app pins a fixed or sticky bar to the top whose rule uses none of
  `--saltix-safe-top`, `--saltix-controls-*` or `env(safe-area-inset-top)` (`full-screen-top-bar`): heuristics, never
  errors. A page without `viewport-fit=cover` needs neither: Saltix keeps it inside the safe area.
- `grain init`'s `grain.json` names its page sealed from the start, as `grain publish` will put it into the network
  (`grain dev` and `grain publish` seal `public/` again as it changes), so neither `grain lint` nor the simulator's
  Connect sheet has a placeholder host to speak of. Its `permissions` is the sum of what the app asks Saltix for: 1
  storage (`grain.storage`), 2 relay (`grain.relay`), 4 notifications, 8 camera, 16 microphone, 32 location, 64 address
  (`grain.requestAddress`); each is a row on the Connect sheet, and `grain lint` warns about one nothing uses.
- `grain publish` puts an app's page straight into the network (Saltix [12-grains §10](docs/protocol/grains.md#10-for-developers),
  [32-images §7](docs/protocol/images.md#7-uploading)): it seals `public/` (the bundle check every node runs, run here
  first), names the bundle's sources by the network's protocol (none from version 2; before it, the network's own copies
  at up to 3 relays of its relay list: [where the bundle goes](docs/how-it-works.md#where-the-bundle-goes)), and with a server key the registry names for the app (`grain pair`'s `app.key`,
  `--app-key`, or `SALTIX_APP_KEY`) uploads the bundle at once on that key's statement, in pieces, resuming where the
  node stands after a break and waiting out a busy one: the network holds it pending for a day, so the owner signs
  whenever they like and your computer need not stay on. Without one (a first version), it uploads the bundle once the
  registry names it. Then the icon. Run again, it goes on from where it stopped; a version not above the registry's is
  raised to the next only when the content changed: what the registry holds already (the same manifest but for its
  owner, its version and the relays' copies, compared in its canonical form) is never signed again, and with nothing
  left to upload the command says "nothing to publish" and exits 0. A refusal is said in words with what to do, and
  logged by its reason. `--hosted` publishes a page at your own https origin instead; a chat-only app is published as it
  is. A new page project starts sealed (`grain init` seals `public/` as it makes it); an older one's placeholder origin
  (`*.example`) is sealed too, and `grain lint` says `grain bundle` seals it now.
- Who signs is said before anything is signed (`owner: …`): the owner's Saltix by default, from
  `salt:grain-publish?m=…` as a QR code (and `.grain/publish.html`): scan it with the owner's Saltix, which fills in its
  account's key, checks the manifest and the registry, shows the grain and the deposit and, after the PIN, signs and
  registers it (or records a newer version). The tool waits for the registry and writes `signed.json`. The owner's key
  never leaves the phone. A first version a publishing link registers is private unless the owner switches on **Public
  in the Marketplace** on Saltix's sheet (Saltix 0.1.61 and later, which sends that call itself once the registration
  landed); an older Saltix registers it public: then `grain access --slug <slug> --private` (or My apps → the app →
  Access). `grain publish` says so, and `grain doctor` says which it became.
- **A key file signs an owner's call by itself when its account owns the app** (one it registered); `--key` names one
  explicitly, which a registration needs (`grain init`'s `owner.key` never registers an app by itself), and `--wallet`
  always asks Saltix. For devnets and the test network ([No phone, test network](docs/how-it-works.md#no-phone-test-network)):
  it asks the registry for the slug — unregistered → `RegisterGrain` with the deposit and, right behind it with the next
  nonce, `SetGrainAccess` private (a new app starts private, as one made in Saltix does, and is never public in between);
  the owner's with a lower version → `UpdateGrain`; another account's → refused (an app made in Saltix is its owner's
  phone's) — checks the balance, signs and submits through the network's wallet interface (its public relays, `--relay`
  or `--node`). What it sent goes to `.grain/publish.json`, so a run cut short (or `--no-wait`) is finished by the next,
  which waits for it rather than sending it again. Once published it says who can open the app: anyone; its owner and
  members in Saltix; or, for a private app `owner.key` owns, nobody until a member is named, and how to name one.
- `grain init` writes `connect.json`, the app's Connect profile (Saltix [19-connect §11](docs/protocol/connect.md#11-the-connect-profile)):
  the JSON form's `profile` object without `owner` and `revision`, an example in English and Russian that describes the
  counter it makes, to rewrite for your app: `grain lint` warns while any language still says the template's words
  (`connect-template`), and `grain profile` refuses them. `grain lint`'s last line says where the last `grain publish`
  left the project (not published yet; published as it is here; the version the registry took) and what is left, in
  `grain doctor`'s words: `left: public/ changed since v1: grain publish seals v2`, `rewrite connect.json for this app`;
  never "ready" while something is.
  `grain lint` fails without it, and checks every rule of the format with the field and its limit (a tagline of 1–80
  characters in one line, about up to 600, up to 4 highlights of 60, a privacy summary of up to 300, required when the
  manifest asks for `address` or `storage`; `https://` links, never to a host reserved for examples (`.example`,
  `example.com`, `.test`), which leads nowhere; support an `https://` link, a `mailto:` address, `@name` or (version 2)
  a Saltix address in its canonical form with its holder's consent, unless it is the owner's own; at most
  8 192 bytes in Borsh), the icon file (`icon.png` or `public/icon.png`: one every wallet takes, whose hash `grain.json`
  names, with the standard's warnings: [docs/icons.md](docs/icons.md)), and warns about an empty about, English alone, a
  link too long for a QR code (2 048 characters: set it in the app studio, or with a key file) and each permission
  nothing in the app's sources uses (`address` without `requestAddress`, `storage` without `grain.storage`…).
- `grain profile` shows `salt:grain-profile?p=…` as a QR code ([12-grains §10](docs/protocol/grains.md#10-for-developers)): the owner's Saltix
  fills in its account and the registry's revision and one, shows the profile as its Connect sheet will, and sets it
  (`SetGrainProfile`) after the PIN; the tool waits for the registry. A key file that owns the app (test networks) signs
  the profile itself, with or without `--key`, at the registry's revision and one, and sends the call; `--clear` removes
  the profile. A link to a host reserved for examples, and `grain init`'s own words, are refused first. `grain show`
  prints the registry's profile, whether a wallet takes it, and its support contact. A profile that names a support
  address (format 2) is checked as the network reads it now, and refused before it runs protocol version 9.
- `grain support <contact>` writes `connect.json`'s support contact (Saltix 19-connect
  [§11.1](docs/protocol/connect.md#111-the-format), [docs/support.md](docs/support.md)) in its canonical form: an
  `https://` link, a `mailto:` address (`help@dice.app` reads as one), a username (refused when nobody holds it: whoever
  minted it would get the app's users' questions; one bound to the app opens its chat), or a Saltix address, which takes
  format 2 (`"version": 2`, from protocol version 9) and, unless it is the owner's own, its holder's consent:
  `--consent F` (the file `grain support consent` wrote), or signed here with the holder's key in
  `SALTIX_SUPPORT_KEY`. It checks the address against the network (its version, its prefix, the app's registered owner,
  the consent's key, app, owner and signature) before it writes anything; `grain profile` then sets the profile.
  `grain support` alone says which contact `connect.json` names, `--clear` removes it. `grain support consent --slug S
  [--owner A]` is the holder's side: the consent of the address whose key is in `SALTIX_SUPPORT_KEY` (never a file) to
  answer for the app S of its owner (the registry's, or A) on this network, written to `support-consent.json` (public).
- **Donations** (Saltix 24-app-studio §2b, protocol version 9) are the owner's switch in Saltix, on the app's page:
  no command sends `SetGrainDonations` (tag 76). `grainGet(…).donations` says whether they are open; wallets then offer
  *Support the developer*, a transfer to the registry's owner ([AGENTS.md](AGENTS.md#donations-to-your-app)).
- `grain connect-profile` signs a website's profile (subject `site`: `--origin`, `--name`, `--category`) with the
  operator's key file, from the texts and links of `--profile` (`connect.json`), at a revision above the one the site
  serves now and the file it writes (`--out`, `.well-known/saltix-connect`), or `--revision N`; when neither can be
  told it asks for `--revision` (`--offline`: the file only): serve it at `/.well-known/saltix-connect` as
  `application/json`, with no redirect ([docs/connect.md](docs/connect.md)).
- `grain faucet` (test networks): a node's faucet signs a grant of test SALT, and WORK while its purse holds some, to
  owner.key's account or `--address` (`faucet_request`): one every 5 minutes an address; a refusal says when to come
  back. A relay whose node runs no faucet passes the request to the next.
- `grain show --slug S` says what the registry holds in a few lines (the network, the version, public or private, the
  owner, the form, the server keys, the Connect profile and whether a wallet takes it); `--json` prints the record
  itself and nothing else, `--out signed.json` writes the signed manifest. For a free slug it says the deposit
  registering it keeps, and exits 0: 100 SALT for 3–5 characters, 30 for 6–7, 10 for 8 or more
  ([24-app-studio §5](docs/protocol/app-studio.md#5-the-deposit)).
- `configure`, `access` and `bind` are the owner's (the handle's holder's) calls: the account is said first; signed with
  a key file when `--key` names it or it is the owner's (test networks), refused before a node would refuse them;
  otherwise the tool says what to do in the owner's Saltix (My apps) and waits for the registry (`--timeout`). `configure` replaces the server keys and the category
  (`--revoke-all` names no key, which stops every server key at once); `access` replaces public or private and the
  members. A rating names its account and is signed by the rater's key (`--key`), or given in Saltix.
- `configure` sends the form of the network's protocol version (`node_status.protocol`; [24-app-studio
  §2](docs/protocol/app-studio.md#2-the-registry)): bare keys (tag 34) while it runs version 1, valid at most until the
  slot before a scheduled switch to version 2 and not sent in the last 30 slots before it; from version 2 each key with
  its proof (tag 39), which `--server server.key` signs here for the app and its owner. A key given as bare hex cannot be
  proven, so from version 2 it is refused, and the owner's Saltix names a computer's key only by pairing it (`grain
  pair`), whose offer carries the proof.
- `grain pair` (Saltix [24-app-studio §3a](docs/protocol/app-studio.md#3a-pairing-a-server-by-qr-code)) takes the three
  public fields of the command the app's page in Saltix shows (`--app <slug> --owner <address> --genesis <16 hex>`; a
  project paired once keeps them in `app.json` and `.grain/pair.json`, and for an app the registry holds `grain pair`
  alone reads the owner from its record; a new app needs `--app` and `--owner`), reads the registry's record of the slug
  first (another account's, or retired: refused before anything is shown), makes the server's Ed25519 key on this
  computer, in `.grain/pair.key` (owner-only, never printed), signs its proof for the app and the owner — the very proof
  a `ConfigureGrain` of tag 39 carries — and shows its offer: a QR code (with colours on a terminal; plain half blocks
  elsewhere, drawn for a dark background), `.grain/pair.html`, the link `salt:grain-pair?o=…` and a 6-digit code that
  Saltix shows too. Nothing in the offer is secret, and nothing is signed but the proof. The owner's Saltix scans it,
  checks it by itself (its network, the clock, the owner is this account, the proof, the slug its own or free) and
  names the key; this computer watches the registry (`grain_get` through the public relays, polled with a short backoff:
  no relay session, no mailbox) until the record names its key, renewing the offer when it expires with nobody having
  scanned it, then writes `app.key` (owner-only) and `app.json` (the app, its owner, the network, the key's public
  half), and keeps `app.key`, `*.key` and `.grain/` out of git. It waits until then (`--timeout S` stops it after S
  seconds; `--no-wait` shows the offer and returns); run again, it shows the same offer while it lives (30 minutes) and
  finishes once Saltix's transaction landed (a managed account's may wait its delay). `--name` names this server on the
  owner's screen (the host name unless told). `--new` pairs a new key — to rotate it, or for another app, since the
  registry names a key for one live app only — and keeps the old `app.key` in `.grain/`. No key, token or address is
  ever pasted: the owner scans, compares the code and confirms with the PIN.
- `grain status` prints `paired`, `not_needed` (a page alone: nothing to pair), `waiting` (an offer shown, the registry
  not naming the key yet), `unpaired`, `revoked`,
  `replaced`, `retired`, `unregistered`, `other_network`, `invalid` or `unknown`, one line on why (and a warning when
  `app.key` holds a developer key made in Saltix: pair a server in its place), and the command to
  run next (`--json` for a program, `next` in the same words, `nothing: …` once paired, never null; exit 0 when paired
  or not needed). `grain doctor` checks the rest of the way to an app that runs (`.gitignore`, the key file's mode,
  `chat.json`'s version, `npm install`, a page's bundle and where its publish stands, `not_uploaded`, `pending`,
  `waiting_for_owner`, `pending_expired` or `published`, what the registry holds, each transaction a key file here sent
  until it landed, who opens the app (and **public, but should be private** while a key file's registration is still to
  be made private), the icon, the Connect profile: `connect.json` as `grain lint` checks it before the app is
  registered, the registry's after) and ends with the exact next step; a page alone needs no paired key, and before its
  first publish it says what registering the slug takes (the deposit and the fees of the manifest as `grain publish`
  will send it, its sources included; on the test network without a phone, `grain faucet --wait` and `grain publish
  --key owner.key`). Both only read; what `grain doctor` says, and its exit status, [below](#grain-doctor-where-a-project-stands-and-its-exit-status).
- Every command run in an app's project appends its steps to `.grain/log.jsonl` ([docs/devex.md](docs/devex.md#the-steps-log)):
  the command, the step, its outcome, a reason code, the milliseconds, the network's kind; never a key, an address, a
  slug, a path or anything typed; its last line the exit, a stop by Ctrl-C, SIGTERM or a closed terminal included,
  however the command was launched (`npx grain …` too: npm passes on the Ctrl-C the command gets from the terminal as
  well, and the second signal is ignored while the line is written). Only `kill -9` leaves a run with no last line.
  `SALTIX_GRAIN_LOG=off` turns it off.
- `grain app-key` reads a developer key from `SALTIX_APP_KEY`, `--file` or stdin, never from the command line (shells
  keep their history), and prints its network, genesis, slug, public key and address, and whether the registry names it
  (through the network's public relays, or `--node`).
- `grain bundle` seals `public/` (Saltix [12-grains §8](docs/protocol/grains.md#8-sealed-bundles)): one ZIP of its files — sorted, no times, every file stored as
  it is (never deflated), so the same files make the same bytes on any computer and any Node — in the form the network
  keeps (the bundle check), and `grain.json` names its hash, size, `start` and the `connect` origins the grain may
  reach; `--sources` only for hosts of your own (a bundle over 16 MiB, which the network does not keep). `grain publish`
  bundles too. Wallets fetch it from their own relay, check it and serve it from the phone at
  `https://<slug>.grain.invalid`, with the network limited to `connect`. A sealed grain's `grain dev` makes the bundle
  for every manifest it serves and serves it at `/_bundle.zip`, so a debug Saltix runs it as it will run.
- `grain icon <picture> --out icon.png` makes a 512 × 512 icon to Saltix's standard from any PNG or JPEG (fitted by
  `--fit crop|contain|mark`, flattened onto `--background` or the picture's own ground, converted to sRGB, stripped of
  metadata, a palette when that is what fits 64 KiB), prints its hash first, checks it, writes a preview of it in the
  mask at 24, 40, 56 and 96 dp on dark and light, and names it in `grain.json`; `grain icon icon.png` checks one
  ([docs/icons.md](docs/icons.md)). A mark on transparency goes on a light or a dark ground, whichever leaves less of
  it faint, both apart from the two themes' own so the rounded square shows on either. `grain icon --monogram L` makes
  one with no picture: one or two letters or digits drawn bold (a stroke near a quarter of their height) inside the
  keyline circle on `--background` (else a colour the slug picks), from a stroke font of its own, the same bytes on any
  computer.

### `grain doctor`: where a project stands, and its exit status

Each line is a finding: `ok` (in order), `fix` (something to do: the arrow says what), or `wait` (nothing to do but wait
for the network: a transaction on its way). The last line, `next:`, is the first thing to do, else what to wait for,
else `nothing: …`. `--json` gives the same as `{status, publish, outcome, exit, findings, next}`, each finding
`{ok, what, detail, next?, waiting?}`; `next` is the `next:` line's words, `nothing: …` included (never null: an older
tool gave `null` when nothing was left; read `outcome` or `exit` to tell).

| Exit | `outcome` | Means |
|---|---|---|
| 0 | `done` | nothing left to do |
| 1 | `fix` | something to do or fix: `next` says what (it comes first even while a transaction is on its way, since it can be done meanwhile) |
| 75 | `waiting` | nothing to do but wait for the network: a registration, an update, an access or a profile call on its way to the registry. Ask again in a minute; a line says when it landed (`ok registry … (the transaction sent at … landed)`) |

- **What is waited for**: what `grain publish`, `grain access` and `grain profile` sent with a key file for the
  project's app, kept in `.grain/publish.json` until a command sees it land: in the pool, in a shard block on its way to
  the registry, or not seen yet by the relay asked. One that can land no more (its last slot passed unknown to the
  network, or the registry refused it) is something to do: the command that sends it again.
- **`published`** means the registry names the version and the network holds its bundle: a relay that answers
  `blob_get` with `fetching` knows the hash from the manifest and looks for the bytes, which says nothing of whether
  anyone has them, so it counts only when this computer saw a node take them (`uploaded_at`); otherwise `grain publish`
  is the next step. A change to `public/` or `grain.json` not published yet is something to do too (`grain publish`).
- **Compatibility, for an agent or a script**: exit 1 used to cover waiting too, and the log's `doctor` step said
  `refused`. Treat any status but 0 as "not done"; 75 means run `grain doctor` again later, never fix something. 75 is
  sysexits' EX_TEMPFAIL ("try again later"), as a server that cannot work exits with 78; 2 stays the command line's
  exit for a misuse (`grain doctor --typo`). The log says `waiting` (`doctor`) and `end` `waiting` with `exit_75`.

## The page

```ts
import { TEAM, gateOf, grain, inWallet, slugLink } from "@saltix/grain";

if (!inWallet()) showLink(slugLink("chess"));     // salt:grain/chess, for a sealed page and a hosted one alike

const info = await grain.info();               // slug, version, form, listing, host, bridge, language, theme, safe_area…
const layout = await grain.layout();           // the frame: { safeArea, controls }, kept current, and CSS variables
await grain.ready();                           // says the first screen is drawn; Saltix ignores it today
const answer = await grain.login(challenge);   // { key, signature, at, origin, member }: check it on your server
const gate = gateOf(await grain.signIn({ url: "https://api.chess.example/" }), TEAM); // "open", "refused", "update"…
await grain.storage.set("rating", "1640");     // synced across the user's devices, 1 MiB per grain
const { id } = await grain.pay({ invoice });   // from a tap; the wallet's own sheet and PIN
grain.on("theme", ({ theme }) => repaint(theme));

const me = await grain.relay.open({ grant });  // the user's address in this grain; grant: your sponsor pays relays
await grain.relay.send(peer, bytes, { keep: true });   // sealed to peer's key; at most 48 000 bytes
const stop = grain.relay.onFrame((from, payload) => apply(from, payload));
await grain.notifications.allow();             // asked once: your server may notify with the grain closed
await grain.manage.open({ section: "members" }); // from a tap: the app's own manage page, for its team (bridge 3)
```

Frames without a sponsor use the relay's free share, never the user's own channel.

**Check first, render after** (Saltix [12-grains §5.1a](docs/protocol/grains.md#51a-the-teams-sign-in-check-first-render-after)): a page for some people only (its team, a private circle)
shows a splash (its icon and name, marked `data-grain-splash`) until `grain.signIn({ url })` resolves, then the app or a
refusal page with none of its UI, as `gateOf(signIn, TEAM)` says. Saltix's login carries the account's member proof
for the app's team and a private app's members (`member`, `null` for anyone else, absent from Saltix 0.1.53 and older,
which `gateOf` answers with `update`). The server checks it with `SignIns`. `grain lint` warns about a page that shows
anything else first ([docs/agents/app.md](docs/agents/app.md#a-page-for-some-people-only-check-first-then-render)).

**The page's frame** (bridge version 3, Saltix [12-grains §5](docs/protocol/grains.md#5-the-bridge), §7): Saltix opens every app as a full app, with its
controls `⋯ | ✕` floating in the top right corner, and lays the page out inside the safe area, below the band that holds
them, unless the page declares `viewport-fit=cover` (`viewportFitCover` reads it as Saltix does); then edge to edge.
Saltix sets `--saltix-safe-top`, `--saltix-safe-bottom`, `--saltix-safe-left`, `--saltix-safe-right`,
`--saltix-controls-top`, `--saltix-controls-right`, `--saltix-controls-width` and `--saltix-controls-height` on `:root`
itself (0 inside the safe area). `grain.layout(onChange?)` reads `safe_area {top, bottom, left, right}` and `controls
{top, right, width, height}` (null inside the safe area) from `grain_info`, follows the `insets` event, window resizes
and theme changes, and sets the same variables where Saltix does not: in a stylesheet below Saltix's own (`layoutSheet`),
never `:root`'s inline style, so Saltix's values and their later changes always win, and `stop()` takes away what it set
and nothing else. Never write them into `:root`'s inline style yourself. An older Saltix (bridge 1–2, and 0.1.53) gives
0 and no controls; a plain browser its own `env(safe-area-inset-*)` and no controls (`layoutOf` decides it, in one place).
`frameFor` is the frame itself, and `pageColorOf` and `frameColors` its colours, for tools that play the wallet.
Saltix's splash shows while the page loads and goes once it has loaded: `grain.ready()` neither holds nor hides it.
Keep text inside the safe area and every tappable
element out of the controls' box; no close button of your own (✕ and Back close the app).
[Designing for Saltix](docs/first-app.md#designing-for-saltix).

**What a page gets, and what it does not** ([AGENTS.md](AGENTS.md#building-an-app-what-a-page-gets-from-saltix-and-what-it-does-not)):
`grain_info` (with `theme`, `dark` or `light`, and `language`), the events `theme`, `visibility`, `insets` and
`relay`, and the eight variables above. Saltix gives a page no design tokens (no palette, fonts or spacing): a page
brings its own, light and dark, switches by `theme`, and Saltix takes its own band and bars' colours from the page
(`grain.setHeader` until the next call, else the first `theme-color` whose `media` matches and which is opaque, else
the background), read again when the head changes, once the page has loaded and when the theme changes; the simulator
draws them in the same order. Nor does it give anyone's name: a user is a grain key, a
pseudonym of this app alone.

Every method rejects with a `GrainError` whose `code` is `4001` (the user refused), `4100` (not permitted: the
manifest does not ask for it, no consent, no tap before a payment or before leaving the grain, or not on the app's
team), `4200` (unsupported), `4290` (rate limited), `-32602` (invalid parameters), `5000` (the wallet failed) or `4900`
(not in a wallet).

## The server

```ts
import { AppKey, SignIns, newChallenge, signInAnswer, verifyLogin, signInvoice, issueInvoiceKeyCert, findPayment, RelayClient, signNotification, grantFor } from "@saltix/grain-server";

// Sign-in: give the page a challenge, check what grain.login returned.
const ok = verifyLogin(answer, { slug: "chess", origin: "https://chess.example", challenge });
// Or the whole of it, for grain.signIn's two routes: the login and the team's member proof, checked against the
// registry through the chat server, with the rights it gives (owner, developer, viewer, user, none).
const signIns = SignIns.of(chat, { origin: "https://chess.example" });
//   POST challenge → { challenge: signIns.challenge() }
//   POST session   → const r = await signIns.check(body); signInAnswer(r.signedIn, admitted, { token })

// Invoices from a developer key (a registered server key): to the grain's owner only (docs/payments.md).
const invoice = signInvoice({ slug: "chess", to: grain.owner, asset: "SALT", amount: 2_500_000_000n, memo: "Premium",
  reference, expires_at: Date.now() + 600_000 }, AppKey.parse(developerKey), genesisHash);
// Or certify a server key once with the owner's key (offline) and sign with it, to any payee.
const cert = issueInvoiceKeyCert(ownerSecret, "chess", serverKeyHex, Date.now() + 90 * 86_400_000);
const certified = signInvoice({ slug: "chess", to, asset: "SALT", amount: 2_500_000_000n, memo: "Premium",
  reference, expires_at: Date.now() + 600_000 }, serverSecret, genesisHash, cert);

// The payment, by the reference its public memo carries.
const payment = await findPayment(nodeUrl, myAddress, reference);

// Users through the relays, under the server key: frames both ways and notifications.
const relay = await RelayClient.connect({ node: nodeUrl, secret: serverSecret, network: "devnet" });   // the test network's kind
await relay.notify(userGrainAddress, signNotification(
  { slug: "chess", title: "Your move", body: "Bob played e4", start: "game-7", at: Date.now() }, serverSecret, genesisHash, cert));
await relay.send(userGrainAddress, bytes);                       // live; { keep: true } for the mailbox
relay.on("frame", ({ from, payload, kept }) => handle(from, payload));
```

**A chat** (Saltix [22-grain-chats](docs/protocol/grain-chats.md), [24-app-studio](docs/protocol/app-studio.md), [docs/chats.md](docs/chats.md)): users send typed actions your chat
spec declares, your server answers with cards it signs with the server key. The developer key Saltix gives for the app
is the server's whole configuration: it finds the network's public relays, checks that the registry names the key, signs
the spec, and stops once the owner replaces or revokes the key. Requests are checked and answered once; a private app
takes its owner's and members' only (member proofs, checked against the registry and the accounts' keys); files go next
to the relay; unasked messages are at most 10 a day per user; the numbers it reports are signed hourly. Each request
names the user's language (`ask.lang`: `en`, `ru`, …, or `""` when the app does not say): answer in it when you can,
else in English. The team's chat with its own app is the app's **console** ([24-app-studio §4](docs/protocol/app-studio.md#4-in-saltix-my-apps)): `chat.team()` reads who
is on the team, `chat.notifyTeam(card)` writes to it (100 a day each), and `chat.report(error)` sends an error as a card
made for an AI agent, scrubbed of secrets and folded within an hour; handlers' errors are reported on their own. The
team's wallets say **hello** to their own app by themselves ([22-grain-chats §3a](docs/protocol/grain-chats.md#3a-the-hello-the-team-introduces-itself)): the server checks the member proof
against the registry, keeps where the member's console is and welcomes the wallet (once an hour per key, nothing at all
to anyone off the team, at most 30 checks a minute against the node), so the console reaches the team before anyone
writes. In Saltix, long-press the report → Copy for an AI agent → paste it into Claude Code.

```ts
const chat = await ChatServer.start({ appKey: process.env.SALTIX_APP_KEY!, spec, store: fileChatStore("chat.store.json") });
// or under the owner key's certificate: { slug: "chess", spec, secret: serverSecret, cert, chain, node }
chat.command("rating", (ask) => card().status("done").fields({ Rating: rating(ask.key) }).open("Play", "lobby"));
chat.command("report", async (ask) => {
  await ask.working();                                            // replaced in place by the answer
  const file = await chat.upload(csv, { name: "games.csv", mime: "text/csv" });
  return card().text("Your games this week.").file(file, { format: "csv" });
});
await chat.notifyTeam(card().text("A player reported a bug in game 7"));   // the owner and developers, in the console
await chat.report(error, { context: { command: "/rating" } });              // a card for an AI agent to read
```

**Tests** run the chat end to end with `testChat` (`@saltix/grain-server/testing`, [docs/chats.md](docs/chats.md#testing-a-chat)):
a development relay and registry (`@saltix/grain-server/dev`) and a development key, wallets that ask as Saltix does
(strangers, the owner, members with proofs) and check every card as Saltix does. `grain init --chat` writes one.

```ts
const t = await testChat({ spec: new URL("../chat.json", import.meta.url), setup: handlers });
assert.equal((await t.ask("rating", {}, { lang: "ru" })).status?.state, "done");
await t.close();
```

A **sponsor** pays the relays for your users' grain frames when the free share is busy (Saltix [11-access](docs/protocol/relays.md#paying-for-relays-lanes-and-sponsors), [12-grains §5.4](docs/protocol/grains.md#54-relays-real-time-between-users)):

```sh
grain sponsor init                                   # sponsor.key; put its account in grain.json "sponsor"
grain sponsor                                        # its account, WORK, channels, the exchanges to open one with
grain sponsor open --exchange <pool> --amount 10
```

```ts
// At login: a grant for the user's grain key (what grain.login returned), for the page's grain.relay.open({ grant }).
// A node's URL, or the network's relays: publicGateways("devnet").
const grant = await grantFor(publicGateways("devnet"), sponsorSecret, answer.key, { perDay: 500_000n, days: 7 });
```

The wallet checks the grant against the manifest's sponsor and network; the exchange holds each user to `perDay` µWORK.

`RelayClient` (Saltix [09-relay §3](docs/protocol/relays.md#the-connection), [12-grains §5.4](docs/protocol/grains.md#54-relays-real-time-between-users)–5.5) registers under the server key with a record it signs
itself, its messaging key derived from that key (`serverMessagingSecret`); it trusts a relay's self-signed
certificate only by the hash in the relay's record, takes users' messaging keys only from records it checked,
acknowledges kept frames with a signed proof, and reconnects on its own, to another relay when one fails. Its
frames use the free share for now. `notificationProblem` checks a notification as a wallet does: signed by the owner key,
a certified key, or a key the registry names (`servers`).

The manifest your site serves at `/.well-known/saltix-grain` is `signManifest(manifest,
ownerSecret)`'s output (`grain sign`); keep the owner's key off servers. A manifest names its `owner`
account and an `owner_key` that speaks for it (Saltix [12-grains §2](docs/protocol/grains.md#2-manifest)): a key file's own account and
key (`{ "ed25519": "<hex>" }`), or — published from Saltix by a managed account — its phone's P-256 key
(`{ "p256": "<hex>" }`). `invoiceProblem` and `notificationProblem` take that `owner_key`;
`verifyByDeviceKey` checks either kind. `signGrainTx` makes a plain account's registry transactions as the `grain`
command line does: `RegisterGrain` (with the deposit `grainDeposit(slug)` or a node's quote, `grainQuote`),
`UpdateGrain`, `RetireGrain`, `ConfigureGrain`, `SetGrainAccess`, `RateGrain` and `BindHandle` (`parseHandle`,
`displayHandle`), each refused first as the shard would refuse it (`grainCallProblem`).

## Checks

```sh
npm test               # builds, then runs every package's tests (node --test)
```

MIT licensed.
