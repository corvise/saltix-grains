# The wallet interface

> Reflects Saltix 08-node §6 and 09-relay §10.7 (with 32-images' `blob_put` and `blob_get`), as of corvise/saltix
> `b9019fdf` (2026-10-19); the pool vocabulary (`exchange_list`'s `pool` and `pool_key`, `grain_list`'s `miners` sort,
> the ratings' `miners_count`, `miners_sum` and `miner`) as of corvise/saltix `e6448704` (2026-10-22); `grain_get`'s
> `donations` (protocol version 9) as of corvise/saltix `6671fabb` (2026-10-28). Only the methods an app, its server or
> its tools call; a node answers more (the explorer's reads, pools, books, licenses).

A node's JSON-RPC interface: what wallets, the SDK and the `grain` command line read the chain through.

## Transport

- **JSON-RPC 2.0 over HTTP**: one request per body, `Content-Type: application/json`, a body of at most 64 KiB (512 KiB
  for `blob_put`, whose piece is up to 256 KiB in base64).
- **At a node of your own**: `POST /` at `--rpc`, `http://127.0.0.1:30334` by default, local only. The SDK's `--node URL`
  and `NODE_RPC` name it; reach a remote one through a tunnel, never by exposing it. A node's own interface also has
  WebSocket subscriptions (`GET /ws`: `subscribe {topic}` with `heads`, `account` or `transaction`), which no relay
  serves.
- **At any relay**: `POST /rpc` on the relay's client port, over its TLS, pinned by its record's `cert_sha256`
  ([relays](relays.md#relay-records-and-certificate-pinning)). That is how the SDK reaches the network with no node of
  its own (`publicGateways`, `--relay`): a call goes on to the next relay when one fails. A relay answers the methods
  below (and the explorer's reads) from its own node; any other method is `-32601` ("not served here"). Per client (an
  IPv4 address or an IPv6 /64): 4 requests at once, 20 a second with a burst of 60, HTTP `429` past them. Heavy reads
  (`account_history`, `grain_list`, `grain_history`, `grain_stats_list`, `handle_search`, …) share one budget among all
  of a relay's clients: 5 a second after a burst of 20, at most 2 under way, error `6` past it.

**Values.** SALT and WORK amounts are **decimal strings of base units** (a JSON number above 2⁵³ loses precision).
Hashes, keys, account ids and transaction ids are hex. An account is given as a Bech32m address of the node's network
or an account id in hex. A transaction is the hex of its signed Borsh.

## Methods

| Method | Parameters | Result |
|---|---|---|
| `node_status` | — | `network` (the kind), `genesis` (the genesis hash), `genesis_time` (Unix seconds of slot 0), `slot`, `epoch`, `epoch_slots`, `beacon {height, hash, slot, final_height, …}`, `shards [{shard, height, hash, followed, slot}]`, `peers`, `faucet` (`{amount, work, every}` or `null`), `accounts` (`{derivation, policy: {delay, dispute_timeout}}`: the network's first account policy, which an offline key event log check needs), `build {version, commit}`, `protocol {version, supported, next, outdated}` ([basics](basics.md#protocol-versions)) |
| `account_get` | `address` | `account` (hex), `shard`, `salt`, `work`, `nonce` (the next transaction's), `channels` (`[{exchange, deposit, closing_at}]`), `stake`, `controller` (a managed account's: `devices [{key: {ed25519 \| p256}, kind, limit, …}]`, `policy`, `pending`, `log_seq`, `log_tip`, …; `null` for a plain account), `alias` |
| `account_log` | `address` | a managed account's key event log: `account`, `origin` (`{root_digest}` of a kind 5 address or `{key}` of an upgraded kind 0 one; `null` with no events), `events` (`[{seq, slot, id, event}]`, `event` its Borsh in hex), along the canonical chain |
| `account_history` | `address`, `limit` (50 by default, at most 500), `before` (a height) | `entries`, newest first (below) |
| `transaction_submit` | `transaction` (hex) | `id`; the node pools and gossips it |
| `transaction_get` | `id` | `status`: `pending`, `included` or `unknown`; for `included` also `shard`, `block`, `height`, `confirmations`, `linked`, `linked_depth`, `final`; `transaction` when the node has it |
| `faucet_request` | `address` | a test network's faucet (below): `id` of the transfer, `amount`, `work` (`{id, amount}` or `null`) |
| `exchange_list` | — | `exchanges`: `pool` (its id, hex), `pool_key`, `fee_bp`, `bond`, `payout`, `closed`, `reachable` (a sponsor opens its channel with one) |
| `relay_list` | — | `relays`: `key`, `peer`, `endpoints [{url, cert_sha256}]` (empty: not reachable), `issued_at`, `version`, `store_gib`, `country` |
| `grain_get` | `slug` | `grain` (or `null`): `slug`, `owner` (account id), `version`, `id` (the manifest id), `registered`, `updated`, `retired` (slots; `retired` `null` while live), `deposit` (SALT held), `manifest` (its signed JSON form, `null` once retired), `servers` (hex), `category`, `public`, `members` (`[{account, roles}]`), `handles` (as displayed), `ratings {count, sum, miners_count, miners_sum}`, `returns`, `profile` (the signed Connect profile's JSON form, or `null`), `profile_revision`, `donations` (whether the owner takes donations: *Support the developer* on the app's card, a transfer to `owner`; absent from a node before protocol version 9); and, beside `grain`, `deposit`: what `RegisterGrain` of this slug needs, also for a free slug |
| `grain_list` | `query` (≤ 64 bytes), `sort` (`slug`, `newest`, `rating`, `miners`), `after`, `limit` (20, at most 100), `retired` (`false`), `category`, `owner` or `member` (an address) | `grains` in `grain_get`'s form, public ones only unless `owner` or `member` asks; `next` |
| `grain_ratings` | `slug`, `after`, `limit` (20, at most 100) | `ratings` newest first: `account`, `score`, `review` (as a reader may show it), `slot`, `miner` (whether the account held an active mining license when it rated); `next` |
| `grain_history` | `slug`, `before` (a beacon height), `limit` (20, at most 100), `ratings` (`true`) | `entries`: the registry calls about the grain, newest first (`call`, `height`, `slot`, `caller`, `asset`, `amount`, `refused`, `tx`, and what the call says); `next` |
| `grain_totals` | — | counts of the registry's grains: `registered`, `live`, `public`, `private`, `retired`, by entry and category |
| `grain_stats` | `slug` | `stats` (or `null`): `slug`, `at`, `users_1d`, `users_30d`, `requests_30d`, `key`, `signed` (hex of the Borsh `SignedGrainStats`, to check yourself): the newest numbers a live, public grain reported, at most 2 days old, signed by a key its record still names |
| `grain_stats_list` | `sort` (`slug` or `users`), `after`, `limit` (20, at most 100) | `stats` as above; `next` |
| `handle_get` | `name` (without `@`) or `number` (the digits after `+0`) | `handle` (or `null`): `kind`, `text`, `display`, `owner` (account id), `minted`, `price`, `primary`, `app` (the slug of the grain whose chat it opens, or `null`) |
| `handle_search` | `query` (≤ 64 bytes), `kind`, `limit` (20, at most 50) | held handles that start with the query, each with `owner`, `owner_address`, `app`; `exact` |
| `handle_of` | `address` | the account's primary `name` and `number`, or `null` each |
| `blob_put` | an icon: `kind` (`grain_icon`), `data` (base64); a bundle's piece: `kind` (`grain_bundle`), `hash`, `size`, `from`, `data` (at most 262 144 bytes, base64), `upload` (hex of a server key's `SignedBundleUpload`, for a bundle no manifest names yet) | `{kind, hash, kept: true}` for an icon; `{kind, hash, received, kept: false}` while a bundle's pieces come, then `{kind, hash, received, kept: true, pending}`; a refusal is `-32602` with `data.reason` (and `data.received` for `offset`) ([images §7](images.md#7-uploading)) |
| `blob_get` | `kind`, `hash`, `from`, `len` (a bundle's piece: 0 and 1 MiB by default) | `{blob, fetching}`: `blob` `{kind, hash, type, size, from, data}` (base64) when the node holds it, else `null`, `fetching` `true` while it fetches it ([images §8](images.md#8-fetching)) |

**A history entry** has `kind`, `block`, `height`, `slot`, `confirmations`, `linked`, `linked_depth`, `final`, `asset`
(`salt` or `work`) and `amount`. The kinds an app reads:

| `kind` | What | Besides |
|---|---|---|
| `received` | a transfer to the account within its shard | `tx`, `from`, `memo` |
| `receipt` | funds from another chain: a transfer from another shard, a registry payout or refund (a retired grain's deposit coming back, a failed call's value) | `source`, `sequence`; for a transfer `from` and `memo` |
| `sent` | a transfer from the account | `tx`, `to`, `fee`, `memo` |
| `call` | a registry call with an amount (a grain's deposit) | `tx`, `fee`, `call` |

`memo` is present only when the transfer has one: `{"text": "…"}`, or `{"sealed": {key_hint, ephemeral, ciphertext}}`.
An invoice's payment is the `received` or `receipt` entry whose text memo starts with the invoice's reference in hex
([grains §5.2](grains.md#52-payments)). A page is whole blocks: pass the page's last `height` as `before` for the next.

## Confirmations

A shard block reverts only with the beacon block that links it. `linked` says a canonical beacon block links the
block, `linked_depth` that beacon block's confirmations (one more about every 20 seconds), and `final` that it can no
longer revert: about 7 minutes after the link on the test network, about 4 hours on the main network. A wallet shows
"final" only then. A block `included` but not yet `linked` can still be replaced by another branch of its shard. An app
that delivers on a payment decides how much it waits for; a small amount may go on `included`.

## Errors

JSON-RPC codes: `-32700` unparsable JSON, `-32600` not a request, `-32601` no such method (or not served at a relay),
`-32602` invalid parameters, `-32603` node failure (`the node is busy` after 10 seconds). The node's own:

| Code | Meaning |
|---|---|
| `1` | the node does not follow the account's shard |
| `2` | the pool did not take the transaction; `message` gives the pool's reason (a nonce already used or too far ahead, a transaction of the same nonce pending that it does not outbid by at least 10% of its fee per byte, a fee too low, funds short, a tag the network does not take yet) |
| `3` | the faucet gives nothing: `no_faucet`, `too_soon` (`data.retry_after`, seconds), `daily_limit`, `empty`, `self` |
| `4` | no such canonical block |
| `6` | a relay holds a heavy read back: `data.retry_after` |

A node that does not answer within its time is not a refusal: ask again, or another relay (the SDK's `retryable`). A
node knows the transactions and accounts of only the shards it follows, so through a relay `unknown` from
`transaction_get`, or error `1`, may mean only that this relay's node does not follow that shard: ask another relay.

## The faucet

On test networks only. A node with a faucet signs a transfer of test SALT, and of WORK while its purse holds some, to
the address that asks, and pools it like any other. An address gets one grant every 5 minutes (`faucet.every` in
`node_status`); a refusal says when to come back. `grain faucet` asks for it, through the public relays.
