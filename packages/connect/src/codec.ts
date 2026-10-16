// base64url as Saltix Connect spells it (19-connect §3): offers carry it strictly (the alphabet, no padding, no stray
// bits: one spelling per value); relays' frames may spell it loosely. On top of the server SDK's base64.
import { fromBase64, toBase64 } from "@saltix/grain-server/web";

/** base64url without padding. */
export const b64url = (bytes: Uint8Array): string => toBase64(bytes, true);

/** Strict base64url without padding, as offers carry it; null for anything else. */
export function fromB64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    return fromBase64(text, true);
  } catch {
    return null;
  }
}

/** base64 or base64url, padded or not, as relays' frames may spell it; null when it is neither. */
export const fromB64Loose = (text: string): Uint8Array | null => fromB64url(text.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));

/** Whether two byte strings are equal, in time that does not depend on where they differ. */
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}
