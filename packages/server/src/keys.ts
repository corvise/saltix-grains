// A key that speaks for an account (Saltix 13-accounts §5): a plain account's own Ed25519 key, or one of a managed
// account's devices — a phone's P-256 key among them. Manifests (12-grains §2) and the wallet interface write it
// as `{"ed25519": "<hex>"}` or `{"p256": "<hex>"}`; Borsh writes its tag (0, 1) and the key.
import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { Reader, Writer, fromHex, toHex } from "./bytes.js";

export type DeviceKey = { ed25519: string } | { p256: string };

const ED25519 = 0;
const P256 = 1;

/** `key` in the JSON form, or null: one field, lowercase hex of the key's length. */
export function deviceKeyOf(value: unknown): DeviceKey | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1) return null;
  const [kind, hex] = entries[0]!;
  if (typeof hex !== "string") return null;
  if (kind === "ed25519" && /^[0-9a-f]{64}$/.test(hex)) return { ed25519: hex };
  if (kind === "p256" && /^[0-9a-f]{66}$/.test(hex)) return { p256: hex };
  return null;
}

export function writeDeviceKey(w: Writer, key: DeviceKey): Writer {
  return "ed25519" in key ? w.u8(ED25519).fixed(fromHex(key.ed25519, 32), 32) : w.u8(P256).fixed(fromHex(key.p256, 33), 33);
}

export function readDeviceKey(r: Reader): DeviceKey {
  const tag = r.u8();
  if (tag === ED25519) return { ed25519: toHex(r.fixed(32)) };
  if (tag === P256) return { p256: toHex(r.fixed(33)) };
  throw new TypeError("borsh: a device key's tag");
}

/** Whether `a` and `b` are the same key. */
export function sameDeviceKey(a: DeviceKey, b: DeviceKey): boolean {
  return "ed25519" in a ? "ed25519" in b && a.ed25519 === b.ed25519 : "p256" in b && a.p256 === b.p256;
}

type Point = InstanceType<typeof ed25519.ExtendedPoint>;

/**
 * The point `bytes` encode, or null. `canonical`: only as RFC 8032 writes it (y < p, and x = 0 with its sign bit clear);
 * otherwise as curve25519-dalek decompresses (any y below 2^255, reduced), which is how the node reads a key.
 */
function pointOf(bytes: Uint8Array, canonical: boolean): Point | null {
  if (bytes.length !== 32) return null;
  try {
    return ed25519.ExtendedPoint.fromHex(bytes, !canonical);
  } catch {
    return null;
  }
}

/**
 * An Ed25519 key the node takes as a key (`ed25519::is_valid_public_key`): 32 bytes that decode to a point not of small
 * order. Like the node it takes the few non-canonical encodings (y ≥ p) of points not of small order: no one knows a
 * secret for any of them, so they sign nothing (`verifyEd25519` refuses them), but a log that lists one stays the log
 * the node replays.
 */
export function ed25519KeyValid(key: Uint8Array): boolean {
  const point = pointOf(key, false);
  return point !== null && !point.isSmallOrder();
}

/** A device key the node takes: such an Ed25519 key, or a compressed P-256 point other than the identity. */
export function deviceKeyValid(key: DeviceKey): boolean {
  if ("ed25519" in key) return /^[0-9a-f]{64}$/.test(key.ed25519) && ed25519KeyValid(fromHex(key.ed25519, 32));
  try {
    return /^[0-9a-f]{66}$/.test(key.p256) && !p256.ProjectivePoint.fromHex(key.p256).equals(p256.ProjectivePoint.ZERO);
  } catch {
    return false;
  }
}

const L = ed25519.CURVE.n;

const littleEndian = (bytes: Uint8Array): bigint => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
};

/**
 * Whether `signature` is `publicKey`'s over `message`: the SDK's one Ed25519 check, and the node's (saltix-crypto
 * `ed25519::verify`, ed25519-dalek 2's `verify_strict`). `s` below the group's order L; the key and `R` canonical
 * encodings of points not of small order; and `R` exactly `[s]B − [k]A`, k = SHA-512(R ‖ A ‖ message) mod L — never
 * merely equal up to a point of small order, as the cofactored check of RFC 8032 (and `@noble/curves`' `verify`, ZIP-215
 * or not) allows. A check any weaker takes what the node refuses (a key of small order "signs" every message), so two
 * readers of one signature disagree. The node's decoder also takes the non-canonical encodings of a few keys
 * (`ed25519KeyValid`); refusing them here changes no verdict, as no one can sign for those points.
 */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  const rBytes = signature.subarray(0, 32);
  const s = littleEndian(signature.subarray(32));
  if (s >= L) return false;
  const A = pointOf(publicKey, true);
  const R = pointOf(rBytes, true);
  if (A === null || R === null || A.isSmallOrder() || R.isSmallOrder()) return false;
  const h = new Uint8Array(64 + message.length);
  h.set(rBytes, 0);
  h.set(publicKey, 32);
  h.set(message, 64);
  const k = littleEndian(sha512(h)) % L;
  const expected = ed25519.ExtendedPoint.BASE.multiplyUnsafe(s).subtract(A.multiplyUnsafe(k)).toRawBytes();
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= expected[i]! ^ rBytes[i]!;
  return diff === 0;
}

/**
 * Whether `signature` (64 bytes of hex) is `key`'s over the 32-byte `message`: Ed25519 (strictly, `verifyEd25519`), or
 * ECDSA P-256 over SHA-256 of it as `r ‖ s` with a low `s` — as a phone signs a transaction (13-accounts §6.1).
 */
export function verifyByDeviceKey(key: DeviceKey, message: Uint8Array, signature: string): boolean {
  try {
    const sig = fromHex(signature, 64);
    if ("ed25519" in key) return verifyEd25519(fromHex(key.ed25519, 32), message, sig);
    // The hash is given, so no library default decides it.
    return deviceKeyValid(key) && p256.verify(sig, sha256(message), fromHex(key.p256, 33), { prehash: false, lowS: true, format: "compact" });
  } catch {
    return false;
  }
}
