// An account's registry calls, one at a time. A call carries the account's nonce, and a profile its revision, as the node
// holds them when the call is built: a second call built while the first is still in the pool takes the same ones, and
// the pool refuses it (or the registry, its revision). So a command waits until its transaction left the pool and the
// registry holds what it makes, and a call the pool refuses because an earlier one of the account is pending (another
// command at the same time) is built again from what the node holds once that one landed. A wait says where it stands
// (`onWait`): in the pool, or in a shard block on its way to the registry, which the beacon chain keeps.
import { type GrainCall, type NodeLike, RpcError, nodeCall } from "@saltix/grain-server";
import { type Sent, type Signing, submit } from "./registry.js";
import { holds } from "./studio.js";

/** How long a command waits for its call to land, or for an earlier one to: 6 minutes, about three times what one takes
 *  on the test network (a shard block, the block linked into the beacon chain, the registry's beacon block). */
export const SETTLE_MS = 360_000;
/** How often the node is asked meanwhile. */
export const SETTLE_EVERY_MS = 2_000;

/** The node's code for a transaction its pool did not take (08-node §6), with the reason in its message. */
const POOL_REFUSED = 2;

/** Whether `e` is the pool's refusal of a call because an earlier call of the account holds its nonce: pending (a
 *  replacement must pay more), or landed after the call was built (the nonce is used already). */
export function earlierPending(e: unknown): boolean {
  return e instanceof RpcError && e.code === POOL_REFUSED && /is used already|replacement must pay more/.test(e.reason);
}

const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms));

/** What the registry holds once `call` landed: watched for every call but a rating. */
const watched = (call: GrainCall): boolean => !("rate" in call);

/** Where a transaction stands while a command waits for it, in words. */
export const STAGES = {
  pool: "in the pool, waiting for a shard block",
  block: "in a shard block, on its way to the registry (the beacon chain)",
  earlier: "the account's earlier call is still in the pool: this one goes once it landed",
} as const;

/** Told where a wait stands, as often as the node is asked. */
export type OnWait = (stage: string) => void;

/**
 * Whether the call sent as `id` landed by `end`: its transaction left the pool into a block and the registry holds what
 * it makes (a rating: the block alone). Null when the node cannot say (it answers no `transaction_get`).
 */
export async function landed(node: NodeLike, call: GrainCall, id: string, end: number, every = SETTLE_EVERY_MS, onWait?: OnWait): Promise<boolean | null> {
  for (;;) {
    let status: unknown;
    try {
      status = (await nodeCall<{ status?: unknown } | undefined>(node, "transaction_get", { id }))?.status;
    } catch {
      return null;
    }
    if (status === "included") break;
    // Pending in the pool, or not yet known to the node asked (a relay's gateway may reach another node).
    if (status !== "pending" && status !== "unknown") return null;
    if (Date.now() >= end) return false;
    onWait?.(STAGES.pool);
    await sleep(every);
  }
  if (!watched(call)) return true;
  for (;;) {
    if (await holds(node, call)) return true;
    if (Date.now() >= end) return false;
    onWait?.(STAGES.block);
    await sleep(every);
  }
}

export interface Settle {
  /** Wait for the call to land (true), or return once the pool took it. */
  wait: boolean;
  ms?: number;
  every?: number;
  /** Told once the pool took the call, before the wait. */
  onSent?: (sent: Sent) => void;
  /** Told where the wait stands: an earlier call in the pool, this one in the pool, in a block. */
  onWait?: OnWait;
  /** Base units of SALT the account must keep besides this call: the fees of calls sent right after it. */
  reserve?: bigint;
}

/**
 * Build the call from what the node holds now (`build`), sign it with `secret` and send it: again, built anew, while the
 * pool refuses it for an earlier call of the account; then, with `wait`, until it landed. `landed` is null without
 * `wait` or when the node cannot say.
 */
export async function sendSettled(build: () => Promise<GrainCall>, secret: Uint8Array, s: Signing, o: Settle): Promise<{ sent: Sent; landed: boolean | null }> {
  const every = o.every ?? SETTLE_EVERY_MS;
  const end = Date.now() + (o.ms ?? SETTLE_MS);
  for (;;) {
    const call = await build();
    let sent: Sent;
    try {
      sent = await submit(call, secret, s, { reserve: o.reserve });
    } catch (e) {
      if (!earlierPending(e) || Date.now() >= end) throw e;
      o.onWait?.(STAGES.earlier);
      await sleep(every);
      continue;
    }
    o.onSent?.(sent);
    return { sent, landed: o.wait ? await landed(s.node, call, sent.id, end, every, o.onWait) : null };
  }
}
