// The chain's side of taking a grant (Saltix 19-connect §5): rules 1–4, then rule 5 by the account's key event log from
// the page's node (`account_log`), checked offline under the network's genesis hash and the first account policy, both
// read from the node's status (`node_status`) for this grant. What the page keeps comes back.
//
// This module is the page's check, and the reference for every copy of it: the explorer's `/explorer/me`
// (corvise/saltix `explorer/src/connect/`) follows it rule for rule — what is refused, what is only unchecked, and
// when the node is asked again.
import { type NetworkName, encodeAddress, fromHex, policyOf, toHex } from "@saltix/grain-server/web";
import { b64url } from "./codec.js";
import { ConnectError, type ConnectGrant, type Session, checkAccount, checkGrant, signerKind } from "./grant.js";
import { type KeyLogAnswer, type NodeLike, type NodeStatus, NODE_FAILURE, NodeError, NodeUnreachable, nodeCall, retryable } from "./node.js";
import type { Connection } from "./store.js";

/** A grant the node could not be asked about: not refused, only not checked now (the visitor approves again). */
export class UncheckedError extends Error {
  constructor(readonly kind: string) {
    super(`the node could not check the login: ${kind}`);
    this.name = "UncheckedError";
  }
}

export interface VerifyDeps {
  node: NodeLike;
  /** The network kind the page reads: the node must be of it. */
  network: NetworkName;
  /** The genesis hash the page offered under, hex: the node must be on it now. */
  genesis: string;
  now?: () => number;
  /** Waits between tries of a node that could not answer (`retryable`): two more tries by default. */
  retryMs?: number[];
}

const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));

/** Why the node gave no answer, for an `UncheckedError`. */
const failureKind = (e: unknown): string =>
  e instanceof NodeUnreachable ? e.kind : e instanceof NodeError && e.code === NODE_FAILURE ? "busy" : "node_error";

/** `method` of the node, asked again after each of `waits` while it could not answer; an `UncheckedError` otherwise. */
async function ask<T>(deps: VerifyDeps, method: string, params: object = {}): Promise<T> {
  const waits = deps.retryMs ?? [1_000, 3_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await nodeCall<T>(deps.node, method, params);
    } catch (e) {
      if (!retryable(e) || attempt >= waits.length) throw new UncheckedError(failureKind(e));
      await sleep(waits[attempt]!);
    }
  }
}

/**
 * Check `grant` (its Borsh `bytes`) for `session`: a `ConnectError` refuses it, an `UncheckedError` leaves it unchecked;
 * the connection the page keeps otherwise. The node's status is read for each grant: a node now of another network or
 * chain refuses it (`network`), and one that names no account policy keeps no key event logs, so even an empty log
 * from it proves nothing (unchecked, `no_policy`).
 */
export async function verifyGrant(grant: ConnectGrant, bytes: Uint8Array, session: Session, deps: VerifyDeps): Promise<Connection> {
  const now = deps.now ?? (() => Date.now());
  checkGrant(grant, session, now());
  const status = await ask<NodeStatus>(deps, "node_status");
  if (typeof status !== "object" || status === null || typeof status.network !== "string" || typeof status.genesis !== "string") {
    throw new UncheckedError("bad_answer");
  }
  if (status.network !== deps.network || status.genesis !== deps.genesis) throw new ConnectError("network", "the node is on another network or chain");
  if (!status.accounts) throw new UncheckedError("no_policy");
  let policy;
  try {
    policy = policyOf(status.accounts.policy);
  } catch {
    throw new UncheckedError("bad_answer");
  }
  const account = toHex(grant.login.account);
  const answer = await ask<KeyLogAnswer>(deps, "account_log", { address: account });
  if (!answer || answer.account !== account || !Array.isArray(answer.events)) throw new UncheckedError("bad_answer");
  let events: Uint8Array[];
  try {
    events = answer.events.map((e) => fromHex(e.event));
  } catch {
    throw new UncheckedError("bad_answer");
  }
  const { kind, log } = checkAccount(grant, events, fromHex(deps.genesis, 32), policy);
  return {
    network: deps.genesis,
    account,
    address: encodeAddress(deps.network, grant.login.account, kind),
    grant: b64url(bytes),
    signer: signerKind(grant.signer),
    managed: log !== null,
    since: now(),
  };
}
