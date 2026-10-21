# The gate: access on a test network

> Reflects Saltix 37-gate §1–§5 and §7 (approved 2026-10-20), with what it added to 09-relay §3 and §10.7, 08-node §6,
> 12-grains §5.5 and 24-app-studio §3a, as of corvise/saltix `9ff53fd8` (2026-10-21). Only what an app's server and its
> tools meet. Section numbers are the specification's.

A test network may be closed to people without an access code. Its website and downloads stay open; what is closed is
the **service**: the relays' connections and the writes of the wallet interface at a relay. A person enters a one-time
code; the network's **gate** checks it once and answers with an **access grant**, a statement it signs that one key may
use the network until a moment. The relays check the grant. The main network runs no gate.

**An app's server under its paired key needs nothing**: a relay lets in a record self-signed by a registered server
key of a live grain without a grant (12-grains [§5.5](grains.md#55-notifications)). What needs one is a key the
registry does not name yet: the computer running `grain pair` (24-app-studio
[§3a](app-studio.md#3a-pairing-a-server-by-qr-code)), a certified key, and the tools' writes through the relays
(`grain faucet`, a key file's transaction).

The SDK: `access.ts` (the formats, `AccessKey`, `accessToken`, `checkAccessToken`), `gate.ts` (`redeemComputerAccess`
and the gate's refusals), `RelayClient`'s `access` option, `RelayGateways.useAccess`, and `grain pair`'s code
(`--access-code`, `SALTIX_ACCESS_CODE`). The vectors: `vectors/gate-v1.json`.

## 1. Keys

- **The gate key**: Ed25519, held by the gate. A relay trusts the gates its node names; a network may trust several at
  once, so a gate's key can change without a gap. `hello.access` and `node_status.access` name them.
- **The access key**: P-256. A phone keeps its own in its secure hardware; a computer keeps one in the project
  (`.grain/access.key`, owner-only). It signs ECDSA over SHA-256 of a 32-byte message, `r ‖ s` with a low `s`
  ([Basics](basics.md#signatures-and-keys)).

## 2. The grant

```text
AccessGrant {
  version:     u8          1
  network:     [u8; 32]    the genesis hash: a grant opens one network
  key:         [u8; 33]    the access key, P-256, SEC1-compressed
  attestation: u8          0 none (a computer, or a phone that could not attest), 1 TEE, 2 StrongBox
  boot:        u8          the attested boot state: 0 verified, 1 self-signed, 2 unverified, 3 failed; 255 none
  code:        [u8; 4]     the code's id: the first 4 bytes of SHA-256 of the code's canonical form
  issued_at:   u64         Unix ms
  not_after:   u64         Unix ms: the access ends here
}
SignedAccessGrant { grant: AccessGrant, signature: [u8; 64] }
  signature: Ed25519 by the gate key over derive("Saltix access grant v1", Borsh(grant))
```

A relay takes a grant when `version` is 1, `network` is its genesis hash, the signature verifies under a gate it trusts,
`issued_at ≤ now + 10 min`, `issued_at < not_after`, `now < not_after`, `key` is a valid point, `attestation ≤ 2`, and
the grant lives at most 400 days, or at most **24 hours when `attestation` is 0**.

## 3. What a client presents

```text
Access = 0 Own { grant: SignedAccessGrant }               a computer, or Saltix on a phone
       | 1 Delegated { delegation: AccessDelegation }     a browser a phone linked (never a server)

AccessToken {
  access: Access
  relay:  [u8; 32]       the node key of the relay it is shown to (the hello's `relay`; `relay_list`'s `key`)
  at:     u64            Unix ms
  proof:  [u8; 64]       Own: by the grant's access key over derive("Saltix access proof v1", Borsh(access, relay, at))
}
```

The token proves that whoever shows the grant holds its key, now and to this relay: a token seen by one relay opens no
other, and a copied grant without its key opens nothing. A relay takes it within 10 minutes of its clock, so a client
signs one per relay (the SDK signs one per registration, at the hello's `sts`: the relay's own moment). A token is at
most 1 KiB, nothing trailing. The relay checks what costs nothing first (its key, the time, the grant's terms), then the
gate's signature and the proof; `checkAccessToken` decides as it does, in its order.

## 4. The gate

### 4.1. Codes

A code is 10 Crockford base32 characters, shown `XXXXX-XXXXX`, minted by the network's operator (in Saltix Pass, with
the operator's bot or its command line) for an access length: a minute, 10 or 30 minutes, an hour, a day, 3 or 7 days,
a month, 6 months or a year. It is entered within 7 days of being minted and opens one grant, once. Its canonical form
is the 10 characters in upper case (no I, L, O or U), and its id the first 4 bytes of SHA-256 of that. Guesses are
limited per client address, with a lockout after repeated misses.

### 4.3. A computer: an unattested grant

A computer cannot attest its key, so it asks for an **unattested grant**: the gate gives at most 24 hours of the code's
access length, with `attestation` 0, and the code is spent. The relays take it like any grant within that shorter life.

### 4.5. The reference gate's interface

Saltix's test network's gate is `https://api.saltix.io` (another network's may differ: the SDK takes `SALTIX_GATE`).
JSON; binary values base64url without padding, the network in hex, times Unix ms.

- `POST /v1/access/challenge` `{}` → `{challenge, expires_at}`: 32 random bytes, valid 10 minutes, spent by the first
  redemption that names it.
- `POST /v1/access/redeem` `{code, network, challenge, key, proof, unattested: "computer"}`: `key` the 33-byte access
  key, `proof` its signature over `derive("Saltix access redeem v1", challenge ‖ network ‖ key)`. A phone sends its
  key's certificate `chain` instead of `unattested`. → `{grant, issued_at, not_after, access, attestation, boot,
  code_id}`: `grant` base64url of Borsh `SignedAccessGrant`, `access` the code's length as minted (`10m`, `1d`…).
- Refusals are `{error, detail?, retry_after?}`: `400 malformed` (`detail` the field), `400 network` (a network the gate
  does not serve), `400 challenge` (unknown, ended or spent), `401 rejected` (unknown, used, revoked or lapsed: one
  answer for all), `403 attestation`, `403 unattested_off` (no grants without a phone's attestation now), `429
  rate_limited` and `429 locked` with `retry_after` seconds, `503 unavailable`, `500 storage`. The code stays unspent
  but on a grant; the challenge is spent by any answer but `rate_limited` and `locked`.

The SDK checks a grant before it keeps it: for its key and the network, signed by a gate the network's relays trust,
not ended. Each refusal is said in plain words (`GATE_WORDS`), and a spent challenge is asked again once.

## 5. At the relays and the wallet interface

- **`hello`** carries `access: {gates: [base64url key, …]}` where the relay's node runs a gate. Without it, the relay
  requires nothing.
- **`register`** (a plain or a managed record) carries `access`: base64url of Borsh `AccessToken`. Without a valid one
  the answer is `error {message: "auth_failed", detail: "access", access: <reason>}`, the reason one of `required`,
  `malformed`, `relay`, `time`, `network`, `gate` (no trusted gate signed it), `expired`, `lifetime`, `delegation`,
  `proof` (`ACCESS_REASONS`). The connection's later aliases need nothing more.
- **When the access ends** the relay sends `error {message: "access_ended"}` and closes the connection.
- **Exempt**: a record self-signed by a registered server key of a live grain, and a guest's connection. So a paired
  server shows nothing, and `RelayClient` shows a grant only where it was given one and the hello names `access`.
- **The wallet interface at the relay** ([relays](relays.md#the-wallet-interface-at-a-relay)): `transaction_submit` and
  `faucet_request` need the header `X-Saltix-Access` with a token as in `register` (for that relay's node key); without
  a valid one the answer is HTTP 401 with the JSON-RPC error `-32001`, message `"access"`, `data: {access: <reason>}`.
  Reads stay open.
- **`node_status`** says `access: {gates: [hex key, …]}`, or `null` where the node requires none: what `grain pair`
  and `grain status` read to know whether a code is needed.

## 7. Parameters

| Name | Value |
|---|---|
| `GRANT_MAX` | 400 days |
| `UNATTESTED_MAX` | 24 hours (a computer's grant) |
| `ACCESS_SKEW` | 10 minutes (a token's `at`, a grant's `issued_at`) |
| `MAX_ACCESS_TOKEN` | 1 024 bytes |
| Challenge life | 10 minutes |
