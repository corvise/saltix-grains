import { ed25519 } from "@noble/curves/ed25519";
import { Reader, Writer, derive, fromBase64, toBase64 } from "./bytes.js";
import { type NetworkName, accountId, decodeAddress } from "./address.js";
import { verifyEd25519 } from "./keys.js";

/**
 * The relays' records (Saltix 09-relay §1), byte for byte the node's (vectors/relay-v1.json): what a
 * server needs to register its own address at a relay and to check other addresses' messaging keys.
 * Every signature is Ed25519 over `derive(domain, Borsh(payload))`.
 */

const BINDING = "Saltix messaging key v1";
const DEVICE = "Saltix device certificate v1";
const RECORD = "Saltix address record v1";
const ACK = "Saltix mailbox ack v1";
/** How far ahead of a checker's clock a record may be issued. */
const FUTURE_SKEW_MS = 10 * 60_000;
const MAX_CERT_LIFETIME_MS = 400 * 86_400_000;

/** The account's messaging key for an epoch, signed by the account key (§1.2). */
export interface KeyBinding {
  accountKey: Uint8Array;
  messagingKey: Uint8Array;
  keyEpoch: number;
  devicesAfter: number;
  issuedAt: number;
  signature: Uint8Array;
}

/** A device key the account trusts (§1.1). */
export interface DeviceCert {
  deviceKey: Uint8Array;
  kind: number;
  issuedAt: number;
  expiresAt: number;
  signature: Uint8Array;
}

/** Where an address is now (§1.2). */
export interface AddressRecord {
  key: KeyBinding;
  relay: Uint8Array;
  issuedAt: number;
  nonce: Uint8Array;
  device: DeviceCert | null;
  signature: Uint8Array;
}

const sign = (domain: string, payload: Uint8Array, secret: Uint8Array) => ed25519.sign(derive(domain, payload), secret);
const verify = (domain: string, payload: Uint8Array, signature: Uint8Array, key: Uint8Array) => verifyEd25519(key, derive(domain, payload), signature);

const bindingBody = (b: Omit<KeyBinding, "signature">) =>
  new Writer().fixed(b.accountKey, 32).fixed(b.messagingKey, 32).u32(b.keyEpoch).u64(b.devicesAfter).u64(b.issuedAt).done();

/** Bind `messagingKey` (X25519 public) to the account of `secret`. */
export function signKeyBinding(secret: Uint8Array, messagingKey: Uint8Array, issuedAt: number, keyEpoch = 0, devicesAfter = 0): KeyBinding {
  const body = { accountKey: ed25519.getPublicKey(secret), messagingKey, keyEpoch, devicesAfter, issuedAt };
  return { ...body, signature: sign(BINDING, bindingBody(body), secret) };
}

export function encodeKeyBinding(b: KeyBinding): Uint8Array {
  return new Writer().raw(bindingBody(b)).fixed(b.signature, 64).done();
}

const certBody = (accountKey: Uint8Array, c: Omit<DeviceCert, "signature">) =>
  new Writer().fixed(accountKey, 32).fixed(c.deviceKey, 32).u8(c.kind).u64(c.issuedAt).u64(c.expiresAt).done();

function writeDevice(w: Writer, c: DeviceCert | null): Writer {
  if (!c) return w.u8(0);
  return w.u8(1).fixed(c.deviceKey, 32).u8(c.kind).u64(c.issuedAt).u64(c.expiresAt).fixed(c.signature, 64);
}

const recordBody = (r: Omit<AddressRecord, "signature">) =>
  writeDevice(new Writer().raw(encodeKeyBinding(r.key)).fixed(r.relay, 32).u64(r.issuedAt).fixed(r.nonce, 16), r.device).done();

/** A record signed by the account key itself (no device certificate): how a server registers. */
export function signAddressRecord(secret: Uint8Array, key: KeyBinding, relay: Uint8Array, nonce: Uint8Array, issuedAt: number): AddressRecord {
  const body = { key, relay, issuedAt, nonce, device: null };
  return { ...body, signature: sign(RECORD, recordBody(body), secret) };
}

export function encodeAddressRecord(r: AddressRecord): Uint8Array {
  return new Writer().raw(recordBody(r)).fixed(r.signature, 64).done();
}

export function decodeAddressRecord(bytes: Uint8Array): AddressRecord {
  const r = new Reader(bytes);
  const key: KeyBinding = {
    accountKey: r.fixed(32), messagingKey: r.fixed(32), keyEpoch: r.u32(), devicesAfter: Number(r.u64()), issuedAt: Number(r.u64()),
    signature: r.fixed(64),
  };
  const relay = r.fixed(32);
  const issuedAt = Number(r.u64());
  const nonce = r.fixed(16);
  const tag = r.u8();
  if (tag > 1) throw new TypeError("borsh: bad option");
  const device = tag === 1
    ? { deviceKey: r.fixed(32), kind: r.u8(), issuedAt: Number(r.u64()), expiresAt: Number(r.u64()), signature: r.fixed(64) }
    : null;
  const signature = r.fixed(64);
  r.end();
  return { key, relay, issuedAt, nonce, device, signature };
}

/** Why `r` is not a valid record at `now` (§1.2's check), or null. */
export function recordProblem(r: AddressRecord, now: number): string | null {
  const k = r.key;
  if (!verify(BINDING, bindingBody(k), k.signature, k.accountKey)) return "binding";
  if (k.issuedAt > now + FUTURE_SKEW_MS || r.issuedAt > now + FUTURE_SKEW_MS) return "future";
  let signer = k.accountKey;
  if (r.device) {
    const d = r.device;
    const valid = verify(DEVICE, certBody(k.accountKey, d), d.signature, k.accountKey) && d.expiresAt > now &&
      d.issuedAt <= now + FUTURE_SKEW_MS && d.expiresAt - d.issuedAt <= MAX_CERT_LIFETIME_MS && d.issuedAt >= k.devicesAfter;
    if (!valid) return "device";
    signer = d.deviceKey;
  }
  return verify(RECORD, recordBody(r), r.signature, signer) ? null : "signature";
}

/**
 * The messaging key of `address` from the record a relay gave for it (`key_response.record`,
 * base64url), or null: taken only from a record that checks and names that address (§3: never the
 * relay's word).
 */
export function messagingKeyOf(address: string, recordB64: string | null | undefined, now = Date.now(), network?: NetworkName): Uint8Array | null {
  if (!recordB64) return null;
  const wanted = decodeAddress(address);
  if (!wanted || wanted.kind !== 0 || (network && wanted.network !== network)) return null;
  let record: AddressRecord;
  try {
    record = decodeAddressRecord(fromBase64Url(recordB64));
  } catch {
    return null;
  }
  if (recordProblem(record, now) !== null) return null;
  const id = accountId(record.key.accountKey);
  return id.every((b, i) => b === wanted.id[i]) ? record.key.messagingKey : null;
}

/** The signed proof that the account of `secret` took `msgId` off its mailbox (10-storage §4). */
export function signMailboxAck(secret: Uint8Array, msgId: string, at: number): Uint8Array {
  const body = new Writer().fixed(ed25519.getPublicKey(secret), 32).string(msgId).u64(at).u8(0).done();
  return new Writer().raw(body).fixed(sign(ACK, body, secret), 64).done();
}

/** Base64url without padding (without Node's `Buffer`, so a browser runs it too). */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes, true);
}

/** Base64url with or without padding, as relays send it. */
export function fromBase64Url(text: string): Uint8Array {
  return fromBase64(text, true);
}
