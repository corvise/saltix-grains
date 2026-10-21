# The protocol, for app developers

Everything a mini-app (a *grain*) or a website that signs its users in with Saltix Connect needs from the Saltix
protocol: the formats an app signs and checks, what the wallet does with them, the wallet interface and the relay
frames an app's server uses, and the rules wallets enforce. The SDKs in this repository implement all of it; these
pages say what they implement, so that you can reason about it, debug it, or write a client in another language.

The protocol's own specifications live in Saltix's protocol repository, which stays private until the main network
launches. These pages are this repository's account of their app-facing parts, written for developers. Each page names
the specification it reflects and the protocol commit it was read at. The golden vectors in [`vectors/`](../../vectors/README.md)
are the protocol's own bytes, copied unchanged: when a page and a vector disagree, the vector is right and the page
is a bug to report, unless the page follows a protocol change newer than the vectors' commit, which
[vectors/README.md](../../vectors/README.md) lists.

## The pages

| Page | What it covers | Saltix specification |
|---|---|---|
| [Basics](basics.md) | encodings, hashing under domains, signatures and device keys, networks, addresses, amounts and units, transactions an app's tools sign, usernames, protocol versions | 01-foundation, 03-ledger, 13-accounts, 21-names, 23-upgrades (parts) |
| [Grains](grains.md) | the manifest and its JSON form, the registry's grain calls, links, the bridge, the page's frame, sign-in and the team's member proof, invoices, storage, relays and notifications for grains, permissions, the container, sealed bundles, publishing | 12-grains |
| [Images](images.md) | named blobs: the image check and the bundle check, the mini-app icon standard (the master, the mask, the zones, the monogram), the light on an icon's edge, uploading an icon and a sealed bundle into the network (the server key's statement, the pieces, the refusals), fetching them, and the one rule that is consensus | 32-images |
| [Grain chats](grain-chats.md) | the chat spec, requests and member proofs, the team's hello and welcome, signed messages and their blocks and actions, frames, reported numbers, the card standard | 22-grain-chats |
| [App studio](app-studio.md) | registered server keys, chat-only grains, usernames bound to apps, private apps and roles, invites, pairing a server by QR code, the developer key, the console, deposits, categories, ratings and reported numbers | 24-app-studio |
| [Saltix Connect](connect.md) | a page's session and offer, the login and grant, sealing, the page's checks, the Connect profile of a mini-app or a site, the Connect sheet, Sign in with Saltix | 19-connect |
| [The gate](gate.md) | a test network's access grants: the grant and the token a client shows a relay, who needs none (a registered server key), a computer's unattested grant from a code, the gate's interface and refusals, what relays and their wallet interface say | 37-gate |
| [Relays](relays.md) | relay records and certificate pinning, the client protocol a server speaks (register, messages, acks, keys, presence, files, an app's numbers, link slots), paying for relays and sponsors | 09-relay, 10-storage §4, 11-access (parts) |
| [Wallet interface](wallet-interface.md) | the JSON-RPC methods an app or its server calls, at a node or a relay's gateway | 08-node §6, 09-relay §10.7 |
| [Golden vectors](../../vectors/README.md) | what each vector file holds and how to use it | every file's own `spec` field |

The six pages named after a specification keep its section numbers (`grains.md` § 5.4 is 12-grains §5.4), so a
reference such as "22-grain-chats §3a" in the SDK's code, its docs or a vector's `spec` field leads to the same place
here. Sections that concern no app (the chain's rules, nodes, relays' internals) are left out, so the numbers have gaps.

## Conventions

The pages use one notation:

- **Borsh**, as the node writes it: integers little-endian (`u8`, `u16`, `u32`, `u64`, `i64`); a `String` or `Vec<u8>`
  as a `u32` length then its bytes (UTF-8 for text); a `Vec<T>` as a `u32` count then the items; `[u8; N]` as its N
  bytes; `Option<T>` as `0`, or `1` then the value; an enum as a `u8` tag then the variant's fields; a struct as its
  fields in the order given; a `Map<K, V>` as a `u32` count then the pairs sorted by key. Readers take only the
  canonical form: a map's keys in order and none repeated, every tag known, nothing after the value. One signed object
  has one encoding.
- **`derive("Saltix … v1", bytes)`** is BLAKE3 in its `derive_key` mode with that context string, 32 bytes out. Every
  hash and signature of the protocol is under such a domain, so a signature for one purpose is worthless for another.
  `‖` is concatenation.
- **A signature "over m"** is Ed25519 over the 32 bytes `m`, verified strictly as the node verifies, or, where a device
  key may sign, ECDSA P-256 over SHA-256 of `m` as `r ‖ s` with a low `s` ([Basics](basics.md#signatures-and-keys)).
- **In JSON and text**: bytes in lowercase hex unless a page says base64url (RFC 4648 §5, without padding; relays also
  take it padded), amounts as decimal strings of base units, times as Unix milliseconds unless a field says slots.
- **Slots** are the chain's seconds: slot `n` begins `n` seconds after the network's `genesis_time`. A day is
  86 400 slots.

## What is not here

These pages hold what a third-party developer needs to build and publish a mini-app or a Connect sign-in, and nothing
more. Left out on purpose: consensus and mining, the beacon chain and shards beyond what a confirmation means, the
registry's internals besides the grain calls, cities, citizenship and licenses, WORK books, the economics beyond units
and deposits, how nodes and relays work inside (gossip, placement, replication, the vault's storage, the archive),
wallets' own formats (device linking, the vault's items, managed accounts' recovery), running a node, and any server or
deployment of Saltix's own. When an app needs one of those, the page says what it may rely on and stops there.

## Keeping them true

A page states `As of corvise/saltix <commit>`: the protocol commit its text was read at. The vectors' commit is
`vectors/SOURCE`'s. A protocol change that reaches apps updates the page, its commit line and the SDK in the same pull
request ([docs/agents/sdk.md](../agents/sdk.md#rules-of-the-repository)).
