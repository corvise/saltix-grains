// A link payload (Saltix 09-relay §10.3), byte for byte the node's `saltix_crypto::sealed::seal_link_payload`:
//   E = X25519(e, 9) · S = X25519(e, Q) (an all-zero S is refused)
//   key = BLAKE3 derive_key("Saltix link payload v1", S ‖ E ‖ Q)
//   payload = E ‖ XChaCha20-Poly1305(key, 24 zero bytes, aad = sid ‖ P)
// What a wallet delivers to a Connect page's slot (19-connect §5).
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { concat, derive } from "@saltix/grain-server/web";

export const LINK_PAYLOAD_DOMAIN = "Saltix link payload v1";

export const boxPublic = (secret: Uint8Array): Uint8Array => x25519.getPublicKey(secret);

export const randomSecret = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

function cipherKey(shared: Uint8Array, ephemeral: Uint8Array, recipient: Uint8Array): Uint8Array {
  if (shared.every((b) => b === 0)) throw new TypeError("sealed: no shared secret");
  return derive(LINK_PAYLOAD_DOMAIN, shared, ephemeral, recipient);
}

/** Seal `plaintext` to the slot `sid` of session key `page` at box key `q`; `oneTime` only for vectors and tests. */
export function sealLinkPayload(q: Uint8Array, sid: Uint8Array, page: Uint8Array, plaintext: Uint8Array, oneTime = randomSecret()): Uint8Array {
  const ephemeral = x25519.getPublicKey(oneTime);
  const key = cipherKey(x25519.getSharedSecret(oneTime, q), ephemeral, q);
  return concat(ephemeral, xchacha20poly1305(key, new Uint8Array(24), concat(sid, page)).encrypt(plaintext));
}

/** The plaintext of a payload for the holder of `secret` (Q's), or null when it does not open for this slot. */
export function openLinkPayload(secret: Uint8Array, sid: Uint8Array, page: Uint8Array, payload: Uint8Array): Uint8Array | null {
  if (payload.length < 32 + 16) return null;
  try {
    const ephemeral = payload.slice(0, 32);
    const key = cipherKey(x25519.getSharedSecret(secret, ephemeral), ephemeral, x25519.getPublicKey(secret));
    return xchacha20poly1305(key, new Uint8Array(24), concat(sid, page)).decrypt(payload.slice(32));
  } catch {
    return null;
  }
}
