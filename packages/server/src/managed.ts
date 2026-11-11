// Managed accounts at relays (Saltix 09-relay §1.4, 13-accounts §7–§8). A managed account has no account key: a device or
// a root of its key event log signs its messaging key's binding and its records, and a reader checks them against the
// newest log it has of the account. The relay hands a managed address's record and log out together (`key_response
// {record: null, managed, log}`); a messaging key is taken only from a record that checks against a log that checks,
// never on the relay's word. Byte for byte the node's (vectors/relay-v1.json), and the same checks in the same order as the
// node's relay makes them (saltix-node relay/managed.rs: `ManagedSigner`, `ManagedBinding::check`, `ManagedRecord::check`,
// `KnownLog::of_record`), so that a record a relay took is one this takes and no other.
import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { ID_BYTES, type NetworkName, decodeAddress } from "./address.js";
import { Reader, Writer, derive, fromHex, toHex } from "./bytes.js";
import { type DeviceKey, readDeviceKey, verifyByDeviceKey, verifyEd25519, writeDeviceKey } from "./keys.js";
import { type CheckedLog, type LogOrigin, type LogRules, LogError, checkLog, checkLogFrom, isPhraseRoot, logOriginAccount, policyOf, rootDigest, splitLog } from "./keylog.js";
import { type NodeLike, nodeCall } from "./node.js";
import { fromBase64Url } from "./records.js";

const BINDING = "Salarium managed messaging key v1";
const RECORD = "Salarium managed address record v1";
/** How far ahead of a checker's clock a binding or a record may be issued. */
const FUTURE_SKEW_MS = 10 * 60_000;
/** A managed record without its log is at most this long (09-relay §1.4). */
export const MAX_MANAGED_RECORD_BYTES = 1024;

/** Who signs for a managed account (13-accounts §5): a root of its current phrase (an Ed25519 key), or one of its devices. */
export type ManagedSigner = { root: Uint8Array } | { device: DeviceKey };

/** A managed account's messaging key for an epoch, signed by a device or a root current in its log at `seq`. */
export interface ManagedBinding {
  account: Uint8Array;
  messagingKey: Uint8Array;
  keyEpoch: number;
  issuedAt: number;
  /** The log event the signer is checked at (13-accounts §7). */
  seq: number;
  signer: ManagedSigner;
  signature: Uint8Array;
}

/** Where a managed account's device is, signed by that device (or a root): one route per signer (09-relay §10.2). */
export interface ManagedRecord {
  key: ManagedBinding;
  relay: Uint8Array;
  issuedAt: number;
  nonce: Uint8Array;
  signer: ManagedSigner;
  signature: Uint8Array;
}

/** Why a managed binding or record does not hold, by the node's `RecordError`: `mismatch` (another account's log),
 *  `log_behind` (the log has not reached the binding's `seq`), `binding_signature`, `signature` (the record's), `revoked`
 *  (a signer not current in the log), `future` (issued more than 10 minutes ahead), `log` (the log does not check). */
export type ManagedProblem = "mismatch" | "log_behind" | "binding_signature" | "signature" | "revoked" | "future" | "log";

function readSigner(r: Reader): ManagedSigner {
  const tag = r.u8();
  if (tag === 0) return { root: r.fixed(32) };
  if (tag === 1) return { device: readDeviceKey(r) };
  throw new TypeError(`borsh: a managed signer's tag ${tag}`);
}

function writeSigner(w: Writer, s: ManagedSigner): Writer {
  return "root" in s ? w.u8(0).fixed(s.root, 32) : writeDeviceKey(w.u8(1), s.device);
}

const bindingPayload = (b: Omit<ManagedBinding, "signature">): Uint8Array =>
  writeSigner(new Writer().fixed(b.account, ID_BYTES).fixed(b.messagingKey, 32).u32(b.keyEpoch).u64(b.issuedAt).u32(b.seq), b.signer).done();

const encodeBinding = (b: ManagedBinding): Uint8Array => new Writer().raw(bindingPayload(b)).fixed(b.signature, 64).done();

const recordBody = (r: Omit<ManagedRecord, "signature">): Uint8Array =>
  writeSigner(new Writer().raw(encodeBinding(r.key)).fixed(r.relay, 32).u64(r.issuedAt).fixed(r.nonce, 16), r.signer).done();

/** What a binding's signer signs: `derive("Salarium managed messaging key v1", Borsh of its fields before the signature)`. */
export const managedBindingMessage = (b: Omit<ManagedBinding, "signature">): Uint8Array => derive(BINDING, bindingPayload(b));

/** What a record's signer signs: `derive("Salarium managed address record v1", Borsh of its body)`. */
export const managedRecordMessage = (r: Omit<ManagedRecord, "signature">): Uint8Array => derive(RECORD, recordBody(r));

export function encodeManagedRecord(r: ManagedRecord): Uint8Array {
  return new Writer().raw(recordBody(r)).fixed(r.signature, 64).done();
}

/** A managed record from its Borsh (`key_response.managed`, base64url): at most `MAX_MANAGED_RECORD_BYTES`, every byte read. */
export function decodeManagedRecord(bytes: Uint8Array): ManagedRecord {
  if (bytes.length > MAX_MANAGED_RECORD_BYTES) throw new TypeError("a managed record is at most 1 024 bytes");
  const r = new Reader(bytes);
  const key: ManagedBinding = {
    account: r.fixed(ID_BYTES), messagingKey: r.fixed(32), keyEpoch: r.u32(), issuedAt: r.u64n(), seq: r.u32(), signer: readSigner(r),
    signature: r.fixed(64),
  };
  const record: ManagedRecord = { key, relay: r.fixed(32), issuedAt: r.u64n(), nonce: r.fixed(16), signer: readSigner(r), signature: r.fixed(64) };
  r.end();
  return record;
}

/** Whether `signature` is `signer`'s over the 32-byte `message` (`ManagedSigner::verify`): strict Ed25519 for a root or an
 *  Ed25519 device, ECDSA P-256 over SHA-256 of it with a low `s` for a P-256 device. */
export function managedSignerVerifies(signer: ManagedSigner, message: Uint8Array, signature: Uint8Array): boolean {
  return "root" in signer ? verifyEd25519(signer.root, message, signature) : verifyByDeviceKey(signer.device, message, toHex(signature));
}

/** The very key a log lists, as the node looks a device up (`d.key == key`): a P-256 key in another form is another key. */
const sameKey = (a: DeviceKey, b: DeviceKey): boolean => ("ed25519" in a ? "ed25519" in b && a.ed25519 === b.ed25519 : "p256" in b && a.p256 === b.p256);

/** Whether `log` lists `signer` now (`ManagedSigner::is_current`, 13-accounts §8): a device among its devices that is not a
 *  guardian, or a root of its current phrase. */
export function managedSignerIsCurrent(signer: ManagedSigner, log: Pick<CheckedLog, "devices" | "phraseRoots">): boolean {
  if ("root" in signer) return isPhraseRoot(log, signer.root);
  const device = log.devices.find((d) => sameKey(d.key, signer.device));
  return device !== undefined && device.kind !== "guardian";
}

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Why `b` does not hold at `now` against `log`, the newest log of its account (`ManagedBinding::check`), or null. */
export function managedBindingProblem(b: ManagedBinding, log: CheckedLog, now: number): ManagedProblem | null {
  if (!equal(logOriginAccount(log.origin), b.account)) return "mismatch";
  if (log.seq < b.seq) return "log_behind";
  if (!managedSignerVerifies(b.signer, managedBindingMessage(b), b.signature)) return "binding_signature";
  if (!managedSignerIsCurrent(b.signer, log)) return "revoked";
  if (b.issuedAt > now + FUTURE_SKEW_MS) return "future";
  return null;
}

/** Why `r` does not hold at `now` against `log` (`ManagedRecord::check`): its binding, then its own signature by a signer
 *  current in the log, then its time; or null. */
export function managedRecordProblem(r: ManagedRecord, log: CheckedLog, now: number): ManagedProblem | null {
  const binding = managedBindingProblem(r.key, log, now);
  if (binding !== null) return binding;
  if (!managedSignerVerifies(r.signer, managedRecordMessage(r), r.signature)) return "signature";
  if (!managedSignerIsCurrent(r.signer, log)) return "revoked";
  if (r.issuedAt > now + FUTURE_SKEW_MS) return "future";
  return null;
}

/**
 * `events` (each event's Borsh) as the log of `record`'s account (`KnownLog::of_record`): checked from the origin their
 * first event shows; an empty log is a kind 5 address before its first transaction, which starts from the root that signed
 * the record's binding, and that root must make the address. The checked log, or why there is none: `log` (it does not
 * check; `detail` says where), `revoked` (an empty log whose binding no first root of the address signed).
 */
export function managedLogOf(
  record: ManagedRecord,
  events: Uint8Array[],
  rules: LogRules,
): { log: CheckedLog } | { problem: "log" | "revoked"; detail: string } {
  const account = record.key.account;
  try {
    if (events.length > 0) return { log: checkLog(account, events, rules.genesis, rules.policy) };
    const signer = record.key.signer;
    if (!("root" in signer)) return { problem: "log", detail: "empty" };
    const origin: LogOrigin = { kind: "root", digest: rootDigest(signer.root) };
    if (!equal(logOriginAccount(origin), account)) return { problem: "revoked", detail: "the root does not make the address" };
    return { log: checkLogFrom(account, origin, [], rules.genesis, rules.policy) };
  } catch (e) {
    if (e instanceof LogError) return { problem: "log", detail: e.message };
    throw e;
  }
}

/**
 * The messaging key of `address` from what a relay gave for it (`key_response.managed` and `.log`, base64url: the record's
 * Borsh, the Borsh of the log's events), or why not (`ManagedProblem`, or `record` for a record that does not decode or is
 * another address's). Taken only from a record that checks at `now` against its log checked under `rules` (the network's
 * genesis hash and first account policy), of an address of `network` (09-relay §3: never the relay's word).
 */
export function managedMessagingKey(
  address: string,
  managedB64: string,
  logB64: string,
  now: number,
  network: NetworkName | undefined,
  rules: LogRules,
): { key: Uint8Array } | { problem: ManagedProblem | "record"; detail?: string } {
  const wanted = decodeAddress(address);
  if (!wanted || (wanted.kind !== 0 && wanted.kind !== 5) || (network && wanted.network !== network)) return { problem: "record" };
  let record: ManagedRecord;
  let events: Uint8Array[];
  try {
    record = decodeManagedRecord(fromBase64Url(managedB64));
  } catch {
    return { problem: "record" };
  }
  if (!equal(record.key.account, wanted.id)) return { problem: "record" };
  try {
    events = splitLog(fromBase64Url(logB64));
  } catch (e) {
    return { problem: "log", detail: e instanceof Error ? e.message : String(e) };
  }
  const known = managedLogOf(record, events, rules);
  if ("problem" in known) return known;
  const problem = managedRecordProblem(record, known.log, now);
  return problem === null ? { key: record.key.messagingKey } : { problem };
}

/** `managedMessagingKey`'s key, or null: what a reader seals to and opens with, beside `messagingKeyOf` for plain records. */
export function managedMessagingKeyOf(
  address: string,
  managedB64: string | null | undefined,
  logB64: string | null | undefined,
  now: number,
  network: NetworkName | undefined,
  rules: LogRules | null | undefined,
): Uint8Array | null {
  if (!managedB64 || typeof logB64 !== "string" || !rules) return null;
  const found = managedMessagingKey(address, managedB64, logB64, now, network, rules);
  return "key" in found ? found.key : null;
}

/**
 * The rules a managed account's log is checked under, from `node`'s `node_status` (its `genesis` and `accounts.policy`,
 * Saltix 08-node §6): your own node, which is yours to trust, of `network`. Throws when it names another network or gives
 * no rules (a node still starting).
 */
export async function logRulesOf(node: NodeLike, network: NetworkName): Promise<LogRules> {
  const status = await nodeCall<{ network?: unknown; genesis?: unknown; accounts?: { policy?: { delay?: unknown; dispute_timeout?: unknown } } }>(
    node, "node_status");
  if (status.network !== network) throw new Error(`the node is on ${String(status.network)}, not ${network}`);
  const policy = status.accounts?.policy;
  if (typeof status.genesis !== "string" || !/^[0-9a-f]{64}$/.test(status.genesis) || !Number.isSafeInteger(policy?.delay) ||
    !Number.isSafeInteger(policy?.dispute_timeout)) {
    throw new Error("the node gives no genesis and account policy yet");
  }
  return { genesis: fromHex(status.genesis, 32), policy: policyOf({ delay: policy!.delay as number, dispute_timeout: policy!.dispute_timeout as number }) };
}

/** A key that signs for a managed account (the node's `ManagedKey`): a root's or an Ed25519 device's 32-byte secret, or a
 *  P-256 device's. Phones sign in their hardware; this is for servers' devices, tests and vectors. */
export type ManagedKey = { root: Uint8Array } | { ed25519: Uint8Array } | { p256: Uint8Array };

/** The signer `key` names. */
export function managedSignerOf(key: ManagedKey): ManagedSigner {
  if ("root" in key) return { root: ed25519.getPublicKey(key.root) };
  if ("ed25519" in key) return { device: { ed25519: toHex(ed25519.getPublicKey(key.ed25519)) } };
  return { device: { p256: toHex(p256.getPublicKey(key.p256, true)) } };
}

/** `key`'s signature over the 32-byte `message`: Ed25519, or P-256 over SHA-256 of it with a low `s` (RFC 6979). */
function signBy(key: ManagedKey, message: Uint8Array): Uint8Array {
  if ("p256" in key) return p256.sign(sha256(message), key.p256, { prehash: false, lowS: true }).toCompactRawBytes();
  return ed25519.sign(message, "root" in key ? key.root : key.ed25519);
}

/** `key` binds `messagingKey` (X25519 public) to `account` for `keyEpoch`, checked at its log's event `seq`. */
export function signManagedBinding(
  key: ManagedKey, account: Uint8Array, messagingKey: Uint8Array, keyEpoch: number, issuedAt: number, seq: number,
): ManagedBinding {
  const body = { account, messagingKey, keyEpoch, issuedAt, seq, signer: managedSignerOf(key) };
  return { ...body, signature: signBy(key, managedBindingMessage(body)) };
}

/** `key` signs a record of `binding` at `relay` (its node key) for the connection of `nonce` (the relay's challenge). */
export function signManagedRecord(key: ManagedKey, binding: ManagedBinding, relay: Uint8Array, issuedAt: number, nonce: Uint8Array): ManagedRecord {
  const body = { key: binding, relay, issuedAt, nonce, signer: managedSignerOf(key) };
  return { ...body, signature: signBy(key, managedRecordMessage(body)) };
}
