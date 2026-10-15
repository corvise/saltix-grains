// `grain publish`, `grain retire` and `grain show`: the owner's registry calls through a node's wallet interface
// (Saltix 12-grains §3, 08-node §6), signed with the owner's key file; and what every signed registry call shares.
import {
  type Manifest, type SignedManifest, type GrainCall, rpc, grainGet, grainQuote, signGrainTx, minimumFee, callAmount, accountId, toHex,
  fromHex, type RegisteredGrain, sameManifest,
} from "@saltix/grain-server";
import { publishLink } from "./publish.js";
import { publicKeyOf } from "./project.js";

export interface Signing {
  node: string;
  /** Refuse a node of another network. */
  genesis?: string;
  /** Base units of SALT; the pool's floor for the size by default. */
  fee?: bigint;
  /** Slots the transaction stays valid. */
  validFor: number;
}

export interface Sent {
  call: "register" | "update" | "retire" | "configure" | "access" | "rate" | "bind";
  id: string;
  fee: bigint;
  /** What the call sent besides its fee: a registration's deposit. */
  amount: bigint;
}

/** Base units of SALT as SALT, for people: `10`, `30.5`. */
export function salt(units: bigint): string {
  const whole = units / 1_000_000_000n;
  const fraction = (units % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

interface Status { genesis: string; slot: number; network: string }
interface Account { nonce: number; salt: string }

/** Register `signed` with the deposit the node quotes for its slug, or update it when its owner registered the slug
 *  before. */
export async function publish(signed: SignedManifest, secret: Uint8Array, s: Signing): Promise<Sent> {
  const m = signed.manifest;
  const { grain: now, deposit } = await grainQuote(s.node, m.slug);
  const mine = toHex(accountId(fromHex(publicKeyOf(secret), 32)));
  let call: GrainCall;
  if (now === null) {
    call = { register: signed, deposit };
  } else if (now.owner !== mine) {
    throw new Error(`${m.slug}: registered by another owner (${now.owner}); pick another slug`);
  } else if (now.retired !== null) {
    throw new Error(`${m.slug}: retired at slot ${now.retired}; a retired slug is never used again`);
  } else if (m.version <= now.version) {
    throw new Error(`${m.slug}: version ${now.version} is registered; raise "version" above it`);
  } else {
    call = { update: signed };
  }
  return submit(call, secret, s);
}

/** Close the slug for good: the deposit returns 30 days later. */
export async function retire(slug: string, secret: Uint8Array, s: Signing): Promise<Sent> {
  const now = await grainGet(s.node, slug);
  const mine = toHex(accountId(fromHex(publicKeyOf(secret), 32)));
  if (now === null) throw new Error(`${slug}: not registered`);
  if (now.owner !== mine) throw new Error(`${slug}: registered by another owner`);
  if (now.retired !== null) throw new Error(`${slug}: retired already`);
  return submit({ retire: slug }, secret, s);
}

export async function show(node: string, slug: string): Promise<RegisteredGrain | null> {
  return grainGet(node, slug);
}

/** Sign `call` with the key file's secret and submit it, after the network, the balance and the call's own bounds are
 *  checked: what a node would refuse is refused before a transaction is made. */
export async function submit(call: GrainCall, secret: Uint8Array, s: Signing): Promise<Sent> {
  const status = await rpc<Status>(s.node, "node_status");
  if (s.genesis !== undefined && status.genesis !== s.genesis.toLowerCase()) {
    throw new Error(`the node is on genesis ${status.genesis}, not ${s.genesis}`);
  }
  const id = toHex(accountId(fromHex(publicKeyOf(secret), 32)));
  const account = await rpc<Account>(s.node, "account_get", { address: id });
  const fee = s.fee ?? minimumFee(call);
  const amount = callAmount(call);
  if (BigInt(account.salt) < amount + fee) {
    throw new Error(`the account has ${account.salt} base units of SALT; this needs ${amount + fee}`);
  }
  const signed = signGrainTx(secret, { nonce: account.nonce, fee, validUntilSlot: status.slot + s.validFor }, call, status.genesis);
  const answer = await rpc<{ id: string }>(s.node, "transaction_submit", { transaction: signed.hex });
  const kind = (["register", "update", "retire", "configure", "access", "rate", "bind"] as const).find((k) => k in call)!;
  return { call: kind, id: answer.id, fee, amount };
}

/** Wait until the registry shows `done`, at most `ms`. */
export async function waitFor(node: string, slug: string, done: (g: RegisteredGrain | null) => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (done(await grainGet(node, slug))) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/** The link that asks the owner's wallet to publish `m` (12-grains §10), after what the registry says rules it out:
 *  a retired slug, or a version not above the registered one. Whose the slug is, the wallet checks. */
export async function walletLink(m: Manifest, node: string): Promise<string> {
  const now = await grainGet(node, m.slug);
  if (now?.retired != null) throw new Error(`${m.slug}: retired at slot ${now.retired}; a retired slug is never used again`);
  if (now && m.version <= now.version) throw new Error(`${m.slug}: version ${now.version} is registered; raise "version" above it`);
  return publishLink(m);
}

/** The signed manifest once the registry holds `m` as a wallet published it (any owner key); null after `ms`. */
export async function waitForPublished(node: string, m: Manifest, ms: number): Promise<SignedManifest | null> {
  let found: SignedManifest | null = null;
  await waitFor(node, m.slug, (g) => {
    if (g?.manifest && g.retired === null && sameManifest(g.manifest.manifest, m)) found = g.manifest;
    return found !== null;
  }, ms);
  return found;
}
