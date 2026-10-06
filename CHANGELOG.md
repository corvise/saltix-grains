# Changelog

## [Unreleased]

### Changed

- Transaction v3 (Salarium 03-ledger §3, 13-accounts §6.1): `encodeTx`, `signTx` and every transaction built on them
  (grains' registry calls, a sponsor's channel) carry the sender's tag and the proof's, and their id is
  `"Salarium transaction v3"`; fees count the extra byte. Vectors synced from Salarium 602995e. Every package's tests
  exit when one fails instead of waiting on an open server.

### Added

- Sealed grains (Salarium 12-grains §8): `grain bundle` makes a deterministic ZIP of `public/` (at most 20 MiB) and
  names its hash, size, sources, start and connect origins in `grain.json`; `grain dev` makes and serves the bundle of a
  sealed grain for a debug wallet. `manifestProblem(m, dev)` takes developer origins as a sealed grain's sources.

- A grain's sponsor (Salarium 11-access §4, 12-grains §5.4):
  - `@salarium/grain`: `relay.open({ grant })`;
  - `@salarium/grain-server`: `issueSponsorCert`, `decodeSponsorCert`, `sponsorCertProblem`, `grantFor` (a grant at login
    from the node's slot), `signChannelTx` (open, top up, close the sponsor's channel), byte for byte
    `vectors/access-v1.json`; the transaction envelope shared by registry and channel calls (`signTx`);
  - `grain sponsor init | show | open | top-up | close`: the sponsor key and its channel, refused before a node would.

- Relays for grains and notifications (Salarium 12-grains §5.4–5.5, stage 3 on the free lane):
  - `@salarium/grain`: `relay.open/send/close/onFrame` (frames of at most `MAX_RELAY_PAYLOAD` = 48 000 bytes),
    the `relay` event, `notifications.allow`;
  - `@salarium/grain-server`: relay records (`signKeyBinding`, `signAddressRecord`, `recordProblem`,
    `messagingKeyOf`, `signMailboxAck`) byte for byte `vectors/relay-v1.json`; `sealFrame`/`openFrame`
    (`crypto_box`, tweetnacl); `signNotification`, `decodeNotification`, `notificationProblem` byte for byte
    `vectors/grains-v1.json`; `RelayClient`, a server's connection to the relays (`ws`): registers under its key,
    pins self-signed relays by the hash in their record, seals to checked keys, acks its mailbox, reconnects;
  - the simulator answers the relay and notification methods, plays a frame arriving, and checks a server's
    notification as a wallet does.
- Vectors synced with Salarium b1d399c (`relay-v1.json` added; grain messaging keys and notifications).

- `grain publish` in the owner's wallet (Salarium 12-grains §10): without a key file it shows a QR code of
  `salt:grain-publish?m=…` (the manifest's Borsh, `owner_key` zeroed, raw DEFLATE, base64url), waits for the
  registry to hold the grain as the wallet published it, and writes `signed.json`; `grain show --out`. Checked
  end to end with a debug Saltix on a local devnet. `sameManifest` in the server SDK.
- `@salarium/grain-cli` 0.1.0, the `grain` command line (Salarium 12-grains §10): `init` (a project with an
  owner-only key and the bridge), `dev` (public/ and the manifest signed for the asking developer origin),
  `lint` (bounds, developer origins, the size a transaction allows), `icon`, `sign`, `publish` (register or
  update through a node, deposit and balance checked first), `retire`, `show`. Checked against a local devnet:
  registered, updated and retired a grain end to end.
- `@salarium/grain-server`: `encodeGrainTx`, `signGrainTx`, `minimumFee`, `grainGet` — the owner's registry
  transactions, byte for byte `vectors/grains-v1.json`.
- `slugLink(slug, start?)`: the link that opens a registered grain, `salt:grain/<slug>`; `GrainInfo.listing`
  may be `listed` (in the network's registry, not on the wallet's verified list; Salarium 12-grains §9).
  Vectors synced with Salarium's registry transactions.
- `@salarium/grain` 0.1.0: the page's side of the bridge, version 1 (12-grains §5): info, ready,
  close, expand, setHeader, haptic, copy, share, openLink, scanQr, login, requestAddress,
  pickContact, pay, storage, events; `inWallet()`, `walletLink()`; the simulator transport.
- `@salarium/grain-server` 0.1.0: sign-in checks, invoices and invoice keys, payments found on
  chain, manifests (Borsh, id, signature, JSON form, developer origins), Address v1, reproducing
  `vectors/grains-v1.json` and `vectors/crypto-v1.json`.
- The simulator and `examples/hello-grain` with `npm run dev`.
