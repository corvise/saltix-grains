// A Salarium transaction (03-ledger §3): the sender's key, nonce, fee and last valid slot, then the action; its id
// binds it to one network, and the sender signs the id.
import { ed25519 } from "@noble/curves/ed25519";
import { Writer, derive, fromHex, toHex } from "./bytes.js";

/** Base units of SALT a transaction pays per byte at least (Salarium 03-ledger §7). */
export const MIN_FEE_PER_BYTE = 10n;
/** The largest signed transaction a node takes. */
export const MAX_TX_SIZE = 16_384;

/** A transaction's fields besides its action: the sender's key (hex) and nonce, the fee (base units of SALT) and the
 *  last slot it is valid in. */
export interface TxFields {
  sender: string;
  nonce: bigint | number;
  fee: bigint | number;
  validUntilSlot: bigint | number;
}

/** The transaction's Borsh form, `action` its encoded action: what its id and signature cover. */
export function encodeTx(tx: TxFields, action: Uint8Array): Uint8Array {
  return new Writer().fixed(fromHex(tx.sender, 32), 32).u64(tx.nonce).u64(tx.fee).u64(tx.validUntilSlot).raw(action).done();
}

/** The transaction's id and what the sender signs: bound to the network's genesis. */
export function txId(body: Uint8Array, genesisHash: string): string {
  return toHex(derive("Salarium transaction v2", fromHex(genesisHash, 32), body));
}

/** Sign the transaction of `action` with the sender's 32-byte secret: hex as `transaction_submit` takes it, and its id. */
export function signTx(secret: Uint8Array, fields: Omit<TxFields, "sender">, action: Uint8Array, genesisHash: string): { hex: string; id: string } {
  const body = encodeTx({ ...fields, sender: toHex(ed25519.getPublicKey(secret)) }, action);
  const id = txId(body, genesisHash);
  const hex = toHex(body) + toHex(ed25519.sign(fromHex(id, 32), secret));
  if (hex.length / 2 > MAX_TX_SIZE) throw new TypeError(`the transaction is ${hex.length / 2} bytes, a node takes at most ${MAX_TX_SIZE}`);
  return { hex, id };
}

/** The least fee a node's pool takes for a transaction of `action`: its size times `MIN_FEE_PER_BYTE`. */
export function minimumTxFee(action: Uint8Array): bigint {
  return BigInt(encodeTx({ sender: "00".repeat(32), nonce: 0, fee: 0, validUntilSlot: 0 }, action).length + 64) * MIN_FEE_PER_BYTE;
}
