# saltix-grains

SDKs and tools for **grains**, apps that open inside Saltix wallets (in the Saltix app: Apps → Grains). The
rules are in the protocol's [12-grains](https://github.com/corvise/saltix/blob/main/specs/12-grains.md).
A grain uses the wallet's identity, payments, storage and relays, and never holds the wallet's keys.

| Package | What it is |
|---|---|
| [`@saltix/grain`](packages/grain) | the page's side of the bridge: typed `grain_*` methods, events, `inWallet()`, `walletLink()` |
| [`@saltix/grain-server`](packages/server) | the server's side: check sign-ins, make and sign invoices, certify an invoice key, find payments on chain, sign the manifest, the owner's registry transactions, Address v1 |
| [`@saltix/grain-cli`](packages/cli) | the `grain` command line: `init`, `dev`, `lint`, `icon`, `sign`, `publish`, `retire`, `show` |
| [`simulator/`](simulator) | the wallet's side of the bridge in a desktop browser, for development |
| [`examples/hello-grain`](examples/hello-grain) | a grain with its server: sign-in, storage, an invoice paid and found on chain |

The packages reproduce `vectors/grains-v1.json` (manifests, logins, invoices, registry transactions), the addresses of
`vectors/crypto-v1.json`, the relay records of `vectors/relay-v1.json` and the sponsors of `vectors/access-v1.json` byte
for byte; `scripts/sync-vectors.sh ../saltix` (a checkout of corvise/saltix) refreshes them.

## Quick start

```sh
npm install
npm run dev            # builds, then serves the simulator and hello-grain on :8090
```

- **In a desktop browser:** open `http://localhost:8090/` (the simulator), press *Load a manifest*,
  then *Open*. Sign-in signatures are real; payments are not made.
- **In a debug Saltix in the Android emulator:** open the link the server prints,
  `salt:grain?manifest=http%3A%2F%2F10.0.2.2%3A8090%2F.well-known%2Fsaltix-grain`. Debug builds take
  developer origins (`localhost`, `127.0.0.1`, `10.0.2.2`); release builds never do.
- `NODE_RPC` (default `http://127.0.0.1:30734`) is a node of the wallet's network: the server reads
  its genesis for invoices and finds payments there.

## The command line

```sh
npx grain init dice --name "Dice roll"   # grain.json, owner.key (owner-only), public/ with the bridge
cd dice && npx grain dev                  # serves public/ and the manifest signed for this computer
npx grain lint                            # what stops grain.json from being registered
npx grain icon icon.png                   # the hash grain.json names its 256x256 icon by
npx grain sign                            # signed.json: serve it at /.well-known/saltix-grain
npx grain bundle --sources https://cdn.example/dice-2.zip --connect https://api.dice.example
                                          # a sealed grain: public/ as one ZIP named by its hash
npx grain publish --node http://127.0.0.1:30334   # a QR code: the owner's Saltix registers it (100 SALT)
npx grain publish --node … --key owner.key --wait # or sign with a key file (test networks)
npx grain retire --slug dice --node …     # close the slug for good; the deposit returns 30 days later
```

- `grain dev` signs the manifest for the origin each request came to (`localhost`, `127.0.0.1`, or
  the emulator's `10.0.2.2`) and prints the `salt:grain?manifest=…` link to open in a debug Saltix.
- `publish` without a key file shows `salt:grain-publish?m=…` as a QR code (Saltix 12-grains §10):
  scan it with the owner's Saltix, which fills in its account's key, checks the manifest and the
  registry, shows the grain and the deposit and, after the PIN, signs and registers it (or records
  a newer version). The tool waits for the registry and writes `signed.json`, the form your origin
  serves. The owner's key never leaves the phone.
- With `owner.key` (or `--key`), for devnets and the test network: it asks the node for the slug —
  unregistered → `RegisterGrain` with the deposit; the owner's with a lower version → `UpdateGrain`;
  anything else is refused before a transaction is made — checks the balance, signs and submits
  through the node's wallet interface (plain HTTP: a local node or an SSH tunnel).
- `grain show --slug S --node … --out signed.json` writes the signed manifest the registry holds.
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
await grain.ready();
const answer = await grain.login(challenge);   // { key, signature, at, origin }: check it on your server
await grain.storage.set("rating", "1640");     // synced across the user's devices, 1 MiB per grain
const { id } = await grain.pay({ invoice });   // from a tap; the wallet's own sheet and PIN
grain.on("theme", ({ theme }) => repaint(theme));

const me = await grain.relay.open({ grant });  // the user's address in this grain; grant: your sponsor pays relays
await grain.relay.send(peer, bytes, { keep: true });   // sealed to peer's key; at most 48 000 bytes
const stop = grain.relay.onFrame((from, payload) => apply(from, payload));
await grain.notifications.allow();             // asked once: your server may notify with the grain closed
```

Frames without a sponsor use the relay's free share, never the user's own channel.

Every method rejects with a `GrainError` whose `code` is `4001` (the user refused), `4100` (not
permitted: the manifest does not ask for it, or no tap before a payment), `4200` (unsupported),
`4290` (rate limited), `-32602` (invalid parameters), `5000` (the wallet failed) or `4900` (not in a
wallet).

## The server

```ts
import { newChallenge, verifyLogin, signInvoice, issueInvoiceKeyCert, findPayment, RelayClient, signNotification, grantFor } from "@saltix/grain-server";

// Sign-in: give the page a challenge, check what grain.login returned.
const ok = verifyLogin(answer, { slug: "chess", origin: "https://chess.example", challenge });

// Invoices: certify a server key once with the owner's key (offline), then sign with it.
const cert = issueInvoiceKeyCert(ownerSecret, "chess", serverKeyHex, Date.now() + 90 * 86_400_000);
const invoice = signInvoice({ slug: "chess", to, asset: "SALT", amount: 2_500_000_000n, memo: "Premium",
  reference, expires_at: Date.now() + 600_000 }, serverSecret, genesisHash, cert);

// The payment, by the reference its public memo carries.
const payment = await findPayment(nodeUrl, myAddress, reference);

// Users through the relays, under the server key: frames both ways and notifications.
const relay = await RelayClient.connect({ node: nodeUrl, secret: serverSecret, network: "testnet" });
await relay.notify(userGrainAddress, signNotification(
  { slug: "chess", title: "Your move", body: "Bob played e4", start: "game-7", at: Date.now() }, serverSecret, genesisHash, cert));
await relay.send(userGrainAddress, bytes);                       // live; { keep: true } for the mailbox
relay.on("frame", ({ from, payload, kept }) => handle(from, payload));
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
frames use the free share for now. `notificationProblem` checks a notification as a wallet does.

The manifest your site serves at `/.well-known/saltix-grain` is `signManifest(manifest,
ownerSecret)`'s output (`grain sign`); keep the owner's key off servers. A manifest names its `owner`
account and an `owner_key` that speaks for it (Saltix 12-grains §2): a key file's own account and
key (`{ "ed25519": "<hex>" }`), or — published from Saltix by a managed account — its phone's P-256 key
(`{ "p256": "<hex>" }`). `invoiceProblem` and `notificationProblem` take that `owner_key`;
`verifyByDeviceKey` checks either kind. `signGrainTx` makes a plain owner's registry transactions
(`RegisterGrain`, `UpdateGrain`, `RetireGrain`) as `grain publish` does.

## Checks

```sh
npm test               # builds, then runs every package's tests (node --test)
```

MIT licensed.
