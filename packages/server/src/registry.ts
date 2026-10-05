// The grains' registry on the beacon chain (Salarium 12-grains §3): the owner's transactions that register,
// update and retire a grain, encoded and signed as the node checks them, and what a node says of a slug.
import { ed25519 } from "@noble/curves/ed25519";
import { Writer, derive, fromHex, toHex } from "./bytes.js";
import { encodeManifest, type SignedManifest } from "./manifest.js";
import { rpc } from "./node.js";

/** What `RegisterGrain` keeps until the grain retires: 100 SALT, in base units. */
export const GRAIN_DEPOSIT = 100_000_000_000n;
/** Base units of SALT a transaction pays per byte at least (Salarium 03-ledger §7). */
export const MIN_FEE_PER_BYTE = 10n;
/** The largest signed transaction a node takes. */
export const MAX_TX_SIZE = 16_384;

/** A registry call of the owner (Salarium 06-licenses §4). */
export type GrainCall =
  | { register: SignedManifest }
  | { update: SignedManifest }
  | { retire: string };

/** A transaction's fields besides the call: the sender's key (hex) and nonce, the fee (base units of SALT) and the
 *  last slot it is valid in. */
export interface TxFields {
  sender: string;
  nonce: bigint | number;
  fee: bigint | number;
  validUntilSlot: bigint | number;
}

// Action::Registry is tag 1; RegisterGrain, UpdateGrain and RetireGrain are calls 7, 8 and 9.
const ACTION_REGISTRY = 1;
const CALL = { register: 7, update: 8, retire: 9 } as const;

/** The transaction's Borsh form: what its id and signature cover. */
export function encodeGrainTx(tx: TxFields, call: GrainCall): Uint8Array {
  const w = new Writer().fixed(fromHex(tx.sender, 32), 32).u64(tx.nonce).u64(tx.fee).u64(tx.validUntilSlot).u8(ACTION_REGISTRY);
  let amount = 0n;
  if ("register" in call || "update" in call) {
    const signed = "register" in call ? call.register : call.update;
    w.u8("register" in call ? CALL.register : CALL.update).raw(encodeManifest(signed.manifest)).fixed(fromHex(signed.signature, 64), 64);
    if ("register" in call) amount = GRAIN_DEPOSIT;
  } else {
    if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(call.retire)) throw new TypeError("slug: 3 to 32 of [a-z0-9-], not starting with -");
    w.u8(CALL.retire).string(call.retire);
  }
  return w.u64(amount).done();
}

/** The transaction's id and what the sender signs: bound to the network's genesis. */
export function grainTxId(body: Uint8Array, genesisHash: string): string {
  return toHex(derive("Salarium transaction v2", fromHex(genesisHash, 32), body));
}

/** Sign `call` with the owner's 32-byte secret: the signed transaction in hex, as `transaction_submit` takes it, and
 *  its id. A registered manifest must be the sender's own. */
export function signGrainTx(secret: Uint8Array, fields: Omit<TxFields, "sender">, call: GrainCall, genesisHash: string): { hex: string; id: string } {
  const sender = toHex(ed25519.getPublicKey(secret));
  if (!("retire" in call)) {
    const signed = "register" in call ? call.register : call.update;
    if (signed.manifest.owner_key !== sender) throw new TypeError("the manifest's owner_key is not this key's");
  }
  const body = encodeGrainTx({ ...fields, sender }, call);
  const id = grainTxId(body, genesisHash);
  const signature = ed25519.sign(fromHex(id, 32), secret);
  const hex = toHex(body) + toHex(signature);
  if (hex.length / 2 > MAX_TX_SIZE) throw new TypeError(`the transaction is ${hex.length / 2} bytes, a node takes at most ${MAX_TX_SIZE}`);
  return { hex, id };
}

/** The least fee a node's pool takes for `call`: its size times `MIN_FEE_PER_BYTE` (the fee does not change it). */
export function minimumFee(call: GrainCall): bigint {
  const size = encodeGrainTx({ sender: "00".repeat(32), nonce: 0, fee: 0, validUntilSlot: 0 }, call).length + 64;
  return BigInt(size) * MIN_FEE_PER_BYTE;
}

/** A slug in the registry as a node serves it (`grain_get`, Salarium 08-node §6). */
export interface RegisteredGrain {
  slug: string;
  owner: string;
  version: number;
  id: string;
  registered: number;
  updated: number;
  retired: number | null;
  deposit: string;
  manifest: SignedManifest | null;
}

/** What the registry holds under `slug`; null when nobody registered it. */
export async function grainGet(nodeUrl: string, slug: string): Promise<RegisteredGrain | null> {
  return (await rpc<{ grain: RegisteredGrain | null }>(nodeUrl, "grain_get", { slug })).grain;
}
