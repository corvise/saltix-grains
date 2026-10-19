# An app's icon

Saltix draws every mini-app's icon the same way, in every list, tile, sheet and preloader: one picture, cut by one
mask. This page is the standard as a developer meets it, and what `grain icon` does about it. The protocol's account is
[images § 3](protocol/images.md#3-the-mini-app-icon-standard) (Saltix 32-images §3).

```sh
npx grain icon logo.png --out icon.png     # any PNG or JPEG in; a 512 × 512 icon to the standard out
```

It prints the icon's hash first (the hash `grain.json`'s `"icon"` names, which it now names), then what it did and what
it checked, and writes a preview. `grain publish` puts the icon into the network once the registry holds the version that
names it; until then, and whenever an icon is missing, Saltix draws the app's **monogram** (its name's first letter on
a colour of Saltix's palette, the same on every phone).

## The master

| | Rule |
|---|---|
| Canvas | **512 × 512** pixels. 256 × 256, from manifests made before the standard, is still taken (with a warning) |
| Format | PNG, 8 bits a channel, true colour or a palette, not interlaced |
| Bytes | **at most 64 KiB** (65 536) |
| Colour | sRGB, with no colour profile and no gamma: browsers and Android apply those differently |
| Background | **Full bleed and opaque**: the background fills the whole square, its corners too. No transparency, no rounded corners, no border, no shadow: Saltix cuts the shape, and a baked-in shape shows as a frame inside it |
| The mark | inside the **keyline circle** (below) |
| Text | none but a mark that is a word; a letter at least a fifth of the side tall: the name is always drawn beside the icon |
| Motion | none: one picture |
| Metadata | none: no text, EXIF, time or profile chunks. The image check refuses them |

Every node and every wallet runs the **image check** on the bytes before it keeps or draws them: the PNG's structure
only (its signature, its chunks and their CRCs, IHDR's 512 or 256 square, 8 bits, colour type 2 or 3, no interlace;
only `IHDR`, `PLTE`, `sRGB`, `pHYs`, `IDAT`, `IEND`; nothing after `IEND`). An icon that fails it is never drawn, by any
wallet. `grain icon` writes only icons that pass it, and `grain icon icon.png` (or `grain lint`) checks one you made
yourself, naming the reason: `size`, `format`, `dimensions`, `depth`, `alpha`, `metadata` or `animation`.

## The mask and the zones

Saltix draws the master at the mask's full size through a **rounded square with corners of 0.26 of the side**, the
shape of its video notes, at 24 dp (mentions, notifications), 40 dp (lists), 56 dp (tiles, the Connect sheet) and
96 dp (the preloader, the Publish review). The zones, in fractions of the side:

- **The keyline circle**, 5/12 of the side from the centre (213 px of 512): the mark stays inside it, whole. A square
  mark is at most 0.59 of the side; a wide one within the circle too.
- **The ground**, between the circle and the mask: background only, nothing a person must see.
- **The edge band**, the outer 1/16 of each side (32 px of 512): Saltix runs the light of progress along it (an app
  opening, a bundle downloading, a publish), inside the mask's edge.

The mask never cuts into the keyline circle, so a mark inside it shows whole at every size, with the lit edge running
clear of it.

## `grain icon`

```text
grain icon <picture> --out icon.png [--fit crop|contain|mark] [--background #rrggbb] [--preview F]
grain icon <icon.png>
grain icon --fix <picture> <icon.png>
```

**Making one** (`--out`, or `--fix`) from any PNG or JPEG (a WebP, GIF, HEIC or SVG: export a PNG first, 1024 px or more
for a drawing):

1. **Decoded and made sRGB.** A colour profile is converted to sRGB (the matrix-and-curves profiles phones and design
   tools write: Display P3, Adobe RGB…), as is a PNG's own gamma; a JPEG is turned as its EXIF orientation says. The
   output has no profile and no metadata of the original: the place and time a phone wrote never leave your computer.
2. **Fitted** to the square, by `--fit`:
   - `mark` (the default for a picture with transparency, a logo): the picture's mark, its pixels that are not
     background, centred and scaled so its farthest pixel sits just inside the keyline circle;
   - `crop` (the default for an opaque picture): covers the square, the overflow cut, centred;
   - `contain`: the whole picture, the rest the background.
3. **Flattened** onto a background: `--background`, else the picture's corners' colour when they are opaque, else a
   light ground (`#f2f4f7`) for a dark mark or a dark one (`#101820`) for a light mark, never the wallet's own pure white
   or black, on which the icon's edge vanishes.
4. **Resampled** once, from the picture's own pixels, with a Lanczos filter; a picture upscaled by more than 1.5 times is
   said so (a larger one is sharper).
5. **Written** in true colour when that fits 64 KiB, else with a palette (median cut refined by k-means, dithered first,
   fewer colours until it fits). A picture too detailed for 64 KiB even in 16 colours is refused: simplify it.

Written to the project's `icon.png` (or `public/icon.png`), the icon is the one `grain.json` names from then on: raise
`"version"` if the app is published, then `grain publish`.

**Checking one** (`grain icon icon.png`, and `grain lint` for the project's icon file): the hash first, then the
image check and §3.4's warnings:

| Warning | When |
|---|---|
| 256 × 256 | taken by wallets, soft on large screens: make it 512 |
| the mark outside the keyline circle | more than 2 % of the ring between the keyline circle and the edge band differs from the background (the median colour of the four corners' 16 × 16 squares) by more than 24 in a channel |
| the mark small | the box of the pixels that differ from the background is narrower and shorter than half the side: it reads small at 24 dp |
| pure white, pure black | a background of one colour equal to the wallet's own on one theme |

and an error when the hash is not the one `grain.json` names.

**The preview** (`.grain/icon-preview.png` in a project, else beside the icon; `--preview F`): the icon in the mask at
24, 40, 56 and 96 dp (drawn at twice the size) on Saltix's dark and light themes, and the master at 256 px with its zones
over it (the keyline circle in pink, the edge band's inner edge dashed in blue, the mask's corners dimmed). Look at the
24 dp one: if the mark does not read there, it is too thin or too small.

## Into the network

The icon's bytes are a **named blob** (Saltix 32-images §6): every full node keeps the icon a live app's manifest names,
and wallets fetch it by its hash and check it before decoding. There is no upload before the registry names it:
`grain publish` waits until the registry holds the version, then sends the icon (`blob_put {kind: "grain_icon"}`) unless
the network holds it already. Run again, `grain publish` finishes an upload a break cut short; `grain doctor` says when
the registry names an icon the network does not hold. The rules of the upload are [images § 7.1](protocol/images.md#71-icons-after-the-registry-names-them).
