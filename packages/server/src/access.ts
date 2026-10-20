// A test network's gate (Saltix 33-gate): the access grant its gate signs for a P-256 key, what a client shows a relay
// (an `AccessToken`: the grant and the key's proof to that relay at that moment), and the relay's own check of one.
//
// A relay whose node runs a gate names it in its hello (`access: {gates}`) and takes a registration only with a token,
// unless the record is self-signed by a registered server key of a live grain (12-grains §5.5): an app's server under
// its paired key needs nothing. A key the registry does not name yet (a computer running `grain pair`, a certified key)
// shows a grant; a computer cannot attest its key, so its grant is unattested and lives at most 24 hours (§4.3).
// Byte for byte the node's (`vectors/gate-v1.json`).
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { Reader, Writer, derive, fromHex, toHex } from "./bytes.js";
import { ed25519KeyValid, verifyByDeviceKey, verifyEd25519 } from "./keys.js";

/** Domain of the gate's signature over a grant. */
export const GRANT_DOMAIN = "Saltix access grant v1";
/** Domain of a phone's delegation to a browser it linked. */
export const DELEGATION_DOMAIN = "Saltix access delegation v1";
/** Domain of a client's proof to one relay. */
export const PROOF_DOMAIN = "Saltix access proof v1";
/** Domain of the proof of possession in a redemption at the gate (§4.2). */
export const REDEEM_DOMAIN = "Saltix access redeem v1";

/** The longest a grant may live: 400 days. */
export const GRANT_MAX_MS = 400 * 24 * 3_600_000;
/** The longest an unattested grant may live (§4.3): a computer's, 24 hours. */
export const UNATTESTED_MAX_MS = 24 * 3_600_000;
/** How far a token's `at`, and a grant's `issued_at` ahead, may be from the relay's clock. */
export const ACCESS_SKEW_MS = 10 * 60_000;
/** The longest token a relay decodes. */
export const MAX_ACCESS_TOKEN = 1024;

/** What vouched for a grant's key: nothing (a computer, or a phone that could not attest), the TEE, a StrongBox. */
export const ATTESTATION = { none: 0, tee: 1, strongbox: 2 } as const;

/** A statement of the gate that `key` may use the network of genesis hash `network` until `notAfter` (§2). */
export interface AccessGrant {
  version: number;
  network: Uint8Array;
  /** The access key: P-256, SEC1-compressed (33 bytes). */
  key: Uint8Array;
  /** 0 none, 1 TEE, 2 StrongBox. */
  attestation: number;
  /** The attested verified boot state (0 verified … 3 failed), 255 without an attestation: the gate's note. */
  boot: number;
  /** The code's id: the first 4 bytes of SHA-256 of its canonical form. */
  code: Uint8Array;
  /** Unix ms. */
  issuedAt: number;
  /** Unix ms: the access ends here. */
  notAfter: number;
}

export interface SignedAccessGrant {
  grant: AccessGrant;
  /** Ed25519 by the gate key over `grantSigningMessage(grant)`. */
  signature: Uint8Array;
}

/** A phone's word that a browser it linked shares its access (§3): what a relay checks, never what a server makes. */
export interface AccessDelegation {
  grant: SignedAccessGrant;
  device: Uint8Array;
  notAfter: number;
  signature: Uint8Array;
}

/** What a client shows: its own grant, or a delegation from its phone. */
export type Access = { own: SignedAccessGrant } | { delegated: AccessDelegation };

/** An `Access` with its holder's proof to one relay at one moment. */
export interface AccessToken {
  access: Access;
  /** The node key of the relay it is shown to. */
  relay: Uint8Array;
  /** Unix ms. */
  at: number;
  proof: Uint8Array;
}

/** Why a relay refused a token: the word it says (`access` in `auth_failed`, §5). */
export type AccessReason =
  | "required" | "malformed" | "relay" | "time" | "network" | "gate" | "expired" | "lifetime" | "delegation" | "proof";

/** Every word a relay refuses access with, in plain words: what it means for whoever holds the grant. */
export const ACCESS_REASONS: Readonly<Record<AccessReason, string>> = {
  required: "this network lets in only connections with an access grant, and none was shown",
  malformed: "the relay could not read the access token",
  relay: "the access token was made for another relay",
  time: "the access token's time, or the grant's, is more than 10 minutes off the relay's clock",
  network: "the access grant is for another network (was the network reset?)",
  gate: "no gate this network trusts signed the access grant (the network changed its gate)",
  expired: "the access grant has ended",
  lifetime: "the access grant lives longer than the network allows",
  delegation: "the access delegation does not verify",
  proof: "the access token's proof does not verify: the grant is another key's",
};

const REASONS = new Set(Object.keys(ACCESS_REASONS));

/** A relay word as an `AccessReason`: anything else is `malformed`, so a reason a newer relay adds still reads. */
export const accessReasonOf = (word: unknown): AccessReason =>
  typeof word === "string" && REASONS.has(word) ? (word as AccessReason) : "malformed";

/** A relay refused this connection's access (`auth_failed` with `detail: "access"`), or its wallet interface refused a
 *  write (`-32001`, `"access"`): `reason` is its word. */
export class AccessRefused extends Error {
  constructor(readonly reason: AccessReason) {
    super(`the relay refused access (${reason}): ${ACCESS_REASONS[reason]}`);
    this.name = "AccessRefused";
  }
}

const writeGrant = (w: Writer, g: AccessGrant): Writer =>
  w.u8(g.version).fixed(g.network, 32).fixed(g.key, 33).u8(g.attestation).u8(g.boot).fixed(g.code, 4).u64(g.issuedAt).u64(g.notAfter);

const writeSigned = (w: Writer, s: SignedAccessGrant): Writer => writeGrant(w, s.grant).fixed(s.signature, 64);

const writeAccess = (w: Writer, a: Access): Writer =>
  "own" in a
    ? writeSigned(w.u8(0), a.own)
    : writeSigned(w.u8(1), a.delegated.grant).fixed(a.delegated.device, 32).u64(a.delegated.notAfter).fixed(a.delegated.signature, 64);

/** A time a relay reads: refused past 2^53 ms, which no gate signs (the node's u64 reads as the same moment below it). */
const readTime = (r: Reader): number => r.u64n();

function readGrant(r: Reader): AccessGrant {
  return {
    version: r.u8(), network: r.fixed(32), key: r.fixed(33), attestation: r.u8(), boot: r.u8(), code: r.fixed(4),
    issuedAt: readTime(r), notAfter: readTime(r),
  };
}

const readSigned = (r: Reader): SignedAccessGrant => ({ grant: readGrant(r), signature: r.fixed(64) });

function readAccess(r: Reader): Access {
  const tag = r.u8();
  if (tag === 0) return { own: readSigned(r) };
  if (tag === 1) return { delegated: { grant: readSigned(r), device: r.fixed(32), notAfter: readTime(r), signature: r.fixed(64) } };
  throw new TypeError("borsh: an unknown kind of access");
}

export const encodeAccessGrant = (grant: AccessGrant): Uint8Array => writeGrant(new Writer(), grant).done();
export const encodeSignedAccessGrant = (signed: SignedAccessGrant): Uint8Array => writeSigned(new Writer(), signed).done();

/** A `SignedAccessGrant` from its Borsh, exactly (nothing trailing). Throws a `TypeError` otherwise. */
export function decodeSignedAccessGrant(bytes: Uint8Array): SignedAccessGrant {
  const r = new Reader(bytes);
  const signed = readSigned(r);
  r.end();
  return signed;
}

export const encodeAccessToken = (token: AccessToken): Uint8Array =>
  writeAccess(new Writer(), token.access).fixed(token.relay, 32).u64(token.at).fixed(token.proof, 64).done();

/** A token as a relay decodes it: at most `MAX_ACCESS_TOKEN` bytes, nothing trailing. Throws a `TypeError` otherwise. */
export function decodeAccessToken(bytes: Uint8Array): AccessToken {
  if (bytes.length > MAX_ACCESS_TOKEN) throw new TypeError("an access token is at most 1 KiB");
  const r = new Reader(bytes);
  const token = { access: readAccess(r), relay: r.fixed(32), at: readTime(r), proof: r.fixed(64) };
  r.end();
  return token;
}

/** The 32-byte message the gate signs. */
export const grantSigningMessage = (grant: AccessGrant): Uint8Array => derive(GRANT_DOMAIN, encodeAccessGrant(grant));

/** The 32-byte message a phone signs to delegate `grant` to the browser `device` until `notAfter`. */
export const delegationMessage = (grant: SignedAccessGrant, device: Uint8Array, notAfter: number): Uint8Array =>
  derive(DELEGATION_DOMAIN, writeSigned(new Writer(), grant).fixed(device, 32).u64(notAfter).done());

/** The 32-byte message a client signs to show `access` to `relay` at `at`. */
export const accessProofMessage = (access: Access, relay: Uint8Array, at: number): Uint8Array =>
  derive(PROOF_DOMAIN, writeAccess(new Writer(), access).fixed(relay, 32).u64(at).done());

/** The 32-byte message a new access key signs in a redemption at the gate (§4.2): challenge ‖ network ‖ key. */
export const redeemMessage = (challenge: Uint8Array, network: Uint8Array, key: Uint8Array): Uint8Array =>
  derive(REDEEM_DOMAIN, challenge, network, key);

/** The grant behind an access: its own, or the delegation's. */
export const grantOf = (access: Access): SignedAccessGrant => ("own" in access ? access.own : access.delegated.grant);

/** Whether a grant is signed by one of `gates` (Ed25519 public keys): the one that signed it, or null. */
export function grantSigner(signed: SignedAccessGrant, gates: readonly Uint8Array[]): Uint8Array | null {
  const message = grantSigningMessage(signed.grant);
  return gates.find((gate) => verifyEd25519(gate, message, signed.signature)) ?? null;
}

const SECRETS = new WeakMap<AccessKey, Uint8Array>();

/**
 * The P-256 key an access grant is bound to (33-gate §1). A phone keeps its own in the Keystore; a computer keeps one in
 * its project (`grain pair`: `.grain/access.key`, owner-only). It signs ECDSA over SHA-256 of a 32-byte message, `r ‖ s`
 * with a low `s` (RFC 6979). Its secret is never logged or printed: `toString` and `toJSON` show the public key alone.
 */
export class AccessKey {
  /** SEC1-compressed, 33 bytes. */
  readonly publicKey: Uint8Array;

  private constructor(secret: Uint8Array) {
    this.publicKey = p256.getPublicKey(secret, true);
    SECRETS.set(this, Uint8Array.from(secret));
    Object.freeze(this);
  }

  /** A new key from the system's randomness. */
  static generate(): AccessKey {
    return new AccessKey(p256.utils.randomPrivateKey());
  }

  /** The key of a 32-byte scalar (1 to the curve's order − 1). */
  static fromSecret(secret: Uint8Array): AccessKey {
    if (secret.length !== 32 || !p256.utils.isValidPrivateKey(secret)) throw new TypeError("an access key: a P-256 scalar of 32 bytes");
    return new AccessKey(secret);
  }

  /** ECDSA P-256 over SHA-256 of `message`: `r ‖ s`, low `s`, deterministic (RFC 6979). */
  sign(message: Uint8Array): Uint8Array {
    return p256.sign(sha256(message), SECRETS.get(this)!, { prehash: false, lowS: true }).toCompactRawBytes();
  }

  /** The secret, to write to the key's own owner-only file. Never log or print it. */
  reveal(): Uint8Array {
    return Uint8Array.from(SECRETS.get(this)!);
  }

  toString(): string {
    return `AccessKey(${toHex(this.publicKey).slice(0, 16)}…)`;
  }

  toJSON(): { publicKey: string } {
    return { publicKey: toHex(this.publicKey) };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/** A grant and the key it is bound to: what a client needs to make tokens. */
export interface AccessCredential {
  grant: SignedAccessGrant;
  key: AccessKey;
}

/** A token for `relay` (its node key) at `at` (Unix ms; a relay takes it within 10 minutes of its clock): the grant's
 *  own key's proof. Its Borsh, which `register {access}` and `X-Saltix-Access` carry as base64url. */
export function accessToken(credential: AccessCredential, relay: Uint8Array, at: number): Uint8Array {
  if (toHex(credential.grant.grant.key) !== toHex(credential.key.publicKey)) throw new TypeError("the access grant is for another key");
  const access: Access = { own: credential.grant };
  return encodeAccessToken({ access, relay, at, proof: credential.key.sign(accessProofMessage(access, relay, at)) });
}

/** What a relay checks a token against. */
export interface AccessCheckpoint {
  /** The gates the node trusts: Ed25519 public keys. */
  gates: readonly Uint8Array[];
  /** The network's genesis hash. */
  network: Uint8Array;
  /** The relay's node key. */
  relay: Uint8Array;
  /** Unix ms by the relay's clock. */
  now: number;
}

/** What a relay learned from a token it took: when the access ends, and whether it is a browser's delegated one. */
export interface AccessAdmitted {
  until: number;
  attestation: number;
  delegated: boolean;
}

const p256KeyValid = (key: Uint8Array): boolean => {
  try {
    p256.ProjectivePoint.fromHex(key);
    return key.length === 33;
  } catch {
    return false;
  }
};

/** §2's rules that need no signature: the shape, the network, the times and the lifetime. */
function grantTermsProblem(g: AccessGrant, network: Uint8Array, now: number): AccessReason | null {
  if (g.attestation > 2 || g.version !== 1 || !p256KeyValid(g.key)) return "malformed";
  if (toHex(g.network) !== toHex(network)) return "network";
  if (g.issuedAt > now + ACCESS_SKEW_MS) return "time";
  if (g.issuedAt >= g.notAfter) return "lifetime";
  if (g.notAfter - g.issuedAt > (g.attestation === ATTESTATION.none ? UNATTESTED_MAX_MS : GRANT_MAX_MS)) return "lifetime";
  if (now >= g.notAfter) return "expired";
  return null;
}

/**
 * Whether a relay takes `bytes` as a token (33-gate §3), as the node's `check_token` decides, in its order: what costs
 * nothing first (the relay's key, the time, the grant's terms, the delegation's dates), then the gate's signature, the
 * delegation's and the proof. `@saltix/grain-server/dev`'s relay checks with it; a client needs it only in tests.
 */
export function checkAccessToken(bytes: Uint8Array, at: AccessCheckpoint): { admitted: AccessAdmitted } | { refused: AccessReason } {
  let token: AccessToken;
  try {
    token = decodeAccessToken(bytes);
  } catch {
    return { refused: "malformed" };
  }
  if (toHex(token.relay) !== toHex(at.relay)) return { refused: "relay" };
  if (Math.abs(token.at - at.now) > ACCESS_SKEW_MS) return { refused: "time" };
  const signed = grantOf(token.access);
  const terms = grantTermsProblem(signed.grant, at.network, at.now);
  if (terms) return { refused: terms };
  let until = signed.grant.notAfter;
  if ("delegated" in token.access) {
    const d = token.access.delegated;
    if (d.notAfter > signed.grant.notAfter) return { refused: "delegation" };
    if (at.now >= d.notAfter) return { refused: "expired" };
    if (!ed25519KeyValid(d.device)) return { refused: "malformed" };
    until = d.notAfter;
  }
  if (grantSigner(signed, at.gates) === null) return { refused: "gate" };
  const message = accessProofMessage(token.access, token.relay, token.at);
  const grantKey = { p256: toHex(signed.grant.key) };
  if ("delegated" in token.access) {
    const d = token.access.delegated;
    if (!verifyByDeviceKey(grantKey, delegationMessage(d.grant, d.device, d.notAfter), toHex(d.signature))) return { refused: "delegation" };
    if (!verifyEd25519(d.device, message, token.proof)) return { refused: "proof" };
  } else if (!verifyByDeviceKey(grantKey, message, toHex(token.proof))) {
    return { refused: "proof" };
  }
  return { admitted: { until, attestation: signed.grant.attestation, delegated: "delegated" in token.access } };
}

/** A code as the operator hands it out (§4.1): 10 Crockford base32 characters, shown `XXXXX-XXXXX`. */
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/**
 * A code as typed, in its canonical form (the 10 characters, upper case: what the gate takes and what its id hashes),
 * or why it is none: `length`, or `letters` (I, L, O and U are never in a code: one of them is a 1 or a 0 misread).
 */
export function canonicalAccessCode(typed: string): { code: string } | { problem: "length" | "letters" } {
  const code = typed.replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== 10) return { problem: "length" };
  if (!CROCKFORD.test(code)) return { problem: "letters" };
  return { code };
}

/** A code's id (§4.1): the first 4 bytes of SHA-256 of its canonical form, what the operator's lists show. */
export const accessCodeId = (canonical: string): Uint8Array => sha256(new TextEncoder().encode(canonical)).slice(0, 4);

/** `hello.access` as a relay sends it (`{gates: [base64url key, …]}`): the gates, or null when the relay names none. */
export function helloGates(access: unknown, decode: (text: string) => Uint8Array): Uint8Array[] | null {
  if (typeof access !== "object" || access === null) return null;
  const gates = (access as { gates?: unknown }).gates;
  if (!Array.isArray(gates)) return null;
  const keys: Uint8Array[] = [];
  for (const g of gates) {
    try {
      const key = typeof g === "string" ? decode(g) : null;
      if (key && key.length === 32) keys.push(key);
    } catch {
      // A gate that does not read is none of ours to trust.
    }
  }
  return keys;
}

/** `node_status.access` (`{gates: [hex key, …]}`, or null): the gates whose grants the node's relay requires, or null
 *  when it requires none (08-node §6, 33-gate §5). */
export function statusGates(access: unknown): Uint8Array[] | null {
  if (typeof access !== "object" || access === null) return null;
  const gates = (access as { gates?: unknown }).gates;
  if (!Array.isArray(gates) || gates.length === 0) return null;
  return gates.filter((g): g is string => typeof g === "string" && /^[0-9a-f]{64}$/.test(g)).map((g) => fromHex(g, 32));
}
