# salarium-grains

SDKs and tools for **grains**, apps that open inside Salarium wallets (Saltix: Apps → Grains). The
rules are in Salarium's [12-grains](https://github.com/corvise/salarium/blob/main/specs/12-grains.md).
A grain uses the wallet's identity, payments, storage and relays, and never holds the wallet's keys.

| Package | What it is |
|---|---|
| [`@salarium/grain`](packages/grain) | the page's side of the bridge: typed `grain_*` methods, events, `inWallet()`, `walletLink()` |
| [`@salarium/grain-server`](packages/server) | the server's side: check sign-ins, make and sign invoices, certify an invoice key, find payments on chain, sign the manifest, the owner's registry transactions, Address v1 |
| [`@salarium/grain-cli`](packages/cli) | the `grain` command line: `init`, `dev`, `lint`, `icon`, `sign`, `publish`, `retire`, `show` |
| [`simulator/`](simulator) | the wallet's side of the bridge in a desktop browser, for development |
| [`examples/hello-grain`](examples/hello-grain) | a grain with its server: sign-in, storage, an invoice paid and found on chain |

The packages reproduce `vectors/grains-v1.json` (manifests, logins, invoices, registry transactions) and the addresses of
`vectors/crypto-v1.json` byte for byte; `scripts/sync-vectors.sh ../Salarium` refreshes them.

## Quick start

```sh
npm install
npm run dev            # builds, then serves the simulator and hello-grain on :8090
```

- **In a desktop browser:** open `http://localhost:8090/` (the simulator), press *Load a manifest*,
  then *Open*. Sign-in signatures are real; payments are not made.
- **In a debug Saltix in the Android emulator:** open the link the server prints,
  `salt:grain?manifest=http%3A%2F%2F10.0.2.2%3A8090%2F.well-known%2Fsalarium-grain`. Debug builds take
  developer origins (`localhost`, `127.0.0.1`, `10.0.2.2`); release builds never do.
- `NODE_RPC` (default `http://127.0.0.1:30734`) is a node of the wallet's network: the server reads
  its genesis for invoices and finds payments there.

## The command line

```sh
npx grain init dice --name "Dice roll"   # grain.json, owner.key (owner-only), public/ with the bridge
cd dice && npx grain dev                  # serves public/ and the manifest signed for this computer
npx grain lint                            # what stops grain.json from being registered
npx grain icon icon.png                   # the hash grain.json names its 256x256 icon by
npx grain sign                            # signed.json: serve it at /.well-known/salarium-grain
npx grain publish --node http://127.0.0.1:30334 --wait   # register the slug (100 SALT) or a newer version
npx grain retire --slug dice --node …     # close the slug for good; the deposit returns 30 days later
```

- `grain dev` signs the manifest for the origin each request came to (`localhost`, `127.0.0.1`, or
  the emulator's `10.0.2.2`) and prints the `salt:grain?manifest=…` link to open in a debug Saltix.
- `publish` asks the node for the slug: unregistered → `RegisterGrain` with the deposit; the owner's
  with a lower version → `UpdateGrain`; anything else is refused before a transaction is made. It
  checks the owner's balance, signs with `owner.key`, submits through the node's wallet interface
  (plain HTTP: a local node or an SSH tunnel), and writes `signed.json`.
- `owner.key` is a key file, for devnets and the test network. On mainnet the owner's key should be
  the wallet's: signing and registering from Saltix by a QR code comes next (12-grains §10).

## The page

```ts
import { grain, inWallet, walletLink } from "@salarium/grain";

if (!inWallet()) showLink(walletLink("https://chess.example/.well-known/salarium-grain"));

const info = await grain.info();               // slug, version, form, listing, language, theme, network, start
await grain.ready();
const answer = await grain.login(challenge);   // { key, signature, at, origin }: check it on your server
await grain.storage.set("rating", "1640");     // synced across the user's devices, 1 MiB per grain
const { id } = await grain.pay({ invoice });   // from a tap; the wallet's own sheet and PIN
grain.on("theme", ({ theme }) => repaint(theme));
```

Every method rejects with a `GrainError` whose `code` is `4001` (the user refused), `4100` (not
permitted: the manifest does not ask for it, or no tap before a payment), `4200` (unsupported),
`4290` (rate limited), `-32602` (invalid parameters), `5000` (the wallet failed) or `4900` (not in a
wallet).

## The server

```ts
import { newChallenge, verifyLogin, signInvoice, issueInvoiceKeyCert, findPayment } from "@salarium/grain-server";

// Sign-in: give the page a challenge, check what grain.login returned.
const ok = verifyLogin(answer, { slug: "chess", origin: "https://chess.example", challenge });

// Invoices: certify a server key once with the owner's key (offline), then sign with it.
const cert = issueInvoiceKeyCert(ownerSecret, "chess", serverKeyHex, Date.now() + 90 * 86_400_000);
const invoice = signInvoice({ slug: "chess", to, asset: "SALT", amount: 2_500_000_000n, memo: "Premium",
  reference, expires_at: Date.now() + 600_000 }, serverSecret, genesisHash, cert);

// The payment, by the reference its public memo carries.
const payment = await findPayment(nodeUrl, myAddress, reference);
```

The manifest your site serves at `/.well-known/salarium-grain` is `signManifest(manifest,
ownerSecret)`'s output (`grain sign`); keep the owner's key off servers. `signGrainTx` makes the
owner's registry transactions (`RegisterGrain`, `UpdateGrain`, `RetireGrain`) as `grain publish` does.

## Checks

```sh
npm test               # builds, then runs every package's tests (node --test)
```

MIT licensed.
