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

/** A node's answer that is an error (`code` as 08-node §6 numbers them: 1, it does not follow the account's shard; 3,
 *  the faucet refused), its `reason` (the node's message) and `data` (`retry_after` seconds for a faucet's `too_soon`). */
export class RpcError extends Error {
  readonly reason: string;
  constructor(public readonly method: string, public readonly code: number, detail: string, public readonly data: unknown = null) {
    super(`${method}: ${detail} (${code})`);
    this.name = "RpcError";
    this.reason = detail;
  }
}

/** The node does not follow the shard an account lives in: another node may. */
export const NOT_FOLLOWED = 1;
/** A test network's faucet refused (`faucet_request`): `no_faucet`, `too_soon`, `daily_limit`, `empty`, `self`. */
export const FAUCET = 3;

/** Whether an error answer is this node's alone, so that another node may answer: it does not follow the shard, or runs
 *  no faucet. */
export const nodeOnly = (code: number, reason: string): boolean => code === NOT_FOLLOWED || (code === FAUCET && reason === "no_faucet");

/** A node's wallet interface: your own node's URL (plain HTTP: a local node or a tunnel), or the interface however it is
 *  reached (the network's relays' gateways, `RelayGateways`; a fake in tests). */
export type NodeLike = string | { call<T>(method: string, params?: object): Promise<T> };

/** Call `method` of `node`'s wallet interface. */
export function nodeCall<T>(node: NodeLike, method: string, params: object = {}): Promise<T> {
  return typeof node === "string" ? rpc<T>(node, method, params) : node.call<T>(method, params);
}

/** An answer from a node or a relay is read up to this many bytes (a `blob_get` piece is 256 KiB; an account's history
 *  or key event log a few hundred KiB): past it the answer is refused, so no node fills the caller's memory. */
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/** The body of `response`, at most `MAX_ANSWER_BYTES`; throws past that. */
export async function boundedBody(response: Response, limit = MAX_ANSWER_BYTES): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) throw new Error(`the answer is ${declared} bytes, at most ${limit} are read`);
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`the answer is longer than ${limit} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A JSON-RPC call to a node's wallet interface (Saltix 08-node §6), plain HTTP: your own node or a tunnel. Throws an
 *  `RpcError` for the node's error answer. */
export async function rpc<T>(url: string, method: string, params: object = {}): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = JSON.parse(new TextDecoder().decode(await boundedBody(response))) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (body.error) throw new RpcError(method, body.error.code, body.error.message, body.error.data ?? null);
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
 * chain has it (the latest `limit` entries of the account's history). `node` is your node's URL, or
 * any wallet interface (`ChatServer` reaches one through the relays: `chat.paymentOf`). Check its
 * amount and asset against your invoice, and wait for the confirmations you need.
 */
export async function findPayment(node: NodeLike, address: string, reference: string, limit = 200): Promise<Payment | null> {
  const { entries } = await nodeCall<{ entries: HistoryEntry[] }>(node, "account_history", { address, limit });
  const e = entries.find(
    (x) => (x.kind === "received" || x.kind === "receipt") && x.memo?.text !== undefined && referenceInMemo(x.memo.text) === reference,
  );
  if (!e) return null;
  return { tx: e.tx ?? null, from: e.from ?? null, asset: e.asset, amount: e.amount, height: e.height, confirmations: e.confirmations };
}
