// The page's node (Saltix 08-node §6): a wallet interface it reads public data from — the network it is on, the account
// policy, and an account's key event log. JSON-RPC 2.0 over HTTP POST, at a URL the page can reach (its own site's
// path to a node, which the site's CSP admits), or any object that answers calls (a test's).

/** A wallet interface: its URL, or an object that answers its calls. */
export type NodeLike = string | { call<T>(method: string, params?: object): Promise<T> };

/** The node could not be asked (unreachable, busy, too slow): not an answer about the grant. */
export class NodeUnreachable extends Error {
  constructor(
    readonly method: string,
    readonly kind: "unreachable" | "timeout" | "busy" | "bad_answer",
  ) {
    super(`${method}: the node ${kind === "bad_answer" ? "gave an answer that is no answer" : kind === "busy" ? "is busy" : `is ${kind}`}`);
    this.name = "NodeUnreachable";
  }
}

/** The node's own error answer. */
export class NodeError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly reason: string,
  ) {
    super(`${method}: ${reason} (${code})`);
    this.name = "NodeError";
  }
}

const TIMEOUT_MS = 10_000;

/** Call `method` of `node`; a `NodeUnreachable` when it cannot be asked, a `NodeError` for its error answer. */
export async function nodeCall<T>(node: NodeLike, method: string, params: object = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
  if (typeof node !== "string") return node.call<T>(method, params);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(node, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      credentials: "omit",
      signal: abort.signal,
    });
  } catch {
    throw new NodeUnreachable(method, abort.signal.aborted ? "timeout" : "unreachable");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 429 || response.status >= 500) throw new NodeUnreachable(method, "busy");
  let body: { result?: T; error?: { code: number; message: string } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new NodeUnreachable(method, "bad_answer");
  }
  if (body.error) throw new NodeError(method, body.error.code, body.error.message);
  if (!("result" in body)) throw new NodeUnreachable(method, "bad_answer");
  return body.result as T;
}

/** What the page reads of `node_status`. */
export interface NodeStatus {
  network: string;
  genesis: string;
  /** The network's first account policy (13-accounts §5), which key event logs are checked under. */
  accounts?: { policy: { delay: number; dispute_timeout: number } };
}

/** An account's key event log as `account_log` gives it: each event's Borsh in hex. */
export interface KeyLogAnswer {
  account: string;
  events: Array<{ seq: number; slot: number; id?: string; event: string }>;
}
