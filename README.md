# saltix-grains

SDKs and tools for **grains**, apps that open inside Saltix wallets (in the Saltix app: Apps). The rules are in the
protocol's [12-grains](https://github.com/corvise/saltix/blob/main/specs/12-grains.md),
[22-grain-chats](https://github.com/corvise/saltix/blob/main/specs/22-grain-chats.md) and
[24-app-studio](https://github.com/corvise/saltix/blob/main/specs/24-app-studio.md). A grain uses the wallet's identity,
payments, storage and relays, and never holds the wallet's keys. It may be a page, or a chat and nothing else.

**[Your first app in ten minutes](docs/first-app.md)**: make it in Saltix, copy its developer key, `npm run example`.

**Saltix shows apps full screen**: keep tappable content clear of the wallet's controls, pad by the safe area, and test
at the Galaxy Z Fold's sizes in `grain dev` ([AGENTS.md](AGENTS.md), [Designing for Saltix](docs/first-app.md#designing-for-saltix)).

| Package | What it is |
|---|---|
| [`@saltix/grain`](packages/grain) | the page's side of the bridge: typed `grain_*` methods, events, `inWallet()`, `walletLink()`, `grain.chat.open()`, `grain.layout()` (the full-screen page's safe area and the wallet's controls, as CSS variables), `grain.manage.open()` |
| [`@saltix/grain-server`](packages/server) | the server's side: check sign-ins, make and sign invoices, certify an invoice key, find payments on chain, sign the manifest, the registry's calls, Address v1, and the grain's chat (`ChatServer`, from a developer key alone) |
| [`@saltix/grain-cli`](packages/cli) | the `grain` command line: `init`, `dev`, `lint`, `icon`, `sign`, `publish`, `retire`, `show`, `chat-spec`, `cert`, `configure`, `access`, `rate`, `bind`, `app-key` |
| [`simulator/`](simulator) | the wallet's side of the bridge in a desktop browser, for development: the page full screen with the wallet's controls at a phone's and the Galaxy Z Fold's sizes, and a chat pane |
| [`examples/hello-grain`](examples/hello-grain) | a grain with its server: sign-in, storage, an invoice paid and found on chain, and a chat that runs from a developer key (`npm run example`) |
| [`docs/first-app.md`](docs/first-app.md) | your first app in ten minutes: Saltix's App studio, the developer key, a command, going public, designing for a full-screen app |
| [`AGENTS.md`](AGENTS.md) | the rules a coding agent (and a person) follows: an app's full-screen layout, and work on this repository; `CLAUDE.md` points to it |
| [`docs/chats.md`](docs/chats.md) | grain chats: the spec, the server, registered and certified keys, private apps and members, the console and the team's hellos, the numbers an app reports, files, and what a wallet shows and refuses |
| [`docs/payments.md`](docs/payments.md) | payments: invoices from a developer key (to the app's owner) or a certified key, in a chat card or from a page, finding the payment on chain, and what a wallet refuses |
| [`docs/cards.md`](docs/cards.md) | the card design standard: how every Saltix draws a card (the capsule, the action bar, emphasis, polls, states after a tap), what each block is for, do's and don'ts, and the lint |

The packages reproduce `vectors/grains-v1.json` (manifests, chat-only ones included, logins, invoices, notifications,
the registry transactions of 12-grains and 24-app-studio, deposits, the developer key), the addresses of
`vectors/crypto-v1.json`, the relay records of `vectors/relay-v1.json`, the sponsors of `vectors/access-v1.json`, the
chats, member proofs, reported numbers, hellos and welcomes and file references of `vectors/grain-chats-v1.json` and the usernames bound to
apps of `vectors/handles-v1.json` byte for byte, refusals included; `scripts/sync-vectors.sh ../saltix` (a checkout of
corvise/saltix) refreshes them.

## Quick start

```sh
npm install
npm run dev            # builds, then serves the simulator and hello-grain on :8090
npm run example        # hello-grain's chat as your app's server, from your developer key (SALTIX_APP_KEY or app.key)
```

- **In a desktop browser:** open `http://localhost:8090/` (the simulator), press *Load a manifest*,
  then *Open*. The page is shown full screen as Saltix shows it: under a status bar and a navigation bar, with the
  wallet's ⋯ | ✕ in its corner; *Size* switches to the Galaxy Z Fold's 475×751, 704×932 and 932×704. Sign-in signatures
  are real; payments are not made. *Load the chat* talks to the example's chat through
  a development relay, as a wallet would ([docs/chats.md](docs/chats.md)).
- **In a debug Saltix in the Android emulator:** open the link the server prints,
  `salt:grain?manifest=http%3A%2F%2F10.0.2.2%3A8090%2F.well-known%2Fsaltix-grain`. Debug builds take
  developer origins (`localhost`, `127.0.0.1`, `10.0.2.2`); release builds never do.
- `NODE_RPC` (default `http://127.0.0.1:30334`, a node's own default) is a node of the wallet's network: the server
  reads its genesis for invoices and finds payments there.

### Networks, and where `--node` comes from

Saltix's **test network** is of the devnet kind: addresses `dsalt1…`, developer keys `saltix-app:1:dsalt:…`, and
`network: "devnet"` wherever the SDK asks (`testnet` is a kind no public network runs yet). It is reset now and then;
a developer key names the genesis it was made on, and the SDK refuses a key of a network that was reset.

- **The chat server and `grain app-key`** need no node: they reach the test network through its public relays
  (`PUBLIC_RELAYS`, pinned by their certificates).
- **The other commands' `--node`** is a node's wallet interface over plain HTTP: a test-network node of your own
  (`https://download.saltix.io/node/install.sh`, Linux x86-64; its wallet interface listens on
  `http://127.0.0.1:30334`), or one reached through a tunnel, `ssh -N -L 30334:127.0.0.1:30334 you@your-server`. Without
  one, do the owner's calls in Saltix (My apps). `grain publish` needs a node even for its QR code: it quotes the
  deposit and watches the registry.

## The command line

In the checkout, `npx grain …` runs it once `npm install` and `npm run build` have run. For a project of your own
elsewhere, install the tool and the server SDK from the checkout (they are not on npm yet), then `npx grain …` there:

```sh
npm install --save-dev ../saltix-grains/packages/cli ../saltix-grains/packages/server
```

```sh
npx grain init dice --name "Dice roll"   # grain.json, owner.key (owner-only), public/ with the bridge, AGENTS.md
cd dice && npx grain dev                  # serves public/, the manifest signed for this computer, and the simulator
npx grain lint                            # what stops grain.json from being registered; warns of a top bar under ⋯ | ✕
npx grain icon icon.png                   # the hash grain.json names its 256x256 icon by
npx grain sign                            # signed.json: serve it at /.well-known/saltix-grain
npx grain bundle --sources https://cdn.example/dice-2.zip --connect https://api.dice.example
                                          # a sealed grain: public/ as one ZIP named by its hash
npx grain publish --node http://127.0.0.1:30334   # a QR code: the owner's Saltix registers it (the node quotes the deposit)
npx grain publish --node … --key owner.key --wait # or sign with a key file (test networks)
npx grain retire --slug dice --node …     # close the slug for good; the deposit returns 30 days later
npx grain cert init && npx grain cert     # server.key, and cert.json: the owner key certifies it (31 days for chats)
npx grain chat-spec --cert cert.json      # chat.json → chat.signed.json, served at /.well-known/saltix-grain-chat
npx grain init coach --chat               # a chat-only grain: grain.json, chat.json, server.mjs (npm start), no page
npx grain configure --slug dice --server server.key --category games --node …   # the registry names the server key
npx grain app-key make --slug dice --node …     # app.key: its developer key, owner-only, never printed
npx grain app-key --file app.key          # a developer key's public parts, and whether the registry names it
npx grain access --slug dice --private --member dsalt1q…:user+developer --node …  # its owner and members only
npx grain access --slug dice --public --node …  # anyone
npx grain bind --handle @dice --slug dice --node …   # a username you hold opens the app's chat
npx grain rate --slug chess --score 5 --review "Good" --key rater.key --node …   # rate someone else's app
```

- `grain help <command>` (or `grain <command> --help`, `-h`) prints that command's part of the help and runs nothing;
  `grain --version` names the tool's version. A flag's value is the next word or comes after `=` (`--node=URL`); a
  switch (`--chat`, `--wallet`, `--wait`, `--public`, `--private`, `--clear`, `--offline`, `--revoke-all`) takes none, so
  `grain init --chat coach` makes `coach`. A flag a command does not take is refused (exit 2), never ignored.
- `grain dev` signs the manifest for the origin each request came to (`localhost`, `127.0.0.1`, or
  the emulator's `10.0.2.2`) and prints the `salt:grain?manifest=…` link to open in a debug Saltix, and the simulator's
  address (`/_simulator/`): the page full screen with the wallet's controls, at a phone's and the Galaxy Z Fold's sizes.
- `grain init` lays its page out full screen by the variables `grain.layout()` sets, and writes `AGENTS.md` (the rules a
  coding agent follows) and `CLAUDE.md` (which points to it). `grain lint` warns (`full-screen-top-bar`) when a page in
  `public/` has a fixed or sticky top bar but uses none of `--saltix-safe-*`, `--saltix-controls-*` or
  `env(safe-area-inset-top)`: a heuristic, never an error.
- `publish` without a key file shows `salt:grain-publish?m=…` as a QR code (Saltix 12-grains §10):
  scan it with the owner's Saltix, which fills in its account's key, checks the manifest and the
  registry, shows the grain and the deposit and, after the PIN, signs and registers it (or records
  a newer version). The tool waits for the registry and writes `signed.json`, the form your origin
  serves. The owner's key never leaves the phone.
- With `owner.key` (or `--key`), for devnets and the test network: it asks the node for the slug —
  unregistered → `RegisterGrain` with the deposit; the owner's with a lower version → `UpdateGrain`;
  anything else is refused before a transaction is made — checks the balance, signs and submits
  through the node's wallet interface (plain HTTP: a local node or an SSH tunnel).
- `grain show --slug S --node … --out signed.json` writes the signed manifest the registry holds; for a free slug it
  says the deposit registering it keeps: 100 SALT for 3–5 characters, 30 for 6–7, 10 for 8 or more (24-app-studio §5).
- `configure`, `access` and `bind` are the owner's (the handle's holder's) calls: signed with `owner.key` on test
  networks, refused before a node would refuse them; without a key file the tool says what to do in the owner's Saltix
  (My apps) and waits for the registry (`--timeout`). `configure` replaces the server keys and the category
  (`--revoke-all` names no key, which stops every developer key at once); `access` replaces public or private and the
  members. A rating names its account and is signed by the rater's key (`--key`), or given in Saltix.
- `grain app-key` reads a developer key from `SALTIX_APP_KEY`, `--file` or stdin, never from the command line (shells
  keep their history), and prints its network, genesis, slug, public key and address, and whether the registry names it
  (through the network's public relays, or `--node`).
- `grain bundle` seals `public/` (Saltix 12-grains §8): one ZIP of its files — sorted, no times, so
  the same files make the same bytes — at most 20 MiB, and `grain.json` names its hash, size,
  `sources` (where you upload `bundle.zip`), `start` and the `connect` origins the grain may reach.
  Wallets download it, check the hash and serve it from the phone at `https://<slug>.grain.invalid`,
  with the network limited to `connect`. A sealed grain's `grain dev` makes the bundle for every
  manifest it serves and serves it at `/_bundle.zip`, so a debug Saltix runs it as it will run.

## The page

```ts
import { grain, inWallet, walletLink } from "@saltix/grain";

if (!inWallet()) showLink(walletLink("https://chess.example/.well-known/saltix-grain"));

const info = await grain.info();               // slug, version, form, listing, language, theme, network, start
const layout = await grain.layout();           // full screen: { safeArea, controls }, kept current, and CSS variables
await grain.ready();
const answer = await grain.login(challenge);   // { key, signature, at, origin }: check it on your server
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

**Full screen** (bridge version 3, Saltix 12-grains §5, §7): Saltix opens every app edge to edge, with its controls
`⋯ | ✕` floating in the top right corner. `grain.layout(onChange?)` reads `safe_area {top, bottom, left, right}` and
`controls {top, right, width, height}` from `grain_info`, follows the `insets` event, window resizes and theme changes,
and sets `--saltix-safe-top`, `--saltix-safe-bottom`, `--saltix-safe-left`, `--saltix-safe-right`,
`--saltix-controls-top`, `--saltix-controls-right`, `--saltix-controls-width` and `--saltix-controls-height` on `:root`.
An older Saltix (bridge 1–2) gives 0 and no controls; a plain browser its own `env(safe-area-inset-*)` and no controls
(`layoutOf` decides it, in one place). Keep text inside the safe area and every tappable element out of the controls'
box; no close button of your own (✕ and Back close the app). [Designing for Saltix](docs/first-app.md#designing-for-saltix).

Every method rejects with a `GrainError` whose `code` is `4001` (the user refused), `4100` (not
permitted: the manifest does not ask for it, or no tap before a payment), `4200` (unsupported),
`4290` (rate limited), `-32602` (invalid parameters), `5000` (the wallet failed) or `4900` (not in a
wallet).

## The server

```ts
import { AppKey, newChallenge, verifyLogin, signInvoice, issueInvoiceKeyCert, findPayment, RelayClient, signNotification, grantFor } from "@saltix/grain-server";

// Sign-in: give the page a challenge, check what grain.login returned.
const ok = verifyLogin(answer, { slug: "chess", origin: "https://chess.example", challenge });

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

**A chat** (Saltix 22-grain-chats, 24-app-studio, [docs/chats.md](docs/chats.md)): users send typed actions your chat
spec declares, your server answers with cards it signs with the server key. The developer key Saltix gives for the app
is the server's whole configuration: it finds the network's public relays, checks that the registry names the key, signs
the spec, and stops once the owner replaces or revokes the key. Requests are checked and answered once; a private app
takes its owner's and members' only (member proofs, checked against the registry and the accounts' keys); files go next
to the relay; unasked messages are at most 10 a day per user; the numbers it reports are signed hourly. Each request
names the user's language (`ask.lang`: `en`, `ru`, …, or `""` when the app does not say): answer in it when you can,
else in English. The team's chat with its own app is the app's **console** (24-app-studio §4): `chat.team()` reads who
is on the team, `chat.notifyTeam(card)` writes to it (100 a day each), and `chat.report(error)` sends an error as a card
made for an AI agent, scrubbed of secrets and folded within an hour; handlers' errors are reported on their own. The
team's wallets say **hello** to their own app by themselves (22-grain-chats §3a): the server checks the member proof
against the registry, keeps where the member's console is and welcomes the wallet (once an hour per key, nothing at all
to anyone off the team, at most 30 checks a minute against the node), so the console reaches the team before anyone
writes. In Saltix, long-press the report → Copy for an AI agent → paste it into Claude Code.

```ts
const chat = await ChatServer.start({ appKey: process.env.SALTIX_APP_KEY!, spec, store: fileChatStore("chat.store.json") });
// or under the owner key's certificate: { slug: "chess", spec, secret: serverSecret, cert, chain, node }
chat.command("rating", (ask) => card().fields({ Rating: rating(ask.key) }).status("done").open("Play", "lobby"));
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

A **sponsor** pays the relays for your users' grain frames when the free share is busy (Saltix 11-access, 12-grains §5.4):

```sh
grain sponsor init                                   # sponsor.key; put its account in grain.json "sponsor"
grain sponsor --node URL                             # its account, WORK, channels, the exchanges to open one with
grain sponsor open --exchange <city> --amount 10 --node URL
```

```ts
// At login: a grant for the user's grain key (what grain.login returned), for the page's grain.relay.open({ grant }).
const grant = await grantFor(nodeUrl, sponsorSecret, answer.key, { perDay: 500_000n, days: 7 });
```

The wallet checks the grant against the manifest's sponsor and network; the exchange holds each user to `perDay` µWORK.

`RelayClient` (Saltix 09-relay §3, 12-grains §5.4–5.5) registers under the server key with a record it signs
itself, its messaging key derived from that key (`serverMessagingSecret`); it trusts a relay's self-signed
certificate only by the hash in the relay's record, takes users' messaging keys only from records it checked,
acknowledges kept frames with a signed proof, and reconnects on its own, to another relay when one fails. Its
frames use the free share for now. `notificationProblem` checks a notification as a wallet does: signed by the owner key,
a certified key, or a key the registry names (`servers`).

The manifest your site serves at `/.well-known/saltix-grain` is `signManifest(manifest,
ownerSecret)`'s output (`grain sign`); keep the owner's key off servers. A manifest names its `owner`
account and an `owner_key` that speaks for it (Saltix 12-grains §2): a key file's own account and
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
