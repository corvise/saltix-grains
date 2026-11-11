// Relay tickets (Saltix 41-transport §18), byte for byte the node's `relay::tickets` (vectors/relay-tickets-v1.json): a
// relay's own signed record (09-relay §1.3) with the network it serves, `SALARIUM-RELAY:` and base32. A client finds relays
// by them without any public list, and checks each one itself — the signature of the record's node key, its bounds,
// its age and its network — never the word of the relay that handed it out.
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { Reader, Writer, concat, derive, fromBase32, fromBase64, fromHex, toBase32, toBase64, toHex } from "./bytes.js";
import { verifyEd25519 } from "./keys.js";
import type { RelayEndpoint } from "./relay.js";

/** What a ticket's text starts with (either case). */
export const TICKET_PREFIX = "SALARIUM-RELAY:";
/** A ticket serves this long after its record's `issued_at`. */
export const TICKET_LIFE_MS = 30 * 86_400_000;
/** The tickets of other relays one `relay_tickets` answer gives at most; the answering relay's own comes beside them. */
export const TICKETS = 5;
/** What `relay_tickets` seals its answer under to the requester's one-time key. */
export const TICKETS_SEAL_DOMAIN = "Salarium relay tickets seal v1";

const VERSION = 1;
/** A ticket longer than this is refused before decoding: the largest record the bounds allow (version 3, a 64-byte peer
 *  id, four 200-byte endpoints with pins, fragment space and a country: 1135 bytes) makes a ticket of 1145. */
export const MAX_TICKET_BYTES = 1152;
const FUTURE_SKEW_MS = 10 * 60_000;
const MAX_PEER_ID = 64;
const MAX_ENDPOINTS = 4;
const MAX_ENDPOINT_BYTES = 200;
const RECORD_DOMAIN: Record<2 | 3, string> = { 2: "Salarium relay record v2", 3: "Salarium relay record v3" };

/** Why a reader refuses a ticket, in the order it checks (41-transport §18.3). */
export type TicketReason = "prefix" | "encoding" | "version" | "network" | "record" | "bounds" | "signature" | "future" | "expired" | "unreachable";

const WORDS: Record<TicketReason, string> = {
  prefix: "not a relay ticket (one starts with SALARIUM-RELAY:)",
  encoding: "not base32, or over 1 152 bytes",
  version: "a ticket of a version this SDK does not know",
  network: "a ticket of another network",
  record: "its record does not decode",
  bounds: "its record's fields are out of bounds",
  signature: "its record's signature does not verify (cut short or changed?)",
  future: "dated more than 10 minutes ahead of this computer's clock: check the clock's time and time zone",
  expired: "past its life of 30 days: ask whoever gave it for a new one",
  unreachable: "the relay names no endpoint",
};

/** The whitespace Rust's `str::trim` removes (Unicode's White_Space), and only it: JavaScript's `trim` also takes
 *  U+FEFF and leaves U+0085, so a text one reader takes the other would refuse. */
const RUST_SPACE = "\t\n\u000b\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const TRIM = new RegExp(`^[${RUST_SPACE}]+|[${RUST_SPACE}]+$`, "g");

/** `text` without the whitespace around it, as Rust trims it. */
const trimmed = (text: string): string => text.replace(TRIM, "");

/** `text` with ASCII's lower-case letters in upper case and nothing else changed (`to_ascii_uppercase`): JavaScript's
 *  `toUpperCase` makes `ſ` an S and `ı` an I, which Rust's reader refuses. */
const asciiUpper = (text: string): string => text.replace(/[a-z]+/g, (letters) => letters.toUpperCase());

export class TicketRefused extends Error {
  constructor(readonly reason: TicketReason) {
    super(`relay ticket refused: ${WORDS[reason]} (${reason})`);
    this.name = "TicketRefused";
  }
}

/** A ticket a reader took: the relay's node key, its endpoints with their pins, and its life. */
export interface RelayTicket {
  /** The ticket's text, as the node writes it. */
  text: string;
  /** The first 8 bytes of the network's genesis hash, hex. */
  network: string;
  recordVersion: 2 | 3;
  /** The relay's node key, hex. */
  nodeKey: string;
  issuedAt: number;
  expiresAt: number;
  endpoints: RelayEndpoint[];
  /** The space it offers the archive's fragments, GiB (a version 3 record's `store`); null for a version 2 record. */
  store: number | null;
}

interface Record_ {
  version: 2 | 3;
  nodeKey: Uint8Array;
  peerId: Uint8Array;
  endpoints: Array<{ url: string; pin: Uint8Array | null }>;
  issuedAt: bigint;
  store: bigint;
  country: Uint8Array | null;
  body: Uint8Array;
  signature: Uint8Array;
}

/** A relay record in `version`'s layout, nothing left over (the node's `RelayRecord::decode`, by the version named). */
function decodeRecord(bytes: Uint8Array, version: number): Record_ {
  if (version !== 2 && version !== 3) throw new TicketRefused("record");
  try {
    const r = new Reader(bytes);
    const nodeKey = r.fixed(32);
    const peerId = r.fixed(r.u32());
    const endpoints = r.vec((x) => ({ url: x.string(), pin: x.option((y) => y.fixed(32)) }));
    const issuedAt = r.u64();
    const store = version === 3 ? r.u64() : 0n;
    const country = version === 3 ? r.option((x) => x.fixed(2)) : null;
    const bodyEnd = r.position;
    const signature = r.fixed(64);
    r.end();
    return { version, nodeKey, peerId, endpoints, issuedAt, store, country, body: bytes.slice(0, bodyEnd), signature };
  } catch (e) {
    if (e instanceof TicketRefused) throw e;
    throw new TicketRefused("record");
  }
}

/** The record's own checks, the node's `RelayRecord::check`: bounds, then the node key's signature, then its time
 *  (none at `now: null`). */
function checkRecord(record: Record_, now: number | null): void {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (record.peerId.length === 0 || record.peerId.length > MAX_PEER_ID || record.endpoints.length > MAX_ENDPOINTS ||
    record.endpoints.some((e) => bytes(e.url) > MAX_ENDPOINT_BYTES || !e.url.startsWith("wss://") || e.url.length === "wss://".length) ||
    (record.country !== null && ![...record.country].every((c) => c >= 0x41 && c <= 0x5a))) {
    throw new TicketRefused("bounds");
  }
  if (!verifyEd25519(record.nodeKey, derive(RECORD_DOMAIN[record.version], record.body), record.signature)) {
    throw new TicketRefused("signature");
  }
  if (now !== null && record.issuedAt > BigInt(now) + BigInt(FUTURE_SKEW_MS)) throw new TicketRefused("future");
}

/**
 * Read a ticket (41-transport §18.3) at `now`, for the network of `genesis` when it is known (64 hex, or its first 16):
 * the relay's endpoints and pins, or a `TicketRefused` naming the first check that failed, in the readers' order, byte for
 * byte as the node reads it (ASCII's case and Rust's whitespace only). `now: null` checks everything but the time
 * (`future`, `expired`): what a ticket given at start must pass whenever it is used.
 */
export function readTicket(text: string, options: { genesis?: string | null; now?: number | null } = {}): RelayTicket {
  const now = options.now === undefined ? Date.now() : options.now;
  const given = trimmed(text);
  if (asciiUpper(given.slice(0, TICKET_PREFIX.length)) !== TICKET_PREFIX) throw new TicketRefused("prefix");
  const body = given.slice(TICKET_PREFIX.length);
  // Bytes, as the node counts them: a letter outside ASCII is two or more.
  if (new TextEncoder().encode(body).length > Math.floor((MAX_TICKET_BYTES * 8) / 5) + 1) throw new TicketRefused("encoding");
  const bytes = fromBase32(asciiUpper(body));
  if (bytes === null || bytes.length > MAX_TICKET_BYTES || bytes.length === 0) throw new TicketRefused("encoding");
  if (bytes[0] !== VERSION) throw new TicketRefused("version");
  const network = options.genesis ? options.genesis.slice(0, 16).toLowerCase() : null;
  if (network !== null && bytes.length >= 9 && toHex(bytes.subarray(1, 9)) !== network) throw new TicketRefused("network");
  if (bytes.length < 10) throw new TicketRefused("record");
  const record = decodeRecord(bytes.subarray(10), bytes[9]!);
  checkRecord(record, now);
  if (now !== null && record.issuedAt + BigInt(TICKET_LIFE_MS) < BigInt(now)) throw new TicketRefused("expired");
  if (record.endpoints.length === 0) throw new TicketRefused("unreachable");
  const issuedAt = Number(record.issuedAt);
  return {
    text: `${TICKET_PREFIX}${toBase32(bytes)}`,
    network: toHex(bytes.subarray(1, 9)),
    recordVersion: record.version,
    nodeKey: toHex(record.nodeKey),
    issuedAt,
    expiresAt: issuedAt + TICKET_LIFE_MS,
    endpoints: record.endpoints.map((e) => ({ url: e.url, cert_sha256: e.pin === null ? null : toHex(e.pin) })),
    store: record.version === 3 ? Number(record.store) : null,
  };
}

/** Why `text` is not a ticket a reader takes at `now` for `genesis`, or null. */
export function ticketProblem(text: string, options: { genesis?: string | null; now?: number | null } = {}): TicketReason | null {
  try {
    readTicket(text, options);
    return null;
  } catch (e) {
    if (e instanceof TicketRefused) return e.reason;
    throw e;
  }
}

/** Whether `text` reads as a ticket's (by its prefix alone, as `readTicket` reads it): `--relay` takes a ticket or an
 *  endpoint. */
export function isTicketText(text: string): boolean {
  return asciiUpper(trimmed(text).slice(0, TICKET_PREFIX.length)) === TICKET_PREFIX;
}

/**
 * A relay record signed by `secret` (an Ed25519 secret) as a ticket of the network of `genesis`: what a relay hands out,
 * for tests and a development network (a real relay signs its own with its node key). Version 2, or version 3 when it
 * offers `store` GiB (no country).
 */
export function signRelayTicket(input: {
  secret: Uint8Array; genesis: string; endpoints: RelayEndpoint[]; issuedAt: number; peerId?: Uint8Array; store?: number;
}): string {
  const version = input.store === undefined ? 2 : 3;
  const nodeKey = ed25519.getPublicKey(input.secret);
  const w = new Writer().fixed(nodeKey, 32).bytes(input.peerId ?? Uint8Array.of(0, 36, 8, 1, 18, 32, ...nodeKey));
  w.u32(input.endpoints.length);
  for (const e of input.endpoints) {
    w.string(e.url).option(e.cert_sha256, (x, pin) => x.fixed(fromHex(pin, 32), 32));
  }
  w.u64(input.issuedAt);
  if (version === 3) w.u64(input.store!).option(null, () => {});
  const body = w.done();
  const signature = ed25519.sign(derive(RECORD_DOMAIN[version], body), input.secret);
  return `${TICKET_PREFIX}${toBase32(concat(Uint8Array.of(VERSION), fromHex(input.genesis.slice(0, 16), 8), Uint8Array.of(version), body, signature))}`;
}

/** A fresh one-time X25519 key for `relay_tickets`: the secret stays here, the public half goes in the request. */
export function ticketsKey(): { secret: Uint8Array; key: string } {
  const secret = x25519.utils.randomPrivateKey();
  return { secret, key: toHex(x25519.getPublicKey(secret)) };
}

/** `answer` sealed to the requester's one-time `key` (hex) for the network of `genesis`, as a relay seals it
 *  (`openTicketsAnswer` opens it): for tests and a development relay. `oneTime` only for vectors. */
export function sealTicketsAnswer(answer: unknown, key: string, genesis: string, oneTime: Uint8Array = x25519.utils.randomPrivateKey()): string {
  const recipient = fromHex(key, 32);
  const ephemeral = x25519.getPublicKey(oneTime);
  const shared = x25519.getSharedSecret(oneTime, recipient);
  if (shared.every((b) => b === 0)) throw new TypeError("key: no shared secret");
  const cipher = xchacha20poly1305(derive(TICKETS_SEAL_DOMAIN, shared, ephemeral, recipient), new Uint8Array(24), fromHex(genesis, 32));
  return toBase64(concat(ephemeral, cipher.encrypt(new TextEncoder().encode(JSON.stringify(answer)))), true);
}

/**
 * Open `relay_tickets`' sealed answer (41-transport §18.4), the node's `saltix_crypto::sealed`: `E ‖ ciphertext`,
 * XChaCha20-Poly1305 under BLAKE3 derive_key("Salarium relay tickets seal v1", S ‖ E ‖ R) with 24 zero bytes of nonce and
 * the network's genesis hash as associated data. Null when it does not open (another key, another network, changed).
 */
export function openTicketsAnswer(sealed: string, secret: Uint8Array, genesis: string): unknown | null {
  try {
    const bytes = fromBase64(sealed, true);
    if (bytes.length < 32 + 16) return null;
    const ephemeral = bytes.slice(0, 32);
    const shared = x25519.getSharedSecret(secret, ephemeral);
    if (shared.every((b) => b === 0)) return null;
    const key = derive(TICKETS_SEAL_DOMAIN, shared, ephemeral, x25519.getPublicKey(secret));
    const plain = xchacha20poly1305(key, new Uint8Array(24), fromHex(genesis, 32)).decrypt(bytes.slice(32));
    return JSON.parse(new TextDecoder().decode(plain)) as unknown;
  } catch {
    return null;
  }
}
