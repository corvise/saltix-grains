// The page's node (Saltix 08-node §6): a wallet interface it reads public data from — the network it is on, the account
// policy, and an account's key event log. JSON-RPC 2.0 over HTTP POST, at a URL the page can reach (its own site's
// path to a node, which the site's CSP admits), or any object that answers calls (a test's).

/** A wallet interface: its URL, or an object that answers its calls. */
export type NodeLike = string | { call<T>(method: string, params?: object): Promise<T> };

/**
 * The node could not be asked (`unreachable`, `timeout`, `busy`: HTTP 429, 502, 503 or 504), or the way to it answered
 * something that is no answer (`http`: another HTTP status, such as a proxy's 403 or 404; `bad_answer`): not an answer
 * about the grant either way.
 */
export class NodeUnreachable extends Error {
  constructor(
    readonly method: string,
    readonly kind: "unreachable" | "timeout" | "busy" | "http" | "bad_answer",
  ) {
    super(`${method}: ${UNREACHABLE[kind]}`);
    this.name = "NodeUnreachable";
  }
}

const UNREACHABLE: Record<NodeUnreachable["kind"], string> = {
  unreachable: "the node is unreachable",
  timeout: "the node did not answer in time",
  busy: "the node is busy",
  http: "the way to the node answered with an HTTP error",
  bad_answer: "the node gave an answer that is no answer",
};

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

/** The node's JSON-RPC code for its own failure, which it also answers when it cannot answer within 10 s ("the node is
 *  busy", 08-node §6). */
export const NODE_FAILURE = -32603;

/**
 * Whether asking again may get an answer: the node could not be reached, did not answer in time, or said it is busy
 * (HTTP 429, 502, 503, 504, or its JSON-RPC -32603). An answer of any other kind — the node's refusal, an HTTP error of
 * the way to it, something that is no answer, a failure of a page's own transport — stays what it is however often it
 * is asked. The explorer's `/explorer/me` asks again by the same rule.
 */
export function retryable(e: unknown): boolean {
  if (e instanceof NodeUnreachable) return e.kind === "unreachable" || e.kind === "timeout" || e.kind === "busy";
  return e instanceof NodeError && e.code === NODE_FAILURE;
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
  const status = response.status;
  if (status === 429 || status === 502 || status === 503 || status === 504) throw new NodeUnreachable(method, "busy");
  if (status < 200 || status > 299) throw new NodeUnreachable(method, "http");
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
