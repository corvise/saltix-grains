# Payments

How an app takes a payment (Saltix 12-grains [§5.2](protocol/grains.md#52-payments)). The user always pays in the wallet's own sheet: it shows
your app, the amount, the payee and your text, and the user approves with the PIN or biometrics (or one tap within the
daily sum they allowed for your app, SALT only). Your server never touches the user's keys. It signs an **invoice**,
and later finds the payment on chain by the invoice's **reference**.

## Who signs the invoice

| Key | Payee (`to`) | When |
|---|---|---|
| A **developer key**: a server key the grain's registry record names (`ConfigureGrain`; what Saltix's app studio makes) | the grain's **owner** only | an app made in Saltix; any app whose server runs from a registered key |
| A server key the owner key **certified** (`InvoiceKeyCert`, `grain cert`) | any account | an app whose owner holds a key file |
| The **owner key** itself | any account | not on a server: the owner key stays with the owner |

A developer key's invoice pays the grain's owner, as the registry has it when the wallet checks. Then even a leaked
developer key cannot send a payment anywhere but the owner. The owner replaces or revokes it in Saltix (My apps → the
app → Developer key). Such an invoice has no certificate, like the owner key's, and the wallet tries the owner key
first and then each key the registry names.

**Which wallets take it.** Saltix 0.1.54 and newer take it, checked against the registry read when the invoice comes.
Saltix 0.1.53 and older know no registered key for invoices: they refuse such an invoice as not signed and pay nothing.
In a chat, your server cannot tell which version a user runs. So say in the card's text what the user does if the sheet
does not open: update Saltix.

## In a chat (`ChatServer`)

```ts
import { ChatServer, card, fileChatStore } from "@saltix/grain-server";

const chat = await ChatServer.start({ appKey: process.env.SALTIX_APP_KEY!, spec, store: fileChatStore("chat.store.json") });

chat.command("premium", async (ask) => {
  // Signed by the developer key, to the owner the registry names; 30 minutes to pay unless you say otherwise.
  const invoice = chat.invoice({ amount: "2.5", memo: "Premium, 1 month" });
  await orders.put(invoice.invoice.reference, { user: ask.key, invoice: invoice.invoice });   // your own store
  return card()
    .text("Premium for a month. If the payment sheet does not open, update Saltix.")
    .invoice(invoice);
});

// Later: a timer or the user's next request.
const paid = await chat.paymentOf(order.invoice);   // through the same relays or node the server reads the registry from
if (paid && paid.confirmations >= 1) await deliver(order.user);   // final on Consensus 2: the test network's
```

- `chat.invoice({ amount, asset?, memo?, reference?, expiresInMs?, to? })`:
  - `amount` is a bigint of base units or a decimal string in whole units (`"2.5"` SALT; SALT has 9 decimals, WORK 6);
  - `asset` is `"SALT"` (the default) or `"WORK"`. Ask for SALT on a network of protocol version 4 or later, as the
    test network is: WORK lives only in the pools' books there, so a WORK invoice is paid from the payer's book or as
    SALT of the same integer on chain (Saltix 35-work-on-layer-2), and `chat.paymentOf` counts only a payment in the
    invoice's own asset;
  - `memo` is the sheet's text, at most 200 bytes;
  - `reference` is 16 random bytes unless you give it;
  - it returns `{ invoice, hex, payee }`, where `hex` is what a card's `invoice` block and `grain.pay` take, and
    `payee` is the owner's address.
- `chat.invoice` throws, before anything is signed:
  - for a registered key, when `to` names anyone but the owner, or when the grain's record is unknown or retired;
  - for a certified key without a node, when `to` is missing: it knows no owner.
- `chat.paymentOf(invoice)` finds the payment to the payee whose public memo starts with the reference. It counts only
  a payment of the invoice's asset and at least its amount, and returns `null` until one is on the canonical chain.
  On Consensus 2 — the test network since its v15 of 26 October 2026 — a block the node shows is final at its
  committee's certificate, so one confirmation is enough and a payment never rolls back; on a network of the longest
  chain, deliver after the confirmations your goods are worth
  ([confirmations](protocol/wallet-interface.md#confirmations)).

## From a page (`grain.pay`)

A screen asks its server for the invoice and hands the hex to the wallet after the user's tap:

```ts
// The server, with the developer key and the grain's record (grainGet, or ChatServer.grain):
import { AppKey, grainGet, signInvoice } from "@saltix/grain-server";
const appKey = AppKey.parse(process.env.SALTIX_APP_KEY!);
const grain = await grainGet(nodeUrl, appKey.slug);
const hex = signInvoice({ slug: appKey.slug, to: grain!.owner, asset: "SALT", amount: 2_500_000_000n, memo: "Premium",
  reference, expires_at: Date.now() + 30 * 60_000 }, appKey, genesisHash);

// The page, from a tap:
const { id } = await grain.pay({ invoice: hex });
```

`signInvoice` with an `AppKey` signs for the key's own grain and network only, and takes no certificate. With a
certified key's secret and its `cert`, it signs to any payee, as before.

## What the wallet checks

`invoiceProblem(hex, slug, ownerKey, genesisHash, now, record)` decides as Saltix does, and returns `null` or the
reason. `record` is the grain's registry record (`grainGet`), or `null` for a grain the registry does not hold.

| Reason | What it means |
|---|---|
| `grain` | the invoice names another grain |
| `retired` | the grain is retired: it takes no payment, whoever signed |
| `expired` | `expires_at` has passed |
| `amount` | the amount is zero |
| `cert` | the certificate is not the owner key's for this grain, or has expired |
| `signature` | no key that may sign verifies: not the owner key, not the certificate's key, not a key the registry names now (a key the owner removed counts as none) |
| `payee` | a registered key's invoice to anyone but the grain's owner |
| `malformed` | the bytes are not a signed invoice |

The golden vectors hold one invoice of each kind (`vectors/grains-v1.json`: `invoices.cases`, and
`invoices.registered`, which holds the developer key's cases with the record each is judged against).

## Testing

- **Without a network**: a fake node that answers `account_history` beside `node_status` and `grain_get`, as
  `packages/server/test/invoice.test.mjs` does, with a development key (`AppKey.of("devnet", genesis, slug, secret)`).
  Never use a real key.
- **On the test network**: Saltix's **Faucet** button gives test SALT. Pay from Saltix, and `chat.paymentOf` finds the
  payment through the relays.
- The simulator makes no payment: it answers a made-up transaction id.
