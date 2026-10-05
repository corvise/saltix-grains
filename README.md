# salarium-grains

SDKs and tools for **grains**, apps that open inside Salarium wallets (Saltix: Apps → Grains). The
rules are in Salarium's [12-grains](https://github.com/corvise/salarium/blob/main/specs/12-grains.md).
A grain uses the wallet's identity, payments, storage and relays, and never holds the wallet's keys.

| Package | What it is |
|---|---|
| [`@salarium/grain`](packages/grain) | the page's side of the bridge: typed `grain_*` methods, events, `inWallet()`, `walletLink()` |
| [`@salarium/grain-server`](packages/server) | the server's side: check sign-ins, make and sign invoices, certify an invoice key, find payments on chain, sign the manifest, Address v1 |
| [`simulator/`](simulator) | the wallet's side of the bridge in a desktop browser, for development |
| [`examples/hello-grain`](examples/hello-grain) | a grain with its server: sign-in, storage, an invoice paid and found on chain |

Both packages reproduce `vectors/grains-v1.json` (manifests, logins, invoices) and the addresses of
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
ownerSecret)`'s output; keep the owner's key off servers (12-grains §10: `grain sign` will sign it
in the wallet by a QR code).

## Checks

```sh
npm test               # builds, then runs both packages' tests (node --test)
```

MIT licensed.
