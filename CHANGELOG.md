# Changelog

## [Unreleased]

### Changed

- The protocol is Saltix (Saltix #165), and so are the SDKs: `@saltix/grain`, `@saltix/grain-server` and
  `@saltix/grain-cli` (called `@salarium/*` until 2026-10-12), in the repository corvise/saltix-grains. Every domain
  string the packages hash or sign under starts with `"Saltix "` (`"Saltix grain login v1"`,
  `"Saltix grain manifest v1"`, `"Saltix transaction v3"`, `"Saltix address v1"`, …); a hosted grain serves its
  manifest at `/.well-known/saltix-grain`; the page finds the wallet's provider at `window.saltix`, and the simulator's
  frame is `saltix-simulator`. Vectors synced from Saltix a4d1d83.
- A grain's manifest names its owner (Saltix 12-grains §2–3): `owner` (the account id) and `owner_key` (`{ ed25519 }`
  or `{ p256 }`, `DeviceKey`), which must speak for it; a managed account's phone signs with P-256 (`verifyByDeviceKey`:
  SHA-256, low s). `grain init` writes the key file's account and key; `lint`, `sign` and `publish --key` refuse a
  manifest that is not the key file's own; publish links zero both (`UNOWNED`). `invoiceProblem`,
  `notificationProblem` and `signerOf` take the owner key as a `DeviceKey`; the simulator takes either form. Vectors
  synced (a managed owner's manifest and a phone's server key certificate).
- A sponsor certificate's key carries its tag (Saltix 11-access §4.3: `sponsor` is a device key, so a managed
  account's phone can grant with P-256): `encodeSponsorCert` writes Ed25519's tag 0 before the key, `decodeSponsorCert`
  and `sponsorCertProblem` take only an Ed25519 sponsor, as a grain's server signs. Vectors synced from Saltix (with a
  phone's grant).
- Transaction v3 (Saltix 03-ledger §3, 13-accounts §6.1): `encodeTx`, `signTx` and every transaction built on them
  (grains' registry calls, a sponsor's channel) carry the sender's tag and the proof's, and their id is
  `"Saltix transaction v3"`; fees count the extra byte. Vectors synced from Saltix 602995e. Every package's tests
  exit when one fails instead of waiting on an open server.

### Added

- Sealed grains (Saltix 12-grains §8): `grain bundle` makes a deterministic ZIP of `public/` (at most 20 MiB) and
  names its hash, size, sources, start and connect origins in `grain.json`; `grain dev` makes and serves the bundle of a
  sealed grain for a debug wallet. `manifestProblem(m, dev)` takes developer origins as a sealed grain's sources.

- A grain's sponsor (Saltix 11-access §4, 12-grains §5.4):
  - `@saltix/grain`: `relay.open({ grant })`;
  - `@saltix/grain-server`: `issueSponsorCert`, `decodeSponsorCert`, `sponsorCertProblem`, `grantFor` (a grant at login
    from the node's slot), `signChannelTx` (open, top up, close the sponsor's channel), byte for byte
    `vectors/access-v1.json`; the transaction envelope shared by registry and channel calls (`signTx`);
  - `grain sponsor init | show | open | top-up | close`: the sponsor key and its channel, refused before a node would.

- Relays for grains and notifications (Saltix 12-grains §5.4–5.5, stage 3 on the free lane):
  - `@saltix/grain`: `relay.open/send/close/onFrame` (frames of at most `MAX_RELAY_PAYLOAD` = 48 000 bytes),
    the `relay` event, `notifications.allow`;
  - `@saltix/grain-server`: relay records (`signKeyBinding`, `signAddressRecord`, `recordProblem`,
    `messagingKeyOf`, `signMailboxAck`) byte for byte `vectors/relay-v1.json`; `sealFrame`/`openFrame`
    (`crypto_box`, tweetnacl); `signNotification`, `decodeNotification`, `notificationProblem` byte for byte
    `vectors/grains-v1.json`; `RelayClient`, a server's connection to the relays (`ws`): registers under its key,
    pins self-signed relays by the hash in their record, seals to checked keys, acks its mailbox, reconnects;
  - the simulator answers the relay and notification methods, plays a frame arriving, and checks a server's
    notification as a wallet does.
- Vectors synced with Saltix b1d399c (`relay-v1.json` added; grain messaging keys and notifications).

- `grain publish` in the owner's wallet (Saltix 12-grains §10): without a key file it shows a QR code of
  `salt:grain-publish?m=…` (the manifest's Borsh, `owner_key` zeroed, raw DEFLATE, base64url), waits for the
  registry to hold the grain as the wallet published it, and writes `signed.json`; `grain show --out`. Checked
  end to end with a debug Saltix on a local devnet. `sameManifest` in the server SDK.
- `@saltix/grain-cli` 0.1.0, the `grain` command line (Saltix 12-grains §10): `init` (a project with an
  owner-only key and the bridge), `dev` (public/ and the manifest signed for the asking developer origin),
  `lint` (bounds, developer origins, the size a transaction allows), `icon`, `sign`, `publish` (register or
  update through a node, deposit and balance checked first), `retire`, `show`. Checked against a local devnet:
  registered, updated and retired a grain end to end.
- `@saltix/grain-server`: `encodeGrainTx`, `signGrainTx`, `minimumFee`, `grainGet` — the owner's registry
  transactions, byte for byte `vectors/grains-v1.json`.
- `slugLink(slug, start?)`: the link that opens a registered grain, `salt:grain/<slug>`; `GrainInfo.listing`
  may be `listed` (in the network's registry, not on the wallet's verified list; Saltix 12-grains §9).
  Vectors synced with Saltix's registry transactions.
- `@saltix/grain` 0.1.0: the page's side of the bridge, version 1 (12-grains §5): info, ready,
  close, expand, setHeader, haptic, copy, share, openLink, scanQr, login, requestAddress,
  pickContact, pay, storage, events; `inWallet()`, `walletLink()`; the simulator transport.
- `@saltix/grain-server` 0.1.0: sign-in checks, invoices and invoice keys, payments found on
  chain, manifests (Borsh, id, signature, JSON form, developer origins), Address v1, reproducing
  `vectors/grains-v1.json` and `vectors/crypto-v1.json`.
- The simulator and `examples/hello-grain` with `npm run dev`.
