// Pairing an app's server with its owner's Saltix by a QR code (Saltix 24-app-studio §3a, version 2;
// docs/protocol/app-studio.md#3a-pairing-a-server-by-qr-code). The server key is made on the computer that runs the
// app's program, and its secret never leaves it:
//
// - the app's page in Saltix shows one command naming three public facts, the `PairTarget`: the app, its owner and the
//   network (`pairCommand`, `parsePairCommand`); nothing in it is secret;
// - the computer signs the key's proof for that app and owner (`signServerKeyProof`: the very `ServerKeyProof` a
//   `ConfigureGrain` of tag 39 needs) and shows a `PairingOffer` (`makeOffer`): the key, the proof, the app, the owner,
//   the network, a name for the server, a nonce and the times; as a QR code of its link `salt:grain-pair?o=…`
//   (`offerLink`), with a 6-digit code to compare on both screens (`offerCode`);
// - the owner's Saltix scans it and checks everything by itself (`offerProblem`: the form, its network, the clock, the
//   owner is this account, the proof) and what the slug is to it (`judgeSlug`), then names the key in the registry with
//   the proof as the offer carried it (`offerProof`);
// - the computer watches the registry until the record names its key: no frame travels either way. Version 1's exchange
//   through the relays (the `SGP1` frames) went with version 1; an offer of version 1 is read for its version only, to say
//   that it is from an older SDK.
//
// Byte for byte the reference's (`saltix_types::grain::pairing`, vectors/server-pairing-v2.json). Nothing here is secret
// but the server key's secret, which only `makeOffer` takes, to sign the proof. No Node APIs.
import { ed25519 } from "@noble/curves/ed25519";
import { type NetworkName, accountId, decodeAddress, encodeAddress } from "./address.js";
import { Reader, Writer, derive, fromBase64, fromHex, toBase64, toHex } from "./bytes.js";
import { ed25519KeyValid, verifyEd25519 } from "./keys.js";
import { grainOwnerPayload, refusedChar } from "./profile.js";
import type { RegisteredGrain } from "./registry.js";

/** The domain of an offer's code. */
export const PAIRING_CODE_DOMAIN = "Saltix grain pairing code v1";
/** The domain a server key signs its proof for an app and owner under (24-app-studio §2). */
export const SERVER_KEY_DOMAIN = "Saltix grain server v1";
/** The version of an offer this SDK makes and takes. */
export const PAIR_OFFER_VERSION = 2;
/** An offer lives at most 30 minutes after it is made (`PAIR_OFFER_LIFE`), ms. */
export const PAIR_OFFER_LIFE_MS = 30 * 60_000;
/** How far ahead of a reader's clock an offer may have been made (`PAIR_SKEW`), ms. */
export const PAIR_SKEW_MS = 5 * 60_000;
/** The server's name in an offer, at most, in characters. */
export const MAX_PAIR_NAME = 32;
/** What an offer's link starts with. */
export const PAIR_LINK_PREFIX = "salt:grain-pair?o=";
/** The SDK's command the app's page shows, before the target's three fields. */
export const PAIR_COMMAND = "grain pair";

const HRP: Record<NetworkName, string> = { mainnet: "salt", testnet: "tsalt", devnet: "dsalt" };
const slugOk = (slug: string) => /^[a-z0-9][a-z0-9-]{2,31}$/.test(slug);
const lowerHex = (text: string, bytes: number) => new RegExp(`^[0-9a-f]{${2 * bytes}}$`).test(text);

/** The three public facts the command from the app's page names (§3a, *The command*): the app, its owner and the
 *  network. Without them the computer cannot make an offer; with them, it signs the key's proof before it shows one. */
export interface PairTarget {
  slug: string;
  /** The owner's address: its prefix names the network, its id is the offer's owner (of kind 0 or kind 5 alike). */
  owner: string;
  /** The first 8 bytes of the network's genesis hash, 16 hex. */
  genesis: string;
}

/** "Name this server key for an app": what the computer shows. Keys, ids and the proof are lower-case hex; times
 *  Unix ms. Nothing in it is secret, and nothing is signed but the proof. */
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
  /** The app. */
  slug: string;
  /** The owner's account (32 bytes). */
  owner: string;
  /** `ServerKeyProof.proof` by `key` for the network, `slug` and `owner` (24-app-studio §2), 64 bytes. */
  proof: string;
  /** What to call this server: at most 32 characters, or "". */
  name: string;
  createdAt: number;
  expiresAt: number;
}

/** The registry's record of a slug as a reader has it (`grain_get`): the owner (hex account), whether it is retired,
 *  the server keys it names. */
export interface SlugRecord {
  owner: string;
  retired: boolean;
  servers: string[];
}

/** What an offer's slug is to the owner the offer names, from the registry's record of it (§3a): no grain of that
 *  slug (`free`: a new app made in place); the owner's live app (`own`); one that names the key already
 *  (`paired_already`: nothing to sign); another account's; the owner's own, retired. */
export const SLUG_VERDICTS = ["free", "own", "paired_already", "another_account", "retired"] as const;
export type SlugVerdict = (typeof SLUG_VERDICTS)[number];

/** Whether a verdict leaves something to sign: a new app, or the owner's own app that does not name the key yet. */
export const verdictPairs = (verdict: SlugVerdict): boolean => verdict === "free" || verdict === "own";

/** Why an offer or a command is refused, as the reference names it. */
export type PairingProblem =
  | "not_pairing" | "malformed" | "version" | "unknown_network" | "key" | "slug" | "name" | "life" | "other_network" | "ahead"
  | "expired" | "other_owner" | "proof";

const EXPLAINED: Record<Exclude<PairingProblem, "version">, string> = {
  not_pairing: "not a pairing offer's link, nor the pairing command",
  malformed: "a malformed or non-canonical pairing offer or command",
  unknown_network: "an offer of an unknown network",
  key: "the offer's key is not a valid Ed25519 public key",
  slug: "the slug names no app: 3 to 32 of [a-z0-9-], not starting with -",
  name: "a server's name is at most 32 characters, with no control or format characters",
  life: "an offer expires after it is made, and at most 30 minutes after",
  other_network: "this computer is set up for another network",
  ahead: "the offer was made ahead of this clock",
  expired: "the offer has expired: run `grain pair` again for a new one",
  other_owner: "this computer is set up for another owner",
  proof: "the offer's proof does not verify: run `grain pair` again",
};

/** What a reader says of an offer of another version (24-app-studio §3a): below this SDK's, from an older SDK; above,
 *  from a newer one than this reader. */
export function versionMessage(version: number): string {
  return version < PAIR_OFFER_VERSION
    ? "this offer is from an older SDK: update it and run `grain pair` again"
    : "an offer of an unknown version: update Saltix";
}

/** An offer or a command refused; `problem` is the reference's reason, and for `version` the offer's version says
 *  which side is to update. */
export class PairingError extends Error {
  constructor(readonly problem: PairingProblem, readonly version?: number) {
    super(problem === "version" ? versionMessage(version ?? PAIR_OFFER_VERSION + 1) : EXPLAINED[problem]);
    this.name = "PairingError";
  }
}

/** A server key's fingerprint, where people tell keys apart: its first 4 bytes in lower-case hex. */
export const keyFingerprint = (key: string): string => key.slice(0, 8);

/** The network an `hrp` names, or null. */
export function networkOfHrp(hrp: string): NetworkName | null {
  return (Object.keys(HRP) as NetworkName[]).find((n) => HRP[n] === hrp) ?? null;
}

/** The address prefix of a network. */
export const hrpOf = (network: NetworkName): string => HRP[network];

function nameOk(name: string): boolean {
  if (/\p{Cs}/u.test(name)) return false;
  const chars = [...name];
  return chars.length <= MAX_PAIR_NAME && chars.every((c) => !refusedChar(c.codePointAt(0)!));
}

/** What `address` names, in its canonical form; throws a `PairingError`: `unknown_network` for a prefix no network has,
 *  `malformed` for anything else that is not an address. */
function addressOf(address: string): { network: NetworkName; kind: number; id: Uint8Array; text: string } {
  const decoded = decodeAddress(address);
  if (decoded) return { ...decoded, text: encodeAddress(decoded.network, decoded.id, decoded.kind) };
  const lower = address.toLowerCase();
  const sep = lower.lastIndexOf("1");
  throw new PairingError(sep > 0 && networkOfHrp(lower.slice(0, sep)) === null ? "unknown_network" : "malformed");
}

/** `grain pair --app <slug> --owner <address> --genesis <16 hex>`: what the app's page shows and a developer copies.
 *  The syntax is the SDK's; the three fields are the protocol's. */
export function pairCommand(target: PairTarget): string {
  return `${PAIR_COMMAND} --app ${target.slug} --owner ${target.owner} --genesis ${target.genesis}`;
}

/** Read a command: `grain pair` and the three flags, each with its value, each once, in any order, nothing else; white
 *  space around and between the words is free. The genesis is 16 lower-case hex digits; the address any kind's, of a
 *  known network (kept in its canonical form). Throws a `PairingError` (`not_pairing`, `malformed`, `slug`,
 *  `unknown_network`). */
export function parsePairCommand(text: string): PairTarget {
  const words = text.split(/\s+/).filter((w) => w !== "");
  const command = PAIR_COMMAND.split(" ");
  if (command.some((word, i) => words[i] !== word)) throw new PairingError("not_pairing");
  const values: Partial<Record<"app" | "owner" | "genesis", string>> = {};
  for (let i = command.length; i < words.length; i += 2) {
    const value = words[i + 1];
    if (value === undefined) throw new PairingError("malformed");
    const flag = words[i]!;
    const name = flag === "--app" ? "app" : flag === "--owner" ? "owner" : flag === "--genesis" ? "genesis" : null;
    if (name === null || values[name] !== undefined) throw new PairingError("malformed");
    values[name] = value;
  }
  const { app, owner, genesis } = values;
  if (app === undefined || owner === undefined || genesis === undefined) throw new PairingError("malformed");
  if (!slugOk(app)) throw new PairingError("slug");
  const address = addressOf(owner);
  if (!lowerHex(genesis, 8)) throw new PairingError("malformed");
  return { slug: app, owner: address.text, genesis };
}

/** The target of `owner`'s (an address) app `slug` on the chain of `network` and `genesis` (its hash, hex): the slug of
 *  form, the address of this network (throws a `PairingError`: `slug`, `malformed`, `unknown_network`,
 *  `other_network`). */
export function pairTarget(network: NetworkName, genesis: string, slug: string, owner: string): PairTarget {
  if (!slugOk(slug)) throw new PairingError("slug");
  const address = addressOf(owner);
  if (address.network !== network) throw new PairingError("other_network");
  return { slug, owner: address.text, genesis: genesis.slice(0, 16) };
}

/** The network the target's owner address names, or null when it is not an address. */
export function targetNetwork(target: PairTarget): NetworkName | null {
  return decodeAddress(target.owner)?.network ?? null;
}

/** The owner's account the target names (hex): the offer's `owner`. Throws a `PairingError` for an address out of form. */
export function targetOwner(target: PairTarget): string {
  return toHex(addressOf(target.owner).id);
}

/** Whether the target names the chain of `network` and `genesis` (its hash, or its first 8 bytes, hex). */
export function targetIsFor(target: PairTarget, network: NetworkName, genesis: string): boolean {
  return targetNetwork(target) === network && target.genesis === genesis.slice(0, 16);
}

/** What a server key signs for `owner`'s (hex account) app `slug` on the chain of `genesis` (hash, hex):
 *  Borsh((genesis_hash, slug, owner)), as a support address's consent does in a domain of its own (`grainOwnerPayload`). */
export const serverKeyProofPayload: (genesis: string, slug: string, owner: string) => Uint8Array = grainOwnerPayload;

/** The server key `secret`'s proof that it serves `owner`'s app `slug` (hex, 64 bytes): the `ServerKeyProof.proof` a
 *  `ConfigureGrain` of tag 39 carries (24-app-studio §2), and what a pairing offer carries. */
export function signServerKeyProof(secret: Uint8Array, genesis: string, slug: string, owner: string): string {
  return toHex(ed25519.sign(derive(SERVER_KEY_DOMAIN, serverKeyProofPayload(genesis, slug, owner)), secret));
}

/** Whether `proof` is `key`'s for `owner`'s app `slug` on the chain of `genesis` (strict Ed25519). */
export function verifyServerKeyProof(key: string, proof: string, genesis: string, slug: string, owner: string): boolean {
  if (!lowerHex(key, 32) || !lowerHex(proof, 64)) return false;
  return verifyEd25519(fromHex(key, 32), derive(SERVER_KEY_DOMAIN, serverKeyProofPayload(genesis, slug, owner)), fromHex(proof, 64));
}

/** Why `offer` is out of form (what every reader requires first), or null: its version, a known network, a valid key, a
 *  slug of form, a name within its bounds, a life within 30 minutes. The proof is the wallet's to check against its own
 *  genesis hash (`offerProblem`), not the form's. */
export function offerFormProblem(offer: PairingOffer): PairingProblem | null {
  if (offer.version !== PAIR_OFFER_VERSION) return "version";
  if (!lowerHex(offer.genesis, 8) || !lowerHex(offer.key, 32) || !lowerHex(offer.nonce, 16) || !lowerHex(offer.owner, 32) || !lowerHex(offer.proof, 64)) {
    return "malformed";
  }
  if (!Number.isSafeInteger(offer.createdAt) || !Number.isSafeInteger(offer.expiresAt) || offer.createdAt < 0 || offer.expiresAt < 0) return "malformed";
  if (networkOfHrp(offer.hrp) === null) return "unknown_network";
  if (!ed25519KeyValid(fromHex(offer.key, 32))) return "key";
  if (!slugOk(offer.slug)) return "slug";
  if (!nameOk(offer.name)) return "name";
  if (offer.expiresAt <= offer.createdAt || offer.expiresAt - offer.createdAt > PAIR_OFFER_LIFE_MS) return "life";
  return null;
}

/**
 * The offer of the server key `secret` for `target` on the chain of `network` and `genesis` (its hash, hex), the server
 * named `name`, made at `createdAt` for the longest life. The key signs its proof for the app and the owner
 * (`signServerKeyProof`: the very proof the owner's `ConfigureGrain` carries), which needs the chain's full genesis hash:
 * a target of another chain is refused (`PairingError` `other_network`), as is an offer out of form (`name`, `slug`).
 */
export function makeOffer(o: {
  network: NetworkName; genesis: string; secret: Uint8Array; target: PairTarget; nonce: string; name: string; createdAt: number;
}): PairingOffer {
  if (!lowerHex(o.genesis, 32)) throw new TypeError("genesis: the genesis hash, 64 lower-case hex");
  if (!lowerHex(o.nonce, 16)) throw new TypeError("nonce: 16 bytes, lower-case hex");
  if (o.secret.length !== 32) throw new TypeError("secret: the server key's 32-byte Ed25519 secret");
  if (!targetIsFor(o.target, o.network, o.genesis)) throw new PairingError("other_network");
  const owner = targetOwner(o.target);
  const offer: PairingOffer = {
    version: PAIR_OFFER_VERSION, hrp: HRP[o.network], genesis: o.genesis.slice(0, 16), key: toHex(ed25519.getPublicKey(o.secret)),
    nonce: o.nonce, slug: o.target.slug, owner, proof: signServerKeyProof(o.secret, o.genesis, o.target.slug, owner), name: o.name,
    createdAt: o.createdAt, expiresAt: o.createdAt + PAIR_OFFER_LIFE_MS,
  };
  const problem = offerFormProblem(offer);
  if (problem) throw new PairingError(problem, offer.version);
  return offer;
}

/**
 * Why the wallet of `account` (hex) on the chain of `network` and `genesis` (hash, hex) would refuse `offer` at `now`, or
 * null, in the order §3a names: out of form; another network or genesis (`other_network`); made more than 5 minutes
 * ahead (`ahead`); expired; for another owner (`other_owner`); a proof that does not verify under the offer's key for
 * this genesis hash, slug and owner (`proof`). Nothing travels to the computer, which watches the registry.
 */
export function offerProblem(offer: PairingOffer, network: NetworkName, genesis: string, account: string, now: number): PairingProblem | null {
  const form = offerFormProblem(offer);
  if (form) return form;
  if (networkOfHrp(offer.hrp) !== network || offer.genesis !== genesis.slice(0, 16)) return "other_network";
  if (offer.createdAt > now + PAIR_SKEW_MS) return "ahead";
  if (now >= offer.expiresAt) return "expired";
  if (offer.owner !== account) return "other_owner";
  if (!verifyServerKeyProof(offer.key, offer.proof, genesis, offer.slug, offer.owner)) return "proof";
  return null;
}

/** The key's proof for the app and the owner as the offer carries it: a `configureProven` server entry, what the wallet
 *  sends in `ConfigureGrain` (tag 39) once `offerProblem` took the offer, and keeps for the calls that keep the key. */
export const offerProof = (offer: PairingOffer): { key: string; proof: string } => ({ key: offer.key, proof: offer.proof });

/** Borsh(PairingOffer). */
export function encodeOffer(offer: PairingOffer): Uint8Array {
  return new Writer()
    .u8(offer.version).string(offer.hrp).fixed(fromHex(offer.genesis, 8), 8).fixed(fromHex(offer.key, 32), 32)
    .fixed(fromHex(offer.nonce, 16), 16).string(offer.slug).fixed(fromHex(offer.owner, 32), 32).fixed(fromHex(offer.proof, 64), 64)
    .string(offer.name).u64(offer.createdAt).u64(offer.expiresAt).done();
}

/** Read exactly the Borsh form, of form; throws a `PairingError`. An offer of another version is read for its version
 *  only: `version`, whose message says whether to update the SDK or the wallet. */
export function decodeOffer(bytes: Uint8Array): PairingOffer {
  if (bytes.length === 0) throw new PairingError("malformed");
  if (bytes[0] !== PAIR_OFFER_VERSION) throw new PairingError("version", bytes[0]);
  let offer: PairingOffer;
  try {
    const r = new Reader(bytes);
    offer = {
      version: r.u8(), hrp: r.string(), genesis: toHex(r.fixed(8)), key: toHex(r.fixed(32)), nonce: toHex(r.fixed(16)), slug: r.string(),
      owner: toHex(r.fixed(32)), proof: toHex(r.fixed(64)), name: r.string(), createdAt: r.u64n(), expiresAt: r.u64n(),
    };
    r.end();
  } catch {
    throw new PairingError("malformed");
  }
  const problem = offerFormProblem(offer);
  if (problem) throw new PairingError(problem, offer.version);
  return offer;
}

/** `salt:grain-pair?o=<base64url without padding of its Borsh>`: what the QR code holds. */
export const offerLink = (offer: PairingOffer): string => PAIR_LINK_PREFIX + toBase64(encodeOffer(offer), true);

/** Read a link: exactly the form `offerLink` writes (no padding, no spare bits, no further parameter), white space
 *  around it allowed; throws a `PairingError`. */
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
 *  big-endian u32, modulo 1 000 000. Derived from everything in the offer, the key and the proof included. */
export function offerCode(offer: PairingOffer): number {
  const digest = derive(PAIRING_CODE_DOMAIN, encodeOffer(offer));
  return new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0, false) % 1_000_000;
}

/** The code as people read it: six digits in two groups, `482 913`. */
export function offerCodeText(offer: PairingOffer): string {
  const digits = String(offerCode(offer)).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** The server key's personal address on the offer's network: where the app's chat registers once the key is named. */
export function offerAddress(offer: PairingOffer): string {
  const network = networkOfHrp(offer.hrp);
  if (network === null) throw new PairingError("unknown_network");
  return encodeAddress(network, accountId(fromHex(offer.key, 32)));
}

/** The registry's record as `grain_get` serves it, in the form the slug is judged by; null for a slug nobody holds. */
export function slugRecordOf(grain: RegisteredGrain | null): SlugRecord | null {
  return grain === null ? null : { owner: grain.owner, retired: grain.retired !== null, servers: grain.servers ?? [] };
}

/**
 * What the slug is to the owner the offer names (`key`, `owner`: the offer's, or the computer's before it has one), from
 * the registry's record of it (null: the registry holds no grain of that slug), in the order §3a names: another
 * account's, retired, the key named already, else the owner's own; free when there is no record. A wallet signs for
 * `free` and `own` only; the computer checks the same before it shows an offer, and takes itself as paired at
 * `paired_already`.
 */
export function judgeSlug(offer: Pick<PairingOffer, "key" | "owner">, record: SlugRecord | null): SlugVerdict {
  if (record === null) return "free";
  if (record.owner !== offer.owner) return "another_account";
  if (record.retired) return "retired";
  if (record.servers.includes(offer.key)) return "paired_already";
  return "own";
}
