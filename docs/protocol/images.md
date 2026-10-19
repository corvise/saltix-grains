# Images: icons, named blobs and bundles in the network

> Reflects Saltix 32-images (basis for implementation, 2026-10-19: named blobs, the image and bundle checks, the
> mini-app icon standard, sealed bundles hosted by the network), as of corvise/saltix `b9019fdf` (2026-10-19). Section
> numbers are the specification's.

Bytes that something signed or on chain names by hash are **named blobs**, and the network keeps them while that
reference stands: a mini-app's icon (named by its manifest), a person's avatar (named by their profile), and a sealed
mini-app's bundle (named by its manifest, or for a day before it by a registered server key's statement). Every node and
wallet checks a blob's structure before it keeps, passes on, decodes or unpacks it. For an app this means two things: its
icon follows one standard (§3), and its page needs no hosting: the developer's computer puts the bundle straight into the
network (§7.3). The SDK: `named.ts` (the checks), `bundle-upload.ts` (the statement), `blobs.ts` (`putBundle`,
`putIcon`, `getBlob`), `grain icon` and `grain publish` ([docs/icons.md](../icons.md)). The vectors:
`vectors/images-v1.json`.

## 1. Overview

| | Mini-app icon | Avatar | Mini-app bundle |
|---|---|---|---|
| Kind (tag, name) | 0 `grain_icon` | 1 `avatar` | 3 `grain_bundle` (2 is reserved) |
| Named by | a live grain's manifest `icon` | the newest profile of an account | a live grain's sealed manifest (`bundle`, `size`); for a day before, a registered server key's statement (§7.3) |
| Hash | `derive("Saltix grain icon v1", bytes)` | `derive("Saltix avatar v1", bytes)` | `derive("Saltix grain bundle v1", bytes)` ([grains §8](grains.md#8-sealed-bundles)) |
| Format | PNG, opaque | JPEG | ZIP, the bundle check (§2a) |
| Pixels | 512 × 512 (256 × 256 taken from manifests made before) | 640 × 640 | — |
| Bytes | at most 65 536 | at most 131 072 | at most 16 MiB |
| Kept by | every full node | the 5 relays that keep the account's vault | 3 storage cities and 5 relays offering space, its keepers |
| Uploaded | `blob_put` once the registry names it (§7.1) | with the profile (wallets') | `blob_put` in pieces, before or after the manifest (§7.3) |
| Fetched | `blob_get`, `GET /_blob/grain_icon/<hash>` | `blob_get`, `GET /_blob/avatar/<hash>` | `GET /_blob/grain_bundle/<hash>` with `Range`, `blob_get` a piece at a time |

## 2. The image check

One function, run by every node and every wallet on a small image before it keeps, passes on or decodes it. It reads
the structure and never decodes a pixel; it guarantees what a decoder needs to stay bounded and what makes every wallet
draw the same picture.

- **Both formats.** 1 byte to the kind's maximum; the kind's format; nothing before its signature or after its end.
- **PNG** (an icon): the signature `89 50 4E 47 0D 0A 1A 0A`; then chunks `length` (u32 BE, at most 2³¹ − 1) ‖ `type`
  (4 ASCII letters) ‖ `data` ‖ `crc` (the CRC-32 of ISO 3309 over `type ‖ data`, which must hold), covering the rest
  exactly. The first chunk is `IHDR` of 13 bytes: width and height equal and one of the kind's sides, bit depth 8, colour
  type 2 (true colour) or 3 (palette), compression, filter and interlace 0. Only `IHDR`, `PLTE`, `sRGB`, `pHYs`, `IDAT`
  and `IEND` appear: `IHDR`, `PLTE`, `sRGB` and `pHYs` at most once; `PLTE` exactly when the colour type is 3, before the
  first `IDAT`, 3–768 bytes in threes; `sRGB` (one byte, 0–3) and `pHYs` (9 bytes) before the first `IDAT`; the `IDAT`s
  consecutive, at least one; `IEND` last and empty. So an icon is opaque by its structure (no colour types 4 or 6, no
  `tRNS`), has no profile (`iCCP`), gamma or chromaticities, no text, no `eXIf`, no animation (`acTL`, `fcTL`, `fdAT`)
  and no private chunk. Its colours are sRGB.
- **JPEG** (an avatar, the wallets'): `FF D8`; a JFIF `APP0` at most, first; `DQT`, `DHT`, `DRI`; one baseline or
  progressive frame of 8 bits, 1 or 3 components, 640 × 640; scans; `FF D9` the last two bytes. No `APP1`–`APP15`, no
  comment.
- **Reasons**, which `blob_put` answers and the vectors name: `size`, `format`, `dimensions`, `depth`, `alpha`,
  `metadata`, `animation`.

A wallet takes bytes from nodes it does not trust: it checks the hash against the reference, then the image check, then
decodes in isolation with the platform's decoder, and draws the monogram (§3.5) for anything that fails.

## 2a. The bundle check

A sealed mini-app's bundle is kept by the network only when every wallet unpacks it the same way, read by its end record
and directory without inflating a byte:

1. 1 byte to 16 MiB (a wallet checks one from a source up to 12-grains' 20 MiB the same way).
2. **The end record** (`PK 05 06`) is the last 22 bytes: one disk, as many entries on it as in all, **no comment**, and
   the central directory's offset plus its size is the end record's own offset. No ZIP64.
3. **The central directory**: 1 to 8 192 entries covering it exactly, none with ZIP64's all-ones sizes or offset.
4. **Each entry** stored (method 0, its two sizes equal) or deflated (8), not encrypted: else `method`. Its name is
   `/`-separated parts of `[A-Za-z0-9._ ~@+-]`, none empty, `.` or `..`, at most 1 024 bytes; a folder is a name ending in
   `/` with nothing in it; every name once, and no file where another's folder is: else `name`.
5. 1 to 4 096 files (`files`), declaring at most 64 MiB unpacked in all (`unpacked`).
6. **The local records** lie back to back from the first byte to the directory, in its order, each at its entry's offset
   with its entry's flags, method and name, and its CRC and sizes unless flag 0x0008 puts a data descriptor after the data.

Anything else is `format`; empty or larger is `size`. `grain bundle` (and `grain publish`, which bundles first) writes
exactly this form: names sorted, every file stored as it is, no times and no extra fields, so the same files make the same
bytes on any computer.

## 3. The mini-app icon standard

### 3.1 The master

512 × 512, PNG of 8 bits, true colour or a palette, at most 65 536 bytes, sRGB with no profile and no gamma, **full bleed
and opaque** (the background fills the square, corners included; no transparency, rounded corners, border or shadow:
the wallet cuts the shape), the mark inside the keyline circle, no text but a mark that is a word, no motion. The
manifest's `icon` is the master's hash; **thirty-two zero bytes mean no icon**, and the wallet draws the monogram.

### 3.2 The mask

Wallets draw every icon through one mask: a rounded square with the side of the drawn icon and **corners of 0.26 of the
side** (circular arcs tangent to the sides), at 24 dp (mentions, notifications), 40 dp (rows), 56 dp (tiles, the Connect
sheet) and 96 dp (the preloader, the Publish review). The master's 512 pixels span the mask's side.

### 3.3 Zones

In fractions of the side `s`, from the centre: **the keyline circle** of radius 5/12 s (the mark, whole, inside it);
**the ground** between it and the mask (background only); **the edge band**, the outer 1/16 s of each side, where the
lit edge (§4) runs. The mask's edge is 1/12 s or more from the circle all round.

### 3.4 What tools check

`grain icon <png>` prints the hash a manifest names the icon by after these checks; `grain icon --fix <in> <out>` (or
`grain icon <in> --out <out>`) writes a master that passes them from any PNG or JPEG. `grain lint` runs them on the
project's `icon.png` and compares its hash with the manifest's.

- **Errors**: the image check fails; the hash differs from the manifest's `icon`.
- **Warnings**: 256 × 256; the mark outside the keyline circle (more than 2 % of the pixels between the keyline circle and
  the edge band differ from the background, the median colour of the four corners' 16 × 16 squares, by more than 24 in
  any channel); the mark small (the box of the pixels that differ from the background narrower and shorter than half the
  side); a background of one colour equal to the wallet's own (pure white, pure black).

### 3.5 The monogram

Until a wallet has an icon's bytes, and whenever the icon is none, missing or fails, it draws the **monogram** in the
same mask: the first character of the grain's name in the reader's language (else its English name), upper-cased,
centred on a colour of the wallet's palette of 12 chosen by the first byte of `derive("Saltix grain monogram v1", slug)`
modulo 12. It is the same on every device and changes only with the slug.

## 4. Light on the icon's edge

Wallets show progress on an app's icon as light running along the inner edge of its rounded square (never a ring, a
spinner or a veil over it): an app being made or published, a sealed bundle downloading, and an app opening. **The
preloader**: from the tap the icon grows into the centre over the app's last colour (its `grain.setHeader` or
`theme-color`, else the icon's corners'), the name under it, the light running round it; it ends when the page is ready.
A page that has called `grain_ready` once is waited for until it calls it again (15 s at most); any other until its
`load` event. The SDK's templates call `grain.ready()` once their first screen is drawn.

## 6. Named blobs

A node keeps a blob only while a reference names it (and an hour after): an icon or a bundle a live grain's manifest names
in the canonical registry, an avatar a kept profile names. **A blob nothing names is never taken**, with one bounded
exception: a bundle a registered server key says is its grain's next, held **pending** for a day (§7.3). The bytes prove
themselves (their hash is computed, never claimed), so whoever holds them may bring them, and nobody can bring others.

A bundle's keepers are 3 storage cities of different governors and the first 5 relays offering space, chosen by
rendezvous hashing (`derive("Saltix bundle placement v1", hash ‖ key)`); a young network with neither keeps every bundle
at every node with a store. Any relay caches what it fetched for its clients.

## 7. Uploading

### 7.1 Icons: after the registry names them

The bytes go up after the canonical registry holds the manifest that names them; there is no upload before. The publisher
(`grain publish`, Saltix's New app and Publish) waits until `grain_get` shows the new version, then calls `blob_put
{kind: "grain_icon", data}` (base64) at a node or a relay's gateway. The node checks the kind, the size, that its
registry names the hash (`not_named` otherwise), the image check and its room; it keeps the icon, answers `{kind, hash,
kept: true}` and passes it to every node. Anyone may call it: the hash is fixed by the manifest. 60 a minute per node,
besides the gateway's per-address limits (`rate_limited`).

### 7.3 Bundles: from the developer's machine into the network

```text
blob_put {kind: "grain_bundle", hash, size, from, data, upload?}
  hash    hex, derive("Saltix grain bundle v1", the bundle)
  size    the bundle's bytes, at most 16 MiB
  from    where this piece starts: the first 0, each next where the last ended
  data    the piece, at most 262 144 bytes, base64
  upload  hex of a SignedBundleUpload, for a bundle no manifest names yet
```

**Two ways up.**

1. **Before the owner signs**, with `upload`, a server key's statement that the bundle is the grain's:

   ```text
   BundleUpload       { slug: String, bundle: [u8; 32], size: u64, at: u64 }      at: Unix ms
   SignedBundleUpload { upload, key: [u8; 32], signature: [u8; 64] }
     signature: Ed25519 by key over
     derive("Saltix grain bundle upload v1", genesis_hash ‖ Borsh(BundleUpload))
   ```

   signed by a key the live grain's registry record names: the key `grain pair` made on the developer's computer, or a
   developer key's. The node checks it against its registry, cheap first: a live grain of `slug` whose record names `key`
   (`slug`, `key`), a `size` it keeps (`size`), `at` no more than 10 minutes ahead of its clock and its day not over
   (`time`), the signature (`signature`); then that the statement names the bundle's hash and size. It takes the pieces,
   checks the whole (the hash and §2a) and holds the bundle **pending** until `at` + 24 hours. The owner signs the
   manifest naming it on the phone whenever they like within that day; once a canonical manifest names it, it is kept as
   any named bundle. A statement no manifest follows lets the bundle go an hour after its day.
2. **After the registry names it**, without `upload`: anyone may upload it, the hash and the size being the manifest's.
   A grain with no server key yet (its first version) uploads its first bundle this way, after `RegisterGrain`.

**The pieces.** An upload lives at the node that took its first piece. Its first piece starts at 0 and each next one
where the last ended; a piece out of place is refused `offset` with `data.received`, where the upload stands at that node
(0 at a node that never saw it), and the tool goes on from there. Each piece but the last is answered `{kind, hash,
received, kept: false}`; the last takes the bundle whole, checked: `{kind, hash, received: size, kept: true, pending}`.
A piece of a bundle the node holds already ends the upload at once with `kept: true`. An upload quiet for 10 minutes is
dropped.

**Bounds**: at most 2 pending bundles of one slug and 2 of one key at a node (a newer one replaces the oldest) and
256 MiB of pending bundles in all (`pending`); 4 uploads at once, declaring 64 MiB in all (`busy`); an upload's first
piece counts against `blob_put`'s 60 a minute (`rate_limited`). Without a statement, a bundle no manifest names is
refused (`not_named`).

**Refusals** (`-32602`, `data.reason`): `kind`, `not_named`, `size`, the bundle check's (`format`, `method`, `files`,
`name`, `unpacked`), `hash` (the pieces are not the hash named), the statement's (`slug`, `key`, `time`, `signature`,
`size`, `hash`), `offset` (with `received`), `busy`, `pending`, `full`, `store`, `rate_limited`. The tool waits out `busy`
and `rate_limited`; the rest end the upload (`grain publish` says each in words, with what to do).

**Placing.** The node that took the bundle offers it to its keepers at once and every minute until 3 of them hold it,
for as long as it is pending (a day for a named one), and they pull it from that node. So the bytes go from the
developer's computer through one node of the network to the servers that keep them, and nowhere else. A pending bundle
is not secret: a node serves it to whoever knows its hash.

## 8. Fetching

- **`blob_get {kind, hash, from?, len?}`** at a node or a relay's gateway: `{blob, fetching}`, `blob` as `{kind, hash,
  type, size, from, data}` (`data` base64) when the node holds it, else `null`; an image whole, a bundle a piece of at
  most `len` bytes and 1 MiB from `from`. `fetching` is `true` when the node started to fetch it: ask again in about 2 s.
- **`GET /_blob/<kind>/<hash>`** on a relay's client port: `200` with the bytes, `Content-Type` `image/png`,
  `image/jpeg` or `application/zip`, `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<hash>"`,
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`; a bundle with `Range` (`206`, `416` past its
  end); `404` when the relay does not hold it, with `Retry-After: 2` when it started to fetch it.

**A sealed grain's bundle** is fetched by the wallet from its own relay first, over the relay's pinned TLS, waiting
`Retry-After` while the relay fetches it and resuming with `Range`; it turns to the manifest's `sources` only when its
relay answers `404` without `Retry-After`, or the network fails it for 30 s. Whichever way the bytes came, it checks the
size, the hash and the bundle check before it unpacks them.

## 10. What is a protocol change

One rule is consensus, in protocol version 2 (`NETWORK_BUNDLES`): **a sealed manifest may name no source**, the network
being its bundle's source, and such a manifest names a bundle of at most 16 MiB. Before version 2 a sealed manifest names
1–8 sources. Until a network runs version 2 the network still keeps every named bundle of at most 16 MiB and wallets ask
it first, so `grain publish` names, as the fallbacks the rule asks for, copies the network itself serves:
`https://<relay>/_blob/grain_bundle/<hash>` at up to 3 relays of the network's relay list (`relay_list`), those offering
space first. `node_status`'s `protocol.version` says which rule a network runs; the test network runs version 1.

Nothing else here is consensus: the manifest's `icon` and `bundle` are 12-grains' as before, and the statement, the
requests and the blob store are off chain.

## 12. Parameters

| Name | Value |
|---|---|
| A grain icon | PNG, 512 × 512 (256 × 256 taken), at most 65 536 bytes, opaque |
| An avatar | JPEG, 640 × 640, at most 131 072 bytes |
| A bundle the network keeps | ZIP (§2a), at most 16 MiB; 4 096 files and 64 MiB unpacked |
| The icon mask | a rounded square, corner radius 0.26 of the side |
| The keyline circle | 5/6 of the side across; the edge band 1/16 of the side |
| Pending bundles | 24 hours from the statement's `at` (at most 10 minutes ahead); 2 per slug and 2 per key at a node; 256 MiB in all |
| Uploads of bundles | pieces of at most 256 KiB; 4 at once and 64 MiB declared per node; dropped after 10 quiet minutes |
| `blob_put` | 60 a minute per node (an icon, or a bundle's first piece), besides the gateway's per-address limits; a request body at most 512 KiB |
