// A server key's word that a bundle is its grain's next one (Saltix 32-images §7.3, docs/protocol/images.md): with it a
// node holds a sealed grain's bundle *pending* for a day before any manifest names it, so the developer's machine (or the
// app's program) puts the bundle into the network before the owner signs the manifest on the phone.
//
//   BundleUpload       { slug: String, bundle: [u8; 32], size: u64, at: u64 }      at: Unix ms
//   SignedBundleUpload { upload, key: [u8; 32], signature: [u8; 64] }
//     signature: Ed25519 by key over derive("Saltix grain bundle upload v1", genesis_hash ‖ Borsh(BundleUpload))
//
// The key is one the live grain's registry record names (`ConfigureGrain`): the key `grain pair` made on this computer, or
// a developer key's. Byte for byte `saltix_types::grain::bundle` (`vectors/images-v1.json`, `uploads`).
//
// No Node APIs here.
import { ed25519 } from "@noble/curves/ed25519";
import { Reader, Writer, derive, fromHex, toHex } from "./bytes.js";
import { verifyEd25519 } from "./keys.js";
import { MAX_NETWORK_BUNDLE_BYTES } from "./named.js";

export const UPLOAD_DOMAIN = "Saltix grain bundle upload v1";
/** How long a node holds a pending bundle after its statement's time: a day. */
export const PENDING_MS = 24 * 3_600_000;
/** How far ahead of a node's clock a statement may be dated. */
export const UPLOAD_AHEAD_MS = 10 * 60_000;
/** A signed statement's bytes at most: a slug of 32 bytes, the hash, the size, the time, the key and the signature. */
export const MAX_SIGNED_UPLOAD_BYTES = 4 + 32 + 32 + 8 + 8 + 32 + 64;

/** What the server key says: the bundle of this hash and size is `slug`'s, as of `at`. Bytes in lowercase hex. */
export interface BundleUpload {
  slug: string;
  /** `namedHash("grain_bundle", zip)`. */
  bundle: string;
  size: number;
  /** When it was signed (Unix ms): the bundle is held pending until `at` + `PENDING_MS`. */
  at: number;
}

export interface SignedBundleUpload {
  upload: BundleUpload;
  /** The server key that signed it, hex. */
  key: string;
  signature: string;
}

/** Why a node refuses a statement: the words `blob_put` answers. */
export type UploadReason = "slug" | "size" | "hash" | "key" | "time" | "signature";

export function encodeBundleUpload(u: BundleUpload): Uint8Array {
  return new Writer().string(u.slug).fixed(fromHex(u.bundle, 32), 32).u64(u.size).u64(u.at).done();
}

/** What the server key signs: the statement on the network of `genesis` (its hash, hex). */
export const bundleUploadMessage = (genesis: string, u: BundleUpload): Uint8Array =>
  derive(UPLOAD_DOMAIN, fromHex(genesis, 32), encodeBundleUpload(u));

/** The statement signed with the server key's 32-byte secret. The secret never leaves the caller. */
export function signBundleUpload(secret: Uint8Array, genesis: string, u: BundleUpload): SignedBundleUpload {
  if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(u.slug)) throw new TypeError("slug: 3 to 32 of [a-z0-9-]");
  if (!Number.isSafeInteger(u.size) || u.size < 1 || !Number.isSafeInteger(u.at) || u.at < 0) throw new TypeError("size and at: whole numbers");
  return {
    upload: { ...u },
    key: toHex(ed25519.getPublicKey(secret)),
    signature: toHex(ed25519.sign(bundleUploadMessage(genesis, u), secret)),
  };
}

/** The Borsh of a signed statement: what `blob_put`'s `upload` carries, in hex. */
export function encodeSignedBundleUpload(s: SignedBundleUpload): Uint8Array {
  return new Writer().raw(encodeBundleUpload(s.upload)).fixed(fromHex(s.key, 32), 32).fixed(fromHex(s.signature, 64), 64).done();
}

/** A signed statement from its Borsh, strictly: its bound first, no trailing bytes. Throws otherwise. */
export function decodeSignedBundleUpload(bytes: Uint8Array): SignedBundleUpload {
  if (bytes.length > MAX_SIGNED_UPLOAD_BYTES) throw new TypeError("a bundle upload's statement: too long");
  const r = new Reader(bytes);
  const upload: BundleUpload = { slug: r.string(), bundle: toHex(r.fixed(32)), size: r.u64n(), at: r.u64n() };
  const s = { upload, key: toHex(r.fixed(32)), signature: toHex(r.fixed(64)) };
  r.end();
  return s;
}

/** Until when a node holds the bundle pending (Unix ms). */
export const pendingUntil = (u: BundleUpload): number => u.at + PENDING_MS;

/**
 * What a node checks before it holds a bundle no manifest names yet, cheap first: a live grain's slug whose registry
 * record names the signing key (`servers`, null for a slug that is no live grain), a size the network keeps, dated no
 * further than 10 minutes ahead of `now` and its day not over, and the signature. Null when it holds.
 */
export function bundleUploadProblem(s: SignedBundleUpload, genesis: string, servers: readonly string[] | null, now: number): UploadReason | null {
  const u = s.upload;
  if (servers === null || !/^[a-z0-9][a-z0-9-]{2,31}$/.test(u.slug)) return "slug";
  if (u.size < 1 || u.size > MAX_NETWORK_BUNDLE_BYTES) return "size";
  if (!servers.includes(s.key)) return "key";
  if (u.at > now + UPLOAD_AHEAD_MS || now >= pendingUntil(u)) return "time";
  if (!verifyEd25519(fromHex(s.key, 32), bundleUploadMessage(genesis, u), fromHex(s.signature, 64))) return "signature";
  return null;
}

/** Whether the statement names a bundle of `hash` (hex) and `size`: null, or `size` / `hash`. */
export function bundleUploadNames(s: SignedBundleUpload, hash: string, size: number): "size" | "hash" | null {
  if (s.upload.size !== size) return "size";
  return s.upload.bundle === hash ? null : "hash";
}
