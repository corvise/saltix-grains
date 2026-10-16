// The chain's side of taking a grant (Saltix 19-connect §5): rules 1–4, then rule 5 by the account's key event log from
// the page's node (`account_log`), checked offline under the network's genesis hash and first policy. What the page
// keeps comes back. As the explorer's `explorer/src/connect/verify.ts`.
import { type AccountPolicy, type NetworkName, encodeAddress, fromHex, toHex } from "@saltix/grain-server/web";
import { b64url } from "./codec.js";
import { type ConnectGrant, type Session, checkAccount, checkGrant, signerKind } from "./grant.js";
import { type KeyLogAnswer, type NodeLike, NodeUnreachable, nodeCall } from "./node.js";
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
  network: NetworkName;
  /** The genesis hash the page reads, hex. */
  genesis: string;
  /** The network's first account policy; null when the node gave none (a managed account's login is then unchecked). */
  policy: AccountPolicy | null;
  now?: () => number;
  /** Waits between tries of a node that cannot be asked just then. */
  retryMs?: number[];
}

const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));

/** Check `grant` (its Borsh `bytes`) for `session`: a `ConnectError` refuses it, an `UncheckedError` leaves it unchecked;
 *  the connection the page keeps otherwise. */
export async function verifyGrant(grant: ConnectGrant, bytes: Uint8Array, session: Session, deps: VerifyDeps): Promise<Connection> {
  const now = deps.now ?? (() => Date.now());
  checkGrant(grant, session, now());
  const account = toHex(grant.login.account);
  let answer: KeyLogAnswer | null = null;
  const waits = deps.retryMs ?? [1_000, 3_000];
  for (let attempt = 0; ; attempt++) {
    try {
      answer = await nodeCall<KeyLogAnswer>(deps.node, "account_log", { address: account });
      break;
    } catch (e) {
      const kind = e instanceof NodeUnreachable ? e.kind : "node_error";
      if (!(e instanceof NodeUnreachable) || attempt >= waits.length) throw new UncheckedError(kind);
      await sleep(waits[attempt]!);
    }
  }
  if (!answer || answer.account !== account || !Array.isArray(answer.events)) throw new UncheckedError("bad_answer");
  let events: Uint8Array[];
  try {
    events = answer.events.map((e) => fromHex(e.event));
  } catch {
    throw new UncheckedError("bad_answer");
  }
  if (events.length > 0 && deps.policy === null) throw new UncheckedError("no_policy");
  const { kind, log } = checkAccount(grant, events, fromHex(deps.genesis, 32), deps.policy ?? { delay: 0n, disputeTimeout: 0n });
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

