import { referenceInMemo } from "./invoice.js";

/** A payment found on chain. */
export interface Payment {
  /** The transaction id (a transfer in the shard) or the receipt's source and sequence. */
  tx: string | null;
  from: string | null;
  asset: "salt" | "work";
  /** Base units, decimal. */
  amount: string;
  height: number;
  confirmations: number;
}

/** A JSON-RPC call to a node's wallet interface (Saltix 08-node §6), plain HTTP: your own node or a tunnel. */
export async function rpc<T>(url: string, method: string, params: object = {}): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
  return body.result as T;
}

interface HistoryEntry {
  kind: string;
  tx?: string;
  from?: string;
  asset: "salt" | "work";
  amount: string;
  height: number;
  confirmations: number;
  memo?: { text?: string };
}

/**
 * The payment of the invoice whose reference is `reference` to `address`, if the node's canonical
 * chain has it (the latest `limit` entries of the account's history). Check its amount and asset
 * against your invoice, and wait for the confirmations you need.
 */
export async function findPayment(nodeUrl: string, address: string, reference: string, limit = 200): Promise<Payment | null> {
  const { entries } = await rpc<{ entries: HistoryEntry[] }>(nodeUrl, "account_history", { address, limit });
  const e = entries.find(
    (x) => (x.kind === "received" || x.kind === "receipt") && x.memo?.text !== undefined && referenceInMemo(x.memo.text) === reference,
  );
  if (!e) return null;
  return { tx: e.tx ?? null, from: e.from ?? null, asset: e.asset, amount: e.amount, height: e.height, confirmations: e.confirmations };
}
