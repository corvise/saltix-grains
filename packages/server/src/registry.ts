// The grains' registry on the beacon chain (Salarium 12-grains §3): the owner's transactions that register,
// update and retire a grain, encoded and signed as the node checks them, and what a node says of a slug.
import { ed25519 } from "@noble/curves/ed25519";
import { Writer, fromHex, toHex } from "./bytes.js";
import { encodeManifest, type Manifest, type SignedManifest } from "./manifest.js";
import { rpc } from "./node.js";
import { type TxFields, encodeTx, minimumTxFee, signTx, txId } from "./tx.js";

export type { TxFields } from "./tx.js";

/** What `RegisterGrain` keeps until the grain retires: 100 SALT, in base units. */
export const GRAIN_DEPOSIT = 100_000_000_000n;

/** A registry call of the owner (Salarium 06-licenses §4). */
export type GrainCall =
  | { register: SignedManifest }
  | { update: SignedManifest }
  | { retire: string };

// Action::Registry is tag 1; RegisterGrain, UpdateGrain and RetireGrain are calls 7, 8 and 9.
const ACTION_REGISTRY = 1;
const CALL = { register: 7, update: 8, retire: 9 } as const;

/** The registry call's action: `Action::Registry { call, amount }`. */
function grainAction(call: GrainCall): Uint8Array {
  const w = new Writer().u8(ACTION_REGISTRY);
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

/** The transaction's Borsh form: what its id and signature cover. */
export function encodeGrainTx(tx: TxFields, call: GrainCall): Uint8Array {
  return encodeTx(tx, grainAction(call));
}

/** The transaction's id and what the sender signs: bound to the network's genesis. */
export const grainTxId = txId;

/** Sign `call` with the owner's 32-byte secret: the signed transaction in hex, as `transaction_submit` takes it, and
 *  its id. A registered manifest must be the sender's own. */
export function signGrainTx(secret: Uint8Array, fields: Omit<TxFields, "sender">, call: GrainCall, genesisHash: string): { hex: string; id: string } {
  const sender = toHex(ed25519.getPublicKey(secret));
  if (!("retire" in call)) {
    const signed = "register" in call ? call.register : call.update;
    if (signed.manifest.owner_key !== sender) throw new TypeError("the manifest's owner_key is not this key's");
  }
  return signTx(secret, fields, grainAction(call), genesisHash);
}

/** The least fee a node's pool takes for `call`: its size times `MIN_FEE_PER_BYTE` (the fee does not change it). */
export function minimumFee(call: GrainCall): bigint {
  return minimumTxFee(grainAction(call));
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

const ZERO_KEY = "00".repeat(32);

/** Whether `a` and `b` are the same manifest but for its owner: what a wallet published from a link. */
export function sameManifest(a: Manifest, b: Manifest): boolean {
  return toHex(encodeManifest({ ...a, owner_key: ZERO_KEY })) === toHex(encodeManifest({ ...b, owner_key: ZERO_KEY }));
}
