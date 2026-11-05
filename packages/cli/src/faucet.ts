// `grain faucet`: test SALT, and WORK while its purses hold some, for a key file's account or an address, from a test
// network's faucet (Saltix 08-node §6, `faucet_request`): a node signs a grant from one of its purses and pools it; an
// address gets one every 5 minutes. No mainnet node runs one.
import { FAUCET, type NodeLike, RpcError, accountId, decodeAddress, encodeAddress, fromHex, grainQuote, nodeCall, toHex } from "@saltix/grain-server";
import { publicKeyOf } from "./project.js";
import { salt } from "./registry.js";

/** What a first publish signed with a key file needs beyond the slug's deposit: two registry calls' fees (registering,
 *  then making it private), with room to spare: 0.001 SALT. The doctor and `grain faucet --wait` measure by it. */
export const FEES_MARGIN = 1_000_000n;

/** The grants `grain faucet --wait` makes for one first publish at most: the deposits of 10 and 30 SALT at the faucet's
 *  default of 10 SALT a grant, five minutes apart, are 2 and 4 grants; the 100 SALT of a slug of 3–5 characters would be
 *  11, near an hour, which is said up front instead of waited for. */
export const GRANTS_MAX = 4;

/** A test network's faucet as `node_status.faucet` tells it (Saltix 08-node §6): a grant in base units of SALT, and the
 *  seconds an address waits between grants. */
export interface FaucetTerms {
  amount: bigint;
  every: number;
}

/** The faucet's terms from the node answering, or null where it runs none (or says them in no form this tool reads). */
export async function faucetTerms(node: NodeLike): Promise<FaucetTerms | null> {
  const { faucet } = await nodeCall<{ faucet?: { amount?: unknown; every?: unknown } | null }>(node, "node_status");
  if (!faucet || typeof faucet.amount !== "string" || !/^\d{1,30}$/.test(faucet.amount)) return null;
  const amount = BigInt(faucet.amount);
  const every = typeof faucet.every === "number" && Number.isFinite(faucet.every) && faucet.every >= 0 ? Math.floor(faucet.every) : 300;
  return amount > 0n ? { amount, every } : null;
}

/** What a project's first publish signed with its key file takes: the slug, its deposit, and the whole with the fees. */
export interface PublishGoal {
  slug: string;
  deposit: bigint;
  need: bigint;
}

/** The goal of `grain faucet --wait` in a project: `slug`'s first publish, or null once the registry names the slug (a
 *  grant then is a plain grant). */
export async function publishGoal(node: NodeLike, slug: string): Promise<PublishGoal | null> {
  const { grain, deposit } = await grainQuote(node, slug);
  return grain === null ? { slug, deposit, need: deposit + FEES_MARGIN } : null;
}

/** The grants it takes to bring `held` up to `goal` at `amount` a grant: 0 while it holds enough. */
export function grantsNeeded(goal: bigint, held: bigint, amount: bigint): number {
  if (held >= goal) return 0;
  return Number((goal - held + amount - 1n) / amount);
}

/** Seconds in a person's words: "5 minutes", "about 50 minutes", "90 s". */
export function spanWords(seconds: number): string {
  if (seconds < 120 || seconds % 60 !== 0) return seconds < 120 ? `${seconds} s` : `about ${Math.round(seconds / 60)} minutes`;
  return `${seconds / 60} minutes`;
}

/** The grants a first publish takes at `terms`, in words: "2 grants of 10 SALT, 5 minutes apart" — one grant without
 *  the interval. */
export function grantsWords(grants: number, terms: FaucetTerms): string {
  return grants <= 1 ? `one grant of ${salt(terms.amount)} SALT` : `${grants} grants of ${salt(terms.amount)} SALT, ${spanWords(terms.every)} apart`;
}

/** A faucet's refusal, with what it said: the reason, and for `too_soon` the seconds to wait. */
export class FaucetRefusal extends Error {
  constructor(message: string, readonly reason: string, readonly retryAfter: number | null) {
    super(message);
    this.name = "FaucetRefusal";
  }
}

/** What the faucet granted: the SALT transfer, and the WORK one after it while the purse holds WORK. Amounts in base
 *  units of SALT and µWORK. */
export interface Grant {
  address: string;
  salt: { id: string; amount: bigint };
  work: { id: string; amount: bigint } | null;
}

/** µWORK as WORK, for people: `1000`, `0.5`. */
export function work(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** The address a grant goes to: `address` as given (on the network answering), or the key file's account's. */
export async function grantAddress(node: NodeLike, options: { address?: string; secret?: Uint8Array }): Promise<string> {
  const { network } = await nodeCall<{ network: "mainnet" | "testnet" | "devnet" }>(node, "node_status");
  if (options.address !== undefined) {
    const decoded = decodeAddress(options.address);
    if (!decoded) throw new Error(`--address ${options.address}: not an address`);
    if (decoded.network !== network) throw new Error(`--address ${options.address}: an address of ${decoded.network}, and the network answering is ${network}`);
    return options.address;
  }
  if (!options.secret) throw new Error("a key file (--key) or --address");
  return encodeAddress(network, accountId(fromHex(publicKeyOf(options.secret), 32)));
}

/** What a faucet's refusal means, in words, with what it said. */
function refusal(e: RpcError, address: string): FaucetRefusal {
  const retry = (e.data as { retry_after?: unknown } | null)?.retry_after;
  const retryAfter = typeof retry === "number" && Number.isFinite(retry) && retry >= 0 ? Math.ceil(retry) : null;
  const words = (() => {
    switch (e.reason) {
      case "too_soon":
        return `the faucet paid ${address} less than 5 minutes ago` + (retryAfter !== null ? `: try again in ${retryAfter} s` : ": try again later");
      case "daily_limit":
        return "the faucet has made its grants of the day (UTC): try again tomorrow";
      case "empty":
        return "the faucet's purses are empty: tell the test network's operators";
      case "self":
        return "that is a purse of the faucet itself";
      case "no_faucet":
        return "the node answering runs no faucet: a faucet runs only on a test network";
      default:
        return e.message;
    }
  })();
  return new FaucetRefusal(words, e.reason, retryAfter);
}

/** Ask the faucet for a grant to `address`. Throws in words when it refuses (`FaucetRefusal` for the faucet's own). */
export async function requestGrant(node: NodeLike, address: string): Promise<Grant> {
  let answer: { id: string; amount: string; work: { id: string; amount: string } | null };
  try {
    answer = await nodeCall(node, "faucet_request", { address });
  } catch (e) {
    if (e instanceof RpcError && e.code === FAUCET) throw refusal(e, address);
    if (e instanceof Error && /no_faucet/.test(e.message)) throw new Error("no node within reach runs a faucet: a faucet runs only on a test network");
    throw e;
  }
  return {
    address,
    salt: { id: answer.id, amount: BigInt(answer.amount) },
    work: answer.work ? { id: answer.work.id, amount: BigInt(answer.work.amount) } : null,
  };
}

/** The account's SALT now, in base units: 0 for one the chain does not know yet. */
export async function saltOf(node: NodeLike, address: string): Promise<bigint> {
  const decoded = decodeAddress(address);
  const a = await nodeCall<{ salt?: string } | null>(node, "account_get", { address: decoded ? toHex(decoded.id) : address });
  return BigInt(a?.salt ?? "0");
}

/** Wait until the account holds `atLeast` base units of SALT, at most `ms`: whether it did. */
export async function waitForSalt(node: NodeLike, address: string, atLeast: bigint, ms: number, every = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if ((await saltOf(node, address).catch(() => 0n)) >= atLeast) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, every));
  }
}

/** A grant in words. */
export const granted = (g: Grant): string =>
  `${salt(g.salt.amount)} SALT to ${g.address} (transaction ${g.salt.id})` + (g.work ? `, and ${work(g.work.amount)} WORK (transaction ${g.work.id})` : "");
