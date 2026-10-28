# Basics: encodings, keys, addresses and amounts

> Reflects Saltix 01-foundation v2 §3–§5 (approved 2026-10-10), 03-ledger §1–§3, 13-accounts §2–§7 and §11,
> 21-names §3–§5a, 23-upgrades §6–§7, 09-relay §1.5, and of 08-node §2, 05-beacon §1 and 06-licenses §4 the order an
> account's transactions and registry calls take, as of corvise/saltix `7d3744c5` (2026-10-19); a quorum's two forms
> and protocol version 2's parts for apps (13-accounts §6.1, §7; 23-upgrades §6a) as of corvise/saltix `44bbf728`
> (2026-10-20); usernames without the numbers (21-names) as of corvise/saltix `6671fabb` (2026-10-28). Only what an app
> touches.

What every other page builds on. The [index](README.md#conventions) gives the notation (Borsh, `derive`, hex,
base64url).

## Hashing under domains

Every hash and signed message of the protocol is BLAKE3 in `derive_key` mode under a context string `"Saltix <purpose>
v1"`: `derive(context, bytes)`. Nothing is ever signed raw. The domains an app meets:

| Context | What it makes | Bound to the network | Page |
|---|---|---|---|
| `Saltix address v1` | an account id: `derive(…, [kind] ‖ material)` | no (the address prefix is) | [Addresses](#addresses) |
| `Saltix transaction v3` | a transaction's id, which its sender signs | yes | [Transactions](#transactions-an-apps-tools-sign) |
| `Saltix grain manifest v1`, `Saltix grain manifest id v1` | a manifest's signed message, its id | no | [grains §2](grains.md#2-manifest) |
| `Saltix grain icon v1`, `Saltix grain bundle v1` | the icon's and a sealed bundle's hash | no | [grains §2](grains.md#2-manifest), [§8](grains.md#8-sealed-bundles) |
| `Saltix grain key v1` | a user's grain key (its Ed25519 seed) | no | [grains §5.1](grains.md#51-identity) |
| `Saltix grain login v1` | a sign-in's signed message | no (origin and slug are in it) | [grains §5.1](grains.md#51-identity) |
| `Saltix grain invoice v1`, `Saltix grain invoice key v1` | an invoice, a server key's certificate | the invoice yes, the certificate no | [grains §5.2](grains.md#52-payments) |
| `Saltix grain notification v1` | a notification | yes | [grains §5.5](grains.md#55-notifications) |
| `Saltix grain messaging key v1`, `Saltix grain server messaging key v1` | a user's and a server's messaging secret | no | [grains §5.4](grains.md#54-relays-real-time-between-users), [§5.5](grains.md#55-notifications) |
| `Saltix grain chat spec v1`, `… chat request v1`, `… chat message v1`, `… chat hello v1`, `… chat welcome v1` | a chat's signed objects | all but the spec | [grain chats](grain-chats.md) |
| `Saltix grain member v1` | a member proof | yes | [grain chats §3](grain-chats.md#3-requests-what-the-user-sends) |
| `Saltix grain stats v1` | an app's reported numbers | yes | [grain chats §4](grain-chats.md#4-messages-what-the-app-sends) |
| `Saltix grain server v1` | a server key's proof of its holder (protocol version 2) | yes | [app studio §2](app-studio.md#2-the-registry) |
| `Saltix app invite v1` | an invite's MAC key | yes | [app studio §2a.1](app-studio.md#2a1-invites) |
| `Saltix connect login v1`, `Saltix connect profile v1` | a Connect login, a Connect profile | the login names its network | [connect](connect.md) |
| `Saltix link payload v1` | the key that seals a payload to a link slot | no (bound to the slot) | [relays](relays.md#link-slots) |
| `Saltix messaging key v1`, `Saltix address record v1`, `Saltix device certificate v1`, `Saltix mailbox ack v1` | records a client signs for relays | no | [relays](relays.md#registering-an-address) |
| `Saltix sponsor certificate v1`, `Saltix allowance request v1`, `Saltix access allowance v1` | paying for relays | yes | [relays](relays.md#paying-for-relays-lanes-and-sponsors) |
| `Saltix key event v1`, `Saltix root digest v1`, `Saltix root use v1` | an account's key event log | the events' transactions are | [Accounts whose keys change](#accounts-whose-keys-change) |

"Bound to the network" means the context's input starts with the network's **genesis hash** (32 bytes), so a signature
made for the test network is worthless on another.

## Signatures and keys

- **Ed25519** (RFC 8032), verified the way the node verifies (ed25519-dalek's `verify_strict`): the public key and `R`
  are canonical encodings not of small order, `s` is reduced, and `R` equals `[s]B − [k]A` exactly. A library's
  plain `verify` takes signatures the node refuses (a small-order key "signs" every message): the SDK checks every
  signature in one function, `verifyEd25519`, and so must any other client.
- **ECDSA P-256** is how a phone's secure hardware signs. The key is SEC1-compressed (33 bytes, not the identity), the
  signature over 32 bytes `m` is ECDSA over SHA-256 of `m` (what hardware computes as SHA256withECDSA), written `r ‖ s`,
  32 bytes each, big-endian, with `0 < r, s < n` and `s ≤ n/2`: a signer with a larger `s` uses `n − s`, so one message
  has one valid encoding.
- **`DeviceKey`**, where either may sign: `0 Ed25519([u8; 32])` or `1 P256([u8; 33])`. In JSON:
  `{"ed25519": "<hex>"}` or `{"p256": "<hex>"}`.
- **X25519** messaging keys: the secret is 32 bytes (X25519 clamps them itself, RFC 7748), the public key
  `X25519(secret, 9)`. Frames between messaging keys are NaCl `crypto_box` ([grains §5.4](grains.md#54-relays-real-time-between-users)).

## Networks

| Kind | Address prefix | |
|---|---|---|
| `mainnet` | `salt` | the main network (not launched yet) |
| `testnet` | `tsalt` | a kind no public network runs yet |
| `devnet` | `dsalt` | development networks, **Saltix's public test network among them** |

- A network is named by its **genesis hash**, which `node_status` gives (`genesis`) and every network-bound signature
  starts with. A network that is reset gets a new genesis hash: everything signed for the old one stops checking,
  developer keys included.
- Relays and `grain_info` name the network's kind (`devnet` on the test network). The SDK's `network: "devnet"` is that
  kind.
- **Slots** are seconds from `genesis_time` (`node_status`); chain formats count in slots, app formats in Unix ms.

## Addresses

```text
identifier = derive("Saltix address v1", [kind] ‖ material)          32 bytes: the account id
address    = Bech32m(prefix, [kind as one 5-bit symbol] ‖ identifier)
```

| Kind | Symbol | Material | |
|---|---|---|---|
| 0 | `q` | an Ed25519 public key (32 bytes) | a **personal address**: `salt1q…`, `dsalt1q…` |
| 5 | `9` | the hash of the phrase's first root key | a **managed account** ([below](#accounts-whose-keys-change)): `salt19…` |
| 3 | `r` | a module's name | the chain's own modules (funds, registries); never an app's |

The other kinds (contracts, and kinds retired before launch) are not an app's.

- **Bech32m** (BIP-350), all lowercase or all uppercase (uppercase for QR codes). The checksum catches up to 4 errors.
- **The account id** is the 32-byte identifier: the network is not part of it. JSON gives accounts as a Bech32m address
  of the node's network, or as the id in hex.
- **A key's personal address** is kind 0 of that key. Every key an app meets has one: a user's grain key (the grain
  alias at relays), a server key (the chat's address), a sponsor's key (its account). The SDK: `accountId(key)`,
  `encodeAddress(network, id, kind)`, `decodeAddress(text)`.
- The address format is frozen from the main network's genesis on. A kind says how an id was born, not which rules
  apply: an account changes its keys and rules without changing its address.
- **A payment link**: `salt:<address>?amount=…&asset=SALT|WORK&memo=…`.

## Keys from the phrase

An app never sees a phrase or a wallet's key. For reference, a wallet derives its keys from a BIP-39 phrase by
SLIP-0010 Ed25519 at `m/44'/1010'/account'/chain'/index'`, every level hardened. Branch 0 is the account's signing key,
branch 1 its X25519 messaging key, and branch **3 the grain secret** (`m/44'/1010'/account'/3'/0'`), from which each
grain's key is derived with the slug ([grains §5.1](grains.md#51-identity)); the other branches are the wallet's own.
`vectors/crypto-v1.json` holds keys and addresses by path, and `vectors/grains-v1.json` (`keys`) the grain secret and
grain keys of a phrase.

## Accounts whose keys change

An account is **plain** (kind 0, its key is its only authority) or **managed** (a controller in the account's state:
a kind 5 address from its first transaction on, and a kind 0 address that upgraded). A kind 5 address that has only
received funds has no controller and no devices yet.

- A managed account has **devices** (`DeviceKey`s of kind phone, browser, service or guardian, each with a daily
  limit) and a **root** behind a hash (the phrase, on paper). One device pays at once within its daily limit and is
  refused above it; the root alone always waits the account's delay; anything that strengthens the owner's control
  applies at once; a **quorum** (two devices, or the root and a device) acts at once.
- **A key speaks for an account** when it is the account's own Ed25519 key and the account has no controller, or when
  it is one of the account's current devices that is not a guardian. A manifest's `owner_key`, a Connect profile's
  key, a member proof's key and a Connect grant's signer must speak for the account they name. Once a kind 0 account
  upgraded, its old key speaks for it only if the account lists it among its devices.
- **A managed owner's grain calls wait.** `RegisterGrain`, `UpdateGrain`, `RetireGrain`, `ConfigureGrain`,
  `SetGrainAccess`, `SetGrainProfile` and `BindHandle` (and giving a handle away or listing it) are *guarded*: from one
  device they are registered as pending and take effect after the account's delay (refused above the device's limit),
  from the root alone after the delay too, unless cancelled; a quorum applies them at once. The account's devices are
  told, so a stolen phone cannot replace an app before its owner cancels. `RateGrain` is an ordinary payment: at once
  from a device, after the delay from the root alone.
- **The key event log.** Every change of a managed account's keys is an event, in order:

  ```text
  KeyEvent  { account: [u8; 32], seq: u32, prev: [u8; 32], slot: u64, body: EventBody }
  EventBody = 0 Signed(SignedTransaction) | 1 Matured(transaction id [u8; 32])
  event id  = derive("Saltix key event v1", Borsh(event))
  ```

  `seq` counts from 1, `prev` is the id of the event before (zeros for the first), `slot` never decreases. From the
  address, the network's genesis hash and its first account policy (`node_status.accounts.policy`) anyone checks the
  log offline: each event is replayed against the controller
  the earlier ones made, starting from what the address commits to (a kind 5 address's first root, or an upgraded
  kind 0 address's key). The check proves that every change was authorized; the chain orders them. A controller
  version the checker does not know makes the log unverifiable to it ("keys not verified"), never a broken account.
- **A quorum's two forms.** One signer (a key, one device, the root alone) signs the transaction's id in every protocol
  version. A quorum's signers sign its id up to version 1 and, from version 2, its **quorum message**, which names the
  proof's shape so that nobody can cut a quorum down to one of its signers and change what it may do:

  ```text
  q = derive("Saltix quorum v1", transaction id ‖ [proof tag] ‖ the devices' indexes in the proof's order)
      Devices (tag 2): two indexes; RootAndDevice (tag 4): one
  the devices sign q; the root signs its use of q: derive("Saltix root use v1", q ‖ next_digest)
  ```

  A log does not say which version each event's block ran, so its check takes a quorum in either form, the newer
  first, all its signers in the same one: a root of one form with a device of the other proves nothing.
  `vectors/accounts-v1.json` holds its log and the same quorums signed in version 2's form (`quorums_v2`), with their
  messages.
- **Where an app meets it.** `account_get` gives the current controller (its devices) as the node sees it, and
  `account_log` the log ([wallet interface](wallet-interface.md#methods)). A server that trusts its node reads
  `account_get`; a page that trusts no node (a Connect sign-in) replays `account_log` itself. The SDK's `checkLog`,
  `keySpeaksFor` and `deviceProblem` (`@saltix/grain-server`) do it, held to the logs in `vectors/connect-v1.json`,
  `vectors/connect-profiles-v1.json` and `vectors/accounts-v1.json` (version 2's quorums); port them rather than the
  replay's rules, which are the managed accounts' own.

## Amounts and units

| Asset | Decimals | Base unit | Borsh tag |
|---|---|---|---|
| SALT | 9 | 10⁻⁹ SALT | 0 |
| WORK | 6 | 1 µWORK = 10⁻⁶ WORK | 1 |

- **1 SALT = 1 000 WORK**, fixed: the network sells WORK for SALT at that price and takes it back at par. So 1 µWORK
  is exactly one base unit of SALT. WORK pays for services (relays, files, a sponsor's channel); wallets show it with
  at most 4 decimals.
- Amounts are `u64` base units in Borsh and **decimal strings of base units** in JSON: a JSON number above 2⁵³ loses
  precision, and SALT's supply counts far more base units than that. `grain_pay {to, asset, amount}` is the one place an amount
  is a decimal string in **whole units** (`"2.5"`). The SDK: `unitsOf(amount, asset)`, `ASSET_DECIMALS`.
- At most 840 000 000 SALT will ever exist; nothing is burned. That is all of the economics an app needs.

## Transactions an app's tools sign

The `grain` command line and the SDK sign registry calls (publishing, configuring, rating) and channel calls (a
sponsor's) with a kind 0 key. Wallets sign everything else. A signed transaction, version 3:

```text
Transaction {
  sender:           Sender            0 Key([u8; 32]): a kind 0 account, its key | 1 Account([u8; 32]): a managed one
  nonce:            u64               the account's next nonce (account_get's `nonce`)
  fee:              u64               base units of SALT: at least the signed size × the block's fee per byte (10 or more)
  valid_until_slot: u64               the last slot it is valid in; at most 86 400 slots ahead
  action:           Action
}
Action = 0 Transfer { to: [u8; 32], asset: Asset, amount: u64, memo: Memo }
       | 1 Registry { call: RegistryCall, amount: u64 }      a registry call and the value it sends
       | 2 OpenChannel { exchange: [u8; 32], amount: u64 }   WORK into a channel (relays.md)
       | 3 TopUpChannel { exchange, amount } | 4 CloseChannel { exchange }
       | 5 StakeAccess { amount } | 6 UnstakeAccess | 7 Account(…)       not an app's
Memo   = 0 None | 1 Text(String: 1–512 bytes) | 2 Sealed { key_hint: [u8; 4], ephemeral: [u8; 32], ciphertext: Vec<u8> }
id     = derive("Saltix transaction v3", genesis_hash ‖ Borsh(tx))
SignedTransaction { tx: Transaction, proof }    proof 0 Key([u8; 64]): the key's Ed25519 signature over id
```

- At most 16 384 bytes signed. `transaction_submit` takes the hex of the signed Borsh; `transaction_get` follows it.
- **In nonce order, several at once.** A block applies an account's transactions in the order of their nonces, each
  the account's next. A node's pool takes one up to 64 nonces ahead of the account's (`account_get`'s `nonce`), so a
  tool may send a call right behind another still in the pool, with the next nonce; the pool refuses a nonce used
  already, too far ahead, or of a pending transaction it does not outbid (error `2`,
  [wallet interface](wallet-interface.md#errors)).
- **A registry call takes the beacon chain's time.** The account's shard takes the transaction and turns its call into
  a receipt to the registry, which the beacon chain keeps; a shard's calls reach it in their order, so a call sent right
  behind a registration applies after it, in the same beacon block or a later one. The registry holds what a call makes
  once the shard block is linked into the beacon chain: about 1.5 to 2.5 minutes on the test network.
- A `Text` memo is public on the chain forever, and holds no control character but the line feed and no bidirectional
  formatting character. An invoice's payment carries its reference there ([grains §5.2](grains.md#52-payments)).
- The registry calls an app's owner sends are listed with their tags in [grains §3](grains.md#3-registry) and
  [app studio §9](app-studio.md#9-wire-shapes). A call's value goes with it and comes back when the call fails.
- The SDK: `signTx`, `txId`, `minimumTxFee` (`tx.ts`), `signGrainTx` (registry calls), `signChannelTx` (channels).
  `vectors/grains-v1.json` (`registry.transactions`) holds signed registry transactions byte for byte.

## Usernames

Handles are NFTs in the chain's registry that resolve to an account; an owner may bind one to an app so that `@name`
opens the app's chat ([app studio §2](app-studio.md#2-the-registry)).

- **A name**: 1–32 of `a-z`, `0-9` and `_`, starting with a letter, no `__`, not ending in `_`; lowercase only on chain.
  Written `@name`; the `@` is not part of it. Some names are reserved (`saltix…`, `support`, `wallet`, …).
- **Borsh** `Handle = 0 Name(String)`, the canonical text. The numbers (`+0 777 1234`, tag 1) left with the v15 test
  network's genesis (2026-10-25): tag 1 decodes as nothing, and text of their form reads as no handle.
- Reading what a person typed: white space around it dropped, a leading `@` dropped and the name lowercased. The SDK:
  `parseHandle`, `displayHandle`, `handleProblem`; `vectors/handles-v1.json`.
- `handle_get` resolves one, with `app` the slug it opens ([wallet interface](wallet-interface.md#methods)).

## People's names

An account may publish a profile name (a first and a last name, signed by the account) at the relays, and may hold
usernames. **Saltix gives an app neither.** A user is their grain key, a pseudonym of one app alone; only the app's
team and a private app's members are known to it as accounts (member proofs), and a page learns an address only from
`grain_requestAddress` with the user's yes. A name a person types in an app is the app's own data, never proof of who
they are, and profile names are personal data no app receives from Saltix.

## Protocol versions

- A network runs **protocol versions** in order, each from an epoch its schedule names. Every new tag of an enum a
  transaction carries (a registry call, an action, a memo, a key scheme, a manifest's `Entry`) comes with a new
  version: before its epoch a node refuses it. `node_status.protocol` gives `version` (the current one), `supported`,
  and `next` (`{version, epoch}` or `null`).
- Version 1 is what every network runs today. Version 2 (built, scheduled on no network yet) brings, for apps,
  `ConfigureGrain` tag 39 with proofs of its server keys ([app studio §2](app-studio.md#2-the-registry)); a client sends
  tag 34 while `protocol.version` is 1, tag 39 from 2, and never signs tag 34 valid past the switch `next` names. It
  also brings a quorum's message (above), and a sealed manifest that names no source, the network keeping its bundle
  ([grains §2](grains.md#2-manifest)); before it, a sealed manifest names 1–8 sources. `outdated` (`{version, …}` or
  `null`) says the node saw a block of a version it does not know: the network runs that one.
- **Readers.** An unknown tag fails Borsh, so a reader that predates it drops the whole object: an older wallet drops a
  chat message with a newer block or action whole ([grain chats §4](grain-chats.md#4-messages-what-the-app-sends)). A
  wallet signs nothing for a controller version it does not know, and shows an unknown key event as "keys not
  verified, update Saltix", never as a broken account.
