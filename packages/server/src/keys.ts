// A key that speaks for an account (Saltix 13-accounts §5): a plain account's own Ed25519 key, or one of a managed
// account's devices — a phone's P-256 key among them. Manifests (12-grains §2) and the wallet interface write it
// as `{"ed25519": "<hex>"}` or `{"p256": "<hex>"}`; Borsh writes its tag (0, 1) and the key.
import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
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

/**
 * Whether `signature` (64 bytes of hex) is `key`'s over the 32-byte `message`: Ed25519, or ECDSA P-256 over SHA-256 of
 * it as `r ‖ s` with a low `s` — as a phone signs a transaction (13-accounts §6.1).
 */
export function verifyByDeviceKey(key: DeviceKey, message: Uint8Array, signature: string): boolean {
  try {
    const sig = fromHex(signature, 64);
    if ("ed25519" in key) return ed25519.verify(sig, message, fromHex(key.ed25519, 32));
    // The hash is given, so no library default decides it.
    return p256.verify(sig, sha256(message), fromHex(key.p256, 33), { prehash: false, lowS: true, format: "compact" });
  } catch {
    return false;
  }
}
