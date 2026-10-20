# Relays: what an app's server says to them

> Reflects Saltix 09-relay §1.1–§1.3, §2, §3, §5, §6, §10.1, §10.3, §10.5, §10.5.2 and §10.7 (version 2, with the
> changes of 2026-10-15 to 2026-10-19), 10-storage §4 and 11-access §2–§5 (approved 2026-10-05), as of corvise/saltix
> `7d3744c5` (2026-10-19); and what 33-gate added to 09-relay §3 and §10.7 (a test network's access grants), as of
> corvise/saltix `6c965007` (2026-10-21). Only the client side an app's server or a Connect page uses.

Relays carry messages between clients: Saltix wallets, grains' servers, Connect pages. Clients encrypt the content themselves; a relay cannot read it. Any relay is an entry point: a client connects to one,
and relays pass frames to each other and keep mailboxes for addresses that are offline.

The SDK: `RelayClient` (`@saltix/grain-server`) is a server's whole connection (register, keys, frames, acks, files,
numbers, reconnecting to another relay), `ChatServer` uses it, and `@saltix/connect` opens link slots. The vectors:
`vectors/relay-v1.json` (records, bindings, acks, the link code and payload).

## Relay records and certificate pinning

- **Where relays are.** `relay_list` ([wallet interface](wallet-interface.md#methods)) gives the relays a node checked
  (each with a valid, signed record): `key` (the relay's node key, hex), `peer`, `endpoints` (`[{url,
  cert_sha256}]`), `issued_at`, `version`. A relay with no endpoints is not reachable from outside; skip it. A client
  that knows no relay yet starts from a few it is built with (the SDK's `PUBLIC_RELAYS` for the test network), then
  keeps the list `relay_list` returns.
- **Choosing.** Connect to the fastest of a random sample of up to five; when the connection drops, register at the
  next within seconds. Nothing is lost by switching: an address's mailbox does not live on the relay it came in by.
- **TLS without a domain.** An endpoint is `wss://host:port/` with `cert_sha256`, the SHA-256 of the relay's
  self-signed DER certificate. A client accepts the connection exactly when the certificate's SHA-256 equals
  `cert_sha256`: names and certificate authorities are not checked. An endpoint without a fingerprint has a public
  CA's certificate. The SDK writes an endpoint as `wss://host:port/#<sha256 hex>` (`--relay`).
- **Browsers cannot pin** a certificate: a web page reaches relays through a WebSocket path of its own site that pins
  them ([docs/connect.md](../connect.md)), and their files through its own relay's fetch-through (below).

## The connection

WebSocket; every frame is a JSON object with a `type`. Binary values are base64url (the relay takes it with or without
padding); addresses are Bech32m of the relay's network. The relay speaks first:

```text
hello {nonce, sts, relay, network, prices, access?}
  nonce:   16 random bytes of this connection: an address record must name it
  sts:     the relay's clock, Unix ms
  relay:   its node key
  network: "mainnet", "testnet" or "devnet"
  prices:  {frame, file_mib, turn_kib}: µWORK on the paid lane, decimal strings
  access:  {gates: [base64url key, …]} where the relay's node runs a test network's gate: every register then
           carries an access token, unless a registered server key signed its record ([the gate](gate.md#5-at-the-relays-and-the-wallet-interface))
```

The relay may also send frames nobody asked for (such as `account {…}` when a registered address's account changes on
chain): a client ignores frame types it does not know.

**Presence and silence.** A connection registers visible (`register {record}`) or invisible (`register {record,
invisible: true}`), and switches with `presence {invisible}` (no answer). A visible connection counts as online in
`status` (below); the relay pings it after 45 seconds of silence (no frame, ping or pong) and closes it after 90. An
invisible one is never pinged and is closed after 10 minutes of silence. A server registers visible and lets its
WebSocket library answer pings: that is how Saltix tells its program runs.

## Registering an address

A server registers its own address (the personal address of its server key) with a record it signs itself:

```text
KeyBinding {                     the account's messaging key; only the account key signs it
  account_key:   [u8; 32]        the address is this key's personal address
  messaging_key: [u8; 32]        X25519 public key for messages
  key_epoch:     u32             0 for a server
  devices_after: u64             Unix ms; device certificates issued before it no longer count
  issued_at:     u64             Unix ms
  signature:     [u8; 64]        by account_key over derive("Saltix messaging key v1", Borsh(the fields above))
}
AddressRecord {                  where an address is now
  key:       KeyBinding
  relay:     [u8; 32]            the node key of the relay it registers at (hello.relay)
  issued_at: u64                 Unix ms, the client's clock
  nonce:     [u8; 16]            hello.nonce of this connection
  device:    Option<DeviceCert>  none for a server: it signs with the account key itself
  signature: [u8; 64]            by device.device_key, or the account key without one, over
                                 derive("Saltix address record v1", Borsh(the fields above))
}
DeviceCert { device_key: [u8; 32], kind: u8 (0 phone, 1 browser), issued_at: u64, expires_at: u64, signature: [u8; 64] }
  by the account key over derive("Saltix device certificate v1", Borsh((account_key, device_key, kind, issued_at, expires_at)))
```

A record is valid when the binding's key is valid and its signature verifies; `key.issued_at` and `issued_at` are at
most 10 minutes ahead (and a relay takes a record only when `issued_at` is within 10 minutes of its `hello.sts`, either
way); a device certificate, if any, is valid (its signature, unexpired, issued at most 10 minutes
ahead, at most 400 days long, issued at or after `devices_after`); and the record's signature verifies. Of two records
of one address the newer binding wins, then the newer record.

```text
register {record, invisible?, access?}   record: base64url Borsh(AddressRecord); access: base64url Borsh(AccessToken)
  → registered {pubkey, keyEpoch, turn, profile}
  → error {message: "auth_failed", detail, keyEpoch?, keyIssuedAt?, issuedAt?, binding?, access?}
```

**On a test network with a gate** (the hello names `access`), a record self-signed by a registered server key of a live
grain registers as anywhere else: a paired server shows nothing. Any other key shows an access token
([the gate §3](gate.md#3-what-a-client-presents)): without a valid one the answer is `auth_failed` with `detail:
"access"` and `access` the reason (`required`, `expired`, `gate`, …). When the access ends the relay sends `error
{message: "access_ended"}` and closes the connection. `RelayClient` shows the grant its `access` option gives, only
where the hello asks; a round of relays that all refused access rejects `connect` with an `AccessRefused`, and the
events `accessRefused` and `accessEnded` say what happened later.

`detail` `"stale"` means the relays know a newer binding of the address, or a newer record of this signer
(`keyIssuedAt`, `issuedAt` and `binding` say which): a server signs a new binding and a new record dated after both,
and registers (so a server whose clock is behind still registers). `"revoked"` means the known binding revokes the
record's device. A connection registers one address (`already_registered` for another); frames that need an address
(`message`, `get_key`, `file_new`, …) before it get `not_registered`. After registering, the relay hands the connection the frames its mailbox kept.

A grain's server derives its messaging secret from its key, `derive("Saltix grain server messaging key v1", the
Ed25519 secret)`, so it keeps one messaging key across restarts and SDKs ([grains §5.5](grains.md#55-notifications)).
Wallets register their users' grain aliases on their own connections (`register_alias {record, grain: true}`, at most
32 per connection besides 8 ordinary aliases): a server never needs it.

## Messaging keys: get_key

```text
get_key {pubkey}  → key_response {pubkey, record, encryptKey, managed, log, profile}
```

`record` is the newest plain address record the relays know of the address (base64url Borsh), or `null`. **Check the
record yourself** and take the messaging key only from a checked record's binding whose key's personal address is the
address asked for; never take the relay's word (`encryptKey`). A grain alias's record is a plain kind 0 record; a
managed account's address has `record: null` and its `managed` record and `log` instead, which a grain's server never
needs. The SDK: `messagingKeyOf`, `recordProblem`.

## Sending and receiving

```text
message {to, payload, msgId, ephemeral?}     to: an address; payload: at most 64 KiB (a sealed frame, grains.md §5.4)
```

- **Kept** (the default): the frame goes live to every connected device of `to` and also to `to`'s mailbox, where it
  stays until a signed ack, for at most 7 days. A kept message needs a `msgId` of 1–128 bytes, by which it is
  acknowledged and kept once: without one it is refused (`bad_frame`, `detail: "message"`). Sent twice with one
  `msgId`, it is delivered once.
- **`ephemeral: true`**: live only, never kept; it may go without a `msgId`.
- The relay delivers the frame to the addressee with `from` (the sender's address, or the alias it names) and `sts`
  added. When no device of the addressee is connected the sender hears `peer-offline {pubkey, reason: "message"}`, and
  once a replica keeps a kept message `queued {msgId, to}`: it is on the network and may be shown as sent.
- A whole frame is at most 256 KiB. A frame to oneself is not forwarded.

**Acknowledging a kept frame**:

```text
message_ack {to, msgId, proof}       to: the message's sender; proof: base64url Borsh(MailboxAckProof)
MailboxAckProof { account_key: [u8; 32], msg_id: String, at: u64 (Unix ms), device: Option<DeviceCert>, signature: [u8; 64] }
  by account_key (or the device) over derive("Saltix mailbox ack v1", Borsh(the fields above))
```

The ack goes to the sender like a message, and with the proof the message also leaves the acknowledging address's own
mailbox; `at` must be within 10 minutes of the replica's clock, and a proof that does not check gets `bad_proof`. No
relay deletes mail on an unsigned word. One device's ack clears the frame for every device of the address. Ack a
request only once its answer is sent, so a request a server failed to answer comes back (`signMailboxAck`).

**Mailboxes** keep, per address, up to 500 frames and 1 MiB for 7 days.

## Presence: status

```text
status {pubkeys}   (up to 100) → status {statuses: {address: online}}
```

"Online" means one of the address's devices has a live connection that is not invisible. Saltix asks it, over its
grain aliases' connection, to tell whether a chat-only app's program runs ([app studio §4](app-studio.md#4-in-saltix-my-apps)):
a server that stays registered counts as online. 2 a second per connection, burst 4.

## Files next to the relay

Messages carry files by reference. The sender encrypts a file under a fresh key, uploads the ciphertext to the relay it
is connected to, and sends a reference naming that relay; the key travels only inside the sealed message.

```text
file_new {size, ref?}  → file_slot {id, ref?}  | error {message: "file_refused", detail, ref?, lane?}
  size: the ciphertext's bytes, 1 to 50 MiB + 16;  ref: the client's tag, at most 64 bytes, given back
  id:   16 random bytes, base64url without padding (22 characters)
  detail: too_large | too_many (4 uploads in progress) | quota (100 MiB a UTC day on the free lane) | full (the node's
          room, or on the free lane its store half full) | unavailable
```

Over HTTPS on the relay's client port, with the WebSocket's certificate:

| Request | Answer |
|---|---|
| `PUT /_file/<id>`, header `X-Offset: n`, at most 1 MiB of ciphertext | `200 {received}`; `409 {received}` when `n` is not the bytes received so far; `413` past the reserved size; `507` no room now (try again later) |
| `GET /_file/<id>/status` | `200 {size, received, done}` |
| `POST /_file/<id>/done` | `200 {size}` once every byte arrived, else `409 {received}` |
| `GET /_file/<id>`, optionally `Range: bytes=n-` | `200` or `206` with the ciphertext, for 30 days once done; `404`: unknown, unfinished or expired, gone for good; `416` |
| `GET /_file/<id>?at=<url>&pin=<cert_sha256>` | the same, fetched by this relay from another relay's endpoint that its relay list publishes with exactly that URL and fingerprint (for a client that cannot pin, such as a browser); `403` for any other |

A reservation that gets no byte within 10 minutes is dropped; an upload silent for 24 hours is dropped. A client IP has
at most 8 file requests at once (`429` past them). Whoever holds an id can download: it is a 128-bit capability, and
the content is ciphertext.

**The reference** a message carries:

```text
FileRef {
  relay: Option<String>   the endpoint: "wss://host[:port]/…" and "#<cert_sha256 in lowercase hex>" when it pins a
                          certificate; none: the reader's own relay (a server always names its relay)
  id:    String           the file's id (22 characters)
  key:   [u8; 32]         AES-256-GCM key, fresh per file
  iv:    [u8; 12]         its nonce
  hash:  [u8; 32]         SHA-256 of the plaintext
  size:  u64              the plaintext's bytes, at most 50 MiB
  name:  String           at most 255 bytes, no control characters, no "/" or "\"
  mime:  String           a media type, at most 127 bytes
}
```

- The ciphertext is AES-256-GCM of the plaintext under `key` and `iv`, the 16-byte tag at its end. A reader fetches
  `https://<host>:<port>/_file/<id>` from the endpoint, pinning `cert_sha256`, and checks the plaintext's SHA-256
  against `hash` before using it.
- **Borsh**: the struct above, inside signed structures (a chat's `File` block and `File` value).
- **JSON**, as a message of its own: `{"cmd": "file_ref", "id", "key", "iv", "hash", "size", "name", "mime", "relay"?}`,
  `key` and `iv` in standard base64 with padding, `hash` in hex (lower case written, either read).

The SDK: `sealFile`, `openFile`, `uploadFile`, `downloadFile`, `encodeFileRef`, `fileRefToJson`, `fileRefProblem`;
`chat.upload`.

## An app's numbers

```text
grain_stats {stats}     stats: base64url Borsh(SignedGrainStats), at most 256 bytes (grain-chats.md §4)
  → grain_stats_taken {slug, at}  |  grain_stats_refused {reason}
```

The relay hands them to its node, which checks them against the registry, keeps the newest of each grain and shares
them with the network, so any node answers `grain_stats`. Reasons: `malformed`, `unknown_grain`, `private` (only a public grain's
numbers are published), `key` (not a server key the registry names), `old` (more than 2 days before the node's clock),
`ahead` (more than 5 minutes after it), `inconsistent` (not `users_1d ≤ users_30d ≤ requests_30d`), `stale` (not at
least 10 minutes after the numbers the node keeps), `signature` (another network's genesis gives this too),
`rate_limited`. A server sends its newest numbers after each signing (at most hourly) and again whenever it registers,
while its grain is public. At most one a minute, burst 4, per connection; not billed.

## Link slots

A client with no identity yet (a Connect page, a browser being linked) meets a phone through a relay:

```text
link_open {sid}                        sid: 32 random bytes, base64url; allowed before registering
  → link_opened {sid, relay}           the relay's node key, for the offer
link_payload {sid, payload}            what a phone delivered to the slot
link_deliver {relay, sid, payload}     (the phone's side) payload at most 8 KiB → link_delivered {sid, delivered}
```

A slot belongs to the connection that opened it (`sid_taken` for any other) and goes when it closes; it lives up to 5
minutes idle and 30 minutes in all, and `link_open` with the same `sid` again keeps it from going idle. Deliveries never
consume the slot, and a client ignores payloads it cannot open, so junk from someone who saw the QR code crowds nothing
out. Limits: 20 `link_open` and 40 `link_deliver` a minute per connection, 4 open slots per connection (`busy` past
them). A Connect page's payload is sealed as [connect §5](connect.md#5-the-login) says.

## Paying for relays: lanes and sponsors

A relay never asks which app a client is, only how its use is paid for:

| Lane | Who | What it gets |
|---|---|---|
| **Free** | any address | a fair share of the relay's free budget (20% of its forwarding, by bytes), split over IPv4 /24 and IPv6 /48 prefixes active in the last minute; an account that staked at least 1 SALT for access gets a weighted bucket of its own; files 100 MiB a day per address while the relay's store is at most half full |
| **Paid** | an address that presents an allowance from its payer's exchange | the relay's full service at its prices (`hello.prices`) |
| **Sponsored** | a key a sponsor certified | as paid, within the sponsor's caps |

Past the free share a forwarded frame gets `error {message: "payment_required", detail: "frames", lane: "free"}` and is
not forwarded: wait, or pay. A grain's server's frames use the free share (the SDK's `RelayClient` today). A grain's
users' frames go on the sponsor's lane when the manifest names a sponsor ([grains §5.4](grains.md#54-relays-real-time-between-users)),
and on the free share otherwise: never on the user's own channel.

**Channels.** A payer (a person, an app's backend) keeps WORK in a channel with one city's exchange, part of its account:
`OpenChannel {exchange, amount}`, `TopUpChannel`, `CloseChannel` (the deposit returns 3 days later); at most 2 channels,
with different exchanges ([basics](basics.md#transactions-an-apps-tools-sign)). `exchange_list` names the exchanges.
The SDK: `grain sponsor init`, `grain sponsor`, `grain sponsor open --exchange <city> --amount <WORK>`.

### Sponsor certificates

A payer authorizes another key to spend from its channels, here an app's users:

```text
SponsorCert {
  sponsor:  DeviceKey   who signs: Ed25519(the payer's key), the payer being its personal account; or a managed
                        payer's device
  user_key: [u8; 32]    the key it authorizes: for a grain, the user's grain key
  per_day:  u64         µWORK this key may spend a day (the exchange enforces it)
  services: u8          a bit set: 1 messages, 2 TURN, 4 files, 8 mailbox beyond the free (the relay enforces it)
  issued:   u64         slot
  expires:  u64         slot; issued < expires ≤ issued + MAX_GRANT_LIFE (2 592 000 slots, 30 days)
}
SignedSponsorCert { cert, signature: [u8; 64] }
  by sponsor over derive("Saltix sponsor certificate v1", genesis_hash ‖ Borsh(cert)): Ed25519, or P-256 with a low s
```

A grain's server issues one at login for the grain key `grain_login` returned, with `sponsor` the key whose personal
account is the manifest's `sponsor`, and the page passes it to `grain_relay_open {grant}`. The SDK: `grantFor`
(it reads the current slot from the node), `issueSponsorCert`, `sponsorCertProblem`; `vectors/access-v1.json` (`grant`,
`phone_grant`).

### Allowances: what the wallet does with a grant

The wallet asks, over its relay, the sponsor's exchange for an **allowance**: at most 5 WORK, for one relay, living at
most a day, signed by the exchange's operator key, whose `client_key` is the grain key (`allowance_request {request}` →
`allowance {allowance, nonce}` or `allowance_refused {reason, nonce}`; refusals such as `no_channel`, `closing`,
`not_authorized`, `over_daily`, `insufficient`). It pays the relay for the alias with it (`pay {allowance, grant, as}`)
and signs running totals (`voucher`) as frames go; the relay claims them from the sponsor's channel. Nothing of this is
the app's to do: the sponsor keeps WORK in its channel, and the certificate caps what each user may spend.

## Limits and errors

| What | Limit |
|---|---|
| Frames per connection | 30 a second, burst 120; a connection over it more than 20 times is closed |
| Connections per IP | 32 |
| A frame | 256 KiB; a message's `payload` 64 KiB |
| `msgId` | 1–128 bytes for a kept message |
| A mailbox | 500 frames and 1 MiB per address, 7 days |
| `status` | 2 a second, burst 4; 100 addresses each |
| An address record or ack proof | 2 048 bytes encoded |
| Files | 50 MiB + 16 bytes each; 4 uploads in progress; 100 MiB a day free; 8 requests at once per IP |
| `grain_stats` | one a minute, burst 4 |

Errors are `error {message, detail?}`: `auth_failed` (`detail: "access"` with `access: <reason>` on a gated network),
`access_ended` (the connection's access ended: the relay closes it), `not_registered`, `already_registered`, `too_many_aliases`,
`bad_frame`, `frame_too_large`, `payload_too_large`, `bad_address` (`to` is not of this network), `bad_proof`,
`rate_limited` (`detail` names what was refused), `file_refused`, `payment_required`, `too_many_connections`, `busy`,
`sid_taken`, `unsupported` (an unknown frame type, `detail` naming it). A frame refused for the rate is not served and
not billed.

## The wallet interface at a relay

Every relay also serves the wallet interface at `POST /rpc` on its client port, over the same pinned TLS: that is how
the SDK reaches the network without a node of its own ([wallet interface](wallet-interface.md)). Where the relay's node
runs a gate, `transaction_submit` and `faucet_request` there need the header `X-Saltix-Access` with an access token for
that relay's node key (`relay_list`'s `key`); without a valid one the answer is HTTP 401 with the JSON-RPC error
`-32001`, message `"access"`, `data: {access: <reason>}`. Reads stay open. `RelayGateways.useAccess` gives the
credential: a write refused for want of one goes again with a token ([the gate §5](gate.md#5-at-the-relays-and-the-wallet-interface)).
