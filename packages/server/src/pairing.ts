// Pairing an app's server with its owner's Saltix by a QR code (Saltix 24-app-studio §3a,
// docs/protocol/app-studio.md#3a-pairing-a-server-by-qr-code). The server key is made on the computer that runs the
// app's program, and its secret never leaves it:
//
// - the computer shows a pairing offer (`PairingOffer`: the network, the key's public half, a nonce, the app its project
//   is set up for, a name for a new app, how long it lives) as a QR code of its link `salt:grain-pair?o=…`, with a
//   6-digit code to compare on both screens;
// - the owner's Saltix scans it and asks the computer through the relays, from the owner's grain alias in the app, with
//   a `PairRequest` ("SGP1" frames, sealed as grain frames are);
// - the computer judges the request (`judgePair`) and answers (`answerPair`); an accepted answer carries the key's proof
//   for that app and owner, the `ServerKeyProof` a version 2 `ConfigureGrain` needs;
// - Saltix checks it (`checkPairAnswer`) and names the key in the registry.
//
// Byte for byte the reference's (`saltix_types::grain::pairing`, vectors/server-pairing-v1.json). Nothing here is secret
// but the server key, which only `answerPair` takes. No Node APIs.
import { ed25519 } from "@noble/curves/ed25519";
import { type NetworkName, accountId, encodeAddress } from "./address.js";
import { Reader, Writer, concat, derive, fromBase64, fromHex, toBase64, toHex } from "./bytes.js";
import { ed25519KeyValid, verifyEd25519 } from "./keys.js";
import { refusedChar } from "./profile.js";

/** The domain of an offer's code. */
export const PAIRING_CODE_DOMAIN = "Saltix grain pairing code v1";
/** The domain a server key signs its proof for an app and owner under (24-app-studio §2). */
export const SERVER_KEY_DOMAIN = "Saltix grain server v1";
/** The only version of an offer. */
export const PAIR_OFFER_VERSION = 1;
/** An offer lives at most 30 minutes after it is made (`PAIR_OFFER_LIFE`), ms. */
export const PAIR_OFFER_LIFE_MS = 30 * 60_000;
/** How far ahead of a reader's clock an offer may have been made, ms. */
export const PAIR_SKEW_MS = 5 * 60_000;
/** How long Saltix waits for the computer's answer (`PAIR_ANSWER_WAIT`), ms. */
export const PAIR_ANSWER_WAIT_MS = 2 * 60_000;
/** A new app's name in an offer, at most, in characters. */
export const MAX_PAIR_NAME = 32;
/** What an offer's link starts with. */
export const PAIR_LINK_PREFIX = "salt:grain-pair?o=";
/** What the plaintext of every pairing frame starts with. */
export const PAIR_FRAME_MAGIC = new TextEncoder().encode("SGP1");

const HRP: Record<NetworkName, string> = { mainnet: "salt", testnet: "tsalt", devnet: "dsalt" };
const slugOk = (slug: string) => /^[a-z0-9][a-z0-9-]{2,31}$/.test(slug);

/** "Name this server key for an app": what the computer shows. Keys and ids are lower-case hex; times Unix ms. */
export interface PairingOffer {
  version: number;
  /** The network's address prefix: `salt`, `tsalt` or `dsalt`. */
  hrp: string;
  /** The first 8 bytes of the network's genesis hash (16 hex). */
  genesis: string;
  /** The server key's Ed25519 public key. */
  key: string;
  /** Random, 16 bytes: the offer's id. */
  nonce: string;
  /** The app the computer is set up for, or null. */
  slug: string | null;
  /** What to call a new app: at most 32 characters, or "". */
  name: string;
  createdAt: number;
  expiresAt: number;
}

/** The owner's Saltix asks for the key's proof for `owner`'s (an account, hex) app `slug`. */
export interface PairRequest {
  /** The offer's nonce. */
  offer: string;
  slug: string;
  owner: string;
}

/** What the computer did with a request, by number. */
export const PAIR_RESULTS = ["accepted", "used", "expired", "unknown", "other_app", "not_owner"] as const;
export type PairResult = (typeof PAIR_RESULTS)[number];

/** The computer's answer; `proof` (64 bytes, hex) is there with `accepted` and with nothing else. */
export interface PairAnswer {
  offer: string;
  slug: string;
  owner: string;
  result: PairResult;
  proof: string | null;
}

export type PairFrame = { request: PairRequest } | { answer: PairAnswer };

/** The registry's record of a request's slug, as the computer reads it. */
export interface SlugRecord {
  owner: string;
  retired: boolean;
}

/** Why an offer, a frame or an answer is refused, as the reference names it. */
export type PairingProblem =
  | "not_pairing" | "malformed" | "version" | "unknown_network" | "key" | "slug" | "name" | "life" | "expired" | "ahead"
  | "other_network" | "mismatch" | "proof";

const EXPLAINED: Record<PairingProblem, string> = {
  not_pairing: "not a pairing offer's link or a pairing frame",
  malformed: "a malformed or non-canonical pairing offer, request or answer",
  version: "an offer of an unknown version",
  unknown_network: "an offer of an unknown network",
  key: "the offer's key is not a valid Ed25519 public key",
  slug: "the slug names no app",
  name: "a new app's name is at most 32 characters, with no control or format characters",
  life: "an offer expires after it is made, and at most 30 minutes after",
  expired: "the offer has expired",
  ahead: "the offer was made ahead of this clock",
  other_network: "the offer is for another network",
  mismatch: "the answer is for another request",
  proof: "the answer's proof does not verify under the offer's key",
};

/** An offer, a frame or an answer refused; `problem` is the reference's reason. */
export class PairingError extends Error {
  constructor(readonly problem: PairingProblem) {
    super(EXPLAINED[problem]);
    this.name = "PairingError";
  }
}

/** A server key's fingerprint, where people tell keys apart: its first 4 bytes in lower-case hex. */
export const keyFingerprint = (key: string): string => key.slice(0, 8);

/** The network an `hrp` names, or null. */
export function networkOfHrp(hrp: string): NetworkName | null {
  return (Object.keys(HRP) as NetworkName[]).find((n) => HRP[n] === hrp) ?? null;
}

function nameOk(name: string): boolean {
  const chars = [...name];
  return chars.length <= MAX_PAIR_NAME && chars.every((c) => !refusedChar(c.codePointAt(0)!));
}

/** Why `offer` is out of form (what every reader requires first), or null. */
export function offerFormProblem(offer: PairingOffer): PairingProblem | null {
  if (offer.version !== PAIR_OFFER_VERSION) return "version";
  if (networkOfHrp(offer.hrp) === null) return "unknown_network";
  if (!/^[0-9a-f]{64}$/.test(offer.key) || !ed25519KeyValid(fromHex(offer.key, 32))) return "key";
  if (offer.slug !== null && !slugOk(offer.slug)) return "slug";
  if (!nameOk(offer.name)) return "name";
  if (offer.expiresAt <= offer.createdAt || offer.expiresAt - offer.createdAt > PAIR_OFFER_LIFE_MS) return "life";
  return null;
}

/** The offer of the server key `key` (hex) on the network of `genesis` (its hash, hex), made at `createdAt` for the
 *  longest life. Throws a `PairingError` for one out of form (a name too long, a slug that is no app's). */
export function makeOffer(o: {
  network: NetworkName; genesis: string; key: string; nonce: string; slug: string | null; name: string; createdAt: number;
}): PairingOffer {
  if (!/^[0-9a-f]{64}$/.test(o.genesis)) throw new TypeError("genesis: the genesis hash, 64 lower-case hex");
  if (!/^[0-9a-f]{32}$/.test(o.nonce)) throw new TypeError("nonce: 16 bytes, lower-case hex");
  const offer: PairingOffer = {
    version: PAIR_OFFER_VERSION, hrp: HRP[o.network], genesis: o.genesis.slice(0, 16), key: o.key, nonce: o.nonce,
    slug: o.slug, name: o.name, createdAt: o.createdAt, expiresAt: o.createdAt + PAIR_OFFER_LIFE_MS,
  };
  const problem = offerFormProblem(offer);
  if (problem) throw new PairingError(problem);
  return offer;
}

/** Why a wallet on `network` (its genesis hash, hex) would refuse `offer` at `now`, or null: out of form, another
 *  network or genesis, made more than 5 minutes ahead, expired; in that order. */
export function offerProblem(offer: PairingOffer, network: NetworkName, genesis: string, now: number): PairingProblem | null {
  const form = offerFormProblem(offer);
  if (form) return form;
  if (networkOfHrp(offer.hrp) !== network || offer.genesis !== genesis.slice(0, 16)) return "other_network";
  if (offer.createdAt > now + PAIR_SKEW_MS) return "ahead";
  if (now >= offer.expiresAt) return "expired";
  return null;
}

/** Borsh(PairingOffer). */
export function encodeOffer(offer: PairingOffer): Uint8Array {
  return new Writer()
    .u8(offer.version).string(offer.hrp).fixed(fromHex(offer.genesis, 8), 8).fixed(fromHex(offer.key, 32), 32)
    .fixed(fromHex(offer.nonce, 16), 16).option(offer.slug, (w, s) => w.string(s)).string(offer.name)
    .u64(offer.createdAt).u64(offer.expiresAt).done();
}

/** Read exactly the Borsh form, of form; throws a `PairingError`. */
export function decodeOffer(bytes: Uint8Array): PairingOffer {
  let offer: PairingOffer;
  try {
    const r = new Reader(bytes);
    offer = {
      version: r.u8(), hrp: r.string(), genesis: toHex(r.fixed(8)), key: toHex(r.fixed(32)), nonce: toHex(r.fixed(16)),
      slug: r.option((x) => x.string()), name: r.string(), createdAt: r.u64n(), expiresAt: r.u64n(),
    };
    r.end();
  } catch {
    throw new PairingError("malformed");
  }
  const problem = offerFormProblem(offer);
  if (problem) throw new PairingError(problem);
  return offer;
}

/** `salt:grain-pair?o=<base64url without padding of its Borsh>`: what the QR code holds. */
export const offerLink = (offer: PairingOffer): string => PAIR_LINK_PREFIX + toBase64(encodeOffer(offer), true);

/** Read a link: exactly the form `offerLink` writes, white space around it allowed; throws a `PairingError`. */
export function parseOfferLink(text: string): PairingOffer {
  const body = text.trim();
  if (!body.startsWith(PAIR_LINK_PREFIX)) throw new PairingError("not_pairing");
  const encoded = body.slice(PAIR_LINK_PREFIX.length);
  let bytes: Uint8Array;
  try {
    if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error("not base64url without padding");
    bytes = fromBase64(encoded, true);
  } catch {
    throw new PairingError("malformed");
  }
  return decodeOffer(bytes);
}

/** The code both screens show: the first 4 bytes of derive_key("Saltix grain pairing code v1", Borsh(offer)) as a
 *  big-endian u32, modulo 1 000 000. */
export function offerCode(offer: PairingOffer): number {
  const digest = derive(PAIRING_CODE_DOMAIN, encodeOffer(offer));
  return new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0, false) % 1_000_000;
}

/** The code as people read it: six digits in two groups, `482 913`. */
export function offerCodeText(offer: PairingOffer): string {
  const digits = String(offerCode(offer)).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** The server key's personal address on the offer's network: where Saltix sends its request. */
export function offerAddress(offer: PairingOffer): string {
  const network = networkOfHrp(offer.hrp);
  if (network === null) throw new PairingError("unknown_network");
  return encodeAddress(network, accountId(fromHex(offer.key, 32)));
}

/** What a server key signs for `owner`'s (hex account) app `slug` on the chain of `genesis` (hash, hex):
 *  Borsh((genesis_hash, slug, owner)). */
export const serverKeyProofPayload = (genesis: string, slug: string, owner: string): Uint8Array =>
  new Writer().fixed(fromHex(genesis, 32), 32).string(slug).fixed(fromHex(owner, 32), 32).done();

/** The server key `secret`'s proof that it serves `owner`'s app `slug` (hex, 64 bytes). */
export function signServerKeyProof(secret: Uint8Array, genesis: string, slug: string, owner: string): string {
  return toHex(ed25519.sign(derive(SERVER_KEY_DOMAIN, serverKeyProofPayload(genesis, slug, owner)), secret));
}

/** Whether `proof` is `key`'s for `owner`'s app `slug` on the chain of `genesis` (strict Ed25519). */
export function verifyServerKeyProof(key: string, proof: string, genesis: string, slug: string, owner: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{128}$/.test(proof)) return false;
  return verifyEd25519(fromHex(key, 32), derive(SERVER_KEY_DOMAIN, serverKeyProofPayload(genesis, slug, owner)), fromHex(proof, 64));
}

const resultOf = (n: number): PairResult => {
  const result = PAIR_RESULTS[n];
  if (result === undefined) throw new TypeError("an unknown result");
  return result;
};

/** "SGP1" ‖ Borsh(PairFrame): the plaintext that is sealed. */
export function encodePairFrame(frame: PairFrame): Uint8Array {
  const w = new Writer();
  if ("request" in frame) {
    const q = frame.request;
    w.u8(0).fixed(fromHex(q.offer, 16), 16).string(q.slug).fixed(fromHex(q.owner, 32), 32);
  } else {
    const a = frame.answer;
    w.u8(1).fixed(fromHex(a.offer, 16), 16).string(a.slug).fixed(fromHex(a.owner, 32), 32).u8(PAIR_RESULTS.indexOf(a.result))
      .option(a.proof, (x, p) => x.fixed(fromHex(p, 64), 64));
  }
  return concat(PAIR_FRAME_MAGIC, w.done());
}

/** Read a plaintext `encodePairFrame` writes, of form; throws a `PairingError` (`not_pairing` for another magic). */
export function decodePairFrame(bytes: Uint8Array): PairFrame {
  if (bytes.length < 4 || PAIR_FRAME_MAGIC.some((b, i) => bytes[i] !== b)) throw new PairingError("not_pairing");
  let frame: PairFrame;
  try {
    const r = new Reader(bytes.subarray(4));
    const tag = r.u8();
    const offer = toHex(r.fixed(16));
    const slug = r.string();
    const owner = toHex(r.fixed(32));
    if (tag === 0) frame = { request: { offer, slug, owner } };
    else if (tag === 1) frame = { answer: { offer, slug, owner, result: resultOf(r.u8()), proof: r.option((x) => toHex(x.fixed(64))) } };
    else throw new TypeError("an unknown tag");
    r.end();
  } catch {
    throw new PairingError("malformed");
  }
  const body = "request" in frame ? frame.request : frame.answer;
  if (!slugOk(body.slug)) throw new PairingError("slug");
  if ("answer" in frame && (frame.answer.proof !== null) !== (frame.answer.result === "accepted")) throw new PairingError("malformed");
  return frame;
}

/**
 * What the computer that shows `offer` answers `request` at `now` (24-app-studio §3a). `answered`: the slug and owner it
 * already answered this offer for, if any; `record`: the registry's record of the request's slug, if there is one. In
 * order: another offer's nonce, `unknown`; answered already, `accepted` again for the same slug and owner (even past the
 * expiry) and `used` for any other; expired, `expired`; the offer names a slug and the request another, `other_app`;
 * the registry holds the slug for another account, or retired, `not_owner`; otherwise `accepted`.
 */
export function judgePair(offer: PairingOffer, answered: { slug: string; owner: string } | null, record: SlugRecord | null,
  request: PairRequest, now: number): PairResult {
  if (request.offer !== offer.nonce) return "unknown";
  if (answered) return answered.slug === request.slug && answered.owner === request.owner ? "accepted" : "used";
  if (now >= offer.expiresAt) return "expired";
  if (offer.slug !== null && offer.slug !== request.slug) return "other_app";
  if (record && (record.retired || record.owner !== request.owner)) return "not_owner";
  return "accepted";
}

/** The answer of the server key `secret` on the chain of `genesis` (hash, hex) to `request`: with the key's proof for
 *  the request's slug and owner when `result` is `accepted`. */
export function answerPair(secret: Uint8Array, genesis: string, request: PairRequest, result: PairResult): PairAnswer {
  return {
    offer: request.offer, slug: request.slug, owner: request.owner, result,
    proof: result === "accepted" ? signServerKeyProof(secret, genesis, request.slug, request.owner) : null,
  };
}

/** Saltix's check of an answer to `request` about `offer` on the chain of `genesis` (hash, hex): for this request,
 *  and, when accepted, with a proof that verifies under the offer's key. The proof (hex) of an accepted answer; null for
 *  any other. Throws a `PairingError` (`mismatch`, `proof`). */
export function checkPairAnswer(answer: PairAnswer, genesis: string, offer: PairingOffer, request: PairRequest): string | null {
  if (answer.offer !== request.offer || answer.offer !== offer.nonce || answer.slug !== request.slug || answer.owner !== request.owner) {
    throw new PairingError("mismatch");
  }
  if (answer.proof === null) return null;
  if (!verifyServerKeyProof(offer.key, answer.proof, genesis, answer.slug, answer.owner)) throw new PairingError("proof");
  return answer.proof;
}
