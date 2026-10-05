# Changelog

## [Unreleased]

### Added

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
