// Named blobs (Saltix 32-images §1–§2a, docs/protocol/images.md): bytes a manifest names by hash and the network keeps —
// a mini-app's icon, a person's avatar, a sealed mini-app's bundle — and the one check every node and wallet runs on
// them before it keeps, passes on, decodes or unpacks them. The check reads structure only: PNG chunks with their CRCs,
// JPEG segments, a ZIP's end record, directory and local records; it never decodes a pixel or inflates a byte. Byte for
// byte the protocol's `saltix_types::named::check` (`vectors/images-v1.json`).
//
// No Node APIs here.
import { derive, toHex } from "./bytes.js";

/** The kinds of named blob, by their name in JSON and URLs (`/_blob/<kind>/<hash>`): a mini-app's icon, a person's
 *  avatar, a token's logo (20-mint), a sealed mini-app's bundle. */
export type NamedKind = "grain_icon" | "avatar" | "token_logo" | "grain_bundle";
export type ImageKind = "grain_icon" | "avatar" | "token_logo";

/** The standard icon's side (32-images §3.1), and the side of icons manifests named before the standard. */
export const ICON_SIDE = 512;
export const LEGACY_ICON_SIDE = 256;
/** An icon's bytes at most. */
export const MAX_ICON_BYTES = 65_536;
/** An avatar's side and bytes at most (32-images §5.1). */
export const AVATAR_SIDE = 640;
export const MAX_AVATAR_BYTES = 131_072;
/** A token's logo: an opaque PNG of this side and at most these bytes (20-mint, 32-images §2). */
export const TOKEN_LOGO_SIDE = 256;
export const MAX_TOKEN_LOGO_BYTES = 12_288;
/** The largest bundle the network keeps (32-images §6.2): one a manifest with no source may name. Larger ones, up to
 *  `MAX_BUNDLE_BYTES` (12-grains' 20 MiB), come only from their sources. */
export const MAX_NETWORK_BUNDLE_BYTES = 16 * 1024 * 1024;
/** A bundle as any wallet takes it (12-grains §8): bytes, files, unpacked bytes, a name's bytes. */
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 4096;
export const MAX_BUNDLE_UNPACKED = 64 * 1024 * 1024;
export const MAX_BUNDLE_NAME_BYTES = 1024;
/** A bundle's piece on `blob_put` at most (32-images §7.3). */
export const BLOB_PIECE = 262_144;
/** Colours in the wallet's monogram palette (32-images §3.5). */
export const MONOGRAM_COLOURS = 12;

export interface KindInfo {
  tag: number;
  /** The domain its hash is derived in. */
  domain: string;
  maxBytes: number;
  /** Its media type, as `blob_get` and `GET /_blob/…` serve it. */
  type: string;
  /** An image's sides, the standard first. */
  sides: readonly number[];
}

export const NAMED_KINDS: Readonly<Record<NamedKind, KindInfo>> = {
  grain_icon: { tag: 0, domain: "Saltix grain icon v1", maxBytes: MAX_ICON_BYTES, type: "image/png", sides: [ICON_SIDE, LEGACY_ICON_SIDE] },
  avatar: { tag: 1, domain: "Saltix avatar v1", maxBytes: MAX_AVATAR_BYTES, type: "image/jpeg", sides: [AVATAR_SIDE] },
  token_logo: { tag: 2, domain: "Saltix token logo v1", maxBytes: MAX_TOKEN_LOGO_BYTES, type: "image/png", sides: [TOKEN_LOGO_SIDE] },
  grain_bundle: { tag: 3, domain: "Saltix grain bundle v1", maxBytes: MAX_NETWORK_BUNDLE_BYTES, type: "application/zip", sides: [] },
};

/** The hash a reference names a blob of `kind` by, hex. */
export const namedHash = (kind: NamedKind, bytes: Uint8Array): string => toHex(derive(NAMED_KINDS[kind].domain, bytes));

/** Why an image is refused (32-images §2): the word `blob_put` answers and the vectors use. */
export type ImageReason = "size" | "format" | "dimensions" | "depth" | "alpha" | "metadata" | "animation";
/** Why a bundle is refused (32-images §2a). */
export type BundleReason = "size" | "format" | "method" | "files" | "name" | "unpacked";

/** What a check found, or why it refused. */
export type Checked<T, R> = { ok: true; value: T } | { ok: false; reason: R };

const refuse = <R>(reason: R): { ok: false; reason: R } => ({ ok: false, reason });

/** What each reason means, in words for people. */
export const NAMED_REASONS: Readonly<Record<ImageReason | BundleReason, string>> = {
  size: "empty, or larger than the kind takes",
  format: "not the kind's format, or its structure breaks a rule",
  dimensions: "not the kind's dimensions",
  depth: "not 8 bits, or a colour type or component count the kind refuses",
  alpha: "an alpha channel or transparency in an opaque kind",
  metadata: "a colour profile, gamma, text, EXIF, a comment or another chunk or segment the kind refuses",
  animation: "an animation",
  method: "an entry neither stored nor deflated, or encrypted",
  files: "no file, or more than 4 096",
  name: "a name a wallet does not unpack, or a name twice",
  unpacked: "its files unpack to more than 64 MiB",
};

// --- CRC-32 (ISO 3309: PNG's and ZIP's) ---

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** The CRC-32 of ISO 3309 over `parts` in turn. */
export function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const part of parts) for (const b of part) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const be32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const le16 = (b: Uint8Array, at: number): number | null => (at + 2 <= b.length ? b[at]! | (b[at + 1]! << 8) : null);
const le32 = (b: Uint8Array, at: number): number | null =>
  at + 4 <= b.length ? (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0 : null;

// --- The image check ---

export interface ImageInfo {
  width: number;
  height: number;
}

/** The image check (32-images §2): whether `bytes` are an image of `kind`, read without decoding. */
export function checkImage(kind: ImageKind, bytes: Uint8Array): Checked<ImageInfo, ImageReason> {
  const info = NAMED_KINDS[kind];
  if (bytes.length === 0 || bytes.length > info.maxBytes) return refuse("size");
  return info.type === "image/png" ? checkPng(bytes, info.sides) : checkJpeg(bytes, info.sides);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ANIMATION_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);

/** A PNG of the opaque kind: true colour or a palette, 8 bits, not interlaced, square of one of `sides`; only IHDR,
 *  PLTE, sRGB, pHYs, IDAT and IEND, in their order, every CRC holding, nothing after IEND. */
function checkPng(bytes: Uint8Array, sides: readonly number[]): Checked<ImageInfo, ImageReason> {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return refuse("format");
  let at = 8;
  let info: ImageInfo | null = null;
  let paletteType = false;
  let seenPlte = false;
  let seenSrgb = false;
  let seenPhys = false;
  // 0: before the first IDAT, 1: in the IDATs, 2: after them.
  let idat = 0;
  let ended = false;
  while (at < bytes.length) {
    if (ended) return refuse("format");
    if (at + 8 > bytes.length) return refuse("format");
    const length = be32(bytes, at);
    if (length > 0x7fffffff) return refuse("format");
    const typeBytes = bytes.subarray(at + 4, at + 8);
    if (![...typeBytes].every((b) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a))) return refuse("format");
    const type = String.fromCharCode(...typeBytes);
    const start = at + 8;
    const end = start + length;
    if (end + 4 > bytes.length) return refuse("format");
    const data = bytes.subarray(start, end);
    if (be32(bytes, end) !== crc32(typeBytes, data)) return refuse("format");
    at = end + 4;
    if ((info === null) !== (type === "IHDR")) return refuse("format");
    if (idat === 1 && type !== "IDAT") idat = 2;
    switch (type) {
      case "IHDR": {
        if (data.length !== 13) return refuse("format");
        const width = be32(data, 0);
        const height = be32(data, 4);
        const [depth, colour, compression, filter, interlace] = [data[8]!, data[9]!, data[10]!, data[11]!, data[12]!];
        if (compression !== 0 || filter !== 0 || interlace !== 0) return refuse("format");
        if (colour === 4 || colour === 6) return refuse("alpha");
        if (depth !== 8 || (colour !== 2 && colour !== 3)) return refuse("depth");
        if (width !== height || !sides.includes(width)) return refuse("dimensions");
        paletteType = colour === 3;
        info = { width, height };
        break;
      }
      case "PLTE":
        if (!paletteType || seenPlte || idat !== 0 || data.length < 3 || data.length > 768 || data.length % 3 !== 0) return refuse("format");
        seenPlte = true;
        break;
      case "sRGB":
        if (seenSrgb || idat !== 0 || data.length !== 1 || data[0]! > 3) return refuse("format");
        seenSrgb = true;
        break;
      case "pHYs":
        if (seenPhys || idat !== 0 || data.length !== 9) return refuse("format");
        seenPhys = true;
        break;
      case "IDAT":
        if (idat === 2 || (paletteType && !seenPlte)) return refuse("format");
        idat = 1;
        break;
      case "IEND":
        if (data.length !== 0 || idat === 0) return refuse("format");
        ended = true;
        break;
      case "tRNS":
        return refuse("alpha");
      default:
        return refuse(ANIMATION_CHUNKS.has(type) ? "animation" : "metadata");
    }
  }
  if (!ended || info === null) return refuse("format");
  return { ok: true, value: info };
}

/** A JPEG of the kind: SOI; an optional JFIF APP0 first; DQT, DHT, DRI; one baseline or progressive frame of 8 bits
 *  and 1 or 3 components, square of one of `sides`; scans; EOI as the last two bytes. */
function checkJpeg(bytes: Uint8Array, sides: readonly number[]): Checked<ImageInfo, ImageReason> {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return refuse("format");
  let at = 2;
  let info: ImageInfo | null = null;
  let scans = 0;
  let first = true;
  const JFIF = [0x4a, 0x46, 0x49, 0x46, 0x00];
  for (;;) {
    if (at + 2 > bytes.length || bytes[at] !== 0xff) return refuse("format");
    const marker = bytes[at + 1]!;
    at += 2;
    if (marker === 0xd9) {
      if (at !== bytes.length || scans === 0 || info === null) return refuse("format");
      return { ok: true, value: info };
    }
    if (at + 2 > bytes.length) return refuse("format");
    const length = (bytes[at]! << 8) | bytes[at + 1]!;
    if (length < 2 || at + length > bytes.length) return refuse("format");
    const data = bytes.subarray(at + 2, at + length);
    at += length;
    const wasFirst = first;
    first = false;
    if (marker === 0xe0) {
      if (!wasFirst || data.length < 5 || JFIF.some((b, i) => data[i] !== b)) return refuse("metadata");
    } else if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) {
      return refuse("metadata");
    } else if (marker === 0xdb) {
      if (scans > 0) return refuse("format");
    } else if (marker === 0xc4 || marker === 0xdd) {
      // Huffman tables and restart intervals: anywhere.
    } else if (marker === 0xc0 || marker === 0xc2) {
      if (info !== null || scans > 0 || data.length < 6) return refuse("format");
      const height = (data[1]! << 8) | data[2]!;
      const width = (data[3]! << 8) | data[4]!;
      const components = data[5]!;
      if (data[0] !== 8 || (components !== 1 && components !== 3)) return refuse("depth");
      if (data.length !== 6 + 3 * components) return refuse("format");
      if (width !== height || !sides.includes(width)) return refuse("dimensions");
      info = { width, height };
    } else if (marker === 0xda) {
      if (info === null) return refuse("format");
      scans++;
      const next = scanEnd(bytes, at);
      if (next === null) return refuse("format");
      at = next;
    } else {
      return refuse("format");
    }
  }
}

/** Where a scan's entropy-coded data that starts at `at` ends: the first `FF xx` that is neither a stuffed `FF 00` nor
 *  a restart marker; null when the bytes end first or a fill byte (`FF FF`) stands there. */
function scanEnd(bytes: Uint8Array, at: number): number | null {
  for (;;) {
    const ff = bytes.indexOf(0xff, at);
    if (ff < 0 || ff + 1 >= bytes.length) return null;
    const next = bytes[ff + 1]!;
    if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) at = ff + 2;
    else if (next === 0xff) return null;
    else return ff;
  }
}

// --- The bundle check ---

export interface BundleInfo {
  files: number;
  /** The bytes its files declare unpacked. */
  unpacked: number;
}

/** Whether a wallet unpacks a file of this name (12-grains §8): `/`-separated parts of `[A-Za-z0-9._ ~@+-]`, none empty,
 *  `.` or `..`, at most 1 024 bytes. */
export function bundleNameOk(name: Uint8Array): boolean {
  if (name.length === 0 || name.length > MAX_BUNDLE_NAME_BYTES) return false;
  const text = String.fromCharCode(...name);
  return text.split("/").every((part) => part !== "" && part !== "." && part !== ".." && /^[A-Za-z0-9._ ~@+-]+$/.test(part));
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const DESCRIPTOR = 0x08074b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_STRONG = 0x0040;

interface Central {
  flags: number;
  method: number;
  crc: number;
  packed: number;
  unpacked: number;
  name: Uint8Array;
  offset: number;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const nameKey = (b: Uint8Array) => String.fromCharCode(...b);

/**
 * The bundle check (32-images §2a, 12-grains §8): whether `bytes` are a bundle the network keeps and every wallet unpacks
 * the same way, read by its end record and directory without inflating. `max` is the size bound: the network's 16 MiB
 * by default; a wallet checks one from a source up to 20 MiB the same way.
 */
export function checkBundle(bytes: Uint8Array, max = MAX_NETWORK_BUNDLE_BYTES): Checked<BundleInfo, BundleReason> {
  if (bytes.length === 0 || bytes.length > Math.min(max, MAX_BUNDLE_BYTES)) return refuse("size");
  if (bytes.length < 22) return refuse("format");
  // The end record: the last 22 bytes, one disk, no comment.
  const end = bytes.length - 22;
  const entriesHere = le16(bytes, end + 8)!;
  const entries = le16(bytes, end + 10)!;
  const directorySize = le32(bytes, end + 12)!;
  const directoryAt = le32(bytes, end + 16)!;
  if (le32(bytes, end) !== END || le16(bytes, end + 4) !== 0 || le16(bytes, end + 6) !== 0 || le16(bytes, end + 20) !== 0 ||
    entriesHere !== entries || directoryAt + directorySize !== end) {
    return refuse("format");
  }
  if (entries === 0 || entries > 2 * MAX_BUNDLE_FILES) return refuse("files");
  // The central directory, entry by entry, covering its bytes exactly.
  const centrals: Central[] = [];
  let at = directoryAt;
  for (let i = 0; i < entries; i++) {
    if (le32(bytes, at) !== CENTRAL) return refuse("format");
    const nameLength = le16(bytes, at + 28);
    const extraLength = le16(bytes, at + 30);
    const commentLength = le16(bytes, at + 32);
    if (nameLength === null || extraLength === null || commentLength === null) return refuse("format");
    const nameAt = at + 46;
    const next = nameAt + nameLength + extraLength + commentLength;
    if (next > end || le16(bytes, at + 34) !== 0) return refuse("format");
    const entry: Central = {
      flags: le16(bytes, at + 8)!, method: le16(bytes, at + 10)!, crc: le32(bytes, at + 16)!, packed: le32(bytes, at + 20)!,
      unpacked: le32(bytes, at + 24)!, name: bytes.subarray(nameAt, nameAt + nameLength), offset: le32(bytes, at + 42)!,
    };
    // ZIP64 marks its sizes and offsets with all ones.
    if ([entry.packed, entry.unpacked, entry.offset].includes(0xffffffff)) return refuse("format");
    centrals.push(entry);
    at = next;
  }
  if (at !== end) return refuse("format");
  // Each entry: a method a wallet inflates, a name it unpacks, once.
  const names = new Set<string>();
  let files = 0;
  let unpacked = 0;
  for (const entry of centrals) {
    if ((entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG)) !== 0 || (entry.method !== 0 && entry.method !== 8)) return refuse("method");
    if (entry.method === 0 && entry.packed !== entry.unpacked) return refuse("format");
    let name: Uint8Array;
    if (entry.name.length > 0 && entry.name[entry.name.length - 1] === 0x2f) {
      // A folder: nothing in it, its path a name's.
      name = entry.name.subarray(0, entry.name.length - 1);
      if (entry.unpacked !== 0 || !bundleNameOk(name)) return refuse("name");
    } else {
      if (!bundleNameOk(entry.name)) return refuse("name");
      files++;
      unpacked += entry.unpacked;
      name = entry.name;
    }
    const key = nameKey(name);
    if (names.has(key)) return refuse("name");
    names.add(key);
  }
  if (files === 0 || files > MAX_BUNDLE_FILES) return refuse("files");
  // No file stands where another's folder is: a wallet could not unpack both.
  const entryNames = new Set(centrals.map((e) => nameKey(e.name)));
  for (const entry of centrals) {
    if (entry.name[entry.name.length - 1] === 0x2f) continue;
    for (let i = 0; i < entry.name.length; i++) {
      if (entry.name[i] === 0x2f && entryNames.has(nameKey(entry.name.subarray(0, i)))) return refuse("name");
    }
  }
  if (unpacked > MAX_BUNDLE_UNPACKED) return refuse("unpacked");
  // The local records, back to back from the first byte to the central directory, in its order, each agreeing with its
  // entry: a wallet that reads them one after another sees what the directory says.
  at = 0;
  for (const entry of centrals) {
    if (entry.offset !== at || le32(bytes, at) !== LOCAL) return refuse("format");
    const flags = le16(bytes, at + 6);
    const method = le16(bytes, at + 8);
    const nameLength = le16(bytes, at + 26);
    const extraLength = le16(bytes, at + 28);
    if (flags === null || method === null || nameLength === null || extraLength === null) return refuse("format");
    const nameAt = at + 30;
    if (flags !== entry.flags || method !== entry.method || nameAt + nameLength > bytes.length ||
      !sameBytes(bytes.subarray(nameAt, nameAt + nameLength), entry.name)) {
      return refuse("format");
    }
    if ((flags & FLAG_DESCRIPTOR) === 0 &&
      (le32(bytes, at + 14) !== entry.crc || le32(bytes, at + 18) !== entry.packed || le32(bytes, at + 22) !== entry.unpacked)) {
      return refuse("format");
    }
    let next = nameAt + nameLength + extraLength + entry.packed;
    // The descriptor, with its optional signature: CRC and sizes.
    if ((flags & FLAG_DESCRIPTOR) !== 0) next += le32(bytes, next) === DESCRIPTOR ? 16 : 12;
    if (next > directoryAt) return refuse("format");
    at = next;
  }
  if (at !== directoryAt) return refuse("format");
  return { ok: true, value: { files, unpacked } };
}

/** The check of `kind` on `bytes` (32-images §2, §2a): null when it passes, else why. */
export function namedProblem(kind: NamedKind, bytes: Uint8Array): ImageReason | BundleReason | null {
  const checked = kind === "grain_bundle" ? checkBundle(bytes) : checkImage(kind, bytes);
  return checked.ok ? null : checked.reason;
}

/** The colour of a grain's monogram in the wallet's palette of 12 (32-images §3.5): what a wallet draws while an icon is
 *  none, missing or failing. */
export const monogramColour = (slug: string): number =>
  derive("Saltix grain monogram v1", new TextEncoder().encode(slug))[0]! % MONOGRAM_COLOURS;

/** Thirty-two zero bytes name no icon (32-images §3.1): wallets draw the monogram and fetch nothing. */
export const NO_ICON = "00".repeat(32);
