# Changelog

## [Unreleased]

### Added

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
