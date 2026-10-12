import nacl from "tweetnacl";
import { derive } from "./bytes.js";

/**
 * Frames between a grain's users and its server (12-grains §5.4): NaCl `crypto_box` (X25519,
 * XSalsa20-Poly1305) as `nonce (24) ‖ box`, sealed to the recipient's messaging key from its checked
 * record.
 */

/** The X25519 public key of a messaging `secret` (32 bytes). */
export function messagingPublic(secret: Uint8Array): Uint8Array {
  return nacl.scalarMult.base(secret);
}

/**
 * The messaging secret a server SDK uses for the address of `secret` (an Ed25519 secret): the same
 * key across restarts and SDKs, so users' wallets keep sealing to it.
 */
export function serverMessagingSecret(secret: Uint8Array): Uint8Array {
  return derive("Saltix grain server messaging key v1", secret);
}

export function sealFrame(plaintext: Uint8Array, recipientKey: Uint8Array, senderSecret: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(plaintext, nonce, recipientKey, senderSecret);
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce);
  out.set(box, nonce.length);
  return out;
}

/** The plaintext of `sealed` from `senderKey`, or null when it does not open. */
export function openFrame(sealed: Uint8Array, senderKey: Uint8Array, recipientSecret: Uint8Array): Uint8Array | null {
  if (sealed.length < nacl.box.nonceLength + nacl.box.overheadLength) return null;
  return nacl.box.open(sealed.subarray(nacl.box.nonceLength), sealed.subarray(0, nacl.box.nonceLength), senderKey, recipientSecret);
}
