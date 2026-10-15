// The grains' registry on the beacon chain (Saltix 12-grains §3, 24-app-studio §2–§6a): the owner's transactions that
// register, update, configure, open or close and retire a grain, a username bound to it, anyone's rating, encoded and
// signed as the node checks them, the deposit a slug needs, and what a node says of a slug.
import { ed25519 } from "@noble/curves/ed25519";
import { accountId } from "./address.js";
import { Writer, fromHex, toHex } from "./bytes.js";
import { type Handle, handleProblem, writeHandle } from "./handle.js";
import { encodeManifest, type Manifest, type SignedManifest } from "./manifest.js";
import { rpc } from "./node.js";
import { type TxFields, encodeTx, minimumTxFee, signTx, txId } from "./tx.js";

export type { TxFields } from "./tx.js";

/** What `RegisterGrain` needs for a slug of 3–5 characters, and the most a grain keeps as its deposit: 100 SALT. */
export const GRAIN_DEPOSIT = 100_000_000_000n;
/** For a slug of 6–7 characters: 30 SALT. */
export const GRAIN_DEPOSIT_MEDIUM = 30_000_000_000n;
/** For a slug of 8 characters or more: 10 SALT. */
export const GRAIN_DEPOSIT_LONG = 10_000_000_000n;

/** Server keys a grain's registry record names, at most (24-app-studio §2). */
export const MAX_SERVERS = 4;
/** Members of a grain, at most (24-app-studio §2a). */
export const MAX_MEMBERS = 64;
/** A rating's review, at most, in characters (24-app-studio §6a). */
export const MAX_REVIEW = 140;
/** A member's roles (24-app-studio §2a), a bit set: uses the app while it is private; holds a server key and may sign
 *  its price-free specs; sees its page in My apps read-only. */
export const ROLES = { user: 1, developer: 2, viewer: 4 } as const;
/** The categories (24-app-studio §6), by number. */
export const CATEGORIES = ["other", "tools", "finance", "social", "games", "shopping", "education", "news", "business", "developer"] as const;
export type Category = (typeof CATEGORIES)[number];

const SLUG = /^[a-z0-9][a-z0-9-]{2,31}$/;
const slugOk = (slug: string) => SLUG.test(slug);

/**
 * What `RegisterGrain` needs for `slug` (24-app-studio §5): 100 SALT for 3–5 characters, 30 for 6–7, 10 for 8 or more.
 * The registry keeps what the call sends up to 100 SALT; a node quotes it as `grain_get`'s `deposit`, which a
 * registration should send exactly (`grainQuote`).
 */
export function grainDeposit(slug: string): bigint {
  const n = new TextEncoder().encode(slug).length;
  return n <= 5 ? GRAIN_DEPOSIT : n <= 7 ? GRAIN_DEPOSIT_MEDIUM : GRAIN_DEPOSIT_LONG;
}

/** A member's roles from a number (1–7) or names joined by `+` (`user+developer`); null when they are none or unknown. */
export function parseRoles(text: string): number | null {
  const roles = /^\d+$/.test(text)
    ? Number(text)
    : text.split(/[+,]/).reduce<number | null>((all, name) => {
      const role = ROLES[name.trim() as keyof typeof ROLES];
      return all === null || role === undefined ? null : all | role;
    }, 0);
  return roles !== null && rolesOk(roles) ? roles : null;
}

/** Whether `roles` is a member's: some of the known bits and nothing else. */
export const rolesOk = (roles: number): boolean => Number.isInteger(roles) && roles >= 1 && roles <= 7;

/** The names of `roles`: `["user", "developer"]`. */
export const roleNames = (roles: number): string[] => (Object.keys(ROLES) as Array<keyof typeof ROLES>).filter((r) => (roles & ROLES[r]) !== 0);

/** A category's number from its number or name (`games`), or null. */
export function categoryOf(text: string | number): number | null {
  const n = typeof text === "number" ? text : /^\d+$/.test(text) ? Number(text) : CATEGORIES.indexOf(text as Category);
  return Number.isInteger(n) && n >= 0 && n < CATEGORIES.length ? n : null;
}

/** A registry call of the owner, or of a rater (Saltix 06-licenses §4, 12-grains §3, 21-names §5a, 24-app-studio §9).
 *  `deposit` overrides a registration's value (a node's quote); by default it is `grainDeposit(slug)`. */
export type GrainCall =
  | { register: SignedManifest; deposit?: bigint }
  | { update: SignedManifest }
  | { retire: string }
  | { configure: { slug: string; servers: string[]; category: number } }
  | { bind: { handle: Handle; slug: string | null } }
  | { access: { slug: string; public: boolean; members: Array<{ account: string; roles: number }> } }
  | { rate: { slug: string; score: number; review: string } };

// Action::Registry is tag 1; RegisterGrain, UpdateGrain and RetireGrain are calls 7, 8 and 9; ConfigureGrain,
// BindHandle, SetGrainAccess and RateGrain 34 to 37.
const ACTION_REGISTRY = 1;
const CALL = { register: 7, update: 8, retire: 9, configure: 34, bind: 35, access: 36, rate: 37 } as const;

/** Why `call` would be refused before it leaves the shard (24-app-studio §9), or null; the registry checks the rest. */
export function grainCallProblem(call: GrainCall, sender?: string): string | null {
  const slug = (s: string) => (slugOk(s) ? null : "slug: 3 to 32 of [a-z0-9-], not starting with -");
  if ("retire" in call) return slug(call.retire);
  if ("configure" in call) {
    const { servers, category } = call.configure;
    const keysOk = servers.length <= MAX_SERVERS && new Set(servers).size === servers.length && servers.every(serverKeyOk);
    if (!keysOk) return `servers: at most ${MAX_SERVERS} Ed25519 keys in lowercase hex, valid, none twice`;
    if (categoryOf(category) === null) return "category: 0 to 9";
    return slug(call.configure.slug);
  }
  if ("bind" in call) {
    if (handleProblem(call.bind.handle)) return "handle: not a name or number in its canonical form";
    return call.bind.slug === null ? null : slug(call.bind.slug);
  }
  if ("access" in call) {
    const { members } = call.access;
    const accounts = members.map((m) => m.account);
    const ok = members.length <= MAX_MEMBERS && new Set(accounts).size === accounts.length &&
      members.every((m) => /^[0-9a-f]{64}$/.test(m.account) && m.account !== sender && rolesOk(m.roles));
    if (!ok) return `members: at most ${MAX_MEMBERS}, none twice, not the owner, roles 1 to 7`;
    return slug(call.access.slug);
  }
  if ("rate" in call) {
    const { score, review } = call.rate;
    if (!Number.isInteger(score) || score < 0 || score > 5) return "score: 1 to 5, or 0 to withdraw";
    if ([...review].length > MAX_REVIEW || /\p{Cc}/u.test(review) || /[\uD800-\uDFFF]/u.test(review)) {
      return `review: at most ${MAX_REVIEW} characters, no control characters`;
    }
    return slug(call.rate.slug);
  }
  return null;
}

/** Whether `hex` is a server key the registry takes: lowercase hex of a valid Ed25519 point not of small order. */
export function serverKeyOk(hex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  try {
    // A point of the curve that is not of small order, as the node's `is_valid_public_key` takes it.
    const point = ed25519.ExtendedPoint.fromHex(hex);
    point.assertValidity();
    return !point.isSmallOrder();
  } catch {
    return false;
  }
}

/** The registry call's action: `Action::Registry { call, amount }`. */
function grainAction(call: GrainCall, sender?: string): Uint8Array {
  const problem = grainCallProblem(call, sender);
  if (problem) throw new TypeError(problem);
  const w = new Writer().u8(ACTION_REGISTRY);
  let amount = 0n;
  if ("register" in call || "update" in call) {
    const signed = "register" in call ? call.register : call.update;
    w.u8("register" in call ? CALL.register : CALL.update).raw(encodeManifest(signed.manifest)).fixed(fromHex(signed.signature, 64), 64);
    if ("register" in call) amount = call.deposit ?? grainDeposit(call.register.manifest.slug);
  } else if ("retire" in call) {
    w.u8(CALL.retire).string(call.retire);
  } else if ("configure" in call) {
    const c = call.configure;
    w.u8(CALL.configure).string(c.slug).u32(c.servers.length);
    for (const key of c.servers) w.fixed(fromHex(key, 32), 32);
    w.u8(c.category);
  } else if ("bind" in call) {
    writeHandle(w.u8(CALL.bind), call.bind.handle).option(call.bind.slug, (w, slug) => w.string(slug));
  } else if ("access" in call) {
    const a = call.access;
    w.u8(CALL.access).string(a.slug).bool(a.public).u32(a.members.length);
    for (const m of a.members) w.fixed(fromHex(m.account, 32), 32).u8(m.roles);
  } else if ("rate" in call) {
    w.u8(CALL.rate).string(call.rate.slug).u8(call.rate.score).string(call.rate.review);
  } else {
    throw new TypeError("a grain's registry call");
  }
  return w.u64(amount).done();
}

/** The value a call sends: a registration's deposit, nothing otherwise. */
export function callAmount(call: GrainCall): bigint {
  return "register" in call ? call.deposit ?? grainDeposit(call.register.manifest.slug) : 0n;
}

/** The transaction's Borsh form: what its id and signature cover. */
export function encodeGrainTx(tx: TxFields, call: GrainCall): Uint8Array {
  return encodeTx(tx, grainAction(call, toHex(accountId(fromHex(tx.sender, 32)))));
}

/** The transaction's id and what the sender signs: bound to the network's genesis. */
export const grainTxId = txId;

/** Sign `call` with a plain account's 32-byte secret: the signed transaction in hex, as `transaction_submit` takes it,
 *  and its id. For a registration or an update, the manifest's `owner` must be the key's account and its `owner_key`
 *  the key (a managed owner publishes from its wallet). */
export function signGrainTx(secret: Uint8Array, fields: Omit<TxFields, "sender">, call: GrainCall, genesisHash: string): { hex: string; id: string } {
  const sender = ed25519.getPublicKey(secret);
  if ("register" in call || "update" in call) {
    const { manifest } = "register" in call ? call.register : call.update;
    if (!("ed25519" in manifest.owner_key) || manifest.owner_key.ed25519 !== toHex(sender)) {
      throw new TypeError("the manifest's owner_key is not this key");
    }
    if (manifest.owner !== toHex(accountId(sender))) throw new TypeError("the manifest's owner is not this key's account");
  }
  return signTx(secret, fields, grainAction(call, toHex(accountId(sender))), genesisHash);
}

/** The least fee a node's pool takes for `call`: its size times `MIN_FEE_PER_BYTE` (the fee does not change it). */
export function minimumFee(call: GrainCall): bigint {
  return minimumTxFee(grainAction(call));
}

/** A grain's ratings (24-app-studio §6a): their count and sum, overall and from accounts that held a citizenship. */
export interface GrainRatings {
  count: number;
  sum: number;
  citizens_count: number;
  citizens_sum: number;
}

/** A slug in the registry as a node serves it (`grain_get`, Saltix 08-node §6). The app studio's fields are absent on
 *  a node from before it. */
export interface RegisteredGrain {
  slug: string;
  owner: string;
  version: number;
  id: string;
  registered: number;
  updated: number;
  retired: number | null;
  /** What the grain keeps, base units. */
  deposit: string;
  manifest: SignedManifest | null;
  /** The server keys the registry names (hex): wallets trust them in its chat and notifications. */
  servers?: string[];
  category?: number;
  /** True until the owner makes it private. */
  public?: boolean;
  members?: Array<{ account: string; roles: number }>;
  /** The usernames pointing at it, as wallets write them (`@chess_coach`). */
  handles?: string[];
  ratings?: GrainRatings;
}

/** What the registry holds under `slug`; null when nobody registered it. */
export async function grainGet(nodeUrl: string, slug: string): Promise<RegisteredGrain | null> {
  return (await grainQuote(nodeUrl, slug)).grain;
}

/** What the registry holds under `slug`, and the deposit registering it needs: the node's quote, or 100 SALT from a node
 *  that quotes none (it predates deposits by length and takes 100 SALT for any slug). */
export async function grainQuote(nodeUrl: string, slug: string): Promise<{ grain: RegisteredGrain | null; deposit: bigint }> {
  const answer = await rpc<{ grain: RegisteredGrain | null; deposit?: string }>(nodeUrl, "grain_get", { slug });
  return { grain: answer.grain, deposit: typeof answer.deposit === "string" ? BigInt(answer.deposit) : GRAIN_DEPOSIT };
}

/** The owner a publishing link leaves for the wallet to fill in (12-grains §10): zero bytes, an Ed25519 key. */
export const UNOWNED = { owner: "00".repeat(32), owner_key: { ed25519: "00".repeat(32) } } as const;

/** Whether `a` and `b` are the same manifest but for its owner and owner key: what a wallet published from a link. */
export function sameManifest(a: Manifest, b: Manifest): boolean {
  return toHex(encodeManifest({ ...a, ...UNOWNED })) === toHex(encodeManifest({ ...b, ...UNOWNED }));
}
