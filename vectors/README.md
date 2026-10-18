# Golden vectors: the protocol's own bytes

The JSON files here are the Saltix protocol's **golden vectors**: keys, signed objects and their encodings, made by the
protocol's reference implementation and copied here unchanged. They are the protocol's bytes, not this SDK's: every
client, in any language, reproduces them byte for byte, refusals included. The SDK's tests do
(`packages/*/test/vectors.test.mjs` and the tests each format has).

- **They are never edited by hand.** `SOURCE` names the protocol commit they were copied from (its first line,
  `corvise/saltix <commit>`) and each file's git blob id at that commit; `node scripts/check-vectors.mjs`, which CI runs,
  refuses a file whose bytes differ, one `SOURCE` does not name, and one missing. A new version of a file arrives by
  `scripts/sync-vectors.sh` from the protocol's repository, which only its maintainers can run while that repository is
  private.
- **When they and a page disagree**, the vector is right, unless the page names a protocol change made after
  `SOURCE`'s commit (below). [docs/protocol/](../docs/protocol/README.md) explains every format they hold; a file's own
  `spec` field (`"specs/12-grains.md"`, …) names the protocol document, which those pages reflect under the same name
  and section numbers.
- **The protocol moved on since `SOURCE`'s commit** (`4b431c1`) in two places the pages already follow (they reflect
  `7d3744c5`), and the next sync brings their vectors: a member proof is refused only past 30 days **and 5 minutes**
  of the reader's clock (`grain-chats-v1.json` still has the case "+ 30 days + 1 ms", which the SDK's tests read with
  the 5 minutes added), and `ConfigureGrain` tag 39, of protocol version 2, which no network runs yet
  (`grains-v1.json` has only tag 34).
- **Using one.** A file holds its `version`; the genesis hash and network its network-bound signatures use (`chain`, or
  `genesis_hash` and `network`); the keys it signs with (fixed, fake secrets: never use them for anything real); the
  objects in their Borsh form as hex, and in their JSON form where they have one; the messages signed (`message_hex`);
  and `rules` or `notes`, the formats in one line each. Lists named `refused` hold inputs every reader refuses, each
  with its reason, which a client reproduces too. A P-256 signature in them is deterministic (RFC 6979); any valid
  low-`s` signature of the same message checks.

| File | What it holds | Pages |
|---|---|---|
| `grains-v1.json` | grain keys from a phrase (`keys`); manifests of every entry (hosted, sealed, managed owner, chat) with their Borsh, JSON form, id and signature; the icon and bundle hashes; a login; invoices signed by the owner key, a certificate and a registered server key, with the wallet's refusals (`invoices.registered`); notifications; the slug deposits and the owner's registry transactions (register, update, retire, configure, access, rate); the developer key (`app_key`) | [grains](../docs/protocol/grains.md), [app studio](../docs/protocol/app-studio.md), [basics](../docs/protocol/basics.md#transactions-an-apps-tools-sign) |
| `grain-chats-v1.json` | a chat spec signed by the owner and by a server key, its `.well-known` document; requests (with a member proof, text only), answers, a report, a poll, a `Publish`, a hello and its welcome, reported numbers, each as signed Borsh and as a sealed frame's plaintext; a file reference in Borsh and JSON; the card standard's cases (`cards`); what every reader refuses | [grain chats](../docs/protocol/grain-chats.md), [relays](../docs/protocol/relays.md#files-next-to-the-relay) |
| `connect-v1.json` | a page's session, its offer as text and as a link, other offers and refused ones; the wallet's `ConnectSeen`; grants signed by a plain key and by a phone's P-256 key, sealed to the page; the key event logs they are checked against (`managed`, `managed-payments`, `managed-without-phone`, `upgraded`; a plain account's is empty); refused grants and payloads | [connect](../docs/protocol/connect.md) |
| `connect-profiles-v1.json` | Connect profiles of a mini-app and of a site, signed by a plain account and by a managed account's phone, in Borsh and JSON; links taken and refused; profiles refused for every rule, each with its reason; the profile link; `SetGrainProfile` transactions; the logs a site's owner is checked against | [connect §11](../docs/protocol/connect.md#11-the-connect-profile) |
| `crypto-v1.json` | phrases, seeds and keys by path, addresses on every network, messaging keys (and the vault's, which no app uses) | [basics](../docs/protocol/basics.md#addresses) |
| `relay-v1.json` | key bindings, device certificates, address records, mailbox acks and the records a client signs for relays; the rest (the vault, linking a browser, managed records, profile names) is wallets' and no app uses it | [relays](../docs/protocol/relays.md#registering-an-address) |
| `access-v1.json` | channel and stake transactions, an allowance and its request, a voucher, sponsor certificates signed by a plain key (`grant`) and a phone (`phone_grant`) | [relays](../docs/protocol/relays.md#paying-for-relays-lanes-and-sponsors) |
| `handles-v1.json` | usernames and numbers: their forms and Borsh, what a typed text reads as, how wallets display them, and every handle transaction (`BindHandle` among them) | [basics](../docs/protocol/basics.md#usernames-and-numbers), [app studio §2](../docs/protocol/app-studio.md#2-the-registry) |
