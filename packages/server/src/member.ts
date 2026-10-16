// Private grains and their members (Saltix 24-app-studio §2a). A private grain is used by its owner and its members
// only; its server cannot tell who a grain key belongs to, so a member's wallet adds to every chat request a member
// proof: the account, the grain key it uses in this grain, and a signature by a key that speaks for the account
// (13-accounts §5). `admits` is the check a private grain's server makes, as the reference's `grain::member::admits`.
// Byte for byte vectors/grain-chats-v1.json.
//
// The grain's team (its owner, developers and viewers, 24-app-studio §2a, §4) sends its proof to its own grain, public
// or private, with its requests and in a hello of its own (22-grain-chats §3a), so that the server learns where each
// member's chat is: `teamMemberOf`, `introductionProblem` (the reference's `grain::member::introduces`).
//
// No Node APIs here: the simulator runs it in a browser.
import { ed25519 } from "@noble/curves/ed25519";
import { accountId } from "./address.js";
import { Reader, Writer, derive, fromHex, toHex } from "./bytes.js";
import { type DeviceKey, readDeviceKey, sameDeviceKey, verifyByDeviceKey, writeDeviceKey } from "./keys.js";
import { ROLES } from "./registry.js";

export const MEMBER_DOMAIN = "Saltix grain member v1";
/** The longest a member proof lives: 30 days, ms. */
export const MEMBER_PROOF_LIFE_MS = 30 * 86_400_000;

/** "`account` uses the grain `slug` under `grain_key`", until `expires_at` (Unix ms). Bytes in lowercase hex. */
export interface MemberProof {
  slug: string;
  account: string;
  grain_key: string;
  expires_at: number;
}

/** A proof with the key that signed it, one that speaks for its account. */
export interface SignedMemberProof {
  proof: MemberProof;
  key: DeviceKey;
  /** Ed25519 over `memberProofToSign`, or ECDSA P-256 over its SHA-256 as `r ‖ s` with a low `s`, as a device signs a
   *  transaction. */
  signature: string;
}

/** Who may use a grain, as its registry record has it (`grain_get`'s `owner`, `public` and `members`). */
export interface GrainAccess {
  owner: string;
  public: boolean;
  /** Accounts (hex) and their roles, a bit set of `ROLES`. */
  members: Array<{ account: string; roles: number }>;
}

/** A managed account's devices as the wallet interface shows them (`account_get`'s `controller`, 08-node §6): the
 *  fields this check reads. */
export interface Controller {
  devices: Array<{ key: DeviceKey; kind: string }>;
}

/** Why a member proof is refused, as the reference names it (`MemberError`): `not_member` for a private grain's request
 *  from an account that may not use it, `not_team` for a hello from an account off the grain's team. */
export type MemberProblem = "missing" | "mismatch" | "expired" | "signer" | "signature" | "not_member" | "not_team";

export function writeMemberProof(w: Writer, p: MemberProof): Writer {
  if (!Number.isSafeInteger(p.expires_at) || p.expires_at < 0) throw new TypeError("expires_at: Unix ms");
  return w.string(p.slug).fixed(fromHex(p.account, 32), 32).fixed(fromHex(p.grain_key, 32), 32).u64(p.expires_at);
}

export function readMemberProof(r: Reader): MemberProof {
  return { slug: r.string(), account: toHex(r.fixed(32)), grain_key: toHex(r.fixed(32)), expires_at: r.u64n() };
}

export function writeSignedMemberProof(w: Writer, s: SignedMemberProof): Writer {
  return writeDeviceKey(writeMemberProof(w, s.proof), s.key).fixed(fromHex(s.signature, 64), 64);
}

export function readSignedMemberProof(r: Reader): SignedMemberProof {
  return { proof: readMemberProof(r), key: readDeviceKey(r), signature: toHex(r.fixed(64)) };
}

export const encodeMemberProof = (p: MemberProof): Uint8Array => writeMemberProof(new Writer(), p).done();
export const encodeSignedMemberProof = (s: SignedMemberProof): Uint8Array => writeSignedMemberProof(new Writer(), s).done();

export function decodeSignedMemberProof(bytes: Uint8Array): SignedMemberProof {
  const r = new Reader(bytes);
  const s = readSignedMemberProof(r);
  r.end();
  return s;
}

/** What the account's key signs: the proof on the network of `genesis` (hex). */
export const memberProofToSign = (p: MemberProof, genesis: string): Uint8Array =>
  derive(MEMBER_DOMAIN, fromHex(genesis, 32), encodeMemberProof(p));

/** `p` signed by an Ed25519 key of the account (a plain account's own key): what a member's wallet sends. For tests
 *  and TypeScript clients; a phone's P-256 key signs `memberProofToSign` itself. */
export function signMemberProof(p: MemberProof, accountSecret: Uint8Array, genesis: string): SignedMemberProof {
  return {
    proof: p,
    key: { ed25519: toHex(ed25519.getPublicKey(accountSecret)) },
    signature: toHex(ed25519.sign(memberProofToSign(p, genesis), accountSecret)),
  };
}

/**
 * Whether `key` speaks for the account `account` (hex) now (13-accounts §5): with no `controller`, its own Ed25519 key
 * (the account is the key's personal one); once managed, one of its devices, a guardian excepted.
 */
export function keyStandsFor(controller: Controller | null, account: string, key: DeviceKey): boolean {
  if (controller === null) return "ed25519" in key && /^[0-9a-f]{64}$/.test(key.ed25519) && toHex(accountId(fromHex(key.ed25519, 32))) === account;
  return controller.devices.some((d) => sameDeviceKey(d.key, key) && d.kind !== "guardian");
}

/**
 * Why `signed` does not prove its account uses `slug` under `grainKey` at `now`, or null (the reference's
 * `SignedMemberProof::verify`, in its order): for this grain and key, alive for at most 30 days, its key speaks for the
 * account now (`controller`, the account's as the server knows it), and the signature holds on this network.
 */
export function memberProofProblem(
  signed: SignedMemberProof,
  check: { genesis: string; slug: string; grainKey: string; controller: Controller | null; now: number },
): MemberProblem | null {
  const p = signed.proof;
  if (p.slug !== check.slug || p.grain_key !== check.grainKey) return "mismatch";
  if (p.expires_at <= check.now || p.expires_at > check.now + MEMBER_PROOF_LIFE_MS) return "expired";
  if (!keyStandsFor(check.controller, p.account, signed.key)) return "signer";
  return verifyByDeviceKey(signed.key, memberProofToSign(p, check.genesis), signed.signature) ? null : "signature";
}

/** The roles of `account` in a grain: every role for the owner, none for a stranger. */
export function rolesOf(access: GrainAccess, account: string): number {
  if (account === access.owner) return ROLES.user | ROLES.developer | ROLES.viewer;
  return access.members.find((m) => m.account === account)?.roles ?? 0;
}

/**
 * What a signed-in account may do in a grain, by its strongest role (12-grains §5.1a): `owner` (the registry's owner),
 * `developer`, `viewer`, `user` (a private grain's member who only uses it), or `none` (anyone else, and everyone whose
 * wallet proved nothing).
 */
export type Rights = "owner" | "developer" | "viewer" | "user" | "none";

/** Every right, strongest first. */
export const RIGHTS: readonly Rights[] = ["owner", "developer", "viewer", "user", "none"];

/** The rights of `account` (hex; null for none proven) in a grain, by its strongest role. A public grain's user role
 *  counts for nothing: anyone uses a public grain, and its wallet sends no proof for it. */
export function rightsOf(access: GrainAccess, account: string | null): Rights {
  if (account === null) return "none";
  if (account === access.owner) return "owner";
  const roles = rolesOf(access, account);
  if ((roles & ROLES.developer) !== 0) return "developer";
  if ((roles & ROLES.viewer) !== 0) return "viewer";
  if (!access.public && (roles & ROLES.user) !== 0) return "user";
  return "none";
}

/** The roles that put a member on the grain's team (24-app-studio §2a): developer or viewer. A member with the user role
 *  alone uses a private grain and is not on its team. */
export const TEAM_ROLES = ROLES.developer | ROLES.viewer;

/** Whether `account` is on the grain's team: its owner, or a member with the developer or viewer role. */
export const onTeam = (access: GrainAccess, account: string): boolean => account === access.owner || (rolesOf(access, account) & TEAM_ROLES) !== 0;

/** Whether the account may use the grain while it is private: the owner, a user or a developer; a viewer only reads its
 *  page. */
export const mayUse = (access: GrainAccess, account: string): boolean => (rolesOf(access, account) & (ROLES.user | ROLES.developer)) !== 0;

/**
 * What a private grain's server checks before it takes a request from `requestKey` (24-app-studio §2a), or null: the
 * request carries a proof for this grain and that key, alive and signed by a key that speaks for its account now, and
 * the account may use the grain. A public grain takes anyone and reads no proof.
 */
export function admits(
  access: GrainAccess,
  check: { genesis: string; slug: string; requestKey: string; proof: SignedMemberProof | null; controller: Controller | null; now: number },
): MemberProblem | null {
  if (access.public) return null;
  if (!check.proof) return "missing";
  const problem = memberProofProblem(check.proof, { genesis: check.genesis, slug: check.slug, grainKey: check.requestKey, controller: check.controller, now: check.now });
  if (problem) return problem;
  return mayUse(access, check.proof.proof.account) ? null : "not_member";
}

type ProofCheck = { genesis: string; slug: string; requestKey: string; proof: SignedMemberProof | null; now: number };

/** Whether `s` holds but for its signer: for this grain and the request's (or the hello's) key, alive for at most 30
 *  days, and its signature checks. Only then is the account's controller worth asking the node for. */
export function holdsButSigner(s: SignedMemberProof, check: ProofCheck): boolean {
  const p = s.proof;
  return p.slug === check.slug && p.grain_key === check.requestKey && p.expires_at > check.now &&
    p.expires_at <= check.now + MEMBER_PROOF_LIFE_MS && verifyByDeviceKey(s.key, memberProofToSign(p, check.genesis), s.signature);
}

/** Whether the server needs the account's controller to judge `proof` (`admits` cannot refuse it without one): a proof
 *  for this grain and key, alive, from an account that may use it, whose signature holds. Anything else is refused
 *  whatever the account's keys are, so its server need not ask the node. */
export function needsController(access: GrainAccess, check: ProofCheck): boolean {
  const s = check.proof;
  if (access.public || !s) return false;
  return mayUse(access, s.proof.account) && holdsButSigner(s, check);
}

/** Whether the server needs the account's controller to learn from `proof` that the request's key is a team member's
 *  (`teamMemberOf`): a proof from an account on the team that holds but for its signer. Anyone else's costs the node
 *  nothing. Public or private grain alike. */
export function needsTeamController(access: GrainAccess, check: ProofCheck): boolean {
  const s = check.proof;
  return s !== null && onTeam(access, s.proof.account) && holdsButSigner(s, check);
}

/**
 * Why `proof` does not introduce an account on the grain's team as the one behind `helloKey` (22-grain-chats §3a), or
 * null (the reference's `member::introduces`, in its order): `memberProofProblem` passes it for this grain and key, and
 * the account is the owner, a developer or a viewer (`not_team` otherwise; a user alone is not on the team). Public
 * grain or private alike.
 */
export function introductionProblem(
  access: GrainAccess,
  check: { genesis: string; slug: string; helloKey: string; proof: SignedMemberProof; controller: Controller | null; now: number },
): MemberProblem | null {
  const problem = memberProofProblem(check.proof, { genesis: check.genesis, slug: check.slug, grainKey: check.helloKey, controller: check.controller, now: check.now });
  if (problem) return problem;
  return onTeam(access, check.proof.proof.account) ? null : "not_team";
}

/**
 * The account on the grain's team that `proof` shows is behind the request's (or the hello's) key (24-app-studio §4),
 * or null: a proof that `introductionProblem` passes, signed by a key that speaks for an account on the team now
 * (`controller`, the account's). What a server learns where its team's chats are from; it admits nobody to a private
 * grain (`admits`).
 */
export function teamMemberOf(access: GrainAccess, check: ProofCheck & { controller: Controller | null }): string | null {
  const s = check.proof;
  if (!s) return null;
  const problem = introductionProblem(access, { genesis: check.genesis, slug: check.slug, helloKey: check.requestKey, proof: s, controller: check.controller, now: check.now });
  return problem === null ? s.proof.account : null;
}
